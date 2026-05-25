/**
 * AC-008: Behavior-preservation test fixtures for fix strategy composition.
 *
 * These tests verify the expected ordering and selection of strategies under
 * different config conditions. The assembly helper mirrors the logic that
 * buildPlanForStrategy (US-005a) will wire — tested here so the composition
 * contract is locked before wiring occurs.
 */
import { describe, expect, test } from "bun:test";
import type { FixStrategy } from "@/findings";
import type { Finding } from "@/findings";
import {
  makeAutofixImplementerStrategy,
  makeAutofixTestWriterStrategy,
  makeMechanicalFormatFixStrategy,
  makeMechanicalLintFixStrategy,
} from "@/operations";
import { makeNaxConfig } from "@test/helpers";

const mockCtx = {} as any;

/**
 * Assemble strategy array from config options in the same order that
 * buildPlanForStrategy (US-005a) will use: mechanical before agent.
 */
function assembleStrategies(opts: {
  lintFix?: string;
  formatFix?: string;
  autofixEnabled: boolean;
}): FixStrategy<Finding, any, any, any>[] {
  const strategies: FixStrategy<Finding, any, any, any>[] = [];
  if (opts.lintFix) strategies.push(makeMechanicalLintFixStrategy());
  if (opts.formatFix) strategies.push(makeMechanicalFormatFixStrategy());
  if (opts.autofixEnabled) {
    strategies.push(makeAutofixImplementerStrategy(mockCtx, makeNaxConfig()));
    strategies.push(makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig()));
  }
  return strategies;
}

describe("AC8: behavior-preservation — strategy composition scenarios", () => {
  test("AC8a: only mechanical lintFix configured + autofix disabled → only mechanical-lintfix in array", () => {
    const strategies = assembleStrategies({ lintFix: "bun run lint:fix", autofixEnabled: false });

    expect(strategies).toHaveLength(1);
    expect(strategies[0].name).toBe("mechanical-lintfix");
  });

  test("AC8a: no agent strategies present when autofix is disabled", () => {
    const strategies = assembleStrategies({ lintFix: "bun run lint:fix", autofixEnabled: false });

    const agentNames = strategies.filter(
      (s) => s.name === "autofix-implementer" || s.name === "autofix-test-writer",
    );
    expect(agentNames).toHaveLength(0);
  });

  test("AC8b: only autofix enabled → only agent strategies in array", () => {
    const strategies = assembleStrategies({ autofixEnabled: true });

    expect(strategies).toHaveLength(2);
    expect(strategies[0].name).toBe("autofix-implementer");
    expect(strategies[1].name).toBe("autofix-test-writer");
  });

  test("AC8b: no mechanical strategies when no lintFix/formatFix configured", () => {
    const strategies = assembleStrategies({ autofixEnabled: true });

    const mechanicalNames = strategies.filter(
      (s) => s.name === "mechanical-lintfix" || s.name === "mechanical-formatfix",
    );
    expect(mechanicalNames).toHaveLength(0);
  });

  test("AC8c: both mechanical and autofix enabled → mechanical-lintfix precedes agent strategies", () => {
    const strategies = assembleStrategies({ lintFix: "bun run lint:fix", autofixEnabled: true });

    expect(strategies.length).toBeGreaterThanOrEqual(3);
    const lintfixIdx = strategies.findIndex((s) => s.name === "mechanical-lintfix");
    const implementerIdx = strategies.findIndex((s) => s.name === "autofix-implementer");
    const testWriterIdx = strategies.findIndex((s) => s.name === "autofix-test-writer");

    expect(lintfixIdx).toBeGreaterThanOrEqual(0);
    expect(implementerIdx).toBeGreaterThanOrEqual(0);
    expect(testWriterIdx).toBeGreaterThanOrEqual(0);
    expect(lintfixIdx).toBeLessThan(implementerIdx);
    expect(lintfixIdx).toBeLessThan(testWriterIdx);
  });

  test("AC8c: mechanical-formatfix also precedes agent strategies when configured", () => {
    const strategies = assembleStrategies({
      lintFix: "bun run lint:fix",
      formatFix: "bun run format:fix",
      autofixEnabled: true,
    });

    expect(strategies.length).toBeGreaterThanOrEqual(4);
    const formatfixIdx = strategies.findIndex((s) => s.name === "mechanical-formatfix");
    const implementerIdx = strategies.findIndex((s) => s.name === "autofix-implementer");

    expect(formatfixIdx).toBeGreaterThanOrEqual(0);
    expect(formatfixIdx).toBeLessThan(implementerIdx);
  });

  test("AC8c: all four strategies present when both mechanical commands and autofix configured", () => {
    const strategies = assembleStrategies({
      lintFix: "bun run lint:fix",
      formatFix: "bun run format:fix",
      autofixEnabled: true,
    });

    const names = strategies.map((s) => s.name);
    expect(names).toContain("mechanical-lintfix");
    expect(names).toContain("mechanical-formatfix");
    expect(names).toContain("autofix-implementer");
    expect(names).toContain("autofix-test-writer");
  });
});
