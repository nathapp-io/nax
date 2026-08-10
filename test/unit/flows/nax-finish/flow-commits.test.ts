/**
 * `commit_<phase>` node behaviour: the message it writes, the round it records,
 * and the gate loop's re-entry into the quality review.
 *
 * Split out of `flow-graph.test.ts` (800-line test cap) — that file covers the
 * graph's shape and the other nodes' routing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import { makeFlowCtx, makeFlowSteps } from "@test/helpers";
import type { FlowNodeContext, FlowStepRecord } from "acpx/flows";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

const ctxOf = (over: { outputs?: Record<string, unknown>; steps?: FlowStepRecord[] }): FlowNodeContext =>
  makeFlowCtx({ input: INPUT, ...over });

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;
const switchOf = (from: string) => {
  const edge = flow.edges.find((e) => e.from === from && "switch" in e);
  if (!edge || !("switch" in edge)) throw new Error(`no switch edge from ${from}`);
  return edge.switch;
};

describe("commit_* nodes", () => {
  const originalRun = _gitDeps.run;
  const originalAppend = _resultDeps.appendText;
  afterEach(() => {
    _gitDeps.run = originalRun;
    _resultDeps.appendText = originalAppend;
  });

  const runCommitNode = async (
    id: string,
    porcelain: string,
    outputs: Record<string, unknown> = {},
    postCommitSha = "post-commit-sha",
  ) => {
    const calls: string[][] = [];
    const rounds: unknown[] = [];
    let revParseCalls = 0;
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("--porcelain")) return { exitCode: 0, stdout: porcelain, stderr: "" };
      if (cmd.includes("rev-parse")) {
        revParseCalls++;
        // First call = shaBefore (pre-commit HEAD); second call = shaAfter
        // (post-commit HEAD). Returning distinct values lets the AC1 assertion
        // actually distinguish the two — returning the same string for both
        // would let a regression that records `shaBefore` pass unnoticed.
        const sha = revParseCalls === 1 ? "before-sha" : postCommitSha;
        return { exitCode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _resultDeps.appendText = async (_p, s) => {
      rounds.push(JSON.parse(s));
    };
    const out = await nodeRun<{ committed: boolean; route: string }>(id).run(ctxOf({ outputs }));
    // The commit message is the last `-m` argument; asserting on it directly
    // keeps these tests readable now that it spans multiple lines.
    const commit = calls.find((c) => c[1] === "commit");
    return {
      out,
      argv: calls.map((c) => c.join(" ")),
      message: commit?.[3] ?? "",
      rounds,
      revParseCalls,
    };
  };

  test("commits the fix under a subject naming what was fixed, and does not push", async () => {
    const { out, message, argv } = await runCommitNode("commit_spec", " M apps/api/_calendar.py\n", {
      review_spec: {
        findings: [{ severity: "HIGH", title: "Market gate skip branch is unreachable", problem: "P", fix: "F" }],
      },
    });
    expect(out.committed).toBe(true);
    expect(message.split("\n")[0]).toBe("fix(x): market gate skip branch is unreachable");
    // The finding's detail belongs in the body — a PR reviewer reads it there.
    expect(message).toContain("- [HIGH] Market gate skip branch is unreachable");
    // --no-verify: a pre-commit hook rejecting an intermediate state would
    // otherwise kill the flow before the gate loop could fix it
    expect(argv.some((c) => c.endsWith("--no-verify"))).toBe(true);
    // the push belongs to the terminal nodes; a mid-loop push would publish
    // half-fixed states to the forge on every round
    expect(argv.some((c) => c.startsWith("git push"))).toBe(false);
  });

  // Regression: all six nax-finish commits on rs-stock/pipeline-run-outcome read
  // `fix(f): nax-finish <phase> fixes` with an empty body, so a PR reviewer could
  // not tell which one re-enabled a disabled market gate.
  test("no phase falls back to the old opaque 'nax-finish <phase> fixes' subject", async () => {
    for (const phase of ["acceptance", "spec", "quality", "gate"]) {
      const { message } = await runCommitNode(`commit_${phase}`, " M a.ts\n");
      expect(message.split("\n")[0]).not.toBe(`fix(x): nax-finish ${phase} fixes`);
      expect(message.split("\n")[0].startsWith("fix(x): ")).toBe(true);
    }
  });

  test("the gate phase names the failing commands in its subject", async () => {
    const { message } = await runCommitNode("commit_gate", " M a.ts\n", {
      quality_gates: { failing: ["lint", "test"], output: "1 failed" },
    });
    expect(message.split("\n")[0]).toBe("fix(x): repair failing lint and test gates");
  });

  test("a fix node that changed nothing produces no commit", async () => {
    const { out, argv } = await runCommitNode("commit_gate", "");
    expect(out.committed).toBe(false);
    expect(argv.some((c) => c.startsWith("git commit"))).toBe(false);
  });

  // ctx.outputs holds only the latest output per node, so a round not recorded
  // here is a round no terminal node can reconstruct.
  test("records the round to the audit trail, findings included", async () => {
    const { rounds } = await runCommitNode("commit_quality", " M a.ts\n", {
      review_quality: { findings: [{ severity: "CRITICAL", title: "T", problem: "P", fix: "F" }] },
    });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      phase: "quality",
      committed: true,
      findings: [{ severity: "CRITICAL", title: "T" }],
    });
  });

  test("records a round even when the fix committed nothing, so the dead round is visible", async () => {
    const { rounds } = await runCommitNode("commit_gate", "", { quality_gates: { failing: ["test"] } });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ phase: "gate", committed: false, failing: ["test"] });
  });

  // AC1 — the live audit trail must carry the SHA produced by this round's
  // commit. "Fixed in <sha>" is otherwise only reconstructable by matching
  // round timestamps against `git log`, which is not what audit trails are for.
  test("records the post-commit SHA on the round when the tree was dirty", async () => {
    const { rounds, revParseCalls } = await runCommitNode(
      "commit_quality",
      " M a.ts\n",
      { review_quality: { findings: [{ severity: "CRITICAL", title: "T", problem: "P", fix: "F" }] } },
      "deadbeef",
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ phase: "quality", committed: true, sha: "deadbeef" });
    // Two rev-parse calls: one for shaBefore, one for shaAfter — proves the SHA
    // recorded is the post-commit HEAD, not the pre-commit one.
    expect(revParseCalls).toBe(2);
  });

  // AC2 — a no-op round has no commit and therefore no SHA to record. The
  // `sha` key must be absent, not present-with-undefined or present-with-null,
  // so the result-file reader can distinguish "no commit" from "record lost".
  test("records no sha on the round when the tree was clean (no commit happened)", async () => {
    const { rounds } = await runCommitNode("commit_gate", "", { quality_gates: { failing: ["test"] } });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ phase: "gate", committed: false });
    expect(rounds[0]).not.toHaveProperty("sha");
  });

  test("marks a review-phase round as fixed — a reviewer found something and this fixed it", async () => {
    const { rounds } = await runCommitNode("commit_quality", " M a.ts\n", {
      review_quality: { findings: [{ severity: "LOW", title: "T", problem: "P", fix: "F" }] },
    });
    expect(rounds[0]).toMatchObject({ outcome: "fixed" });
  });

  // The gate phase has no `review_gate` node at all. Recording its empty finding
  // list without saying so let the PR body render "- _no findings_", which reads
  // as "a reviewer looked and approved this" — manufactured evidence for a
  // review that cannot have happened (#1507).
  test("marks a gate round as having no reviewer, never as a clean review", async () => {
    const { rounds } = await runCommitNode("commit_gate", "", { quality_gates: { failing: ["test"] } });
    expect(rounds[0]).toMatchObject({ phase: "gate", outcome: "no-reviewer" });
    expect(rounds[0].outcome).not.toBe("passed");
  });

  test("marks an acceptance round as having no reviewer", async () => {
    const { rounds } = await runCommitNode("commit_acceptance", " M a.ts\n");
    expect(rounds[0]).toMatchObject({ phase: "acceptance", outcome: "no-reviewer" });
  });
});

// Regression: the gate loop was the last loop to edit the tree and the only one
// whose edits nothing reviewed — `quality_gates` proves the repo's commands are
// green, which a bad fix can satisfy. rs-stock/pipeline-run-outcome shipped 8
// copy-pasted test stubs through this hole.
describe("gate fixes re-enter the quality review", () => {
  const gateSwitch = () => switchOf("commit_gate");

  test("a gate fix that committed goes back through review_quality", () => {
    expect(gateSwitch().cases.changed).toBe("review_quality");
  });

  test("a gate fix that changed nothing skips the re-review", () => {
    expect(gateSwitch().cases.unchanged).toBe("quality_gates");
  });

  test("the re-entry still terminates: review_quality's own fix loop keeps its escalate exit", () => {
    expect(switchOf("route_quality").cases.escalate).toBe("escalate");
    expect(switchOf("route_quality").cases.clean).toBe("quality_gates");
  });
});

// Chosen tradeoff, not an oversight: the re-review is the flow's most expensive
// node and a gate fix is usually a mechanical test repair. It is a real hole —
// the defect that motivated the re-entry (rs-stock b6fb66dd) was itself
// test-only — so these tests pin the boundary precisely.
describe("gate re-entry is scoped to non-test changes", () => {
  const originalRun = _gitDeps.run;
  const originalAppend = _resultDeps.appendText;
  afterEach(() => {
    _gitDeps.run = originalRun;
    _resultDeps.appendText = originalAppend;
  });

  const TS_TEST_REGEX = ["\\.test\\.ts$", "(^|/)test/"];

  const gateRounds: unknown[] = [];

  const runGateCommit = async (
    files: string[],
    regex: string[] = TS_TEST_REGEX,
    opts: { revParseFails?: boolean } = {},
  ) => {
    gateRounds.length = 0;
    _resultDeps.appendText = async (_p, s) => {
      gateRounds.push(JSON.parse(s));
    };
    _gitDeps.run = async (cmd) => {
      if (cmd.includes("--porcelain")) return { exitCode: 0, stdout: " M a\n", stderr: "" };
      if (cmd.includes("rev-parse"))
        return opts.revParseFails
          ? { exitCode: 128, stdout: "", stderr: "fatal" }
          : { exitCode: 0, stdout: "sha1\n", stderr: "" };
      if (cmd.includes("--name-only")) return { exitCode: 0, stdout: `${files.join("\n")}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return nodeRun<{ route: string }>("commit_gate").run(ctxOf({ outputs: { load_ctx: { testFileRegex: regex } } }));
  };

  test("a fix touching production code routes into review_quality", async () => {
    expect((await runGateCommit(["src/scheduler.ts", "test/unit/scheduler.test.ts"])).route).toBe("changed");
  });

  test("a fix touching only test files skips the re-review", async () => {
    expect((await runGateCommit(["test/unit/a.test.ts", "test/unit/b.test.ts"])).route).toBe("tests-only");
  });

  // Fail-safe: an older nax whose `features resolve` predates testPatterns, or a
  // config the resolver choked on, must review rather than skip.
  test("with no patterns to classify by, it reviews rather than skipping", async () => {
    expect((await runGateCommit(["test/unit/a.test.ts"], [])).route).toBe("changed");
  });

  test("an unparseable pattern is ignored without taking the flow down", async () => {
    expect((await runGateCommit(["test/unit/a.test.ts"], ["\\.test\\.ts$", "([unclosed"])).route).toBe("tests-only");
  });

  test("an empty file list (git show failed) reviews rather than skipping", async () => {
    expect((await runGateCommit([])).route).toBe("changed");
  });

  // The skip is a deliberate cost tradeoff, but until it says so in the audit
  // it is indistinguishable from a gate fix that WAS re-reviewed — both wrote
  // `no-reviewer`. That is the #1507 failure mode surviving on the one path
  // where the omission is on purpose, which is exactly where a reader most
  // needs to know. Recording it is also what makes "how often does this fire?"
  // answerable before anyone decides whether to close the hole.
  test("a skipped re-review says so in the audit trail", async () => {
    await runGateCommit(["test/unit/a.test.ts"]);
    expect(gateRounds[0]).toMatchObject({ phase: "gate", outcome: "review-skipped" });
  });

  test("a gate fix that IS re-reviewed is not marked skipped", async () => {
    await runGateCommit(["src/scheduler.ts"]);
    expect(gateRounds[0]).toMatchObject({ phase: "gate", outcome: "no-reviewer" });
  });

  test("a gate fix that committed nothing is not marked skipped — there was nothing to review", async () => {
    _resultDeps.appendText = async (_p, s) => {
      gateRounds.push(JSON.parse(s));
    };
    gateRounds.length = 0;
    _gitDeps.run = async (cmd) => {
      if (cmd.includes("--porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "sha1\n", stderr: "" };
    };
    await nodeRun<{ route: string }>("commit_gate").run(ctxOf({ outputs: { load_ctx: { testFileRegex: [] } } }));
    expect(gateRounds[0]).toMatchObject({ outcome: "no-reviewer" });
  });

  // A committed fix whose HEAD will not resolve is real and unclassifiable. It
  // must not be folded in with "nothing committed" — that would skip the review
  // for a change that actually landed on the branch.
  test("a commit whose HEAD does not resolve reviews rather than skipping", async () => {
    const out = await runGateCommit(["test/unit/a.test.ts"], TS_TEST_REGEX, { revParseFails: true });
    expect(out.committed).toBe(true);
    expect(out.route).toBe("changed");
  });
});

// `incrementalSince` decides how much a re-review re-reads. Under-scoping it
// silently hides code from the reviewer, so every case that cannot prove
// "exactly one commit since the last verdict" must fall back to a full review.
describe("review nodes — incremental scoping window", () => {
  const promptOf = (
    id: string,
    over: { outputs?: Record<string, unknown>; steps?: { nodeId: string; output?: unknown }[] },
  ) => (flow.nodes[id] as unknown as { prompt: (c: FlowNodeContext) => string }).prompt(ctxOf(over));

  const LOAD = { load_ctx: { base: "origin/main", specPath: "s.md" } };

  test("the first review of a phase reads the whole branch diff", () => {
    expect(promptOf("review_spec", { outputs: LOAD, steps: makeFlowSteps(["load_ctx"]) })).toContain(
      "git diff origin/main...HEAD",
    );
  });

  test("one commit since the last review scopes to that commit's parent tree", () => {
    const p = promptOf("review_spec", {
      outputs: { ...LOAD, review_spec: { findings: [] } },
      steps: makeFlowSteps(["review_spec", "fix_spec", ["commit_spec", { shaBefore: "sha-at-review-1" }]]),
    });
    expect(p).toContain("git diff sha-at-review-1..HEAD");
  });

  // The acceptance loop can commit between a spec fix and its re-review. The
  // window must span BOTH commits, so it anchors on the first one after the
  // review — anchoring on the last would hide the spec fix from the reviewer.
  test("two commits since the last review scope from the FIRST, spanning both", () => {
    const p = promptOf("review_spec", {
      outputs: { ...LOAD, review_spec: { findings: [] } },
      steps: makeFlowSteps([
        "review_spec",
        ["commit_spec", { shaBefore: "sha-at-review-1" }],
        "acceptance",
        ["commit_acceptance", { shaBefore: "sha-after-spec-fix" }],
      ]),
    });
    expect(p).toContain("git diff sha-at-review-1..HEAD");
    expect(p).not.toContain("sha-after-spec-fix..HEAD");
  });

  test("a commit that recorded no shaBefore falls back to a full review", () => {
    const p = promptOf("review_quality", {
      outputs: { ...LOAD, review_quality: { findings: [] } },
      steps: makeFlowSteps(["review_quality", ["commit_quality", { shaBefore: null }]]),
    });
    expect(p).toContain("git diff origin/main...HEAD");
  });

  // A fix node that edited nothing still records a `commit_*` step, and that
  // step's `shaBefore` is the *current* HEAD — so scoping to it asks for
  // `HEAD..HEAD`, an empty diff. The reviewer is simultaneously told the prior
  // findings "have since been fixed and committed", so it returns clean and
  // route_* sends the flow onward with the findings unfixed. That exits the
  // loop through the green door rather than the fix cap, which is why
  // MAX_FIX_ATTEMPTS never catches it.
  test("a fix that committed nothing falls back to a full review", () => {
    const p = promptOf("review_quality", {
      outputs: { ...LOAD, review_quality: { findings: [{ severity: "HIGH", title: "t", problem: "p", fix: "f" }] } },
      steps: makeFlowSteps([
        "review_quality",
        "fix_quality",
        ["commit_quality", { committed: false, shaBefore: "head-sha", shaAfter: "head-sha" }],
      ]),
    });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).not.toContain("head-sha..HEAD");
  });

  // The window must still open at the tree the last verdict passed on, so a
  // no-op round followed by a real one scopes from the REAL commit's parent.
  test("a no-op round before a real commit scopes from the commit that landed", () => {
    const p = promptOf("review_quality", {
      outputs: { ...LOAD, review_quality: { findings: [] } },
      steps: makeFlowSteps([
        "review_quality",
        ["commit_gate", { committed: false, shaBefore: "head-sha", shaAfter: "head-sha" }],
        ["commit_gate", { committed: true, shaBefore: "head-sha", shaAfter: "new-sha" }],
      ]),
    });
    expect(p).toContain("git diff head-sha..HEAD");
  });

  test("only commits AFTER the last review count — an earlier one does not scope it", () => {
    const p = promptOf("review_quality", {
      outputs: { ...LOAD, review_quality: { findings: [] } },
      steps: makeFlowSteps([["commit_quality", { shaBefore: "old" }], "review_quality"]),
    });
    expect(p).toContain("git diff origin/main...HEAD");
  });

  // The gate re-entry: quality_gates -> fix_gate -> commit_gate -> review_quality.
  test("the gate re-entry scopes the quality re-review to the gate commit", () => {
    const p = promptOf("review_quality", {
      outputs: { ...LOAD, review_quality: { findings: [] } },
      steps: makeFlowSteps([
        "review_quality",
        "quality_gates",
        "fix_gate",
        ["commit_gate", { shaBefore: "sha-at-clean-review" }],
      ]),
    });
    expect(p).toContain("git diff sha-at-clean-review..HEAD");
  });
});
