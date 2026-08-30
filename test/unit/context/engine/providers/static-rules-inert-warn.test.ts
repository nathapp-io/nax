/**
 * nax#1775 — a rule declaring `appliesTo:` that gets admitted only because
 * `request.scopeFiles` is empty is a silent scoping bug, not a benign
 * default. `appliesToInertCount` already existed on the scoping report but
 * was invisible outside manifest telemetry — this pins the accompanying
 * `logger.warn`.
 *
 * Split out of static-rules.test.ts (already at the 800-line test-file
 * ceiling) per test-architecture.md's "split by concern" rule.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { Logger } from "@/logger";

let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
let warnSpy: Mock<Logger["warn"]> | undefined;

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

beforeEach(async () => {
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  _staticRulesDeps.loadCanonicalRules = async () => [];
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const logger = initLogger({ level: "silent" });
  warnSpy = spyOn(logger, "warn");
});

afterEach(async () => {
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  warnSpy?.mockRestore();
  warnSpy = undefined;
  const { resetLogger } = await import("@/logger");
  resetLogger();
});

describe("StaticRulesProvider — appliesTo inert-scoping warning (nax#1775)", () => {
  test("warns when an appliesTo: rule is admitted because scopeFiles is empty", async () => {
    setupCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ storyId: "US-001", appliesToInertCount: 1 });
  });

  test("warns when scopeFiles is entirely absent (undefined)", async () => {
    setupCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...BASE_REQUEST, scopeFiles: undefined });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeDefined();
  });

  test("does not warn when scopeFiles is populated (appliesTo scoping is live)", async () => {
    setupCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/agents/manager.ts"] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeUndefined();
  });

  test("does not warn when no rule declares appliesTo:", async () => {
    setupCanonical([{ fileName: "global.md", content: "Global rules" }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeUndefined();
  });
});
