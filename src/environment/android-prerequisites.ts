import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { OpenPocketConfig } from "../types.js";
import { ensureDir } from "../utils/paths.js";

type ToolName = "adb" | "emulator" | "sdkmanager" | "avdmanager";

type ToolPaths = Record<ToolName, string | null>;

export interface EnsureAndroidPrerequisitesOptions {
  autoInstall?: boolean;
  logger?: (line: string) => void;
}

export interface EnsureAndroidPrerequisitesResult {
  skipped: boolean;
  configUpdated: boolean;
  sdkRoot: string;
  toolPaths: ToolPaths;
  installedSteps: string[];
  avdCreated: boolean;
}

interface RunResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

interface JavaRuntimeInfo {
  javaHome: string | null;
  javaBin: string;
  major: number;
  rawVersion: string;
}

const DEFAULT_AVD_DATA_PARTITION_SIZE_GB = 24;
const STANDARD_AVD_LCD_WIDTH = 1080;
const STANDARD_AVD_LCD_HEIGHT = 2400;
const STANDARD_AVD_LCD_DENSITY = 420;
const PREFERRED_ANDROID_PLATFORM_PACKAGES = ["platforms;android-36", "platforms;android-34"] as const;
const PREFERRED_SYSTEM_IMAGE_API_LEVELS = ["android-36.1", "android-34"] as const;

function normalizeDataPartitionSizeGb(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_AVD_DATA_PARTITION_SIZE_GB;
  }
  return Math.max(8, Math.min(512, Math.round(parsed)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type AvdConfigOverride = {
  key: string;
  value: string;
};

export function upsertAvdConfigOverrides(content: string, overrides: AvdConfigOverride[]): string {
  let next = content;
  for (const override of overrides) {
    const line = `${override.key}=${override.value}`;
    const matcher = new RegExp(`^${escapeRegExp(override.key)}=.*$`, "m");
    if (matcher.test(next)) {
      next = next.replace(matcher, line);
      continue;
    }
    next = `${next.trimEnd()}\n${line}\n`;
  }
  return next;
}

function run(
  cmd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    inherit?: boolean;
  } = {},
): RunResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    env: options.env,
    input: options.input,
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return {
    ok: status === 0 && !result.error,
    status,
    stdout,
    stderr,
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && canExecute(resolved)) {
      return resolved;
    }
  }
  return null;
}

function findInPath(binName: string): string | null {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((v) => v.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, binName);
    if (fs.existsSync(candidate) && canExecute(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseJavaMajor(rawOutput: string): number | null {
  const quoted = rawOutput.match(/version\s+"([^"]+)"/i)?.[1]?.trim();
  if (quoted) {
    const parts = quoted.split(/[._-]/).filter(Boolean);
    if (parts[0] === "1" && parts.length > 1) {
      const major = Number(parts[1]);
      return Number.isFinite(major) ? major : null;
    }
    const major = Number(parts[0]);
    return Number.isFinite(major) ? major : null;
  }

  const fallback = rawOutput.match(/\bopenjdk\s+(\d+)(?:[.\s]|$)/i)?.[1];
  if (fallback) {
    const major = Number(fallback);
    return Number.isFinite(major) ? major : null;
  }

  return null;
}

function inspectJavaBin(javaBin: string): JavaRuntimeInfo | null {
  const result = run(javaBin, ["-version"]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output) {
    return null;
  }
  const major = parseJavaMajor(output);
  if (!major) {
    return null;
  }
  const javaHome = path.dirname(path.dirname(javaBin));
  return {
    javaHome,
    javaBin,
    major,
    rawVersion: output.split("\n")[0] ?? output,
  };
}

function detectBestJavaRuntime(): JavaRuntimeInfo | null {
  const homeCandidates: string[] = [];
  const envHome = process.env.JAVA_HOME?.trim();
  if (envHome) {
    homeCandidates.push(envHome);
  }

  const javaHomeDefault = run("/usr/libexec/java_home", []);
  if (javaHomeDefault.ok) {
    const resolved = javaHomeDefault.stdout.trim();
    if (resolved) {
      homeCandidates.push(resolved);
    }
  }

  const vmDir = "/Library/Java/JavaVirtualMachines";
  if (fs.existsSync(vmDir)) {
    for (const name of fs.readdirSync(vmDir)) {
      homeCandidates.push(path.join(vmDir, name, "Contents", "Home"));
    }
  }

  homeCandidates.push("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home");
  homeCandidates.push("/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home");

  const infos: JavaRuntimeInfo[] = [];
  const seen = new Set<string>();

  for (const home of homeCandidates) {
    const resolved = path.resolve(home);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const javaBin = path.join(resolved, "bin", "java");
    if (!fs.existsSync(javaBin) || !canExecute(javaBin)) {
      continue;
    }
    const info = inspectJavaBin(javaBin);
    if (info) {
      infos.push(info);
    }
  }

  const pathJava = findInPath("java");
  if (pathJava) {
    const resolved = path.resolve(pathJava);
    if (!seen.has(resolved)) {
      const info = inspectJavaBin(resolved);
      if (info) {
        infos.push(info);
      }
    }
  }

  if (infos.length === 0) {
    return null;
  }

  // Prefer JDK 17–21 which are well-tested with Android SDK tools.
  // Newer JDKs (22+) may break avdmanager/sdkmanager due to stricter
  // module access restrictions (JNA, etc.).
  const preferred = infos
    .filter((i) => i.major >= 17 && i.major <= 21)
    .sort((a, b) => b.major - a.major);
  if (preferred.length > 0) {
    return preferred[0];
  }

  // Fall back to the highest available version ≥ 17.
  infos.sort((a, b) => b.major - a.major);
  return infos[0];
}

function sdkRootScore(sdkRoot: string): number {
  // Score an SDK root by how complete it is.
  // Higher score = more useful (has tools, system images, platforms, etc.).
  let score = 0;
  const checks = [
    path.join(sdkRoot, "platform-tools", "adb"),
    path.join(sdkRoot, "emulator", "emulator"),
    path.join(sdkRoot, "cmdline-tools"),
    path.join(sdkRoot, "platforms"),
    path.join(sdkRoot, "system-images"),
  ];
  for (const p of checks) {
    if (fs.existsSync(p)) {
      score += 1;
    }
  }
  return score;
}

function collectSdkRoot(config: OpenPocketConfig): { sdkRoot: string; configUpdated: boolean } {
  // Gather all candidate SDK roots and pick the most complete one.
  const candidates: string[] = [];

  const configured = config.emulator.androidSdkRoot.trim();
  if (configured) {
    candidates.push(path.resolve(configured));
  }

  const envRoot = process.env.ANDROID_SDK_ROOT?.trim() || process.env.ANDROID_HOME?.trim() || "";
  if (envRoot) {
    candidates.push(path.resolve(envRoot));
  }

  // Well-known Android Studio SDK locations on macOS / Linux.
  candidates.push(path.join(os.homedir(), "Library", "Android", "sdk"));
  candidates.push(path.join(os.homedir(), "Android", "Sdk"));

  // Deduplicate and score each candidate.
  const seen = new Set<string>();
  let bestRoot = "";
  let bestScore = -1;
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const score = sdkRootScore(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestRoot = candidate;
    }
  }

  // If no candidate scored, fall back to the first existing one or default.
  if (!bestRoot) {
    bestRoot = configured
      ? path.resolve(configured)
      : envRoot
        ? path.resolve(envRoot)
        : path.join(os.homedir(), "Library", "Android", "sdk");
  }

  const configUpdated = bestRoot !== configured;
  if (configUpdated) {
    config.emulator.androidSdkRoot = bestRoot;
  }
  return { sdkRoot: bestRoot, configUpdated };
}

function detectTools(sdkRoot: string): ToolPaths {
  const fallbackSdk = path.join(os.homedir(), "Library", "Android", "sdk");
  const sdkRoots = Array.from(new Set([sdkRoot, fallbackSdk]));

  const adbCandidates = sdkRoots
    .map((root) => path.join(root, "platform-tools", "adb"))
    .concat(["/opt/homebrew/bin/adb", "/usr/local/bin/adb"]);
  const emulatorCandidates = sdkRoots
    .map((root) => path.join(root, "emulator", "emulator"))
    .concat([
      "/opt/homebrew/share/android-commandlinetools/emulator/emulator",
      "/usr/local/share/android-commandlinetools/emulator/emulator",
    ]);
  const sdkManagerCandidates = sdkRoots
    .map((root) => path.join(root, "cmdline-tools", "latest", "bin", "sdkmanager"))
    .concat([
      "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager",
      "/usr/local/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager",
    ]);
  const avdManagerCandidates = sdkRoots
    .map((root) => path.join(root, "cmdline-tools", "latest", "bin", "avdmanager"))
    .concat([
      "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/avdmanager",
      "/usr/local/share/android-commandlinetools/cmdline-tools/latest/bin/avdmanager",
    ]);

  return {
    adb: firstExecutable(adbCandidates) ?? findInPath("adb"),
    emulator: firstExecutable(emulatorCandidates) ?? findInPath("emulator"),
    sdkmanager: firstExecutable(sdkManagerCandidates) ?? findInPath("sdkmanager"),
    avdmanager: firstExecutable(avdManagerCandidates) ?? findInPath("avdmanager"),
  };
}

function missingTools(toolPaths: ToolPaths): ToolName[] {
  const required: ToolName[] = ["adb", "emulator", "sdkmanager", "avdmanager"];
  return required.filter((name) => !toolPaths[name]);
}

function missingEssentialTools(toolPaths: ToolPaths): ToolName[] {
  // Only adb and emulator are strictly required at runtime.
  // sdkmanager/avdmanager are only needed when creating new AVDs.
  const essential: ToolName[] = ["adb", "emulator"];
  return essential.filter((name) => !toolPaths[name]);
}

function resolveBrewBinary(): string | null {
  return firstExecutable(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) ?? findInPath("brew");
}

export function buildAvdManagerOpts(sdkRoot: string, existingOpts: string | undefined): string {
  const current = (existingOpts ?? "").trim();
  if (current.includes("-Dcom.android.sdkmanager.toolsdir=")) {
    return current;
  }

  const toolsDir = path.join(path.resolve(sdkRoot), "cmdline-tools", "latest");
  const toolsDirOpt = `"-Dcom.android.sdkmanager.toolsdir=${toolsDir}"`;
  return current ? `${current} ${toolsDirOpt}` : toolsDirOpt;
}

export function shouldRunSdkBootstrap(hasAnyAvd: boolean, essentialMissingCount: number): boolean {
  return !hasAnyAvd || essentialMissingCount > 0;
}

function extendProcessPathForBrew(): void {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const candidate of extra) {
    if (!entries.includes(candidate) && fs.existsSync(candidate)) {
      entries.unshift(candidate);
    }
  }
  process.env.PATH = entries.join(path.delimiter);
}

function installHomebrew(logger: (line: string) => void): void {
  logger("Homebrew not found. Installing Homebrew...");
  const result = run("/usr/bin/env", [
    "bash",
    "-lc",
    "NONINTERACTIVE=1 /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
  ], { inherit: true });
  if (!result.ok) {
    throw new Error("Failed to install Homebrew automatically.");
  }
  extendProcessPathForBrew();
}

function brewEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOMEBREW_NO_AUTO_UPDATE: process.env.HOMEBREW_NO_AUTO_UPDATE ?? "1",
    HOMEBREW_NO_ENV_HINTS: process.env.HOMEBREW_NO_ENV_HINTS ?? "1",
  };
}

function installBrewCask(brew: string, cask: string, logger: (line: string) => void): boolean {
  const exists = run(brew, ["list", "--cask", cask], { env: brewEnv() });
  if (exists.ok) {
    logger(`brew cask '${cask}' already installed (skip).`);
    return false;
  }
  logger(`Installing brew cask '${cask}'...`);
  const installed = run(brew, ["install", "--cask", cask], { inherit: true, env: brewEnv() });
  if (!installed.ok) {
    throw new Error(`brew install --cask ${cask} failed.`);
  }
  return true;
}

function resolveAndroidToolEnv(sdkRoot: string, javaHome: string): NodeJS.ProcessEnv {
  const extraBins = [
    path.join(javaHome, "bin"),
    path.join(sdkRoot, "platform-tools"),
    path.join(sdkRoot, "emulator"),
  ];
  const basePath = process.env.PATH ?? "";
  const pathEntries = [...extraBins, ...basePath.split(path.delimiter)].filter(Boolean);
  const avdmanagerOpts = buildAvdManagerOpts(sdkRoot, process.env.AVDMANAGER_OPTS);
  return {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_SDK_ROOT: sdkRoot,
    ANDROID_HOME: sdkRoot,
    AVDMANAGER_OPTS: avdmanagerOpts,
    PATH: Array.from(new Set(pathEntries)).join(path.delimiter),
  };
}

function acceptSdkLicenses(
  sdkmanager: string,
  sdkRoot: string,
  logger: (line: string) => void,
  toolEnv: NodeJS.ProcessEnv,
): void {
  logger("Accepting Android SDK licenses...");
  const res = run(sdkmanager, [`--sdk_root=${sdkRoot}`, "--licenses"], {
    env: toolEnv,
    input: `${"y\n".repeat(200)}`,
  });
  if (!res.ok) {
    logger("SDK licenses command returned non-zero; continuing.");
  }
}

function installSdkPackages(
  sdkmanager: string,
  sdkRoot: string,
  logger: (line: string) => void,
  toolEnv: NodeJS.ProcessEnv,
): string {
  logger("Installing Android SDK packages: platform-tools, emulator ...");
  const baseResult = run(
    sdkmanager,
    [`--sdk_root=${sdkRoot}`, "platform-tools", "emulator"],
    { inherit: true, env: toolEnv },
  );
  if (!baseResult.ok) {
    throw new Error(
      [
        "Failed to install required Android SDK packages (platform-tools/emulator).",
        "This usually means Java runtime is below 17 or JAVA_HOME points to an old JDK.",
      ].join(" "),
    );
  }

  for (const platformPkg of PREFERRED_ANDROID_PLATFORM_PACKAGES) {
    logger(`Trying Android platform package: ${platformPkg}`);
    const platformResult = run(sdkmanager, [`--sdk_root=${sdkRoot}`, platformPkg], { inherit: true, env: toolEnv });
    if (platformResult.ok) {
      logger(`Android platform ready: ${platformPkg}`);
      return platformPkg;
    }
  }

  throw new Error(
    [
      `Failed to install Android platform packages: ${PREFERRED_ANDROID_PLATFORM_PACKAGES.join(", ")}.`,
      "This usually means Java runtime is below 17 or JAVA_HOME points to an old JDK.",
    ].join(" "),
  );
}

function buildSystemImageCandidatesForApiLevel(apiLevel: string, archTag: string): string[] {
  return [
    `system-images;${apiLevel};google_apis_playstore;${archTag}`,
    `system-images;${apiLevel};google_apis_playstore;x86_64`,
    `system-images;${apiLevel};google_apis_playstore;arm64-v8a`,
  ];
}

function systemImageApiLevelPriority(pkg: string): number {
  const parts = pkg.split(";");
  if (parts.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  const apiLevel = parts[1];
  const index = PREFERRED_SYSTEM_IMAGE_API_LEVELS.indexOf(apiLevel as (typeof PREFERRED_SYSTEM_IMAGE_API_LEVELS)[number]);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

function prioritizeSystemImagePackages(pkgs: Iterable<string>): string[] {
  return Array.from(new Set(pkgs)).sort((a, b) => systemImageApiLevelPriority(a) - systemImageApiLevelPriority(b));
}

function findAnyGooglePlaySystemImage(sdkRoot: string): string[] {
  const imageRoot = path.join(sdkRoot, "system-images");
  if (!fs.existsSync(imageRoot)) {
    return [];
  }
  const results: string[] = [];
  const apiLevels = fs.readdirSync(imageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const apiLevel of apiLevels) {
    const variantRoot = path.join(imageRoot, apiLevel, "google_apis_playstore");
    if (!fs.existsSync(variantRoot)) {
      continue;
    }
    const archDirs = fs.readdirSync(variantRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const arch of archDirs) {
      const full = path.join(variantRoot, arch);
      if (fs.existsSync(path.join(full, "system.img"))) {
        results.push(`system-images;${apiLevel};google_apis_playstore;${arch}`);
      }
    }
  }
  return prioritizeSystemImagePackages(results);
}

function detectHostArm64(): boolean {
  if (process.arch === "arm64") {
    return true;
  }
  // On macOS, process.arch may report "x64" when running under Rosetta 2.
  // Use sysctl to detect actual hardware architecture.
  if (process.platform === "darwin") {
    try {
      const result = spawnSync("sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
      });
      if (result.stdout?.trim() === "1") {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export function getSystemImageCandidates(): string[] {
  const archTag = detectHostArm64() ? "arm64-v8a" : "x86_64";
  const candidates = PREFERRED_SYSTEM_IMAGE_API_LEVELS.flatMap((apiLevel) =>
    buildSystemImageCandidatesForApiLevel(apiLevel, archTag),
  );
  return Array.from(new Set(candidates));
}

function findExistingSystemImage(sdkRoot: string, logger: (line: string) => void): string | null {
  // Check if any system image already exists locally (e.g. installed via Android Studio).
  // Also scan the well-known Android Studio SDK location in case sdkRoot differs.
  const androidStudioSdk = path.join(os.homedir(), "Library", "Android", "sdk");
  const sdkRootsToCheck = Array.from(new Set([sdkRoot, androidStudioSdk].filter((p) => fs.existsSync(p))));
  const preferredCandidates = getSystemImageCandidates();

  for (const pkg of preferredCandidates) {
    // Package name format: system-images;android-XX;variant;arch
    // Translates to: <sdk>/system-images/android-XX/variant/arch/
    const parts = pkg.split(";");
    if (parts.length !== 4) {
      continue;
    }
    const relPath = path.join(parts[0], parts[1], parts[2], parts[3]);
    for (const root of sdkRootsToCheck) {
      const fullPath = path.join(root, relPath);
      if (fs.existsSync(fullPath) && fs.existsSync(path.join(fullPath, "system.img"))) {
        logger(`Found existing system image locally: ${pkg} (at ${root})`);
        return pkg;
      }
    }
  }

  for (const root of sdkRootsToCheck) {
    const discovered = findAnyGooglePlaySystemImage(root);
    if (discovered.length === 0) {
      continue;
    }
    logger(`Found existing fallback Google Play system image locally: ${discovered[0]} (at ${root})`);
    return discovered[0];
  }
  return null;
}

function installOneSystemImage(
  sdkmanager: string,
  sdkRoot: string,
  logger: (line: string) => void,
  toolEnv: NodeJS.ProcessEnv,
): string | null {
  // First check if a system image already exists locally (skip slow download).
  const existing = findExistingSystemImage(sdkRoot, logger);
  if (existing) {
    return existing;
  }

  const candidates = getSystemImageCandidates();
  for (const pkg of candidates) {
    logger(`Trying system image: ${pkg}`);
    const res = run(sdkmanager, [`--sdk_root=${sdkRoot}`, pkg], { inherit: true, env: toolEnv });
    if (res.ok) {
      logger(`System image ready: ${pkg}`);
      return pkg;
    }
  }

  const fallbackInstalled = findAnyGooglePlaySystemImage(sdkRoot)
    .filter((pkg) => !candidates.includes(pkg));
  if (fallbackInstalled.length > 0) {
    logger(`Using installed fallback Google Play system image: ${fallbackInstalled[0]}`);
    return fallbackInstalled[0];
  }

  logger(
    "Could not install Google Play system image automatically (strict mode: no fallback to non-PlayStore images).",
  );
  return null;
}

function listAvdNames(avdmanager: string, toolEnv: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();

  // Method 1: avdmanager list avd (only returns fully valid AVDs).
  const result = run(avdmanager, ["list", "avd"], { env: toolEnv });
  if (result.ok) {
    const regex = /^Name:\s*(.+)$/gm;
    let match: RegExpExecArray | null = regex.exec(result.stdout);
    while (match) {
      names.add(match[1].trim());
      match = regex.exec(result.stdout);
    }
  }

  // Method 2: Scan ~/.android/avd/ directory directly.
  // This finds AVDs created by Android Studio that avdmanager might reject
  // due to SDK root mismatch (e.g. "Missing system image" when the image
  // exists under a different SDK path).
  const avdDir = path.join(os.homedir(), ".android", "avd");
  if (fs.existsSync(avdDir)) {
    for (const entry of fs.readdirSync(avdDir)) {
      if (!entry.endsWith(".ini")) {
        continue;
      }
      // The .ini file contains a line like "path=<avd_dir>" and the AVD name
      // is derived from the filename: "Medium_Phone_API_36.1.ini" → name in the file.
      const iniPath = path.join(avdDir, entry);
      try {
        const content = fs.readFileSync(iniPath, "utf-8");
        const avdPath = content.match(/^path\s*=\s*(.+)$/m)?.[1]?.trim();
        if (avdPath && fs.existsSync(avdPath)) {
          // Use the AvdId from config.ini if available, otherwise derive from filename.
          const configIni = path.join(avdPath, "config.ini");
          if (fs.existsSync(configIni)) {
            const configContent = fs.readFileSync(configIni, "utf-8");
            const avdId = configContent.match(/^AvdId\s*=\s*(.+)$/m)?.[1]?.trim();
            if (avdId) {
              names.add(avdId);
            } else {
              names.add(entry.replace(/\.ini$/, ""));
            }
          }
        }
      } catch {
        // skip unreadable ini files
      }
    }
  }

  return Array.from(names);
}

function createAvd(
  avdmanager: string,
  avdName: string,
  imagePackage: string,
  dataPartitionSizeGb: number,
  logger: (line: string) => void,
  toolEnv: NodeJS.ProcessEnv,
): boolean {
  const normalizedSizeGb = normalizeDataPartitionSizeGb(dataPartitionSizeGb);
  const desiredPartitionSize = `${normalizedSizeGb}G`;
  logger(`Creating AVD '${avdName}' with image '${imagePackage}'...`);
  const result = run(
    avdmanager,
    ["create", "avd", "--force", "-n", avdName, "-k", imagePackage],
    { env: toolEnv, input: "no\n" },
  );
  if (!result.ok) {
    const detail = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
    logger(`Failed to create AVD automatically.${detail ? `\n${detail}` : ""}`);
    return false;
  }
  try {
    const iniPath = path.join(os.homedir(), ".android", "avd", `${avdName}.ini`);
    const iniContent = fs.readFileSync(iniPath, "utf-8");
    const avdPath = iniContent.match(/^path\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!avdPath) {
      logger(`AVD created but path was not resolved from ${iniPath}; skip data partition sizing.`);
      return true;
    }
    const configIniPath = path.join(avdPath, "config.ini");
    if (!fs.existsSync(configIniPath)) {
      logger(`AVD created but ${configIniPath} is missing; skip data partition sizing.`);
      return true;
    }
    const configIni = fs.readFileSync(configIniPath, "utf-8");
    const patched = upsertAvdConfigOverrides(configIni, [
      { key: "disk.dataPartition.size", value: desiredPartitionSize },
      { key: "hw.lcd.width", value: String(STANDARD_AVD_LCD_WIDTH) },
      { key: "hw.lcd.height", value: String(STANDARD_AVD_LCD_HEIGHT) },
      { key: "hw.lcd.density", value: String(STANDARD_AVD_LCD_DENSITY) },
    ]);
    fs.writeFileSync(configIniPath, patched, "utf-8");
    logger(`AVD data partition target set to ${desiredPartitionSize}.`);
    logger(
      `AVD display target set to ${STANDARD_AVD_LCD_WIDTH}x${STANDARD_AVD_LCD_HEIGHT}@${STANDARD_AVD_LCD_DENSITY}dpi.`,
    );
  } catch (error) {
    logger(`Failed to set AVD data partition size (${desiredPartitionSize}): ${(error as Error).message}`);
  }
  return true;
}

export async function ensureAndroidPrerequisites(
  config: OpenPocketConfig,
  options: EnsureAndroidPrerequisitesOptions = {},
): Promise<EnsureAndroidPrerequisitesResult> {
  const logger = options.logger ?? (() => {});
  const autoInstall = options.autoInstall !== false;

  if (process.env.OPENPOCKET_SKIP_ENV_SETUP === "1") {
    const { sdkRoot, configUpdated } = collectSdkRoot(config);
    return {
      skipped: true,
      configUpdated,
      sdkRoot,
      toolPaths: detectTools(sdkRoot),
      installedSteps: [],
      avdCreated: false,
    };
  }

  const collected = collectSdkRoot(config);
  const sdkRoot = collected.sdkRoot;
  let configUpdated = collected.configUpdated;
  ensureDir(sdkRoot);
  logger(`Android SDK root: ${sdkRoot}`);

  let tools = detectTools(sdkRoot);
  const installedSteps: string[] = [];
  let avdCreated = false;

  // --- Phase 1: Ensure essential tools (adb + emulator) exist ---
  let essentialMissing = missingEssentialTools(tools);

  if (essentialMissing.length > 0) {
    if (!autoInstall) {
      throw new Error(`Missing Android prerequisites: ${essentialMissing.join(", ")}`);
    }
    if (process.platform !== "darwin") {
      throw new Error(
        `Missing Android prerequisites on ${process.platform}: ${essentialMissing.join(", ")}. Auto-install currently supports macOS only.`,
      );
    }

    let brew = resolveBrewBinary();
    if (!brew) {
      installHomebrew(logger);
      installedSteps.push("homebrew");
      brew = resolveBrewBinary();
    }
    if (!brew) {
      throw new Error("Homebrew was not found after installation attempt.");
    }

    if (installBrewCask(brew, "android-platform-tools", logger)) {
      installedSteps.push("brew:android-platform-tools");
    }
    if (installBrewCask(brew, "android-commandlinetools", logger)) {
      installedSteps.push("brew:android-commandlinetools");
    }

    tools = detectTools(sdkRoot);
    essentialMissing = missingEssentialTools(tools);
  }

  // --- Phase 2: Early AVD check (scan ~/.android/avd/ directly, no Java needed) ---
  // This catches AVDs created by Android Studio even before we set up Java / avdmanager.
  const earlyAvds = listAvdNames(
    tools.avdmanager ?? "avdmanager",
    { ...process.env, ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot },
  );
  const hasAnyAvdEarly = earlyAvds.length > 0;
  const needsSdkBootstrap = shouldRunSdkBootstrap(hasAnyAvdEarly, essentialMissing.length);

  if (!needsSdkBootstrap && hasAnyAvdEarly) {
    // Reuse an existing AVD — no need for heavy SDK setup.
    if (!earlyAvds.includes(config.emulator.avdName)) {
      const fallback = earlyAvds[0];
      logger(`Configured AVD '${config.emulator.avdName}' not found. Reusing existing AVD '${fallback}'.`);
      config.emulator.avdName = fallback;
      configUpdated = true;
    }
    logger(`Using existing AVD '${config.emulator.avdName}'. Skipping heavy SDK install.`);

    tools = detectTools(sdkRoot);
    return {
      skipped: false,
      configUpdated,
      sdkRoot,
      toolPaths: tools,
      installedSteps,
      avdCreated: false,
    };
  }

  // --- Phase 3: Need SDK bootstrap ---
  // Run SDK bootstrap when:
  // - no AVD exists (need to create one), or
  // - essential runtime tools are still missing (for example emulator binary).
  const sdkmanager = tools.sdkmanager;
  const avdmanager = tools.avdmanager;
  if (!sdkmanager || !avdmanager) {
    const missingBootstrapTools = [
      sdkmanager ? null : "sdkmanager",
      avdmanager ? null : "avdmanager",
    ].filter(Boolean) as string[];
    throw new Error(
      `Cannot continue Android SDK bootstrap; missing tools: ${missingBootstrapTools.join(", ")}. ` +
      "Install Android Studio (or Android command line tools) and retry onboarding.",
    );
  }

  let javaRuntime = detectBestJavaRuntime();
  if (!javaRuntime || javaRuntime.major < 17) {
    if (!autoInstall) {
      throw new Error("Java 17+ is required for Android command line tools, but was not detected.");
    }
    if (process.platform !== "darwin") {
      throw new Error("Java 17+ is required for Android command line tools.");
    }

    let brew = resolveBrewBinary();
    if (!brew) {
      installHomebrew(logger);
      installedSteps.push("homebrew");
      brew = resolveBrewBinary();
    }
    if (!brew) {
      throw new Error("Homebrew was not found after installation attempt.");
    }

    if (installBrewCask(brew, "temurin", logger)) {
      installedSteps.push("brew:temurin");
    }
    javaRuntime = detectBestJavaRuntime();
  }

  if (!javaRuntime || javaRuntime.major < 17 || !javaRuntime.javaHome) {
    throw new Error(
      [
        "Java 17+ is required for Android command line tools but is still unavailable.",
        "Please ensure a JDK 17+ is installed and retry onboarding.",
      ].join(" "),
    );
  }

  logger(`Using Java ${javaRuntime.major} for Android SDK tools: ${javaRuntime.javaHome}`);
  const toolEnv = resolveAndroidToolEnv(sdkRoot, javaRuntime.javaHome);

  // --- Phase 4: Install SDK packages and create AVD ---
  acceptSdkLicenses(sdkmanager, sdkRoot, logger, toolEnv);
  const installedPlatformPackage = installSdkPackages(sdkmanager, sdkRoot, logger, toolEnv);
  installedSteps.push(`sdk:platform-tools,emulator,${installedPlatformPackage}`);

  tools = detectTools(sdkRoot);
  essentialMissing = missingEssentialTools(tools);
  if (essentialMissing.length > 0) {
    throw new Error(`Missing essential Android tools after SDK bootstrap: ${essentialMissing.join(", ")}`);
  }

  let currentAvds = listAvdNames(avdmanager, toolEnv);
  if (!currentAvds.includes(config.emulator.avdName) && currentAvds.length > 0) {
    const fallback = currentAvds[0];
    logger(`Configured AVD '${config.emulator.avdName}' not found. Reusing existing AVD '${fallback}'.`);
    config.emulator.avdName = fallback;
    configUpdated = true;
  }

  if (currentAvds.length === 0) {
    const image = installOneSystemImage(sdkmanager, sdkRoot, logger, toolEnv);
    if (image) {
      installedSteps.push(`sdk:${image}`);
      avdCreated = createAvd(
        avdmanager,
        config.emulator.avdName,
        image,
        config.emulator.dataPartitionSizeGb,
        logger,
        toolEnv,
      );
      if (!avdCreated) {
        throw new Error(`Failed to create AVD '${config.emulator.avdName}'.`);
      }
      installedSteps.push(`avd:${config.emulator.avdName}`);
      currentAvds = listAvdNames(avdmanager, toolEnv);
    } else {
      throw new Error(
        "No AVD exists and no installable Google Play system image was found (strict mode: fallback disabled).",
      );
    }
  }

  tools = detectTools(sdkRoot);
  essentialMissing = missingEssentialTools(tools);
  if (essentialMissing.length > 0) {
    throw new Error(`Missing essential Android tools after onboarding setup: ${essentialMissing.join(", ")}`);
  }

  return {
    skipped: false,
    configUpdated,
    sdkRoot,
    toolPaths: tools,
    installedSteps,
    avdCreated,
  };
}
