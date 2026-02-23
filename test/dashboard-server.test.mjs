import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { DashboardServer } = await import("../dist/dashboard/server.js");

async function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${response.status}`);
  }
  return payload;
}

async function requestJsonExpectError(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  assert.equal(response.ok, false);
  assert.equal(payload.ok, false);
  return payload;
}

test("dashboard server exposes health/config and prompt CRUD APIs", async () => {
  await withTempHome("openpocket-dashboard-server-", async () => {
    const cfg = loadConfig();
    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });

    await server.start();
    const base = server.address;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

    try {
      const health = await requestJson(base, "/api/health");
      assert.equal(health.ok, true);

      const configPayload = await requestJson(base, "/api/config");
      assert.equal(typeof configPayload.config.projectName, "string");
      assert.equal(typeof configPayload.credentialStatus, "object");

      const promptFile = path.join(cfg.workspaceDir, "TEST_PROMPT.md");

      const added = await requestJson(base, "/api/prompts/add", {
        method: "POST",
        body: JSON.stringify({ title: "TEST", path: promptFile }),
      });
      assert.equal(Array.isArray(added.promptFiles), true);
      const target = added.promptFiles.find((item) => item.path === promptFile);
      assert.equal(Boolean(target), true);

      await requestJson(base, "/api/prompts/save", {
        method: "POST",
        body: JSON.stringify({ id: target.id, content: "hello prompt" }),
      });

      const read = await requestJson(base, "/api/prompts/read", {
        method: "POST",
        body: JSON.stringify({ id: target.id }),
      });
      assert.equal(read.content, "hello prompt");
      assert.equal(fs.existsSync(promptFile), true);

      const removed = await requestJson(base, "/api/prompts/remove", {
        method: "POST",
        body: JSON.stringify({ id: target.id }),
      });
      const stillExists = removed.promptFiles.some((item) => item.id === target.id);
      assert.equal(stillExists, false);
    } finally {
      await server.stop();
    }
  });
});

test("dashboard permission scope does not leak sibling paths with shared prefix", async () => {
  await withTempHome("openpocket-dashboard-scope-", async () => {
    const cfg = loadConfig();
    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });

    const safeDir = path.join(cfg.workspaceDir, "safe");
    const unsafeDir = path.join(cfg.workspaceDir, "safe2");
    fs.mkdirSync(safeDir, { recursive: true });
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(safeDir, "ok.txt"), "allowed", "utf-8");
    fs.writeFileSync(path.join(unsafeDir, "leak.txt"), "blocked", "utf-8");

    await server.start();
    const base = server.address;

    try {
      await requestJson(base, "/api/control-settings", {
        method: "POST",
        body: JSON.stringify({
          permission: {
            allowLocalStorageView: true,
            storageDirectoryPath: cfg.workspaceDir,
            allowedSubpaths: ["safe"],
            allowedExtensions: ["txt"],
          },
        }),
      });

      const files = await requestJson(base, "/api/permissions/files");
      assert.equal(Array.isArray(files.files), true);
      assert.equal(files.files.some((item) => item.endsWith("/safe/ok.txt")), true);
      assert.equal(files.files.some((item) => item.endsWith("/safe2/leak.txt")), false);

      const denied = await requestJsonExpectError(base, "/api/permissions/read-file", {
        method: "POST",
        body: JSON.stringify({
          path: path.join(unsafeDir, "leak.txt"),
        }),
      });
      assert.match(String(denied.error), /outside allowed scope/i);
    } finally {
      await server.stop();
    }
  });
});
