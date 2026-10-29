import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  createOwnToolLedger,
  MAX_OWN_TOOL_CALL_ID_CHARS,
  MAX_OWN_TOOL_CALLS,
  MAX_OWN_TOOL_FIELD_CHARS,
  mcpCallIdentityOf,
} from "#src/client/own-tool-calls";

const SERVER = "nax-0badc0de";

const cursorRaw = (extra: Record<string, unknown> = {}) => ({
  providerIdentifier: SERVER,
  toolName: "lookup",
  args: {},
  ...extra,
});
const codexRaw = { server: SERVER, tool: "lookup", arguments: {} };

const callUpdate = (toolCallId: string, rawInput?: unknown): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: "x",
  ...(rawInput === undefined ? {} : { rawInput }),
});
const patchUpdate = (toolCallId: string, rawInput?: unknown, title?: string): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  ...(title === undefined ? {} : { title }),
  ...(rawInput === undefined ? {} : { rawInput }),
});

describe("mcpCallIdentityOf", () => {
  test("AC-1: cursor tool_call_update", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", cursorRaw()))).toEqual({
      toolCallId: "t1",
      server: SERVER,
      tool: "lookup",
    });
  });

  test("AC-2: cursor tool_call", () => {
    expect(mcpCallIdentityOf("cursor", callUpdate("t1", cursorRaw()))).toEqual({
      toolCallId: "t1",
      server: SERVER,
      tool: "lookup",
    });
  });

  test("AC-3: codex tool_call", () => {
    expect(mcpCallIdentityOf("codex", callUpdate("t2", codexRaw))).toEqual({
      toolCallId: "t2",
      server: SERVER,
      tool: "lookup",
    });
  });

  test("AC-4: codex tool_call_update", () => {
    expect(mcpCallIdentityOf("codex", patchUpdate("t2", codexRaw))).toEqual({
      toolCallId: "t2",
      server: SERVER,
      tool: "lookup",
    });
  });

  test("AC-5: a codex reader ignores the cursor shape", () => {
    expect(mcpCallIdentityOf("codex", patchUpdate("t1", cursorRaw()))).toBeUndefined();
  });

  test("a cursor reader ignores the codex shape", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t2", codexRaw))).toBeUndefined();
  });

  test("AC-6: a numeric providerIdentifier is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", cursorRaw({ providerIdentifier: 7 })))).toBeUndefined();
  });

  test("AC-7: an empty providerIdentifier is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", cursorRaw({ providerIdentifier: "" })))).toBeUndefined();
  });

  test("AC-8: a string rawInput is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", "lookup"))).toBeUndefined();
  });

  test("AC-9: a missing toolName is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", { providerIdentifier: SERVER }))).toBeUndefined();
  });

  test("AC-10: an empty codex tool is undefined", () => {
    expect(mcpCallIdentityOf("codex", callUpdate("t2", { server: SERVER, tool: "" }))).toBeUndefined();
  });

  test("AC-11: a title alone is never read", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", undefined, `${SERVER}-lookup: lookup`))).toBeUndefined();
  });

  test("AC-12: an unrelated update is undefined", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    };
    expect(mcpCallIdentityOf("cursor", update)).toBeUndefined();
  });

  test("an empty toolCallId is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("", cursorRaw()))).toBeUndefined();
  });

  test("a null or array rawInput is undefined", () => {
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", null))).toBeUndefined();
    expect(mcpCallIdentityOf("cursor", patchUpdate("t1", [cursorRaw()]))).toBeUndefined();
  });
});

describe("createOwnToolLedger", () => {
  const cursorLedger = () => createOwnToolLedger({ kind: "cursor", serverName: SERVER, toolNames: ["lookup"] });

  test("AC-13: an observed matching call is own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw()));
    expect(ledger.isOwn("t1")).toBe(true);
  });

  test("AC-14: an id never observed is not own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw()));
    expect(ledger.isOwn("t9")).toBe(false);
  });

  test("AC-15: another server is not own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw({ providerIdentifier: "nax" })));
    expect(ledger.isOwn("t1")).toBe(false);
  });

  test("AC-16: a tool outside toolNames is not own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw({ toolName: "other" })));
    expect(ledger.isOwn("t1")).toBe(false);
  });

  test("AC-17: a later different tool makes the id permanently non-own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw()));
    ledger.observe(patchUpdate("t1", cursorRaw({ toolName: "other" })));
    expect(ledger.isOwn("t1")).toBe(false);
    ledger.observe(patchUpdate("t1", cursorRaw()));
    expect(ledger.isOwn("t1")).toBe(false);
  });

  test("AC-18: a wrong server followed by the right one stays non-own", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw({ providerIdentifier: "nax" })));
    ledger.observe(patchUpdate("t1", cursorRaw()));
    expect(ledger.isOwn("t1")).toBe(false);
  });

  test("the same identity reported twice, as tool_call then update, stays own", () => {
    const ledger = cursorLedger();
    ledger.observe(callUpdate("t1", cursorRaw()));
    ledger.observe(patchUpdate("t1", cursorRaw()));
    expect(ledger.isOwn("t1")).toBe(true);
  });

  test("a report without structured fields neither adds nor erases evidence", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("t1", cursorRaw()));
    ledger.observe(patchUpdate("t1", undefined, "title"));
    ledger.observe({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(ledger.isOwn("t1")).toBe(true);
  });

  test("a codex ledger reads the codex shape only", () => {
    const ledger = createOwnToolLedger({ kind: "codex", serverName: SERVER, toolNames: ["lookup"] });
    ledger.observe(patchUpdate("c1", codexRaw));
    ledger.observe(patchUpdate("c2", cursorRaw()));
    expect(ledger.isOwn("c1")).toBe(true);
    expect(ledger.isOwn("c2")).toBe(false);
  });

  test("past MAX_OWN_TOOL_CALLS distinct ids, new ids are never own; tracked ids still update", () => {
    const ledger = cursorLedger();
    for (let i = 0; i < MAX_OWN_TOOL_CALLS; i++) ledger.observe(patchUpdate(`id${i}`, cursorRaw()));
    ledger.observe(patchUpdate("overflow", cursorRaw()));
    expect(ledger.isOwn("overflow")).toBe(false);
    expect(ledger.isOwn("id0")).toBe(true);
    ledger.observe(patchUpdate("id0", cursorRaw({ toolName: "other" })));
    expect(ledger.isOwn("id0")).toBe(false);
  });

  test("an id longer than MAX_OWN_TOOL_CALL_ID_CHARS is never tracked", () => {
    const ledger = cursorLedger();
    const long = "x".repeat(MAX_OWN_TOOL_CALL_ID_CHARS + 1);
    ledger.observe(patchUpdate(long, cursorRaw()));
    expect(ledger.isOwn(long)).toBe(false);
  });

  test("an oversized server or tool name is never own, even if it is in toolNames", () => {
    const long = "y".repeat(MAX_OWN_TOOL_FIELD_CHARS + 1);
    const ledger = createOwnToolLedger({ kind: "cursor", serverName: long, toolNames: [long] });
    ledger.observe(patchUpdate("t1", { providerIdentifier: long, toolName: long }));
    expect(ledger.isOwn("t1")).toBe(false);
  });

  test("ids are tracked independently", () => {
    const ledger = cursorLedger();
    ledger.observe(patchUpdate("a", cursorRaw({ toolName: "other" })));
    ledger.observe(patchUpdate("b", cursorRaw()));
    expect(ledger.isOwn("a")).toBe(false);
    expect(ledger.isOwn("b")).toBe(true);
  });
});
