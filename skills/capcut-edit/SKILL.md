---
name: capcut-edit
description: Edit videos and beautify photos in CapCut on mobile. Use when the user asks to open CapCut, create/edit/export videos, add text/effects/music/captions, use templates, or retouch and enhance photos.
metadata: {"openclaw":{"triggers":{"any":["capcut","cap cut","com.lemon.lvoverseas","video edit","edit video","photo edit","beautify photo","retouch photo","\u526a\u6620","\u526a\u8f91\u89c6\u9891","\u7f8e\u5316\u7167\u7247","\u7f16\u8f91\u7167\u7247"]}}}
---

# CapCut Edit

Use this skill to complete CapCut editing tasks end-to-end with deterministic, low-risk actions.

This skill follows CapCut official app capabilities (video editing, effects/transitions, text/captions, audio tools, templates, and photo editing/retouch flow).

## Preconditions

- Confirm CapCut is foreground (`com.lemon.lvoverseas`).
- If not installed, install and launch first.
- If sign-in is required for cloud/template assets, use `request_human_auth(oauth)`.
- If gallery/media permission is requested, approve locally on Agent Phone.

## Human Auth Photo Mapping (Critical)

When photos come from Human Phone authorization, use this strict picker rule:

1. Prefer `Downloads` first.
2. If filename is visible, select `openpocket-human-auth-latest.*` first.
3. If the picker is thumbnail-only, select the top-left tile first (most recently imported).
4. Do not randomly scan old thumbnails before trying the latest slot above.

Runtime summaries may include:
- `photo_latest_device_path=...`
- `photo_latest_alias_device_path=...`
- `photo_latest_name=...`

Use these hints to match the correct media item before editing.

## Core Modes

Identify and choose the correct mode before editing:

1. `New project` (manual timeline editing)
2. `Templates` (fast preset output)
3. `AutoCut` (auto-generated edits)
4. `Photo editor` / photo-only flow (retouch, filters, color, crop)

If the user did not specify, default to `New project` for control.

## Video Editing Workflow

### 1) Project setup

- Enter `New project` and select target media.
- Confirm orientation and aspect ratio early (`9:16`, `16:9`, `1:1`, etc.) to avoid rework.
- Place clips in intended order before fine edits.

### 2) Structural edit first

- Trim/split/delete first.
- Then set clip speed and timing.
- Add transitions only after clip boundaries are stable.

### 3) Visual polish

- Apply filters/effects conservatively.
- Add text/stickers after timeline timing is mostly fixed.
- For portrait content, use retouch/beauty controls moderately and keep a natural look.

### 4) Audio and captions

- Add music/voiceover and balance volume levels.
- Use auto captions/subtitles when requested; then quickly proofread key lines.
- Keep caption position away from UI-safe zones (top status area and bottom controls).

### 5) Export

- Verify export settings (resolution/fps) against user intent.
- Export once and wait for completion.
- Do not publish/share to public platforms unless user explicitly asks.

## Photo Edit / Beautify Workflow

Use this when user asks to beautify or edit photos.

1. Open photo editing entry (`Photo editor` tool or image-only project).
2. Apply base corrections first:
- crop/rotate/straighten
- brightness/contrast/highlight/shadow/color temperature
3. Then apply style controls:
- filters/effects
- retouch/beauty (skin smoothing, face/body adjustments when available)
4. Compare before/after quickly and avoid over-processing.
5. Export/save edited photo and report output.

## Template Workflow (Fast Output)

- Open `Templates`.
- Search by user goal/theme.
- Preview 1-3 candidates, pick one closest to requested style.
- Replace media placeholders.
- Check text overlays for clipping/truncation.
- Export and return result.

## AutoCut Workflow

- Open `AutoCut` and select source clips/photos.
- Let CapCut generate draft.
- Accept only if pacing and cuts match user intent.
- If draft quality is poor, switch to `New project` instead of repeatedly regenerating.

## Safety Guardrails

- Never purchase paid assets/subscription without explicit user approval.
- Never auto-post to TikTok/other social channels unless user asks.
- Never delete original media unless user explicitly requests deletion.
- If watermark/pro feature lock appears, report clearly and ask for user decision.

## Interaction Guidance

- Prefer `tap_element` when reliable UI candidates exist.
- Use `swipe` for timeline/media panel navigation.
- For timeline precision, use small repeated drags instead of one large drag.
- After each major edit block, verify visible timeline/result changed as expected.
- If the same action fails twice, switch strategy (different panel/entry point).

## Failure Handling

- Import failed: re-open media picker and retry once.
- Export failed: reduce quality preset and retry once.
- App stalls/crashes: relaunch CapCut, reopen draft/project, continue from last stable point.
- Permission wall loops: close dialog, re-enter editor, confirm permission state.

## Completion Report

When finishing, include:

- mode used (`new project`, `template`, `autocut`, `photo edit`)
- major edits applied
- export status and output type (video/photo)
- notable constraints encountered (pro lock, missing asset, permission issue)
