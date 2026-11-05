import { describe, expect, test } from "bun:test";
import { formatTokens as viaStatus, formatWindow as windowViaStatus } from "@/tui/chat/chat-status";
import { formatTokens, formatWindow } from "@/tui/chat/context-span";

describe("formatWindow", () => {
  test.each([
    [1_000_000, "1M"],
    [1_050_000, "1.05M"],
    [200_000, "200k"],
    [262_144, "262k"],
    [800, "800"],
    [999_600, "1M"],
  ])("formats %i as %s", (n, text) => {
    expect(formatWindow(n)).toBe(text);
  });
});

describe("re-exports from chat-status", () => {
  test("are the same functions", () => {
    expect(viaStatus).toBe(formatTokens);
    expect(windowViaStatus).toBe(formatWindow);
    expect(viaStatus(1234)).toBe("1.2k");
  });
});
