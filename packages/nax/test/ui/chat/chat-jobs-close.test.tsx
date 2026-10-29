import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeFakeClock, makeLogger } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { _askControllerDeps, DEFAULT_HOST_APPROVAL_TIMEOUT_MS } from "@/chat/ask-controller";
import { createCloseConfirm } from "@/chat/close-confirm";
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
const originalTimers = { ..._askControllerDeps };
afterEach(() => {
  Object.assign(_askControllerDeps, originalTimers);
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
function mount(confirm?: ChatHost["confirmBeforeClose"]) {
  const fixture = fakeHost();
  if (confirm) Object.assign(fixture.host, { confirmBeforeClose: confirm });
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
    const gate = Promise.withResolvers<boolean>();
    const confirm = mock(async () => {
      order.push("confirm");
      return await gate.promise;
    });
    const ui = mount(confirm);
    ui.close.mockImplementation(async () => {
      order.push("close");
    });
    if (gesture === "/quit") await ui.quit();
    else await ui.press(gesture);
    expect(order).toEqual(["confirm"]);
    await flush(() => gate.resolve(true));
    expect(order).toEqual(["confirm", "close"]);
  });

  test.each([CTRL_C, "/quit"])("US-015 AC-7 repeated %s does not duplicate pending confirmation", async (repeat) => {
    const gate = Promise.withResolvers<boolean>();
    const confirm = mock(() => gate.promise);
    const ui = mount(confirm);
    await ui.press(CTRL_C);
    if (repeat === "/quit") await ui.quit();
    else await ui.press(repeat);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ui.close).not.toHaveBeenCalled();
    await flush(() => gate.resolve(true));
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

  test.each([false, true])("AC-20 AC-21 idle ctrl-c confirmation %s", async (answer) => {
    const ui = mount(async () => answer);
    await ui.press(CTRL_C);
    expect(ui.close).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (!answer) {
      await ui.press("still chatting");
      expect(ui.lastFrame()).toContain("still chatting");
    }
  });

  test.each(["timeout", "escape", "stop"])("AC-21 AC-22 AC-23 real quit card %s", async (action) => {
    const ui = mount();
    const clock = makeFakeClock();
    _askControllerDeps.setTimeout = clock.setTimeout;
    _askControllerDeps.clearTimeout = clock.clearTimeout;
    const stopAll = mock(async () => {});
    const confirm = createCloseConfirm({
      asks: ui.asks,
      logger: makeLogger(),
      tasks: { running: () => [{ id: "bash-1a2b3c4d" }], stopAll },
    });
    const decisions: boolean[] = [];
    Object.assign(ui.host, {
      confirmBeforeClose: async () => {
        const result = await confirm();
        decisions.push(result);
        return result;
      },
    });
    await ui.press(CTRL_C);
    expect(ui.lastFrame()).toContain("1. Quit and stop them");
    expect(ui.lastFrame()).toContain("2. Stay in chat");
    expect(ui.asks.pending()).toHaveLength(1);
    expect(ui.close).not.toHaveBeenCalled();
    if (action === "timeout") await flush(() => clock.advance(DEFAULT_HOST_APPROVAL_TIMEOUT_MS));
    else await ui.press(action === "escape" ? "\x1b" : "1");
    expect(decisions).toEqual([action === "stop"]);
    expect(ui.asks.pending()).toEqual([]);
    expect(ui.close).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
    expect(stopAll).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
    if (action !== "stop") {
      await ui.press("still chatting");
      expect(ui.lastFrame()).toContain("still chatting");
    }
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
