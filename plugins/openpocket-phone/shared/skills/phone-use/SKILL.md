---
name: phone-use
description: Use OpenPocket MCP tools to inspect or control an Android emulator, physical Android phone, Android TV, or ADB-backed app. Trigger for phone use, Android automation, mobile UI testing, emulator control, physical-device control, app navigation, screenshots, tapping, typing, and requests that should not use desktop computer-use automation.
---

# Phone Use With OpenPocket

Use the plugin-provided `openpocket-phone` MCP server for Android work. Do not use desktop computer-use automation to operate an emulator window unless the MCP server is unavailable and the user explicitly accepts that fallback.

OpenPocket is Android-first. This plugin does not control iOS Simulator or iPhone targets.

## Start Every Task

1. Confirm the target belongs to the user or is authorized for testing.
2. Call `target_status` before taking any action.
3. If the configured target is an emulator and no booted emulator is online, call `start_emulator` when starting it will not disrupt other local work.
4. If multiple devices are online, ask which serial to use and pass that `deviceId` to every subsequent tool.
5. Never bypass Android trust prompts, lock screens, account prompts, or OS security controls.

## Interaction Loop

1. Read state with `ui_snapshot`, `visible_text`, or `current_app`.
2. Open apps with `open_app` when only the label is known, or `launch_app` when the package name is exact.
3. Locate controls with `find_text` and prefer `tap_text` or `tap_element` over raw coordinates.
4. After navigation, launch, search, or scrolling, use `wait_for_text` instead of repeatedly polling screenshots.
5. Use `screenshot` when visual layout, imagery, canvas content, or uncertain text extraction matters.
6. Read the metadata returned by `screenshot` or `ui_snapshot`, including `currentApp`, `deviceId`, `uiElements`, `visibleTextLines`, `secureSurfaceDetected`, capture metrics, and screen dimensions.
7. Use `type_text` only after the intended input field is focused.
8. Use `key_event` for BACK, HOME, ENTER, SEARCH, and similar Android keys.
9. Use `swipe`, `drag`, and `long_press_drag` for gestures.
10. Use `adb_shell` only for narrow Android inspection or deterministic setup. Avoid broad or destructive commands.
11. Re-read the screen after every state-changing action and stop when the user goal is complete or the state becomes ambiguous.

## Tool Guide

- `target_status`: configured target type, online devices, booted devices, and resolved device.
- `ui_snapshot`: default text-only UI state with element metadata.
- `visible_text`: lightweight visible and accessibility text extraction.
- `find_text`: locate elements by text, content description, resource ID, or class.
- `tap_text`: tap a labeled control without coordinates.
- `wait_for_text`: wait for a known screen state.
- `screenshot`: visual evidence plus current app, text, elements, and capture metadata.
- `open_app`: discover and open an app by label or package.
- `list_apps`: list launchable app labels and package names.
- `adb_shell`: narrow Android inspection only.

## Sensitive Boundaries

Pause for explicit user confirmation before:

- submitting a purchase or payment
- sending a message, post, like, follow, bid, or other irreversible social action
- changing account, security, privacy, or payment settings
- entering a password, OTP, 2FA code, recovery code, card detail, government ID, or private health or finance data
- using camera, microphone, photos, contacts, files, location, biometric, NFC, or SMS capabilities

If OpenPocket Human Auth is configured and the user asks for an approval-driven flow, prefer the OpenPocket human-auth path. Otherwise ask the user to provide the required data or approve the action in chat.

If a secure surface produces a black or incomplete screenshot, use returned UI metadata only. Do not infer hidden sensitive content.

## Recovery

If tools are missing immediately after installation or update, restart the client and open a new task. Plugin-provided MCP tools are loaded per client task and an existing task may retain the previous tool surface.

Run `node plugins/openpocket-phone/scripts/doctor.mjs` from an OpenPocket checkout to validate both host bundles. If a UI element disappears, capture a fresh snapshot before trying again. If a physical device is unavailable, ask the user to authorize USB debugging or Wi-Fi ADB first.
