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
