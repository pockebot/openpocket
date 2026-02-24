import assert from "node:assert/strict";
import test from "node:test";

const { TELEGRAM_MENU_COMMANDS } = await import("../dist/gateway/telegram-gateway.js");

test("telegram command menu includes control commands for bot menu", () => {
  const commands = TELEGRAM_MENU_COMMANDS.map((item) => item.command);
  const expected = [
    "start",
    "help",
    "context",
    "status",
    "model",
    "startvm",
    "stopvm",
    "hidevm",
    "showvm",
    "screen",
    "skills",
    "clear",
    "new",
    "reset",
    "stop",
    "restart",
    "cronrun",
    "auth",
    "run",
  ];

  for (const command of expected) {
    assert.equal(commands.includes(command), true, `missing command: ${command}`);
  }
});

test("telegram command menu uses Telegram-compatible command schema", () => {
  for (const item of TELEGRAM_MENU_COMMANDS) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/);
    assert.equal(typeof item.description, "string");
    assert.equal(item.description.length > 0, true);
    assert.equal(item.description.length <= 256, true);
  }
});
