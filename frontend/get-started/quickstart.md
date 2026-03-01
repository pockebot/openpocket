# Quickstart

This page gets OpenPocket running locally with the current Node.js + TypeScript runtime.

OpenPocket controls a configurable Agent Phone target through `adb`.

- Default target: `emulator`
- Recommended production-like target: `physical-phone` (USB/Wi-Fi ADB)
- `android-tv` and `cloud` targets are currently in progress

For target-specific setup, see [Device Targets](./device-targets.md).

## Prerequisites

- Node.js 20+
- Android platform-tools (`adb`) for all targets
- API key for your configured model profile
- Telegram bot token (for gateway mode)

For emulator target (default):

- Android SDK Emulator
- at least one Android AVD

For physical phone target:

- one Android phone with Developer options + USB debugging enabled

You do not need to root your personal phone.

## npm Install

```bash
npm install -g openpocket
openpocket onboard
```

OpenPocket uses a local web dashboard:

```bash
openpocket dashboard start
```

## Source Install

```bash
git clone git@github.com:SergioChan/openpocket.git
cd openpocket
npm install
npm run build
./openpocket onboard
```

`./openpocket` uses `dist/cli.js` when present and falls back to `tsx src/cli.ts` in dev installs.

Default runtime home is `~/.openpocket` unless `OPENPOCKET_HOME` is set.

For commands below:

- use `openpocket ...` for npm package install
- use `./openpocket ...` for local clone

## First Onboard Output

On first `onboard`, OpenPocket creates:

- `config.json`
- `workspace/` with bootstrap prompt templates and runtime folders
- `state/` for runtime state and logs

CLI onboarding state:

- `state/onboarding.json`

Workspace bootstrap includes prompt/memory identity files (for example `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `TASK_PROGRESS_REPORTER.md`, `TASK_OUTCOME_REPORTER.md`).

## Env Vars

```bash
export OPENAI_API_KEY="<your_key>"
export OPENROUTER_API_KEY="<your_key>"        # if using OpenRouter profiles
export TELEGRAM_BOT_TOKEN="<your_bot_token>"   # for gateway mode
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
```

Optional:

```bash
export OPENPOCKET_HOME="$HOME/.openpocket"
export BLOCKRUN_API_KEY="<optional>"
export AUTOGLM_API_KEY="<optional>"
export OPENPOCKET_HUMAN_AUTH_KEY="<optional relay api key>"
export NGROK_AUTHTOKEN="<optional ngrok token>"
export CODEX_HOME="$HOME/.codex"              # optional override
```

If you use Codex subscription auth, run `codex login` and codex model profiles can use CLI credentials.

## Command Check

```bash
openpocket config-show
openpocket target show
openpocket emulator status
openpocket emulator start
openpocket emulator screenshot --out ~/Desktop/openpocket-screen.png
openpocket skills list
openpocket script run --text "echo hello"
```

## Switch Target (Optional)

Keep default emulator:

```bash
openpocket target set --type emulator
```

Use a connected physical phone (interactive device picker when multiple are online):

```bash
openpocket target set --type physical-phone
```

If multiple ADB devices are online, CLI shows an arrow-key selector with transport labels (`USB ADB` / `WiFi ADB`).

For Android 11+ Wireless debugging pairing, you can run:

```bash
openpocket target pair --host <device-ip> --pair-port <pair-port> --code <pairing-code> --type physical-phone
```

Then verify:

```bash
openpocket target show
adb devices -l
```

## Run a Task (CLI)

```bash
openpocket agent --model gpt-5.2-codex "Open Chrome and search weather"
```

Result includes:

- summary message
- session file path (`workspace/sessions/session-*.md`)
- daily memory append (`workspace/memory/YYYY-MM-DD.md`)

## Run via Telegram Gateway

```bash
openpocket gateway start
```

Gateway startup verifies the selected target device is online before task processing.

Then chat with your bot:

- `/start` (will trigger chat onboarding if workspace profile is incomplete)
- plain text requests for auto route (`task` or `chat`)
- `/help` for command list

Useful debug command:

- `/context [list|detail|json]`

## Human-in-the-Loop

When task emits `request_human_auth`, gateway can send one-time approval link and `/auth` fallback commands.

For architecture and end-to-end validation:

- [Remote Human Authorization](../concepts/remote-human-authorization.md)

PermissionLab E2E command:

```bash
openpocket test permission-app run --case camera --chat <telegram_chat_id>
```
