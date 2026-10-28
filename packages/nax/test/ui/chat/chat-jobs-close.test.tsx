import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat";
import { useChatKeys } from "@/tui/chat/useChatKeys";

const CTRL_C = "\x03";
const STATE: ChatHostState = {
  sessionId: "close-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "close-session",
    cwd: "/repo",
    mode: "ask",
    model: "test-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
  },
};
afterEach(() => {
  cleanup();
  mock.restore();
});
const flush = (action: () => void = () => {}): Promise<void> =>
  Promise.resolve(
    act(async () => {
      action();
    }),
  );

function fakeHost() {
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const close = mock(async () => {});
  const host: ChatHost = {
    repoRoot: "/repo",
    models: [STATE.model],
    asks,
    current: () => STATE,
    notice: () => undefined,
    send: async () => {},
    cancel: () => {},
    close,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
  };
  return { host, close, asks };
}
function mount(confirm?: ChatHost["confirmJobsBeforeClose"]) {
  const fixture = fakeHost();
  if (confirm) Object.assign(fixture.host, { confirmJobsBeforeClose: confirm });
  const ui = render(<ChatApp host={fixture.host} />);
  const press = (text: string): Promise<void> =>
    flush(() => {
      ui.stdin.write(text);
    });
  const quit = async (): Promise<void> => {
    await press("/quit");
    await press("\r");
  };
  return { ...fixture, ...ui, press, quit };
}

describe("ChatApp job close confirmation", () => {
  test.each(["/quit", CTRL_C])("US-015 AC-5 AC-6 confirms before closing via %s", async (gesture) => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const confirm = mock(async () => {
      order.push("confirm");
      await gate.promise;
    });
    const ui = mount(confirm);
    ui.close.mockImplementation(async () => {
      order.push("close");
    });
    if (gesture === "/quit") await ui.quit();
    else await ui.press(gesture);
    expect(order).toEqual(["confirm"]);
    await flush(() => gate.resolve());
    expect(order).toEqual(["confirm", "close"]);
  });

  test.each([CTRL_C, "/quit"])("US-015 AC-7 repeated %s does not duplicate pending confirmation", async (repeat) => {
    const gate = Promise.withResolvers<void>();
    const confirm = mock(() => gate.promise);
    const ui = mount(confirm);
    await ui.press(CTRL_C);
    if (repeat === "/quit") await ui.quit();
    else await ui.press(repeat);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ui.close).not.toHaveBeenCalled();
    await flush(() => gate.resolve());
  });

  test("US-015 AC-8 AC-9 AC-15 rejection is shown, stays open and permits retry", async () => {
    const confirm = mock(async () => {
      throw new Error("boom");
    });
    const ui = mount(confirm);
    await ui.quit();
    expect(ui.lastFrame()).toContain("boom");
    expect(ui.close).not.toHaveBeenCalled();
    await ui.quit();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(ui.close).not.toHaveBeenCalled();
  });

  test("US-015 AC-10 AC-11 AC-12 real approval stays interactive until yes closes", async () => {
    const ui = mount();
    const decisions: string[] = [];
    Object.assign(ui.host, {
      confirmJobsBeforeClose: async () => {
        decisions.push(
          await ui.asks.requestHostApproval({
            tool: "nax-jobs__close",
            summary: "Cancel owned jobs before quitting?",
            reason: "Yes cancels. No keeps running.",
          }),
        );
      },
    });
    await ui.quit();
    expect(ui.lastFrame()).toContain("Cancel owned jobs before quitting?");
    expect(ui.lastFrame()).toContain("1. Yes");
    expect(ui.asks.pending()).toHaveLength(1);
    expect(ui.close).not.toHaveBeenCalled();
    await ui.press(CTRL_C);
    expect(ui.asks.pending()).toHaveLength(1);
    await ui.press("1");
    expect(decisions).toEqual(["allow"]);
    expect(ui.asks.pending()).toHaveLength(0);
    expect(ui.close).toHaveBeenCalledTimes(1);
  });

  test("US-015 AC-13 host without confirmation still closes on quit", async () => {
    const ui = mount();
    await ui.quit();
    expect(ui.close).toHaveBeenCalledTimes(1);
  });

  test("US-015 AC-14 no-confirmation close synchronously disables controls", async () => {
    const { host, close } = fakeHost();
    let keys: ReturnType<typeof useChatKeys> | undefined;
    function Probe() {
      keys = useChatKeys({ host, running: { current: false }, refresh: () => {}, onError: () => {} });
      return null;
    }
    render(<Probe />);
    expect(keys?.canControl()).toBe(true);
    let task: Promise<void> | undefined;
    act(() => {
      task = keys?.close();
      expect(keys?.canControl()).toBe(false);
      expect(close).not.toHaveBeenCalled();
    });
    await flush();
    await task;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
