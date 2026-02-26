# CLI and Gateway Reference

## CLI Commands

```text
openpocket [--config <path>] install-cli
openpocket [--config <path>] onboard
openpocket [--config <path>] config-show
openpocket [--config <path>] target show
openpocket [--config <path>] target set --type <emulator|physical-phone|android-tv|cloud> [--device <id>] [--adb-endpoint <host[:port]>] [--cloud-provider <name>] [--clear-device] [--clear-adb-endpoint]
openpocket [--config <path>] emulator status|start|stop|hide|show|list-avds|screenshot [--out <path>] [--device <id>]
openpocket [--config <path>] emulator tap --x <int> --y <int> [--device <id>]
openpocket [--config <path>] emulator type --text <text> [--device <id>]
openpocket [--config <path>] agent [--model <name>] <task>
openpocket [--config <path>] skills list
openpocket [--config <path>] script run [--file <path> | --text <script>] [--timeout <sec>]
openpocket [--config <path>] telegram setup|whoami
openpocket [--config <path>] gateway [start|telegram]
openpocket [--config <path>] dashboard start [--host <host>] [--port <port>]
openpocket [--config <path>] test permission-app [deploy|install|launch|reset|uninstall|task|run|cases] [--device <id>] [--clean] [--case <id>] [--send] [--chat <id>] [--model <name>]
openpocket [--config <path>] human-auth-relay start [--host <host>] [--port <port>] [--public-base-url <url>] [--api-key <key>] [--state-file <path>]
```

Deprecated aliases:

```text
openpocket [--config <path>] init
openpocket [--config <path>] setup
```

Local clone launcher:

```text
./openpocket <command>
```

## `onboard`

- loads or creates config
- writes normalized config
- ensures workspace bootstrap files/directories
- runs Android dependency doctor (auto-install on macOS when tools are missing)
- ensures Java 17+ for Android command line tools
- asks for deployment target (`emulator` / `physical-phone` / `android-tv` / `cloud`)
- reuses existing local AVD when available
- installs CLI launcher on first onboard (`~/.local/bin/openpocket`)
- runs interactive setup wizard (consent/model/API key/Telegram/human-auth mode)
- when target is `emulator`, includes emulator startup + Play Store/Gmail check
- when target is non-emulator, skips emulator onboarding and asks to verify adb connectivity

Wizard persistence:

- `state/onboarding.json`

## `install-cli`

- explicitly (re)installs local CLI launcher at `~/.local/bin/openpocket`
- adds `~/.local/bin` export line to `~/.zshrc` and `~/.bashrc` when missing

## `dashboard start`

- starts local Web dashboard server
- host/port defaults from `config.dashboard`
- optional `--host` and `--port` override
- optional browser auto-open when `dashboard.autoOpenBrowser=true`

## `gateway start`

Startup sequence:

1. load config
2. validate Telegram token source (`config.telegram.botToken` or env)
3. ensure selected target device is online
4. ensure dashboard is running
5. initialize Telegram gateway runtime
6. start polling + heartbeat + cron

Step 3 behavior:

- if target is `emulator`: boot emulator when needed and wait for boot-complete
- if target is non-emulator: verify at least one adb device is online (USB or configured adb endpoint)

When human auth is enabled, gateway can auto-start:

- local relay stack (`humanAuth.useLocalRelay=true`)
- ngrok tunnel (`humanAuth.tunnel.provider=ngrok` and `humanAuth.tunnel.ngrok.enabled=true`)

Gateway startup also attempts Telegram bot display-name sync from `workspace/IDENTITY.md` (`- Name:`).

## Telegram Commands

Supported commands:

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

This keeps task chat updates natural and sparse.

## Telegram Display Name Sync

When onboarding/profile update changes assistant name:

- `ChatAssistant` sets pending profile update payload
- gateway calls Telegram `setMyName`
- local sync state is cached in `state/telegram-bot-name-sync.json`
- if Telegram rate-limits name changes, gateway defers retry and informs user

## Human Auth in Gateway

When task emits `request_human_auth`:

- gateway creates pending request through `HumanAuthBridge`
- sends Telegram message with auth link and fallback commands
- if URL is available, includes one-tap web button
- supports inline OTP resolution for `sms`/`2fa` (plain 4-10 digits)
- for `oauth`, web page provides dedicated username/password inputs plus optional remote takeover
- approval artifacts are stored locally under `state/human-auth-artifacts/`

Manual fallback commands remain available:

- `/auth pending`
- `/auth approve <request-id> [note]`
- `/auth reject <request-id> [note]`

## Telegram Output Sanitization

Before sending model/task content back to chat:

- remove internal lines (`Session:`, `Auto skill:`, `Auto script:`)
- redact local screenshot and run-directory paths
- compact and length-limit output

This keeps user-facing messages concise and avoids local path leakage.

## Related Specs

- [Remote Human Authorization](../concepts/remote-human-authorization.md)
- [Prompt Templates](./prompt-templates.md)
- [Action and Output Schema](./action-schema.md)
- [Session and Memory Formats](./session-memory-formats.md)
