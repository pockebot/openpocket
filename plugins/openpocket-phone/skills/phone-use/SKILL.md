---
name: phone-use
description: Use OpenPocket MCP tools to control Android emulator or physical-phone targets from Codex. Trigger for phone use, Android automation, ADB-backed app testing, emulator control, physical Android device control, mobile UI tasks, and requests that should not use desktop Computer Use.
---

# Phone Use With OpenPocket

Use this skill when the user wants Codex to inspect or control an Android emulator, Android phone, Android TV target, or ADB-backed mobile app through OpenPocket.

## Core Rule

Use the OpenPocket MCP server first. Do not use desktop Computer Use for Android phone control unless the OpenPocket MCP server is unavailable and the user explicitly accepts a visual desktop fallback.

OpenPocket is Android-first. It does not provide iOS Simulator or iPhone control in this MCP surface yet.

## Preconditions

Before controlling a target:

1. Confirm the task is scoped to a device the user owns or is authorized to test.
2. Use `target_status` to inspect configured target type and online ADB devices.
3. If the target is an emulator and no booted emulator is online, use `start_emulator` or ask the user before starting it when the task might disturb local resources.
4. If the target is a physical phone, require USB debugging or Wi-Fi ADB to be authorized. Do not try to bypass device trust prompts, lock screens, account prompts, or OS security settings.
5. If multiple devices are online, ask the user which serial to use unless the task names a device.

## Interaction Loop

1. Capture state with `screenshot`.
2. Read the metadata returned with the screenshot:
   - `currentApp`
   - `deviceId`
   - `uiElements`
   - `secureSurfaceDetected`
   - screen dimensions and scale values
3. Prefer `tap_element` when a matching UI element ID exists. Use raw `tap` only when no reliable element is exposed.
4. Use `type_text` only after the intended input field is focused.
5. Use `key_event` for BACK, HOME, ENTER, SEARCH, and similar Android key actions.
6. Use `swipe` for scrolling or gesture movement.
7. Use `launch_app` when the target package is known.
8. Use `adb_shell` only for Android inspection or deterministic device setup. Avoid broad or destructive shell commands.
9. After each action, use `wait` briefly when the UI needs time to settle, then capture a fresh `screenshot`.
10. Stop when the user goal is met, when the device state is ambiguous, or when a sensitive checkpoint appears.

## Sensitive Boundaries

Pause and ask the user for explicit confirmation before:

- submitting payments or purchases
- sending messages, posts, likes, follows, or irreversible social actions
- changing account, security, privacy, or payment settings
- entering passwords, OTPs, 2FA codes, recovery codes, card details, government IDs, or private health/finance data
- using camera, microphone, photos, contacts, files, location, biometric, NFC, or SMS capabilities

If OpenPocket Human Auth is configured and the user asks for an approval-driven flow, prefer the OpenPocket human-auth path. Otherwise ask the user to provide the needed data or approve the action in chat.

## Target Setup Helpers

For emulator targets, the user or Codex can run:

```bash
npm run build
openpocket target set --type emulator
openpocket emulator start
```

For physical Android phones, the user must authorize ADB on the device first:

```bash
adb devices -l
openpocket target set --type physical-phone --device <serial>
```

For Wi-Fi ADB pairing:

```bash
openpocket target pair --host <device-ip> --pair-port <pair-port> --code <pairing-code> --type physical-phone
```

## Recovery

If the MCP server is missing or disconnected:

1. Build OpenPocket: `npm install && npm run build`.
2. Verify the MCP server manually: `node dist/mcp/server.js`.
3. In Codex, check the MCP status for `openpocket-phone`.
4. If the plugin was just installed or updated, start a new Codex thread.

If `tap_element` fails because the element disappeared, capture a fresh `screenshot` and pick a new element ID.

If screenshots are black or incomplete, rely on `uiElements`, `secureSurfaceDetected`, and recent history. Do not infer sensitive screen contents from a black secure surface.
