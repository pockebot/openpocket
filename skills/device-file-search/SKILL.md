---
name: device-file-search
description: Locate and verify files on Android storage before upload/share, especially latest edited photos or videos.
metadata: {"openclaw":{"triggers":{"any":["find file","search file","locate file","latest photo","edited photo","saved photo","send photo","send image","upload photo","upload image","share photo","latest video","dcim","camera","download","capcut","\u53d1\u7ed9\u6211","\u627e\u6587\u4ef6","\u627e\u56fe\u7247","\u627e\u7167\u7247","\u6700\u65b0\u7167\u7247","\u7f16\u8f91\u540e\u7167\u7247","\u7f8e\u5316\u540e\u7167\u7247","\u4e0a\u4f20\u56fe\u7247","\u53d1\u9001\u7167\u7247"]}}}
---

# Device File Search

Use this skill when you need to find a saved file on the Agent Phone, then upload/share it in an app.

## Goal

- Return a real, existing absolute file path.
- Prefer the newest matching file.
- Avoid repeated blind searches.

## Default Search Order

1. Check likely output folders first:
- `/storage/emulated/0/DCIM/Camera`
- `/storage/emulated/0/Pictures`
- `/storage/emulated/0/Download`
- `/storage/emulated/0/Movies`

2. For editor-specific outputs, try app-named subfolders:
- `/storage/emulated/0/Pictures/CapCut`
- `/storage/emulated/0/Movies/CapCut`
- `/storage/emulated/0/DCIM/Camera`

3. Only if still missing, run a wider `find` under `/storage/emulated/0`.

## Command Patterns

Use `shell` (device-side), not workspace `exec`.

- Quick latest list:
`shell("sh -lc 'ls -1t /storage/emulated/0/DCIM/Camera | head -n 20'")`

- Wider image search:
`shell("sh -lc 'find /storage/emulated/0 -type f \\( -iname \"*.jpg\" -o -iname \"*.jpeg\" -o -iname \"*.png\" -o -iname \"*.webp\" \\) | head -n 400'")`

- Wider video search:
`shell("sh -lc 'find /storage/emulated/0 -type f \\( -iname \"*.mp4\" -o -iname \"*.mov\" -o -iname \"*.mkv\" \\) | head -n 400'")`

- Verify one candidate path:
`shell("ls -l /storage/emulated/0/DCIM/Camera/<filename>")`

## Reliability Rules

- Prefer `/storage/emulated/0/...` over `/sdcard/...` (symlink issues can hide `find` results).
- If `/sdcard` must be used, use `find -L /sdcard ...`.
- After editing/saving, prioritize files modified in the last few minutes.
- Before telling the user "not found", verify at least 2 directories + 1 wide search.

## After Found

- Keep the exact absolute path in memory for the rest of the task.
- Reuse the same path for upload/share actions.
- If upload fails, retry with the same verified path before starting a new search.
