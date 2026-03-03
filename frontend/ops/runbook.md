# Operations Runbook

This runbook focuses on day-to-day operation of the current runtime.

## Daily Start

1. Ensure Android emulator dependencies are available.
2. Verify config and environment variables.
3. Run onboarding if first launch.
4. Start emulator and verify booted device.
5. Start gateway or run tasks from CLI.
6. Validate human-auth readiness if remote approvals are enabled.

Commands:

```bash
openpocket config-show
openpocket onboard
openpocket emulator status
openpocket emulator start
openpocket gateway start
```

If launcher is not in PATH yet, use `node dist/cli.js <command>`.

Human-auth readiness checks:

- `humanAuth.enabled` and `humanAuth.useLocalRelay` in config
- `humanAuth.relayBaseUrl` / `humanAuth.publicBaseUrl` populated after gateway boot
- if ngrok mode is enabled, verify `NGROK_AUTHTOKEN` (or config token)

## Runtime Prompt Context Check

Before production runs, validate prompt context injection:

- `/context` for summary
- `/context detail` for full report
- `/context detail <fileName>` for file snippet
- `/context json` for raw JSON

Use this when investigating unexpected model behavior.

## Remote Auth Validation (PermissionLab)

Use this playbook to verify remote authorization E2E.

```bash
openpocket telegram whoami
openpocket test permission-app cases
openpocket test permission-app run --case camera --chat <telegram_chat_id>
```

Expected outcome:

1. PermissionLab deploys and launches.
2. Agent taps scenario button in emulator.
3. If scenario requires remote authorization, Telegram receives human-auth request with link.
4. Phone approval/rejection resolves request.
5. Agent resumes and reports final result.

Note:

- in-emulator Android runtime permission dialogs are auto-handled locally (no remote auth required for those dialogs).

Recommended scenario matrix:

- `--case camera` for image delegation
- `--case location` for geo delegation
- `--case sms` or `--case 2fa` for text/code delegation
- real app login wall (`capability=oauth`) for credential delegation or optional remote takeover validation

## Automated Agent E2E (Local)

Validate natural-language planning -> emulator actions -> session assertions.

```bash
npm run build
OPENPOCKET_E2E_HOME=/tmp/openpocket-e2e-report node test/integration/docker-agent-e2e.mjs
```

Expected outcome:

1. mock model server starts locally
2. emulator boots and is detected by `adb`
3. task session contains expected action chain and `status: SUCCESS`
4. script exits with `E2E assertions passed`

This test uses local mock endpoint and does not require external model API keys.

## Monitoring

- gateway logs show accepted task, progress narration decisions, and final status
- heartbeat logs are printed and appended to `state/heartbeat.log`
- cron execution state in `state/cron-state.json`
- each task writes `workspace/sessions/session-*.md`
- each task appends one line to `workspace/memory/YYYY-MM-DD.md`
- relay requests in `state/human-auth-relay/requests.json`
- uploaded auth artifacts in `state/human-auth-artifacts/`

Log tuning:

- use `gatewayLogging.level` to set baseline verbosity (`error|warn|info|debug`)
- disable noisy domains with `gatewayLogging.modules.*` (for example `heartbeat=false`, `chat=false`)
- keep `gatewayLogging.includePayloads=false` in production to avoid task/input payload leakage

## Safe Stop

- use `/stop` in Telegram to request cancellation
- runtime checks stop flag between steps and finalizes session as failed with stop reason
- for blocked auth requests, use `/auth pending` then `/auth approve|reject`

## Debug Evidence Collection

When remote auth flow fails, collect:

- gateway lines containing `[OpenPocket][gateway-core][humanAuth]` and `[OpenPocket][human-auth]`
- latest session under `workspace/sessions/`
- relay state file `state/human-auth-relay/requests.json`
- artifact listing under `state/human-auth-artifacts/`

For prompt diagnosis, also collect `/context json` output.

## Data Retention

- screenshots: bounded by `screenshots.maxCount`
- sessions/memory/scripts: retained until manually cleaned

## Model Switch

Use Telegram `/model <name>` or edit `defaultModel` in config.

When changing model, verify:

- profile exists in `models`
- API key/env is valid
- model supports required tool-calling behavior

## Script and Coding Safety

- keep `scriptExecutor.allowedCommands` and `codingTools.allowedCommands` minimal in production
- disable tools when not needed (`scriptExecutor.enabled=false`, `codingTools.enabled=false`)
- review run artifacts under `workspace/scripts/runs`
