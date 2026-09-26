import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { ParseValidationError } from "@/agents/retry";
import { type ConfigSelector, DEFAULT_CONFIG, tddConfigSelector } from "@/config";
import { verifierOp } from "@/operations";
import type { PackageView } from "@/runtime";

/**
 * verifierOp.parse failure paths, and their agreement with the parse-retry
 * validator. Parse throwing ParseValidationError is what lets callOp re-prompt
 * in-session and then fall back to `recover` (the on-disk verdict file).
 */

function makeParseCtx() {
  const config = DEFAULT_CONFIG;
  const packageView: PackageView = {
    packageDir: "",
    relativeFromRoot: "",
    repoRoot: "",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
  return { packageView, config: tddConfigSelector.select(config) };
}

/**
 * An APPROVED verdict whose stdout JSON is one `}` short (nax#2264).
 *
 * `"details":{...}}}` closes the file entry, `integration` and `details` but
 * not `tests`, so every later key nests inside `tests` and the outer object
 * never closes. The lenient parser used to hand back the balanced inner
 * `tests` object, and coerceVerdict turned that into a phantom
 * `approved:false, 0/0` tests-failing verdict that passed the retry validator,
 * so neither the re-prompt nor the disk `recover` ever ran.
 */
const TRUNCATED_APPROVED_VERDICT = [
  '{"version":1,"approved":true,',
  '"tests":{"allPassing":true,"passCount":27,"failCount":0,',
  '"details":{"integration":{"test/unit/foo.test.ts":{"pass":27,"fail":0}}},',
  '"testModifications":{"detected":false,"files":[],"legitimate":true,"reasoning":"none"},',
  '"acceptanceCriteria":{"allMet":true,"criteria":[{"criterion":"AC-1","met":true}]},',
  '"quality":{"rating":"good","issues":[]},',
  '"fixes":[],"reasoning":"All ACs met."}',
].join("");

describe("verifierOp.parse — error handling (strict: throws ParseValidationError)", () => {
  test("the truncated fixture is exactly one closing brace short of an approved verdict", () => {
    expect(() => JSON.parse(TRUNCATED_APPROVED_VERDICT)).toThrow();
    expect(JSON.parse(`${TRUNCATED_APPROVED_VERDICT}}`).approved).toBe(true);
  });

  test.each([
    ["empty output", ""],
    ["unparseable prose", "could not parse"],
    ["malformed JSON", '{ "incomplete":'],
    ["an approved verdict one closing brace short (#2264)", TRUNCATED_APPROVED_VERDICT],
  ])("throws ParseValidationError when output is %s", (_label, output) => {
    const input = { story: makeStory({ id: "US-001" }) };
    expect(() => verifierOp.parse(output, input, makeParseCtx())).toThrow(ParseValidationError);
  });
});

describe("verifierOp.retry — agrees with parse on a truncated verdict", () => {
  test("re-prompts instead of accepting a coerced fragment (#2264)", () => {
    const strategy = verifierOp.retry;
    if (typeof strategy !== "object" || !("shouldRetry" in strategy)) {
      throw new Error("verifierOp.retry must be a RetryStrategy");
    }
    const decision = strategy.shouldRetry(new ParseValidationError("probe"), 0, {
      site: "run",
      agentName: "claude",
      stage: "verify",
      storyId: "US-004",
      lastOutput: TRUNCATED_APPROVED_VERDICT,
    });
    expect(decision.retry).toBe(true);
  });
});
