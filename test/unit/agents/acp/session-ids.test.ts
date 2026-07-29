/**
 * Tests for parseSessionIds - extracted verbatim from spawn-client.ts.
 *
 * Reads the JSON line emitted by `acpx --format json sessions ensure`, scanning
 * from the last line backwards so a banner or warning above it is ignored.
 */

import { describe, expect, test } from "bun:test";
import { parseSessionIds } from "@/agents/acp/session-ids";

describe("parseSessionIds", () => {
  test("reads both ids from the ensure line", () => {
    const line = JSON.stringify({
      action: "session_ensured",
      created: true,
      acpxRecordId: "rec-1",
      acpxSessionId: "sess-1",
      name: "s1",
    });
    expect(parseSessionIds(line)).toEqual({ sessionId: "sess-1", recordId: "rec-1" });
  });

  test("ignores non-JSON banner lines above the payload", () => {
    const line = JSON.stringify({ acpxRecordId: "rec-2", acpxSessionId: "sess-2" });
    expect(parseSessionIds(`[acpx] cwd: /tmp\n${line}`)).toEqual({ sessionId: "sess-2", recordId: "rec-2" });
  });

  test("returns undefined recordId when absent", () => {
    const line = JSON.stringify({ acpxSessionId: "sess-3" });
    expect(parseSessionIds(line)).toEqual({ sessionId: "sess-3", recordId: undefined });
  });

  test("returns undefined for both when no session id is present", () => {
    expect(parseSessionIds("no json here")).toEqual({ sessionId: undefined, recordId: undefined });
    expect(parseSessionIds(JSON.stringify({ acpxRecordId: "rec-4" }))).toEqual({
      sessionId: undefined,
      recordId: undefined,
    });
  });

  test("survives malformed JSON without throwing", () => {
    expect(parseSessionIds("{not valid json")).toEqual({ sessionId: undefined, recordId: undefined });
  });
});
