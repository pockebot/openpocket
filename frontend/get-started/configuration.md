# Configuration

OpenPocket loads config from JSON, merges defaults, normalizes compatibility keys, and writes resolved runtime structure.

## File Location

Resolution order:

1. CLI `--config <path>` if provided
2. default `OPENPOCKET_HOME/config.json`
3. if missing, default config is auto-created

`OPENPOCKET_HOME` defaults to `~/.openpocket`.

## Load Order

At startup, config handling does:

1. parse JSON from config path
2. convert compatibility `snake_case` keys to `camelCase`
3. deep-merge with default config object
4. normalize model profiles and typed fields
5. resolve paths (`~` and relative paths -> absolute)
6. ensure required directories
7. bootstrap workspace files when missing

## API Keys

Per model profile:

- use `models.<name>.apiKey` if non-empty
- else env var from `models.<name>.apiKeyEnv`
- else for OpenAI codex models, try Codex CLI credentials (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`; macOS keychain `Codex Auth` first)
- else treat key as missing and fail task early

For human-auth relay:

- `humanAuth.apiKey` if non-empty
- else env from `humanAuth.apiKeyEnv` (default `OPENPOCKET_HUMAN_AUTH_KEY`)
- if both empty, relay still works in no-auth mode (recommended only for trusted local setups)

## Backward Compatibility Keys

Loader maps old keys automatically, including:

- top-level: `project_name`, `workspace_dir`, `state_dir`, `default_model`, `script_executor`, `coding_tools`, `memory_tools`
- top-level aliases: `heartbeat_config`, `cron_config`, `dashboard_config`, `human_auth`
- nested: `avd_name`, `android_sdk_root`, `bot_token`, `max_steps`, `system_prompt_mode`, `context_budget_chars`, `save_step_screenshots`, `allowed_commands`, `base_url`, `api_key`, `reasoning_effort`, etc.

After `onboard`, saved config uses camelCase keys.

## Validation and Clamps

Normalization enforces:

- `defaultModel` must exist in `models`
- `agent.lang` -> `en`
- `agent.systemPromptMode` in `full|minimal|none` (invalid -> `full`)
- `agent.contextBudgetChars >= 10000`
- `agent.progressReportInterval >= 1`
- `screenshots.maxCount >= 20`
- `scriptExecutor.timeoutSec >= 1`
- `scriptExecutor.maxOutputChars >= 1000`
- `codingTools.timeoutSec >= 1`
- `codingTools.maxOutputChars >= 1000`
- `memoryTools.maxResults` in `1..30`
- `memoryTools.minScore` in `0..1`
- `memoryTools.maxSnippetChars` in `200..8000`
- `heartbeat.everySec >= 5`
- `heartbeat.stuckTaskWarnSec >= 30`
- `cron.tickSec >= 2`
- `dashboard.port` in `1..65535`
- `humanAuth.localRelayPort` in `1..65535`
- `humanAuth.requestTimeoutSec >= 30`
- `humanAuth.pollIntervalMs >= 500`
- `humanAuth.tunnel.provider` in `none|ngrok`
- `humanAuth.tunnel.ngrok.startupTimeoutSec >= 3`

If `defaultModel` does not exist in `models`, startup throws.

## Defaults

See [Config Defaults](../reference/config-defaults.md) for exact default JSON and field-by-field reference.
