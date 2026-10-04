/**
 * nax-agent's test helper is a verbatim copy of this module (S3-2). nax-agent
 * cannot import nax, so the copy keeps nax-agent's engine tests on nax's real
 * rules; this test fails when the two drift. Import lines and the helper's
 * one-line provenance header are the only permitted differences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const normalise = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("// Verbatim copy of nax"))
    .join("\n")
    .trim();

describe("nax-agent's nax-owned-paths test helper", () => {
  test("is a verbatim copy of src/agents/nax-owned-writes.ts", () => {
    const original = readFileSync(join(import.meta.dir, "../../../src/agents/nax-owned-writes.ts"), "utf8");
    const copy = readFileSync(join(import.meta.dir, "../../../../nax-agent/test/helpers/nax-owned-paths.ts"), "utf8");
    expect(normalise(copy)).toBe(normalise(original));
  });
});
