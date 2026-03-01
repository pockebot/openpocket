---
name: "human-auth-biometric"
description: "Handle biometric authentication delegation (fingerprint, face recognition) when the Agent Phone lacks biometric hardware."
metadata: {"openclaw":{"triggers":{"any":["biometric","fingerprint","face id","face recognition","touch id","biometric auth"]}}}
---

# Human Auth: Biometric

Use this when an app requires biometric authentication (fingerprint, face recognition) that the emulator cannot provide.

## When to Trigger

- App shows a fingerprint or face recognition dialog.
- App requires biometric confirmation for a sensitive action (payment, account access).
- Emulator shows "No biometric hardware detected" or similar.

## How to Call

```
request_human_auth(
  capability: "biometric",
  instruction: "App requires biometric authentication. Please confirm this action.",
  uiTemplate: {
    title: "Biometric Confirmation Required",
    summary: "The app needs fingerprint/face verification. Approve to confirm."
  }
)
```

## What You Receive

- Usually no artifact — just an approval/rejection signal.
- `status: approved` means the human confirmed the biometric action.

## How to Apply

Biometric prompts on the emulator typically cannot be bypassed programmatically. Options:

1. **Dismiss and retry:** Press Back to dismiss the biometric dialog, then look for a "Use password instead" or "Use PIN" fallback option. Enter the fallback credentials.

2. **Emulator fingerprint simulation** (if available):
   ```
   shell("adb -s <device> emu finger touch 1")
   ```
   This simulates a fingerprint touch on some emulator versions.

3. **If no fallback exists:** The flow may be blocked on the emulator. Report this to the user.

## Tips

- Most apps that use biometrics also offer a PIN/password fallback. Look for it.
- On emulators with enrolled fingerprints, `emu finger touch 1` can simulate a successful scan.
- Real devices with actual biometric hardware would need the human to physically authenticate — this is the primary use case for this delegation.
