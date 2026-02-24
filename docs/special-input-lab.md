# Special Character Input Lab

This lab reproduces how `AdbRuntime.executeAction({ type: "type" })` behaves with credential-like strings on a real emulator.

## What it tests

- Builds and installs a tiny Android app (`com.openpocket.inputlab`) with one `EditText`.
- Launches the app and focuses the input field.
- Sends text by the same runtime path used by the agent.
- Reads the final text from UI XML and compares expected vs observed.

## Files

- `tools/android-input-lab/`: minimal Android app source + `build.sh`.
- `scripts/verify-special-input.mjs`: end-to-end verifier.

## Run

```bash
npm run build
node scripts/verify-special-input.mjs
```

The script exits with code `1` when any sample does not round-trip correctly.

## Notes

- The runtime route depends on branch logic in `src/device/adb-runtime.ts`.
- On some emulator images, `cmd clipboard` is not implemented and `AdbIME` is not installed; this strongly affects fallback behavior.
