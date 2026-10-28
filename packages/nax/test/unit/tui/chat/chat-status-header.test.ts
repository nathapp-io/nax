import { describe, expect, test } from "bun:test";
import type { SandboxState } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import { headerLines } from "@/tui/chat/chat-status";
import { displayWidth, MIN_LAYOUT_WIDTH, plainText, type StyledLine } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";

const GLYPHS = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;
const FOOTER_COST_USD = 0.42;

const AVAILABLE_SANDBOX: SandboxState = { kind: "available", backend: "srt", network: "open" };

/** The footer fixture: guarded, model `anthropic/m1`, a $0.42 session, sandbox available. */
function chatState(overrides: Partial<ChatHostState> = {}): ChatHostState {
  return {
    sessionId: "abcdefgh-1234",
    mode: "guarded",
    model: "anthropic/m1",
    meta: {
      schemaVersion: 1,
      sessionId: "abcdefgh-1234",
      cwd: "/repo",
      mode: "ask",
      model: "anthropic/m1",
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: FOOTER_COST_USD,
    },
    sandbox: AVAILABLE_SANDBOX,
    ...overrides,
  };
}

const HEADER_WIDTH = 60;
/** The columns a header path may take before the sandbox suffix needs the rest. */
const HEADER_PATH_BUDGET = HEADER_WIDTH - 20;
const HEADER_VERSION = "0.91.7";
const HEADER_CWD = "/Users/u/repo";
const HEADER_HOME = "/Users/u";

function header(
  options: { state?: Partial<ChatHostState>; version?: string; cwd?: string; home?: string; width?: number } = {},
): readonly StyledLine[] {
  return headerLines({
    state: chatState(options.state),
    version: options.version ?? HEADER_VERSION,
    cwd: options.cwd ?? HEADER_CWD,
    home: options.home ?? HEADER_HOME,
    width: options.width ?? HEADER_WIDTH,
  });
}

/** One of the header's three lines as text. */
function headerText(index: number, options: Parameters<typeof header>[0] = {}): string {
  return plainText(header(options)[index] ?? []);
}

describe("headerLines session title", () => {
  function titled(title: string | null, width = 100, model = "p/m", glyphs = GLYPHS): string {
    const state = chatState({ model, mode: "guarded" });
    return plainText(
      headerLines({
        state: { ...state, meta: { ...state.meta, title } },
        version: HEADER_VERSION,
        cwd: HEADER_CWD,
        home: HEADER_HOME,
        width,
        glyphs,
      })[0] ?? [],
    );
  }

  test("omits title before eliding an overflowing model", () => {
    expect(titled("fix login", 40, "p/abcdefghijklmnopqrstuvwx")).toBe(
      `${GLYPHS.thinking} nax chat v0.91.7 · abcdefgh… · guarded`,
    );
  });
  test("AC-13 appends a readable title", () => {
    expect(titled("fix login")).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m · guarded · fix login`);
  });
  test("AC-14 null title preserves the original header", () => {
    expect(titled(null)).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m · guarded`);
  });
  test("AC-15 elides a long title at the end within display width", () => {
    const line = titled("x".repeat(100), 60);
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(line.endsWith(GLYPHS.ellipsis)).toBe(true);
  });
  test("AC-16 renders legacy skill titles as slash commands", () => {
    expect(titled('<skill name="superpowers:brainstorming" source="test">body</skill>')).toEndWith(
      " · /superpowers:brainstorming",
    );
  });
  test.each(["界", "😀", "a\n\u001b[31mb"])("sanitizes and measures title %s using actual theme ellipsis", (text) => {
    const glyphs = { ...GLYPHS, ellipsis: "...", thinking: "CHAT" };
    const line = titled(text.repeat(100), 60, "p/界界", glyphs);
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(line).toEndWith("...");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
  });
  test("requires eight title columns after measuring the entire prefix and separator", () => {
    const prefix = titled(null);
    expect(titled("fix login", displayWidth(prefix) + 3 + 7)).toBe(prefix);
    expect(titled("fix login", displayWidth(prefix) + 3 + 8)).toBe(`${prefix} · fix log…`);
  });
});

describe("headerLines model allocation", () => {
  test("keeps a long unknown suffix whole even when fixed facts cannot fit", () => {
    const suffix = `[${"turbo".repeat(10)}]`;
    const line = headerText(0, { width: 40, state: { model: `provider/m${suffix}` } });
    expect(line).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · ${GLYPHS.ellipsis}${suffix} · guarded`);
  });
  test.each(["deepseek-v4.1-flash[high]", "a".repeat(40)])("shows the uncapped model %s at width 120", (name) => {
    const line = headerText(0, { width: 120, state: { model: `provider/${name}` } });
    expect(line).toContain(` · ${name} · guarded`);
    expect(line).not.toContain("…");
  });

  test.each([
    { width: 40, title: null, suffix: "[high]" },
    { width: 60, title: "fix login", suffix: "[high]" },
    { width: 40, title: null, suffix: "" },
  ])("elides only the name at width $width with suffix $suffix", ({ width, title, suffix }) => {
    const state = chatState({ model: `provider/${"a".repeat(40)}${suffix}` });
    const line = headerText(0, { width, state: { ...state, meta: { ...state.meta, title } } });
    expect(displayWidth(line)).toBeLessThanOrEqual(width);
    expect(line).toEndWith(`${GLYPHS.ellipsis}${suffix} · guarded`);
    expect(line).not.toContain("fix login");
  });

  test.each([GLYPHS, { ...GLYPHS, ellipsis: "...", thinking: "CHAT" }])(
    "keeps the whole theme ellipsis and suffix when no name fits",
    (glyphs) => {
      const state = chatState({ model: `provider/${"a".repeat(40)}[high]` });
      const prefix = `${glyphs.thinking} nax chat v${HEADER_VERSION} · `;
      const width = displayWidth(`${prefix}${glyphs.ellipsis}[high] · guarded`);
      const line = plainText(
        headerLines({ state, version: HEADER_VERSION, cwd: "/repo", home: "", width, glyphs })[0] ?? [],
      );
      expect(line).toBe(`${prefix}${glyphs.ellipsis}[high] · guarded`);
      expect(displayWidth(line)).toBe(width);
    },
  );

  test.each(["界", "😀", "a\n\u001b[31mb"])("measures and sanitizes model %s with ASCII ellipsis", (name) => {
    const glyphs = { ...GLYPHS, ellipsis: "..." };
    const state = chatState({ model: `provider/${name.repeat(40)}[turbo]` });
    const line = plainText(
      headerLines({ state, version: HEADER_VERSION, cwd: "/repo", home: "", width: 50, glyphs })[0] ?? [],
    );
    expect(displayWidth(line)).toBeLessThanOrEqual(50);
    expect(line).toEndWith("...[turbo] · guarded");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
  });
});

describe("headerLines", () => {
  test("gives three lines", () => {
    expect(header()).toHaveLength(3);
  });

  test("names the product, its version, the model and the mode first", () => {
    expect(headerText(0)).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m1 · guarded`);
  });

  test("draws the title accent and bold and the facts muted", () => {
    const [title] = header();
    expect(title?.[0]).toEqual({ text: `${GLYPHS.thinking} nax chat`, color: "accent", bold: true });
    expect(title?.[1]).toEqual({ text: " v0.91.7 · m1 · guarded", color: "muted" });
  });

  test("names the full mode as full", () => {
    expect(headerText(0, { state: { mode: "full" } })).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m1 · full`);
  });

  test("puts the shortened home path two columns in and the sandbox after it", () => {
    const line = headerText(1);
    expect(line.startsWith("  ~/repo")).toBe(true);
    expect(line.endsWith("sandbox on")).toBe(true);
    expect(line).toBe("  ~/repo · sandbox on");
  });

  test("leaves a path outside the home as it is", () => {
    expect(headerText(1, { cwd: "/opt/repo" })).toBe("  /opt/repo · sandbox on");
  });

  test("shows the home itself as a tilde", () => {
    expect(headerText(1, { cwd: HEADER_HOME })).toBe("  ~ · sandbox on");
  });

  test("leaves the path alone when no home is known", () => {
    expect(headerText(1, { home: "" })).toBe("  /Users/u/repo · sandbox on");
  });

  test("flattens a cwd carrying a line break onto the one row the header gives it", () => {
    const lines = header({ cwd: "/Users/u/re\npo" });
    expect(lines).toHaveLength(3);
    expect(plainText(lines[1])).toBe("  ~/re po · sandbox on");
    expect(lines.some((line) => plainText(line).includes("\n"))).toBe(false);
  });

  test("flattens a home carrying a line break before it is matched", () => {
    expect(headerText(1, { cwd: "/Users/ u/repo", home: "/Users/\nu" })).toBe("  ~/repo · sandbox on");
  });

  test("flattens a version and a model carrying a line break", () => {
    const title = headerText(0, { version: "0.91.7\nx", state: { model: "anthropic/m\n1" } });
    expect(title).toBe(`${GLYPHS.thinking} nax chat v0.91.7 x · m 1 · guarded`);
    expect(title.includes("\n")).toBe(false);
  });

  const SANDBOX_CASES: Array<[string, SandboxState | undefined, string]> = [
    ["available", AVAILABLE_SANDBOX, "sandbox on"],
    ["disabled", { kind: "disabled" }, "sandbox off"],
    ["absent", undefined, "sandbox off"],
    ["unavailable", { kind: "unavailable", backend: "srt", reason: "no bwrap" }, "sandbox unavailable"],
  ];

  test.each(SANDBOX_CASES)("labels the %s sandbox at the end of the second line", (_name, sandbox, label) => {
    const line = header({ state: { sandbox } })[1] ?? [];
    expect(plainText(line).endsWith(label)).toBe(true);
    expect(line.at(-1)).toEqual({ text: ` · ${label}`, color: "muted" });
  });

  test("draws a border rule as wide as the header", () => {
    expect(headerText(2)).toBe(GLYPHS.rule.repeat(HEADER_WIDTH));
    expect(header()[2]?.[0]?.color).toBe("border");
  });

  test("clamps a width under the minimum before drawing the rule", () => {
    expect(headerText(2, { width: 4 })).toBe(GLYPHS.rule.repeat(MIN_LAYOUT_WIDTH));
  });

  test("elides a long path in the middle to the room the sandbox suffix leaves", () => {
    const cwd = `/Users/u/${"x".repeat(60)}`;
    const line = headerText(1, { cwd });
    const shown = line.slice(2, line.indexOf(" · sandbox"));
    expect(shown).toContain("…");
    expect(displayWidth(shown)).toBeLessThanOrEqual(HEADER_PATH_BUDGET);
    expect(shown.startsWith("~/")).toBe(true);
    expect(shown.endsWith("x")).toBe(true);
  });

  test("keeps a path that just fits the budget whole", () => {
    const cwd = `/Users/u/${"x".repeat(HEADER_PATH_BUDGET - 2)}`;
    const shown = headerText(1, { cwd }).slice(2, headerText(1, { cwd }).indexOf(" · sandbox"));
    expect(shown).toBe(cwd.replace(HEADER_HOME, "~"));
    expect(displayWidth(shown)).toBe(HEADER_PATH_BUDGET);
  });
});
