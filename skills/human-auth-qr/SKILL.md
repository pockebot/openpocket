---
name: "human-auth-qr"
description: "Handle QR code scanning delegation from Human Phone. Covers QR scan result retrieval and application in login, payment, and linking flows."
metadata: {"openclaw":{"triggers":{"any":["qr","qr code","scan","barcode","scan code","qr login","scan to login"]}}}
---

# Human Auth: QR Code

Use this when an app displays a QR code that needs to be scanned by the user's real phone, or when the app needs QR scan input.

## When to Trigger

- App shows a QR code for "Scan to log in" (e.g., WhatsApp Web, Telegram Desktop, WeChat).
- App requires scanning a QR code from a physical object (ticket, product, receipt).
- App needs barcode/QR input but the emulator camera cannot scan.

## How to Call

```
request_human_auth(
  capability: "qr",
  instruction: "Please scan the QR code shown on the Agent Phone screen (or scan [describe target]).",
  uiTemplate: {
    allowTextAttachment: true,
    allowPhotoAttachment: true,
    title: "QR Code Scan Needed",
    summary: "Scan the QR code and provide the result."
  }
)
```

## What You Receive

- If the human entered the QR text: `artifact_kind: text`, `value: "<qr_content>"`
- If the human took a photo of the QR: `artifact_type: image/jpeg`

## How to Apply

### Text Result (QR content decoded)
1. Read the artifact to get the decoded text.
2. If the app has a "Enter code manually" option, type the code there.
3. If the code is a URL, you may need to open it via:
   ```
   shell("am start -a android.intent.action.VIEW -d '<url>'")
   ```

### Photo of QR Code
1. If the app has its own QR scanner and needs the image:
   - Push the photo to device and import via the scanner's gallery option.
2. If you need to decode the QR from the photo, this requires a QR decoder (not built-in).

### "Scan to Log In" Flows
For apps like WhatsApp Web where the QR just needs to be scanned by the user's phone app:
1. The human uses their phone's native app to scan the QR displayed on the emulator screen.
2. No artifact is needed — the human just approves after scanning.
3. The app on Agent Phone will automatically proceed after the scan completes.

## Tips

- For "scan to login" flows, use Remote Takeover so the human can see the QR code on their phone and scan it with their native app.
- QR codes may expire. If the login times out, the app usually regenerates a new QR.
