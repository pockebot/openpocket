---
name: "Human Auth: Location"
description: "Handle GPS location delegation from Human Phone. Covers coordinate injection on emulators and manual coordinate usage on real devices."
metadata: {"openclaw":{"triggers":{"any":["location","gps","geolocation","coordinates","latitude","longitude","nearby","map","position"]}}}
---

# Human Auth: Location

Use this when an app needs the user's real GPS location but the Agent Phone has no real GPS.

## When to Trigger

- App requests location permission and shows "location not available" or defaults to wrong location.
- App needs "nearby" results but the emulator has no GPS fix.
- Capability Probe detects `location` / `ACCESS_FINE_LOCATION` activity.

## How to Call

```
request_human_auth(
  capability: "location",
  instruction: "Please share your current GPS location for [purpose].",
  uiTemplate: {
    allowLocationAttachment: true,
    requireArtifactOnApprove: true,
    title: "Location Needed",
    summary: "Share your current location coordinates."
  }
)
```

## After You Receive the Artifact

The artifact is a JSON file with `lat` and `lon` fields. Read it first: `read(<artifact_path>)`.

### On Emulator

1. **Inject GPS coordinates:**
   ```
   shell("adb emu geo fix <lon> <lat>")
   ```
   Note: `geo fix` takes **longitude first**, then latitude.

2. **Go back to the app** and refresh. The app may need:
   - Pull-to-refresh
   - Tap a "Refresh location" or "Use current location" button
   - Force-stop and relaunch: `shell("am force-stop <package>")` then `launch_app(<package>)`

### On Real Device

Direct GPS injection is not possible on non-rooted real devices. Instead:
- If the app has a search box or address field, type the coordinates or a nearby address.
- If the app has a map with a pin, try to manually position it.

## Tips

- Inject coordinates BEFORE the app requests location for best results.
- Some apps cache location aggressively — force-stop and relaunch if needed.
