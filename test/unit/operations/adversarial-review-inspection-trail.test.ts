/**
 * Tests for adversarialReviewOp.hopBody — inspection-trail guard (#3A).
 *
 * A ref-mode `passed:true` verdict with zero findings and no `inspectedFiles`
 * is the rubber-stamp signature (the reviewer never opened the code). The guard
 * issues exactly one same-session re-prompt demanding inspection, then adopts the
 * second turn's verdict. It is gated on `adversarialConfig.demandInspectionTrail`
 * and only fires in ref mode.
 *
 * See docs/findings/2026-05-30-prompt-audit-analysis.md (#3A).
 */

import { describe, expect, mock, test } from "bun:test";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { HopBodyContext } from "@/operations/types";
import { AdversarialReviewPromptBuilder } from "@/prompts";

const ADVERSARIAL_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
  demandInspectionTrail: true,
  substantiation: { requote: false, maxRequotes: 0 },
};

const STORY = {
  id: "STORY-INSPECT",
  title: "Inspection trail guard",
  description: "guard against rubber-stamp reviews",
  acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
};

function turn(output: string) {
  return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 };
}

async function runHopBody(opts: {
  responses: string[];
  config?: Partial<typeof ADVERSARIAL_CONFIG>;
  mode?: "ref" | "embedded";
}) {
  let callCount = 0;
  const mockSend = mock(async () => turn(opts.responses[Math.min(callCount++, opts.responses.length - 1)]));
  const result = await adversarialReviewOp.hopBody("initial prompt", {
    send: mockSend,
    sendWithParseRetry: mockSend,
    input: {
      workdir: "/tmp",
      story: STORY,
      adversarialConfig: { ...ADVERSARIAL_CONFIG, ...opts.config },
      mode: opts.mode ?? "ref",
    },
  } satisfies HopBodyContext<AdversarialReviewInput>);
  return { result, callCount };
}

describe("adversarialReviewOp.hopBody — inspection-trail guard (#3A)", () => {
  const RUBBER_STAMP = JSON.stringify({ passed: true, findings: [] });

  test("empty pass with no inspectedFiles → one re-prompt (two sends)", async () => {
    const second = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const { callCount } = await runHopBody({ responses: [RUBBER_STAMP, second] });
    expect(callCount).toBe(2);
  });

  test("re-prompt uses the demandInspection prompt", async () => {
    let secondPrompt: string | undefined;
    let n = 0;
    const second = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const mockSend = mock(async (p: string) => {
      if (n === 1) secondPrompt = p;
      n += 1;
      return turn(n === 1 ? RUBBER_STAMP : second);
    });
    await adversarialReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY, adversarialConfig: ADVERSARIAL_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    expect(secondPrompt).toBe(AdversarialReviewPromptBuilder.demandInspection());
  });

  test("second turn's verdict is adopted (findings flow downstream)", async () => {
    const second = JSON.stringify({
      passed: false,
      inspectedFiles: ["src/auth.ts"],
      findings: [
        { severity: "error", category: "test-gap", file: "src/auth.ts", line: 1, issue: "x", suggestion: "y" },
      ],
    });
    const { result } = await runHopBody({ responses: [RUBBER_STAMP, second] });
    expect(result.output).toBe(second);
  });

  test("empty pass WITH inspectedFiles → no re-prompt (single send)", async () => {
    const passed = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const { callCount } = await runHopBody({ responses: [passed] });
    expect(callCount).toBe(1);
  });

  test("demandInspectionTrail:false → no re-prompt", async () => {
    const { callCount } = await runHopBody({
      responses: [RUBBER_STAMP],
      config: { demandInspectionTrail: false },
    });
    expect(callCount).toBe(1);
  });

  test("embedded mode → guard does not fire (ref-only)", async () => {
    const { callCount } = await runHopBody({ responses: [RUBBER_STAMP], mode: "embedded" });
    expect(callCount).toBe(1);
  });

  test("unparseable second turn → keep original pass, still two sends", async () => {
    const { result, callCount } = await runHopBody({ responses: [RUBBER_STAMP, "not json at all"] });
    expect(callCount).toBe(2);
    expect(result.output).toBe(RUBBER_STAMP);
  });
});

/**
 * Corroboration (2026-09-03). Reproduces the verdict observed in the Phase C1
 * A/B run: the reviewer wrote "I have no file/shell access tool in this
 * environment", then returned `passed:true` with
 * `inspectedFiles: ["src/calc.ts", "src/calc.test.ts"]` — files it had just
 * said it could not open. The guard believed the list and let it through.
 */
describe("adversarialReviewOp.hopBody — inspection trail corroborated against tool use", () => {
  const DECLARED = JSON.stringify({
    passed: true,
    inspectedFiles: ["src/calc.ts", "src/calc.test.ts"],
    findings: [],
  });

  async function sendCount(codingToolUse: { advertised: number; called: string[] } | undefined) {
    const mockSend = mock(async () => ({ ...turn(DECLARED), ...(codingToolUse ? { codingToolUse } : {}) }));
    await adversarialReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY, adversarialConfig: ADVERSARIAL_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    return mockSend.mock.calls.length;
  }

  test("re-prompts when tools were advertised and the reviewer called none", async () => {
    expect(await sendCount({ advertised: 4, called: [] })).toBe(2);
  });

  test("accepts the verdict when the reviewer actually called a tool", async () => {
    expect(await sendCount({ advertised: 4, called: ["Git", "Read"] })).toBe(1);
  });

  test("falls back to the self-report when no tools were advertised", async () => {
    expect(await sendCount(undefined)).toBe(1);
  });
});
