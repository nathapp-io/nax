import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _acceptanceDeps } from "@flows/nax-finish/steps/acceptance";
import { _contextDeps } from "@flows/nax-finish/steps/context";
import { _escalateDeps } from "@flows/nax-finish/steps/escalate";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import { _prDeps } from "@flows/nax-finish/steps/pr";
import { _qualityDeps } from "@flows/nax-finish/steps/quality";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FlowNodeContext } from "acpx/flows";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

const ctxOf = (over: {
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  steps?: { nodeId: string }[];
}): FlowNodeContext =>
  ({
    input: over.input ?? INPUT,
    outputs: over.outputs ?? {},
    results: {},
    state: { steps: over.steps ?? [] } as never,
    services: {},
  }) as FlowNodeContext;

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;
const switchOf = (from: string) => {
  const edge = flow.edges.find((e) => e.from === from && "switch" in e);
  if (!edge || !("switch" in edge)) throw new Error(`no switch edge from ${from}`);
  return edge.switch;
};
const toOf = (from: string) => {
  const edge = flow.edges.find((e) => e.from === from && "to" in e);
  return edge && "to" in edge ? edge.to : undefined;
};

const GROUPS = [
  {
    packageDir: "",
    testPath: ".nax/features/x/a.test.ts",
    exists: true,
    command: "bun test {{FILE}}",
    language: "typescript",
  },
];

describe("nax-finish flow graph", () => {
  test("declares approve-all + starts at load_ctx", () => {
    expect(flow.name).toBe("nax-finish");
    expect(flow.permissions?.requiredMode).toBe("approve-all");
    expect(flow.startAt).toBe("load_ctx");
  });

  test("has every node the pipeline needs", () => {
    for (const n of [
      "load_ctx",
      "acceptance",
      "fix_acceptance",
      "review_spec",
      "route_spec",
      "fix_spec",
      "review_quality",
      "route_quality",
      "fix_quality",
      "quality_gates",
      "fix_gate",
      "open_pr",
      "escalate",
    ]) {
      expect(flow.nodes[n]).toBeDefined();
    }
    expect(flow.nodes.review_spec.nodeType).toBe("acp");
    // load_ctx shells git + `nax features resolve`, so it is an action, not a compute.
    expect(flow.nodes.load_ctx.nodeType).toBe("action");
  });

  test("review nodes are isolated and their profile comes from NAX_FINISH_*_PROFILE at module load", () => {
    for (const id of ["review_spec", "review_quality"]) {
      expect((flow.nodes[id] as { session?: { isolated?: boolean } }).session?.isolated).toBe(true);
    }
  });

  test("every fix loop has an escalate exit, so no loop can run forever", () => {
    expect(switchOf("acceptance").cases.escalate).toBe("escalate");
    expect(switchOf("quality_gates").cases.escalate).toBe("escalate");
    expect(switchOf("route_spec").cases.escalate).toBe("escalate");
    expect(switchOf("route_quality").cases.escalate).toBe("escalate");
  });

  test("a clean review skips its fix node entirely", () => {
    expect(switchOf("route_spec").cases.clean).toBe("review_quality");
    expect(switchOf("route_quality").cases.clean).toBe("quality_gates");
  });

  test("review fixes are re-verified, not applied once and trusted", () => {
    // spec fixes re-run the acceptance gate, which routes back into review_spec
    expect(toOf("commit_spec")).toBe("acceptance");
    expect(switchOf("acceptance").cases.proceed).toBe("review_spec");
    // quality fixes are re-reviewed by the same lens
    expect(toOf("commit_quality")).toBe("review_quality");
    expect(toOf("commit_acceptance")).toBe("acceptance");
    // commit_gate is the exception — it switches on whether it committed, so
    // that a real gate fix is re-reviewed. See "gate fixes re-enter the quality
    // review" below.
    expect(switchOf("commit_gate").cases.unchanged).toBe("quality_gates");
  });

  // Regression: #1397 — reviewers read `git diff base...HEAD`, so an uncommitted
  // fix is invisible to the re-review and the loop escalates at the cap having
  // re-reported findings that were already fixed.
  test("every fix node commits before anything re-reads the diff", () => {
    for (const phase of ["acceptance", "spec", "quality", "gate"]) {
      expect(flow.nodes[`commit_${phase}`]).toBeDefined();
      expect(flow.nodes[`commit_${phase}`].nodeType).toBe("action");
      expect(toOf(`fix_${phase}`)).toBe(`commit_${phase}`);
    }
  });
});

describe("load_ctx node", () => {
  const originalRun = _contextDeps.run;
  afterEach(() => {
    _contextDeps.run = originalRun;
  });

  test("resolves the feature once and carries base, specPath and groups forward", async () => {
    const cmds: string[][] = [];
    _contextDeps.run = async (cmd) => {
      cmds.push(cmd);
      const joined = cmd.join(" ");
      if (joined.includes("remote show")) return { exitCode: 0, stdout: "HEAD branch: main\n", stderr: "" };
      if (joined.includes("features resolve"))
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            specSource: { kind: "markdown", path: ".nax/features/x/spec.md" },
            acceptance: { status: "ok", groups: GROUPS },
          }),
          stderr: "",
        };
      return { exitCode: 0, stdout: "2\n", stderr: "" };
    };

    const out = await nodeRun<{ base: string; specPath: string; groups: unknown[]; route: string }>("load_ctx").run(
      ctxOf({}),
    );

    expect(out).toMatchObject({ base: "origin/main", specPath: ".nax/features/x/spec.md", route: "proceed" });
    expect(out.groups).toEqual(GROUPS);
    expect(cmds.filter((c) => c.join(" ").includes("features resolve")).length).toBe(1);
  });
});

describe("acceptance node", () => {
  const originalRun = _acceptanceDeps.runShell;
  afterEach(() => {
    _acceptanceDeps.runShell = originalRun;
  });

  test("reads groups from load_ctx instead of resolving the feature again", async () => {
    let ran = 0;
    _acceptanceDeps.runShell = async () => {
      ran += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const out = await nodeRun<{ route: string }>("acceptance").run(
      ctxOf({ outputs: { load_ctx: { groups: GROUPS, base: "origin/main", specPath: "s" } } }),
    );
    expect(out.route).toBe("proceed");
    expect(ran).toBe(1);
  });

  test("still under the cap routes to fix, not escalate", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "still failing" });
    const out = await nodeRun<{ route: string }>("acceptance").run(
      ctxOf({
        outputs: { load_ctx: { groups: GROUPS } },
        steps: [{ nodeId: "fix_acceptance" }, { nodeId: "fix_acceptance" }],
      }),
    );
    expect(out.route).toBe("fix");
  });

  // Regression: an empty/ungenerated acceptance set used to report `passed`,
  // so the flow could open a ready PR having verified nothing (issue #1398).
  test("escalates instead of passing when the feature has no PRD to compute targets from", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await nodeRun<{ route: string; reason?: string }>("acceptance").run(
      ctxOf({ outputs: { load_ctx: { groups: [], acceptanceStatus: "no-prd" } } }),
    );
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("no-prd");
  });

  test("skips cleanly when acceptance is disabled in config", async () => {
    let ran = 0;
    _acceptanceDeps.runShell = async () => {
      ran += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await nodeRun<{ route: string; output: string }>("acceptance").run(
      ctxOf({ outputs: { load_ctx: { groups: [], acceptanceStatus: "disabled" } } }),
    );
    expect(out.route).toBe("proceed");
    expect(ran).toBe(0);
    expect(out.output).toContain("disabled");
  });

  test("escalates when every group's acceptance test is missing — nothing was verified", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await nodeRun<{ route: string; reason?: string }>("acceptance").run(
      ctxOf({
        outputs: { load_ctx: { groups: [{ ...GROUPS[0], exists: false }], acceptanceStatus: "ok" } },
      }),
    );
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("never generated");
  });

  test("escalates on a partial coverage hole even when the runnable groups pass", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await nodeRun<{ route: string; reason?: string }>("acceptance").run(
      ctxOf({
        outputs: {
          load_ctx: {
            groups: [GROUPS[0], { ...GROUPS[0], packageDir: "apps/web", exists: false }],
            acceptanceStatus: "ok",
          },
        },
      }),
    );
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("apps/web");
  });

  test("a real test failure still routes to the fix loop, not the coverage escalation", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "assert failed" });
    const out = await nodeRun<{ route: string }>("acceptance").run(
      ctxOf({
        outputs: {
          load_ctx: {
            groups: [GROUPS[0], { ...GROUPS[0], packageDir: "apps/web", exists: false }],
            acceptanceStatus: "ok",
          },
        },
      }),
    );
    expect(out.route).toBe("fix");
  });

  test("at the cap routes to escalate with a reason", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "still failing" });
    const out = await nodeRun<{ route: string; reason?: string }>("acceptance").run(
      ctxOf({
        outputs: { load_ctx: { groups: GROUPS } },
        steps: [{ nodeId: "fix_acceptance" }, { nodeId: "fix_acceptance" }, { nodeId: "fix_acceptance" }],
      }),
    );
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("3 fix attempts");
  });
});

describe("review parse + route_* nodes", () => {
  const parseSpec = (flow.nodes.review_spec as { parse: (t: string) => { route: string; findings: unknown[] } }).parse;

  test("parse rewrites a findings-free proceed to clean", () => {
    expect(parseSpec(JSON.stringify({ route: "proceed", findings: [] })).route).toBe("clean");
  });

  test("parse keeps proceed when there are findings, and escalate always", () => {
    const finding = { severity: "HIGH", title: "t", problem: "p", fix: "f" };
    expect(parseSpec(JSON.stringify({ route: "proceed", findings: [finding] })).route).toBe("proceed");
    expect(parseSpec(JSON.stringify({ route: "escalate", findings: [] })).route).toBe("escalate");
  });

  test("parse tolerates a missing findings array", () => {
    expect(parseSpec(JSON.stringify({ route: "proceed" })).findings).toEqual([]);
  });

  const finding = { severity: "HIGH" as const, title: "t", problem: "p", fix: "f" };

  test("route_spec sends findings to the fix node while under the cap", () => {
    const out = nodeRun<{ route: string }>("route_spec").run(
      ctxOf({ outputs: { review_spec: { route: "proceed", findings: [finding] } } }),
    ) as { route: string };
    expect(out.route).toBe("fix");
  });

  test("route_spec escalates once the fix cap is reached", () => {
    const out = nodeRun<{ route: string; escalationReason?: string }>("route_spec").run(
      ctxOf({
        outputs: { review_spec: { route: "proceed", findings: [finding] } },
        steps: [{ nodeId: "fix_spec" }, { nodeId: "fix_spec" }, { nodeId: "fix_spec" }],
      }),
    ) as { route: string; escalationReason?: string };
    expect(out.route).toBe("escalate");
    expect(out.escalationReason).toContain("after 3 fix attempts");
  });

  test("route_spec passes the reviewer's own escalate verdict straight through", () => {
    const out = nodeRun<{ route: string; escalationReason?: string }>("route_spec").run(
      ctxOf({
        outputs: {
          review_spec: { route: "escalate", findings: [finding], escalationReason: "AC-3 contradicts the schema" },
        },
      }),
    ) as { route: string; escalationReason?: string };
    expect(out.route).toBe("escalate");
    expect(out.escalationReason).toBe("AC-3 contradicts the schema");
  });

  test("route_quality reads the quality verdict, not the spec one", () => {
    const out = nodeRun<{ route: string }>("route_quality").run(
      ctxOf({
        outputs: {
          review_spec: { route: "proceed", findings: [finding] },
          review_quality: { route: "clean", findings: [] },
        },
      }),
    ) as { route: string };
    expect(out.route).toBe("clean");
  });
});

describe("quality_gates node", () => {
  const originalRun = _qualityDeps.runShell;
  const originalReadText = _qualityDeps.readText;
  const originalAcceptanceRun = _acceptanceDeps.runShell;
  afterEach(() => {
    _qualityDeps.runShell = originalRun;
    _qualityDeps.readText = originalReadText;
    _acceptanceDeps.runShell = originalAcceptanceRun;
  });

  // The feature's acceptance tests are re-run here because the quality-review
  // and gate fix loops edit code after the `acceptance` node last passed, and
  // the repo-root `test` command does not cover them — they live under
  // `<pkg>/.nax/features/<f>/` and usually need their own runner config. Without
  // this, a quality fix could break the feature's own contract and still ship.
  describe("acceptance as gate zero", () => {
    const withGroups = () => ctxOf({ outputs: { load_ctx: { groups: GROUPS } } });

    test("runs the feature's acceptance tests before the configured commands", async () => {
      const order: string[] = [];
      _acceptanceDeps.runShell = async () => {
        order.push("acceptance");
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      _qualityDeps.runShell = async () => {
        order.push("lint");
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const out = await nodeRun<{ route: string }>("quality_gates").run(withGroups());

      expect(out.route).toBe("green");
      expect(order).toEqual(["acceptance", "lint"]);
    });

    test("a fix that broke the contract routes to the gate fix loop, naming acceptance", async () => {
      _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "AssertionError" });
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });

      const out = await nodeRun<{ route: string; failing: string[]; output: string }>("quality_gates").run(
        withGroups(),
      );

      expect(out.route).toBe("fix");
      expect(out.failing).toContain("acceptance");
      expect(out.output).toContain("AssertionError");
    });

    test("does not run the repo gates while acceptance is red", async () => {
      _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      let gatesRan = 0;
      _qualityDeps.runShell = async () => {
        gatesRan += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const out = await nodeRun<{ route: string; reason?: string }>("quality_gates").run(withGroups());

      expect(gatesRan).toBe(0);
      // must not be mistaken for the "nothing configured" escalation — the
      // commands are configured, they were skipped on purpose
      expect(out.reason).toBeUndefined();
    });

    test("at the cap it escalates naming the broken contract, not the lint gate", async () => {
      _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });

      const out = await nodeRun<{ route: string; reason?: string }>("quality_gates").run(
        ctxOf({
          outputs: { load_ctx: { groups: GROUPS } },
          steps: [{ nodeId: "fix_gate" }, { nodeId: "fix_gate" }, { nodeId: "fix_gate" }],
        }),
      );

      expect(out.route).toBe("escalate");
      expect(out.reason).toContain("contract");
    });

    test("acceptance disabled (no groups) does not block a green gate", async () => {
      let acceptanceRan = 0;
      _acceptanceDeps.runShell = async () => {
        acceptanceRan += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });

      const out = await nodeRun<{ route: string }>("quality_gates").run(
        ctxOf({ outputs: { load_ctx: { groups: [] } } }),
      );

      expect(acceptanceRan).toBe(0);
      expect(out.route).toBe("green");
    });
  });

  test("escalates instead of reporting green when the repo configured no commands", async () => {
    _qualityDeps.readText = async () => JSON.stringify({ quality: {} });
    _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await nodeRun<{ route: string; reason?: string }>("quality_gates").run(ctxOf({}));
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("No quality.commands configured");
  });

  test("at the cap routes to escalate with a reason naming the failing gates", async () => {
    _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
    _qualityDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "lint bad" });
    const out = await nodeRun<{ route: string; reason?: string }>("quality_gates").run(
      ctxOf({ steps: [{ nodeId: "fix_gate" }, { nodeId: "fix_gate" }, { nodeId: "fix_gate" }] }),
    );
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("lint");
  });

  test("green when the configured gates pass", async () => {
    _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
    _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await nodeRun<{ route: string }>("quality_gates").run(ctxOf({}));
    expect(out.route).toBe("green");
  });
});

describe("open_pr node", () => {
  const originalPrRun = _prDeps.run;
  const originalGitRun = _gitDeps.run;
  const originalWriteText = _resultDeps.writeText;
  afterEach(() => {
    _prDeps.run = originalPrRun;
    _gitDeps.run = originalGitRun;
    _resultDeps.writeText = originalWriteText;
  });

  test("commits and pushes the flow's fixes before opening the PR", async () => {
    const gitCalls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      gitCalls.push(cmd);
      return cmd.includes("--porcelain")
        ? { exitCode: 0, stdout: " M src/a.ts\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };
    const prCalls: string[][] = [];
    _prDeps.run = async (cmd) => {
      prCalls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view"))
        return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let wrote = "";
    _resultDeps.writeText = async (_p, s) => {
      wrote = s;
    };

    const out = await nodeRun<{ status: string; committed: boolean }>("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "proceed" } } }),
    );

    expect(gitCalls.map((c) => c.join(" "))).toContain("git push --set-upstream origin feat/x");
    expect(out.committed).toBe(true);
    expect(out.status).toBe("promoted");
    expect(JSON.parse(wrote)).toMatchObject({ status: "promoted", url: "https://gh/pr/1" });
  });

  test("writes nothing-to-finish and touches neither git nor the forge", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let wrote = "";
    _resultDeps.writeText = async (_p, s) => {
      wrote = s;
    };

    const out = await nodeRun<{ status: string }>("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "nothing-to-finish" } } }),
    );

    expect(calls).toEqual([]);
    expect(out).toMatchObject({ status: "nothing-to-finish" });
    expect(JSON.parse(wrote)).toMatchObject({ status: "nothing-to-finish" });
  });
});

describe("escalate node", () => {
  const originalEscalateRun = _escalateDeps.run;
  const originalGitRun = _gitDeps.run;
  const originalWriteText = _resultDeps.writeText;
  afterEach(() => {
    _escalateDeps.run = originalEscalateRun;
    _gitDeps.run = originalGitRun;
    _resultDeps.writeText = originalWriteText;
  });

  const stubForge = (calls: string[][]) => {
    _escalateDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 0, stdout: JSON.stringify({ url: "https://gh/pr/9" }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  };

  test("uses the routed review reason and pushes partial fixes", async () => {
    const forgeCalls: string[][] = [];
    stubForge(forgeCalls);
    const gitCalls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      gitCalls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let wrote = "";
    _resultDeps.writeText = async (_p, s) => {
      wrote = s;
    };

    const out = await nodeRun<{ escalationReason: string; channel: string }>("escalate").run(
      ctxOf({
        outputs: {
          route_spec: { route: "escalate", findings: [], escalationReason: "spec contradiction" },
        },
      }),
    );

    expect(out.escalationReason).toBe("spec contradiction");
    expect(out.channel).toBe("pr-comment");
    expect(gitCalls.map((c) => c.join(" "))).toContain("git push --set-upstream origin feat/x");
    expect(JSON.parse(wrote)).toMatchObject({ status: "escalated", escalationReason: "spec contradiction" });
  });

  test("falls back to a loop-exhaustion reason from acceptance / quality_gates", async () => {
    stubForge([]);
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _resultDeps.writeText = async () => {};

    const out = await nodeRun<{ escalationReason: string }>("escalate").run(
      ctxOf({ outputs: { quality_gates: { route: "escalate", reason: "gates still failing (lint)" } } }),
    );
    expect(out.escalationReason).toBe("gates still failing (lint)");
  });

  test("a push failure is reported in the comment rather than losing the escalation", async () => {
    const forgeCalls: string[][] = [];
    stubForge(forgeCalls);
    _gitDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "remote rejected" });
    _resultDeps.writeText = async () => {};

    const out = await nodeRun<{ escalationReason: string }>("escalate").run(
      ctxOf({ outputs: { route_quality: { route: "escalate", findings: [], escalationReason: "needs judgment" } } }),
    );

    expect(out.escalationReason).toBe("needs judgment");
    const comment = forgeCalls.find((c) => c.join(" ").includes("pr comment"))?.join(" ") ?? "";
    expect(comment).toContain("could not push its partial fixes");
  });

  test("prefers Telegram when the input says it is configured", async () => {
    const forgeCalls: string[][] = [];
    stubForge(forgeCalls);
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _resultDeps.writeText = async () => {};

    const out = await nodeRun<{ channel: string }>("escalate").run(
      ctxOf({
        input: { ...INPUT, escalateTelegram: true },
        outputs: { route_spec: { route: "escalate", findings: [], escalationReason: "r" } },
      }),
    );

    expect(out.channel).toBe("telegram");
    expect(forgeCalls.some((c) => c.join(" ").includes("pr comment"))).toBe(false);
  });

  // Regression: on the Telegram path the composed comment (the only thing
  // carrying the findings) was discarded, and the result file recorded just a
  // count — so no artifact anywhere named what needed judgment (issue #1398).
  test("persists the findings in the result file, not only the reason", async () => {
    stubForge([]);
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    let wrote = "";
    _resultDeps.writeText = async (_p, s) => {
      wrote = s;
    };
    const findings = [
      { severity: "HIGH", title: "holidays ignores timezone", problem: "no query param", fix: "add it" },
    ];

    await nodeRun("escalate").run(
      ctxOf({
        input: { ...INPUT, escalateTelegram: true },
        outputs: { route_spec: { route: "escalate", findings, escalationReason: "3 findings after 3 attempts" } },
      }),
    );

    expect(JSON.parse(wrote).findings).toEqual(findings);
  });

  // Regression: postEscalation ran before writeResult, so a failing comment (or
  // an unknown forge) killed the node with no result file — the plugin then had
  // nothing to notify from, and the escalation vanished entirely (#1399).
  test("a failed delivery still leaves a result file the plugin can notify from", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 0, stdout: JSON.stringify({ url: "https://gh/pr/9" }), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "rate limit exceeded" };
    };
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const writes: string[] = [];
    _resultDeps.writeText = async (_p, s) => {
      writes.push(s);
    };

    const out = await nodeRun<{ escalationReason: string; deliveryError?: string }>("escalate").run(
      ctxOf({ outputs: { route_spec: { route: "escalate", findings: [], escalationReason: "needs judgment" } } }),
    );

    expect(out.escalationReason).toBe("needs judgment");
    expect(out.deliveryError).toContain("rate limit exceeded");
    const final = JSON.parse(writes[writes.length - 1]);
    expect(final).toMatchObject({ status: "escalated", escalationReason: "needs judgment" });
    expect(final.deliveryError).toContain("rate limit exceeded");
  });

  test("writes the result before attempting delivery, not after", async () => {
    const order: string[] = [];
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 0, stdout: JSON.stringify({ url: "https://gh/pr/9" }), stderr: "" };
      order.push("deliver");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _resultDeps.writeText = async () => {
      order.push("write");
    };

    await nodeRun("escalate").run(
      ctxOf({ outputs: { route_spec: { route: "escalate", findings: [], escalationReason: "r" } } }),
    );

    expect(order[0]).toBe("write");
    expect(order).toContain("deliver");
  });

  test("an unknown forge does not sink the escalation", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@git.corp:o/r", stderr: "" };
      return { exitCode: 127, stdout: "", stderr: "command not found" };
    };
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    let wrote = "";
    _resultDeps.writeText = async (_p, s) => {
      wrote = s;
    };

    const out = await nodeRun<{ deliveryError?: string }>("escalate").run(
      ctxOf({
        input: { ...INPUT, escalateTelegram: true },
        outputs: { route_spec: { route: "escalate", findings: [], escalationReason: "r" } },
      }),
    );

    expect(out.deliveryError).toBeTruthy();
    expect(JSON.parse(wrote)).toMatchObject({ status: "escalated", escalationReason: "r" });
  });
});
