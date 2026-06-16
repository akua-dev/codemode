import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targetInfo = {
  "aarch64-apple-darwin": {
    cpu: "arm64",
    dir: "darwin-arm64",
    os: "darwin",
  },
  "x86_64-apple-darwin": {
    cpu: "x64",
    dir: "darwin-x64",
    os: "darwin",
  },
  "x86_64-unknown-linux-gnu": {
    cpu: "x64",
    dir: "linux-x64-gnu",
    libc: "glibc",
    os: "linux",
  },
  "aarch64-unknown-linux-gnu": {
    cpu: "arm64",
    dir: "linux-arm64-gnu",
    libc: "glibc",
    os: "linux",
  },
};

export function expectedNativePackages(targets) {
  return targets.map((target) => {
    const info = targetInfo[target];
    if (!info) {
      throw new Error(`Unsupported napi target in package manifest: ${target}`);
    }

    return {
      target,
      dir: info.dir,
      packageName: `@robinbraemer/llrt-${info.dir}`,
      nodeFile: `llrt_node.${info.dir}.node`,
      os: info.os,
      cpu: info.cpu,
      libc: info.libc,
    };
  });
}

export async function verifyNativeArtifacts(options = {}) {
  const packageRoot = options.packageRoot ?? defaultPackageRoot;
  const requireBinaries = options.requireBinaries ?? false;
  const rootPackageJson = await readJson(join(packageRoot, "package.json"));
  const targets = rootPackageJson.napi?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("Root package.json must declare napi.targets");
  }

  const expectedPackages = expectedNativePackages(targets);
  await Promise.all(
    expectedPackages.map((expectedPackage) =>
      verifyNativePackage(packageRoot, rootPackageJson, expectedPackage, requireBinaries),
    ),
  );

  return expectedPackages.map((expectedPackage) => expectedPackage.dir).toSorted();
}

async function verifyNativePackage(
  packageRoot,
  rootPackageJson,
  expectedPackage,
  requireBinaries,
) {
  const relativePackageDir = join("npm", expectedPackage.dir);
  const packageDir = join(packageRoot, relativePackageDir);
  const packageJsonPath = join(packageDir, "package.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing native package manifest: ${relativePackageDir}/package.json`);
  }

  const packageJson = await readJson(packageJsonPath);
  expectEqual(packageJson.name, expectedPackage.packageName, `${relativePackageDir} name`);
  expectEqual(packageJson.version, rootPackageJson.version, `${relativePackageDir} version`);
  expectEqual(packageJson.main, expectedPackage.nodeFile, `${relativePackageDir} main`);
  expectArrayEqual(packageJson.files, [expectedPackage.nodeFile], `${relativePackageDir} files`);
  expectArrayEqual(packageJson.os, [expectedPackage.os], `${relativePackageDir} os`);
  expectArrayEqual(packageJson.cpu, [expectedPackage.cpu], `${relativePackageDir} cpu`);
  expectEqual(packageJson.license, rootPackageJson.license, `${relativePackageDir} license`);
  expectEqual(
    packageJson.repository?.type,
    rootPackageJson.repository?.type,
    `${relativePackageDir} repository.type`,
  );
  expectEqual(
    packageJson.repository?.url,
    rootPackageJson.repository?.url,
    `${relativePackageDir} repository.url`,
  );
  expectEqual(
    packageJson.repository?.directory,
    rootPackageJson.repository?.directory,
    `${relativePackageDir} repository.directory`,
  );
  expectEqual(
    packageJson.publishConfig?.access,
    rootPackageJson.publishConfig?.access,
    `${relativePackageDir} publishConfig.access`,
  );

  if (expectedPackage.libc) {
    expectArrayEqual(packageJson.libc, [expectedPackage.libc], `${relativePackageDir} libc`);
  } else if ("libc" in packageJson) {
    throw new Error(`${relativePackageDir} must not declare libc`);
  }

  if (requireBinaries) {
    const binaryPath = join(packageDir, expectedPackage.nodeFile);
    if (!existsSync(binaryPath)) {
      throw new Error(`Missing native artifact: ${relativePackageDir}/${expectedPackage.nodeFile}`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectArrayEqual(actual, expected, label) {
  if (!Array.isArray(actual)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  expectEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function parseArgs(args) {
  return {
    requireBinaries: args.includes("--require-binaries"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const verified = await verifyNativeArtifacts(options);
  console.log(`Verified LLRT native packages: ${verified.join(", ")}`);
}
