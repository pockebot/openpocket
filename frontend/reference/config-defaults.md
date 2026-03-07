# Config Defaults

This page is the source-of-truth for current default config values and normalization behavior.

The JSON below describes the **default agent** created under `OPENPOCKET_HOME` during onboarding.
Managed agents created later with `openpocket create agent <id>` start from the manager model template and then rewrite the path-bearing fields to their own `agents/<id>/...` directories.

## Default Config JSON

```json
{
  "projectName": "OpenPocket",
  "workspaceDir": "<absolute OPENPOCKET_HOME>/workspace",
  "stateDir": "<absolute OPENPOCKET_HOME>/state",
  "sessionStorage": {
    "mode": "unified",
    "storePath": "<absolute OPENPOCKET_HOME>/workspace/sessions/sessions.json",
    "markdownLog": true
  },
  "defaultModel": "gpt-5.2-codex",
  "target": {
    "type": "emulator",
    "adbEndpoint": "",
    "pin": "1234",
    "wakeupIntervalSec": 3,
    "cloudProvider": ""
  },
  "emulator": {
    "avdName": "OpenPocket_AVD",
    "androidSdkRoot": "<ANDROID_SDK_ROOT env or empty string>",
    "headless": false,
    "bootTimeoutSec": 180,
    "dataPartitionSizeGb": 24,
    "extraArgs": []
  },
  "telegram": {
    "botToken": "",
    "botTokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedChatIds": [],
    "pollTimeoutSec": 25
  },
  "agent": {
    "maxSteps": 100,
    "loopDelayMs": 1200,
    "progressReportInterval": 1,
    "returnHomeOnTaskEnd": true,
    "autoArtifactsEnabled": true,
    "skillsSpecMode": "mixed",
    "systemPromptMode": "full",
    "contextBudgetChars": 150000,
    "lang": "en",
    "verbose": true,
    "deviceId": null,
    "runtimeBackend": "legacy_agent_core",
    "legacyCodingExecutor": false
  },
  "screenshots": {
    "saveStepScreenshots": true,
    "directory": "<absolute OPENPOCKET_HOME>/state/screenshots",
    "maxCount": 400
  },
  "scriptExecutor": {
    "enabled": true,
    "timeoutSec": 60,
    "maxOutputChars": 6000,
    "allowedCommands": [
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
      "npm"
    ]
  },
  "codingTools": {
    "enabled": true,
    "workspaceOnly": true,
    "timeoutSec": 1800,
    "maxOutputChars": 12000,
    "allowBackground": true,
    "applyPatchEnabled": true,
    "allowedCommands": [
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
      "prettier"
    ]
  },
  "memoryTools": {
    "enabled": true,
    "maxResults": 6,
    "minScore": 0.2,
    "maxSnippetChars": 1200
  },
  "heartbeat": {
    "enabled": true,
    "everySec": 30,
    "stuckTaskWarnSec": 600,
    "writeLogFile": true
  },
  "cron": {
    "enabled": true,
    "tickSec": 10,
    "jobsFile": "<absolute OPENPOCKET_HOME>/workspace/cron/jobs.json"
  },
  "dashboard": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 51888,
    "autoOpenBrowser": false
  },
  "gatewayLogging": {
    "level": "info",
    "includePayloads": false,
    "maxPayloadChars": 160,
    "modules": {
      "core": true,
      "access": true,
      "task": true,
      "channel": true,
      "cron": true,
      "heartbeat": false,
      "humanAuth": true,
      "chat": false
    }
  },
  "humanAuth": {
    "enabled": false,
    "useLocalRelay": true,
    "localRelayHost": "127.0.0.1",
    "localRelayPort": 8787,
    "localRelayStateFile": "<absolute OPENPOCKET_HOME>/state/human-auth-relay/requests.json",
    "relayBaseUrl": "",
    "publicBaseUrl": "",
    "apiKey": "",
    "apiKeyEnv": "OPENPOCKET_HUMAN_AUTH_KEY",
    "requestTimeoutSec": 300,
    "pollIntervalMs": 2000,
    "tunnel": {
      "provider": "none",
      "ngrok": {
        "enabled": false,
        "executable": "ngrok",
        "authtoken": "",
        "authtokenEnv": "NGROK_AUTHTOKEN",
        "apiBaseUrl": "http://127.0.0.1:4040",
        "startupTimeoutSec": 20
      }
    }
  },
  "models": {
    "gpt-5.2-codex": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5.2-codex",
      "apiKey": "",
      "apiKeyEnv": "OPENAI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "gpt-5.3-codex": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5.3-codex",
      "apiKey": "",
      "apiKeyEnv": "OPENAI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "gpt-5.4": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5.4",
      "apiKey": "",
      "apiKeyEnv": "OPENAI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "claude-sonnet-4.6": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "claude-sonnet-4.6",
      "apiKey": "",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "claude-opus-4.6": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "claude-opus-4.6",
      "apiKey": "",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "blockrun/gpt-4o": {
      "baseUrl": "https://api.blockrun.ai/v1",
      "model": "openai/gpt-4o",
      "apiKey": "",
      "apiKeyEnv": "BLOCKRUN_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "blockrun/claude-sonnet-4": {
      "baseUrl": "https://api.blockrun.ai/v1",
      "model": "anthropic/claude-sonnet-4",
      "apiKey": "",
      "apiKeyEnv": "BLOCKRUN_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": "medium",
      "temperature": null
    },
    "blockrun/gemini-2.0-flash": {
      "baseUrl": "https://api.blockrun.ai/v1",
      "model": "google/gemini-2.0-flash-exp",
      "apiKey": "",
      "apiKeyEnv": "BLOCKRUN_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "google/gemini-2.0-flash": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "model": "gemini-2.0-flash",
      "apiKey": "",
      "apiKeyEnv": "GEMINI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "google/gemini-3-pro-preview": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "model": "gemini-3-pro-preview",
      "apiKey": "",
      "apiKeyEnv": "GEMINI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "google/gemini-3.1-pro-preview": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "model": "gemini-3.1-pro-preview",
      "apiKey": "",
      "apiKeyEnv": "GEMINI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "blockrun/deepseek-chat": {
      "baseUrl": "https://api.blockrun.ai/v1",
      "model": "deepseek/deepseek-chat",
      "apiKey": "",
      "apiKeyEnv": "BLOCKRUN_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "zai/glm-5": {
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "model": "glm-5",
      "apiKey": "",
      "apiKeyEnv": "ZAI_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    }
  }
}
```

## Managed Agent Overrides

When you run `openpocket create agent <id>`, OpenPocket clones a new agent config and rewrites these defaults:

- `workspaceDir` -> `<absolute OPENPOCKET_HOME>/agents/<id>/workspace`
- `stateDir` -> `<absolute OPENPOCKET_HOME>/agents/<id>/state`
- `sessionStorage.storePath` -> `<absolute OPENPOCKET_HOME>/agents/<id>/workspace/sessions/sessions.json`
- `screenshots.directory` -> `<absolute OPENPOCKET_HOME>/agents/<id>/state/screenshots`
- `cron.jobsFile` -> `<absolute OPENPOCKET_HOME>/agents/<id>/workspace/cron/jobs.json`
- `humanAuth.localRelayStateFile` -> `<absolute OPENPOCKET_HOME>/agents/<id>/state/human-auth-relay/requests.json`
- `dashboard.port` -> next available manager-assigned port (`>= 51889` by default)
- `agent.deviceId` -> `null`
- `target.adbEndpoint` -> `\"\"`
- `humanAuth.relayBaseUrl` / `humanAuth.publicBaseUrl` -> `\"\"`
- `channels` -> reset to `channels.defaults` only

Model behavior for managed agents:

- `defaultModel` and `models` are copied from `manager/model-template.json`
- after creation, each agent can change its own model config independently

Notes:

- Runtime-generated `config.json` uses absolute paths.
- `openpocket.config.example.json` keeps `~` for readability, but loader resolves to absolute paths.

## Normalization

- `defaultModel` must exist in `models`.
- `target.type` accepts only `emulator|physical-phone|android-tv|cloud`; invalid values fall back to `emulator`.
- `agent.lang` is normalized to `en` (runtime internal prompt language).
- `agent.systemPromptMode` accepts only `full|minimal|none`; invalid values fall back to `full`.
- `agent.contextBudgetChars` is clamped to at least `10000`.
- `agent.progressReportInterval` is clamped to at least `1`.
- `agent.runtimeBackend` accepts only `legacy_agent_core|pi_session_bridge`; other values fall back to `legacy_agent_core`.
- `agent.legacyCodingExecutor` defaults to `false`; enabling it is a deprecated migration toggle.
- `emulator.dataPartitionSizeGb` is clamped to `8..512` (GB).
- `screenshots.maxCount` is clamped to at least `20`.
- `scriptExecutor.timeoutSec` is clamped to at least `1`.
- `scriptExecutor.maxOutputChars` is clamped to at least `1000`.
- `codingTools.timeoutSec` is clamped to at least `1`.
- `codingTools.maxOutputChars` is clamped to at least `1000`.
- `memoryTools.maxResults` is clamped to `1..30`.
- `memoryTools.minScore` is clamped to `0..1`.
- `memoryTools.maxSnippetChars` is clamped to `200..8000`.
- `heartbeat.everySec` is clamped to at least `5`.
- `heartbeat.stuckTaskWarnSec` is clamped to at least `30`.
- `cron.tickSec` is clamped to at least `2`.
- `dashboard.port` is clamped to `1..65535`.
- `gatewayLogging.level` accepts only `error|warn|info|debug`.
- `gatewayLogging.maxPayloadChars` is clamped to `40..1000`.
- `humanAuth.localRelayPort` is clamped to `1..65535`.
- `humanAuth.requestTimeoutSec` is clamped to at least `30`.
- `humanAuth.pollIntervalMs` is clamped to at least `500`.
- `humanAuth.tunnel.provider` accepts only `none|ngrok`.
- `humanAuth.tunnel.ngrok.startupTimeoutSec` is clamped to at least `3`.
- `allowedChatIds` is coerced to numeric array with non-finite values removed.
- model `baseUrl` is normalized for known providers:
  - Google Generative Language bare host -> `/v1beta`
  - Anthropic `/v1` endpoint -> root endpoint
- model `reasoningEffort` accepts only `low|medium|high|xhigh`, else `null`.
- model `temperature` is `null` if absent/invalid.

## Paths

- Values starting with `~` are expanded to user home.
- Other paths are resolved to absolute paths.

## API Keys

Per model profile:

1. use `apiKey` when non-empty
2. else use env var from `apiKeyEnv`
3. else for OpenAI codex models, try Codex CLI credentials (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`; macOS keychain `Codex Auth` first)
4. else key is missing

Missing key causes task start failure with a persisted failed session/memory entry.

Human-auth relay API key precedence:

1. `humanAuth.apiKey`
2. env from `humanAuth.apiKeyEnv`
3. empty (relay endpoints run without bearer auth)

ngrok authtoken precedence:

1. `humanAuth.tunnel.ngrok.authtoken`
2. env from `humanAuth.tunnel.ngrok.authtokenEnv`

## Backward Compatibility Keys

The loader maps snake_case compatibility keys to camelCase keys before merge.

Examples:

- `default_model` -> `defaultModel`
- `max_steps` -> `maxSteps`
- `system_prompt_mode` -> `systemPromptMode`
- `context_budget_chars` -> `contextBudgetChars`
- `script_executor` -> `scriptExecutor`
- `coding_tools` -> `codingTools`
- `memory_tools` -> `memoryTools`
- `heartbeat_config` -> `heartbeat`
- `cron_config` -> `cron`
- `gateway_logging` -> `gatewayLogging`
- `human_auth` -> `humanAuth`
- `include_payloads` -> `includePayloads`
- `max_payload_chars` -> `maxPayloadChars`
- `allowed_commands` -> `allowedCommands`
- `base_url` -> `baseUrl`
- `reasoning_effort` -> `reasoningEffort`
