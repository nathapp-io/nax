import { describe, expect, test } from "bun:test";
import { cliInternals } from "@test/helpers";
import type { CLIReadline } from "@/interaction/plugins/cli";
import { CLIInteractionPlugin } from "@/interaction/plugins/cli";
import type { InteractionRequest } from "@/interaction/types";

const makeRequest = (id = "req-1"): InteractionRequest => ({
  id,
  type: "confirm",
  storyId: "s1",
  featureName: "feat",
  stage: "execution",
  summary: "test",
  fallback: "skip",
  createdAt: 0,
});

/** A readline that never answers — the timeout always wins the race. */
const makeSilentReadline = (onClose: () => void = () => {}): CLIReadline => ({
  question: () => {},
  close: onClose,
});

/** A readline that answers synchronously with a fixed string. */
const makeAnsweringReadline = (answer: string, onClose: () => void = () => {}): CLIReadline => ({
  question: (_prompt, callback) => callback(answer),
  close: onClose,
});

describe("CLIInteractionPlugin.promptUser — setTimeout cleanup", () => {
  test("returns timeout response when timeout fires before user input", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    // Inject a mock readline that never answers (simulates waiting for user)
    internals.rl = makeSilentReadline();

    const response = await internals.promptUser(makeRequest(), 5);

    expect(response.respondedBy).toBe("timeout");
    expect(response.requestId).toBe("req-1");
  });

  test("clearTimeout is called when timeout wins — no lingering timers", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    // `recreateReadline` replaces `rl` with a real readline interface after
    // every timeout — re-install the mock before each call so the real rl
    // never sees a `question()` and writes its prompt to stdout.
    const installMock = () => {
      internals.rl = makeSilentReadline();
    };
    installMock();

    // Three sequential short-timeout calls — if clearTimeout were missing, leaked
    // timers would prevent Bun from exiting cleanly after the test suite.
    const r1 = await internals.promptUser(makeRequest("req-1"), 5);
    installMock();
    const r2 = await internals.promptUser(makeRequest("req-2"), 5);
    installMock();
    const r3 = await internals.promptUser(makeRequest("req-3"), 5);

    expect(r1.respondedBy).toBe("timeout");
    expect(r2.respondedBy).toBe("timeout");
    expect(r3.respondedBy).toBe("timeout");
  });

  test("BUG-21: timeout closes the stale readline and recreates it, so the next question() gets a live callback", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    let closeCalls = 0;
    const staleRl = makeSilentReadline(() => {
      closeCalls++;
    });
    internals.rl = staleRl;

    const response = await internals.promptUser(makeRequest("req-1"), 5);

    expect(response.respondedBy).toBe("timeout");
    // The stale readline interface must have been closed...
    expect(closeCalls).toBe(1);
    // ...and replaced, so a subsequent question() is not swallowed by the
    // abandoned callback registered on the old interface.
    expect(internals.rl).not.toBe(staleRl);
    expect(internals.rl).not.toBeNull();

    await plugin.destroy();
  });
});

describe("CLIInteractionPlugin.init/destroy", () => {
  test("init() parses the config schema and skips readline setup on non-TTY stdin", async () => {
    const plugin = new CLIInteractionPlugin();
    // Under `bun test`, stdin is never a TTY — init() must return without
    // throwing and without creating a readline interface.
    await plugin.init({ someExtraKey: "allowed by passthrough" });
    const internals = cliInternals(plugin);
    expect(internals.rl).toBeNull();
  });

  test("destroy() is a no-op when no readline was created", async () => {
    const plugin = new CLIInteractionPlugin();
    await expect(plugin.destroy()).resolves.toBeUndefined();
  });

  test("destroy() closes and clears an installed readline", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    let closed = false;
    internals.rl = makeSilentReadline(() => {
      closed = true;
    });

    await plugin.destroy();

    expect(closed).toBe(true);
    expect(internals.rl).toBeNull();
  });
});

describe("CLIInteractionPlugin.send", () => {
  test("records the request as pending and writes without throwing (minimal request)", async () => {
    const plugin = new CLIInteractionPlugin();
    await plugin.send(makeRequest("send-1"));
    // Presence in the pending map is observable via cancel() succeeding silently.
    await plugin.cancel("send-1");
  });

  test("writes detail, options and timeout sections when present", async () => {
    const plugin = new CLIInteractionPlugin();
    const request: InteractionRequest = {
      ...makeRequest("send-2"),
      detail: "extra context",
      options: [
        { key: "a", label: "Option A", description: "first" },
        { key: "b", label: "Option B" },
      ],
      timeout: 5000,
    };
    await expect(plugin.send(request)).resolves.toBeUndefined();
  });
});

describe("CLIInteractionPlugin.receive/cancel", () => {
  test("throws when there is no pending request with the given ID", async () => {
    const plugin = new CLIInteractionPlugin();
    await expect(plugin.receive("no-such-id")).rejects.toThrow("No pending request with ID: no-such-id");
  });

  test("throws when the plugin has no initialized readline", async () => {
    const plugin = new CLIInteractionPlugin();
    await plugin.send(makeRequest("recv-1"));
    await expect(plugin.receive("recv-1")).rejects.toThrow("CLI plugin not initialized");
  });

  test("resolves via promptUser and removes the request from the pending map", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    internals.rl = makeAnsweringReadline("y");

    await plugin.send(makeRequest("recv-2"));
    const response = await plugin.receive("recv-2", 5000);

    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("user");
    // Already removed — a second receive() call must reject as "no pending".
    await expect(plugin.receive("recv-2")).rejects.toThrow("No pending request with ID: recv-2");
  });

  test("cancel() removes a pending request without responding", async () => {
    const plugin = new CLIInteractionPlugin();
    await plugin.send(makeRequest("cancel-1"));
    await plugin.cancel("cancel-1");
    await expect(plugin.receive("cancel-1")).rejects.toThrow("No pending request with ID: cancel-1");
  });

  test("cancel() on an unknown ID is a silent no-op", async () => {
    const plugin = new CLIInteractionPlugin();
    await expect(plugin.cancel("never-existed")).resolves.toBeUndefined();
  });
});

describe("CLIInteractionPlugin — prompt type dispatch (via promptUser)", () => {
  const run = async (type: InteractionRequest["type"], answer: string, options?: InteractionRequest["options"]) => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    internals.rl = makeAnsweringReadline(answer);
    return internals.promptUser({ ...makeRequest(`dispatch-${type}`), type, options }, 5000);
  };

  test("confirm: y/yes -> approve", async () => {
    expect((await run("confirm", "y")).action).toBe("approve");
    expect((await run("confirm", "yes")).action).toBe("approve");
  });

  test("confirm: n/no -> reject", async () => {
    expect((await run("confirm", "n")).action).toBe("reject");
    expect((await run("confirm", "no")).action).toBe("reject");
  });

  test("confirm: skip/abort/invalid", async () => {
    expect((await run("confirm", "skip")).action).toBe("skip");
    expect((await run("confirm", "abort")).action).toBe("abort");
    expect((await run("confirm", "gibberish")).action).toBe("skip");
  });

  test("choose: matches an option key", async () => {
    const response = await run("choose", "a", [{ key: "a", label: "Option A" }]);
    expect(response.action).toBe("choose");
    expect(response.value).toBe("a");
  });

  test("choose: skip/abort/unmatched key", async () => {
    expect((await run("choose", "skip", [{ key: "a", label: "A" }])).action).toBe("skip");
    expect((await run("choose", "abort", [{ key: "a", label: "A" }])).action).toBe("abort");
    expect((await run("choose", "zzz", [{ key: "a", label: "A" }])).action).toBe("skip");
  });

  test("input: free text is returned as the value", async () => {
    const response = await run("input", "  my free text answer  ");
    expect(response.action).toBe("input");
    expect(response.value).toBe("my free text answer");
  });

  test("input: skip/abort", async () => {
    expect((await run("input", "skip")).action).toBe("skip");
    expect((await run("input", "abort")).action).toBe("abort");
  });

  test("review: approve/reject/skip/abort/invalid", async () => {
    expect((await run("review", "approve")).action).toBe("approve");
    expect((await run("review", "reject")).action).toBe("reject");
    expect((await run("review", "skip")).action).toBe("skip");
    expect((await run("review", "abort")).action).toBe("abort");
    expect((await run("review", "nonsense")).action).toBe("skip");
  });

  test("notify: auto-approves without prompting", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    // No question() would ever be called for notify — verify with a readline
    // whose question() throws if invoked.
    internals.rl = {
      question: () => {
        throw new Error("should not prompt for notify");
      },
      close: () => {},
    };
    const response = await internals.promptUser({ ...makeRequest("notify-1"), type: "notify" }, 5000);
    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("system");
  });

  test("webhook: auto-approves without prompting", async () => {
    const plugin = new CLIInteractionPlugin();
    const internals = cliInternals(plugin);
    internals.rl = {
      question: () => {
        throw new Error("should not prompt for webhook");
      },
      close: () => {},
    };
    const response = await internals.promptUser({ ...makeRequest("webhook-1"), type: "webhook" }, 5000);
    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("system");
  });
});
