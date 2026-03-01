---
name: "human-auth-nfc"
description: "Handle NFC tap and RFID delegation from Human Phone. Covers NFC tag reading, contactless payment verification, and physical access card scenarios."
metadata: {"openclaw":{"triggers":{"any":["nfc","rfid","contactless","tap card","near field","nfc tag","tap to pay","card reader"]}}}
---

# Human Auth: NFC / RFID

Use this when an app requires NFC (Near Field Communication) or RFID interaction that the emulator cannot perform.

## When to Trigger

- App asks user to "Tap your card" or "Hold your phone near the reader".
- App needs to read an NFC tag (transit card, access badge, smart tag).
- App requires contactless payment confirmation.
- Any flow requiring physical NFC/RFID interaction.

## How to Call

```
request_human_auth(
  capability: "nfc",
  instruction: "Please tap your [card/tag/device] to read NFC data for [purpose].",
  uiTemplate: {
    allowTextAttachment: true,
    allowFileAttachment: true,
    title: "NFC / RFID Tap Required",
    summary: "Tap your NFC card or tag and provide the result."
  }
)
```

## What You Receive

- If the human entered the NFC data as text: `artifact_kind: text`, `value: "<nfc_data>"`
- If the human provided a file dump: `artifact_type: application/octet-stream` or similar

## How to Apply

NFC data application depends heavily on the app's expected input:

### Transit / Access Card ID
1. Read the artifact to get the card UID or data.
2. If the app has a manual entry option, type the card ID.
3. If no manual entry exists, the flow may require the human to use Remote Takeover to complete the NFC step directly.

### NFC Tag Content (URL, text record)
1. Read the artifact text content.
2. If it's a URL, open it: `shell("am start -a android.intent.action.VIEW -d '<url>'")`
3. If it's text data, type it into the relevant app field.

### Contactless Payment
NFC payment typically cannot be delegated — it requires the physical card/phone at the terminal. In this case:
1. Inform the user via the decision note that this step requires physical presence.
2. The human completes the payment on their end.
3. Approve without artifact if the payment was completed externally.

## Limitations

- Emulators have no NFC hardware. NFC interactions always require human delegation.
- Some NFC operations are one-shot (e.g., transit gate) and cannot be replayed.
- Real-device Agent Phones may have NFC but cannot proxy another phone's secure element.
