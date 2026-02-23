---
name: issue-fix
on:
  slash_command:
    name: fix
    events: [issues, issue_comment]

engine: codex
strict: true

permissions:
  contents: read
  issues: read

network:
  allowed:
    - defaults

tools:
  github:
    toolsets: [repos, issues]
  bash: ["make", "git:*"]

safe-outputs:
  add-comment:
---

# Analyze issue and suggest fix

Triggered when a maintainer comments `/fix`.

Issue context (sanitized): "${{ needs.activation.outputs.text }}"

Rules:
1. Do not create a PR and do not push code changes.
2. Analyze the issue and provide a concrete recommendation comment containing:
   - probable root cause(s)
   - likely files/modules involved
   - reproduction/verification steps
   - minimal fix options (with one recommended approach)
   - test cases to add/update
   - risk and rollback notes
3. If useful, run lightweight read-only checks and include what you observed.
4. If key context is missing, ask focused follow-up questions in the comment.
