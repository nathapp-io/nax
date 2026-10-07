// test/unit/agents/acp-sdk/tool-audit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { createAuditRecorder } from "@/agents/acp-sdk/tool-audit";

const AT = new Date("2026-10-07T00:00:00.000Z");
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-sdk-audit-");
});
afterEach(() => cleanupTempDir(dir));

function rows(): Array<Record<string, unknown>> {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const body = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as { calls: Array<Record<string, unknown>> };
  return body.calls;
}

function recorder() {
  return createAuditRecorder(
    "nax-s",
    { dir, header: { runId: "run-1", storyId: "US-1", sessionRole: "implementer" } },
    () => AT,
  );
}

describe("createAuditRecorder (spec §7.4, D3-j)", () => {
  test("a call and its result are one row", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } });
    audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "abc", resultBytes: 1234 });
    await audit.flush();
    expect(rows()).toEqual([
      {
        tool: "Read",
        outcome: "ok",
        input: { path: "a.ts" },
        resultBytes: 1234,
        storyId: "US-1",
        at: AT.toISOString(),
        toolCallId: "c1",
      },
    ]);
  });

  test("an error result is outcome error; a missing resultBytes falls back to the preview's bytes", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "x" } });
    audit.onEvent({ type: "tool_result", callId: "c1", isError: true, preview: "héllo" });
    await audit.flush();
    expect(rows()[0]).toMatchObject({ outcome: "error", resultBytes: 6 });
  });

  test("a denied call is one denied row (Review Focus 3)", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Write", input: { path: "x" } });
    audit.denied("c1", "Write", "profile read");
    audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "refused" });
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ tool: "Write", outcome: "denied", reason: "profile read" })]);
  });

  test("a deny with no pending call is written at once with empty input", async () => {
    const audit = recorder();
    audit.denied(undefined, "Edit", "profile read");
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ tool: "Edit", outcome: "denied", input: {}, resultBytes: 0 })]);
  });

  test("a call still pending at flush is written as error with 0 bytes", async () => {
    const audit = recorder();
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Bash", input: "ls" });
    await audit.flush();
    expect(rows()).toEqual([expect.objectContaining({ outcome: "error", resultBytes: 0, input: { value: "ls" } })]);
  });

  test("non-tool events are ignored, and no target means nothing is written", async () => {
    const audit = createAuditRecorder("nax-s", undefined);
    audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    audit.onEvent({ type: "text_delta", text: "x", round: 1 });
    await audit.flush();
    expect(readdirSync(dir)).toEqual([]);
  });
});
