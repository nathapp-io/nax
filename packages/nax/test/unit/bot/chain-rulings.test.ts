import { describe, expect, test } from "bun:test";
import {
  CHAIN_RULING_TEXT_CHARS,
  type ChainRuling,
  chainInstructions,
  chainRulingKey,
  parseChainRuling,
  renderChainRuling,
} from "@/bot/chain-rulings";
import { safeText } from "@/bot/render";
import { isNaxBotMarkerKey, withNaxBotMarker } from "@/forge/marker";

const CONFIRM_LINE = "Reply `confirm` to have nax fix it as reported, or `waive: <reason>` to close it.";
const lines = (s: string): string[] => s.split("\n");

describe("chainRulingKey", () => {
  test("replaces the f- prefix with cr-", () => {
    expect(chainRulingKey("f-ab12cd34")).toBe("cr-ab12cd34");
  });
  test("yields a valid marker key", () => {
    expect(isNaxBotMarkerKey(chainRulingKey("f-ab12cd34"))).toBe(true);
  });
});

describe("renderChainRuling", () => {
  test("renders fix on one line", () => {
    expect(renderChainRuling({ key: "f-1", outcome: "fix", text: "restore the guard" })).toBe(
      "Advisor ruling — fix: restore the guard",
    );
  });
  test("renders waived on two lines", () => {
    expect(lines(renderChainRuling({ key: "f-1", outcome: "waived", text: "base behaviour" }))).toEqual([
      "Advisor ruling — waived: base behaviour",
      "To change it, reply on this thread.",
    ]);
  });
  test("renders held without proposed on two lines", () => {
    expect(lines(renderChainRuling({ key: "f-1", outcome: "held", text: "low confidence" }))).toEqual([
      "Advisor ruling — held: low confidence",
      CONFIRM_LINE,
    ]);
  });
  test("renders held with a waived proposal", () => {
    const out = lines(
      renderChainRuling({
        key: "f-1",
        outcome: "held",
        text: "low confidence",
        proposed: { outcome: "waived", text: "spec excludes it" },
      }),
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toBe("Advisor proposed — waived: spec excludes it");
  });
  test("renders held with a fix proposal", () => {
    const out = lines(
      renderChainRuling({
        key: "f-1",
        outcome: "held",
        text: "low confidence",
        proposed: { outcome: "fix", text: "restore it" },
      }),
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toBe("Advisor proposed — fix: restore it");
  });
  test("joins a multi-line text on one line", () => {
    expect(renderChainRuling({ key: "f-1", outcome: "fix", text: "first\nsecond" })).toBe(
      "Advisor ruling — fix: first second",
    );
  });
  test("caps a long text with safeText", () => {
    const text = "a".repeat(3000);
    const out = renderChainRuling({ key: "f-1", outcome: "fix", text });
    expect(out.slice("Advisor ruling — fix: ".length)).toBe(safeText(text, CHAIN_RULING_TEXT_CHARS));
  });
  test("sanitises links and mentions with safeText", () => {
    const text = "see https://example.com and @octocat";
    const out = renderChainRuling({ key: "f-1", outcome: "fix", text });
    expect(out.slice("Advisor ruling — fix: ".length)).toBe(safeText(text, CHAIN_RULING_TEXT_CHARS));
  });
  test("cap constant is 1200", () => {
    expect(CHAIN_RULING_TEXT_CHARS).toBe(1200);
  });
});

describe("parseChainRuling", () => {
  test("round-trips fix", () => {
    const r: ChainRuling = { key: "f-1", outcome: "fix", text: "restore the guard" };
    expect(parseChainRuling(renderChainRuling(r))).toEqual({ outcome: "fix", text: "restore the guard" });
  });
  test("round-trips waived", () => {
    const r: ChainRuling = { key: "f-1", outcome: "waived", text: "base behaviour" };
    expect(parseChainRuling(renderChainRuling(r))).toEqual({ outcome: "waived", text: "base behaviour" });
  });
  test("round-trips held", () => {
    const r: ChainRuling = { key: "f-1", outcome: "held", text: "low confidence" };
    expect(parseChainRuling(renderChainRuling(r))).toEqual({ outcome: "held", text: "low confidence" });
  });
  test("round-trips held with proposed", () => {
    const r: ChainRuling = {
      key: "f-1",
      outcome: "held",
      text: "low confidence",
      proposed: { outcome: "waived", text: "spec excludes it" },
    };
    expect(parseChainRuling(renderChainRuling(r))).toEqual({
      outcome: "held",
      text: "low confidence",
      proposed: { outcome: "waived", text: "spec excludes it" },
    });
  });
  test("reads a marker-wrapped body like a bare one", () => {
    const r: ChainRuling = {
      key: "f-1",
      outcome: "held",
      text: "why",
      proposed: { outcome: "fix", text: "do it" },
    };
    const body = renderChainRuling(r);
    expect(parseChainRuling(withNaxBotMarker(body, chainRulingKey("f-1")))).toEqual(parseChainRuling(body));
    expect(parseChainRuling(withNaxBotMarker(body, chainRulingKey("f-1")))).not.toBeNull();
  });
  test.each([
    ["an unrelated line", "Recorded: waived — reason"],
    ["an unknown outcome", "Advisor ruling — settled: reason"],
    ["a prefix inside a line", "Fixed in abc1234: Advisor ruling — waived: reason"],
    ["a ruling on the second line", "Fixed in abc1234\nAdvisor ruling — waived: reason"],
  ])("returns null for %s", (_n, body) => {
    expect(parseChainRuling(body)).toBeNull();
  });
});

describe("chainInstructions", () => {
  test("AC-1 maps only the fix entries", () => {
    const map = chainInstructions({
      chainRulings: [
        { key: "f-1", outcome: "fix", text: "a" },
        { key: "f-2", outcome: "held", text: "b" },
      ],
    });
    expect(Array.from(map.entries())).toEqual([["f-1", "a"]]);
  });
  test("AC-2 returns an empty map without rulings", () => {
    expect(chainInstructions({}).size).toBe(0);
  });
});
