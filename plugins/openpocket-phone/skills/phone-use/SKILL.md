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
5. If multiple target devices are online, pass an explicit `deviceId` for every inspection/action. If the user has not chosen one, ask which serial to use.

## Interaction Loop

1. Capture cheap state first with `ui_snapshot`, `visible_text`, or `current_app`.
2. Use `open_app` when the app label is known but the package is not. Use `launch_app` only when the exact package name is known.
3. Use `find_text` to locate screen controls and data. Use `tap_text` when the next action is clearly tied to visible text.
4. Use `wait_for_text` after app launch, navigation, search, or scrolling instead of repeatedly polling screenshots by hand.
5. Use `screenshot` when visual layout, images, game/canvas surfaces, or low-confidence text extraction matter.
6. Read the metadata returned by `screenshot` or `ui_snapshot`:
   - `currentApp`
   - `deviceId`
   - `uiElements`
   - `visibleTextLines`
   - `secureSurfaceDetected`
   - `captureMetrics`
   - screen dimensions and scale values
7. Prefer `tap_text`, then `tap_element`, then raw `tap` in that order. Raw coordinates are last resort.
8. Use `type_text` only after the intended input field is focused.
9. Use `key_event` for BACK, HOME, ENTER, SEARCH, and similar Android key actions.
10. Use `swipe`, `drag`, and `long_press_drag` for scrolling or gesture movement.
11. Use `adb_shell` only for Android inspection or deterministic device setup. Avoid broad or destructive shell commands.
12. Stop when the user goal is met, when the device state is ambiguous, or when a sensitive checkpoint appears.

## Tool Selection

- `target_status`: confirm target type, online devices, booted devices, and ambiguity.
- `ui_snapshot`: default read-only state capture; returns UI elements and visible text without images.
- `visible_text`: quick text extraction for scanning current screen contents.
- `find_text`: locate elements by `text`, `contentDesc`, `resourceId`, or `className`.
- `tap_text`: tap by text/resource match; prefer for buttons, tabs, menus, and labeled controls.
- `wait_for_text`: wait for a screen state to appear after navigation or search.
- `screenshot`: use when visual evidence or element overlays are needed.
- `open_app`: open by launcher label or package; use when the package name is uncertain.
- `list_apps`: discover installed launchable app labels and package names.
- `adb_shell`: use sparingly for Android-level inspection.

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
2. Verify the plugin wrapper and MCP tool surface: `node plugins/openpocket-phone/scripts/doctor.mjs`.
3. In Codex, check the MCP status for `openpocket-phone`.
4. If the plugin was just installed or updated, start a new Codex thread. Existing desktop threads may not pick up newly installed local MCP tools.

If `tap_element` fails because the element disappeared, capture a fresh `screenshot` and pick a new element ID.

If screenshots are black or incomplete, rely on `uiElements`, `secureSurfaceDetected`, and recent history. Do not infer sensitive screen contents from a black secure surface.
