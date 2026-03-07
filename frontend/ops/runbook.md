# Operations Runbook

This runbook focuses on day-to-day operation of the current runtime.

## Daily Start

1. Ensure Android emulator dependencies are available.
2. Verify config and environment variables for the target agent.
3. Run onboarding if first launch.
4. Start emulator and verify booted device if the agent uses emulator.
5. Start gateway or run tasks from CLI.
6. Validate human-auth readiness if remote approvals are enabled.

Commands for the default agent:

```bash
openpocket config-show
openpocket onboard
openpocket emulator status
openpocket emulator start
openpocket gateway start
```

Commands for a managed agent:

```bash
openpocket --agent review-bot config-show
openpocket --agent review-bot target show
openpocket --agent review-bot gateway start
```

If launcher is not in PATH yet, use `node dist/cli.js <command>`.

## Multi-Agent Operational Pattern

Create and inspect agents:

```bash
openpocket create agent review-bot --type physical-phone --device R5CX123456A
openpocket create agent ops-bot --type emulator
openpocket agents list
openpocket agents show review-bot
```

Recommended long-running control surfaces:

```bash
openpocket dashboard manager
openpocket human-auth-relay start
```

This gives you:

- one install-level dashboard for all agents
- one shared relay hub / optional ngrok tunnel for all managed agents
- one per-agent gateway process per running agent

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
openpocket channels whoami --channel telegram
openpocket test permission-app cases
openpocket test permission-app run --case camera --chat <channel_chat_id>
```

Or for a managed agent:

```bash
openpocket --agent review-bot test permission-app run --case camera --chat <channel_chat_id>
```

Expected outcome:

1. PermissionLab deploys and launches.
2. Agent taps scenario button in emulator or device.
3. If scenario requires remote authorization, the configured channel receives a human-auth request with link.
4. Phone approval/rejection resolves request.
5. Agent resumes and reports final result.

Notes:

- in-emulator Android runtime permission dialogs are auto-handled locally (no remote auth required for those dialogs)
- if you need one public relay URL across many agents, start `openpocket human-auth-relay start` before these tests

## Monitoring

Per running agent, monitor:

- gateway logs for accepted task, progress narration decisions, and final status
- heartbeat logs in `state/heartbeat.log`
- cron execution state in `state/cron-state.json`
- task traces in `workspace/sessions/session-*.md`
- daily memory lines in `workspace/memory/YYYY-MM-DD.md`
- relay requests in `state/human-auth-relay/requests.json`
- uploaded auth artifacts in `state/human-auth-artifacts/`

Install-level monitoring:

- `openpocket agents list`
- `openpocket dashboard manager`
- `manager/registry.json`
- `manager/ports.json`
- `manager/locks/targets/*.json`

Log tuning:

- use `gatewayLogging.level` to set baseline verbosity (`error|warn|info|debug`)
- disable noisy domains with `gatewayLogging.modules.*` (for example `heartbeat=false`, `chat=false`)
- keep `gatewayLogging.includePayloads=false` in production to avoid task/input payload leakage

## Safe Stop

- use `/stop` in channel chat to request cancellation for the current agent task
- runtime checks stop flag between steps and finalizes session as failed with stop reason
- for blocked auth requests, use `/auth pending` then `/auth approve|reject`
- stop per-agent gateways individually; deleting an agent requires that agent gateway to be stopped first

## Debug Evidence Collection

When a run fails, collect artifacts from the relevant agent only:

- gateway lines containing `[OpenPocket][gateway]` and `[OpenPocket][human-auth]`
- latest session under that agent `workspace/sessions/`
- relay state file `state/human-auth-relay/requests.json`
- artifact listing under `state/human-auth-artifacts/`
- `/context json` output when prompt diagnosis is needed

When the install-level manager layer fails, also collect:

- `manager/registry.json`
- `manager/ports.json`
- output from `openpocket agents list`
- output from `openpocket dashboard manager`

## Data Retention

Per agent:

- screenshots: bounded by `screenshots.maxCount`
- sessions/memory/scripts: retained until manually cleaned

Install-level:

- manager registry, ports, and target locks remain until explicitly changed or cleaned

## Model Switch

Use `/model <name>` in the selected chat or edit the selected agent's `defaultModel` in config.

CLI examples:

```bash
openpocket model set --name gpt-5.4
openpocket --agent review-bot model set --provider google --model gemini-3.1-pro-preview
```

When changing model, verify:

- profile exists in `models`
- API key/env is valid
- model supports required tool-calling behavior

## Script and Coding Safety

- keep `scriptExecutor.allowedCommands` and `codingTools.allowedCommands` minimal in production
- disable tools when not needed (`scriptExecutor.enabled=false`, `codingTools.enabled=false`)
- review run artifacts under `workspace/scripts/runs`
- remember that each agent has its own workspace, so safety policies and generated scripts are isolated per agent
