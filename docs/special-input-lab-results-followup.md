# Special Input Lab Results (Follow-up Fix)

Date: 2026-02-24
Branch under test: `codex/pr45-specialchar-input-lab`
Device: `emulator-5554`

Command run:

```bash
npm run build
node scripts/verify-special-input.mjs
```

Observed results:

- `abc123` => `PASS` (`Typed text length=6`)
- `Ab&cd` => `PASS` (`Typed text length=5`)
- `Ab&zzzzz` => `PASS` (`Typed text length=8`)
- `A(B` => `PASS` (`Typed text length=3`)
- `P@ssw0rd!#$` => `PASS` (`Typed text length=11`)
- `x|y;z` => `PASS` (`Typed text length=5`)

Runtime strategy used:

- Non-ASCII: clipboard paste, then AdbIME fallback.
- ASCII (including shell-special chars): escaped `adb shell input text` first, then clipboard/AdbIME fallback only if adb input fails.
