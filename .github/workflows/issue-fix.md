---
name: issue-fix
on:
  slash_command:
    name: fix
    events: [issues, issue_comment]

engine: codex
strict: true

network:
  allowed:
    - defaults
    - node

tools:
  github:
    toolsets: [repos, issues, pull_requests, actions]
  edit:
  bash: ["make", "git:*"]

safe-outputs:
  create-pull-request:
    title-prefix: "[codex-fix] "
    draft: true
  add-comment:
---

# Fix issue via PR

Triggered when a maintainer comments `/fix`.

Issue context (sanitized): "${{ needs.activation.outputs.text }}"

Rules:
1. Run `make ci` before changes and summarize baseline status.
2. Make the smallest correct code changes to resolve the issue.
3. Add or update tests that prove the fix.
4. Run `make ci` after changes and summarize results.
5. Create a draft PR that explains:
   - what changed
   - why it fixes the issue
   - how to test
   - remaining risks or limitations
