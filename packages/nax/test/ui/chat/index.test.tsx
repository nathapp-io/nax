import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import type { Instance, RenderOptions } from "ink";
import { isValidElement, type ReactNode } from "react";
import { type ChatHost, createChatHost, createChatStorage } from "@/chat";
import { _renderChatDeps, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, renderChat } from "@/tui/chat";
import { createMouseInput, DISABLE_MOUSE, ENABLE_MOUSE } from "@/tui/chat/mouse-input";
import { POP_TITLE, PUSH_TITLE } from "@/tui/chat/terminal-title";
import { resolveChatTheme } from "@/tui/chat/theme";

/** The title a TTY mount writes for the host's own project, idle — no turn has started yet. */
const IDLE_TITLE = "\u001b]0;nax · repo\u0007";
/** What a TTY mount writes after the first frame: the mouse, then the title it saved. */
const MOUNT_WRITES = [ENTER_ALT_SCREEN, ENABLE_MOUSE, PUSH_TITLE, IDLE_TITLE];
/** What a restore adds after the unmount: mouse off, leave the screen, then the title back. */
const RESTORE_WRITES = [DISABLE_MOUSE, LEAVE_ALT_SCREEN, POP_TITLE];

const originalDeps = { ..._renderChatDeps };
afterEach(() => {
  Object.assign(_renderChatDeps, originalDeps);
  mock.restore();
});

/** A real host: the renderer is stubbed here, so ChatApp is never mounted against it. */
function chatHost(paths: { cwd?: string; repoRoot?: string } = {}): ChatHost {
  const logger = makeLogger();
  return createChatHost({
    config: makeNaxConfig(),
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger }),
    cwd: paths.cwd ?? "/repo",
    repoRoot: paths.repoRoot ?? "/repo",
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
  const timers: { cb: () => void; ms: number; cleared: boolean }[] = [];
  _renderChatDeps.setTimeout = (cb: () => void, ms: number): unknown => {
    const timer = { cb, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  _renderChatDeps.clearTimeout = (handle: unknown): void => {
    for (const timer of timers) if (timer === handle) timer.cleared = true;
    order.push("clear");
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
    timers,
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
    expect(screen.order).toEqual([
      `write:${ENTER_ALT_SCREEN}`,
      "render",
      `write:${ENABLE_MOUSE}`,
      `write:${PUSH_TITLE}`,
      `write:${IDLE_TITLE}`,
    ]);
    view.unmount();
  });

  test("AC-2: unmounting leaves the alternate screen", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(LEAVE_ALT_SCREEN).toBe("\u001b[?1049l");
    expect(screen.writes).toEqual([...MOUNT_WRITES, ...RESTORE_WRITES]);
    // Ink flushes its final frame from unmount(), which belongs on the alt screen.
    expect(screen.order).toEqual([
      `write:${ENTER_ALT_SCREEN}`,
      "render",
      `write:${ENABLE_MOUSE}`,
      `write:${PUSH_TITLE}`,
      `write:${IDLE_TITLE}`,
      "unmount",
      `write:${DISABLE_MOUSE}`,
      `write:${LEAVE_ALT_SCREEN}`,
      `write:${POP_TITLE}`,
    ]);
  });

  test("AC-8: a TTY mount saves, then sets, the project's title after enabling the mouse", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, ENABLE_MOUSE, PUSH_TITLE, "\u001b]0;nax · repo\u0007"]);
    expect(PUSH_TITLE).toBe("\u001b[22;0t");
    view.unmount();
  });

  test("AC-9: unmounting writes POP_TITLE after LEAVE_ALT_SCREEN", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(screen.writes.indexOf(POP_TITLE)).toBe(screen.writes.indexOf(LEAVE_ALT_SCREEN) + 1);
    expect(POP_TITLE).toBe("\u001b[23;0t");
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
    expect(screen.writes.filter((text) => text === POP_TITLE)).toHaveLength(1);
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
    expect(screen.writes).toEqual([...MOUNT_WRITES, ...RESTORE_WRITES]);
    view.unmount();
  });

  test("AC-5: an unmount after the exit guard restored writes nothing more", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    for (const handler of screen.exitHandlers) handler();
    view.unmount();
    expect(screen.writes).toEqual([...MOUNT_WRITES, ...RESTORE_WRITES]);
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

  test("the returned instance is ink's, with only unmount guarded", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    expect(view.clear).toBe(screen.instance.clear);
    expect(view.waitUntilExit).toBe(screen.instance.waitUntilExit);
    view.unmount();
  });

  test("AC-17: a renderer that throws before PUSH_TITLE restores without popping a title", () => {
    const screen = stubScreen();
    _renderChatDeps.render = () => {
      throw new Error("render failed");
    };
    expect(() => renderChat({ host: chatHost() })).toThrow("render failed");
    // Nothing was saved, so nothing is restored: mouse off, then the screen — no POP_TITLE.
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, DISABLE_MOUSE, LEAVE_ALT_SCREEN]);
    expect(screen.writes).not.toContain(PUSH_TITLE);
    expect(screen.writes).not.toContain(POP_TITLE);
    expect(screen.exitHandlers.size).toBe(0);
    expect(screen.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("renderChat terminal title", () => {
  /** The props `renderChat` composed for the screen, so a case can reach the ones it passes. */
  interface ScreenProps {
    readonly onBusyChange?: (busy: boolean) => void;
  }
  function node(screen: ReturnType<typeof stubScreen>): ScreenProps {
    const element = screen.renderMock.mock.calls[0]?.[0];
    if (!isValidElement<ScreenProps>(element)) throw new Error("no element");
    return element.props;
  }

  /** The busy callback renderChat passed to ChatApp. */
  function busyOf(screen: ReturnType<typeof stubScreen>): (busy: boolean) => void {
    const callback = node(screen).onBusyChange;
    if (callback === undefined) throw new Error("renderChat passed no onBusyChange");
    return callback;
  }

  test("AC-10: no TTY means no title sequence at all", () => {
    const screen = stubScreen(false);
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(screen.writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    expect(screen.writes).not.toContain(PUSH_TITLE);
    expect(screen.writes).not.toContain(POP_TITLE);
    expect(node(screen).onBusyChange).toBeUndefined();
  });

  test("AC-13: the busy callback writes the title for the state it reports", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const busy = busyOf(screen);
    busy(true);
    expect(screen.writes.at(-1)).toBe("\u001b]0;✳ nax · repo\u0007");
    busy(false);
    expect(screen.writes.at(-1)).toBe(IDLE_TITLE);
    view.unmount();
  });

  test("AC-13 takes the busy marker from the theme's glyph set", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost(), theme: resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 }) });
    busyOf(screen)(true);
    expect(screen.writes.at(-1)).toBe("\u001b]0;* nax · repo\u0007");
    view.unmount();
  });

  test("AC-13 a busy change after the restore writes nothing: the title is the terminal's again", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const busy = busyOf(screen);
    view.unmount();
    const afterRestore = [...screen.writes];
    busy(true);
    busy(false);
    expect(screen.writes).toEqual(afterRestore);
  });

  const frameTitle = (frame: string) => `\u001b]0;${frame} nax · repo\u0007`;
  const live = (screen: ReturnType<typeof stubScreen>) => screen.timers.filter((t) => !t.cleared);

  test("US-007 AC-7: busy(true) writes the static title and arms one 400 ms timeout", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    busyOf(screen)(true);
    expect(screen.writes.at(-1)).toBe("\u001b]0;✳ nax · repo\u0007");
    expect(screen.timers.map((t) => t.ms)).toEqual([400]);
    view.unmount();
  });

  test("US-007 AC-8: each tick writes the next frame and re-arms", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    busyOf(screen)(true);
    const frames = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs.spinner;
    for (let i = 0; i < 3; i++) {
      screen.timers[i]?.cb();
      expect(screen.writes.at(-1)).toBe(frameTitle(frames[i] as string));
      expect(screen.timers).toHaveLength(i + 2);
      expect(screen.timers[i + 1]?.ms).toBe(400);
    }
    view.unmount();
  });

  test("US-007 AC-9: a second busy(true) arms no second timeout", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const busy = busyOf(screen);
    busy(true);
    busy(true);
    expect(screen.timers).toHaveLength(1);
    view.unmount();
  });

  test("US-007 AC-10/11: busy(false) clears the timeout, writes idle; a stale tick does nothing", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const busy = busyOf(screen);
    busy(true);
    busy(false);
    expect(screen.timers[0]?.cleared).toBe(true);
    expect(screen.writes.at(-1)).toBe(IDLE_TITLE);
    const before = [...screen.writes];
    screen.timers[0]?.cb();
    expect(screen.writes).toEqual(before);
    expect(screen.timers).toHaveLength(1);
    view.unmount();
  });

  test("US-007 AC-12: unmount while busy clears the timeout before POP_TITLE; later tick is silent", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    busyOf(screen)(true);
    view.unmount();
    expect(screen.order.indexOf("clear")).toBeGreaterThan(-1);
    expect(screen.order.indexOf("clear")).toBeLessThan(screen.order.indexOf(`write:${POP_TITLE}`));
    const before = [...screen.writes];
    screen.timers[0]?.cb();
    expect(screen.writes).toEqual(before);
    expect(live(screen)).toHaveLength(0);
    expect(screen.timers).toHaveLength(1);
  });

  test("US-007 AC-13: off a TTY no timeout is armed", () => {
    const screen = stubScreen(false);
    const view = renderChat({ host: chatHost() });
    view.unmount();
    expect(screen.timers).toHaveLength(0);
  });

  test("US-007 AC-14: busy(true) after unmount arms nothing and writes nothing", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost() });
    const busy = busyOf(screen);
    view.unmount();
    const before = [...screen.writes];
    busy(true);
    expect(screen.timers).toHaveLength(0);
    expect(screen.writes).toEqual(before);
  });

  test("AC-14: with no cwd prop the title names the host's repo root", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost({ repoRoot: "/home/me/work/my-repo" }) });
    expect(screen.writes.at(-1)).toBe("\u001b]0;nax · my-repo\u0007");
    view.unmount();
  });

  test("AC-14: the cwd prop names the title when it is given", () => {
    const screen = stubScreen();
    const view = renderChat({ host: chatHost({ repoRoot: "/home/me/work/my-repo" }), cwd: "/elsewhere/other-repo" });
    expect(screen.writes.at(-1)).toBe("\u001b]0;nax · other-repo\u0007");
    view.unmount();
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
