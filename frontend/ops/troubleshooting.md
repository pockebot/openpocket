# Troubleshooting

## `Unknown agent: <id>`

- run `openpocket agents list` to confirm the agent id
- remember that omitting `--agent` selects `default`
- if you moved config files manually, inspect `manager/registry.json`

## `Target '<fingerprint>' is already bound to agent '<id>'`

- another agent already owns that target binding
- run `openpocket agents list` to identify the owner
- either switch the other agent away from that target or choose a different target/AVD/device for the current agent

## `Target '<fingerprint>' is already in use by agent '<id>' (pid ...)`

- another gateway process is actively holding the runtime target lock
- stop the other agent gateway before starting this one
- if the process crashed, retry after the stale lock is cleaned by PID liveness check

## `Gateway is running for agent '<id>' ... Stop it before switching deployment target`

- `target set` and `target pair` require the selected agent gateway to be stopped first
- stop only that agent's gateway; other agents can continue running on their own targets

## `adb not found`

- install Android platform-tools
- set `ANDROID_SDK_ROOT`
- verify `adb` in `PATH`

## `Android emulator binary not found`

- install Android Emulator via SDK manager
- configure `emulator.androidSdkRoot` or `ANDROID_SDK_ROOT`

## `No AVD found`

- run `openpocket emulator list-avds`
- create an AVD if list is empty
- set `emulator.avdName` to a valid entry
- if you run multiple emulator agents, use different AVD names

## `Missing API key for model`

- set `models.<profile>.apiKey` or matching env var (`apiKeyEnv`)
- verify current `defaultModel` profile for the selected agent
- remember that agent model configs diverge after `create agent`

## Task keeps failing with invalid model output

- inspect the selected agent session file for raw thought/action progression
- verify model supports requested endpoint and multimodal input
- switch model profile and retry

## Channel bot does not respond

- validate token for the selected agent (`channels.<type>.*` or env)
- ensure the selected agent gateway process is running
- verify allowlist / mention policy for the specific channel
- if multiple agents share one group, ensure they are not all configured to answer every message

## Manager dashboard does not show an agent

- verify the agent exists in `openpocket agents list`
- inspect `manager/registry.json`
- ensure the agent was created through `openpocket create agent` or updated through manager-aware commands

## Human-auth link is missing in channel reply

- ensure `humanAuth.enabled=true`
- ensure the agent gateway started with `humanAuth.useLocalRelay=true`
- check gateway logs for local relay startup failure (`[human-auth]`)
- use `/auth pending` to verify request creation even when the web link is unavailable
- if running PermissionLab E2E, use `openpocket test permission-app run --chat <id>` so gateway sends auth link automatically

## Shared relay hub / ngrok URL does not come up

- run `openpocket human-auth-relay start`
- verify `humanAuth.tunnel.provider=ngrok` and `humanAuth.tunnel.ngrok.enabled=true` in the selected config used to launch the hub
- verify `NGROK_AUTHTOKEN` (or `humanAuth.tunnel.ngrok.authtoken`) is set
- confirm `ngrok` executable exists in PATH or set `humanAuth.tunnel.ngrok.executable`
- inspect hub logs for `[OpenPocket][relay-hub]` and `[human-auth][ngrok]` startup errors
- if error contains `ERR_NGROK_108`, terminate other ngrok agent sessions and retry

## Managed agent falls back to direct local relay unexpectedly

- this means the private per-agent relay started, but registration to the shared relay hub failed
- verify `openpocket human-auth-relay start` is still running
- inspect the gateway logs for `relay hub unavailable for agent=...; using direct local relay`
- verify the port in `manager/ports.json` matches the running hub

## Human-auth request always times out

- check phone can reach `humanAuth.publicBaseUrl` or the relay hub public URL
- if LAN mode, verify host/port reachability from phone network
- if ngrok mode, verify tunnel URL is active and not blocked
- increase `humanAuth.requestTimeoutSec` when approvals need more time
- check the selected agent relay state file for pending/expired records: `state/human-auth-relay/requests.json`

## Web page camera says permission denied after Allow

- some in-app browsers may block camera access
- use upload fallback instead
- or approve/reject without image when the flow does not require a camera artifact

## Delegated artifact was approved but flow did not resume correctly

- inspect the selected agent session file for `delegation_result=...` and `delegation_template=...`
- ensure app UI has an active focused input field for text delegation
- for image delegation, confirm app picker can access `/sdcard/Download`
- rerun with a deterministic case (`camera`, `location`, `sms`) before app-specific flows

## `Invalid manager registry JSON ...` / `Invalid manager ports JSON ...`

- a manager metadata file is corrupted
- OpenPocket will now fail explicitly instead of silently resetting it
- restore the file from backup or fix the JSON manually
- do not delete `manager/registry.json` casually if you want to preserve managed-agent metadata

## Scripts blocked unexpectedly

- inspect `result.json` and `stderr.log` in the selected agent run directory
- confirm command is in `scriptExecutor.allowedCommands`
- check deny patterns (for example `sudo`, `shutdown`, `rm -rf /`)

## Gateway logs are too noisy (or too quiet)

- set `gatewayLogging.level` to `warn` (quiet) or `debug` (verbose)
- tune module switches under `gatewayLogging.modules`
- if payload fields appear hidden but you need them temporarily, set `gatewayLogging.includePayloads=true` and keep `maxPayloadChars` small
