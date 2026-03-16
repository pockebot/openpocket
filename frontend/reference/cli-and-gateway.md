# CLI and Gateway Reference

## CLI Commands

```text
openpocket [--config <path> | --agent <id>] install-cli
openpocket [--config <path> | --agent <id>] onboard [--force] [--target <type>]
openpocket [--config <path> | --agent <id>] config-show
openpocket [--config <path> | --agent <id>] model show|list|set [--name <profile>|<profile>] [--provider <provider> --model <model-id>]
openpocket [--config <path> | --agent <id>] target show
openpocket [--config <path> | --agent <id>] target set|set-target|config --type <emulator|physical-phone|android-tv|cloud> [--device <id>] [--adb-endpoint <host[:port]>] [--pin <4-digit>] [--wakeup-interval <sec>]
openpocket [--config <path> | --agent <id>] target pair [--host <ip>] [--pair-port <port>] [--connect-port <port>] [--code <pairing-code>] [--type <physical-phone|android-tv>] [--device <id|auto>] [--dry-run]
openpocket [--config <path> | --agent <id>] emulator status
openpocket [--config <path> | --agent <id>] emulator start
openpocket [--config <path> | --agent <id>] emulator stop
openpocket [--config <path> | --agent <id>] emulator hide
openpocket [--config <path> | --agent <id>] emulator show
openpocket [--config <path> | --agent <id>] emulator list-avds
openpocket [--config <path> | --agent <id>] emulator screenshot [--out <path>]
openpocket [--config <path> | --agent <id>] emulator tap --x <int> --y <int> [--device <id>]
openpocket [--config <path> | --agent <id>] emulator type --text <text> [--device <id>]
openpocket [--config <path> | --agent <id>] agent [--model <name>] <task>
openpocket [--config <path> | --agent <id>] skills list|load [--all]|validate [--strict]
openpocket [--config <path> | --agent <id>] script run [--file <path> | --text <script>] [--timeout <sec>]
openpocket [--config <path> | --agent <id>] channels login --channel <name>
openpocket [--config <path> | --agent <id>] channels whoami [--channel <name>]
openpocket [--config <path> | --agent <id>] channels list
openpocket [--config <path> | --agent <id>] gateway [start|telegram]
openpocket [--config <path> | --agent <id>] dashboard start [--host <host>] [--port <port>]
openpocket dashboard manager [--host <host>] [--port <port>]
openpocket [--config <path> | --agent <id>] test permission-app [deploy|install|launch|reset|uninstall|task|run|cases] [--device <id>] [--clean] [--case <id>] [--send] [--chat <id>] [--model <name>]
openpocket [--config <path> | --agent <id>] human-auth-relay start [--host <host>] [--port <port>] [--public-base-url <url>]
openpocket create agent <id> [--type <target-type>] [--device <id>] [--adb-endpoint <host[:port]>] [--pin <4-digit>] [--wakeup-interval <sec>]
openpocket agents list
openpocket agents show [<id>]
openpocket agents delete <id>
```

Deprecated aliases:

```text
openpocket [--config <path> | --agent <id>] init
openpocket [--config <path> | --agent <id>] setup
```

Local clone launcher:

```text
./openpocket <command>
```

## Global Selection Rules

- `--config <path>` and `--agent <id>` are mutually exclusive
- omitting both selects the onboarded `default` agent
- manager-level commands (`create agent`, `agents ...`, `dashboard manager`) do not require `--agent`

## `onboard`

- loads or creates config
- writes normalized config
- ensures workspace bootstrap files/directories
- runs Android dependency doctor (auto-install on macOS when tools are missing)
- ensures Java 17+ for Android command line tools
- asks for deployment target (`emulator` / `physical-phone` / `android-tv` / `cloud`)
- reuses existing local AVD when available
- installs CLI launcher on first onboard (`~/.local/bin/openpocket`)
- runs interactive setup wizard (consent/model/API key/channel/human-auth mode)
- when target is `emulator`, includes emulator startup + Play Store/Gmail check
- when target is non-emulator, skips emulator onboarding and asks to verify adb connectivity
- for physical phone / Android TV, supports later Wi-Fi pairing via `target pair`
- captures the initial manager model template used later by `create agent`

Wizard persistence:

- `state/onboarding.json`

## `create agent`

Example:

```bash
openpocket create agent review-bot --type physical-phone --device R5CX123456A
```

Behavior:

- validates agent id and reserves `default`
- clones the selected source config into a new managed agent directory
- rewrites workspace/state/config/runtime paths
- seeds the new config from the captured manager model template
- clears channel credentials and target runtime identity
- allocates a unique dashboard port
- rejects duplicate target bindings
- registers the agent in `manager/registry.json`

The new agent is isolated from the source agent's workspace data, session history, and channel state.

## `agents list|show|delete`

Examples:

```bash
openpocket agents list
openpocket agents show review-bot
openpocket agents delete review-bot
```

Notes:

- `agents show` defaults to `default`
- `agents delete` cannot remove `default`
- `agents delete` requires the target agent gateway to be stopped

## `target set`

- updates deployment target type and runtime device preferences
- when setting `physical-phone` or `android-tv` without `--device`, OpenPocket discovers online ADB devices and:
  - auto-selects when exactly one online candidate exists
  - otherwise opens an arrow-key selector with connection labels (`USB ADB` / `WiFi ADB`)
- setting `--pin` updates target auto-unlock PIN (`target.pin`)
- setting `--wakeup-interval` updates keep-awake heartbeat interval (`target.wakeupIntervalSec`)
- rejects target fingerprints already registered to another agent
- requires the selected agent gateway to be stopped first

## `target pair`

Use this wrapper for Android Wireless Debugging pairing without typing raw `adb pair` / `adb connect`.

Non-interactive example:

```bash
openpocket target pair \
  --host <device-ip> \
  --pair-port <pair-port> \
  --code <pairing-code> \
  --type physical-phone
```

Behavior:

- runs `adb pair <host:pair-port> <code>`
- runs `adb connect <host:connect-port>` (default connect port: `5555`)
- updates config target endpoint and preferred device id
- re-checks target exclusivity before saving
- supports `--dry-run` for command preview without changing device state

## `install-cli`

- explicitly (re)installs local CLI launcher at `~/.local/bin/openpocket`
- adds `~/.local/bin` export line to `~/.zshrc` and `~/.bashrc` when missing

## `dashboard start`

- starts the selected agent's local Web dashboard server
- host/port defaults from `config.dashboard`
- optional `--host` and `--port` override
- optional browser auto-open when `dashboard.autoOpenBrowser=true`

## `dashboard manager`

- starts the install-level manager dashboard
- host/port default from `manager/ports.json`
- shows all registered agents, target fingerprints, model profiles, channel types, dashboard URLs, and gateway status
- updates `manager/ports.json` if a fallback port is needed

## `gateway start`

Startup sequence:

1. load selected agent config
2. acquire per-agent gateway lock
3. acquire per-target runtime lock
4. validate configured channel credentials
5. ensure selected target device is online
6. ensure selected agent dashboard is running
7. initialize gateway runtime
8. start polling + heartbeat + cron

Target behavior:

- if target is `emulator`: boot emulator when needed and wait for boot-complete
- if target is non-emulator: verify at least one adb device is online (USB or configured adb endpoint)

Gateway startup also:

- attempts Telegram bot display-name sync from `workspace/IDENTITY.md` (`- Name:`)
- starts the integrated per-agent dashboard when enabled
- records dashboard address in the agent runtime lock

When human auth is enabled, a managed agent can use:

- a private local relay stack registered to the shared relay hub
- the shared relay hub started by `openpocket human-auth-relay start`
- an optional shared ngrok public URL owned by that hub

## `human-auth-relay start`

This command starts the **shared relay hub**, not a per-agent relay server.

Behavior:

- listens on a manager-level local port
- optionally starts one ngrok tunnel for the entire install
- allows managed agents to register their private local relay endpoints
- proxies requests by `/a/<agentId>/...`
- updates `manager/ports.json` when a fallback port is needed

Notes:

- request state and uploaded artifacts still remain in each agent's own `state/`
- if the relay hub is unavailable, managed agents fall back to direct local relay URLs

## Model Profile Management

Examples:

```bash
openpocket model show
openpocket model list
openpocket model set --name gpt-5.4
openpocket model set --name aliyun-ui-agent/mobile
openpocket --agent review-bot model set --provider google --model gemini-3.1-pro-preview
openpocket --agent review-bot model set --provider aliyun-ui-agent --model pre-gui_owl_7b
```

Notes:

- `model set --name <profile>` switches to an existing profile key
- `model set --provider <provider> --model <model-id>` creates/updates a profile from provider presets and switches the selected agent's default model
- model config is per agent after creation
- `Aliyun UI Agent (Mobile)` is a dedicated backend, not a normal OpenAI-compatible chat profile even though it uses DashScope
- when using `aliyun-ui-agent/mobile`, the selected agent must expose screenshots through the local relay stack; for public internet access, use the shared relay hub or per-agent ngrok

## Channel Commands

Examples:

```bash
openpocket channels list
openpocket channels whoami --channel telegram
openpocket --agent review-bot channels login --channel discord
```

Managed-agent behavior:

- channels are configured per agent
- auth/state files live under that agent's `state/`
- credentials are not copied from the source agent during `create agent`

## Telegram Commands

Supported gateway commands:

- `/start`
- `/help`
- `/context [list|detail|json]`
- `/context detail <fileName>`
- `/status`
- `/model [name]`
- `/startvm`
- `/stopvm`
- `/hidevm`
- `/showvm`
- `/screen`
- `/skills`
- `/clear`
- `/reset`
- `/stop`
- `/restart`
- `/cronrun <job-id>`
- `/auth`
- `/auth pending`
- `/auth approve <request-id> [note]`
- `/auth reject <request-id> [note]`
- `/run <task>`

## Chat and Task Routing

Plain text is auto-routed by `ChatAssistant.decide`:

1. bootstrap/profile onboarding checks
2. model classifier (`task` vs `chat`)
3. fallback to `task` when classifier fails

Task mode:

- gateway sends a short accepted message
- runs `AgentRuntime.runTask`
- progress updates are model-narrated and selectively emitted
- final result is model-narrated through outcome reporter

Chat mode:

- conversational response via model endpoint fallback (`responses` -> `chat` -> `completions`)

All of this happens inside the selected agent workspace and selected target context.

## Bootstrap and Session Reset Behavior

`/start` behavior:

- if onboarding is pending, gateway seeds onboarding with a locale-aware greeting and sends onboarding reply
- otherwise returns ready message

`/reset` behavior:

- clears in-memory chat turns and requests stop on running task
- if onboarding is pending, starts onboarding reply first
- else sends reset prompt from `BARE_SESSION_RESET_PROMPT.md` (or built-in fallback)

## Prompt Context Diagnostics (`/context`)

`/context` exposes system-prompt construction report from `AgentRuntime`.

Modes:

- `list` (default): summary of prompt source, mode, budgets, and file injection status
- `detail`: full breakdown including skill/tool char budgets
- `detail <fileName>`: injected snippet for one workspace context file
- `json`: raw context report JSON

Report includes:

- prompt mode (`full|minimal|none`)
- total system prompt chars
- workspace context chars and truncation state
- per-file inclusion/missing/budget-exhausted status
- skill prompt and tool schema size contribution

## Progress and Outcome Messaging

Gateway uses model-driven narration:

- progress prompt: `TASK_PROGRESS_REPORTER.md`
- outcome prompt: `TASK_OUTCOME_REPORTER.md`

Additional suppression logic avoids noisy updates:

- skip low-signal repeats on same screen
- suppress highly similar messages sent too recently
- strip step counters unless user explicitly asked for telemetry

## Human Auth in Gateway

When task emits `request_human_auth`:

- gateway creates a pending request through `HumanAuthBridge`
- sends channel message with auth link and fallback commands
- if URL is available, includes one-tap web button
- supports inline OTP resolution for `sms`/`2fa` (plain 4-10 digits)
- for `oauth`, web page provides dedicated username/password inputs plus optional remote takeover
- approval artifacts are stored locally under that agent's `state/human-auth-artifacts/`

Manual fallback commands remain available:

- `/auth pending`
- `/auth approve <request-id> [note]`
- `/auth reject <request-id> [note]`
