import { describe, expect, test } from "bun:test";
import { createStreamScrubber } from "#src/client/stream-scrub";

const SECRET = "s3cr3t-token-value-0123";

function run(
  secrets: readonly string[],
  chunks: readonly string[],
): { readonly emitted: string[]; readonly all: string } {
  const scrubber = createStreamScrubber(secrets);
  const emitted = chunks.map((chunk) => scrubber.push(chunk));
  const rest = scrubber.flush();
  return { emitted: [...emitted, rest], all: [...emitted, rest].join("") };
}

describe("createStreamScrubber (S4-5 D5-g)", () => {
  test("without secrets every chunk passes through at once and nothing is held", () => {
    const { emitted } = run([], ["a", "b", "c"]);
    expect(emitted).toEqual(["a", "b", "c", ""]);
  });

  test("a secret inside one chunk is replaced", () => {
    expect(run([SECRET], [`key ${SECRET} ok`]).all).toBe("key [REDACTED] ok");
  });

  test("a secret split across chunks is replaced, and no emitted piece holds a part that joins into it", () => {
    const { emitted, all } = run([SECRET], ["key s3cr3t-tok", "en-val", "ue-0123 ok"]);
    expect(all).toBe("key [REDACTED] ok");
    expect(emitted.some((piece) => piece.includes("s3cr3t") || piece.includes("value-0123"))).toBe(false);
  });

  test("a secret split one character per chunk is still caught", () => {
    expect(run([SECRET], [..."<<", ...SECRET, ..."!!"]).all).toBe("<<[REDACTED]!!");
  });

  test("holds back at most the longest secret's length minus one", () => {
    const scrubber = createStreamScrubber(["12345678", SECRET]);
    const out = scrubber.push("x".repeat(100));
    expect(out).toBe("x".repeat(100 - (SECRET.length - 1)));
    expect(scrubber.flush()).toBe("x".repeat(SECRET.length - 1));
  });

  test("never splits a surrogate pair at the hold-back boundary", () => {
    const scrubber = createStreamScrubber(["abcdefgh"]);
    const out = scrubber.push(`aaaa\u{1f600}${"z".repeat(6)}`);
    expect(out.endsWith("\ud83d")).toBe(false);
    expect(out + scrubber.flush()).toBe(`aaaa\u{1f600}${"z".repeat(6)}`);
  });

  test("secrets shorter than 8 characters are ignored", () => {
    expect(run(["abc"], ["abc abc"]).emitted).toEqual(["abc abc", ""]);
  });

  test("flush empties the hold; a second flush returns nothing", () => {
    const scrubber = createStreamScrubber([SECRET]);
    scrubber.push("tail");
    expect(scrubber.flush()).toBe("tail");
    expect(scrubber.flush()).toBe("");
  });
});
