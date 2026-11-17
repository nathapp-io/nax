import { afterEach, describe, expect, test } from "bun:test";
import { CLEAR_ALT_SCREEN, RESIZE_REPAINT_MS, renderChat } from "@/tui/chat";
import { busyOf, chatHost, IDLE_TITLE, originalDeps, restoreDeps, stubScreen } from "./render-chat-harness";

afterEach(restoreDeps);

const writesClear = (screen: ReturnType<typeof stubScreen>) =>
  screen.writes.filter((text) => text === CLEAR_ALT_SCREEN);

describe("renderChat resize repaint", () => {
  test("AC-1: CLEAR_ALT_SCREEN erases the whole alternate screen and homes the cursor", () => {
    expect(CLEAR_ALT_SCREEN).toBe("\u001b[2J\u001b[H");
  });

  test("AC-2: a mount subscribes to terminal resizes exactly once", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.subscriptions).toHaveLength(1);
    view.unmount();
  });

  test("AC-3: the subscription happens after render returned", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.timeline.slice(0, 3)).toEqual(["render-start", "render-end", "subscribe"]);
    view.unmount();
  });

  test("AC-4: one resize arms one timeout for RESIZE_REPAINT_MS", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    expect(RESIZE_REPAINT_MS).toBe(50);
    expect(screen.timers.map((timer) => timer.ms)).toEqual([RESIZE_REPAINT_MS]);
    expect(screen.repaints()).toBe(0);
    view.unmount();
  });

  test("AC-5: an armed, unfired timeout writes no screen clear", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    expect(screen.timers).toHaveLength(1);
    expect(writesClear(screen)).toHaveLength(0);
    view.unmount();
  });

  test("AC-6: an armed, unfired timeout repaints nothing", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    expect(screen.timers).toHaveLength(1);
    expect(screen.repaints()).toBe(0);
    view.unmount();
  });

  test("AC-7: the fired timeout clears the screen, then repaints", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    screen.timers[0]?.cb();
    const trace = screen.order.slice(screen.order.indexOf(`write:${IDLE_TITLE}`) + 1);
    expect(trace).toEqual([`write:${CLEAR_ALT_SCREEN}`, "repaint"]);
    view.unmount();
  });

  test("AC-8/AC-9: the fired timeout neither clears nor rerenders the instance", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    expect(screen.timers).toHaveLength(1);
    screen.timers[0]?.cb();
    expect(screen.repaints()).toBe(1);
    expect(screen.clears()).toBe(0);
    expect(screen.rerenders()).toBe(0);
    view.unmount();
  });

  test("AC-10: a second resize clears the first timeout's handle", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    const first = screen.timers[0];
    screen.fireResize();
    expect(screen.clearedHandles).toEqual([first]);
    expect(screen.timers).toHaveLength(2);
    view.unmount();
  });

  test("AC-11: a burst of resizes repaints once, when the last timeout fires", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    screen.fireResize();
    screen.timers[1]?.cb();
    screen.timers[0]?.cb();
    expect(screen.repaints()).toBe(1);
    view.unmount();
  });

  test("AC-12: unmounting removes the resize subscription exactly once", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    view.unmount();
    view.unmount();
    expect(screen.subscriptions.map((record) => record.removed)).toEqual([1]);
  });

  test("AC-13: unmounting clears a pending repaint timeout", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    const pending = screen.timers[0];
    expect(pending).toBeDefined();
    view.unmount();
    expect(screen.clearedHandles).toEqual([pending]);
  });

  test("AC-14: a repaint timeout that fires after unmount writes and repaints nothing", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    const pending = screen.timers[0];
    expect(pending).toBeDefined();
    view.unmount();
    const writes = [...screen.writes];
    pending?.cb();
    expect(screen.writes).toEqual(writes);
    expect(screen.repaints()).toBe(0);
  });

  test("AC-15: a resize after unmount arms no timeout", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    screen.fireResize();
    expect(screen.timers).toHaveLength(1);
    view.unmount();
    const armed = [...screen.timers];
    screen.fireResize();
    expect(screen.timers).toEqual(armed);
    expect(screen.clearedHandles).toHaveLength(1);
  });

  test("AC-18: a resize does not clear the title animation's timeout", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    busyOf(screen)(true);
    const title = screen.timers[0];
    screen.fireResize();
    expect(screen.timers.map((timer) => timer.ms)).toEqual([400, RESIZE_REPAINT_MS]);
    expect(screen.clearedHandles).toEqual([]);
    expect(title?.cleared).toBe(false);
    view.unmount();
  });
});

describe("default onResize subscription", () => {
  const resizeListeners = () => process.stdout.listenerCount("resize");

  test("AC-16: subscribing adds one process.stdout resize listener", () => {
    const before = resizeListeners();
    const remove = originalDeps.onResize(() => {});
    expect(resizeListeners()).toBe(before + 1);
    remove();
  });

  test("AC-17: the remover takes that listener away again", () => {
    const before = resizeListeners();
    const remove = originalDeps.onResize(() => {});
    remove();
    expect(resizeListeners()).toBe(before);
  });
});
