# Filesystem Layout

OpenPocket runtime uses `OPENPOCKET_HOME` (default `~/.openpocket`).

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
