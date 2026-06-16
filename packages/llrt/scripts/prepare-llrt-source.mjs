import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const LLRT_REPOSITORY = "https://github.com/awslabs/llrt.git";
const LLRT_REVISION = "80c113ddee03ff1926068193f50fe35f41ca2105";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(packageRoot, "vendor");
const llrtRoot = resolve(vendorRoot, "llrt");
const patchesRoot = resolve(packageRoot, "patches");

await mkdir(vendorRoot, { recursive: true });
await ensureCheckout();
await applyLocalPatches();
await ensureGeneratedBundle();

async function ensureCheckout() {
  if (!existsSync(resolve(llrtRoot, ".git"))) {
    await rm(llrtRoot, { force: true, recursive: true });
    await mkdir(llrtRoot, { recursive: true });
    run("git", ["init", "-q"], llrtRoot);
    run("git", ["remote", "add", "origin", LLRT_REPOSITORY], llrtRoot);
  }

  const currentRevision = git(["rev-parse", "--verify", "HEAD"], llrtRoot, {
    allowFailure: true,
  });
  if (currentRevision === LLRT_REVISION) {
    return;
  }

  run("git", ["fetch", "--depth=1", "origin", LLRT_REVISION], llrtRoot);
  run("git", ["checkout", "--detach", LLRT_REVISION], llrtRoot);
}

async function applyLocalPatches() {
  applyPatchOnce(resolve(patchesRoot, "disable-default-module-loading.patch"));
}

function applyPatchOnce(patchPath) {
  const checkResult = spawnSync("git", ["apply", "--check", patchPath], {
    cwd: llrtRoot,
    stdio: "ignore",
  });
  if (checkResult.status === 0) {
    run("git", ["apply", patchPath], llrtRoot);
    return;
  }

  const reverseCheckResult = spawnSync("git", ["apply", "--reverse", "--check", patchPath], {
    cwd: llrtRoot,
    stdio: "ignore",
  });
  if (reverseCheckResult.status === 0) {
    return;
  }

  throw new Error(`Unable to apply LLRT patch: ${patchPath}`);
}

async function ensureGeneratedBundle() {
  if (existsSync(resolve(llrtRoot, "bundle/js/@llrt/std.js"))) {
    return;
  }

  if (!existsSync(resolve(llrtRoot, "node_modules/esbuild"))) {
    run("yarn", ["install", "--immutable"], llrtRoot);
  }
  run("make", ["js"], llrtRoot);
}

function git(args, cwd, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "pipe" : "inherit"],
  });

  if (result.status !== 0) {
    if (options.allowFailure) {
      return undefined;
    }
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout.trim();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}
