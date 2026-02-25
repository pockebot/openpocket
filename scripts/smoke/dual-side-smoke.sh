#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[smoke] build"
npm run build

echo "[smoke] type-check"
npm run check

echo "[smoke] dual-side e2e"
node --test test/e2e-dual-side-smoke.test.mjs

echo "[smoke] done"
