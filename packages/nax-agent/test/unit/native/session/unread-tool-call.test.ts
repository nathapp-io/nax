/**
 * US-002 — the built-in `before_turn_end` handler that asks once for a retry
 * when the last reply holds a literal `<tool_call>` block.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createInvalidCallBudget } from "#src/native/session/handle-invalid-tool-call";
import { createLoopEventRegistry, type LoopEventRegistry } from "#src/native/session/loop-events/index";
import type { BeforeTurnEndPayload } from "#src/native/session/loop-events/types";
import { registerBuiltinLoopHandlers } from "#src/native/session/loop-handlers";
import { createNativeSessionState } from "#src/native/session/session";
import { seedNativeSession } from "#test/helpers/index";

const SESSION = "sess-unread-tool-call";
const BLOCK = '<tool_call>{"name":"ScrashpadWrite"}</tool_call>';

let registry: LoopEventRegistry;
let unread: { sent: boolean };

function install(toolNames: () => readonly string[]): void {
  registry = createLoopEventRegistry();
  unread = { sent: false };
  registerBuiltinLoopHandlers(registry, {
    sessionName: SESSION,
    sessionState: seedNativeSession(createNativeSessionState(), SESSION, { transcriptDir: "unused" }),
    budget: createInvalidCallBudget(),
    onSpinStop: () => {},
    toolNames,
    unreadToolCall: unread,
  });
}

function payload(over: Partial<BeforeTurnEndPayload> = {}): BeforeTurnEndPayload {
  return {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: BLOCK },
    ],
    roundTrips: 1,
    ended: "completed",
    stopped: false,
    followUpsSoFar: 0,
    ...over,
  };
}

describe("unread tool-call handler", () => {
  beforeEach(() => install(() => ["Read", "Write"]));

  test("AC-10: a last user message yields {} and leaves sent false", async () => {
    const patch = await registry.dispatch(
      "before_turn_end",
      payload({
        messages: [
          { role: "assistant", content: BLOCK },
          { role: "user", content: BLOCK },
        ],
      }),
    );
    expect(patch).toEqual({});
    expect(unread.sent).toBe(false);
  });

  test("follows up once, naming the tools, and marks sent", async () => {
    const patch = await registry.dispatch("before_turn_end", payload());
    // US-006: the block names ScrashpadWrite, which is neither Read nor Write
    // and is more than MAX_SUGGEST_DISTANCE from both, so it is named without
    // a suggestion.
    expect(patch.followUp).toBe(
      "Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: Read, Write. `ScrashpadWrite` is not a declared tool.",
    );
    expect(unread.sent).toBe(true);
    expect(await registry.dispatch("before_turn_end", payload())).toEqual({});
  });

  test("no follow-up when stopped or not completed", async () => {
    expect(await registry.dispatch("before_turn_end", payload({ stopped: true }))).toEqual({});
    expect(await registry.dispatch("before_turn_end", payload({ ended: "aborted" }))).toEqual({});
    expect(unread.sent).toBe(false);
  });

  test("no follow-up without the literal block", async () => {
    const patch = await registry.dispatch(
      "before_turn_end",
      payload({ messages: [{ role: "assistant", content: "plain" }] }),
    );
    expect(patch).toEqual({});
  });

  test("AC-11: with no tools the follow-up says (none) and names the mistake", async () => {
    install(() => []);
    const patch = await registry.dispatch("before_turn_end", payload());
    expect(patch.followUp).toContain("using one of these exact names: (none).");
    expect(patch.followUp).toEndWith("`ScrashpadWrite` is not a declared tool.");
  });
});
