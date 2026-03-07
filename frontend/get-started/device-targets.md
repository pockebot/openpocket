# Device Targets

OpenPocket runs locally and controls a configurable **Agent Phone** target through `adb`.

In multi-agent mode, the rule is simple:

- one agent instance binds to one selected target at a time
- one target cannot be shared by multiple agents

Default behavior:

- default target type is `emulator`
- during `openpocket onboard`, target selection is always shown and preselected to the current config value (first run: `emulator`)
- after onboarding, you can switch target for the selected agent any time before that agent's `gateway start`

Recommended practical path today:

- start with `emulator` for quick bring-up
- use `physical-phone` for production-like task validation
- create additional agents when you need additional devices, instead of trying to multiplex one agent across many targets

## Target Types and Status

| Type | Key | Status | Notes |
| --- | --- | --- | --- |
| Emulator | `emulator` | Ready | Default and fully documented path. |
| Physical Phone | `physical-phone` | Ready | USB and Wi-Fi ADB supported. |
| Android TV | `android-tv` | In progress | Type is available in config/CLI; broader validation and docs are still being expanded. |
| Cloud | `cloud` | In progress | Type is available in config/CLI; provider integrations are still being expanded. |

## Select or Switch Target

Onboarding preset (optional):

```bash
openpocket onboard --target physical-phone
```

Switch later for the default agent:

```bash
openpocket target show
openpocket target set --type physical-phone
openpocket target set --type emulator
```

Switch later for a managed agent:

```bash
openpocket --agent review-bot target show
openpocket --agent review-bot target set --type physical-phone --device R5CX123456A
```

When you run `openpocket target set --type physical-phone` (or `android-tv`) without `--device`, OpenPocket will:

- detect online adb devices
- auto-select when only one device is online
- show an arrow-key selector when multiple devices are online

Target switching checks:

- the selected agent gateway must be stopped first
- the new target fingerprint must not already belong to another agent

## When to Create Another Agent Instead of Switching

Use `target set` when one existing agent should move to a different target.

Use `create agent` when you need:

- a second target running at the same time
- a second isolated workspace and memory timeline
- different channels for a different phone or workflow

Example:

```bash
openpocket create agent review-bot --type physical-phone --device R5CX123456A
openpocket create agent ops-bot --type emulator
openpocket agents list
```

## Physical Phone Setup (USB)

### 1) Enable Developer Options on your Android phone

Menu names vary by OEM, but the usual flow is:

1. Open **Settings**.
2. Go to **About phone**.
3. Tap **Build number** 7 times.
4. Enter your lock-screen PIN/password if prompted.
5. Go back to **Settings** and open **Developer options** (often under **System**).
6. Enable **USB debugging**.

### 2) Connect phone to your computer and trust the host

1. Connect with a USB cable.
2. On phone, accept **Allow USB debugging?** and optionally enable **Always allow from this computer**.

### 3) Verify adb and set target

```bash
adb devices -l
openpocket target set --type physical-phone
openpocket target show
```

For a managed agent:

```bash
openpocket --agent review-bot target set --type physical-phone
openpocket --agent review-bot target show
```

If multiple devices are connected, select one in the interactive CLI list.

### 4) Start gateway

```bash
openpocket gateway start
openpocket --agent review-bot gateway start
```

OpenPocket verifies that the selected target device is online before gateway runtime starts.

## Physical Phone Setup (Wi-Fi ADB)

Use this only after at least one successful USB pairing.

```bash
adb tcpip 5555
adb connect <phone-ip>:5555
openpocket target set --type physical-phone --adb-endpoint <phone-ip>:5555
```

For a managed agent:

```bash
openpocket --agent review-bot target set --type physical-phone --adb-endpoint <phone-ip>:5555
```

Then verify:

```bash
adb devices -l
openpocket target show
```

Notes:

- some Android 11+ builds prefer **Wireless debugging** pairing flow from Developer options
- keep the phone unlocked during first pairing/authorization

## Physical Phone Setup (Wi-Fi Pairing via `target pair`)

For Android 11+ **Wireless debugging**, you can use OpenPocket's built-in pairing wrapper instead of running raw `adb pair` manually.

### 1) On phone, open Wireless debugging pairing details

1. Open **Settings -> Developer options -> Wireless debugging**.
2. Tap **Pair device with pairing code**.
3. Keep the pairing panel visible and note:
   - IP address
   - Pairing port
   - Pairing code

### 2) Run OpenPocket pairing command

```bash
openpocket target pair --host <device-ip> --pair-port <pair-port> --code <pairing-code> --type physical-phone
```

For a managed agent:

```bash
openpocket --agent review-bot target pair --host <device-ip> --pair-port <pair-port> --code <pairing-code> --type physical-phone
```

This command:

- runs `adb pair` with the provided endpoint/code
- runs `adb connect` for the same host
- updates target config (`type`, `preferredDeviceId`, `adbEndpoint`)
- supports `--dry-run` for command preview without changing device state

### 3) Verify and continue

```bash
adb devices -l
openpocket target show
openpocket gateway start
```

## Emulator Path in Multi-Agent Installs

Each emulator-backed agent still uses one configured AVD name.

Examples:

```bash
openpocket target set --type emulator
openpocket --agent ops-bot target set --type emulator
```

If two agents should both use emulators, assign them different AVDs so the target fingerprint stays unique.

## Android TV and Cloud Paths

`android-tv` and `cloud` targets are visible now for forward compatibility, but these two deployment paths are still under active implementation and documentation expansion.
