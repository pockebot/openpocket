import assert from "node:assert/strict";
import test from "node:test";

const {
  normalizeCronManagementIntent,
  hasCronManagementPatch,
  hasCronManagementSelector,
} = await import("../dist/gateway/cron-management-intent.js");

test("cron management intent normalization supports remove-all requests", () => {
  const intent = normalizeCronManagementIntent({
    action: "remove",
    selector: {
      all: true,
    },
  });

  assert.deepEqual(intent, {
    action: "remove",
    selector: {
      all: true,
      ids: [],
      nameContains: [],
      taskContains: [],
      scheduleContains: [],
      enabled: "any",
    },
    patch: {
      name: null,
      task: null,
      enabled: null,
      schedule: null,
    },
  });
  assert.equal(hasCronManagementSelector(intent.selector), true);
  assert.equal(hasCronManagementPatch(intent.patch), false);
});

test("cron management intent normalization derives enabled patch for disable actions", () => {
  const intent = normalizeCronManagementIntent({
    action: "disable",
    selector: {
      ids: ["earn-app-daily-check"],
    },
  });

  assert.equal(intent.action, "disable");
  assert.equal(intent.patch.enabled, false);
  assert.equal(intent.selector.ids[0], "earn-app-daily-check");
});
