import { describe, expect, test } from "bun:test";
import { createTurnAccumulator } from "@/agents/native/session/turn-accumulator";

describe("createTurnAccumulator cache presence (S1-1)", () => {
  test("absent cache fields stay absent; a reported zero stays zero", () => {
    const absent = createTurnAccumulator();
    absent.add({ inputTokens: 5, outputTokens: 1 }, 0);
    expect(JSON.stringify(absent.tokens())).toBe('{"inputTokens":5,"outputTokens":1}');

    const zero = createTurnAccumulator();
    zero.add({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0);
    expect(JSON.stringify(zero.tokens())).toBe(
      '{"inputTokens":5,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}',
    );
  });
});
