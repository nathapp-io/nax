/**
 * Direct unit tests for `warnQualityCommandChains` (nax#1990) — the
 * config-guards.ts wiring function that calls collectCommandChainWarnings on
 * the raw, pre-safeParse `quality.commands` slice of a config object.
 *
 * These pin the malformed-input contract explicitly (rather than relying on
 * an unrelated pre-existing test — loader-schema-error.test.ts — happening
 * not to crash), since this function runs on config that hasn't been
 * Zod-validated yet.
 */

import { describe, expect, test } from "bun:test";
import { warnQualityCommandChains } from "@/config/config-guards";

describe("warnQualityCommandChains", () => {
  test("warns via the sink for a chained string command", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ quality: { commands: { typecheck: "a && b" } } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("typecheck");
  });

  test("is silent for a clean list command", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ quality: { commands: { typecheck: ["a", "b"] } } }, (msg) => captured.push(msg));

    expect(captured).toEqual([]);
  });

  test("is silent when there is no quality section", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ execution: {} }, (msg) => captured.push(msg));

    expect(captured).toEqual([]);
  });

  test("is silent when quality is not an object", () => {
    const captured: string[] = [];
    expect(() => warnQualityCommandChains({ quality: 42 }, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does not throw and is silent for a non-string, non-array command value", () => {
    // Raw pre-safeParse config: `commands.test: 42` — the exact shape
    // exercised by test/unit/config/loader-schema-error.test.ts through the
    // full loadConfig path. Pinned directly here too.
    const commands = JSON.parse('{"quality": {"commands": {"test": 42}}}');
    const captured: string[] = [];
    expect(() => warnQualityCommandChains(commands, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does not throw and is silent for a mixed-type array command value", () => {
    const commands = JSON.parse('{"quality": {"commands": {"test": ["ok", 42]}}}');
    const captured: string[] = [];
    expect(() => warnQualityCommandChains(commands, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does nothing when warn is omitted", () => {
    expect(() => warnQualityCommandChains({ quality: { commands: { lint: "a && b" } } })).not.toThrow();
  });
});
