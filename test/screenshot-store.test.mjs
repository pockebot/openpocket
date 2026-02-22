import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { ScreenshotStore } = await import("../dist/memory/screenshot-store.js");

test("ScreenshotStore enforces maxCount by deleting oldest files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-shot-"));
  const store = new ScreenshotStore(dir, 3);

  for (let i = 1; i <= 5; i += 1) {
    const buffer = Buffer.from(`fake-image-${i}`, "utf-8");
    store.save(buffer, {
      sessionId: "test",
      step: i,
      currentApp: "com.example.app",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const pngs = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .sort();

  assert.equal(pngs.length, 3);
  assert.equal(pngs.some((name) => name.includes("step-001")), false);
  assert.equal(pngs.some((name) => name.includes("step-002")), false);
  assert.equal(pngs.some((name) => name.includes("step-005")), true);
});
