import { describe, expect, test } from "bun:test";
import { announce, notice } from "#src/server/translate/notice";

describe("notice", () => {
  test("builds a notice update, with the description only when given", () => {
    expect(notice("info", "Response restarted")).toEqual({
      sessionUpdate: "notice",
      severity: "info",
      title: "Response restarted",
    });
    expect(notice("warning", "Turn timed out", "limit 60s")).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Turn timed out",
      description: "limit 60s",
    });
  });
});

describe("announce", () => {
  test("a notice when the client supports notices, else agent message text", () => {
    expect(announce(true, "info", "T", "d")).toEqual(notice("info", "T", "d"));
    expect(announce(false, "warning", "T")).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n\nT\n\n" },
    });
  });
});
