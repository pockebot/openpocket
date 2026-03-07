# Filesystem Layout

OpenPocket runtime uses `OPENPOCKET_HOME` (default `~/.openpocket`).
Android emulator (AVD) data is stored outside `OPENPOCKET_HOME` by Android SDK tooling.

In multi-agent mode, one install contains one default agent plus zero or more managed agents.

## Runtime Tree

```text
~/.openpocket/
  config.json                     # default agent config
  workspace/                      # default agent workspace
  state/                          # default agent state
    runtime/
      gateway.lock.json
    emulator.log
    heartbeat.log
    cron-state.json
    control-panel.json
    onboarding.json
    telegram-bot-name-sync.json
    human-auth-relay/
      requests.json
    human-auth-artifacts/
      auth-*.png|jpg|json|bin
    screenshots/
      *.png

  manager/
    registry.json
    model-template.json
    ports.json
    locks/
      targets/
        <sha1>.json

  agents/
    <agentId>/
      config.json
      workspace/
      state/
        runtime/
          gateway.lock.json
        screenshots/
        human-auth-relay/
          requests.json
        human-auth-artifacts/
          auth-*.png|jpg|json|bin
```

## Agent Storage Model

### Default agent

The onboarded root agent keeps the original layout:

- `OPENPOCKET_HOME/config.json`
- `OPENPOCKET_HOME/workspace/`
- `OPENPOCKET_HOME/state/`

### Managed agents

Each managed agent gets:

- `OPENPOCKET_HOME/agents/<agentId>/config.json`
- `OPENPOCKET_HOME/agents/<agentId>/workspace/`
- `OPENPOCKET_HOME/agents/<agentId>/state/`

These directories are fully isolated from other agents.

## Manager Persistence Map

### `manager/registry.json`

Tracks registered agents and their durable metadata:

- agent id
- config/workspace/state paths
- dashboard port
- target fingerprint
- creation/update timestamps

The `default` agent record is always preserved.

### `manager/model-template.json`

Stores the initial model template captured during onboarding.

`create agent` uses this file to seed:

- `defaultModel`
- `models`

After creation, agent model configs diverge independently.

### `manager/ports.json`

Tracks manager-level ports:

- manager dashboard port
- shared relay hub port

### `manager/locks/targets/*.json`

Global target runtime locks.

These prevent two running gateways from using the same target at the same time.

## Agent Persistence Map

The sections below apply to the currently selected agent, whether it is the default agent or a managed agent.

### `config.json`

Main runtime configuration for one agent instance:

- model profiles
- gateway settings
- target type and target binding
- channel config
- dashboard config

### `state/`

Per-agent operational state:

- `runtime/gateway.lock.json`: active gateway lock and dashboard address for this agent
- `emulator.log`: emulator launch and runtime logs from this agent
- `heartbeat.log`: heartbeat service output and stuck-task warnings
- `onboarding.json`: onboarding progress and completion metadata for the selected agent workspace
- `control-panel.json`: dashboard/panel settings
- `telegram-bot-name-sync.json`: bot display-name sync state
- `screenshots/*.png`: local screenshot artifacts with retention by `screenshots.maxCount`
- `human-auth-relay/requests.json`: pending and completed human-auth requests for this agent
- `human-auth-artifacts/*`: uploaded approval artifacts used by this agent's human-auth flows

### `workspace/`

Per-agent persistent context and history:

- `sessions/session-*.md`: full per-task trace (thought/action/result/final status)
- `memory/YYYY-MM-DD.md`: daily compact memory append log
- `MEMORY.md`: long-lived memory file searched by memory tools
- `skills/`:
  - manual skills (`*.md`)
  - generated reusable skills (`auto/*.md` or strict `auto/<slug>/SKILL.md`)
- `scripts/`:
  - generated replay scripts (`auto/*.sh`)
  - execution artifacts (`runs/run-*/script.sh|stdout.log|stderr.log|result.json`)
- `.openpocket/workspace-state.json`: workspace bootstrap and onboarding completion marker
- bootstrap/profile files (`BOOTSTRAP.md`, `PROFILE_ONBOARDING.json`, `IDENTITY.md`, `USER.md`, etc.) remain local to that agent and are reused across sessions

## Default Workspace Bootstrap Tree

```text
workspace/
  AGENTS.md
  BOOTSTRAP.md
  SOUL.md
  USER.md
  IDENTITY.md
  TOOLS.md
  HEARTBEAT.md
  MEMORY.md
  PROFILE_ONBOARDING.json
  TASK_PROGRESS_REPORTER.md
  TASK_OUTCOME_REPORTER.md
  BARE_SESSION_RESET_PROMPT.md
  .openpocket/
    workspace-state.json
    bootstrap-context-hook.md (optional)
  memory/
    README.md
    YYYY-MM-DD.md
  sessions/
    session-*.md
  skills/
    README.md
    *.md
    auto/
  scripts/
    README.md
    auto/
    runs/
  cron/
    README.md
    jobs.json
```

## Human Auth Storage in Multi-Agent Mode

Even when you run a shared relay hub with `openpocket human-auth-relay start`:

- request state is still written inside each agent's own `state/human-auth-relay/requests.json`
- uploaded artifacts are still written inside each agent's own `state/human-auth-artifacts/`
- the shared hub only proxies requests and allocates one public URL entry point

## Android Emulator Persistence (AVD)

This section explains where the virtual Android phone data lives and why it survives process restarts.

### Where emulator data is stored

OpenPocket references one AVD by name (`config.json -> emulator.avdName`) and starts emulator with:

- `emulator -avd <avdName> ...`

By default on macOS, Android stores AVD files in:

```text
~/.android/avd/
  <avdName>.ini                # pointer file
  <avdDir>.avd/                # persistent device data directory
```

The `<avdName>.ini` file points to the real data directory via `path=...`.

System image files are separate, under Android SDK root:

```text
<ANDROID_SDK_ROOT>/system-images/android-<api>/<tag>/<abi>/
  system.img
  vendor.img
  ramdisk.img
  ...
```

### Persistence mechanism

Persistence is provided by Android Emulator disk images, not by a custom OpenPocket VM layer.

- OpenPocket reuses the same `emulator.avdName`
- it does not run `-wipe-data`
- restarting gateway/dashboard/agent re-attaches to the same AVD disk files
- therefore installed apps, logged-in accounts, and app data remain unless AVD data is deleted/reset

In multi-agent installs, emulator-backed agents must not share the same target fingerprint. Use different AVD names if you want multiple emulator agents.

### Delete or reset the virtual phone

Delete full device data (recommended clean removal):

```bash
openpocket emulator stop
avdmanager delete avd -n <avdName>
```

Equivalent manual deletion:

```bash
rm -f ~/.android/avd/<avdName>.ini
rm -rf ~/.android/avd/<avdDir>.avd
```

Optional: reclaim system image space too:

```bash
sdkmanager --uninstall "system-images;android-<api>;<tag>;<abi>"
```

Deleting AVD data removes app/account/userdata persistence for that virtual phone.

## Repo Layout

```text
src/
  agent/        # prompts, tools schema, model client, runtime loop
  config/       # default config, load/save/normalize, Codex credential fallback
  device/       # emulator and adb runtime
  gateway/      # gateway runtime, onboarding/chat assistant, heartbeat, cron, run-loop
  human-auth/   # relay bridge, web relay server, local stack, ngrok tunnel
  manager/      # agent registry, target locks, ports, manager dashboard, relay hub
  memory/       # workspace bootstrap, templates, session, screenshot storage
  onboarding/   # interactive CLI setup wizard
  skills/       # skill loader and auto artifact builder
  tools/        # script executor, coding executor, memory executor, apply_patch
  dashboard/    # agent dashboard web control API server
  test/         # permission lab runner
  utils/        # paths, image scaling, time, CLI theme
  cli.ts        # command entrypoint
```

## Skill Sources

At runtime, skills are loaded in this priority order for the selected agent:

1. `<repo>/skills`
2. `OPENPOCKET_HOME/skills`
3. `workspace/skills`
