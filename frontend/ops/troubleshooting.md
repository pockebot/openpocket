# Troubleshooting

## `adb not found`

- install Android platform-tools
- set `ANDROID_SDK_ROOT`
- verify `adb` in `PATH`

## `Android emulator binary not found`

- install Android Emulator via SDK manager
- configure `emulator.androidSdkRoot` or `ANDROID_SDK_ROOT`

## `No AVD found`

- run `node dist/cli.js emulator list-avds`
- create an AVD if list is empty
- set `emulator.avdName` to a valid entry

## `Missing API key for model`

- set `models.<profile>.apiKey` or matching env var (`apiKeyEnv`)
- verify current `defaultModel` profile

## Task keeps failing with invalid model output

- inspect session file for raw thought/action progression
- verify model supports requested endpoint and multimodal input
- switch model profile and retry

## Telegram bot does not respond

- validate token (`telegram.botToken` or env)
- check allowed chat IDs (`telegram.allowedChatIds`)
- ensure gateway process is running

## Human-auth link is missing in Telegram

- ensure `humanAuth.enabled=true`
- ensure gateway started with `humanAuth.useLocalRelay=true`
- check gateway logs for local relay startup failure (`[gateway-core][humanAuth]` / `[human-auth]`)
- use `/auth pending` to verify request creation even when web link fallback is unavailable
- if running PermissionLab E2E, use `openpocket test permission-app run --chat <id>` so gateway sends auth link automatically

## ngrok tunnel does not come up

- verify `humanAuth.tunnel.provider=ngrok` and `humanAuth.tunnel.ngrok.enabled=true`
- verify `NGROK_AUTHTOKEN` (or `humanAuth.tunnel.ngrok.authtoken`) is set
- confirm `ngrok` executable exists in PATH or set `humanAuth.tunnel.ngrok.executable`
- inspect gateway logs for `[human-auth][ngrok]` startup errors
- if error contains `ERR_NGROK_108`, terminate other ngrok agent sessions and retry

## Human-auth request always times out

- check phone can reach `humanAuth.publicBaseUrl`
- if LAN mode, verify host/port reachability from phone network
- if ngrok mode, verify tunnel URL is active and not blocked
- increase `humanAuth.requestTimeoutSec` when approvals need more time
- check relay state file for pending/expired records: `state/human-auth-relay/requests.json`

## Web page camera says permission denied after Allow

- Telegram in-app browser may block camera access on some devices/versions
- use `Capture/Upload Photo` button as fallback
- or approve/reject without image when the flow does not require camera artifact

## Delegated artifact was approved but flow did not resume correctly

- inspect session file for `delegation_result=...` and `delegation_template=...`
- ensure app UI has an active focused input field for text delegation
- for image delegation, confirm app picker can access `/sdcard/Download`
- rerun with a deterministic case (`camera`, `location`, `sms`) before app-specific flows

## Scripts blocked unexpectedly

- inspect `result.json` and `stderr.log` in run directory
- confirm command is in `scriptExecutor.allowedCommands`
- check deny patterns (for example `sudo`, `shutdown`, `rm -rf /`)

## Gateway logs are too noisy (or too quiet)

- set `gatewayLogging.level` to `warn` (quiet) or `debug` (verbose)
- tune module switches under `gatewayLogging.modules` (for example disable `heartbeat` and `chat` in production)
- if payload fields appear hidden but you need them temporarily, set `gatewayLogging.includePayloads=true` and keep `maxPayloadChars` small
