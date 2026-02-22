# Filesystem Layout

OpenPocket runtime uses `OPENPOCKET_HOME` (default `~/.openpocket`).
Android emulator (AVD) data is stored outside `OPENPOCKET_HOME` by Android SDK tooling.

## Runtime Tree

```text
~/.openpocket/
  config.json
  state/
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
        *.md
    scripts/
      README.md
      auto/
        *.sh
      runs/
        run-*/
          script.sh
          stdout.log
          stderr.log
          result.json
    cron/
      README.md
      jobs.json
```

## OpenPocket Persistence Map

This section explains what is persisted by OpenPocket itself under `OPENPOCKET_HOME`.

### `config.json`

- Main runtime configuration (model profiles, gateway settings, emulator target AVD name).
- `emulator.avdName` selects which AVD OpenPocket attaches to.

### `state/`

- `emulator.log`: emulator launch and runtime logs from this project.
- `heartbeat.log`: heartbeat service output and stuck-task warnings.
- `onboarding.json`: onboarding progress and completion metadata.
- `control-panel.json`: dashboard/panel settings (permissions, prompt file list).
- `telegram-bot-name-sync.json`: bot display-name sync state.
- `screenshots/*.png`: local screenshot artifacts with retention by `screenshots.maxCount`.
- `human-auth-relay/requests.json`: pending and completed human-auth requests.
- `human-auth-artifacts/*`: uploaded approval artifacts (image/json/bin) used by human-auth flows.

### `workspace/`

- `sessions/session-*.md`: full per-task trace (thought/action/result/final status).
- `memory/YYYY-MM-DD.md`: daily compact memory append log.
- `MEMORY.md`: long-lived memory file searched by memory tools.
- `skills/`:
  - manual skills (`*.md`)
  - generated reusable skills (`auto/*.md`)
- `scripts/`:
  - generated replay scripts (`auto/*.sh`)
  - execution artifacts (`runs/run-*/script.sh|stdout.log|stderr.log|result.json`)
- `.openpocket/workspace-state.json`: workspace bootstrap and onboarding completion marker.
- bootstrap/profile files (`BOOTSTRAP.md`, `PROFILE_ONBOARDING.json`, `IDENTITY.md`, `USER.md`, etc.) remain local and are reused across sessions.

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

### What files mean inside `<avdDir>.avd/`

- `config.ini`: device definition (`AvdId`, screen, RAM, image path, Play Store tag).
- `userdata-qemu.img.qcow2`: writable app/user/account data partition (most important persistence file).
- `sdcard.img`: virtual SD card content.
- `cache.img(.qcow2)`: cache partition.
- `snapshots/default_boot/*`: quick-boot snapshot state (`ram.bin`, textures, metadata).

### Persistence mechanism

Persistence is provided by Android Emulator disk images, not by a custom OpenPocket VM layer.

- OpenPocket reuses the same `emulator.avdName`.
- It does not run `-wipe-data`.
- Restarting gateway/dashboard/agent re-attaches to the same AVD disk files.
- Therefore installed apps, logged-in accounts, and app data remain unless AVD data is deleted/reset.

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
  gateway/      # telegram gateway, onboarding/chat assistant, heartbeat, cron, run-loop
  human-auth/   # relay bridge, web relay server, local stack, ngrok tunnel
  memory/       # workspace bootstrap, templates, session, screenshot storage
  onboarding/   # interactive CLI setup wizard
  skills/       # skill loader and auto artifact builder
  tools/        # script executor, coding executor, memory executor, apply_patch
  dashboard/    # web control API server
  test/         # permission lab runner
  utils/        # paths, image scaling, time, CLI theme
  cli.ts        # command entrypoint
```

## Skill Sources

At runtime, skills are loaded in this priority order:

1. `workspace/skills`
2. `OPENPOCKET_HOME/skills`
3. `<repo>/skills`
