use std::{
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
use rquickjs::{
    atom::PredefinedAtom,
    function::This,
    prelude::{Async, Func},
    CatchResultExt, CaughtError, Ctx, Function as QuickFunction, Object, Promise as QuickPromise,
    Value,
};

type HostDispatcher = ThreadsafeFunction<String, NapiPromise<String>, String, Status, false>;

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
}

#[napi(object)]
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
    let max_stack_bytes = options
        .max_stack_bytes
        .map(|value| value as usize)
        .unwrap_or_else(|| VmOptions::default().max_stack_size);
    let memory_limit_bytes = options
        .memory_mb
        .map(|value| (value * 1024.0 * 1024.0) as usize)
        .unwrap_or(64 * 1024 * 1024);

    let vm = Vm::from_options(VmOptions {
        module_builder: ModuleBuilder::new(),
        allow_module_loading: false,
        max_stack_size: max_stack_bytes,
        ..VmOptions::default()
    })
    .await
    .map_err(|error| Error::from_reason(error.to_string()))?;
    vm.runtime.set_memory_limit(memory_limit_bytes).await;

    let wall_timeout = wall_time_duration(options.wall_time_ms);
    let timeout_flag = configure_wall_time_limit(&vm, wall_timeout).await;
    let result = execute_with_wall_timeout(
        execute_function(&vm, source, input_json, host_dispatcher),
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

    Ok(NativeCallResult {
        ok: true,
        value_json: Some(value_json),
        error: None,
        stats,
    })
}

fn wall_time_duration(wall_time_ms: Option<f64>) -> Option<Duration> {
    let wall_time_ms = wall_time_ms?;
    if !wall_time_ms.is_finite() || wall_time_ms < 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(wall_time_ms / 1000.0))
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

async fn execute_function(
    vm: &Vm,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
) -> std::result::Result<String, NativeErrorInfo> {
    vm.ctx
        .async_with(async |ctx| execute_in_context(ctx, source, input_json, host_dispatcher).await)
        .await
}

async fn execute_in_context<'js>(
    ctx: Ctx<'js>,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
) -> std::result::Result<String, NativeErrorInfo> {
    execute_in_context_inner(ctx.clone(), source, input_json, host_dispatcher)
        .await
        .catch(&ctx)
        .map_err(|error| native_error_from_caught(&ctx, error))
}

async fn execute_in_context_inner<'js>(
    ctx: Ctx<'js>,
    source: String,
    input_json: String,
    host_dispatcher: Option<Arc<HostDispatcher>>,
) -> rquickjs::Result<String> {
    if let Some(host_dispatcher) = host_dispatcher {
        let host_function = Func::from(Async(move |name: String, args_json: String| {
            call_host_function(Arc::clone(&host_dispatcher), name, args_json)
        }));
        ctx.globals().set("__llrtHostCall", host_function)?;
    }

    let function: QuickFunction = ctx.eval(format!("({source})"))?;
    let input = json_parse(&ctx, input_json.into_bytes())?;
    let argument = Object::new(ctx.clone())?;
    argument.set("input", input)?;

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

async fn call_host_function(
    dispatcher: Arc<HostDispatcher>,
    name: String,
    args_json: String,
) -> rquickjs::Result<String> {
    let payload_json = serde_json::json!({
        "name": name,
        "argsJson": args_json,
    })
    .to_string();

    dispatcher
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
        })
}

fn native_error_from_caught<'js>(ctx: &Ctx<'js>, error: CaughtError<'js>) -> NativeErrorInfo {
    match error {
        CaughtError::Exception(exception) => NativeErrorInfo {
            code: "EVALUATION_ERROR".to_string(),
            name: exception_name(&exception).unwrap_or_else(|| "Error".to_string()),
            message: exception.message().unwrap_or_default(),
            stack: exception.stack(),
        },
        CaughtError::Value(value) => NativeErrorInfo {
            code: "EVALUATION_ERROR".to_string(),
            name: value.type_name().to_string(),
            message: json_stringify(ctx, value)
                .ok()
                .flatten()
                .unwrap_or_else(|| "Non-Error JavaScript exception".to_string()),
            stack: None,
        },
        CaughtError::Error(error) => NativeErrorInfo {
            code: "EVALUATION_ERROR".to_string(),
            name: "Error".to_string(),
            message: error.to_string(),
            stack: None,
        },
    }
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
