import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function log(line) {
  process.stdout.write(`[e2e] ${line}\n`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function findPromptText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const root = payload;

  if (Array.isArray(root.messages)) {
    const userMsg = root.messages.find((item) => item && item.role === "user");
    if (userMsg && Array.isArray(userMsg.content)) {
      const textItem = userMsg.content.find((part) => part && part.type === "text" && typeof part.text === "string");
      if (textItem) {
        return textItem.text;
      }
    }
  }

  if (Array.isArray(root.input)) {
    const userMsg = root.input.find((item) => item && item.role === "user");
    if (userMsg && Array.isArray(userMsg.content)) {
      const textItem = userMsg.content.find(
        (part) => part && part.type === "input_text" && typeof part.text === "string",
      );
      if (textItem) {
        return textItem.text;
      }
    }
  }

  return "";
}

function pickScenarioAction(task, step) {
  const normalizedTask = task.toLowerCase();

  if (normalizedTask.includes("settings")) {
    if (step <= 1) {
      return {
        toolName: "launch_app",
        args: {
          thought: "Plan: open Android Settings before returning home.",
          packageName: "com.android.settings",
          reason: "Open Settings as requested.",
        },
      };
    }

    if (step === 2) {
      return {
        toolName: "wait",
        args: {
          thought: "Wait briefly for Settings UI to settle.",
          durationMs: 1200,
          reason: "Stabilize UI after app launch.",
        },
      };
    }

    if (step === 3) {
      return {
        toolName: "keyevent",
        args: {
          thought: "Return to home screen to satisfy the task.",
          keycode: "KEYCODE_HOME",
          reason: "Back to launcher.",
        },
      };
    }

    return {
      toolName: "finish",
      args: {
        thought: "Sub-goals done: opened Settings and returned home.",
        message: "Opened Settings and returned to Home.",
      },
    };
  }

  if (step <= 1) {
    return {
      toolName: "keyevent",
      args: {
        thought: "Fallback plan: return to home before finishing.",
        keycode: "KEYCODE_HOME",
        reason: "Ensure deterministic final state.",
      },
    };
  }

  return {
    toolName: "finish",
    args: {
      thought: "Fallback scenario completed.",
      message: "Reached home screen and finished.",
    },
  };
}

function parseTaskAndStep(promptText, state) {
  const task = promptText.match(/^Task:\s*(.+)$/m)?.[1]?.trim() ?? "";
  console.log(`[MockServer] Parsed -> Task: "${task}", Calls: ${state.calls}`);
  return {
    task,
    step: state.calls,
  };
}

async function startMockModelServer(port) {
  const state = {
    calls: 0,
    task: "",
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      if (req.url !== "/v1/chat/completions" && req.url !== "/v1/responses") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const body = await readJsonBody(req);
      const promptText = findPromptText(body);
      state.calls += 1;
      const parsed = parseTaskAndStep(promptText, state);
      if (parsed.task) {
        state.task = parsed.task;
      }

      const action = pickScenarioAction(parsed.task || state.task, parsed.step);
      const argsJson = JSON.stringify(action.args);

      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const data = {
          id: `chatcmpl-e2e-${state.calls}`,
          object: "chat.completion.chunk",
          created: Date.now(),
          model: "e2e-mock-model",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              delta: {
                role: "assistant",
                content: action.args.thought || "",
                tool_calls: [
                  {
                    id: `call-e2e-${state.calls}`,
                    type: "function",
                    function: {
                      name: action.toolName,
                      arguments: argsJson,
                    },
                  },
                ],
              },
            },
          ],
        };

        res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      sendJson(res, 200, {
        id: `resp-e2e-${state.calls}`,
        object: "response",
        output: [
          {
            type: "function_call",
            name: action.toolName,
            arguments: argsJson,
          },
        ],
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    state,
    close,
    baseUrl: `http://127.0.0.1:${port}/v1`,
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runOrThrow(label, command, args, options = {}) {
  log(`Run: ${label}`);
  const out = runCommand(command, args, options);
  if (out.status !== 0) {
    throw new Error(
      [
        `${label} failed with exit code ${out.status}.`,
        `command: ${command} ${args.join(" ")}`,
        out.stdout.trim() ? `stdout:\n${out.stdout.trim()}` : "",
        out.stderr.trim() ? `stderr:\n${out.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  return out;
}

function runCliOrThrow(label, args, env, timeoutMs) {
  return runOrThrow(label, "node", [cliPath, ...args], { env, timeoutMs });
}

function runCommandAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(error);
    };

    if (child.stdout) {
      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    }

    child.on("error", fail);
    child.on("close", (code) => {
      finish({
        status: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });

    const timeoutMs = options.timeoutMs;
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          status: 124,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: `${Buffer.concat(stderrChunks).toString("utf-8")}\nTimed out after ${timeoutMs}ms.`,
        });
      }, timeoutMs);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBootComplete(env, timeoutMs) {
  log("Waiting for emulator boot completion...");
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const devices = runCommand("adb", ["devices"], { env, timeoutMs: 15000 });
    const devicesText = `${devices.stdout}\n${devices.stderr}`;
    const hasDevice = /emulator-\d+\s+device/.test(devicesText);
    const connectedLines = devicesText
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log(`Boot wait ${elapsedSec}s: ${connectedLines.join(", ") || "(none)"}`);

    if (hasDevice) {
      const prop = runCommand("adb", ["shell", "getprop", "sys.boot_completed"], {
        env,
        timeoutMs: 15000,
      });
      if (prop.status === 0 && prop.stdout.trim() === "1") {
        // Verify the ADB connection is stable before declaring boot complete.
        // The device can briefly go offline right after sys.boot_completed fires,
        // which would cause subsequent agent commands to fail with "device offline".
        // Furthermore, check `adb devices` directly to ensure it does not say `offline`.
        let stableCount = 0;
        for (let i = 0; i < 20 && stableCount < 3; i++) {
          await sleep(3000);
          const devicesCheck = runCommand("adb", ["devices"], { env, timeoutMs: 8000 });
          const isOnline = devicesCheck.stdout.includes("device") && !devicesCheck.stdout.includes("offline");
          if (!isOnline) {
            stableCount = 0;
            continue;
          }
          const ping = runCommand("adb", ["shell", "echo", "ping"], { env, timeoutMs: 8000 });
          if (ping.status === 0 && ping.stdout.trim() === "ping") {
            stableCount++;
          } else {
            stableCount = 0;
          }
        }
        if (stableCount >= 3) {
          return;
        }
      }
    }

    await sleep(4000);
  }

  throw new Error(`Timed out waiting for emulator boot completion after ${timeoutMs}ms.`);
}

function latestSessionFile(homeDir) {
  const sessionsDir = path.join(homeDir, "workspace", "sessions");
  const files = fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(sessionsDir, name));

  assert.ok(files.length > 0, "No session markdown file generated.");

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function main() {
  const modelPort = Number(process.env.OPENPOCKET_E2E_MODEL_PORT ?? 18080);
  const homeDir = process.env.OPENPOCKET_E2E_HOME
    ? path.resolve(process.env.OPENPOCKET_E2E_HOME)
    : fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-e2e-home-"));
  const task =
    process.env.OPENPOCKET_E2E_TASK
    ?? "Open Android Settings, then return to the home screen, then finish.";

  fs.mkdirSync(homeDir, { recursive: true });

  const env = {
    ...process.env,
    OPENPOCKET_HOME: homeDir,
    OPENPOCKET_SKIP_ENV_SETUP: "1",
  };

  const modelServer = await startMockModelServer(modelPort);
  log(`Mock model server ready at ${modelServer.baseUrl}`);

  try {
    runCliOrThrow("openpocket init", ["init"], env, 180000);

    const configPath = path.join(homeDir, "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    cfg.defaultModel = "e2e-mock";
    cfg.emulator.headless = true;
    cfg.emulator.bootTimeoutSec = 60;
    const kvmEnabled = fs.existsSync("/dev/kvm");
    cfg.emulator.extraArgs = [
      "-gpu",
      "swiftshader_indirect",
      "-memory",
      "1024",
      "-cores",
      "1",
      "-accel",
      kvmEnabled ? "kvm" : "off",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      "-no-snapshot-save",
      "-no-metrics",
    ];
    cfg.agent.maxSteps = 8;
    cfg.agent.loopDelayMs = 300;
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = true;
    cfg.models["e2e-mock"] = {
      baseUrl: modelServer.baseUrl,
      model: "e2e-mock-model",
      apiKey: "e2e-local-key",
      apiKeyEnv: "OPENAI_API_KEY",
      maxTokens: 512,
      reasoningEffort: "medium",
      temperature: null,
    };
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");

    runCliOrThrow("openpocket emulator start", ["emulator", "start"], env, 300000);
    await waitForBootComplete(env, 1200000);

    const runAgent = await runCommandAsync("node", [cliPath, "agent", "--model", "e2e-mock", task], {
      env,
      timeoutMs: 600000,
    });
    if (runAgent.status !== 0) {
      throw new Error(
        [
          `openpocket agent failed with exit code ${runAgent.status}.`,
          runAgent.stdout.trim() ? `stdout:\n${runAgent.stdout.trim()}` : "",
          runAgent.stderr.trim() ? `stderr:\n${runAgent.stderr.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    const sessionPath = latestSessionFile(homeDir);
    const sessionBody = fs.readFileSync(sessionPath, "utf-8");

    assert.match(sessionBody, /"type":\s*"launch_app"/);
    assert.match(sessionBody, /com\.android\.settings/);
    assert.match(sessionBody, /"type":\s*"keyevent"/);
    assert.match(sessionBody, /KEYCODE_HOME/);
    assert.match(sessionBody, /status:\s*SUCCESS/);
    assert.match(sessionBody, /Opened Settings and returned to Home\./);

    const resumed = runCommand("adb", ["shell", "dumpsys", "activity", "activities"], {
      env,
      timeoutMs: 15000,
    });
    const resumedText = `${resumed.stdout}\n${resumed.stderr}`;
    const launcherPattern = /(launcher|quickstep|nexuslauncher|trebuchet|systemui)/i;
    assert.match(
      resumedText,
      launcherPattern,
      "Expected resumed activity dump to include a launcher-like package.",
    );

    log("E2E assertions passed.");
    log(`Session file: ${sessionPath}`);
    log(`Model calls: ${modelServer.state.calls}`);
  } finally {
    try {
      runCommand("node", [cliPath, "emulator", "stop"], {
        env,
        timeoutMs: 60000,
      });
    } catch {
      // Ignore cleanup failures.
    }
    await modelServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
