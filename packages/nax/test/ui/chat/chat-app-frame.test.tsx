import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompactResult } from "@nathapp/nax-agent";
import { cleanup } from "ink-testing-library";
import { _chatAppDeps } from "@/tui/chat/ChatApp";
import { APPROVAL, COMPLETED, frameHarness, QUESTION } from "./frame-harness";

const savedIndex = _chatAppDeps.mentionFileIndex;

const HEIGHTS = [2, 3, 4, 5, 8, 9, 10, 12, 24, 40];
afterEach(() => {
  cleanup();
  mock.restore();
  _chatAppDeps.mentionFileIndex = savedIndex;
});

type FrameScreen = ReturnType<typeof frameHarness>;

async function populatePending(ui: FrameScreen, surface: string): Promise<void> {
  if (surface === "queue" || surface === "mixed") for (let i = 0; i < 4; i++) await ui.submit(`queue ${i}`);
  if (surface === "steer" || surface === "mixed") for (let i = 0; i < 5; i++) ui.steer(`steer ${i}`);
}

async function prepareFrameSurface(surface: string): Promise<FrameScreen> {
  _chatAppDeps.mentionFileIndex = () => ({
    get: async () => ({ git: true, rows: [{ path: "file.ts", folder: false }] }),
  });
  const ui = frameHarness();
  await ui.resize(24);
  if (["busy", "busy-short", "busy-long", "queue", "steer", "mixed"].includes(surface)) await ui.start();
  if (surface.includes("short")) ui.type("draft");
  if (surface.includes("long")) ui.type("long draft ".repeat(100));
  if (surface === "slash") ui.type("/");
  if (surface === "mention") {
    ui.type("@file");
    await ui.settle();
  }
  await populatePending(ui, surface);
  if (surface === "question") {
    ui.ask(QUESTION);
    ui.type("answer ".repeat(100));
  }
  if (surface === "approval") ui.ask(APPROVAL);
  if (surface === "picker") await ui.submit("/model");
  return ui;
}

describe("ChatApp allocated physical frame", () => {
  test.each([
    "idle",
    "busy",
    "short",
    "busy-short",
    "long",
    "busy-long",
    "slash",
    "mention",
    "queue",
    "steer",
    "mixed",
    "question",
    "approval",
    "picker",
  ])("AC-1 AC-28 bounds every complete %s frame at supported widths", async (surface) => {
    const ui = await prepareFrameSurface(surface);
    for (const width of [40, 80, 120])
      for (const height of HEIGHTS) {
        await ui.resize(height, width);
        expect(ui.rows().length).toBeLessThanOrEqual(height - 1);
        expect(ui.rows().every((row) => Bun.stringWidth(row) <= width)).toBe(true);
      }
  });
  test("AC-2 AC-15 one-row diagnostic replaces all interactive regions", async () => {
    const ui = frameHarness();
    await ui.resize(1, 40);
    expect(ui.rows()).toEqual(["Terminal too small — enlarge to continue"]);
    ui.type("hidden");
    ui.press("\r");
    expect(ui.host.send).not.toHaveBeenCalled();
    await ui.resize(24);
    expect(ui.rows().join("\n")).not.toContain("hidden");
    await ui.resize(1, 20);
    expect(ui.rows()).toHaveLength(1);
    expect(Bun.stringWidth(ui.rows()[0] ?? "")).toBeLessThanOrEqual(20);
    expect(ui.rows()[0]).toStartWith("Terminal too small");
  });
  test.each([undefined, 0])("AC-3 fallback dimensions for %s", async (dimension) => {
    const ui = frameHarness();
    await ui.resize(dimension, dimension);
    expect(ui.rows()).toHaveLength(23);
    expect(ui.rows()[2]).toBe("─".repeat(80));
  });
  test("AC-4 full-height idle composition retains header transcript input footer", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    expect(ui.rows()).toHaveLength(23);
    expect(ui.rows()[0]).toContain("nax chat");
    expect(ui.rows()[2]).toBe("─".repeat(80));
    expect(ui.rows()[3]).toContain("skills");
    expect(ui.rows().slice(-4)[0]).toBe("─".repeat(80));
    expect(ui.rows().at(-1)).toContain("guarded");
  });
  test.each([17, 40])("AC-5 %i unresolved steers fit 80x24", async (count) => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    for (let i = 0; i < count; i++) ui.steer(`steer ${i}`);
    expect(ui.rows()).toHaveLength(23);
    expect(ui.rows()).toContain(`+${count - 3} pending`);
  });
  test("AC-6 four queued messages fit 80x12", async () => {
    const ui = frameHarness();
    await ui.resize(12);
    await ui.start();
    for (let i = 0; i < 4; i++) await ui.submit(`queue ${i}`);
    expect(ui.rows()).toHaveLength(11);
    expect(ui.rows()).toContain("+3 pending");
  });
  test.each([0, 1, 2, 3, 4])("AC-7 AC-8 AC-9 dedicated working gaps with %i pending", async (count) => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    for (let i = 0; i < count; i++) await ui.submit(`queue ${i}`);
    const thinking = ui.rows().findIndex((row) => row.includes("Thinking…"));
    expect(thinking).toBeGreaterThan(0);
    expect(ui.rows()[thinking - 1]).toBe("");
    expect(ui.rows()[thinking + 1]).toBe("");
    ui.emit({ type: "text_delta", text: "writing", round: 1 });
    const writing = ui.rows().findIndex((row) => row.includes("Writing…"));
    expect(writing).toBe(thinking);
    expect(ui.rows()[writing - 1]).toBe("");
    expect(ui.rows()[writing + 1]).toBe("");
    ui.emit(COMPLETED);
    expect(ui.rows().some((row) => /Thinking…|Writing…/.test(row))).toBe(false);
    expect(ui.rows().slice(-4)[0]).toBe("─".repeat(80));
    expect(ui.rows()).toHaveLength(23);
  });
  test("AC-9 ended status leaves the viewport directly adjacent to the input", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    ui.emit({ type: "text_delta", round: 1, text: "transcript content ".repeat(500) });
    ui.emit(COMPLETED);
    ui.press("\x1b[5~");
    const marker = ui.rows().findIndex((row) => row.includes("Scroll to bottom"));
    expect(marker).toBe(ui.rows().length - 5);
    expect(ui.rows()[marker + 1]).toBe("─".repeat(80));
  });
  test("AC-7 non-turn compaction uses the same explicitly padded status region", async () => {
    const ui = frameHarness();
    const gate = Promise.withResolvers<CompactResult>();
    ui.host.compact = () => gate.promise;
    await ui.resize(24);
    await ui.submit("/compact");
    const at = ui.rows().findIndex((row) => row.includes("compacting"));
    expect(at).toBeGreaterThan(0);
    expect(ui.rows()[at - 1]).toBe("");
    expect(ui.rows()[at + 1]).toBe("");
    await ui.settleAfter(() =>
      gate.resolve({
        compacted: true,
        tokensBefore: 100,
        tokensAfter: 50,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
      }),
    );
  });
  test("AC-10 pressure sheds both working gaps, not the status", async () => {
    const ui = frameHarness();
    await ui.resize(9);
    await ui.start();
    const at = ui.rows().findIndex((row) => row.includes("Thinking…"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ui.rows()[at + 1]).toBe("─".repeat(80));
    expect(ui.rows()[at - 1]).not.toBe("");
    expect(ui.rows()).toHaveLength(8);
  });
  test.each(["ask", "picker"])("AC-11 %s consumes no pending preview rows", async (surface) => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    await ui.submit("queued");
    if (surface === "ask") ui.ask(QUESTION);
    else {
      ui.emit(COMPLETED);
      await ui.finish();
      await ui.submit("/model");
    }
    expect(ui.rows().some((row) => /queued ·|steering ·|pending$/.test(row))).toBe(false);
    expect(ui.rows()).toHaveLength(23);
  });
  test("AC-12 hidden steer settlement updates combined summary", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    for (let i = 0; i < 8; i++) ui.steer(`steer ${i}`);
    expect(ui.rows()).toContain("+5 pending");
    await ui.settleAfter(() => ui.steers[7]?.resolve(true));
    expect(ui.rows()).toContain("+4 pending");
  });
  test("AC-14 pending projection returns in steer then queue order", async () => {
    const ui = frameHarness();
    await ui.resize(24);
    await ui.start();
    ui.steer("first");
    ui.steer("second");
    await ui.submit("third");
    await ui.submit("fourth");
    await ui.resize(5);
    await ui.resize(24);
    expect(ui.rows().filter((row) => /^(steering|queued) ·/.test(row))).toEqual([
      "steering · first",
      "steering · second",
      "queued · third",
      "queued · fourth",
    ]);
  });
});
