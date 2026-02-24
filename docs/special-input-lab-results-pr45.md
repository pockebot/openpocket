# Special Input Lab Results (PR #45)

Date: 2026-02-24
Branch under test: `pr-45` (`61f75e2`)
Device: `emulator-5554`

Command run:

```bash
npm run build
node scripts/verify-special-input.mjs
```

Observed results:

- `abc123` => `PASS` (`Typed text length=6`)
- `Ab&cd` => `FAIL` (`Text input failed (clipboard + adb keyboard) ...`)
- `Ab&zzzzz` => `FAIL` (`Text input failed (clipboard + adb keyboard) ...`)
- `A(B` => `FAIL` (`Text input failed (clipboard + adb keyboard) ...`)
- `P@ssw0rd!#$` => `FAIL` (`Text input failed (clipboard + adb keyboard) ...`)
- `x|y;z` => `FAIL` (`Text input failed (clipboard + adb keyboard) ...`)

Environment notes:

- `adb shell cmd clipboard set text ...` returns `No shell command implementation.` on this emulator image.
- `com.android.adbkeyboard/.AdbIME` is not present in `adb shell ime list -s`.

Conclusion:

PR #45 route selection is not sufficient on this emulator image; most special-character samples still fail in the real runtime path.
