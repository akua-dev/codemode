use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use llrt_core::{
    modules::module_builder::ModuleBuilder,
    vm::{Vm, VmOptions},
};
use llrt_json::{parse::json_parse, stringify::json_stringify};
use napi::{
    bindgen_prelude::Promise as NapiPromise, bindgen_prelude::*,
    threadsafe_function::ThreadsafeFunction, Status,
};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use rquickjs::{
    atom::PredefinedAtom,
    function::This,
    prelude::{Async, Func},
    CatchResultExt, CaughtError, Ctx, Function as QuickFunction, Object, Promise as QuickPromise,
    Value,
};

type HostDispatcher = ThreadsafeFunction<String, NapiPromise<String>, String, Status, false>;
const HOST_ERROR_PREFIX: &str = "__LLRT_HOST_ERROR__";
const DEFAULT_MAX_HOST_PAYLOAD_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES: usize = 10 * 1024 * 1024;

#[napi(object)]
pub struct NativeStats {
    pub wall_time_ms: f64,
    pub cpu_time_ms: Option<f64>,
    pub memory_used_bytes: Option<f64>,
    pub memory_limit_bytes: Option<f64>,
    pub max_stack_bytes: Option<f64>,
}

#[napi(object)]
pub struct NativeRuntimeOptions {
    pub memory_mb: Option<f64>,
    pub wall_time_ms: Option<f64>,
    pub cpu_time_ms: Option<f64>,
    pub max_stack_bytes: Option<f64>,
    pub max_host_payload_bytes: Option<f64>,
    pub max_result_bytes: Option<f64>,
    pub error_marker: Option<String>,
    pub host_paths: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Clone, Deserialize, Serialize)]
pub struct NativeErrorInfo {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
    pub code: String,
}

#[napi(object)]
pub struct NativeCallResult {
    pub ok: bool,
    pub value_json: Option<String>,
    pub error: Option<NativeErrorInfo>,
    pub stats: NativeStats,
}

#[napi]
pub fn call_json<'env>(
    env: &'env Env,
    source: String,
    input_json: String,
    options: NativeRuntimeOptions,
    host_dispatcher: Option<Function<'_, String, NapiPromise<String>>>,
) -> Result<PromiseRaw<'env, NativeCallResult>> {
    let host_dispatcher = host_dispatcher
        .map(|dispatcher| {
            dispatcher
                .build_threadsafe_function()
                .build_callback(|ctx| Ok(ctx.value))
        })
        .transpose()
        .map(|dispatcher| dispatcher.map(Arc::new))?;

    env.spawn_future(
        async move { call_json_inner(source, input_json, options, host_dispatcher).await },
    )
}

async fn call_json_inner(
    source: String,
    input_json: String,
    options: NativeRuntimeOptions,
    host_dispatcher: Option<Arc<HostDispatcher>>,
) -> Result<NativeCallResult> {
    let start = Instant::now();
    if let Some(cpu_time_ms) = options.cpu_time_ms {
        if cpu_time_ms.is_finite() && cpu_time_ms > 0.0 {
            return Ok(option_error(
                start,
                "cpu_time_ms is not enforced by LLRT native bindings; use wall_time_ms",
            ));
        }
    }
    let max_stack_bytes = match finite_positive_usize(
        options.max_stack_bytes,
        "max_stack_bytes",
        VmOptions::default().max_stack_size,
        1.0,
        start,
    )? {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };
    let memory_limit_bytes = match finite_positive_usize(
        options.memory_mb,
        "memory_mb",
        64 * 1024 * 1024,
        1024.0 * 1024.0,
        start,
    )? {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };
    let max_host_payload_bytes = match finite_positive_usize(
        options.max_host_payload_bytes,
        "max_host_payload_bytes",
        DEFAULT_MAX_HOST_PAYLOAD_BYTES,
        1.0,
        start,
    )? {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };
    let max_result_bytes = match finite_positive_usize(
        options.max_result_bytes,
        "max_result_bytes",
        DEFAULT_MAX_RESULT_BYTES,
        1.0,
        start,
    )? {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };
    let error_marker = options
        .error_marker
        .unwrap_or_else(|| format!("{HOST_ERROR_PREFIX}{:p}:", &start));

    let vm = Vm::from_options(VmOptions {
        module_builder: ModuleBuilder::new(),
        allow_module_loading: false,
        max_stack_size: max_stack_bytes,
        ..VmOptions::default()
    })
    .await
    .map_err(|error| Error::from_reason(error.to_string()))?;
    vm.runtime.set_memory_limit(memory_limit_bytes).await;

    let wall_timeout = match wall_time_duration(options.wall_time_ms, start) {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };
    let timeout_flag = configure_wall_time_limit(&vm, wall_timeout).await;
    let result = execute_with_wall_timeout(
        execute_function(
            &vm,
            source,
            input_json,
            host_dispatcher,
            options.host_paths.unwrap_or_default(),
            max_host_payload_bytes,
            error_marker.clone(),
        ),
        wall_timeout,
    )
    .await;
    vm.runtime.set_interrupt_handler(None).await;
    let memory_usage = vm.runtime.memory_usage().await;
    if !matches!(&result, Err(error) if error.code == "TIMEOUT") {
        vm.idle()
            .await
            .map_err(|error| Error::from_reason(error.to_string()))?;
    }

    let stats = NativeStats {
        wall_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        cpu_time_ms: None,
        memory_used_bytes: Some(memory_usage.memory_used_size as f64),
        memory_limit_bytes: Some(memory_limit_bytes as f64),
        max_stack_bytes: Some(max_stack_bytes as f64),
    };

    let value_json = match result {
        Ok(value_json) => value_json,
        Err(mut error) => {
            if error.message.contains("out of memory") {
                error.code = "MEMORY_LIMIT".to_string();
                error.name = "LlrtMemoryLimitError".to_string();
            }

            if timeout_flag
                .as_ref()
                .map(|flag| flag.load(Ordering::Relaxed))
                .unwrap_or_default()
            {
                error.code = "TIMEOUT".to_string();
                error.name = "LlrtTimeoutError".to_string();
                error.message = "Execution exceeded wall-time limit".to_string();
            }

            return Ok(NativeCallResult {
                ok: false,
                value_json: None,
                error: Some(error),
                stats,
            });
        }
    };
    if value_json.len() > max_result_bytes {
        return Ok(NativeCallResult {
            ok: false,
            value_json: None,
            error: Some(limit_error(
                "RESULT_LIMIT",
                "LlrtResultLimitError",
                &format!("LLRT execution result exceeds limit of {max_result_bytes} bytes"),
            )),
            stats,
        });
    }

    Ok(NativeCallResult {
        ok: true,
        value_json: Some(value_json),
        error: None,
        stats,
    })
}

fn wall_time_duration(
    wall_time_ms: Option<f64>,
    start: Instant,
) -> std::result::Result<Option<Duration>, NativeCallResult> {
    let Some(wall_time_ms) = wall_time_ms else {
        return Ok(None);
    };
    if !wall_time_ms.is_finite() || wall_time_ms <= 0.0 {
        return Err(option_error(
            start,
            "wall_time_ms must be a finite positive number",
        ));
    }
    Ok(Some(Duration::from_secs_f64(wall_time_ms / 1000.0)))
}

fn finite_positive_usize(
    value: Option<f64>,
    name: &str,
    default_value: usize,
    multiplier: f64,
    start: Instant,
) -> Result<std::result::Result<usize, NativeCallResult>> {
    let Some(value) = value else {
        return Ok(Ok(default_value));
    };
    if !value.is_finite() || value <= 0.0 {
        return Ok(Err(option_error(
            start,
            &format!("{name} must be a finite positive number"),
        )));
    }
    let scaled = value * multiplier;
    if !scaled.is_finite() || scaled > usize::MAX as f64 {
        return Ok(Err(option_error(
            start,
            &format!("{name} exceeds supported limit"),
        )));
    }
    Ok(Ok(scaled as usize))
}

fn option_error(start: Instant, message: &str) -> NativeCallResult {
    NativeCallResult {
        ok: false,
        value_json: None,
        error: Some(NativeErrorInfo {
            code: "UNSUPPORTED".to_string(),
            name: "LlrtUnsupportedOptionError".to_string(),
            message: message.to_string(),
            stack: None,
        }),
        stats: NativeStats {
            wall_time_ms: start.elapsed().as_secs_f64() * 1000.0,
            cpu_time_ms: None,
            memory_used_bytes: None,
            memory_limit_bytes: None,
            max_stack_bytes: None,
        },
    }
}

async fn configure_wall_time_limit(
    vm: &Vm,
    wall_timeout: Option<Duration>,
) -> Option<Arc<AtomicBool>> {
    let wall_timeout = wall_timeout?;
    let timeout = Arc::new(AtomicBool::new(false));
    let timeout_for_handler = Arc::clone(&timeout);
    let deadline = Instant::now() + wall_timeout;
    vm.runtime
        .set_interrupt_handler(Some(Box::new(move || {
            let should_interrupt = Instant::now() >= deadline;
            if should_interrupt {
                timeout_for_handler.store(true, Ordering::Relaxed);
            }
            should_interrupt
        })))
        .await;

    Some(timeout)
}

async fn execute_with_wall_timeout<F>(
    execution: F,
    wall_timeout: Option<Duration>,
) -> std::result::Result<String, NativeErrorInfo>
where
    F: std::future::Future<Output = std::result::Result<String, NativeErrorInfo>>,
{
    let Some(wall_timeout) = wall_timeout else {
        return execution.await;
    };

    match tokio::time::timeout(wall_timeout, execution).await {
        Ok(result) => result,
        Err(_) => Err(timeout_error()),
    }
}

fn timeout_error() -> NativeErrorInfo {
    NativeErrorInfo {
        code: "TIMEOUT".to_string(),
        name: "LlrtTimeoutError".to_string(),
        message: "Execution exceeded wall-time limit".to_string(),
        stack: None,
    }
}

fn limit_error(code: &str, name: &str, message: &str) -> NativeErrorInfo {
    NativeErrorInfo {
        code: code.to_string(),
        name: name.to_string(),
        message: message.to_string(),
        stack: None,
    }
}

fn host_limit_error(code: &str, message: &str) -> NativeErrorInfo {
    limit_error(code, "LlrtHostLimitError", message)
}

fn host_error_to_quickjs(error: NativeErrorInfo, error_marker: &str) -> rquickjs::Error {
    let marker = serde_json::to_string(&error).unwrap_or_else(|_| {
        r#"{"code":"EVALUATION_ERROR","name":"Error","message":"Host error"}"#.to_string()
    });
    rquickjs::Error::new_from_js_message(
        "host function",
        "JSON string",
        format!("{error_marker}{marker}"),
    )
}

async fn execute_function(
    vm: &Vm,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
    host_paths: Vec<String>,
    max_host_payload_bytes: usize,
    error_marker: String,
) -> std::result::Result<String, NativeErrorInfo> {
    vm.ctx
        .async_with(async |ctx| {
            execute_in_context(
                ctx,
                source,
                input_json,
                host_dispatcher,
                host_paths,
                max_host_payload_bytes,
                error_marker,
            )
            .await
        })
        .await
}

async fn execute_in_context<'js>(
    ctx: Ctx<'js>,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
    host_paths: Vec<String>,
    max_host_payload_bytes: usize,
    error_marker: String,
) -> std::result::Result<String, NativeErrorInfo> {
    execute_in_context_inner(
        ctx.clone(),
        source,
        input_json,
        host_dispatcher,
        host_paths,
        max_host_payload_bytes,
        error_marker.clone(),
    )
        .await
        .catch(&ctx)
        .map_err(|error| native_error_from_caught(&ctx, error, &error_marker))
}

async fn execute_in_context_inner<'js>(
    ctx: Ctx<'js>,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
    host_paths: Vec<String>,
    max_host_payload_bytes: usize,
    error_marker: String,
) -> rquickjs::Result<String> {
    let function: QuickFunction = ctx.eval(format!("({source})"))?;
    let input = json_parse(&ctx, input_json.into_bytes())?;
    let argument = Object::new(ctx.clone())?;
    argument.set("input", input)?;
    if let Some(host_dispatcher) = host_dispatcher {
        if host_paths.is_empty() {
            let host_error_marker = error_marker.clone();
            let host_function = Func::from(Async(move |name: String, args_json: String| {
                call_host_function(
                    Arc::clone(&host_dispatcher),
                    name,
                    args_json,
                    max_host_payload_bytes,
                    host_error_marker.clone(),
                )
            }));
            ctx.globals().set("__llrtHostCall", host_function)?;
        } else {
            let host = build_host_object(
                &ctx,
                host_dispatcher,
                host_paths,
                max_host_payload_bytes,
                error_marker.clone(),
            )?;
            argument.set("host", host)?;
        }
    }

    let result = function.call::<_, Value>((This(ctx.globals()), argument))?;
    let promise_constructor: Value = ctx.globals().get(PredefinedAtom::Promise)?;
    let result = match result.as_object() {
        Some(object) if object.is_instance_of(&promise_constructor) => {
            result.get::<QuickPromise>()?.into_future::<Value>().await?
        }
        _ => result,
    };

    Ok(json_stringify(&ctx, result)?.unwrap_or_default())
}

fn build_host_object<'js>(
    ctx: &Ctx<'js>,
    dispatcher: Arc<HostDispatcher>,
    host_paths: Vec<String>,
    max_host_payload_bytes: usize,
    error_marker: String,
) -> rquickjs::Result<Object<'js>> {
    let host = Object::new(ctx.clone())?;
    let mut namespaces: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();

    for path in host_paths {
        let Some((namespace, method)) = path.split_once('.') else {
            return Err(rquickjs::Error::new_from_js_message(
                "host path",
                "namespace.method",
                format!("Invalid LLRT host path: {path}"),
            ));
        };
        if !is_safe_host_segment(namespace) || !is_safe_host_segment(method) {
            return Err(rquickjs::Error::new_from_js_message(
                "host path",
                "safe namespace.method",
                format!("Invalid LLRT host path: {path}"),
            ));
        }
        namespaces
            .entry(namespace.to_string())
            .or_default()
            .push((method.to_string(), path));
    }

    for (namespace, methods) in namespaces {
        let namespace_object = Object::new(ctx.clone())?;
        for (method, path) in methods {
            let host_error_marker = error_marker.clone();
            let host_dispatcher = Arc::clone(&dispatcher);
            let host_function = Func::from(Async(move |args_json: String| {
                call_host_function(
                    Arc::clone(&host_dispatcher),
                    path.clone(),
                    args_json,
                    max_host_payload_bytes,
                    host_error_marker.clone(),
                )
            }));
            namespace_object.set(method, host_function)?;
        }
        host.set(namespace, namespace_object)?;
    }

    Ok(host)
}

fn is_safe_host_segment(segment: &str) -> bool {
    if matches!(segment, "__proto__" | "prototype" | "constructor") {
        return false;
    }
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|char| char == '_' || char == '$' || char.is_ascii_alphanumeric())
}

async fn call_host_function(
    dispatcher: Arc<HostDispatcher>,
    name: String,
    args_json: String,
    max_host_payload_bytes: usize,
    error_marker: String,
) -> rquickjs::Result<String> {
    if args_json.len() > max_host_payload_bytes {
        return Err(host_error_to_quickjs(host_limit_error(
            "HOST_PAYLOAD_LIMIT",
            &format!("LLRT host call arguments exceed limit of {max_host_payload_bytes} bytes"),
        ), &error_marker));
    }
    let payload_json = serde_json::json!({
        "name": name,
        "argsJson": args_json,
    })
    .to_string();
    if payload_json.len() > max_host_payload_bytes {
        return Err(host_error_to_quickjs(host_limit_error(
            "HOST_PAYLOAD_LIMIT",
            &format!("LLRT host call payload exceeds limit of {max_host_payload_bytes} bytes"),
        ), &error_marker));
    }

    let result_json = dispatcher
        .call_async_catch(payload_json)
        .await
        .map_err(|error| {
            rquickjs::Error::new_from_js_message(
                "host function",
                "JSON string promise",
                error.to_string(),
            )
        })?
        .await
        .map_err(|error| {
            rquickjs::Error::new_from_js_message("host function", "JSON string", error.to_string())
        })?;

    if let Some(error) = host_error_from_message(&result_json, &error_marker) {
        return Err(host_error_to_quickjs(error, &error_marker));
    }

    Ok(result_json)
}

fn native_error_from_caught<'js>(
    ctx: &Ctx<'js>,
    error: CaughtError<'js>,
    error_marker: &str,
) -> NativeErrorInfo {
    match error {
        CaughtError::Exception(exception) => {
            let message = exception.message().unwrap_or_default();
            host_error_from_message(&message, error_marker).unwrap_or_else(|| NativeErrorInfo {
                code: "EVALUATION_ERROR".to_string(),
                name: exception_name(&exception).unwrap_or_else(|| "Error".to_string()),
                message,
                stack: exception.stack(),
            })
        }
        CaughtError::Value(value) => NativeErrorInfo {
            code: "EVALUATION_ERROR".to_string(),
            name: value.type_name().to_string(),
            message: json_stringify(ctx, value)
                .ok()
                .flatten()
                .unwrap_or_else(|| "Non-Error JavaScript exception".to_string()),
            stack: None,
        },
        CaughtError::Error(error) => {
            let message = error.to_string();
            host_error_from_message(&message, error_marker).unwrap_or_else(|| NativeErrorInfo {
                code: "EVALUATION_ERROR".to_string(),
                name: "Error".to_string(),
                message,
                stack: None,
            })
        }
    }
}

fn host_error_from_message(message: &str, error_marker: &str) -> Option<NativeErrorInfo> {
    let marker_start = message.find(error_marker)?;
    let payload = &message[marker_start + error_marker.len()..];
    serde_json::from_str(payload).ok()
}

fn exception_name(exception: &rquickjs::Exception<'_>) -> Option<String> {
    exception
        .as_object()
        .get::<_, Option<Object>>(PredefinedAtom::Constructor)
        .ok()
        .flatten()
        .and_then(|constructor| {
            constructor
                .get::<_, Option<String>>(PredefinedAtom::Name)
                .ok()
                .flatten()
        })
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn creates_llrt_vm() {
        let vm = llrt_core::vm::Vm::new()
            .await
            .expect("LLRT VM should initialize");
        vm.idle().await.expect("LLRT VM should idle cleanly");
    }
}
