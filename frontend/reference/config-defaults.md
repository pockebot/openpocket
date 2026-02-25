# Config Defaults

This page is the source-of-truth for current default config values and normalization behavior.

## Default Config JSON

```json
{
  "projectName": "OpenPocket",
  "workspaceDir": "<absolute OPENPOCKET_HOME>/workspace",
  "stateDir": "<absolute OPENPOCKET_HOME>/state",
  "defaultModel": "gpt-5.2-codex",
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
    "blockrun/deepseek-chat": {
      "baseUrl": "https://api.blockrun.ai/v1",
      "model": "deepseek/deepseek-chat",
      "apiKey": "",
      "apiKeyEnv": "BLOCKRUN_API_KEY",
      "maxTokens": 4096,
      "reasoningEffort": null,
      "temperature": null
    },
    "autoglm-phone": {
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "model": "autoglm-phone-multilingual",
      "apiKey": "",
      "apiKeyEnv": "AUTOGLM_API_KEY",
      "maxTokens": 3000,
      "reasoningEffort": null,
      "temperature": null
    }
  }
}
```

Notes:

- Runtime-generated `config.json` uses absolute paths.
- `openpocket.config.example.json` keeps `~` for readability, but loader resolves to absolute paths.

## Normalization

- `defaultModel` must exist in `models`.
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
- `humanAuth.localRelayPort` is clamped to `1..65535`.
- `humanAuth.requestTimeoutSec` is clamped to at least `30`.
- `humanAuth.pollIntervalMs` is clamped to at least `500`.
- `humanAuth.tunnel.provider` accepts only `none|ngrok`.
- `humanAuth.tunnel.ngrok.startupTimeoutSec` is clamped to at least `3`.
- `allowedChatIds` is coerced to numeric array with non-finite values removed.
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
- `human_auth` -> `humanAuth`
- `allowed_commands` -> `allowedCommands`
- `base_url` -> `baseUrl`
- `reasoning_effort` -> `reasoningEffort`
