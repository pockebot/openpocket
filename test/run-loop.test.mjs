import assert from "node:assert/strict";
import test from "node:test";

const { runGatewayLoop } = await import("../dist/gateway/run-loop.js");

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("runGatewayLoop restarts on SIGUSR1 then stops on SIGTERM", async () => {
  let starts = 0;
  let stops = 0;

  const loopPromise = runGatewayLoop({
    start: async () => {
      starts += 1;
      return {
        stop: async () => {
          stops += 1;
        },
      };
    },
    log: () => {},
  });

  await waitTick();
  process.emit("SIGUSR1");
  await waitTick();
  process.emit("SIGTERM");
  await loopPromise;

  assert.equal(starts >= 2, true);
  assert.equal(stops >= 2, true);
});
