import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { digest64 } from "#src/infra/spin-breaker/hash";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS } from "#src/infra/spin-breaker/index";

test("deduplication hashes retain a 64-bit SHA-256 prefix", () => {
  expect(digest64("")).toBe("e3b0c44298fc1c14");
  expect(digest64("abc")).toBe("ba7816bf8f01cfea");
  expect(digest64("héllo")).toBe(createHash("sha256").update("héllo").digest("hex").slice(0, 16));
});
test("long keys retain suffix and tool-name distinctions", () => {
  const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, { now: () => 0 });
  const long = "x".repeat(600);
  breaker.observe("Read", { path: long });
  breaker.observe("Read", { path: long });
  expect(breaker.summary().newKeyEvents).toBe(1);
  breaker.observe("Read", { path: `${long}y` });
  expect(breaker.summary().newKeyEvents).toBe(2);
  breaker.observe("Grep", { path: long });
  expect(breaker.summary().newKeyEvents).toBe(3);
});
function breaker() {
  return createSpinBreaker(
    { ...DEFAULT_SPIN_BREAKER_SETTINGS, maxNudges: 0, stopAfterSameKeyRepeats: 3 },
    { now: () => 0 },
  );
}
test("control codes, whitespace and elapsed durations normalize as the same result", () => {
  const b = breaker();
  for (const result of ["ok took 1.2ms", "  ok   took 9.8ms", "\u001b[32mok\u001b[0m took 3.4ms"]) {
    b.observe("Read", { path: "x" });
    b.noteResult("Read", { path: "x" }, result);
  }
  expect(b.observe("Read", { path: "x" })).toEqual({ action: "stop", reason: "same-key-cumulative", repeats: 3 });
});
test("a changed normalized result resets the same-result run", () => {
  const b = breaker();
  for (const result of ["ok", "ok", "changed"]) {
    b.observe("Read", { path: "x" });
    b.noteResult("Read", { path: "x" }, result);
  }
  expect(b.observe("Read", { path: "x" })).toEqual({ action: "allow" });
});

/** A tool-result image as `Read` produces one: the label carries no pixel data. */
function image(data: string) {
  return { mimeType: "image/png", data, width: 100, height: 50 };
}

test("identical images count as repeats: the same call returning the same picture is a spin", () => {
  const b = breaker();
  const same = image("AAAA");
  for (const _ of [0, 1, 2]) {
    b.observe("Read", { path: "shot.png" });
    b.noteResult("Read", { path: "shot.png" }, "[image: image/png 100x50, 3 bytes]", [same]);
  }
  expect(b.observe("Read", { path: "shot.png" })).toEqual({
    action: "stop",
    reason: "same-key-cumulative",
    repeats: 3,
  });
});

test("different image bytes under an identical label are progress, not a spin", () => {
  const b = breaker();
  for (const data of ["AAAA", "BBBB", "CCCC"]) {
    b.observe("Read", { path: "shot.png" });
    // Same path, same MIME type, same dimensions, same byte COUNT -- the whole
    // label is identical, so only the bytes distinguish the two screenshots.
    b.noteResult("Read", { path: "shot.png" }, "[image: image/png 100x50, 3 bytes]", [image(data)]);
  }
  expect(b.observe("Read", { path: "shot.png" })).toEqual({ action: "allow" });
});

test("the image fingerprint is ordered and format-aware, and keeps no payload", () => {
  const b = breaker();
  b.observe("Read", { path: "pair.png" });
  b.noteResult("Read", { path: "pair.png" }, "x", [image("AAAA"), image("BBBB")]);
  b.observe("Read", { path: "pair.png" });
  b.noteResult("Read", { path: "pair.png" }, "x", [image("BBBB"), image("AAAA")]);
  // Reordered images are a different result, so the run restarts at 1 and two
  // occurrences are nowhere near the threshold.
  expect(b.observe("Read", { path: "pair.png" })).toEqual({ action: "allow" });
  // The summary carries counts only: no digest, no bytes.
  expect(JSON.stringify(b.summary())).not.toContain("AAAA");
});
