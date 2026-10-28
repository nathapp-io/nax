import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import type { Instance, RenderOptions } from "ink";
import { isValidElement, type ReactNode } from "react";
import { type ChatHost, createChatHost, createChatStorage } from "@/chat";
import { _renderChatDeps, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, renderChat } from "@/tui/chat";
import { createMouseInput, DISABLE_MOUSE, ENABLE_MOUSE } from "@/tui/chat/mouse-input";

const originalDeps = { ..._renderChatDeps };
afterEach(() => {
  Object.assign(_renderChatDeps, originalDeps);
  mock.restore();
});

/** A real host: the renderer is stubbed here, so ChatApp is never mounted against it. */
function chatHost(): ChatHost {
  const logger = makeLogger();
  return createChatHost({
    config: makeNaxConfig(),
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger }),
    cwd: "/repo",
    repoRoot: "/repo",
    chain: null,
    now: () => new Date(),
    logger,
  });
}

/**
 * Replace the screen seams `renderChat` uses: the escape writer, the renderer and the
 * process-exit registration. Nothing here reaches the terminal, so a test can assert
 * the exact byte sequence and the exact number of restore writes.
 */
function stubScreen(isTTY = true) {
  const source = Object.assign(new PassThrough(), {
    isTTY,
    isRaw: false,
    setRawMode: () => source,
    ref: () => source,
    unref: () => source,
  });
  // Borrow the module's typed TTY facades, then detach their real filtering listeners.
  // The renderer receives a different stream from the injected source (no process.stdin).
  const fake = createMouseInput(source);
  fake.dispose();
  const stdin = fake.stdin;
  const dispose = mock(() => {});
  const filtered = createMouseInput(source);
  filtered.dispose();
  const mouse = { ...filtered, dispose };
  const createMouse = mock(() => mouse);
  _renderChatDeps.stdin = () => stdin;
  _renderChatDeps.createMouseInput = createMouse;
  const order: string[] = [];
  const writes: string[] = [];
  const exitHandlers = new Set<() => void>();
  let unmounts = 0;
  let removals = 0;
  const instance: Instance = {
    rerender: () => {},
    unmount: () => {
      unmounts += 1;
      order.push("unmount");
    },
    waitUntilExit: async () => {},
    cleanup: () => {},
    clear: () => {},
  };
  _renderChatDeps.write = (text: string): void => {
    writes.push(text);
    order.push(`write:${text}`);
  };
  const renderMock = mock((_node: ReactNode, _options?: NodeJS.WriteStream | RenderOptions): Instance => {
    order.push("render");
    return instance;
  });
  _renderChatDeps.render = renderMock;
  _renderChatDeps.onExit = (handler: () => void): (() => void) => {
    exitHandlers.add(handler);
    return () => {
      removals += 1;
      exitHandlers.delete(handler);
    };
  };
  return {
    stdin,
    mouse,
    dispose,
    createMouse,
    order,
    writes,
    exitHandlers,
    instance,
    renderMock,
    unmounts: () => unmounts,
    removals: () => removals,
  };
}

describe("renderChat alternate screen", () => {
  test("AC-1: enters the alternate screen before the first frame", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(ENTER_ALT_SCREEN).toBe("\u001b[?1049h\u001b[H");
    expect(screen.order).toEqual([`write:${ENTER_ALT_SCREEN}`, "render", `write:${ENABLE_MOUSE}`]);
    view.unmount();
  });

  test("AC-2: unmounting leaves the alternate screen", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(LEAVE_ALT_SCREEN).toBe("\u001b[?1049l");
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, ENABLE_MOUSE, DISABLE_MOUSE, LEAVE_ALT_SCREEN]);
    // Ink flushes its final frame from unmount(), which belongs on the alt screen.
    expect(screen.order).toEqual([
      `write:${ENTER_ALT_SCREEN}`,
      "render",
      `write:${ENABLE_MOUSE}`,
      "unmount",
      `write:${DISABLE_MOUSE}`,
      `write:${LEAVE_ALT_SCREEN}`,
    ]);
  });

  test("AC-3: unmounting twice restores the screen once", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    view.unmount();
    view.unmount();
    expect(screen.writes.filter((text) => text === LEAVE_ALT_SCREEN)).toHaveLength(1);
    expect(screen.unmounts()).toBe(2);
    expect(screen.dispose).toHaveBeenCalledTimes(1);
    expect(screen.writes.filter((text) => text === DISABLE_MOUSE)).toHaveLength(1);
  });

  test("AC-4: the process-exit guard restores the screen", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const handlers = [...screen.exitHandlers];
    for (const handler of handlers) {
      handler();
      handler();
    }
    expect(screen.dispose).toHaveBeenCalledTimes(1);
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, ENABLE_MOUSE, DISABLE_MOUSE, LEAVE_ALT_SCREEN]);
    view.unmount();
  });

  test("AC-5: an unmount after the exit guard restored writes nothing more", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    for (const handler of screen.exitHandlers) handler();
    view.unmount();
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, ENABLE_MOUSE, DISABLE_MOUSE, LEAVE_ALT_SCREEN]);
  });

  test("AC-6: the first restore deregisters the exit guard", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.exitHandlers.size).toBe(1);
    view.unmount();
    expect(screen.removals()).toBe(1);
    expect(screen.exitHandlers.size).toBe(0);
  });

  test("AC-13: render keeps Ctrl-C in the chat's hands", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.renderMock.mock.calls[0]?.[1]).toEqual({
      exitOnCtrlC: false,
      incrementalRendering: true,
      stdin: screen.mouse.stdin,
    });
    view.unmount();
  });

  test("render rewrites only the rows that changed, so a frame does not blink", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const options = screen.renderMock.mock.calls[0]?.[1];
    expect(options && "incrementalRendering" in options && options.incrementalRendering).toBe(true);
    view.unmount();
  });

  test("the returned instance is ink's, with only unmount guarded", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(view.clear).toBe(screen.instance.clear);
    expect(view.waitUntilExit).toBe(screen.instance.waitUntilExit);
    view.unmount();
  });

  test("a renderer that throws restores the screen before the error escapes", () => {
    const screen = stubScreen();
    _renderChatDeps.render = () => {
      throw new Error("render failed");
    };
    expect(() => renderChat({ host: chatHost() })).toThrow("render failed");
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, DISABLE_MOUSE, LEAVE_ALT_SCREEN]);
    expect(screen.exitHandlers.size).toBe(0);
    expect(screen.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("renderChat mouse seams", () => {
  test("US003 AC-7 injects the source once", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.createMouse).toHaveBeenCalledTimes(1);
    expect(screen.createMouse).toHaveBeenCalledWith(screen.stdin);
    view.unmount();
  });
  test("US003 AC-8 injects the filtered stream into render", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.renderMock.mock.calls[0]?.[1]).toEqual({
      exitOnCtrlC: false,
      incrementalRendering: true,
      stdin: screen.mouse.stdin,
    });
    view.unmount();
  });
  test("US003 AC-9 injects mouse events into ChatApp", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const node = screen.renderMock.mock.calls[0]?.[0];
    expect(isValidElement<{ mouse?: unknown }>(node) && node.props.mouse).toBe(screen.mouse.events);
    view.unmount();
  });
  test("US003 AC-6 non-TTY never enables or disables mouse", () => {
    const screen = stubScreen(false);
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expect(screen.dispose).toHaveBeenCalledTimes(1);
  });
  test("US003 AC-16 ordinary non-TTY text reaches Ink unchanged", () => {
    const screen = stubScreen(false);
    _renderChatDeps.createMouseInput = createMouseInput;
    const view = renderChat({ host: chatHost() });
    const options = screen.renderMock.mock.calls[0]?.[1];
    expect(options && "stdin" in options).toBe(true);
    screen.stdin.emit("data", "ordinary é text");
    if (!options || !("stdin" in options)) throw new Error("missing render options");
    expect(options.stdin?.read()?.toString()).toBe("ordinary é text");
    view.unmount();
  });
});
