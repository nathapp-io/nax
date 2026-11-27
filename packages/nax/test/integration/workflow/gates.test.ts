import { afterEach, describe, expect, test } from "bun:test";
import {
  makeMockCallContext,
  makeNaxConfig,
  makeScriptedCallOp,
  makeStepContext,
  makeTestRuntime,
} from "@test/helpers";
import { lintCheckOp, typecheckCheckOp } from "@/operations";
import { buildWorkflowFixPrompt } from "@/prompts";
import { parseLintOutput } from "@/review/lint-parsing";
import { parseTypecheckOutput } from "@/review/typecheck-parsing";
import { runStoryGates } from "@/workflow/gates";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));
const secret = `ghp_${"a".repeat(36)}`;

const cases = [
  {
    name: "unfamiliar extension after a recognised diagnostic",
    output: "/repo/src/one.go\n  known defect\n/repo/src/two.ex\n  unknown-extension defect\n",
    evidence: ["known defect", "unknown-extension defect"],
  },
  {
    name: "bounded parsed diagnostic with a huge generated-source continuation",
    output: `/repo/src/example.py\n  first actionable diagnostic\n  ${"x".repeat(650_000)}\nlast raw evidence\n`,
    evidence: ["first actionable diagnostic", "last raw evidence"],
  },
  {
    name: "redaction of diagnostic bodies as well as raw evidence",
    output: `/repo/src/example.py\n  credential detail: ${secret}\n`,
    evidence: ["credential detail:"],
  },
  {
    name: "path header with multiple diagnostics",
    output: "/repo/src/example.py\n  7:3 error: first defect\n  9:1 warning: second defect\n",
    evidence: ["7:3 error: first defect", "9:1 warning: second defect"],
  },
  {
    name: "mixed recognised and unfamiliar extensions",
    output: "/repo/src/example.ex\n  error: unknown-extension defect\n\n/repo/src/example.go:7:3: recognised defect\n",
    evidence: ["unknown-extension defect", "recognised defect"],
  },
  {
    name: "unfamiliar path syntax and extension",
    output: "C:\\project with spaces\\example.custom:7:3: unfamiliar diagnostic\n  help: repair detail\n",
    evidence: ["unfamiliar diagnostic", "help: repair detail"],
  },
  {
    name: "output without file paths",
    output: "build rule failed\nexpected: integer\nfound: string\n",
    evidence: ["build rule failed", "expected: integer", "found: string"],
  },
  {
    name: "more findings than the workflow cap",
    output: `unparsed preamble defect\n${Array.from({ length: 30 }, (_, i) => `/repo/src/file${i}.go:1:1: defect ${i}`).join("\n")}`,
    evidence: ["unparsed preamble defect", "defect 29"],
  },
];

describe.each(["lint", "typecheck"] as const)("%s output reaches the workflow fixer", (gate) => {
  test.each(cases)("$name", async ({ output, evidence }) => {
    const config = makeNaxConfig({ quality: { commands: { lint: "custom-linter", typecheck: "custom-compiler" } } });
    const runtime = makeTestRuntime({ config });
    const callCtx = makeMockCallContext({ runtime });
    const sc = makeStepContext({ config, callCtx });
    const runQualityCommand = async () => ({
      commandName: gate,
      command: gate === "lint" ? "custom-linter" : "custom-compiler",
      success: false,
      exitCode: 1,
      output,
      durationMs: 1,
      timedOut: false,
    });
    try {
      _workflowDeps.callOp = makeScriptedCallOp((op) => {
        if (op.name === `${gate}-check`) {
          const input = { workdir: sc.workdir, storyId: sc.story.id };
          return gate === "lint"
            ? lintCheckOp.execute(input, callCtx, { runQualityCommand, parseLintOutput })
            : typecheckCheckOp.execute(input, callCtx, { runQualityCommand, parseTypecheckOutput });
        }
        if (op.name === "verify-scoped")
          return { success: true, status: "passed", findings: [], durationMs: 1, passCount: 1 };
        return { success: true, findings: [], durationMs: 1 };
      });
      const result = await runStoryGates(sc);
      const prompt = buildWorkflowFixPrompt({
        mode: "warm",
        round: 1,
        maxRounds: 5,
        priorRounds: 0,
        findings: result.findings.map((f, i) => ({ ...f, id: `F${i + 1}` })),
        briefPath: "brief.md",
        reportPath: "report.md",
        uncommittedFiles: [],
      });
      expect(result.states[gate]).toBe("red");
      expect(prompt).not.toContain(secret);
      expect(prompt.length).toBeLessThan(30_000);
      for (const detail of evidence) expect(prompt).toContain(detail);
      expect(prompt).toContain(`RunCommand {"command": "${gate}"}`);
      expect(prompt.match(/Output \(last 40 lines\):/g)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
