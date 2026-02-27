---
name: "Human Auth: Photo Album"
description: "Handle photo album selection delegation from Human Phone. Covers single and multi-photo selection, push to Agent Phone, and gallery picker navigation."
metadata: {"openclaw":{"triggers":{"any":["photos","album","gallery","pick photo","select photo","upload photo","image picker"]}}}
---

# Human Auth: Photo Album

Use this when an app needs the user to select photos from their personal album on Human Phone.

## When to Trigger

- App opens a photo picker (gallery, media selector).
- User asks to send/upload "my photos" or "photos from my album".
- Capability Probe detects `photos` activity.

## How to Call

```
request_human_auth(
  capability: "camera",
  instruction: "Please select [N] photo(s) from your gallery for [purpose].",
  uiTemplate: {
    allowPhotoAttachment: true,
    requireArtifactOnApprove: true,
    title: "Photo Selection Needed",
    summary: "Choose photos from your phone gallery."
  }
)
```

## After You Receive the Artifact

**Critical: you must redo the app flow.** The app's photo picker may still be open or the UI may have changed during the Human Auth wait.

### Single Photo

The photo is already pushed to Agent Phone Downloads. The result includes `device_path=...`.

1. **Exit current screen state.** Press `keyevent KEYCODE_BACK` until you're back at the screen where the photo was requested.

2. **Re-open the picker** in the app (tap the attachment button, "Upload", "+", etc.).

3. **Navigate to Downloads** in the picker and select the `openpocket-human-auth-*` file.

4. **Confirm** (tap Send, Done, Upload, etc.).

### Multiple Photos (artifact_kind=photos_multi)

1. Read the artifact JSON: `read(<artifact_path>)` to see the photo array.
2. For each photo, write base64 to a temp file, push to `/sdcard/Download/`, and trigger media scan.
3. Re-open the picker, navigate to Downloads, and select all pushed files.

## Tips

- After pressing Back, verify you're at the right screen before re-opening the picker.
- Some apps show a photo grid — look for "Downloads" or "Recent" folder in the picker.
