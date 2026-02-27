---
name: "Human Auth Delegation Overview"
description: "Overview of how Human Phone authorization and delegation artifacts work. For specific capability handling, see the individual human-auth-* skills."
metadata: {"openclaw":{"triggers":{"any":["human_auth","delegation","artifact","authorize"]}}}
---

# Human Auth Delegation Overview

When a task requires real-world data or sensitive authorization, you call `request_human_auth`. The human on their phone approves and may return a **delegation artifact** — a file containing the data you need.

## How It Works

1. You call `request_human_auth(capability, instruction, ...)`.
2. The human sees an authorization page on their phone.
3. They approve/reject and optionally attach data (photo, audio, coordinates, code, credentials, etc.).
4. You receive a result with `artifact_path` and `artifact_summary`.
5. **You decide what to do next** based on the artifact and current screen state.

## Artifact Result Format

After `request_human_auth` returns, the tool result contains:
- `status`: approved / rejected / timeout
- `artifact_path`: local file path to the saved artifact
- `artifact_summary`: structured key-value description (kind, size, fields, etc.)

## What to Do With the Artifact

Each capability has its own skill with detailed handling instructions:

| Capability | Skill | Typical Artifact |
|-----------|-------|-----------------|
| camera | human-auth-camera | Photo file (JPEG/PNG) |
| photos | human-auth-photos | Photo file(s) |
| microphone | human-auth-microphone | Audio file (WebM/OGG) |
| location | human-auth-location | JSON with lat/lon |
| oauth | human-auth-oauth | JSON with credentials |
| payment | human-auth-payment | JSON with card fields |
| sms, 2fa | human-auth-sms-2fa | JSON with code text |
| qr | human-auth-qr | JSON with scanned text |
| nfc | human-auth-nfc | JSON/binary NFC data |
| biometric | human-auth-biometric | Approval signal |
| contacts, calendar, files | human-auth-contacts-data | JSON/file data |

Use `read(<skill_location>)` to load the relevant skill for detailed instructions.

## Key Principles

1. **You decide.** The runtime only saves the artifact. You choose how to apply it.
2. **Redo the flow.** The app's UI may have changed while waiting for human auth. After receiving the artifact, you typically need to:
   - Press Back (`keyevent KEYCODE_BACK`) to exit the current screen (camera preview, file picker, etc.)
   - Push/prepare the data (adb push, type_text, geo fix, etc.)
   - Re-navigate to the point where the data is needed (re-open picker, re-focus input field)
   - Complete the action (select file, tap submit, etc.)
3. **Read the artifact first.** For JSON artifacts (credentials, codes, coordinates), call `read(<artifact_path>)` to get the actual values. OTP values are not in the session log.
4. **Clean up sensitive data.** Delete credential/payment artifacts after use: `exec("rm <path>")`.
5. **File artifacts are auto-pushed.** When you receive a file artifact (image, audio, etc.), the runtime automatically pushes it to `/sdcard/Download/` on Agent Phone and runs media scan. The result includes `device_path=/sdcard/Download/openpocket-human-auth-<ts>.<ext>` — this is the path you use in file pickers. You do NOT need to manually `adb push`.
