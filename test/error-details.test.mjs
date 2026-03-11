import assert from "node:assert/strict";
import test from "node:test";

const { formatDetailedError } = await import("../dist/utils/error-details.js");

test("formatDetailedError extracts nested provider details", () => {
  const error = new Error("Provider request failed");
  error.cause = {
    status: 500,
    code: "server_error",
    type: "api_error",
    headers: {
      "x-request-id": "req-123",
    },
    error: {
      message: "Upstream timeout while generating response",
    },
    body: {
      error: {
        message: "The server had an error while processing your request.",
      },
    },
  };

  const out = formatDetailedError(error);

  assert.match(out, /Provider request failed/);
  assert.match(out, /Upstream timeout while generating response/);
  assert.match(out, /status=500/);
  assert.match(out, /code=server_error/);
  assert.match(out, /type=api_error/);
  assert.match(out, /request_id=req-123/);
});

test("formatDetailedError handles non-Error values", () => {
  assert.equal(formatDetailedError("plain failure"), "plain failure");
});
