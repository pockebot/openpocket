#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const { loadConfig } = await import("../dist/config/index.js");
const { EmulatorManager } = await import("../dist/device/emulator-manager.js");
const { AdbRuntime } = await import("../dist/device/adb-runtime.js");

const PACKAGE = "com.openpocket.inputlab";
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const RESOURCE_ID = `${PACKAGE}:id/input_box`;

const SAMPLE_TEXTS = [
  "abc123",
  "Ab&cd",
  "Ab&zzzzz",
  "A(B",
  "P@ssw0rd!#$",
  "x|y;z",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const timeout = options.timeout ?? 15000;
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    ...options,
  });
}

function buildAndInstall(deviceId) {
  const buildScript = path.join(repoRoot, "tools", "android-input-lab", "build.sh");
  let javaHome = "";
  try {
    javaHome = run("/usr/libexec/java_home", ["-v", "21"], { timeout: 4000 }).trim();
  } catch {
    javaHome = process.env.JAVA_HOME ?? "";
  }
  const env = { ...process.env };
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${javaHome}/bin:${process.env.PATH ?? ""}`;
  }
  const build = spawnSync(buildScript, [], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  if (build.status !== 0) {
    throw new Error(`Build app failed:\n${build.stdout}\n${build.stderr}`);
  }
  const apkPath = build.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!apkPath) {
    throw new Error(`Build app did not produce apk path. stdout=${build.stdout}`);
  }

  const install = spawnSync("adb", ["-s", deviceId, "install", "-r", apkPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    throw new Error(`Install apk failed:\n${install.stdout}\n${install.stderr}`);
  }
}

function decodeXmlText(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(nodeTag) {
  const attrs = {};
  const attrRe = /([A-Za-z0-9_:\-]+)="([^"]*)"/g;
  let m = attrRe.exec(nodeTag);
  while (m) {
    attrs[m[1]] = m[2];
    m = attrRe.exec(nodeTag);
  }
  return attrs;
}

function findInputNode(xml) {
  const nodeRe = /<node\b[^>]*>/g;
  let m = nodeRe.exec(xml);
  while (m) {
    const attrs = parseAttrs(m[0]);
    if (attrs["resource-id"] === RESOURCE_ID) {
      const bounds = attrs.bounds ?? "";
      const b = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
      if (!b) {
        throw new Error(`Cannot parse bounds from node: ${bounds}`);
      }
      return {
        text: decodeXmlText(attrs.text ?? ""),
        left: Number(b[1]),
        top: Number(b[2]),
        right: Number(b[3]),
        bottom: Number(b[4]),
      };
    }
    m = nodeRe.exec(xml);
  }
  throw new Error(`Cannot find input node by resource-id=${RESOURCE_ID}`);
}

function dumpUiXml(deviceId) {
  run("adb", ["-s", deviceId, "shell", "uiautomator", "dump", "/sdcard/openpocket-ui.xml"], { timeout: 8000 });
  const raw = run("adb", ["-s", deviceId, "shell", "cat", "/sdcard/openpocket-ui.xml"], { timeout: 8000 });
  const idx = raw.indexOf("<hierarchy");
  if (idx < 0) {
    throw new Error(`UI XML not found. raw=${raw}`);
  }
  return raw.slice(idx);
}

function launchLab(deviceId) {
  run("adb", ["-s", deviceId, "shell", "am", "force-stop", PACKAGE]);
  run("adb", ["-s", deviceId, "shell", "am", "start", "-W", "-n", ACTIVITY]);
}

async function main() {
  const cfg = loadConfig();
  const emulator = new EmulatorManager(cfg);
  const runtime = new AdbRuntime(cfg, emulator);
  const status = emulator.status();
  const deviceId = status.bootedDevices[0] ?? status.devices[0];

  if (!deviceId) {
    throw new Error("No emulator device online.");
  }

  buildAndInstall(deviceId);

  const results = [];

  for (const sample of SAMPLE_TEXTS) {
    console.log(`Running sample: ${JSON.stringify(sample)}`);
    let actionResult = "";
    let observed = "";
    let ok = false;
    let error = "";
    try {
      launchLab(deviceId);
      await sleep(700);

      const before = findInputNode(dumpUiXml(deviceId));
      const centerX = Math.round((before.left + before.right) / 2);
      const centerY = Math.round((before.top + before.bottom) / 2);
      await runtime.executeAction({ type: "tap", x: centerX, y: centerY }, deviceId);
      await sleep(250);

      actionResult = await runtime.executeAction({ type: "type", text: sample }, deviceId);
      await sleep(500);

      observed = findInputNode(dumpUiXml(deviceId)).text;
      ok = observed === sample;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    results.push({ sample, ok, observed, actionResult, error });
  }

  console.log(`Device: ${deviceId}`);
  console.log("Results:");
  for (const item of results) {
    const statusMark = item.ok ? "PASS" : "FAIL";
    console.log(`- [${statusMark}] sample=${JSON.stringify(item.sample)} observed=${JSON.stringify(item.observed)} action=${JSON.stringify(item.actionResult)} error=${JSON.stringify(item.error)}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
