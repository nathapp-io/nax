import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxState } from "@nathapp/nax-agent";
import { mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";
import type { FooterSegment } from "@/tui/chat/footer-segments";
import { _statusLayoutDeps } from "@/tui/chat/status-layout";

/**
 * The mounted screen's footer row, as the fitter decides it: the last row of the frame, at the
 * terminal size the stream reports. The story's fixture is guarded, an available sandbox and
 * the model the criteria name, so the row is the one a narrow terminal draws.
 */
const MODEL = "opencode-go/deepseek-v4.1-flash";
const AVAILABLE: SandboxState = { kind: "available", backend: "srt", network: "open" };
const UNAVAILABLE: SandboxState = { kind: "unavailable", backend: "srt", reason: "no-backend" };
/** What a stubbed `footerSegments` returns, so the row can only come from those segments. */
const STUB_GESTURE = "STUB-GESTURE";
const STUB_COST = "STUB-COST";
const STUB: { readonly left: readonly FooterSegment[]; readonly right: readonly FooterSegment[] } = {
  left: [{ role: "gesture", span: { text: STUB_GESTURE } }],
  right: [{ role: "cost", span: { text: STUB_COST } }],
};

const originalFooterSegments = _statusLayoutDeps.footerSegments;
afterEach(() => {
  cleanup();
  _statusLayoutDeps.footerSegments = originalFooterSegments;
});

/** The screen mounted over the story's fixture state. */
function mountScreen(sandbox: SandboxState = AVAILABLE) {
  return mountChatPicker({ current: { model: MODEL, sandbox } });
}

/**
 * Report a terminal size on the harness stream and redraw. `ink-testing-library`'s stdout has
 * a fixed `columns` of 100 and no `rows` until one is defined, so the screen sees the size only
 * after the `resize` event it listens for.
 */
async function resizeAt(screen: ReturnType<typeof mountScreen>, columns: number, rows: number): Promise<void> {
  const { stdout } = screen.ui;
  Object.defineProperty(stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(stdout, "rows", { value: rows, configurable: true });
  await Promise.resolve(
    act(async () => {
      stdout.emit("resize");
    }),
  );
}

/** The frame's last row — the footer. */
function footerRow(screen: ReturnType<typeof mountScreen>): string {
  return screen.rows().at(-1) ?? "";
}

describe("ChatApp footer over the segments it is given", () => {
  test("AC-15 an 80x20 screen draws the stubbed footerSegments' gesture and cost", async () => {
    _statusLayoutDeps.footerSegments = () => STUB;
    const screen = mountScreen();
    await resizeAt(screen, 80, 20);
    const row = footerRow(screen);
    expect(row).toContain(STUB_GESTURE);
    expect(row).toContain(STUB_COST);
  });

  test("AC-15 with the real segments the same screen draws no stub text", async () => {
    const screen = mountScreen();
    await resizeAt(screen, 80, 20);
    expect(footerRow(screen)).not.toContain(STUB_GESTURE);
  });
});

describe("ChatApp footer on a narrow terminal", () => {
  test("AC-16 a 40x20 screen with a running turn keeps the interrupt and the cost", async () => {
    const screen = mountScreen();
    await resizeAt(screen, 40, 20);
    await screen.submit("hello");
    screen.emit({ type: "turn_start" });
    const row = footerRow(screen);
    expect(row).toContain("esc to interrupt");
    expect(row).toContain("$0.00");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
    await screen.finish();
  });

  test("AC-12 a 40x20 screen on an unavailable sandbox keeps the short warning and the cost", async () => {
    const screen = mountScreen(UNAVAILABLE);
    await resizeAt(screen, 40, 20);
    await screen.submit("hello");
    screen.emit({ type: "turn_start" });
    const row = footerRow(screen);
    expect(row).toContain("sandbox n/a");
    expect(row).toContain("$0.00");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
    await screen.finish();
  });
});
