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
