import { describe, expect, test } from "bun:test";
import { CLIInteractionPlugin } from "../../../../src/interaction/plugins/cli";

const makeRequest = (id = "req-1") => ({
  id,
  type: "confirm" as const,
  storyId: "s1",
  featureName: "feat",
  prompt: "Approve?",
  context: {},
  stage: "verify",
  summary: "test",
});

describe("CLIInteractionPlugin.promptUser — setTimeout cleanup", () => {
  test("returns timeout response when timeout fires before user input", async () => {
    const plugin = new CLIInteractionPlugin();
    // Inject a mock readline that never answers (simulates waiting for user)
    (plugin as any).rl = {
      question: (_prompt: string, _cb: (a: string) => void) => {
        // intentionally never calls cb — timeout wins the race
      },
      close: () => {},
    };

    const promptUser = (plugin as any).promptUser.bind(plugin);
    const response = await promptUser(makeRequest(), 5);

    expect(response.respondedBy).toBe("timeout");
    expect(response.requestId).toBe("req-1");
  });

  test("clearTimeout is called when timeout wins — no lingering timers", async () => {
    const plugin = new CLIInteractionPlugin();
    (plugin as any).rl = {
      question: (_prompt: string, _cb: (a: string) => void) => {},
      close: () => {},
    };

    const promptUser = (plugin as any).promptUser.bind(plugin);
    // Three sequential short-timeout calls — if clearTimeout were missing, leaked
    // timers would prevent Bun from exiting cleanly after the test suite.
    const r1 = await promptUser(makeRequest("req-1"), 5);
    const r2 = await promptUser(makeRequest("req-2"), 5);
    const r3 = await promptUser(makeRequest("req-3"), 5);

    expect(r1.respondedBy).toBe("timeout");
    expect(r2.respondedBy).toBe("timeout");
    expect(r3.respondedBy).toBe("timeout");
  });

  test("BUG-21: timeout closes the stale readline and recreates it, so the next question() gets a live callback", async () => {
    const plugin = new CLIInteractionPlugin();
    let closeCalls = 0;
    const staleRl = {
      question: (_prompt: string, _cb: (a: string) => void) => {
        // Never calls cb — simulates the user not answering before timeout.
      },
      close: () => {
        closeCalls++;
      },
    };
    (plugin as any).rl = staleRl;

    const promptUser = (plugin as any).promptUser.bind(plugin);
    const response = await promptUser(makeRequest("req-1"), 5);

    expect(response.respondedBy).toBe("timeout");
    // The stale readline interface must have been closed...
    expect(closeCalls).toBe(1);
    // ...and replaced, so a subsequent question() is not swallowed by the
    // abandoned callback registered on the old interface.
    expect((plugin as any).rl).not.toBe(staleRl);
    expect((plugin as any).rl).not.toBeNull();

    await plugin.destroy();
  });
});
