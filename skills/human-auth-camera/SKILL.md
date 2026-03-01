---
name: "human-auth-camera"
description: "Handle camera photo capture delegation from Human Phone. Covers single photo capture, push to Agent Phone, and app file picker navigation."
metadata: {"openclaw":{"triggers":{"any":["camera","photo","capture","take photo","take picture","snap","image capture"]}}}
---

# Human Auth: Camera

Use this when an app on Agent Phone needs a camera photo but the emulator has no real camera.

## When to Trigger

- App opens a camera intent (e.g., profile photo, document scan, ID verification).
- You see a camera preview screen that shows black or "no camera found".
- Capability Probe detects `camera` activity from the foreground app.

## How to Call

```
request_human_auth(
  capability: "camera",
  instruction: "Please take a photo of [describe what is needed].",
  uiTemplate: {
    allowPhotoAttachment: true,
    requireArtifactOnApprove: true,
    title: "Camera Photo Needed",
    summary: "Take a photo with your phone camera and attach it."
  }
)
```

## After You Receive the Artifact

You will get an `artifact_path` pointing to a JPEG/PNG file on the local filesystem.

**The photo is already pushed to Agent Phone.** The result includes `device_path=/sdcard/Download/openpocket-human-auth-<ts>.jpg` — the file is ready in Downloads.

**You must redo the app flow to select it.** Follow these steps:

1. **Exit the current screen state.** The app may have a camera preview or picker open. Press Back (`keyevent KEYCODE_BACK`) one or more times until you are back at the screen where the photo upload/capture was initiated.

2. **Re-open the photo picker/upload in the app.** Navigate back to the attachment point (e.g., tap the "+" button, "Upload photo" option, or "Choose from gallery" alternative).

3. **Select the file from Downloads.** In the file picker, navigate to Downloads folder and select the `openpocket-human-auth-*` file.

4. **Confirm and continue** the app flow (tap Send, Upload, Submit, etc.).

## Tips

- If the app originally opened a camera intent, look for a "Choose from gallery" or "Upload from files" alternative after pressing Back.
- Always verify the photo was accepted by checking the next screen state.
- Some apps may need you to re-trigger the entire attachment flow from the beginning.
