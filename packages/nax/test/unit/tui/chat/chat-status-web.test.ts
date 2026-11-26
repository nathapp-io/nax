import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { footerModel, IDLE_STATUS, webSpan } from "@/tui/chat/chat-status";
import { plainText } from "@/tui/chat/styled-line";

const BASE_STATE: ChatHostState = {
  sessionId: "session-1",
  mode: "guarded",
  model: "anthropic/m1",
  meta: {
    schemaVersion: 1,
    sessionId: "session-1",
    cwd: "/repo",
    mode: "ask",
    model: "anthropic/m1",
    bashApproval: "gated",
    title: null,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: null,
    costUsd: 0.42,
  },
};

function exposedState(searches: number): ChatHostState {
  return {
    ...BASE_STATE,
    meta: {
      ...BASE_STATE.meta,
      web: { exposedAt: "2026-11-26T10:00:00.000Z", seenUrls: [], searches },
    },
  };
}

describe("webSpan", () => {
  test("US-019 AC-1 hides a state without web metadata", () => {
    expect(webSpan(BASE_STATE)).toBeUndefined();
  });

  test("US-019 AC-2 hides web metadata before exposure", () => {
    const state: ChatHostState = {
      ...BASE_STATE,
      meta: { ...BASE_STATE.meta, web: { exposedAt: null, seenUrls: [], searches: 0 } },
    };
    expect(webSpan(state)).toBeUndefined();
  });

  test("US-019 AC-3 shows the marker without a zero-search count", () => {
    expect(webSpan(exposedState(0))).toEqual({ text: " · web", color: "muted" });
  });

  test("US-019 AC-4 includes the successful-search count", () => {
    expect(webSpan(exposedState(3))).toEqual({ text: " · web 3 searches", color: "muted" });
  });
});

describe("footer web indicator", () => {
  test("US-019 AC-5 places the web span immediately after the cost", () => {
    const { right } = footerModel({ state: exposedState(3), status: IDLE_STATUS, hint: "idle" });
    expect(right.map((span) => span.text)).toEqual(["m1", " · $0.42", " · web 3 searches"]);
  });

  test("US-019 AC-6 preserves model, context and cost without web metadata", () => {
    const state: ChatHostState = { ...BASE_STATE, contextWindow: 200_000 };
    const status = { ...IDLE_STATUS, contextTokens: 36_000 };
    const { right } = footerModel({ state, status, hint: "idle" });
    expect(plainText(right)).toBe("m1 · 36.0k/200k ctx (18%) · $0.42");
    expect(right).toEqual([
      { text: "m1" },
      { text: " · 36.0k/200k ctx (18%)", color: "muted" },
      { text: " · $0.42", color: "muted" },
    ]);
  });
});
