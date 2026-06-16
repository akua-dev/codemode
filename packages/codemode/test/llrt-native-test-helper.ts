import { describe } from "vitest";
import { getNativeBindingAvailability } from "../../llrt/src/index.js";

const nativeBindingAvailability = getNativeBindingAvailability();

export const llrtNativeBindingAvailable = nativeBindingAvailability.available;

if (!llrtNativeBindingAvailable && process.env.LLRT_REQUIRE_NATIVE_TESTS === "1") {
  throw new Error("Codemode LLRT executor tests require a built LLRT native binding", {
    cause: nativeBindingAvailability.error,
  });
}

export const describeWithLlrtNativeBinding = llrtNativeBindingAvailable
  ? describe
  : describe.skip;
