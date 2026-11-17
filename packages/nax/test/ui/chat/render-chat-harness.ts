/**
 * The screen seams `renderChat` reaches through `_renderChatDeps`, stubbed for a test: the
 * escape writer, the renderer, the resize subscription and the process-exit registration.
 * Nothing here touches the terminal, so a case can assert the exact byte sequence, the exact
 * number of restore writes and the order in which the seams ran.
 *
 * Shared by `index.test.tsx` and `index-resize-repaint.test.tsx`, which both mount
 * `renderChat`; the module is not a test file, so it has no cases of its own.
 */
import { mock } from "bun:test";
import { PassThrough } from "node:stream";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import type { Instance, RenderOptions } from "ink";
import { isValidElement, type ReactNode } from "react";
import { type ChatHost, createChatHost, createChatStorage } from "@/chat";
import { _renderChatDeps, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "@/tui/chat";
import { createMouseInput, DISABLE_MOUSE, ENABLE_MOUSE } from "@/tui/chat/mouse-input";
import { POP_TITLE, PUSH_TITLE } from "@/tui/chat/terminal-title";

/** The title a TTY mount writes for the host's own project, idle — no turn has started yet. */
export const IDLE_TITLE = "\u001b]0;nax · repo\u0007";
/** What a TTY mount writes after the first frame: the mouse, then the title it saved. */
export const MOUNT_WRITES = [ENTER_ALT_SCREEN, ENABLE_MOUSE, PUSH_TITLE, IDLE_TITLE];
/** What a restore adds after the unmount: mouse off, leave the screen, then the title back. */
export const RESTORE_WRITES = [DISABLE_MOUSE, LEAVE_ALT_SCREEN, POP_TITLE];

/** The seams as the module shipped them, for the `afterEach` restore each test file runs. */
export const originalDeps = { ..._renderChatDeps };

/** Put every `_renderChatDeps` seam back after a case stubbed it. */
export function restoreDeps(): void {
  Object.assign(_renderChatDeps, originalDeps);
  mock.restore();
}

/** A real host: the renderer is stubbed here, so ChatApp is never mounted against it. */
export function chatHost(paths: { cwd?: string; repoRoot?: string } = {}): ChatHost {
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
 * Replace the screen seams `renderChat` uses: the escape writer, the renderer, the resize
 * subscription and the process-exit registration.
 */
export function stubScreen(isTTY = true) {
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
  /** When each screen seam ran, in order: a subscription must follow a completed render. */
  const timeline: string[] = [];
  const exitHandlers = new Set<() => void>();
  let unmounts = 0;
  let removals = 0;
  let repaints = 0;
  let clears = 0;
  let rerenders = 0;
  const instance: Instance = {
    rerender: () => {
      rerenders += 1;
    },
    unmount: () => {
      unmounts += 1;
      order.push("unmount");
    },
    waitUntilExit: async () => {},
    cleanup: () => {},
    clear: () => {
      clears += 1;
    },
    repaint: () => {
      repaints += 1;
      order.push("repaint");
    },
  };
  const timers: { cb: () => void; ms: number; cleared: boolean }[] = [];
  /** Every handle a restore or a re-arm passed to clearTimeout, in order. */
  const clearedHandles: unknown[] = [];
  _renderChatDeps.setTimeout = (cb: () => void, ms: number): unknown => {
    const timer = { cb, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  _renderChatDeps.clearTimeout = (handle: unknown): void => {
    clearedHandles.push(handle);
    for (const timer of timers) if (timer === handle) timer.cleared = true;
    order.push("clear");
  };
  _renderChatDeps.write = (text: string): void => {
    writes.push(text);
    order.push(`write:${text}`);
  };
  const renderMock = mock((_node: ReactNode, _options?: NodeJS.WriteStream | RenderOptions): Instance => {
    order.push("render");
    timeline.push("render-start");
    return instance;
  });
  _renderChatDeps.render = (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions): Instance => {
    const rendered = renderMock(node, options);
    timeline.push("render-end");
    return rendered;
  };
  const subscriptions: { handler: () => void; removed: number }[] = [];
  _renderChatDeps.onResize = (handler: () => void): (() => void) => {
    const record = { handler, removed: 0 };
    subscriptions.push(record);
    timeline.push("subscribe");
    return () => {
      record.removed += 1;
    };
  };
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
    timeline,
    subscriptions,
    clearedHandles,
    exitHandlers,
    timers,
    instance,
    renderMock,
    unmounts: () => unmounts,
    removals: () => removals,
    repaints: () => repaints,
    clears: () => clears,
    rerenders: () => rerenders,
    /** Fire the terminal resize the mount subscribed to. */
    fireResize: () => {
      for (const record of subscriptions) if (record.removed === 0) record.handler();
    },
  };
}

/** The props `renderChat` composed for the screen, so a case can reach the ones it passes. */
export interface ScreenProps {
  readonly onBusyChange?: (busy: boolean) => void;
}

export function node(screen: ReturnType<typeof stubScreen>): ScreenProps {
  const element = screen.renderMock.mock.calls[0]?.[0];
  if (!isValidElement<ScreenProps>(element)) throw new Error("no element");
  return element.props;
}

/** The busy callback renderChat passed to ChatApp. */
export function busyOf(screen: ReturnType<typeof stubScreen>): (busy: boolean) => void {
  const callback = node(screen).onBusyChange;
  if (callback === undefined) throw new Error("renderChat passed no onBusyChange");
  return callback;
}
