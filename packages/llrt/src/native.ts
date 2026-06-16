import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorInfo } from "./errors.js";
import type {
  LlrtExecutionErrorInfo,
  LlrtStats,
} from "./types.js";

export interface NativeCallSuccess {
  ok: true;
  valueJson: string;
  stats: LlrtStats;
}

export interface NativeCallFailure {
  ok: false;
  error: LlrtExecutionErrorInfo;
  stats: LlrtStats;
}

export type NativeCallResult = NativeCallSuccess | NativeCallFailure;

export interface NativeRuntimeOptions {
  memoryMb?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  maxStackBytes?: number;
}

export interface NativeBinding {
  nativeSmoke(): string;
  callJson(
    source: string,
    inputJson: string,
    options: NativeRuntimeOptions,
    hostDispatcher?: (payloadJson: string) => Promise<string>,
  ): Promise<NativeCallResult>;
  dispose(): void;
}

export type NativeBindingCandidate =
  | { kind: "path"; specifier: string }
  | { kind: "package"; specifier: string };

let testBinding: NativeBinding | null | undefined;

export function setNativeBindingForTest(binding: NativeBinding | null | undefined): void {
  testBinding = binding;
}

function nativePlatformArchAbi(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
  if (platform === "linux" && arch === "arm64") return "linux-arm64-gnu";

  return undefined;
}

function localNativeCandidates(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): NativeBindingCandidate[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, "..");
  const platformArchAbi = nativePlatformArchAbi(platform, arch);
  const platformSpecific = platformArchAbi
    ? [
        join(packageRoot, "native", `llrt_node.${platformArchAbi}.node`),
        join(packageRoot, `llrt_node.${platformArchAbi}.node`),
      ]
    : [];

  return [
    ...platformSpecific,
    join(packageRoot, "native", "llrt_node.node"),
    join(packageRoot, "llrt_node.node"),
  ].map((specifier) => ({ kind: "path", specifier }));
}

export function nativePackageNameForPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  const platformArchAbi = nativePlatformArchAbi(platform, arch);

  return platformArchAbi ? `@robinbraemer/llrt-${platformArchAbi}` : undefined;
}

export function nativeBindingCandidates(
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  } = {},
): NativeBindingCandidate[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const optionalPackageName = nativePackageNameForPlatform(platform, arch);
  const packageCandidates: NativeBindingCandidate[] = optionalPackageName
    ? [{ kind: "package", specifier: optionalPackageName }]
    : [];

  return [
    ...localNativeCandidates(platform, arch),
    ...packageCandidates,
    { kind: "path", specifier: "../llrt_node.node" },
  ];
}

export function loadNativeBinding(): NativeBinding {
  if (testBinding === null) {
    throw Object.assign(new Error("Native binding disabled for test"), {
      llrtError: errorInfo("NATIVE_LOAD_ERROR", "Native binding disabled for test"),
    });
  }
  if (testBinding) return testBinding;

  const require = createRequire(import.meta.url);
  const errors: unknown[] = [];

  for (const candidate of nativeBindingCandidates()) {
    try {
      return require(candidate.specifier) as NativeBinding;
    } catch (error) {
      errors.push(error);
    }
  }

  throw Object.assign(new Error("Unable to load @robinbraemer/llrt native binding"), {
    cause: errors,
    llrtError: errorInfo("NATIVE_LOAD_ERROR", errors.at(-1) ?? "No native candidates tried"),
  });
}

export function isNativeBindingAvailable(): boolean {
  return getNativeBindingAvailability().available;
}

export type NativeBindingAvailability =
  | { available: true }
  | { available: false; error: unknown };

export function getNativeBindingAvailability(): NativeBindingAvailability {
  try {
    loadNativeBinding();
    return { available: true };
  } catch (error) {
    return { available: false, error };
  }
}
