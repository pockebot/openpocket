import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { MemoryExecutor } = require("../dist/tools/memory-executor.js");

function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("MemoryExecutor memory_search returns ranked snippets with citations", () => {
  withTempHome("openpocket-memory-search-", () => {
    const cfg = loadConfig();
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "MEMORY.md"),
      [
        "# MEMORY",
        "",
        "- User prefers being called Sergio.",
        "- Assistant name is JarvisPhone.",
        "- User checks San Francisco weather every morning.",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(cfg.workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "memory", "2026-02-22.md"),
      [
        "# Memory 2026-02-22",
        "",
        "- Discussed Gmail inbox cleanup task.",
        "- Created weather search flow for San Francisco forecast.",
      ].join("\n"),
      "utf8",
    );

    const executor = new MemoryExecutor(cfg);
    const result = JSON.parse(
      executor.execute({
        type: "memory_search",
        query: "Jarvis weather San Francisco",
      }),
    );

    assert.equal(Array.isArray(result.results), true);
    assert.equal(result.results.length > 0, true);
    assert.equal(typeof result.results[0].citation, "string");
    assert.match(result.results[0].citation, /#L/);
  });
});

test("MemoryExecutor memory_get enforces memory path policy", () => {
  withTempHome("openpocket-memory-get-", () => {
    const cfg = loadConfig();
    fs.mkdirSync(path.join(cfg.workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "memory", "2026-02-22.md"),
      ["line-1", "line-2", "line-3", "line-4"].join("\n"),
      "utf8",
    );
    const executor = new MemoryExecutor(cfg);

    const snippet = JSON.parse(
      executor.execute({
        type: "memory_get",
        path: "memory/2026-02-22.md",
        from: 2,
        lines: 2,
      }),
    );
    assert.equal(snippet.path, "memory/2026-02-22.md");
    assert.equal(snippet.from, 2);
    assert.equal(snippet.lines, 2);
    assert.equal(snippet.text, "line-2\nline-3");

    assert.throws(
      () =>
        executor.execute({
          type: "memory_get",
          path: "USER.md",
        }),
      /only MEMORY\.md and memory\/\*\.md are allowed/i,
    );
  });
});
