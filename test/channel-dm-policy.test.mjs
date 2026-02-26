import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { evaluateDmPolicy } = await import("../dist/channel/dm-policy.js");
const { FilePairingStore } = await import("../dist/channel/pairing.js");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// DM Policy Engine tests
// ---------------------------------------------------------------------------

test("dm policy 'disabled' blocks all senders", () => {
  withTempDir("dm-policy-disabled-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("user-1", "Alice", {
      policy: "disabled",
      allowFrom: [],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "dm_policy_disabled");
  });
});

test("dm policy 'open' allows all senders", () => {
  withTempDir("dm-policy-open-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("stranger-99", null, {
      policy: "open",
      allowFrom: [],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "dm_policy_open");
  });
});

test("dm policy 'allowlist' allows sender in allowFrom", () => {
  withTempDir("dm-policy-allowlist-match-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("user-1", "Alice", {
      policy: "allowlist",
      allowFrom: ["user-1", "user-2"],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "allowlist_match");
  });
});

test("dm policy 'allowlist' blocks sender not in allowFrom", () => {
  withTempDir("dm-policy-allowlist-reject-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("stranger-99", null, {
      policy: "allowlist",
      allowFrom: ["user-1"],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "not_in_allowlist");
  });
});

test("dm policy 'allowlist' with empty allowFrom allows everyone", () => {
  withTempDir("dm-policy-allowlist-empty-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("anyone", null, {
      policy: "allowlist",
      allowFrom: [],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "allowlist_match");
  });
});

test("dm policy 'allowlist' with wildcard allows everyone", () => {
  withTempDir("dm-policy-allowlist-wildcard-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("anyone", null, {
      policy: "allowlist",
      allowFrom: ["*"],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "allowlist_match");
  });
});

test("dm policy 'allowlist' allows pairing-approved sender", () => {
  withTempDir("dm-policy-allowlist-paired-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    store.addToAllowlist("telegram", "user-approved");
    const result = evaluateDmPolicy("user-approved", null, {
      policy: "allowlist",
      allowFrom: ["user-1"],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "pairing_approved");
  });
});

test("dm policy 'pairing' issues code for unknown sender", () => {
  withTempDir("dm-policy-pairing-issue-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("stranger-1", "Bob", {
      policy: "pairing",
      allowFrom: ["user-1"],
      pairingStore: store,
      channelType: "discord",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "pairing_code_issued");
    assert.ok(result.pairingCode);
    assert.equal(result.pairingCode.length, 8);
  });
});

test("dm policy 'pairing' allows known sender without code", () => {
  withTempDir("dm-policy-pairing-known-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const result = evaluateDmPolicy("user-1", "Alice", {
      policy: "pairing",
      allowFrom: ["user-1"],
      pairingStore: store,
      channelType: "telegram",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "allowlist_match");
    assert.equal(result.pairingCode, undefined);
  });
});

// ---------------------------------------------------------------------------
// FilePairingStore tests
// ---------------------------------------------------------------------------

test("FilePairingStore creates pairing and approves it", () => {
  withTempDir("pairing-approve-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    const req = store.createPairing("telegram", "user-new", "NewUser");
    assert.ok(req);
    assert.equal(req.code.length, 8);
    assert.equal(req.channelType, "telegram");
    assert.equal(req.senderId, "user-new");
    assert.equal(req.senderName, "NewUser");

    assert.equal(store.isApproved("telegram", "user-new"), false);
    assert.equal(store.listPending("telegram").length, 1);

    const approved = store.approvePairing("telegram", req.code);
    assert.equal(approved, true);

    assert.equal(store.isApproved("telegram", "user-new"), true);
    assert.equal(store.listPending("telegram").length, 0);
  });
});

test("FilePairingStore rejects pairing", () => {
  withTempDir("pairing-reject-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    const req = store.createPairing("discord", "user-spam", null);
    assert.ok(req);

    const rejected = store.rejectPairing("discord", req.code);
    assert.equal(rejected, true);

    assert.equal(store.isApproved("discord", "user-spam"), false);
    assert.equal(store.listPending("discord").length, 0);
  });
});

test("FilePairingStore returns existing code for same sender", () => {
  withTempDir("pairing-dedup-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    const first = store.createPairing("telegram", "user-dup", "Dup");
    const second = store.createPairing("telegram", "user-dup", "Dup");
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.code, second.code);
    assert.equal(store.listPending("telegram").length, 1);
  });
});

test("FilePairingStore enforces max pending per channel", () => {
  withTempDir("pairing-limit-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir, maxPendingPerChannel: 2 });

    const r1 = store.createPairing("telegram", "user-1", null);
    const r2 = store.createPairing("telegram", "user-2", null);
    const r3 = store.createPairing("telegram", "user-3", null);
    assert.ok(r1);
    assert.ok(r2);
    assert.equal(r3, null);
    assert.equal(store.listPending("telegram").length, 2);
  });
});

test("FilePairingStore code is case-insensitive for approval", () => {
  withTempDir("pairing-case-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    const req = store.createPairing("telegram", "user-ci", null);
    assert.ok(req);
    const approved = store.approvePairing("telegram", req.code.toLowerCase());
    assert.equal(approved, true);
    assert.equal(store.isApproved("telegram", "user-ci"), true);
  });
});

test("FilePairingStore approve with wrong code returns false", () => {
  withTempDir("pairing-wrong-code-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    store.createPairing("telegram", "user-x", null);
    const result = store.approvePairing("telegram", "ZZZZZZZZ");
    assert.equal(result, false);
    assert.equal(store.listPending("telegram").length, 1);
  });
});

test("FilePairingStore persists to disk and reloads", () => {
  withTempDir("pairing-persist-", (dir) => {
    const store1 = new FilePairingStore({ stateDir: dir });
    const req = store1.createPairing("whatsapp", "phone-123", "Phone");
    assert.ok(req);
    store1.approvePairing("whatsapp", req.code);

    store1.createPairing("whatsapp", "phone-456", null);

    // Create new store instance from same directory — should reload state
    const store2 = new FilePairingStore({ stateDir: dir });
    assert.equal(store2.isApproved("whatsapp", "phone-123"), true);
    assert.equal(store2.listPending("whatsapp").length, 1);
    assert.equal(store2.listPending("whatsapp")[0].senderId, "phone-456");
  });
});

test("FilePairingStore isolates channels", () => {
  withTempDir("pairing-isolation-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });

    store.createPairing("telegram", "user-tg", null);
    store.createPairing("discord", "user-dc", null);

    assert.equal(store.listPending("telegram").length, 1);
    assert.equal(store.listPending("discord").length, 1);
    assert.equal(store.listPending().length, 2);

    store.addToAllowlist("telegram", "user-tg");
    assert.equal(store.isApproved("telegram", "user-tg"), true);
    assert.equal(store.isApproved("discord", "user-tg"), false);
  });
});

test("FilePairingStore prunes expired entries", () => {
  withTempDir("pairing-expire-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir, expiresAfterSec: 0 });

    const req = store.createPairing("telegram", "user-exp", null);
    assert.ok(req);

    // expiresAfterSec=0 means it expires immediately; next listPending prunes it
    const pending = store.listPending("telegram");
    assert.equal(pending.length, 0);
  });
});

test("FilePairingStore code excludes ambiguous chars", () => {
  withTempDir("pairing-chars-", (dir) => {
    const store = new FilePairingStore({ stateDir: dir });
    const ambiguous = new Set(["0", "O", "1", "I"]);

    for (let i = 0; i < 20; i++) {
      const req = store.createPairing("telegram", `user-char-${i}`, null);
      assert.ok(req);
      for (const c of req.code) {
        assert.equal(ambiguous.has(c), false, `Code '${req.code}' contains ambiguous char '${c}'`);
      }
      // Clean up to allow next create (max pending limit)
      store.rejectPairing("telegram", req.code);
    }
  });
});
