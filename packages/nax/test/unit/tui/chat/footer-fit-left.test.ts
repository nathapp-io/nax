import { describe, expect, test } from "bun:test";
import type { SandboxState } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import { type FooterHint, IDLE_STATUS } from "@/tui/chat/chat-status";
import { fittedFooterModel } from "@/tui/chat/status-layout";
import { plainText, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatGlyphs, resolveChatTheme } from "@/tui/chat/theme";
import { spansWidth } from "@/tui/chat/wrap";

/**
 * The fitter's left-side steps (US-003): the sandbox warning, the mode, the cost and the
 * elided last resort, observed through what the row is drawn with. The story's fixture is
 * guarded, `opencode-go/deepseek-v4.1-flash`, $0.42, no jobs, no tasks, no context meter,
 * Unicode glyphs and an idle turn status.
 */
const MODEL = "opencode-go/deepseek-v4.1-flash";
const COST_USD = 0.42;
const SESSION_ID = "fit-left";
const AVAILABLE: SandboxState = { kind: "available", backend: "srt", network: "open" };
const UNAVAILABLE: SandboxState = { kind: "unavailable", backend: "srt", reason: "no-backend" };

/** The columns between the left and right sides, counted only when the right side is drawn. */
const GAP = 2;
/** The marker the last resort ends a cut left side with, from the Unicode glyph set. */
const ELLIPSIS = "…";
/** What step 8 shortens the sandbox warning to, and the warning it replaces. */
const SHORT_WARNING = "sandbox n/a";
const LONG_WARNING = "sandbox unavailable";
const WIDEST = 120;
const NARROWEST = 10;

/** The three sandbox states the invariants range over; `absent` is no state at all. */
type SandboxName = "available" | "unavailable" | "absent";
const SANDBOX_NAMES: readonly SandboxName[] = ["available", "unavailable", "absent"];
const MODES: readonly ChatHostState["mode"][] = ["guarded", "full"];
const HINTS: readonly FooterHint[] = [
  "idle",
  "busy",
  "background",
  "backgroundTmux",
  "expanded",
  "clear",
  "copied",
  "quit",
];
const WIDTHS: readonly number[] = Array.from({ length: WIDEST - NARROWEST + 1 }, (_, index) => NARROWEST + index);

/** The story's fixture state, with the fields a case cares about overridden. */
function chatState(overrides: Partial<ChatHostState> = {}): ChatHostState {
  return {
    sessionId: SESSION_ID,
    mode: "guarded",
    model: MODEL,
    sandbox: AVAILABLE,
    meta: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      cwd: "/repo",
      mode: "ask",
      model: MODEL,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: COST_USD,
    },
    ...overrides,
  };
}

/** The state fields one sandbox name stands for; an absent sandbox carries no state at all. */
function sandboxOf(name: SandboxName): SandboxState | undefined {
  if (name === "available") return AVAILABLE;
  return name === "unavailable" ? UNAVAILABLE : undefined;
}

interface FitOptions {
  readonly width: number;
  readonly hint?: FooterHint;
  readonly state?: Partial<ChatHostState>;
  readonly layerHint?: string;
  readonly glyphs?: ChatGlyphs;
}

/** The footer the fitter produces for one input, in the terms the criteria read it. */
function fitted(options: FitOptions) {
  const footer = fittedFooterModel({
    width: options.width,
    state: chatState(options.state),
    status: IDLE_STATUS,
    hint: options.hint ?? "busy",
    ...(options.layerHint === undefined ? {} : { layerHint: options.layerHint }),
    ...(options.glyphs === undefined ? {} : { glyphs: options.glyphs }),
  });
  return { footer, left: plainText(footer.left), right: plainText(footer.right) };
}

/** The fitted footer for one sandbox name, so a matrix case names only the state it varies. */
function fittedWithSandbox(options: FitOptions & { readonly sandbox: SandboxName }) {
  return fitted({ ...options, state: { ...options.state, sandbox: sandboxOf(options.sandbox) } });
}

/** Left width plus right width plus the gap the row reserves only for a drawn right side. */
function rowWidth(footer: { readonly left: StyledLine; readonly right: StyledLine }): number {
  return spansWidth(footer.left) + spansWidth(footer.right) + (footer.right.length === 0 ? 0 : GAP);
}

describe("fittedFooterModel keeps the cost beside an unavailable sandbox warning", () => {
  test("AC-1 at 40 columns the short warning replaces the mode and the long warning", () => {
    expect(fittedWithSandbox({ width: 40, sandbox: "unavailable" }).left).toBe("esc to interrupt · sandbox n/a");
  });

  test("AC-2 the cost survives the warning's short form", () => {
    expect(fittedWithSandbox({ width: 40, sandbox: "unavailable" }).right).toBe("$0.42");
  });

  test("AC-3 the short warning is drawn as a warning", () => {
    const { footer } = fittedWithSandbox({ width: 40, sandbox: "unavailable" });
    const warning = footer.left.find((span) => span.text.includes("sandbox n/a"));
    expect(warning?.color).toBe("warning");
  });
});

describe("fittedFooterModel drops a sandbox that is off before the mode", () => {
  test("AC-4 at 40 columns an absent sandbox leaves the mode and the gesture alone", () => {
    const footer = fittedWithSandbox({ width: 40, sandbox: "absent" });
    expect({ left: footer.left, right: footer.right }).toEqual({
      left: "⏵ guarded · esc to interrupt",
      right: "$0.42",
    });
  });

  test("AC-5 an overlay's own escape key stays ahead of the mode at 40 columns", () => {
    const footer = fittedWithSandbox({ width: 40, sandbox: "absent", hint: "layer", layerHint: "esc to deny" });
    // The absent sandbox's `sandbox off` segment goes (step 6) before the mode, so the overlay's
    // key, the mode and the cost are all drawn; only step 6 makes that fit at 40 columns.
    expect({ left: footer.left, right: footer.right }).toEqual({ left: "⏵ guarded · esc to deny", right: "$0.42" });
  });
});

describe("fittedFooterModel elides the last resort instead of cutting it", () => {
  test("AC-6 at 24 columns nothing is left on the right of an unavailable sandbox", () => {
    const footer = fittedWithSandbox({ width: 24, sandbox: "unavailable" });
    // The row the empty right side leaves behind is the short warning, marked: a bare cut of the
    // long warning would end mid-word and the pre-story fitter drew no marker at all.
    expect({ left: footer.left, right: footer.right }).toEqual({
      left: `esc to interrupt · sand${ELLIPSIS}`,
      right: "",
    });
    expect(footer.footer.stripWidth).toBe(0);
  });

  test("AC-7 at 24 columns the left side ends with the theme's ellipsis within the row", () => {
    const { footer, left } = fittedWithSandbox({ width: 24, sandbox: "unavailable" });
    expect(spansWidth(footer.left)).toBeLessThanOrEqual(24);
    expect(left.endsWith(ELLIPSIS)).toBe(true);
  });

  test("AC-11 a width of 0 leaves one column of left, marked", () => {
    const { footer, left } = fittedWithSandbox({ width: 0, sandbox: "available" });
    expect(spansWidth(footer.left)).toBeLessThanOrEqual(1);
    // One column is the marker's alone: the pre-story cut drew the first cluster of the footer.
    expect(left).toBe(ELLIPSIS);
  });

  test("a three-column ASCII marker on a two-column row is bounded to the row", () => {
    const glyphs = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 }).glyphs;
    const { footer, left } = fitted({ width: 2, glyphs });
    expect(left).toBe(glyphs.ellipsis.slice(0, 2));
    expect(spansWidth(footer.left)).toBeLessThanOrEqual(2);
  });
});

describe("fittedFooterModel fits every hint, mode and sandbox state", () => {
  test("AC-8 the two sides and their gap fit every width from 10 to 120", () => {
    const overflows: string[] = [];
    for (const width of WIDTHS) {
      for (const hint of HINTS) {
        for (const mode of MODES) {
          for (const sandbox of SANDBOX_NAMES) {
            const { footer } = fittedWithSandbox({ width, hint, sandbox, state: { mode } });
            const total = rowWidth(footer);
            if (total > width) overflows.push(`${hint}/${mode}/${sandbox} at ${width}: ${total} > ${width}`);
          }
        }
      }
    }
    expect(overflows).toEqual([]);
  });

  test("AC-8 an unavailable sandbox keeps its warning, whole or short, or is marked as cut", () => {
    // Fitting inside the width must not be bought by dropping the warning: it is drawn whole
    // where the row affords it, in short form at step 8, and as the marked head of an elision.
    const lost: string[] = [];
    for (const width of WIDTHS) {
      for (const hint of HINTS) {
        if (hint === "quit") continue;
        for (const mode of MODES) {
          const { left } = fittedWithSandbox({ width, hint, sandbox: "unavailable", state: { mode } });
          const keepsWarning = left.includes(LONG_WARNING) || left.includes(SHORT_WARNING) || left.endsWith(ELLIPSIS);
          if (!keepsWarning) lost.push(`${hint}/${mode} at ${width}: ${JSON.stringify(left)}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  test("AC-9 the left side never ends in a space, and never in a space before the ellipsis", () => {
    const trailing: string[] = [];
    for (const width of WIDTHS) {
      for (const hint of HINTS) {
        for (const sandbox of SANDBOX_NAMES) {
          const { left } = fittedWithSandbox({ width, hint, sandbox });
          if (left.endsWith(" ")) trailing.push(`${hint}/${sandbox} at ${width}: ends with a space`);
          if (left.includes(` ${ELLIPSIS}`)) trailing.push(`${hint}/${sandbox} at ${width}: space before the ellipsis`);
        }
      }
    }
    expect(trailing).toEqual([]);
  });
});

describe("fittedFooterModel normalises the width it is given", () => {
  test("AC-10 a fractional width fits exactly as its floor", () => {
    const fractional = fittedWithSandbox({ width: 40.9, sandbox: "unavailable" });
    const whole = fittedWithSandbox({ width: 40, sandbox: "unavailable" });
    expect({ left: fractional.left, right: fractional.right }).toEqual({ left: whole.left, right: whole.right });
    // …and what both are is the 40-column row steps 6–9 produce, not the pre-story cut of it.
    expect({ left: fractional.left, right: fractional.right }).toEqual({
      left: `esc to interrupt · ${SHORT_WARNING}`,
      right: "$0.42",
    });
  });

  test("AC-13 every finite width below 1 or between two columns fits as its normalised width", () => {
    const widths = [-3, -0.5, 0, 0.0001, 0.5, 0.999, 1.2, 2.5, 12.75, 23.5, 24.9, 39.5, 40.9, 79.5];
    const mismatches = widths
      .map((width) => ({ width, normalised: Math.max(1, Math.floor(width)) }))
      .filter(({ width, normalised }) => {
        const given = fittedWithSandbox({ width, sandbox: "unavailable" });
        const floor = fittedWithSandbox({ width: normalised, sandbox: "unavailable" });
        return given.left !== floor.left || given.right !== floor.right;
      })
      .map(({ width, normalised }) => `${width} differs from ${normalised}`);
    expect(mismatches).toEqual([]);
    // Normalisation feeds the whole pipeline, so the anchored widths land on its own answers: the
    // short warning at 40 columns, and the marker alone on the one-column floor.
    expect(fittedWithSandbox({ width: 40.9, sandbox: "unavailable" }).left).toBe(`esc to interrupt · ${SHORT_WARNING}`);
    expect(fittedWithSandbox({ width: 0.999, sandbox: "unavailable" }).left).toBe(ELLIPSIS);
  });
});
