---
name: "skill-authoring"
description: "Refine draft skills into strict, reusable SKILL.md documents with stable triggers, preconditions, and failure branches."
metadata: {"openclaw":{"triggers":{"any":["skill authoring","refine skill","auto skill","draft skill","skillspec","skill.md"]}}}
---

# skill-authoring

Use this skill when converting a rough draft into a production-ready skill document.

## Goal

Transform noisy step traces or draft markdown into a strict `SKILL.md` that is:

1. deterministic to execute
2. explicit about when to trigger
3. explicit about failure handling
4. valid against strict skill validation rules

## Required Structure

1. Frontmatter:
   - `name` (kebab-case, matches directory)
   - `description` (one concise sentence)
   - optional `metadata` JSON for triggers/requirements
2. Body sections:
   - `When To Use`
   - `Preconditions`
   - `Procedure`
   - `Failure Handling`
   - `Completion Criteria`

## Refinement Rules

1. Replace fragile coordinates with semantic UI targets whenever possible.
2. Keep each procedure step one atomic action.
3. Add at least one fallback path for common blockers (auth wall, empty state, loading timeout).
4. If personal data is required, add `request_human_auth` guidance before UI actions.
5. Keep language concise and executable.

## Validation Gate

Before promotion:

1. Run strict skill validation.
2. If validation fails, keep as draft and report issues.
3. Promote only validated output.
