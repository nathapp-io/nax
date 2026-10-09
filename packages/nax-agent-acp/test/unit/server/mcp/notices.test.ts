import { describe, expect, test } from "bun:test";
import { disconnectNotice, modeNotice, OPEN_NOTICE_TITLE, openNotice } from "#src/server/mcp/notices";

const scrub = (t: string) => t.replaceAll("sekret-value", "[REDACTED]");

describe("MCP notices", () => {
  test("open notice: one warning, one line per item, scrubbed and control-stripped", () => {
    expect(openNotice(true, ["`a`: failed sekret-value", "`b`:\u0007 x"], scrub)).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: OPEN_NOTICE_TITLE,
      description: "`a`: failed [REDACTED]\n`b`: x",
    });
    expect(openNotice(true, [], scrub)).toBeUndefined();
  });

  test("falls back to agent text without notice support", () => {
    const update = openNotice(false, ["`a`: failed"], scrub);
    expect(update?.sessionUpdate).toBe("agent_message_chunk");
  });

  test("mode notice is info and names the mode", () => {
    expect(modeNotice(true, "read")).toEqual({
      sessionUpdate: "notice",
      severity: "info",
      title: "MCP tools are off in read mode",
      description: "Switch to ask or full to use them.",
    });
  });

  test("disconnect notice names the server, scrubbed", () => {
    expect(disconnectNotice(true, "git", "exit sekret-value", scrub)).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "MCP server `git` disconnected",
      description: "exit [REDACTED]; reopen the session to reconnect",
    });
  });
});
