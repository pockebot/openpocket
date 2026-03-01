---
name: "human-auth-microphone"
description: "Handle microphone audio recording delegation from Human Phone. Covers audio capture, push to Agent Phone, and audio file usage in apps."
metadata: {"openclaw":{"triggers":{"any":["microphone","audio","record","voice memo","sound","speech","recording"]}}}
---

# Human Auth: Microphone

Use this when an app needs microphone input (voice recording, audio message, speech-to-text).

## When to Trigger

- App requests microphone permission or opens an audio recording UI.
- App is waiting for voice input (voice search, voice message, audio note).
- Capability Probe detects `microphone` / `RECORD_AUDIO` activity.

## How to Call

```
request_human_auth(
  capability: "microphone",
  instruction: "Please record audio: [describe what to say or capture].",
  uiTemplate: {
    allowAudioAttachment: true,
    requireArtifactOnApprove: true,
    title: "Audio Recording Needed",
    summary: "Record audio with your phone microphone."
  }
)
```

## After You Receive the Artifact

The audio file is already pushed to Agent Phone Downloads. The result includes `device_path=...`.

1. **Exit current screen state.** The app may have a recording UI or microphone dialog open. Press `keyevent KEYCODE_BACK` to dismiss it.

2. **Re-navigate the app** to its file attachment or audio upload option.

3. **Select the audio file** from Downloads in the file picker (look for the `openpocket-human-auth-*` file).

5. If the app needs **speech-to-text** rather than an audio file, and the human provided text in the decision note, type that text directly instead.

## Tips

- Audio files may be in WebM or OGG format. Most Android apps handle these natively.
- Some voice message features (WhatsApp, Telegram) require holding a button — these may not work with file upload. In that case, consider Remote Takeover.
