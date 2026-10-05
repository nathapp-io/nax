import { expect, test } from "bun:test";
import * as pub from "@nathapp/nax-agent";

test("the backend kit is public on the package entry", () => {
  for (const name of [
    "redactSecrets",
    "capStrings",
    "killProcessGroup",
    "isProcessAlive",
    "createStderrTail",
    "TOOL_CALL_INPUT_BYTES",
    "TOOL_RESULT_PREVIEW_BYTES",
  ]) {
    expect(name in pub).toBe(true);
  }
  expect(pub.TOOL_CALL_INPUT_BYTES).toBe(8192);
  expect(pub.TOOL_RESULT_PREVIEW_BYTES).toBe(4096);
});
