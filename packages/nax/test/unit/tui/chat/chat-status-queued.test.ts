/**
 * US-005: the footer's `queued` hint — its own gesture text, and where it sits in the
 * precedence order.
 *
 * A line typed during a turn waits in the queue, and ctrl+s now sends the oldest of them. That
 * key is worth nothing unless the footer names it, so the footer offers `ctrl+s to send queued
 * now` while a line waits and nothing more pressing owns the row. `footerHint` decides which
 * hint that is from the screen's facts alone, so the cases here are its input and its answer.
 *
 * Split out of `chat-status.test.ts` (the footer's composition cases) so the file keeps room
 * under its size cap.
 */
import { describe, expect, test } from "bun:test";
import { hintSpans } from "@/tui/chat/chat-status";
import { footerHint } from "@/tui/chat/use-clipboard-feedback";

describe("footerHint with a queued line", () => {
  /** The footer's gesture inputs with nothing armed, a turn running and nothing drawn over it. */
  const QUEUED_INPUT = {
    busy: true,
    queued: true,
    layer: false,
    quitArmed: false,
    clearArmed: false,
    expanded: false,
    backgroundable: true,
    tmux: false,
  };

  test("AC-10 gives the queued hint ahead of the background one", () => {
    expect(footerHint(QUEUED_INPUT)).toBe("queued");
  });

  test("AC-11 gives the background hint when nothing is queued", () => {
    expect(footerHint({ ...QUEUED_INPUT, queued: false })).toBe("background");
  });

  test("AC-12 keeps the esc layer's own hint ahead of the queued one", () => {
    expect(footerHint({ ...QUEUED_INPUT, layer: true })).toBe("layer");
  });

  test("an armed quit and an armed clear still come first", () => {
    expect(footerHint({ ...QUEUED_INPUT, quitArmed: true })).toBe("quit");
    expect(footerHint({ ...QUEUED_INPUT, clearArmed: true })).toBe("clear");
  });

  test("a caller that omits queued keeps the result it had before the field existed", () => {
    const { queued: _queued, ...withoutQueued } = QUEUED_INPUT;
    expect(footerHint(withoutQueued)).toBe("background");
  });

  test("an idle turn offers the idle hint whatever the queue holds", () => {
    expect(footerHint({ ...QUEUED_INPUT, busy: false })).toBe("idle");
  });
});

describe("hintSpans for the queued hint", () => {
  test("AC-13 names the interrupt as its gesture and ctrl+s as its extra", () => {
    const { gesture, extra } = hintSpans("queued");
    expect(gesture.text).toBe("esc to interrupt");
    expect(extra?.text).toBe("ctrl+s to send queued now");
  });
});
