# Configuration

OpenPocket loads config from JSON, merges defaults, normalizes compatibility keys, and writes resolved runtime structure.

In multi-agent mode, each agent instance still has its own full `config.json`.

## File Resolution

Resolution order:

1. CLI `--config <path>` if provided
2. CLI `--agent <id>` if provided
3. default root config at `OPENPOCKET_HOME/config.json`
4. if missing, default config is auto-created

`OPENPOCKET_HOME` defaults to `~/.openpocket`.

Rules:

- `--config` and `--agent` are mutually exclusive
- omitting both selects the onboarded `default` agent
- `openpocket create agent <id>` registers a managed agent under `OPENPOCKET_HOME/agents/<id>/config.json`

## Config Scope Levels

### Default agent

The onboarded root agent uses:

- `OPENPOCKET_HOME/config.json`
- `OPENPOCKET_HOME/workspace/`
- `OPENPOCKET_HOME/state/`

### Managed agents

Managed agents use:

- `OPENPOCKET_HOME/agents/<agentId>/config.json`
- `OPENPOCKET_HOME/agents/<agentId>/workspace/`
- `OPENPOCKET_HOME/agents/<agentId>/state/`

### Manager metadata

Install-level metadata lives under:

- `OPENPOCKET_HOME/manager/registry.json`
- `OPENPOCKET_HOME/manager/model-template.json`
- `OPENPOCKET_HOME/manager/ports.json`

These manager files are not agent configs. They coordinate agent discovery, the initial model template, and shared port allocation.

## Load Order

At startup, config handling does:

1. parse JSON from the selected config path
2. convert compatibility `snake_case` keys to `camelCase`
3. deep-merge with the default config object
4. normalize model profiles and typed fields
5. resolve paths (`~` and relative paths -> absolute)
6. ensure required directories
7. bootstrap workspace files when missing

This happens independently for each selected agent config.

## Create-Agent Cloning Rules

`openpocket create agent <id>` clones from the source config, but it does **not** copy the entire runtime state.

What is rewritten for the new agent:

- `workspaceDir`
- `stateDir`
- `sessionStorage.storePath`
- `screenshots.directory`
- `cron.jobsFile`
- `dashboard.port`
- `humanAuth.localRelayStateFile`
- `configPath`

What is reset/cleared:

- `agent.deviceId`
- `target.adbEndpoint`
- `humanAuth.relayBaseUrl`
- `humanAuth.publicBaseUrl`
- all channel credentials/config except `channels.defaults`

What is copied from the manager template rather than from the current source config:

- `defaultModel`
- `models`

This means managed agents start from the **initial onboard model template**, then become independent afterwards.

## API Keys

Per model profile:

- use `models.<name>.apiKey` if non-empty
- else env var from `models.<name>.apiKeyEnv`
- else for OpenAI codex models, try Codex CLI credentials (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`; macOS keychain `Codex Auth` first)
- else treat key as missing and fail task early

For human-auth relay:

- standalone/local relay uses `humanAuth.apiKey` or `humanAuth.apiKeyEnv`
- shared relay hub launched by `openpocket human-auth-relay start` does not use separate per-agent relay state or per-agent hub API keys
- in managed mode, agent-local request state still stays under the agent's own `state/`

## Backward Compatibility Keys

Loader maps old keys automatically, including:

- top-level: `project_name`, `workspace_dir`, `state_dir`, `default_model`, `script_executor`, `coding_tools`, `memory_tools`
- top-level aliases: `heartbeat_config`, `cron_config`, `dashboard_config`, `gateway_logging`, `human_auth`
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
- `gatewayLogging.level` in `error|warn|info|debug` (invalid -> `info`)
- `gatewayLogging.maxPayloadChars` clamped to `40..1000`
- `humanAuth.localRelayPort` in `1..65535`
- `humanAuth.requestTimeoutSec >= 30`
- `humanAuth.pollIntervalMs >= 500`
- `humanAuth.tunnel.provider` in `none|ngrok`
- `humanAuth.tunnel.ngrok.startupTimeoutSec >= 3`
- model `baseUrl` normalization:
  - Google AI Studio endpoints auto-normalize bare host to `/v1beta`
  - Anthropic `/v1` base URL auto-normalizes to root endpoint

If `defaultModel` does not exist in `models`, startup throws.

## Related Runtime Constraints

- one agent binds one selected target at a time
- targets cannot be shared between agents
- each running gateway acquires a per-agent gateway lock and a per-target runtime lock
- manager dashboard and shared relay hub ports are allocated centrally via `manager/ports.json`

## Defaults

See [Config Defaults](../reference/config-defaults.md) for the exact default JSON and managed-agent path overrides.
