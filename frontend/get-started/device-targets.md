# Device Targets

OpenPocket runs locally and controls a configurable **Agent Phone** target through `adb`.

Default behavior:

- Default target type is `emulator`.
- During `openpocket onboard`, target selection is always shown and preselected to the current config value (first run: `emulator`).
- After onboarding, you can switch target any time before `gateway start` (gateway must be stopped).

Recommended practical path today:

- start with `emulator` for quick bring-up
- use `physical-phone` for production-like task validation

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

Switch later (gateway must be stopped):

```bash
openpocket target show
openpocket target set --type physical-phone
openpocket target set --type emulator
```

When you run `openpocket target set --type physical-phone` (or `android-tv`) without `--device`, OpenPocket will:

- detect online adb devices,
- auto-select when only one device is online,
- show an arrow-key selector when multiple devices are online.

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

If multiple devices are connected, select one in the interactive CLI list.

### 4) Start gateway

```bash
openpocket gateway start
```

OpenPocket will verify the target device is online before gateway runtime starts.

## Physical Phone Setup (Wi-Fi ADB)

Use this only after at least one successful USB pairing.

```bash
adb tcpip 5555
adb connect <phone-ip>:5555
openpocket target set --type physical-phone --adb-endpoint <phone-ip>:5555
```

Then verify:

```bash
adb devices -l
openpocket target show
```

Notes:

- Some Android 11+ builds prefer **Wireless debugging** pairing flow from Developer options.
- Keep the phone unlocked during first pairing/authorization.

## Physical Phone Setup (Wi-Fi Pairing via `target pair`)

For Android 11+ **Wireless debugging**, you can use OpenPocket's built-in pairing wrapper instead of running raw `adb pair` manually.

### 1) On phone, open Wireless debugging pairing details

1. Open **Settings -> Developer options -> Wireless debugging**.
2. Tap **Pair device with pairing code**.
3. Keep the pairing panel visible and note:
   - IP address
   - Pairing port
   - Pairing code

### 2) Run OpenPocket pairing command (non-interactive)

```bash
openpocket target pair --host <device-ip> --pair-port <pair-port> --code <pairing-code> --type physical-phone
```

This command:

- runs `adb pair` with the provided endpoint/code,
- runs `adb connect` for the same host,
- updates target config (`type`, `preferredDeviceId`, `adbEndpoint`).

Equivalent endpoint-style form:

```bash
openpocket target pair --pair-endpoint <device-ip:pair-port> --connect-endpoint <device-ip:adb-port> --code <pairing-code> --type physical-phone
```

### 3) Optional: specify connect port explicitly

If your device uses a non-default ADB connect port:

```bash
openpocket target pair --host <device-ip> --pair-port <pair-port> --connect-port <adb-connect-port> --code <pairing-code> --type physical-phone
```

### 4) Optional: interactive pairing prompts

If you omit some arguments, OpenPocket can prompt for them:

```bash
openpocket target pair --type physical-phone
```

### 5) Verify and continue

```bash
adb devices -l
openpocket target show
openpocket gateway start
```

## Android TV and Cloud Paths

`android-tv` and `cloud` targets are visible now for forward compatibility, but these two deployment paths are still under active implementation and documentation expansion.
