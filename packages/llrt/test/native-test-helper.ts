import { describe } from "vitest";
import { getNativeBindingAvailability } from "../src/native.js";

const nativeBindingAvailability = getNativeBindingAvailability();
const nativeBindingAvailable = nativeBindingAvailability.available;

if (!nativeBindingAvailable && process.env.LLRT_REQUIRE_NATIVE_TESTS === "1") {
  throw new Error("LLRT native tests require a built native binding", {
    cause: nativeBindingAvailability.error,
  });
}

export const describeWithNativeBinding = nativeBindingAvailable
  ? describe
  : describe.skip;
