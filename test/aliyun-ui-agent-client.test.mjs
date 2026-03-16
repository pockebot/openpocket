import assert from "node:assert/strict";
import test from "node:test";

const { AliyunUiAgentClient } = await import("../dist/agent/aliyun-ui-agent-client.js");

function makeResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("AliyunUiAgentClient sends the mobile payload and reuses session ids", async () => {
  const requests = [];
  const responses = [
    makeResponse({
      session_id: "sess-1",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "The Weibo icon is visible on screen.",
                Explanation: "Tap the Weibo icon to open the app.",
                Operation: "Click (144, 248, 144, 248)",
              },
            },
          ],
        },
      ],
    }),
    makeResponse({
      session_id: "sess-1",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "The next screen requires a downward swipe.",
                Explanation: "Swipe up so the page scrolls down.",
                Operation: "Swipe (320, 900, 320, 300)",
              },
            },
          ],
        },
      ],
    }),
  ];

  const client = new AliyunUiAgentClient({
    apiKey: "dashscope-test-key",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const first = await client.nextStep({
    task: "Open Weibo",
    screenshotUrl: "https://example.com/screenshot-1.png",
    addInfo: "Prefer the visible app icon.",
  });
  assert.equal(first.sessionId, "sess-1");
  assert.equal(first.output.action.type, "tap");
  assert.equal(first.output.action.x, 144);
  assert.equal(first.output.action.y, 248);

  const firstRequest = requests[0];
  assert.equal(firstRequest.url, "https://dashscope.aliyuncs.com/api/v2/apps/gui-owl/gui_agent_server");
  assert.equal(firstRequest.init.method, "POST");
  assert.equal(firstRequest.init.headers.Authorization, "Bearer dashscope-test-key");
  assert.equal(firstRequest.init.headers["Content-Type"], "application/json");

  const firstPayload = JSON.parse(firstRequest.init.body);
  const firstMessages = firstPayload.input[0].content[0].data.messages;
  assert.deepEqual(firstMessages[0], { image: "https://example.com/screenshot-1.png" });
  assert.deepEqual(firstMessages[1], { instruction: "Open Weibo" });
  assert.deepEqual(firstMessages[2], { session_id: "" });
  assert.deepEqual(firstMessages[3], { device_type: "mobile" });
  assert.deepEqual(firstMessages[4], { pipeline_type: "agent" });
  assert.deepEqual(firstMessages[5], { model_name: "pre-gui_owl_7b" });
  assert.deepEqual(firstMessages[6], { thought_language: "english" });
  assert.deepEqual(firstMessages[7], { param_list: [{ add_info: "Prefer the visible app icon." }] });

  const second = await client.nextStep({
    task: "Scroll down",
    screenshotUrl: "https://example.com/screenshot-2.png",
  });
  assert.equal(second.sessionId, "sess-1");
  assert.equal(second.output.action.type, "swipe");
  assert.equal(second.output.action.x1, 320);
  assert.equal(second.output.action.y1, 900);
  assert.equal(second.output.action.x2, 320);
  assert.equal(second.output.action.y2, 300);

  const secondPayload = JSON.parse(requests[1].init.body);
  assert.deepEqual(secondPayload.input[0].content[0].data.messages[2], { session_id: "sess-1" });
});

test("AliyunUiAgentClient falls back to wait for unsupported operations", async () => {
  const client = new AliyunUiAgentClient({
    apiKey: "dashscope-test-key",
    fetchImpl: async () => makeResponse({
      session_id: "sess-unsupported",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "This operation type is not supported yet.",
                Explanation: "Hover over the control.",
                Operation: "Hover (300, 500)",
              },
            },
          ],
        },
      ],
    }),
  });

  const result = await client.nextStep({
    task: "Hover over a control",
    screenshotUrl: "https://example.com/screenshot-unsupported.png",
  });

  assert.equal(result.sessionId, "sess-unsupported");
  assert.equal(result.output.action.type, "wait");
  assert.match(result.output.action.reason || "", /unsupported/i);
});

test("AliyunUiAgentClient maps type key_press and scroll operations", async () => {
  const responses = [
    makeResponse({
      session_id: "sess-ops",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "The search box is focused.",
                Explanation: "Type the query into the active input.",
                Operation: "Type (OpenPocket)",
              },
            },
          ],
        },
      ],
    }),
    makeResponse({
      session_id: "sess-ops",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "Return to the launcher first.",
                Explanation: "Press the home key.",
                Operation: "Key_press (HOME)",
              },
            },
          ],
        },
      ],
    }),
    makeResponse({
      session_id: "sess-ops",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "More results are lower on the page.",
                Explanation: "Scroll down once.",
                Operation: "Scroll (down)",
              },
            },
          ],
        },
      ],
    }),
  ];

  const client = new AliyunUiAgentClient({
    apiKey: "dashscope-test-key",
    fetchImpl: async () => responses.shift(),
  });

  const typed = await client.nextStep({
    task: "Search for OpenPocket",
    screenshotUrl: "https://example.com/typed.png",
  });
  assert.equal(typed.output.action.type, "type");
  assert.equal(typed.output.action.text, "OpenPocket");

  const keyPress = await client.nextStep({
    task: "Return home",
    screenshotUrl: "https://example.com/home.png",
  });
  assert.equal(keyPress.output.action.type, "keyevent");
  assert.equal(keyPress.output.action.keycode, "KEYCODE_HOME");

  const scrolled = await client.nextStep({
    task: "Scroll down",
    screenshotUrl: "https://example.com/scroll.png",
    viewportWidth: 1000,
    viewportHeight: 2000,
  });
  assert.equal(scrolled.output.action.type, "swipe");
  assert.equal(scrolled.output.action.x1, 500);
  assert.equal(scrolled.output.action.y1, 1500);
  assert.equal(scrolled.output.action.x2, 500);
  assert.equal(scrolled.output.action.y2, 500);
});

test("AliyunUiAgentClient rejects non-success payload codes and fail operations", async () => {
  const responses = [
    makeResponse({
      session_id: "sess-error-code",
      output: [
        {
          code: "500",
          content: [
            {
              data: {
                Thought: "The platform rejected the request.",
                Explanation: "Temporary backend issue.",
                Operation: "Wait ()",
              },
            },
          ],
        },
      ],
    }),
    makeResponse({
      session_id: "sess-fail",
      output: [
        {
          code: "200",
          content: [
            {
              data: {
                Thought: "The requested screen is unavailable.",
                Explanation: "Unable to continue because the app blocked automation.",
                Operation: "Fail (app blocked automation)",
              },
            },
          ],
        },
      ],
    }),
  ];

  const client = new AliyunUiAgentClient({
    apiKey: "dashscope-test-key",
    fetchImpl: async () => responses.shift(),
  });

  await assert.rejects(
    () => client.nextStep({
      task: "Open a blocked app",
      screenshotUrl: "https://example.com/error-code.png",
    }),
    /error code 500/i,
  );

  await assert.rejects(
    () => client.nextStep({
      task: "Open a blocked app",
      screenshotUrl: "https://example.com/fail.png",
    }),
    /reported failure/i,
  );
});
