import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, fakeTimers, makeFakeClock } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { _askControllerDeps } from "@/chat/ask-controller";
import { _chatAppDeps } from "@/tui/chat/ChatApp";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";
import { APPROVAL, COMPLETED, frameHarness, QUESTION } from "./frame-harness";
import { fakeMouse } from "./mouse";

const theme = resolveChatTheme({ env: {}, colorLevel: 0 });
const savedIndex = _chatAppDeps.mentionFileIndex;
afterEach(() => {
  cleanup();
  mock.restore();
  _chatAppDeps.mentionFileIndex = savedIndex;
});

async function prepareSurface(ui: ReturnType<typeof frameHarness>, surface: string) {
  await ui.resize(24);
  if (surface === "running") {
    await ui.start();
    await ui.submit("oldest queued");
  }
  if (surface === "picker") {
    await ui.submit("/model");
    ui.type("model");
  } else if (surface === "slash") ui.type("/");
  else if (surface === "mention") ui.type("@file");
  else ui.type("preserved");
  if (surface === "question") ui.ask(QUESTION);
  if (surface === "approval") ui.ask(APPROVAL);
  if (surface === "choice")
    await ui.settleAfter(() => {
      void ui.host.asks.requestHostChoice({
        tool: "Deploy",
        summary: "target",
        reason: "choose",
        choices: [
          { id: "one", label: "one" },
          { id: "two", label: "two" },
        ],
        fallback: "one",
      });
    });
}

describe("ChatApp state-preserving suspension", () => {
  test.each([
    ["idle", ["x", "\r"]],
    ["idle", ["\x13"]],
    ["running", ["x", "\r"]],
    ["running", ["\x13"]],
    ["question", ["x", "\r"]],
    ["approval", ["a"]],
    ["approval", ["\x1b[B", "\r"]],
    ["choice", ["2"]],
    ["picker", ["b", "\x1b[B", "\x1b[C", "\r"]],
    ["slash", ["\x1b[B", "\t"]],
    ["mention", ["\x1b[B", "\t"]],
    ["slash", ["\x1b[B", "\r"]],
    ["mention", ["\x1b[B", "\r"]],
    ["slash", ["\x1b"]],
    ["mention", ["\x1b"]],
    ["idle", ["\x0f"]],
    ["idle", ["\x02"]],
    ["idle", ["\x14"]],
    ["idle", ["\x1b[Z"]],
    ["idle", ["\x1b", "\x1b"]],
    ["idle", ["\x16"]],
    ["idle", ["\x07"]],
    ["running", ["\x0f"]],
    ["running", ["\x02"]],
    ["running", ["\x14"]],
    ["running", ["\x1b[Z"]],
    ["running", ["\x1b", "\x1b"]],
    ["running", ["\x16"]],
    ["running", ["\x07"]],
  ] as const)("US-004 AC-8..18 AC-22 isolated %s controls %j freeze and restore", async (surface, controls) => {
    _chatAppDeps.mentionFileIndex = () => ({
      get: async () => ({
        git: true,
        rows: [
          { path: "file-a.ts", folder: false },
          { path: "file-b.ts", folder: false },
        ],
      }),
    });
    // Three independent sessions: hidden-only, hidden-and-restored, and never-shrunk.
    const run = async (mode: "hidden" | "restored" | "visible") => {
      const clipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
      const mouse = fakeMouse();
      const ui = frameHarness({ mouse: mouse.events });
      const resolve = spyOn(ui.host.asks, "resolve");
      const answer = spyOn(ui.host.asks, "answerQuestion");
      const choice = spyOn(ui.host.asks, "resolveChoice");
      const steer = mock(ui.host.steer);
      ui.host.steer = steer;
      await prepareSurface(ui, surface);
      await ui.settle();
      const before = ui.rows();
      const count = () => ({
        steers: steer.mock.calls.length,
        resolves: resolve.mock.calls.length,
        answers: answer.mock.calls.length,
        choices: choice.mock.calls.length,
        clipboard: clipboard.mock.calls.length,
        switches: ui.switchTo.mock.calls.length,
      });
      const sends = spyOn(ui.host, "send");
      const cancels = spyOn(ui.host, "cancel");
      const snapshot = () => ({ ...count(), sends: sends.mock.calls.length, cancels: cancels.mock.calls.length });
      const effects = snapshot();
      if (mode !== "visible") {
        await ui.resize(2);
        for (const key of controls) ui.press(key);
        for (const kind of ["press", "drag", "release", "wheelUp", "wheelDown"] as const)
          act(() => mouse.emit(kind, { button: "left", x: 1, y: 4 }));
        await ui.settle();
        expect(snapshot()).toEqual(effects);
        await ui.resize(24);
        expect(ui.rows()).toEqual(before);
      }
      if (mode !== "hidden") {
        for (const key of controls) ui.press(key);
        await ui.settle();
      }
      const result = {
        rows: ui.rows(),
        effects: snapshot(),
        pending: ui.host.asks.pending().map((ask) => ask.type),
        decisions: resolve.mock.calls.map((call) => call.slice(1)),
        answers: answer.mock.calls.map((call) => call.slice(1)),
        choices: choice.mock.calls.map((call) => call.slice(1)),
      };
      ui.ui.unmount();
      mock.restore();
      return result;
    };
    await run("hidden");
    expect(await run("restored")).toEqual(await run("visible"));
  });

  test.each([false, true])("US-004 AC-19..21 diagnostic Ctrl-C consults confirmation, allow=%s", async (allow) => {
    const ui = frameHarness();
    const confirm = mock(async () => allow);
    Object.assign(ui.host, { confirmBeforeClose: confirm });
    await ui.resize(2);
    ui.press("\x03");
    await ui.settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ui.host.close).toHaveBeenCalledTimes(allow ? 1 : 0);
  });

  test.each(["input", "picker"] as const)(
    "US-004 AC-6 AC-7 ask takes keys over %s without stealing viewport shortcuts",
    async (underlay) => {
      const ui = frameHarness();
      await ui.resize(24);
      await ui.start();
      ui.emit({ type: "text_delta", text: Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n"), round: 1 });
      ui.emit(COMPLETED);
      await ui.finish();
      if (underlay === "picker") await ui.submit("/model");
      else ui.type("underlying draft");
      ui.ask(QUESTION);
      const answer = spyOn(ui.host.asks, "answerQuestion");
      ui.type("visible answer");
      ui.press("\x1b[5~");
      expect(ui.rows().join("\n")).toContain("Scroll to bottom");
      ui.press("\r");
      await ui.settle();
      expect(answer).toHaveBeenCalledWith("q1", "visible answer");
      expect(ui.host.send).toHaveBeenCalledTimes(1);
      expect(ui.switchTo).not.toHaveBeenCalled();
      if (underlay === "input") expect(ui.rows().join("\n")).toContain("> underlying draft");
      else {
        expect(ui.rows()).toContain("Switch model");
        expect(ui.rows()).toContain("type to filter");
      }
    },
  );

  test("US-004 AC-7 picker query and choose cannot edit or submit the hidden input", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.submit("/model");
    ui.type("model-b");
    ui.press("\x1b[B");
    ui.press("\r");
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "model-b" });
    expect(ui.host.send).not.toHaveBeenCalled();
    expect(ui.rows().join("\n")).not.toContain("> model-b");
  });

  test("US-004 AC-20 diagnostic close confirmation ask stays unanswerable until expanded", async () => {
    const ui = frameHarness();
    Object.assign(ui.host, {
      confirmBeforeClose: async () => (await ui.host.asks.requestHostQuestion({ text: "Close this chat?" })) === "yes",
    });
    const answer = spyOn(ui.host.asks, "answerQuestion");
    await ui.resize(2);
    ui.press("\x03");
    await ui.settle();
    expect(ui.host.asks.pending()).toHaveLength(1);
    ui.type("yes");
    ui.press("\r");
    expect(answer).not.toHaveBeenCalled();
    expect(ui.host.close).not.toHaveBeenCalled();
    await ui.resize(24);
    expect(ui.rows().join("\n")).toContain("Close this chat?");
    ui.type("yes");
    ui.press("\r");
    await ui.settle();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(ui.host.close).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("US-004 AC-20 AC-21 armed running Ctrl-C confirmation allow=%s", async (allow) => {
    const ui = frameHarness();
    const confirm = mock(async () => allow);
    Object.assign(ui.host, { confirmBeforeClose: confirm });
    await ui.resize(24);
    await ui.start();
    await ui.resize(2);
    ui.press("\x03");
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
    ui.press("\x03");
    await ui.settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ui.host.close).toHaveBeenCalledTimes(allow ? 1 : 0);
  });

  test.each([false, true])("AC-17 input draft and history survive diagnostic busy=%s", async (busy) => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.submit("history message");
    if (!busy) {
      ui.emit(COMPLETED);
      await ui.finish();
    }
    ui.type("preserved draft");
    await ui.resize(3);
    ui.type("discarded");
    ui.press("\r");
    await ui.resize(24);
    expect(ui.rows().at(-3)).toBe("> preserved draft");
    ui.press("\x15");
    ui.press("\x1b[A");
    expect(ui.rows().at(-3)).toBe("> history message");
  });
  test("AC-18 question answer survives diagnostic for the same request", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    ui.ask(QUESTION);
    ui.type("my answer");
    await ui.resize(4);
    ui.type("discarded");
    ui.press("\r");
    await ui.resize(24);
    expect(ui.host.asks.pending()).toHaveLength(1);
    expect(ui.rows().join("\n")).toContain("> my answer");
    expect(ui.rows().join("\n")).not.toContain("discarded");
  });
  test("AC-19 AC-24 pending items and running ask survive diagnostic without settlement", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    ui.steer("steer one");
    await ui.submit("queue two");
    ui.ask(QUESTION);
    await ui.resize(2);
    await ui.resize(24);
    expect(ui.host.cancel).not.toHaveBeenCalled();
    expect(ui.host.asks.pending()[0]?.requestId).toBe("q1");
    await ui.settleAfter(() => ui.host.asks.declineQuestion("q1"));
    expect(ui.rows().filter((row) => /^(steering|queued) ·/.test(row))).toEqual([
      "steering · steer one",
      "queued · queue two",
    ]);
  });
  test("AC-20 filtered picker query and selection survive diagnostic", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.submit("/model");
    ui.type("model");
    ui.press("\x1b[B");
    const selected = ui.rows().find((row) => row.startsWith("❯"));
    expect(selected).toContain("model-b");
    await ui.resize(3);
    ui.type("discarded");
    ui.press("\x1b[B");
    ui.press("\r");
    await ui.resize(24);
    expect(ui.rows()).toContain("Filter: model");
    expect(ui.rows().find((row) => row.startsWith("❯"))).toBe(selected);
    expect(ui.switchTo).not.toHaveBeenCalled();
  });
  test.each(["slash", "mention"])(
    "AC-21 AC-22 %s selection demand and dismissal survive zero rows and diagnostic",
    async (kind) => {
      _chatAppDeps.mentionFileIndex = () => ({
        get: async () => ({
          git: true,
          rows: Array.from({ length: 12 }, (_, i) => ({ path: `file-${i}.ts`, folder: false })),
        }),
      });
      const ui = frameHarness();
      await ui.resize(24);
      ui.type(kind === "slash" ? "/" : "@file");
      await ui.settle();
      ui.press("\x1b[B");
      ui.press("\x1b[B");
      const before = ui.rows();
      const selected = before.find((row) => row.startsWith("❯"));
      expect(selected).toBeDefined();
      for (const height of [5, 2]) {
        await ui.resize(height);
        ui.press("\x1b[B");
        await ui.resize(24);
        expect(ui.rows().find((row) => row.startsWith("❯"))).toBe(selected);
        expect(ui.rows()).toEqual(before);
      }
      ui.press("\x1b");
      const dismissed = ui.rows();
      await ui.resize(2);
      await ui.resize(24);
      expect(ui.rows()).toEqual(dismissed);
      expect(ui.rows().some((row) => row.startsWith("❯"))).toBe(false);
    },
  );
  test("AC-16 AC-23 zero-height viewport draws nothing and retains scroll/follow memory", () => {
    const lines = Array.from({ length: 40 }, (_, i) => [{ text: `line ${i}` }]);
    const ui = render(<TranscriptViewport lines={lines} height={6} theme={theme} />);
    act(() => ui.stdin.write("\x1b[5~"));
    const before = ui.lastFrame();
    expect(before).toContain("Scroll to bottom");
    act(() => ui.rerender(<TranscriptViewport lines={lines} height={0} theme={theme} />));
    expect(ui.lastFrame()).toBe("");
    act(() => ui.rerender(<TranscriptViewport lines={lines} height={6} theme={theme} />));
    expect(ui.lastFrame()).toBe(before);
    act(() => ui.stdin.write("\x1b[F"));
    expect(ui.lastFrame()).toContain("line 39");
  });
  test("AC-23 ChatApp transcript scroll survives diagnostic", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    ui.emit({ type: "text_delta", text: Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n"), round: 1 });
    ui.press("\x1b[5~");
    const before = ui.rows();
    expect(before.join("\n")).toContain("Scroll to bottom");
    await ui.resize(2);
    await ui.resize(24);
    expect(ui.rows()).toEqual(before);
  });
  test("AC-25 AC-27 host content and resize subscriptions remain alive in diagnostic", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    await ui.resize(2);
    expect(ui.rows()[0]).toStartWith("Terminal too small");
    ui.emit({ type: "text_delta", text: "arrived while hidden", round: 1 });
    await ui.resize(24);
    expect(ui.rows().join("\n")).toContain("arrived while hidden");
    expect(ui.host.send).toHaveBeenCalledTimes(1);
    expect(ui.rows()).toHaveLength(23);
  });
  test("AC-26 external ask expiry remains authoritative during diagnostic", async () => {
    const clock = makeFakeClock();
    const saved = { ..._askControllerDeps };
    Object.assign(_askControllerDeps, fakeTimers(clock));
    const ui = frameHarness();
    let expired: Promise<string | null> | undefined;
    try {
      await ui.resize(24);
      await ui.settleAfter(() => {
        expired = ui.host.asks.requestHostQuestion({ text: "Proceed?" });
      });
      await ui.resize(2);
      await ui.settleAfter(() => clock.advance(600_000));
      expect(await expired).toBeNull();
    } finally {
      Object.assign(_askControllerDeps, saved);
    }
    await ui.resize(24);
    expect(ui.host.asks.pending()).toHaveLength(0);
    expect(ui.rows().join("\n")).not.toContain("Proceed?");
    expect(ui.rows().join("\n")).toContain("Try");
  });
  test("diagnostic keeps only Ctrl-C control with its existing confirmation", async () => {
    const ui = frameHarness();
    await ui.resize(2);
    ui.press("\x1b[Z");
    ui.press("\x14");
    await ui.settle();
    expect(ui.switchTo).not.toHaveBeenCalled();
    await ui.resize(24);
    await ui.start();
    await ui.resize(2);
    ui.press("\x1b[Z");
    ui.press("\x14");
    ui.press("\x02");
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.rows()).toEqual(["Terminal too small — enlarge to continue"]);
    ui.press("\x03");
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
    expect(ui.host.close).not.toHaveBeenCalled();
    ui.press("\x03");
    await ui.settle();
    expect(ui.host.close).toHaveBeenCalledTimes(1);
  });
  test("approval selection stays mounted while the whole surface is suspended", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    ui.ask(APPROVAL);
    ui.press("\x1b[B");
    const selected = ui.rows().find((row) => row.startsWith("❯"));
    expect(selected).toBeDefined();
    await ui.resize(2);
    ui.press("\x1b[B");
    await ui.resize(24);
    expect(ui.rows().find((row) => row.startsWith("❯"))).toBe(selected);
  });
  test("AC-15 undersized approval cannot answer hidden options", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    ui.ask(APPROVAL);
    await ui.resize(8);
    expect(ui.rows()).toEqual(["Terminal too small — enlarge to continue"]);
    ui.press("a");
    ui.press("\r");
    ui.press("\x1b");
    expect(ui.host.asks.pending()).toHaveLength(1);
    await ui.resize(24);
    expect(ui.rows().join("\n")).toContain("echo hi");
  });
  test("AC-13 hidden queue drain updates overflow through the existing send path", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let listener: ((event: SessionEvent) => void) | undefined;
    let calls = 0;
    const ui = frameHarness({
      send: async (_message, onEvent) => {
        listener = onEvent;
        await gates[calls++]?.promise;
      },
    });
    await ui.resize(24);
    await ui.submit("hello");
    for (let i = 0; i < 4; i++) ui.steer(`steer ${i}`);
    for (let i = 0; i < 8; i++) await ui.submit(`queue ${i}`);
    expect(ui.rows()).toContain("+9 pending");
    const emit = listener;
    assertDefined(emit, "send listener");
    await ui.settleAfter(() => {
      emit({ sessionId: "picker-session", turnId: "t1", at: "now", metadata: {}, ...COMPLETED });
      gates[0]?.resolve();
    });
    expect(calls).toBe(2);
    expect(ui.rows()).toContain("+8 pending");
    await ui.settleAfter(() => gates[1]?.resolve());
  });
});
