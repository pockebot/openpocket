---
name: "Human Auth: Contacts & Data Access"
description: "Handle contacts, calendar, files, and notification data delegation from Human Phone. Covers data export, push to Agent Phone, and app import flows."
metadata: {"openclaw":{"triggers":{"any":["contacts","calendar","files","notification","address book","phone book","schedule","documents","data access","import contacts"]}}}
---

# Human Auth: Contacts & Data Access

Use this when an app needs access to the user's contacts, calendar events, files, or notification data from their real phone.

## When to Trigger

- App asks to import contacts or sync address book.
- App needs calendar events or schedule data.
- App requests access to user's files/documents.
- Any data access that requires the user's real phone data (not emulator data).

## How to Call

### Contacts
```
request_human_auth(
  capability: "contacts",
  instruction: "Please export your contacts for import into [app].",
  uiTemplate: {
    allowFileAttachment: true,
    fileAccept: ".vcf,.csv",
    title: "Contacts Import Needed",
    summary: "Export contacts as VCF/CSV file from your phone."
  }
)
```

### Calendar
```
request_human_auth(
  capability: "calendar",
  instruction: "Please export your calendar events for [purpose].",
  uiTemplate: {
    allowFileAttachment: true,
    fileAccept: ".ics,.csv",
    title: "Calendar Data Needed",
    summary: "Export calendar events from your phone."
  }
)
```

### Files
```
request_human_auth(
  capability: "files",
  instruction: "Please upload [describe the file needed].",
  uiTemplate: {
    allowFileAttachment: true,
    title: "File Upload Needed",
    summary: "Select and upload the required file from your phone."
  }
)
```

## What You Receive

- `artifact_path`: Path to the exported file (VCF, ICS, CSV, or other format).
- `artifact_type`: MIME type of the file.

## How to Apply

1. Push the file to Agent Phone:
   ```
   shell("adb push <artifact_path> /sdcard/Download/<filename>")
   ```

2. Trigger media scan:
   ```
   shell("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/<filename>")
   ```

3. Navigate the app to its import/upload functionality:
   - For contacts: look for "Import contacts" → "From file" → select from Downloads.
   - For calendar: look for "Import" → select ICS file.
   - For files: use the app's file picker to select from Downloads.

## Tips

- VCF (vCard) is the standard format for contacts. Most Android contacts apps can import VCF files directly.
- ICS (iCalendar) is the standard format for calendar events.
- For large data sets, the human may need time to export — adjust `timeoutSec` accordingly.
