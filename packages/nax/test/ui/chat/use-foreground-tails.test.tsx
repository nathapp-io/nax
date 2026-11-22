/**
 * The running Bash card's live tail (chat-live-shell-output US-005): `useForegroundTails`
 * keeps a running `Bash` entry's `liveTail` current, the card model draws its newest lines as
 * clipped rows, and the click mapping keeps up with the rows the tail adds.
 *
 * Every case mounts the whole screen through the shared picker fake, so what is asserted is
 * the frame a user sees. The clock is the fake one, wired through `_foregroundTailsDeps`, so a
 * case says exactly when the coalesced refresh fires.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import { makeFakeClock, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";
import { type ChatShellOutput, SHELL_TAIL_REFRESH_MS } from "@/chat/background";
import { _layoutDeps } from "@/tui/chat/layout";
import { displayWidth } from "@/tui/chat/styled-line";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";
import { _foregroundTailsDeps } from "@/tui/chat/use-foreground-tails";
import { fakeMouse } from "./mouse";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** The call the mounted turn's Bash run carries. */
const CALL_ID = "c1";
/** The five lines a full card shows; the sixth and seventh exist so a case can drop them. */
const FIVE = ["tail-a", "tail-b", "tail-c", "tail-d", "tail-e"];
const BASH_CALL: SessionEventBody = { type: "tool_call", callId: CALL_ID, name: "Bash", input: { command: "make" } };

/** The three seams this file replaces; each `afterEach` puts them back as it found them. */
const savedTailsDeps = { ..._foregroundTailsDeps };
const savedLayoutDeps = { ..._layoutDeps };

afterEach(() => {
  cleanup();
  Object.assign(_foregroundTailsDeps, savedTailsDeps);
  Object.assign(_layoutDeps, savedLayoutDeps);
});

/** A fake `ChatShellOutput`: a tail per call id, and a way to notify the listeners it holds. */
interface ShellOutputFake {
  readonly output: ChatShellOutput;
  /** Notify every listener about `id`, as the registry does when a call appends output. */
  notify(id: string): void;
  /** How many listeners are still subscribed — what an unmount has to bring back to zero. */
  listening(): number;
}

function shellOutputFake(read: (callId: string) => readonly string[] | undefined): ShellOutputFake {
  const listeners = new Set<(id: string) => void>();
  return {
    output: {
      taskTail: () => undefined,
      foregroundTail: (callId) => {
        const lines = read(callId);
        return lines === undefined ? undefined : { lines, truncated: false };
      },
      onShellOutput: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    notify: (id) => {
      for (const listener of [...listeners]) listener(id);
    },
    listening: () => listeners.size,
  };
}

/** Every tool entry the layout rendered, in order: a replaced entry is laid out again, a reused one is not. */
function recordLayouts(): ToolEntry[] {
  const rendered: ToolEntry[] = [];
  const saved = savedLayoutDeps.layoutEntry;
  _layoutDeps.layoutEntry = (entry, context) => {
    if (entry.kind === "tool") rendered.push(entry);
    return saved(entry, context);
  };
  return rendered;
}

interface MountOptions {
  /** False mounts a host with no `shellOutput` at all, the way every pre-US-005 caller does. */
  readonly withShellOutput?: boolean;
  /** False leaves the transcript without the Bash call, so a case can commit it itself. */
  readonly withBashCall?: boolean;
}

/**
 * The chat, with a turn running and its Bash call in the transcript. The fake clock drives the
 * hook's refresh timer, and `advance` is what a case uses to let the scheduled update land.
 */
async function mount(options: MountOptions = {}) {
  const clock = makeFakeClock();
  _foregroundTailsDeps.schedule = (callback, ms) => clock.setTimeout(callback, ms);
  _foregroundTailsDeps.cancel = (handle) => clock.clearTimeout(Number(handle));
  const tails = new Map<string, readonly string[]>();
  const mouse = fakeMouse();
  const shell = shellOutputFake((callId) => tails.get(callId));
  const ui = mountChatPicker({
    ...(options.withShellOutput === false ? {} : { shellOutput: shell.output }),
    mouse: mouse.events,
  });
  await ui.submit("make");
  if (options.withBashCall !== false) ui.emit(BASH_CALL);
  /** Give call `callId` the tail `lines`, as a running call's output would. */
  const setTail = (callId: string, lines: readonly string[]): void => {
    tails.set(callId, lines);
  };
  /** Let the virtual clock reach `ms` from now, inside the act that redraws afterwards. */
  const advance = (ms: number): Promise<void> =>
    Promise.resolve(
      act(async () => {
        await clock.advance(ms);
      }),
    );
  /** Report the terminal as `columns` wide, the size the layout is drawn to. */
  const resize = (columns: number): Promise<void> => {
    Object.defineProperty(ui.ui.stdout, "columns", { value: columns, configurable: true });
    Object.defineProperty(ui.ui.stdout, "rows", { value: 40, configurable: true });
    return Promise.resolve(
      act(async () => {
        ui.ui.stdout.emit("resize");
      }),
    );
  };
  /** The rows a tail line of the Bash card occupies — what its clip is measured on. */
  const tailRows = (text: string): string[] => ui.rows().filter((row) => row.includes(text));
  /** Scroll a click onto `text`'s row, the way the screen's mouse source reports it. */
  const click = (index: number): Promise<void> =>
    Promise.resolve(
      act(async () => {
        mouse.emit("press", { button: "left", x: 2, y: index + 1 });
        mouse.emit("release", { button: "left", x: 2, y: index + 1 });
      }),
    );
  return { ...ui, clock, shell, setTail, advance, resize, tailRows, click };
}

describe("useForegroundTails", () => {
  test("AC-1 draws both lines of the tail after the refresh window", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.rows().some((row) => row.includes("⎿  one"))).toBe(true);
    expect(ui.rows().some((row) => row.includes("two"))).toBe(true);
  });

  test("AC-1b draws the first output when it arrives before the tool_call is committed", async () => {
    const ui = await mount({ withBashCall: false });
    ui.setTail(CALL_ID, ["one", "two"]);
    // The entry and its first output reach the screen in one act, so the output is notified
    // while the transcript the screen last drew still has no Bash call in it at all.
    act(() => {
      ui.emit(BASH_CALL);
      ui.shell.notify(CALL_ID);
    });
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).toContain("one");
    expect(ui.ui.lastFrame()).toContain("two");
  });

  test("AC-1c draws the tail when the entry is committed after the refresh window", async () => {
    const ui = await mount({ withBashCall: false });
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    // The coalesced update lands first and finds no Bash entry to carry the tail.
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).not.toContain("one");
    // The entry appears afterwards: the start of the command must still reach the card, or a
    // command that prints once and then waits shows nothing for the rest of its run.
    ui.emit(BASH_CALL);
    await ui.settle();
    expect(ui.ui.lastFrame()).toContain("one");
  });

  test("AC-2 shows only the newest five lines of a longer tail", async () => {
    const ui = await mount();
    ui.setTail(
      CALL_ID,
      Array.from({ length: 8 }, (_, index) => `l${index + 1}`),
    );
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    const frame = ui.ui.lastFrame() ?? "";
    for (const kept of ["l4", "l5", "l6", "l7", "l8"]) expect(frame).toContain(kept);
    expect(frame).not.toContain("l3");
  });

  test("AC-3 shows a line the tail gained after another notification", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).not.toContain("three");
    ui.setTail(CALL_ID, ["one", "two", "three"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).toContain("three");
  });

  test("AC-4 draws nothing new before the refresh window has passed", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS - 1);
    expect(ui.ui.lastFrame()).not.toContain("one");
    await ui.advance(1);
    expect(ui.ui.lastFrame()).toContain("one");
  });

  test.each([false, true])(
    "AC-4 a newer notification supersedes a queued update (withBashCall=%s)",
    async (withBashCall) => {
      const ui = await mount({ withBashCall });
      ui.setTail(CALL_ID, ["first-output"]);
      ui.shell.notify(CALL_ID);
      await Promise.resolve(
        act(async () => {
          // Queue a transcript update first, preventing the timer's updater from running eagerly.
          ui.emit({ type: "tool_call", callId: "c2", name: "Read", input: { path: "src/a.ts" } });
          const flushed = ui.clock.advance(SHELL_TAIL_REFRESH_MS);
          // advance fires the timer synchronously, but React has not run its queued updater yet.
          ui.setTail(CALL_ID, ["newest-output"]);
          ui.shell.notify(CALL_ID);
          await flushed;
        }),
      );
      expect(ui.clock.pending()).toBe(1);
      if (!withBashCall) ui.emit(BASH_CALL);
      await ui.settle();
      expect(ui.ui.lastFrame()).toContain("Bash(make)");
      expect(ui.ui.lastFrame()).not.toContain("newest-output");
      await ui.advance(SHELL_TAIL_REFRESH_MS - 1);
      expect(ui.ui.lastFrame()).not.toContain("newest-output");
      await ui.advance(1);
      expect(ui.ui.lastFrame()).toContain("newest-output");
      expect(ui.clock.pending()).toBe(0);
    },
  );

  test("AC-5 coalesces ten notifications in one window into a single layout of the card", async () => {
    const ui = await mount();
    const rendered = recordLayouts();
    ui.setTail(CALL_ID, ["one", "two"]);
    for (let index = 0; index < 10; index += 1) ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    const tailed = rendered.filter((entry) => entry.callId === CALL_ID && entry.liveTail !== undefined);
    expect(tailed).toHaveLength(1);
    expect(tailed[0]?.liveTail).toEqual(["one", "two"]);
  });

  test("AC-5b an unrelated transcript change inside the window does not draw the tail early", async () => {
    const ui = await mount();
    const rendered = recordLayouts();
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    // Another card's events, while the tail's refresh window is still open: the transcript
    // changes, but the tail is the armed timer's to draw and nothing else's.
    ui.emit({ type: "tool_call", callId: "c2", name: "Read", input: { path: "src/a.ts" } });
    ui.emit({ type: "tool_result", callId: "c2", isError: false, preview: "1 line" });
    await ui.advance(SHELL_TAIL_REFRESH_MS - 1);
    expect(ui.ui.lastFrame()).not.toContain("one");
    expect(rendered.filter((entry) => entry.callId === CALL_ID)).toHaveLength(0);
    await ui.advance(1);
    expect(ui.ui.lastFrame()).toContain("one");
    // One update for the window: the transcript changes did not each lay the card out again.
    const tailed = rendered.filter((entry) => entry.callId === CALL_ID && entry.liveTail !== undefined);
    expect(tailed).toHaveLength(1);
    expect(tailed[0]?.liveTail).toEqual(["one", "two"]);
  });

  test("AC-6 clips a 300-character tail line to one 80-column row ending in an ellipsis", async () => {
    const line = "0123456789".repeat(30);
    const ui = await mount();
    await ui.resize(80);
    ui.setTail(CALL_ID, [line]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    const rows = ui.tailRows("0123456789");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endsWith("…")).toBe(true);
    expect(displayWidth(rows[0] ?? "")).toBeLessThanOrEqual(80);
  });

  test("AC-7 shows the result preview and no tail once the call's result arrives", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["tail-a", "tail-b"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).toContain("tail-a");
    ui.emit({ type: "tool_result", callId: CALL_ID, isError: false, preview: "build ok" });
    expect(ui.ui.lastFrame()).toContain("build ok");
    expect(ui.ui.lastFrame()).not.toContain("tail-a");
    expect(ui.ui.lastFrame()).not.toContain("tail-b");
  });

  test("AC-8 renders the card as before on a host with no shellOutput", async () => {
    const tailed = await mount();
    tailed.setTail(CALL_ID, ["one", "two"]);
    tailed.shell.notify(CALL_ID);
    await tailed.advance(SHELL_TAIL_REFRESH_MS);
    expect(tailed.ui.lastFrame()).toContain("one");
    // The same screen, the same tail and the same notification, over a host with no tails:
    // nothing subscribes, so the running card stays the header row it always was.
    const bare = await mount({ withShellOutput: false });
    bare.setTail(CALL_ID, ["one", "two"]);
    expect(bare.ui.lastFrame()).toContain("Bash(make)");
    expect(bare.ui.lastFrame()).not.toContain("one");
    expect(bare.tailRows("⎿")).toHaveLength(0);
  });

  test("AC-9 replaces no entry when the id names no running Bash entry", async () => {
    const ui = await mount();
    ui.emit({ type: "tool_call", callId: "c2", name: "RunCommand", input: { argv: ["bun", "test"] } });
    ui.setTail("c2", ["one", "two"]);
    const before = ui.ui.lastFrame();
    const rendered = recordLayouts();
    ui.shell.notify("missing");
    ui.shell.notify("c2");
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).toBe(before);
    expect(rendered).toHaveLength(0);
    // The same notification for an id that does name a running Bash entry does replace it.
    ui.setTail(CALL_ID, ["three"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    expect(ui.ui.lastFrame()).toContain("three");
    expect(rendered).toHaveLength(1);
  });

  test("AC-10 clicking the header of a tailed card toggles that card and no other", async () => {
    const ui = await mount();
    ui.emit({ type: "tool_call", callId: "c2", name: "Read", input: { path: "src/a.ts" } });
    ui.setTail(CALL_ID, FIVE);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    // The card grew by a tail row per line, which is what makes the click mapping the question.
    expect(ui.tailRows("tail-e")).toHaveLength(1);
    const rendered = recordLayouts();
    const header = ui.rows().findIndex((row) => row.includes("Bash(make)"));
    expect(header).toBeGreaterThan(-1);
    await ui.click(header);
    expect(rendered.filter((entry) => entry.callId === CALL_ID)).toHaveLength(1);
    expect(rendered.filter((entry) => entry.callId === "c2")).toHaveLength(0);
  });

  test("AC-11 neutralises a control sequence a tail line carries", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["before\u001b[?1049lafter"]);
    ui.shell.notify(CALL_ID);
    await ui.advance(SHELL_TAIL_REFRESH_MS);
    const frame = ui.ui.lastFrame() ?? "";
    expect(Bun.stripANSI(frame)).toContain("beforeafter");
    expect(frame).not.toContain("\u001b[?1049l");
  });

  test("AC-12 unsubscribes and cancels a scheduled update on unmount", async () => {
    const ui = await mount();
    ui.setTail(CALL_ID, ["one", "two"]);
    ui.shell.notify(CALL_ID);
    expect(ui.clock.pending()).toBe(1);
    ui.ui.unmount();
    expect(ui.clock.pending()).toBe(0);
    expect(ui.shell.listening()).toBe(0);
  });
});
