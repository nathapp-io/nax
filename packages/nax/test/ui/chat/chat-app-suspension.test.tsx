import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, fakeTimers, makeFakeClock } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { _askControllerDeps } from "@/chat/ask-controller";
import { _chatAppDeps } from "@/tui/chat/ChatApp";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";
import { APPROVAL, COMPLETED, frameHarness, QUESTION } from "./frame-harness";

const theme = resolveChatTheme({ env: {}, colorLevel: 0 });
const savedIndex = _chatAppDeps.mentionFileIndex;
afterEach(() => {
  cleanup();
  mock.restore();
  _chatAppDeps.mentionFileIndex = savedIndex;
});

describe("ChatApp state-preserving suspension", () => {
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
