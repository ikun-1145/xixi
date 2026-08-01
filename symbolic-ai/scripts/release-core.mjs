import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const webRoot = path.resolve(projectRoot, "..");
const flutterRoot = process.env.SUNLAND_FLUTTER_ROOT
  ? path.resolve(process.env.SUNLAND_FLUTTER_ROOT)
  : path.resolve(projectRoot, "../../..", "sunland_ai_app");

const artifactName = "sunland-core.js";
const manifestName = "sunland-core.manifest.json";
const releaseReportName = "sunland-core.release-report.json";
const apiSurfaceContractName = "sdk-api-surface.v0.1.0.json";
const stagingArtifact = path.join(projectRoot, "dist", "core", artifactName);
const releaseReportPath = path.join(
  projectRoot,
  "dist",
  "core",
  releaseReportName,
);
const packageJsonPath = path.join(projectRoot, "package.json");
const apiSurfaceContractPath = path.join(
  projectRoot,
  "contracts",
  apiSurfaceContractName,
);
const targets = [
  {
    id: "web",
    label: "Web",
    rootMarker: path.join(webRoot, "ai", "providers", "SunlandProvider.js"),
    artifact: path.join(webRoot, "ai", "vendor", artifactName),
    manifest: path.join(webRoot, "ai", "vendor", manifestName),
  },
  {
    id: "flutter",
    label: "Flutter",
    rootMarker: path.join(flutterRoot, "pubspec.yaml"),
    artifact: path.join(flutterRoot, "assets", artifactName),
    manifest: path.join(flutterRoot, "assets", manifestName),
  },
];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

async function assertRegularFile(filePath, description) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${description}不存在：${filePath}`);
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new Error(`${description}不是普通文件：${filePath}`);
  }
}

async function writeAtomically(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readManifest(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 SHA-256 manifest：${filePath}\n${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`SHA-256 manifest 格式无效：${filePath}`);
  }
  return parsed;
}

async function readPackageMetadata() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    typeof packageJson.name !== "string" ||
    packageJson.name.length === 0 ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error(`package.json 缺少有效的 name/version：${packageJsonPath}`);
  }
  return { name: packageJson.name, version: packageJson.version };
}

async function readApiSurfaceContract(expectedVersion) {
  let contract;
  try {
    contract = JSON.parse(await readFile(apiSurfaceContractPath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取 SDK API Surface 契约：${apiSurfaceContractPath}\n${error.message}`,
    );
  }

  if (
    contract?.schemaVersion !== 1 ||
    contract.sdkVersion !== expectedVersion ||
    contract.entry !== "src/sdk.ts" ||
    !Array.isArray(contract.runtimeExports) ||
    contract.runtimeExports.length === 0 ||
    contract.runtimeExports.some(
      (name) => typeof name !== "string" || name.length === 0,
    )
  ) {
    throw new Error(
      `SDK API Surface 契约格式或版本无效：${apiSurfaceContractPath}`,
    );
  }

  const sortedExports = [...contract.runtimeExports].sort();
  if (
    new Set(sortedExports).size !== sortedExports.length ||
    sortedExports.some((name, index) => name !== contract.runtimeExports[index])
  ) {
    throw new Error("SDK API Surface 导出基线必须唯一且按字母排序");
  }
  return contract;
}

async function createManifest(artifact) {
  const packageMetadata = await readPackageMetadata();
  return {
    schemaVersion: 1,
    artifact: artifactName,
    version: packageMetadata.version,
    algorithm: "SHA-256",
    sha256: sha256(artifact),
    bytes: artifact.byteLength,
  };
}

async function readRuntimeSdk(artifactPath) {
  const artifact = await readFile(artifactPath);
  const encodedArtifact = artifact.toString("base64");
  return import(`data:text/javascript;base64,${encodedArtifact}`);
}

async function verifyRuntimeContract(artifactPath, expectedVersion) {
  const [sdk, apiSurfaceContract] = await Promise.all([
    readRuntimeSdk(artifactPath),
    readApiSurfaceContract(expectedVersion),
  ]);
  if (
    typeof sdk.SUNLAND_CORE_VERSION !== "string" ||
    sdk.SUNLAND_CORE_VERSION.length === 0
  ) {
    throw new Error(`${artifactName} 未导出有效的 SUNLAND_CORE_VERSION`);
  }
  const runtimeVersion = sdk.SUNLAND_CORE_VERSION;
  if (runtimeVersion !== expectedVersion) {
    throw new Error(
      `Core 运行时版本不一致：manifest=${expectedVersion}，bundle=${runtimeVersion}`,
    );
  }

  const runtimeExports = Object.keys(sdk).sort();
  const expectedExports = apiSurfaceContract.runtimeExports;
  const missingExports = expectedExports.filter(
    (name) => !runtimeExports.includes(name),
  );
  const unexpectedExports = runtimeExports.filter(
    (name) => !expectedExports.includes(name),
  );
  if (missingExports.length > 0 || unexpectedExports.length > 0) {
    throw new Error(
      `SDK API Surface 不一致：missing=${JSON.stringify(missingExports)}，unexpected=${JSON.stringify(unexpectedExports)}`,
    );
  }
  return {
    runtimeVersion,
    runtimeExportCount: runtimeExports.length,
  };
}

async function verifyTarget(target, expectedManifest) {
  await assertRegularFile(target.artifact, `${target.label} Core 产物`);
  await assertRegularFile(target.manifest, `${target.label} Core manifest`);

  const artifact = await readFile(target.artifact);
  const manifest = await readManifest(target.manifest);
  const actualHash = sha256(artifact);
  const expectedEntries = Object.entries(expectedManifest);
  const manifestKeys = Object.keys(manifest);
  const expectedKeys = Object.keys(expectedManifest);

  if (
    manifestKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !manifestKeys.includes(key))
  ) {
    throw new Error(`${target.label} manifest 字段集合不一致`);
  }

  for (const [key, value] of expectedEntries) {
    if (manifest[key] !== value) {
      throw new Error(
        `${target.label} manifest 字段不一致：${key}，期望 ${value}，实际 ${manifest[key]}`,
      );
    }
  }
  if (actualHash !== manifest.sha256 || artifact.byteLength !== manifest.bytes) {
    throw new Error(`${target.label} Core 产物与 manifest 不一致`);
  }
  return artifact;
}

async function verifyRelease() {
  await assertRegularFile(targets[0].artifact, `${targets[0].label} Core 产物`);
  const referenceManifest = await createManifest(
    await readFile(targets[0].artifact),
  );
  const artifacts = [];
  for (const target of targets) {
    artifacts.push(await verifyTarget(target, referenceManifest));
  }

  const referenceArtifact = artifacts[0];
  for (let index = 1; index < artifacts.length; index += 1) {
    if (!referenceArtifact.equals(artifacts[index])) {
      throw new Error(
        `${targets[0].label} 与 ${targets[index].label} 的 Core 产物字节不一致`,
      );
    }
  }

  const runtimeContract = await verifyRuntimeContract(
    targets[0].artifact,
    referenceManifest.version,
  );

  console.log(
    `Sunland Core 一致性检查通过：${referenceManifest.sha256} (${referenceManifest.bytes} bytes)`,
  );
  return {
    manifest: referenceManifest,
    runtimeVersion: runtimeContract.runtimeVersion,
    runtimeExportCount: runtimeContract.runtimeExportCount,
  };
}

async function writeReleaseReport(verification) {
  const packageMetadata = await readPackageMetadata();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    package: packageMetadata,
    sdk: {
      entry: "src/sdk.ts",
      format: "es",
      apiSurfaceContract: relativePath(apiSurfaceContractPath),
      runtimeExportCount: verification.runtimeExportCount,
    },
    artifact: verification.manifest,
    runtime: {
      versionExport: "SUNLAND_CORE_VERSION",
      version: verification.runtimeVersion,
    },
    targets: targets.map((target) => ({
      id: target.id,
      label: target.label,
      artifact: relativePath(target.artifact),
      manifest: relativePath(target.manifest),
    })),
    checks: {
      targetCount: targets.length,
      artifactsByteIdentical: true,
      manifestsMatchArtifact: true,
      runtimeVersionMatchesManifest: true,
      apiSurfaceMatchesContract: true,
    },
  };
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  await writeAtomically(releaseReportPath, serializedReport);
  if ((await readFile(releaseReportPath, "utf8")) !== serializedReport) {
    throw new Error(`Core release report 写入校验失败：${releaseReportPath}`);
  }
  console.log(`已生成 Core release report：${relativePath(releaseReportPath)}`);
}

async function publishRelease() {
  await assertRegularFile(stagingArtifact, "Sunland Core staging 产物");
  for (const target of targets) {
    await assertRegularFile(target.rootMarker, `${target.label} 项目标记文件`);
  }

  const artifact = await readFile(stagingArtifact);
  const manifest = await createManifest(artifact);
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await verifyRuntimeContract(stagingArtifact, manifest.version);

  for (const target of targets) {
    await writeAtomically(target.artifact, artifact);
    await writeAtomically(target.manifest, serializedManifest);
    console.log(`已同步 Sunland Core 到 ${target.label}：${target.artifact}`);
  }

  const verification = await verifyRelease();
  await writeReleaseReport(verification);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("用法：node scripts/release-core.mjs [--check]");
}

if (args[0] === "--check") {
  await verifyRelease();
} else {
  await publishRelease();
}
