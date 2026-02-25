import fs from "node:fs";
import path from "node:path";

import type { ModelProfile, OpenPocketConfig } from "../types.js";
import {
  defaultConfigPath,
  defaultStateDir,
  defaultWorkspaceDir,
  ensureDir,
  resolvePath,
} from "../utils/paths.js";
import { ensureWorkspaceBootstrap } from "../memory/workspace.js";
import { CODEX_CLI_BASE_URL, readCodexCliCredential } from "./codex-cli.js";

function defaultConfigObject() {
  return {
    projectName: "OpenPocket",
    workspaceDir: defaultWorkspaceDir(),
    stateDir: defaultStateDir(),
    sessionStorage: {
      mode: "unified" as const,
      storePath: path.join(defaultWorkspaceDir(), "sessions", "sessions.json"),
      markdownLog: true,
    },
    defaultModel: "gpt-5.2-codex",
    emulator: {
      avdName: "OpenPocket_AVD",
      androidSdkRoot: process.env.ANDROID_SDK_ROOT ?? "",
      headless: false,
      bootTimeoutSec: 180,
      dataPartitionSizeGb: 24,
      extraArgs: [] as string[],
    },
    telegram: {
      botToken: "",
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [] as number[],
      pollTimeoutSec: 25,
    },
    agent: {
      maxSteps: 100,
      loopDelayMs: 1200,
      progressReportInterval: 1,
      returnHomeOnTaskEnd: true,
      autoArtifactsEnabled: true,
      systemPromptMode: "full" as const,
      contextBudgetChars: 150_000,
      lang: "en" as const,
      verbose: true,
      deviceId: null,
    },
    screenshots: {
      saveStepScreenshots: true,
      directory: path.join(defaultStateDir(), "screenshots"),
      maxCount: 400,
    },
    scriptExecutor: {
      enabled: true,
      timeoutSec: 60,
      maxOutputChars: 6000,
      allowedCommands: [
        "adb",
        "am",
        "pm",
        "input",
        "echo",
        "pwd",
        "ls",
        "cat",
        "grep",
        "rg",
        "sed",
        "awk",
        "bash",
        "sh",
        "node",
        "npm",
      ],
    },
    codingTools: {
      enabled: true,
      workspaceOnly: true,
      timeoutSec: 1800,
      maxOutputChars: 12000,
      allowBackground: true,
      applyPatchEnabled: true,
      allowedCommands: [
        "git",
        "ls",
        "cat",
        "grep",
        "rg",
        "sed",
        "awk",
        "head",
        "tail",
        "pwd",
        "bash",
        "sh",
        "node",
        "npm",
        "pnpm",
        "yarn",
        "python",
        "python3",
        "pytest",
        "jest",
        "vitest",
        "tsc",
        "eslint",
        "prettier",
      ],
    },
    memoryTools: {
      enabled: true,
      maxResults: 6,
      minScore: 0.2,
      maxSnippetChars: 1200,
    },
    heartbeat: {
      enabled: true,
      everySec: 30,
      stuckTaskWarnSec: 600,
      writeLogFile: true,
    },
    cron: {
      enabled: true,
      tickSec: 10,
      jobsFile: path.join(defaultWorkspaceDir(), "cron", "jobs.json"),
    },
    dashboard: {
      enabled: true,
      host: "127.0.0.1",
      port: 51888,
      autoOpenBrowser: false,
    },
    humanAuth: {
      enabled: false,
      useLocalRelay: true,
      localRelayHost: "127.0.0.1",
      localRelayPort: 8787,
      localRelayStateFile: path.join(defaultStateDir(), "human-auth-relay", "requests.json"),
      relayBaseUrl: "",
      publicBaseUrl: "",
      apiKey: "",
      apiKeyEnv: "OPENPOCKET_HUMAN_AUTH_KEY",
      requestTimeoutSec: 300,
      pollIntervalMs: 2000,
      tunnel: {
        provider: "none" as const,
        ngrok: {
          enabled: false,
          executable: "ngrok",
          authtoken: "",
          authtokenEnv: "NGROK_AUTHTOKEN",
          apiBaseUrl: "http://127.0.0.1:4040",
          startupTimeoutSec: 20,
        },
      },
    },
    imageGeneration: {
      enabled: false,
      provider: "fal" as const,
      apiKey: "",
      apiKeyEnv: "FAL_API_KEY",
      model: "fal-ai/nanobanana",
    },
    models: {
      "gpt-5.2-codex": {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex",
        apiKey: "",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "gpt-5.3-codex": {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.3-codex",
        apiKey: "",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "claude-sonnet-4.6": {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "claude-sonnet-4.6",
        apiKey: "",
        apiKeyEnv: "OPENROUTER_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "claude-opus-4.6": {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "claude-opus-4.6",
        apiKey: "",
        apiKeyEnv: "OPENROUTER_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "blockrun/gpt-4o": {
        baseUrl: "https://api.blockrun.ai/v1",
        model: "openai/gpt-4o",
        apiKey: "",
        apiKeyEnv: "BLOCKRUN_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "blockrun/claude-sonnet-4": {
        baseUrl: "https://api.blockrun.ai/v1",
        model: "anthropic/claude-sonnet-4",
        apiKey: "",
        apiKeyEnv: "BLOCKRUN_API_KEY",
        maxTokens: 4096,
        reasoningEffort: "medium" as const,
        temperature: null,
      },
      "blockrun/gemini-2.0-flash": {
        baseUrl: "https://api.blockrun.ai/v1",
        model: "google/gemini-2.0-flash-exp",
        apiKey: "",
        apiKeyEnv: "BLOCKRUN_API_KEY",
        maxTokens: 4096,
        reasoningEffort: null,
        temperature: null,
      },
      "blockrun/deepseek-chat": {
        baseUrl: "https://api.blockrun.ai/v1",
        model: "deepseek/deepseek-chat",
        apiKey: "",
        apiKeyEnv: "BLOCKRUN_API_KEY",
        maxTokens: 4096,
        reasoningEffort: null,
        temperature: null,
      },
      "autoglm-phone": {
        baseUrl: "https://api.z.ai/api/paas/v4",
        model: "autoglm-phone-multilingual",
        apiKey: "",
        apiKeyEnv: "AUTOGLM_API_KEY",
        maxTokens: 3000,
        reasoningEffort: null,
        temperature: null,
      },
    },
  };
}

function normalizeDataPartitionSizeGb(value: unknown, fallback = 24): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(8, Math.min(512, Math.round(parsed)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, incoming: unknown): T {
  if (!isObject(base) || !isObject(incoming)) {
    return (incoming as T) ?? base;
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = output[key];
    if (isObject(existing) && isObject(value)) {
      output[key] = deepMerge(existing, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

function normalizeLegacyKeys(input: Record<string, unknown>): Record<string, unknown> {
  const raw = { ...input };

  const topLevelMap: Record<string, string> = {
    project_name: "projectName",
    workspace_dir: "workspaceDir",
    state_dir: "stateDir",
    session_storage: "sessionStorage",
    default_model: "defaultModel",
    script_executor: "scriptExecutor",
    coding_tools: "codingTools",
    memory_tools: "memoryTools",
    heartbeat_config: "heartbeat",
    cron_config: "cron",
    dashboard_config: "dashboard",
    human_auth: "humanAuth",
  };

  for (const [oldKey, newKey] of Object.entries(topLevelMap)) {
    if (oldKey in raw && !(newKey in raw)) {
      raw[newKey] = raw[oldKey];
    }
  }

  const emulator = isObject(raw.emulator) ? { ...raw.emulator } : {};
  const emulatorMap: Record<string, string> = {
    avd_name: "avdName",
    android_sdk_root: "androidSdkRoot",
    boot_timeout_sec: "bootTimeoutSec",
    data_partition_size_gb: "dataPartitionSizeGb",
    extra_args: "extraArgs",
  };
  for (const [oldKey, newKey] of Object.entries(emulatorMap)) {
    if (oldKey in emulator && !(newKey in emulator)) {
      emulator[newKey] = emulator[oldKey];
    }
  }
  if (Object.keys(emulator).length > 0) {
    raw.emulator = emulator;
  }

  const telegram = isObject(raw.telegram) ? { ...raw.telegram } : {};
  const telegramMap: Record<string, string> = {
    bot_token: "botToken",
    bot_token_env: "botTokenEnv",
    allowed_chat_ids: "allowedChatIds",
    poll_timeout_sec: "pollTimeoutSec",
  };
  for (const [oldKey, newKey] of Object.entries(telegramMap)) {
    if (oldKey in telegram && !(newKey in telegram)) {
      telegram[newKey] = telegram[oldKey];
    }
  }
  if (Object.keys(telegram).length > 0) {
    raw.telegram = telegram;
  }

  const agent = isObject(raw.agent) ? { ...raw.agent } : {};
  const agentMap: Record<string, string> = {
    max_steps: "maxSteps",
    loop_delay_ms: "loopDelayMs",
    progress_report_interval: "progressReportInterval",
    return_home_on_task_end: "returnHomeOnTaskEnd",
    auto_artifacts_enabled: "autoArtifactsEnabled",
    system_prompt_mode: "systemPromptMode",
    context_budget_chars: "contextBudgetChars",
    device_id: "deviceId",
  };
  for (const [oldKey, newKey] of Object.entries(agentMap)) {
    if (oldKey in agent && !(newKey in agent)) {
      agent[newKey] = agent[oldKey];
    }
  }
  if (Object.keys(agent).length > 0) {
    raw.agent = agent;
  }

  const screenshots = isObject(raw.screenshots) ? { ...raw.screenshots } : {};
  const screenshotsMap: Record<string, string> = {
    save_step_screenshots: "saveStepScreenshots",
    max_count: "maxCount",
  };
  for (const [oldKey, newKey] of Object.entries(screenshotsMap)) {
    if (oldKey in screenshots && !(newKey in screenshots)) {
      screenshots[newKey] = screenshots[oldKey];
    }
  }
  if (Object.keys(screenshots).length > 0) {
    raw.screenshots = screenshots;
  }

  const scriptExecutor = isObject(raw.scriptExecutor) ? { ...raw.scriptExecutor } : {};
  const scriptExecutorMap: Record<string, string> = {
    timeout_sec: "timeoutSec",
    max_output_chars: "maxOutputChars",
    allowed_commands: "allowedCommands",
  };
  for (const [oldKey, newKey] of Object.entries(scriptExecutorMap)) {
    if (oldKey in scriptExecutor && !(newKey in scriptExecutor)) {
      scriptExecutor[newKey] = scriptExecutor[oldKey];
    }
  }
  if (Object.keys(scriptExecutor).length > 0) {
    raw.scriptExecutor = scriptExecutor;
  }

  const codingTools = isObject(raw.codingTools) ? { ...raw.codingTools } : {};
  const codingToolsMap: Record<string, string> = {
    workspace_only: "workspaceOnly",
    timeout_sec: "timeoutSec",
    max_output_chars: "maxOutputChars",
    allow_background: "allowBackground",
    apply_patch_enabled: "applyPatchEnabled",
    allowed_commands: "allowedCommands",
  };
  for (const [oldKey, newKey] of Object.entries(codingToolsMap)) {
    if (oldKey in codingTools && !(newKey in codingTools)) {
      codingTools[newKey] = codingTools[oldKey];
    }
  }
  if (Object.keys(codingTools).length > 0) {
    raw.codingTools = codingTools;
  }

  const memoryTools = isObject(raw.memoryTools) ? { ...raw.memoryTools } : {};
  const memoryToolsMap: Record<string, string> = {
    max_results: "maxResults",
    min_score: "minScore",
    max_snippet_chars: "maxSnippetChars",
  };
  for (const [oldKey, newKey] of Object.entries(memoryToolsMap)) {
    if (oldKey in memoryTools && !(newKey in memoryTools)) {
      memoryTools[newKey] = memoryTools[oldKey];
    }
  }
  if (Object.keys(memoryTools).length > 0) {
    raw.memoryTools = memoryTools;
  }

  const heartbeat = isObject(raw.heartbeat) ? { ...raw.heartbeat } : {};
  const heartbeatMap: Record<string, string> = {
    every_sec: "everySec",
    stuck_task_warn_sec: "stuckTaskWarnSec",
    write_log_file: "writeLogFile",
  };
  for (const [oldKey, newKey] of Object.entries(heartbeatMap)) {
    if (oldKey in heartbeat && !(newKey in heartbeat)) {
      heartbeat[newKey] = heartbeat[oldKey];
    }
  }
  if (Object.keys(heartbeat).length > 0) {
    raw.heartbeat = heartbeat;
  }

  const cron = isObject(raw.cron) ? { ...raw.cron } : {};
  const cronMap: Record<string, string> = {
    tick_sec: "tickSec",
    jobs_file: "jobsFile",
  };
  for (const [oldKey, newKey] of Object.entries(cronMap)) {
    if (oldKey in cron && !(newKey in cron)) {
      cron[newKey] = cron[oldKey];
    }
  }
  if (Object.keys(cron).length > 0) {
    raw.cron = cron;
  }

  const dashboard = isObject(raw.dashboard) ? { ...raw.dashboard } : {};
  const dashboardMap: Record<string, string> = {
    auto_open_browser: "autoOpenBrowser",
  };
  for (const [oldKey, newKey] of Object.entries(dashboardMap)) {
    if (oldKey in dashboard && !(newKey in dashboard)) {
      dashboard[newKey] = dashboard[oldKey];
    }
  }
  if (Object.keys(dashboard).length > 0) {
    raw.dashboard = dashboard;
  }

  const sessionStorage = isObject(raw.sessionStorage) ? { ...raw.sessionStorage } : {};
  const sessionStorageMap: Record<string, string> = {
    storage_backend: "mode",
    dual_write_jsonl: "dualWriteJsonl",
    openclaw_store_path: "storePath",
    markdown_log: "markdownLog",
  };
  for (const [oldKey, newKey] of Object.entries(sessionStorageMap)) {
    if (oldKey in sessionStorage && !(newKey in sessionStorage)) {
      sessionStorage[newKey] = sessionStorage[oldKey];
    }
  }
  if (Object.keys(sessionStorage).length > 0) {
    if (!("markdownLog" in sessionStorage) && "dualWriteJsonl" in sessionStorage) {
      // Legacy mode always wrote markdown; keep that behavior.
      sessionStorage.markdownLog = true;
    }
    if ("mode" in sessionStorage) {
      const mode = String(sessionStorage.mode ?? "").trim().toLowerCase();
      if (mode === "markdown" || mode === "openclaw") {
        sessionStorage.mode = "unified";
      }
    }
    raw.sessionStorage = sessionStorage;
  }

  const humanAuth = isObject(raw.humanAuth) ? { ...raw.humanAuth } : {};
  const humanAuthMap: Record<string, string> = {
    use_local_relay: "useLocalRelay",
    local_relay_host: "localRelayHost",
    local_relay_port: "localRelayPort",
    local_relay_state_file: "localRelayStateFile",
    relay_base_url: "relayBaseUrl",
    public_base_url: "publicBaseUrl",
    api_key: "apiKey",
    api_key_env: "apiKeyEnv",
    request_timeout_sec: "requestTimeoutSec",
    poll_interval_ms: "pollIntervalMs",
  };
  for (const [oldKey, newKey] of Object.entries(humanAuthMap)) {
    if (oldKey in humanAuth && !(newKey in humanAuth)) {
      humanAuth[newKey] = humanAuth[oldKey];
    }
  }

  const tunnel = isObject(humanAuth.tunnel) ? { ...humanAuth.tunnel } : {};
  const tunnelMap: Record<string, string> = {
    provider_type: "provider",
  };
  for (const [oldKey, newKey] of Object.entries(tunnelMap)) {
    if (oldKey in tunnel && !(newKey in tunnel)) {
      tunnel[newKey] = tunnel[oldKey];
    }
  }

  const ngrok = isObject(tunnel.ngrok) ? { ...tunnel.ngrok } : {};
  const ngrokMap: Record<string, string> = {
    auth_token: "authtoken",
    auth_token_env: "authtokenEnv",
    api_base_url: "apiBaseUrl",
    startup_timeout_sec: "startupTimeoutSec",
  };
  for (const [oldKey, newKey] of Object.entries(ngrokMap)) {
    if (oldKey in ngrok && !(newKey in ngrok)) {
      ngrok[newKey] = ngrok[oldKey];
    }
  }
  if (Object.keys(ngrok).length > 0) {
    tunnel.ngrok = ngrok;
  }
  if (Object.keys(tunnel).length > 0) {
    humanAuth.tunnel = tunnel;
  }
  if (Object.keys(humanAuth).length > 0) {
    raw.humanAuth = humanAuth;
  }

  if (isObject(raw.models)) {
    const convertedModels: Record<string, unknown> = {};
    for (const [modelKey, modelValue] of Object.entries(raw.models)) {
      if (!isObject(modelValue)) {
        convertedModels[modelKey] = modelValue;
        continue;
      }
      const m = { ...modelValue };
      const modelMap: Record<string, string> = {
        base_url: "baseUrl",
        api_key: "apiKey",
        api_key_env: "apiKeyEnv",
        max_tokens: "maxTokens",
        reasoning_effort: "reasoningEffort",
      };
      for (const [oldKey, newKey] of Object.entries(modelMap)) {
        if (oldKey in m && !(newKey in m)) {
          m[newKey] = m[oldKey];
        }
      }
      convertedModels[modelKey] = m;
    }
    raw.models = convertedModels;
  }

  return raw;
}

function normalizeConfig(raw: Record<string, unknown>, configPath: string): OpenPocketConfig {
  const compatibleRaw = normalizeLegacyKeys(raw);
  const merged = deepMerge(
    defaultConfigObject() as Record<string, unknown>,
    compatibleRaw,
  ) as Record<string, unknown>;
  const rawModels = (merged.models ?? {}) as Record<string, unknown>;
  const models: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(rawModels)) {
    const model = isObject(value) ? value : {};
    const reasoningRaw =
      model.reasoningEffort ?? model.reasoning_effort ?? null;
    const reasoningEffort =
      reasoningRaw === "low" ||
      reasoningRaw === "medium" ||
      reasoningRaw === "high" ||
      reasoningRaw === "xhigh"
        ? reasoningRaw
        : null;
    const tempRaw = model.temperature;
    models[key] = {
      baseUrl: String(model.baseUrl ?? model.base_url ?? "https://api.openai.com/v1"),
      model: String(model.model ?? key),
      apiKey: String(model.apiKey ?? model.api_key ?? ""),
      apiKeyEnv: String(model.apiKeyEnv ?? model.api_key_env ?? "OPENAI_API_KEY"),
      maxTokens: Number(model.maxTokens ?? model.max_tokens ?? 4096),
      reasoningEffort,
      temperature:
        tempRaw === null || tempRaw === undefined || Number.isNaN(Number(tempRaw))
          ? null
          : Number(tempRaw),
    };
  }
  const defaultModel = String(merged.defaultModel ?? "gpt-5.2-codex");
  if (!models[defaultModel]) {
    throw new Error(`defaultModel '${defaultModel}' is not present in models.`);
  }

  const emulator = (merged.emulator ?? {}) as Record<string, unknown>;
  const telegram = (merged.telegram ?? {}) as Record<string, unknown>;
  const agent = (merged.agent ?? {}) as Record<string, unknown>;
  const screenshots = (merged.screenshots ?? {}) as Record<string, unknown>;
  const scriptExecutor = (merged.scriptExecutor ?? {}) as Record<string, unknown>;
  const codingTools = (merged.codingTools ?? {}) as Record<string, unknown>;
  const memoryTools = (merged.memoryTools ?? {}) as Record<string, unknown>;
  const heartbeat = (merged.heartbeat ?? {}) as Record<string, unknown>;
  const cron = (merged.cron ?? {}) as Record<string, unknown>;
  const dashboard = (merged.dashboard ?? {}) as Record<string, unknown>;
  const humanAuth = (merged.humanAuth ?? {}) as Record<string, unknown>;
  const imageGeneration = (merged.imageGeneration ?? {}) as Record<string, unknown>;
  const sessionStorage = (merged.sessionStorage ?? {}) as Record<string, unknown>;
  const humanAuthTunnel = isObject(humanAuth.tunnel) ? humanAuth.tunnel : {};
  const humanAuthNgrok = isObject(humanAuthTunnel.ngrok) ? humanAuthTunnel.ngrok : {};
  const resolvedWorkspaceDir = resolvePath(String(merged.workspaceDir));
  const resolvedStateDir = resolvePath(String(merged.stateDir));

  const systemPromptModeRaw = String(agent.systemPromptMode ?? agent.system_prompt_mode ?? "full");
  const systemPromptMode = systemPromptModeRaw === "minimal" || systemPromptModeRaw === "none"
    ? systemPromptModeRaw
    : "full";

  const cfg: OpenPocketConfig = {
    projectName: String(merged.projectName),
    workspaceDir: resolvedWorkspaceDir,
    stateDir: resolvedStateDir,
    sessionStorage: {
      mode: "unified",
      storePath: (() => {
        const defaultGlobalStorePath = resolvePath(
          path.join(defaultWorkspaceDir(), "sessions", "sessions.json"),
        );
        const explicit = String(sessionStorage.storePath ?? "").trim();
        if (!explicit) {
          return path.join(resolvedWorkspaceDir, "sessions", "sessions.json");
        }
        const resolvedExplicit = resolvePath(explicit);
        if (resolvedExplicit === defaultGlobalStorePath) {
          return path.join(resolvedWorkspaceDir, "sessions", "sessions.json");
        }
        return resolvedExplicit;
      })(),
      markdownLog: Boolean(sessionStorage.markdownLog ?? true),
    },
    defaultModel,
    emulator: {
      avdName: String(emulator.avdName ?? "OpenPocket_AVD"),
      androidSdkRoot: String(emulator.androidSdkRoot ?? ""),
      headless: Boolean(emulator.headless),
      bootTimeoutSec: Number(emulator.bootTimeoutSec ?? 180),
      dataPartitionSizeGb: normalizeDataPartitionSizeGb(emulator.dataPartitionSizeGb, 24),
      extraArgs: Array.isArray(emulator.extraArgs)
        ? emulator.extraArgs
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0)
        : [],
    },
    telegram: {
      botToken: String(telegram.botToken ?? ""),
      botTokenEnv: String(telegram.botTokenEnv ?? "TELEGRAM_BOT_TOKEN"),
      allowedChatIds: Array.isArray(telegram.allowedChatIds)
        ? telegram.allowedChatIds.map((id) => Number(id)).filter(Number.isFinite)
        : [],
      pollTimeoutSec: Number(telegram.pollTimeoutSec ?? 25),
    },
    agent: {
      maxSteps: Number(agent.maxSteps ?? 100),
      loopDelayMs: Number(agent.loopDelayMs ?? 1200),
      progressReportInterval: Math.max(1, Number(agent.progressReportInterval ?? 1)),
      returnHomeOnTaskEnd: Boolean(agent.returnHomeOnTaskEnd ?? true),
      autoArtifactsEnabled: Boolean(agent.autoArtifactsEnabled ?? true),
      systemPromptMode,
      contextBudgetChars: Math.max(
        10_000,
        Number(agent.contextBudgetChars ?? agent.context_budget_chars ?? 150_000) || 150_000,
      ),
      lang: "en",
      verbose: Boolean(agent.verbose),
      deviceId: agent.deviceId ? String(agent.deviceId) : null,
    },
    screenshots: {
      saveStepScreenshots: Boolean(screenshots.saveStepScreenshots ?? true),
      directory: resolvePath(String(screenshots.directory ?? path.join(resolvedStateDir, "screenshots"))),
      maxCount: Math.max(20, Number(screenshots.maxCount ?? 400)),
    },
    scriptExecutor: {
      enabled: Boolean(scriptExecutor.enabled ?? true),
      timeoutSec: Math.max(1, Number(scriptExecutor.timeoutSec ?? 60)),
      maxOutputChars: Math.max(1000, Number(scriptExecutor.maxOutputChars ?? 6000)),
      allowedCommands: Array.isArray(scriptExecutor.allowedCommands)
        ? scriptExecutor.allowedCommands.map((v) => String(v))
        : defaultConfigObject().scriptExecutor.allowedCommands,
    },
    codingTools: {
      enabled: Boolean(codingTools.enabled ?? true),
      workspaceOnly: Boolean(codingTools.workspaceOnly ?? true),
      timeoutSec: Math.max(1, Number(codingTools.timeoutSec ?? 1800)),
      maxOutputChars: Math.max(1000, Number(codingTools.maxOutputChars ?? 12000)),
      allowBackground: Boolean(codingTools.allowBackground ?? true),
      applyPatchEnabled: Boolean(codingTools.applyPatchEnabled ?? true),
      allowedCommands: Array.isArray(codingTools.allowedCommands)
        ? codingTools.allowedCommands.map((v) => String(v))
        : defaultConfigObject().codingTools.allowedCommands,
    },
    memoryTools: {
      enabled: Boolean(memoryTools.enabled ?? true),
      maxResults: Math.max(1, Math.min(30, Number(memoryTools.maxResults ?? 6))),
      minScore: Math.max(0, Math.min(1, Number(memoryTools.minScore ?? 0.2))),
      maxSnippetChars: Math.max(200, Math.min(8000, Number(memoryTools.maxSnippetChars ?? 1200))),
    },
    heartbeat: {
      enabled: Boolean(heartbeat.enabled ?? true),
      everySec: Math.max(5, Number(heartbeat.everySec ?? 30)),
      stuckTaskWarnSec: Math.max(30, Number(heartbeat.stuckTaskWarnSec ?? 600)),
      writeLogFile: Boolean(heartbeat.writeLogFile ?? true),
    },
    cron: {
      enabled: Boolean(cron.enabled ?? true),
      tickSec: Math.max(2, Number(cron.tickSec ?? 10)),
      jobsFile: resolvePath(String(cron.jobsFile ?? path.join(resolvedWorkspaceDir, "cron", "jobs.json"))),
    },
    dashboard: {
      enabled: Boolean(dashboard.enabled ?? true),
      host: String(dashboard.host ?? "127.0.0.1").trim() || "127.0.0.1",
      port: (() => {
        const raw = Number(dashboard.port ?? 51888);
        const value = Number.isFinite(raw) ? raw : 51888;
        return Math.max(1, Math.min(65535, Math.round(value)));
      })(),
      autoOpenBrowser: Boolean(dashboard.autoOpenBrowser ?? false),
    },
    humanAuth: {
      enabled: Boolean(humanAuth.enabled ?? false),
      useLocalRelay: Boolean(humanAuth.useLocalRelay ?? true),
      localRelayHost: String(humanAuth.localRelayHost ?? "127.0.0.1").trim() || "127.0.0.1",
      localRelayPort: (() => {
        const parsed = Number(humanAuth.localRelayPort ?? 8787);
        const value = Number.isFinite(parsed) ? parsed : 8787;
        return Math.max(1, Math.min(65535, Math.round(value)));
      })(),
      localRelayStateFile: resolvePath(
        String(
          humanAuth.localRelayStateFile ??
            path.join(resolvedStateDir, "human-auth-relay", "requests.json"),
        ),
      ),
      relayBaseUrl: String(humanAuth.relayBaseUrl ?? "").trim().replace(/\/+$/, ""),
      publicBaseUrl: String(humanAuth.publicBaseUrl ?? "").trim().replace(/\/+$/, ""),
      apiKey: String(humanAuth.apiKey ?? ""),
      apiKeyEnv: String(humanAuth.apiKeyEnv ?? "OPENPOCKET_HUMAN_AUTH_KEY"),
      requestTimeoutSec: Math.max(30, Number(humanAuth.requestTimeoutSec ?? 300)),
      pollIntervalMs: Math.max(500, Number(humanAuth.pollIntervalMs ?? 2000)),
      tunnel: {
        provider:
          humanAuthTunnel.provider === "ngrok" || humanAuthTunnel.provider === "none"
            ? humanAuthTunnel.provider
            : Boolean(humanAuthNgrok.enabled)
              ? "ngrok"
              : "none",
        ngrok: {
          enabled: Boolean(humanAuthNgrok.enabled ?? false),
          executable:
            String(
              humanAuthNgrok.executable ??
                defaultConfigObject().humanAuth.tunnel.ngrok.executable,
            ).trim() || "ngrok",
          authtoken: String(humanAuthNgrok.authtoken ?? ""),
          authtokenEnv:
            String(
              humanAuthNgrok.authtokenEnv ??
                defaultConfigObject().humanAuth.tunnel.ngrok.authtokenEnv,
            ).trim() || "NGROK_AUTHTOKEN",
          apiBaseUrl:
            String(
              humanAuthNgrok.apiBaseUrl ??
                defaultConfigObject().humanAuth.tunnel.ngrok.apiBaseUrl,
            ).trim().replace(/\/+$/, "") || "http://127.0.0.1:4040",
          startupTimeoutSec: (() => {
            const raw = Number(
              humanAuthNgrok.startupTimeoutSec ??
                defaultConfigObject().humanAuth.tunnel.ngrok.startupTimeoutSec,
            );
            const value = Number.isFinite(raw) ? raw : 20;
            return Math.max(3, Math.round(value));
          })(),
        },
      },
    },
    imageGeneration: {
      enabled: Boolean(imageGeneration.enabled ?? false),
      provider: (() => {
        const provider = String(imageGeneration.provider ?? "fal");
        return provider === "fal" || provider === "replicate" || provider === "huggingface"
          ? provider
          : "fal";
      })(),
      apiKey: String(imageGeneration.apiKey ?? ""),
      apiKeyEnv: String(imageGeneration.apiKeyEnv ?? "FAL_API_KEY"),
      model: imageGeneration.model ? String(imageGeneration.model) : undefined,
    },
    models,
    configPath,
  };

  return cfg;
}

export function loadConfig(configPath?: string): OpenPocketConfig {
  const finalPath = configPath ? resolvePath(configPath) : defaultConfigPath();
  ensureDir(path.dirname(finalPath));

  if (!fs.existsSync(finalPath)) {
    fs.writeFileSync(finalPath, `${JSON.stringify(defaultConfigObject(), null, 2)}\n`, "utf-8");
  }

  const raw = JSON.parse(fs.readFileSync(finalPath, "utf-8"));
  const cfg = normalizeConfig(raw, finalPath);

  ensureDir(cfg.stateDir);
  ensureDir(cfg.screenshots.directory);
  ensureDir(cfg.workspaceDir);
  ensureDir(path.dirname(cfg.cron.jobsFile));
  ensureWorkspaceBootstrap(cfg.workspaceDir);
  return cfg;
}

export function saveConfig(config: OpenPocketConfig): void {
  const payload = {
    projectName: config.projectName,
    workspaceDir: config.workspaceDir,
    stateDir: config.stateDir,
    sessionStorage: config.sessionStorage,
    defaultModel: config.defaultModel,
    emulator: config.emulator,
    telegram: config.telegram,
    agent: config.agent,
    screenshots: config.screenshots,
    scriptExecutor: config.scriptExecutor,
    codingTools: config.codingTools,
    memoryTools: config.memoryTools,
    heartbeat: config.heartbeat,
    cron: config.cron,
    dashboard: config.dashboard,
    humanAuth: config.humanAuth,
    imageGeneration: config.imageGeneration,
    models: config.models,
  };
  fs.writeFileSync(config.configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function getModelProfile(config: OpenPocketConfig, name?: string): ModelProfile {
  const key = name ?? config.defaultModel;
  const profile = config.models[key];
  if (!profile) {
    throw new Error(`Unknown model profile: ${key}`);
  }
  return profile;
}

export type ResolvedModelAuth = {
  apiKey: string;
  source: "config" | "env" | "codex-cli-keychain" | "codex-cli-auth-json";
  baseUrl?: string;
  preferredMode?: "chat" | "responses" | "completions";
};

function isOpenAiLikeBaseUrl(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return lower.includes("openai.com") || lower.includes("chatgpt.com");
}

function shouldUseCodexCliFallback(profile: ModelProfile): boolean {
  const model = profile.model.toLowerCase();
  if (!model.includes("codex")) {
    return false;
  }
  return isOpenAiLikeBaseUrl(profile.baseUrl);
}

function shouldPreferResponsesMode(profile: ModelProfile): boolean {
  if (!isOpenAiLikeBaseUrl(profile.baseUrl)) {
    return false;
  }
  const model = profile.model.trim().toLowerCase();
  // OpenAI GPT-5 family models are responses-first. Prefer that transport
  // to avoid chat/completions-specific incompatibilities.
  return model.startsWith("gpt-5");
}

export function resolveModelAuth(profile: ModelProfile): ResolvedModelAuth | null {
  const preferredMode = shouldPreferResponsesMode(profile) ? "responses" : undefined;

  if (profile.apiKey?.trim()) {
    const resolved: ResolvedModelAuth = {
      apiKey: profile.apiKey.trim(),
      source: "config",
    };
    if (preferredMode) {
      resolved.preferredMode = preferredMode;
    }
    return resolved;
  }

  if (profile.apiKeyEnv?.trim()) {
    const envApiKey = process.env[profile.apiKeyEnv]?.trim();
    if (envApiKey) {
      const resolved: ResolvedModelAuth = {
        apiKey: envApiKey,
        source: "env",
      };
      if (preferredMode) {
        resolved.preferredMode = preferredMode;
      }
      return resolved;
    }
  }

  if (!shouldUseCodexCliFallback(profile)) {
    return null;
  }

  const codexCredential = readCodexCliCredential();
  if (!codexCredential) {
    return null;
  }

  return {
    apiKey: codexCredential.accessToken,
    source: codexCredential.source === "keychain" ? "codex-cli-keychain" : "codex-cli-auth-json",
    baseUrl: CODEX_CLI_BASE_URL,
    preferredMode: "responses",
  };
}

export function resolveApiKey(profile: ModelProfile): string {
  return resolveModelAuth(profile)?.apiKey ?? "";
}
