/**
 * AC-5..AC-10: the chat host resolves its session model's context window once
 * per model string, through `_chatHostDeps.lookupContextWindow`, and never lets
 * the lookup fail a session operation.
 *
 * The host is built by `createChatHost` through the shared subagent harness, so
 * `start`, `resume` and `switchTo` run the real opener against scripted sessions.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_MODEL, makeSubagentHostHarness, type SubagentHostHarness, withDepsRestore } from "@test/helpers";
import { _chatHostDeps } from "@/chat/chat-host";

type Lookup = typeof _chatHostDeps.lookupContextWindow;

const WINDOW = 200_000;

let harness: SubagentHostHarness | undefined;
let lookup: ReturnType<typeof mock<Lookup>>;
/** What the stubbed catalog knows, keyed `"<provider>/<model>"`. */
let windows: Map<string, number>;
let lookupFails: boolean;

describe("chat host context window", () => {
  withDepsRestore(_chatHostDeps);

  beforeEach(() => {
    windows = new Map([
      [CHAT_MODEL, WINDOW],
      ["anthropic/m1", WINDOW],
    ]);
    lookupFails = false;
    lookup = mock<Lookup>(async (provider, model) => {
      if (lookupFails) throw new Error("catalog unavailable");
      return windows.get(`${provider}/${model}`);
    });
    _chatHostDeps.lookupContextWindow = lookup;
  });

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  function setup(): SubagentHostHarness {
    harness = makeSubagentHostHarness();
    return harness;
  }

  test("AC-5 AC-6 start exposes the session model's context window and looks it up by provider and model", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: "anthropic/m1" });
    expect(h.host.current().contextWindow).toBe(WINDOW);
    expect(lookup).toHaveBeenCalledWith("anthropic", "m1");
  });

  test("AC-7 switching to a model with no catalog window leaves contextWindow undefined", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: "anthropic/m1" });
    await h.host.switchTo({ model: "anthropic/m2" });
    expect(h.host.current().model).toBe("anthropic/m2");
    expect(h.host.current().contextWindow).toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("anthropic", "m2");
  });

  test("AC-8 a rejecting lookup leaves start resolved and contextWindow undefined", async () => {
    lookupFails = true;
    const h = setup();
    await expect(h.host.start({ mode: "guarded", model: "anthropic/m1" })).resolves.toBeUndefined();
    expect(h.host.current().model).toBe("anthropic/m1");
    expect(h.host.current().contextWindow).toBeUndefined();
  });

  test("AC-9 switching mode on the same model reads the window once", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: "anthropic/m1" });
    await h.host.switchTo({ mode: "full" });
    expect(h.host.current().mode).toBe("full");
    expect(h.host.current().contextWindow).toBe(WINDOW);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("AC-10 a model string without a provider is never looked up", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: "test-model" });
    expect(h.host.current().model).toBe("test-model");
    expect(h.host.current().contextWindow).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  test("resume resolves the resumed session's model window", async () => {
    const h = setup();
    await h.storeSession("prior");
    await h.host.resume({ id: "prior" });
    expect(h.host.current().model).toBe(CHAT_MODEL);
    expect(h.host.current().contextWindow).toBe(WINDOW);
    expect(lookup).toHaveBeenCalledWith("anthropic", "chat-model");
  });
});
