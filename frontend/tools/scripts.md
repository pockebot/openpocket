# Scripts

OpenPocket supports controlled script execution through `run_script` action and CLI command.

In multi-agent installs, all `workspace/` paths on this page refer to the **selected agent workspace**.

## Entry Points

- agent action: `{"type":"run_script","script":"...","timeoutSec":60}`
- CLI: `openpocket script run --text "..."` or `--file <path>`

## Validation

`ScriptExecutor.validateScript` checks:

1. executor enabled (`scriptExecutor.enabled`)
2. non-empty script
3. max length <= 12000 chars
4. deny pattern match
5. command allowlist compliance

If validation fails, script is not executed and a failed `result.json` is still recorded.

## Deny Patterns

Built-in blocked patterns include:

- `sudo`
- shutdown/reboot/poweroff/halt
- `mkfs`
- `dd if=`
- `rm -rf /`

## Allowlist Check

- script is split by line
- line comments are stripped
- each line is split by command separators (`&&`, `||`, `;`)
- first command token (after optional env assignments) must be in `allowedCommands`

Default allowlist is documented in [Config Defaults](../reference/config-defaults.md).

## Execution Model

- runtime shell: `bash`
- working directory: `workspace/scripts`
- timeout: `scriptExecutor.timeoutSec` or action override
- output truncation: `scriptExecutor.maxOutputChars`

Each run stores artifacts under:

- `workspace/scripts/runs/run-<runId>/script.sh`
- `workspace/scripts/runs/run-<runId>/stdout.log`
- `workspace/scripts/runs/run-<runId>/stderr.log`
- `workspace/scripts/runs/run-<runId>/result.json`

## Result

See full schema in [Session and Memory Formats](../reference/session-memory-formats.md).

## Generated Scripts

After successful tasks, `AutoArtifactBuilder` may create replay scripts at:

- `workspace/scripts/auto/<timestamp>-<slug>.sh`

Generated scripts convert observed action traces into executable adb commands.

Generation behavior:

- emits only deterministic, replay-friendly action types (`tap`, `swipe`, `type`, `keyevent`, `launch_app`, `wait`, `shell`, `run_script`)
- supports non-ASCII text replay via clipboard fallback when needed
- accepts optional target device as first argument (`./script.sh <device-id>`)
- paired with auto skills through behavior fingerprint deduplication (older equivalent artifacts are pruned)
