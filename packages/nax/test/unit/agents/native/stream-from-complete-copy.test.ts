/**
 * nax's stream-from-complete test helper is a verbatim copy of nax-agent's
 * (S3-3): nax cannot import nax-agent's test helpers. This test fails when the
 * two drift. Import lines and the copy's one-line provenance header are the
 * only permitted differences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const normalise = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("// Verbatim copy of nax-agent"))
    .join("\n")
    .trim();

describe("nax's stream-from-complete test helper", () => {
  test("is a verbatim copy of nax-agent's", () => {
    const original = readFileSync(
      join(import.meta.dir, "../../../../../nax-agent/test/helpers/stream-from-complete.ts"),
      "utf8",
    );
    const copy = readFileSync(join(import.meta.dir, "../../../helpers/stream-from-complete.ts"), "utf8");
    expect(normalise(copy)).toBe(normalise(original));
  });
});
