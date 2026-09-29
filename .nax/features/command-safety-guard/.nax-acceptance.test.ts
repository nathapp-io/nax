import { afterEach, describe, expect, test } from "bun:test";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import {
  type Classify,
  type CommandSafetyRow,
  type CommandShadow,
  createCommandShadow,
  buildCommandShadow,
  detectTmpWrite,
  type ModelResult,
  type Observation,
  RULE_SET_VERSION,
  scoreRules,
} from "@/command-safety";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { CommandSafetyConfigSchema } from "@/config";
import { buildDispatchAskWiring } from "@/interaction";
import type { AskRequest, AskResolver, AskVerdict } from "@/permissions";
import {
  DISABLED_SANDBOX_STATE,
  type CommandLauncher,
  type LaunchRequest,
  type SandboxState,
} from "@/sandbox";
import {
  type CodingTool,
  compileToolPolicy,
  createCodingToolRuntime,
  createRunCommandTool,
  type PolicyVerdict,
  type ToolPolicy,
} from "@/tools";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withWarnSpy } from "@test/helpers";

// ══════════════════════════════════════════════════════════════════════════════
// Shared fixtures
// ══════════════════════════════════════════════════════════════════════════════

const GUARD_THRESHOLD = 0.75;

/** The guard decision shape this feature adds (structural, so the file loads pre-implementation). */
interface GuardDecisionLike {
  readonly flagged: boolean;
  readonly score?: number;
  readonly threshold?: number;
  readonly basis?: "model" | "rules" | "temp-only";
  readonly category?: string;
}

/** The guard input shape this feature adds. */
interface GuardAssessInputLike {
  readonly command: string;
  readonly cwd?: string;
  readonly tempConfined: boolean;
}

type GuardLike = { assess(input: GuardAssessInputLike): Promise<GuardDecisionLike> };

/** Spec "high" answer: score ((1 - 0.1) + 0.9) / 2 = 0.9, top harm option discards_work. */
const HIGH_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 1,
  answers: {
    harm: {
      none: 0.1,
      deletes_data: 0.06,
      discards_work: 0.6,
      outside_project: 0.06,
      system_change: 0.06,
      network_send: 0.06,
      privilege: 0.06,
    },
    noul: {
      deletes_data: 0.9,
      discards_work: 0.9,
      outside_project: 0.9,
      system_change: 0.9,
      network_send: 0.9,
      privilege: 0.9,
    },
  },
};

/** Spec "low" answer: score (0.06 + 0.05) / 2 = 0.055. */
const LOW_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 1,
  answers: {
    harm: {
      none: 0.94,
      deletes_data: 0.01,
      discards_work: 0.01,
      outside_project: 0.01,
      system_change: 0.01,
      network_send: 0.01,
      privilege: 0.01,
    },
    noul: {
      deletes_data: 0.05,
      discards_work: 0.05,
      outside_project: 0.05,
      system_change: 0.05,
      network_send: 0.05,
      privilege: 0.05,
    },
  },
};

/** AC-60's half answer: modelScore (0.5 + 0.5) / 2 = 0.5, exactly at the threshold. */
const HALF_ANSWER: ModelResult = {
  status: "answered",
  latencyMs: 1,
  answers: {
    harm: {
      none: 0.5,
      deletes_data: 0.5,
      discards_work: 0,
      outside_project: 0,
      system_change: 0,
      network_send: 0,
      privilege: 0,
    },
    noul: {
      deletes_data: 0.5,
      discards_work: 0.5,
      outside_project: 0.5,
      system_change: 0.5,
      network_send: 0.5,
      privilege: 0.5,
    },
  },
};

const noopWrite = async (_row: CommandSafetyRow): Promise<void> => {};

/** Reads the guard a shadow was created with, failing loudly when it is absent. */
function guardOf(shadow: CommandShadow): GuardLike {
  const guard = (shadow as unknown as { guard?: { assess?: unknown } }).guard;
  if (guard === undefined || typeof guard.assess !== "function") {
    throw new Error("createCommandShadow did not expose a guard with an assess method for the guard option");
  }
  return guard as unknown as GuardLike;
}

/** The spec's guard fixture: createCommandShadow with a recording classify stub and the guard option. */
function guardFixture(
  answer: ModelResult,
  opts: { threshold?: number } = {},
): { shadow: CommandShadow; guard: GuardLike; classifyCalls: string[] } {
  const classifyCalls: string[] = [];
  const classify: Classify = (command: string) => {
    classifyCalls.push(command);
    return Promise.resolve(answer);
  };
  const shadow = createCommandShadow({
    classify,
    write: noopWrite,
    runId: "r1",
    timeoutMs: 1000,
    guard: { threshold: opts.threshold ?? GUARD_THRESHOLD },
  });
  return { shadow, guard: guardOf(shadow), classifyCalls };
}

/** The same fixture with a classifier that throws synchronously. */
function throwingClassifyFixture(): { shadow: CommandShadow; guard: GuardLike } {
  const shadow = createCommandShadow({
    classify: () => {
      throw new Error("classify exploded synchronously");
    },
    write: noopWrite,
    runId: "r1",
    timeoutMs: 1000,
    guard: { threshold: GUARD_THRESHOLD },
  });
  return { shadow, guard: guardOf(shadow) };
}

/**
 * `isTempOnly` — a NEW export this feature adds to the `@/command-safety`
 * barrel (src/command-safety/temp-only.ts). Loaded dynamically so a missing
 * module fails only the tests that use it.
 */
type IsTempOnly = (command: string, cwd: string | undefined) => boolean;
async function loadIsTempOnly(): Promise<IsTempOnly> {
  const barrel = (await import("@/command-safety")) as Record<string, unknown>;
  if (typeof barrel.isTempOnly !== "function") {
    throw new Error("isTempOnly is not exported from the @/command-safety barrel (expected src/command-safety/temp-only.ts)");
  }
  return barrel.isTempOnly as IsTempOnly;
}

// ─── US-004 runtime fixtures ──────────────────────────────────────────────────

/** A recording stub tool named Bash carrying the real Bash tool's scope; its run never spawns. */
function bashStub(): { tool: CodingTool; runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = [];
  const tool: CodingTool = {
    name: "Bash",
    description: "recording Bash stub",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [], commandField: "command" },
    run: async (input) => {
      runs.push(input);
      return { content: "ok" };
    },
  };
  return { tool, runs };
}

/** A recording stub for Read (pathFields like the real tool); its run never touches the disk. */
function readStub(): { tool: CodingTool; runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = [];
  const tool: CodingTool = {
    name: "Read",
    description: "recording Read stub",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: ["path"] },
    run: async (input) => {
      runs.push(input);
      return { content: "ok" };
    },
  };
  return { tool, runs };
}

const ALLOWED: PolicyVerdict = { allowed: true, resolvedPaths: [] };

/** A hand-rolled policy whose mechanical verdict the test controls exactly. */
function allowPolicy(root: string): ToolPolicy {
  return { root, grantedTools: () => ["Bash", "Read"], check: () => ALLOWED };
}
function denyPolicy(root: string): ToolPolicy {
  return {
    root,
    grantedTools: () => [],
    check: () => ({ allowed: false, reason: "denied by the stub policy", breach: false, outcome: "denied" }),
  };
}
function askPolicy(root: string): ToolPolicy {
  return {
    root,
    grantedTools: () => ["Bash"],
    check: () => ({
      allowed: false,
      reason: 'matched ask rule "Bash(ls)" — requires approval before it may run',
      breach: false,
      outcome: "ask",
      resolvedPaths: [],
      rule: "Bash(ls)",
    }),
  };
}

/** A guard whose assess records its input and resolves the given decision (or throws). */
function recordingGuard(
  decision: GuardDecisionLike | Error,
): { guard: unknown; assessCalls: GuardAssessInputLike[] } {
  const assessCalls: GuardAssessInputLike[] = [];
  const guard = {
    threshold: GUARD_THRESHOLD,
    assess: async (input: GuardAssessInputLike) => {
      assessCalls.push(input);
      if (decision instanceof Error) throw decision;
      return decision;
    },
  };
  return { guard, assessCalls };
}

/** A no-op command shadow carrying the given guard (guard key absent unless provided). */
function stubShadow(guard?: unknown): CommandShadow {
  const shadow: { observe: () => void; settle: () => void; drain: () => Promise<void>; guard?: unknown } = {
    observe: () => {},
    settle: () => {},
    drain: async () => {},
  };
  if (guard !== undefined) shadow.guard = guard;
  return shadow as unknown as CommandShadow;
}

/** An AskResolver stub that records every request it is asked to resolve. */
function recordingResolver(verdict: { decision: "allow" | "deny"; decidedBy: string; latencyMs: number }): {
  resolver: AskResolver;
  requests: AskRequest[];
} {
  const requests: AskRequest[] = [];
  const resolver: AskResolver = {
    resolve: async (req: AskRequest) => {
      requests.push(req);
      return {
        decision: verdict.decision,
        decidedBy: verdict.decidedBy as AskVerdict["decidedBy"],
        latencyMs: verdict.latencyMs,
      };
    },
  };
  return { resolver, requests };
}

/** A launcher that records the calls it was asked to run instead of running them. */
function stubLauncher(state: SandboxState): { launcher: CommandLauncher; runs: LaunchRequest[] } {
  const runs: LaunchRequest[] = [];
  return {
    runs,
    launcher: {
      state,
      run: async (req) => {
        runs.push(req);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          executed: req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv,
          sandbox: { backend: "none", wrapped: false },
        };
      },
    },
  };
}

// Temp-dir lifecycle for the few tests that need a real directory on disk.
const tempDirs: string[] = [];
function newTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop());
});

// ══════════════════════════════════════════════════════════════════════════════
// US-001 — rule set v3 and detectTmpWrite
// ══════════════════════════════════════════════════════════════════════════════

describe("command-safety-guard — rule set v3 (US-001)", () => {
  test("AC-1: git checkout of a dot-extension path hits discards_work", () => {
    expect(scoreRules("git checkout src/cli/approvals.ts").hits.discards_work).toBe(true);
  });

  test("AC-2: git checkout of a trailing-slash directory path hits discards_work", () => {
    expect(scoreRules("git checkout scripts/baselines/").hits.discards_work).toBe(true);
  });

  test("AC-3: git checkout HEAD of a dot-extension path hits discards_work", () => {
    expect(scoreRules("git checkout HEAD src/index.ts").hits.discards_work).toBe(true);
  });

  test("AC-4: a checkout path in the &&-joined second shell segment hits discards_work", () => {
    // The first segment alone never matches; the path must be found in its own segment.
    expect(scoreRules("bun test").hits.discards_work).toBe(false);
    expect(scoreRules("bun test && git checkout docs/guides/cli-reference.md").hits.discards_work).toBe(true);
  });

  test("AC-5: git restore of a non-flag path hits discards_work", () => {
    expect(scoreRules("git restore test/unit/config/schemas-review.test.ts").hits.discards_work).toBe(true);
  });

  test("AC-6: git restore with --staged AND --worktree hits discards_work", () => {
    expect(scoreRules("git restore --staged --worktree src/a.ts").hits.discards_work).toBe(true);
  });

  test("AC-7: git restore --staged without --worktree/-W does not hit discards_work", () => {
    expect(scoreRules("git restore --staged src/a.ts").hits.discards_work).toBe(false);
  });

  test("AC-8: git restore -S without --worktree/-W does not hit discards_work", () => {
    expect(scoreRules("git restore -S src/a.ts").hits.discards_work).toBe(false);
  });

  test("AC-9: git checkout -f hits discards_work despite a branch-name argument", () => {
    expect(scoreRules("git checkout -f main").hits.discards_work).toBe(true);
  });

  test("AC-10: git switch --discard-changes hits discards_work", () => {
    expect(scoreRules("git switch --discard-changes main").hits.discards_work).toBe(true);
  });

  test("AC-11: branch names, the -b form and a tag never match the checkout pattern", () => {
    for (const command of [
      "git checkout main",
      "git checkout feature/x",
      "git checkout -b feature/new",
      "git checkout release/v0.82.1",
      "git checkout v0.83.0",
    ]) {
      expect(scoreRules(command).hits.discards_work).toBe(false);
    }
  });

  test("AC-12: pattern matching never crosses ';' segments (later path cannot satisfy an earlier branch checkout)", () => {
    expect(scoreRules("git checkout main; ls src/").hits.discards_work).toBe(false);
  });

  test("AC-13: a later segment's --staged does not suppress an earlier git restore", () => {
    expect(scoreRules("git restore src/a.ts; git diff --staged").hits.discards_work).toBe(true);
  });

  test("AC-14: RULE_SET_VERSION is 3 and scoreRules reports version 3", () => {
    expect(RULE_SET_VERSION).toBe(3);
    expect(scoreRules("ls").version).toBe(3);
  });
});

describe("command-safety-guard — detectTmpWrite v3 (US-001)", () => {
  test("AC-15: a write to /tmp/nax-red-check is a tmp write (not all digits after nax-)", () => {
    expect(detectTmpWrite("echo x > /tmp/nax-red-check/a.txt")).toBe(true);
  });

  test("AC-16: a write under /private/tmp/nax-scratch is a tmp write", () => {
    expect(detectTmpWrite("cp a.txt /private/tmp/nax-scratch/a.txt")).toBe(true);
  });

  test("AC-17: the all-digit per-user fallback /tmp/nax-501 stays exempt", () => {
    expect(detectTmpWrite("echo x > /tmp/nax-501/r1/a.txt")).toBe(false);
  });

  test("AC-18: the shared nax parent /tmp/nax stays exempt", () => {
    expect(detectTmpWrite("echo x > /tmp/nax/r1/a.txt")).toBe(false);
  });

  test("AC-19: a trailing non-digit after the digits un-exempts /tmp/nax-501x", () => {
    expect(detectTmpWrite("echo x > /tmp/nax-501x/a.txt")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// US-002 — the isTempOnly predicate
// ══════════════════════════════════════════════════════════════════════════════

describe("command-safety-guard — isTempOnly (US-002)", () => {
  test("AC-20: the barrel re-exports isTempOnly and a confined temp destination is temp-only", async () => {
    const leaf = (await import("@/command-safety/temp-only")) as Record<string, unknown>;
    expect(typeof leaf.isTempOnly).toBe("function");
    const fromBarrel = await loadIsTempOnly();
    expect(fromBarrel).toBe(leaf.isTempOnly);
    expect(fromBarrel("cp src/a.ts /tmp/a.bak", "/repo/proj")).toBe(true);
  });

  test("AC-21: a temp READ alone satisfies the temp-path requirement", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat /tmp/out.txt", "/repo/proj")).toBe(true);
  });

  test("AC-22: an $TMPDIR redirect target with a ..-free remainder is a temp path", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("echo x > $TMPDIR/a.txt", "/repo/proj")).toBe(true);
  });

  test("AC-23: cd into a temp root counts as the required temp path", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cd /tmp/work && git init", "/repo/proj")).toBe(true);
  });

  test("AC-24: /private/tmp is accepted as a temp root", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat /private/tmp/x.log", "/repo/proj")).toBe(true);
  });

  test("AC-25: a --flag=value token is judged by its value; a cwd operand is allowed", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("bun build --outdir=/tmp/b src/a.ts", "/repo/proj")).toBe(true);
  });

  test("AC-26: a path under cwd plus a temp redirect target is temp-only", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat /repo/proj/src/a.ts > /tmp/x", "/repo/proj")).toBe(true);
  });

  test("AC-27: /dev/null is allowlisted and a later temp write satisfies the temp-path requirement", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("echo x > /dev/null; cp a.txt /tmp/b", "/repo/proj")).toBe(true);
  });

  test("AC-28: a bare word operand with no temp path anywhere is not temp-only", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("ls src", "/repo/proj")).toBe(false);
  });

  test("AC-29: a ~ path forces false despite a temp source", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cp /tmp/a ~/b", "/repo/proj")).toBe(false);
  });

  test("AC-30: a relative path resolving outside cwd is not temp-only", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat /tmp/a ../other/b", "/repo/proj")).toBe(false);
  });

  test("AC-31: an absolute path under neither temp root, cwd nor /dev is not temp-only", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat /etc/hosts > /tmp/x", "/repo/proj")).toBe(false);
  });

  test("AC-32: an opaque word other than $TMPDIR cannot be judged and returns false", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cp a.txt $OUT/x", "/repo/proj")).toBe(false);
  });

  test("AC-33: a heredoc the lexer refuses returns false even with a temp path", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat > /tmp/a.txt << 'EOF'\nx\nEOF", "/repo/proj")).toBe(false);
  });

  test("AC-34: an undefined cwd short-circuits to false before lexing", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cp a.txt /tmp/b", undefined)).toBe(false);
  });

  test("AC-35: an attached short-option value containing / cannot be judged", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("tar -C/etc -xf /tmp/a.tar", "/repo/proj")).toBe(false);
  });

  test("AC-36: a URL token cannot be judged and returns false", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("curl https://example.com/x -o /tmp/x", "/repo/proj")).toBe(false);
  });

  test("AC-37: a $TMPDIR/ remainder containing .. segments is not allowed", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat $TMPDIR/../../etc/x", "/repo/proj")).toBe(false);
  });

  test("AC-38: $TMPDIRX is not the accepted $TMPDIR form and returns false", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cat $TMPDIRX/a", "/repo/proj")).toBe(false);
  });

  test("AC-39: after an unresolvable cd target a relative path cannot be judged", async () => {
    const isTempOnly = await loadIsTempOnly();
    expect(isTempOnly("cd $D && cp a/b /tmp/x", "/repo/proj")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// US-003 — guard config, wiring and assess scoring
// ══════════════════════════════════════════════════════════════════════════════

describe("command-safety-guard — guard config and wiring (US-003)", () => {
  test("AC-40: guard parses with the 0.75 default threshold when shadow is present", () => {
    const parsed = CommandSafetyConfigSchema.parse({
      shadow: { url: "http://127.0.0.1:8020/x" },
      guard: {},
    }) as { guard?: { threshold: number } };
    expect(typeof parsed.guard).toBe("object");
    expect(parsed.guard?.threshold).toBe(0.75);
  });

  test("AC-41: a guard without a shadow fails with the reuse-classifier message", () => {
    const result = CommandSafetyConfigSchema.safeParse({ guard: { threshold: 0.6 } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for a guard without a shadow");
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      "commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)",
    );
  });

  test("AC-42: a threshold above 1 fails with a guard.threshold issue", () => {
    const result = CommandSafetyConfigSchema.safeParse({
      shadow: { url: "http://127.0.0.1:8020/x" },
      guard: { threshold: 1.5 },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for threshold 1.5");
    const onGuardThreshold = result.error.issues.some((issue) => {
      const segments = issue.path.map(String);
      return segments.includes("guard") && segments.includes("threshold");
    });
    expect(onGuardThreshold).toBe(true);
  });

  test("AC-43: a threshold of 0 fails with a guard.threshold issue", () => {
    const result = CommandSafetyConfigSchema.safeParse({
      shadow: { url: "http://127.0.0.1:8020/x" },
      guard: { threshold: 0 },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for threshold 0");
    const onGuardThreshold = result.error.issues.some((issue) => {
      const segments = issue.path.map(String);
      return segments.includes("guard") && segments.includes("threshold");
    });
    expect(onGuardThreshold).toBe(true);
  });

  test("AC-44: FIELD_DESCRIPTIONS documents both new guard keys with non-empty strings", () => {
    const guard = FIELD_DESCRIPTIONS["execution.commandSafety.guard"];
    const threshold = FIELD_DESCRIPTIONS["execution.commandSafety.guard.threshold"];
    expect(typeof guard).toBe("string");
    expect(guard.length).toBeGreaterThan(0);
    expect(typeof threshold).toBe("string");
    expect(threshold.length).toBeGreaterThan(0);
  });

  test("AC-45: guard is optional — a shadow-only config parses with guard strictly undefined", () => {
    const parsed = CommandSafetyConfigSchema.parse({
      shadow: { url: "http://127.0.0.1:8020/x" },
    }) as { guard?: unknown };
    expect(parsed.guard).toBeUndefined();
  });

  test("AC-46: buildCommandShadow without a guard option returns a shadow whose .guard is undefined", () => {
    const outputDir = newTempDir("cmd-guard-build-");
    const shadow = buildCommandShadow({
      config: {
        shadow: { url: "http://127.0.0.1:8020/x", timeoutMs: 3000, authEnv: "NAX_COMMAND_SAFETY_AUTH", allowRemote: false },
      },
      outputDir,
      runId: "r1",
      env: {},
    });
    expect(shadow).toBeDefined();
    expect((shadow as unknown as { guard?: unknown }).guard).toBeUndefined();
  });

  test("AC-47: buildDispatchAskWiring forwards the guard option to createCommandShadow", async () => {
    const outputDir = newTempDir("cmd-guard-wiring-");
    const config = makeNaxConfig({
      execution: {
        commandSafety: {
          shadow: {
            url: "http://127.0.0.1:8020/x",
            timeoutMs: 3000,
            authEnv: "NAX_COMMAND_SAFETY_AUTH",
            allowRemote: false,
          },
          guard: { threshold: 0.6 },
        },
      },
    });
    const wiring = await buildDispatchAskWiring({
      config,
      interaction: undefined,
      outputDir,
      runId: "run-1",
      repoRoot: "/repo",
      projectRoot: "/repo",
      featureName: "feat",
      stageModes: ["gated"],
    });
    try {
      expect(wiring.commandShadow).toBeDefined();
      const guard = (wiring.commandShadow as unknown as { guard?: { threshold?: number } }).guard;
      expect(guard).toBeDefined();
      expect(guard?.threshold).toBe(0.6);
    } finally {
      await wiring.dispose();
    }
  });
});

describe("command-safety-guard — guard.assess scoring (US-003)", () => {
  test("AC-48: high answer, no rule hit — flags on the model score with the top harm category", async () => {
    const { guard } = guardFixture(HIGH_ANSWER);
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("model");
    expect(Math.abs(decision.score - 0.9)).toBeLessThan(1e-9);
    expect(decision.category).toBe("discards_work");
  });

  test("AC-49: low answer, no rule hit — not flagged on the model score", async () => {
    const { guard } = guardFixture(LOW_ANSWER);
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(false);
    expect(decision.basis).toBe("model");
    expect(Math.abs(decision.score - 0.055)).toBeLessThan(1e-9);
  });

  test("AC-50: low answer but a rule hit — score 1, flagged, basis stays model", async () => {
    const { guard } = guardFixture(LOW_ANSWER);
    const decision = await guard.assess({ command: "git reset --hard", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("model");
    expect(decision.category).toBe("discards_work");
  });

  test("AC-51: classifier unavailable with a rule hit — rules-only flag with the rule category", async () => {
    const { guard } = guardFixture({ status: "unavailable", error: "timeout" });
    const decision = await guard.assess({ command: "git checkout src/a.ts", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBe("discards_work");
  });

  test("AC-52: classifier unavailable with no rule hit — not flagged, score 0, rules basis", async () => {
    const { guard } = guardFixture({ status: "unavailable", error: "timeout" });
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBeUndefined();
  });

  test("AC-53: an oversize result behaves like unavailable — rules-only, not flagged", async () => {
    const { guard } = guardFixture({ status: "oversize", latencyMs: 1 });
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBeUndefined();
  });

  test("AC-54: a blocked result scores 1, flags on the model basis, with no category key", async () => {
    const { guard } = guardFixture({ status: "blocked", latencyMs: 1 });
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("model");
    expect("category" in decision).toBe(false);
  });

  test("AC-55: a synchronously throwing classifier fulfills as rules-only, never rejects", async () => {
    const { guard } = throwingClassifyFixture();
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("rules");
  });

  test("AC-56: a confined temp-only command skips the classifier entirely", async () => {
    const { guard, classifyCalls } = guardFixture(HIGH_ANSWER);
    const decision = await guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: "/repo/proj", tempConfined: true });
    expect(decision.flagged).toBe(false);
    expect(decision.score).toBe(0);
    expect(decision.basis).toBe("temp-only");
    expect(classifyCalls).toHaveLength(0);
  });

  test("AC-57: a confined temp-only command with a non-outside_project rule hit still flags", async () => {
    const { guard } = guardFixture(LOW_ANSWER);
    const decision = await guard.assess({ command: "rm -rf /tmp/x", cwd: "/repo/proj", tempConfined: true });
    expect(decision.flagged).toBe(true);
    expect(decision.score).toBe(1);
    expect(decision.basis).toBe("temp-only");
    expect(decision.category).toBe("deletes_data");
  });

  test("AC-58: not confined, the same command reaches the classifier exactly once", async () => {
    const { guard, classifyCalls } = guardFixture(HIGH_ANSWER);
    const decision = await guard.assess({ command: "cp src/a.ts /tmp/a.bak", cwd: "/repo/proj", tempConfined: false });
    expect(decision.basis).toBe("model");
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]).toBe("cp src/a.ts /tmp/a.bak");
  });

  test("AC-59: observe then assess classifies one command exactly once (shared classify cache)", async () => {
    const { shadow, guard, classifyCalls } = guardFixture(LOW_ANSWER);
    const obs: Observation = {
      command: "bun run test",
      identity: "Bash",
      stage: "run",
      mechanical: { verdict: "allow", breach: false },
    };
    shadow.observe("k1", obs);
    await guard.assess({ command: "bun run test", cwd: "/repo/proj", tempConfined: false });
    expect(classifyCalls).toHaveLength(1);
    await shadow.drain();
  });

  test("AC-60: a score exactly equal to the threshold flags", async () => {
    const { guard } = guardFixture(HALF_ANSWER, { threshold: 0.5 });
    const decision = await guard.assess({ command: "ls", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(Math.abs(decision.score - 0.5)).toBeLessThan(1e-9);
  });

  test("AC-61: createCommandShadow without a guard option returns a shadow whose .guard is undefined", () => {
    const shadow = createCommandShadow({ classify: async () => LOW_ANSWER, write: noopWrite, runId: "r1", timeoutMs: 1000 });
    expect((shadow as unknown as { guard?: unknown }).guard).toBeUndefined();
  });

  test("AC-62: the category is the first hit in QUESTION_IDS order (discards_work before privilege)", async () => {
    const { guard } = guardFixture({ status: "unavailable", error: "timeout" });
    const decision = await guard.assess({ command: "sudo git reset --hard", cwd: "/repo/proj", tempConfined: false });
    expect(decision.flagged).toBe(true);
    expect(decision.basis).toBe("rules");
    expect(decision.category).toBe("discards_work");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// US-004 — the runtime turns a flagged allowed call into an ask
// ══════════════════════════════════════════════════════════════════════════════

describe("command-safety-guard — runtime ask wiring (US-004)", () => {
  test("AC-63: a flagged call with no approval channel is refused before the tool runs", async () => {
    const bash = bashStub();
    const { guard } = recordingGuard({
      flagged: true,
      score: 0.9,
      threshold: 0.75,
      basis: "model",
      category: "discards_work",
    });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });
    if (result.kind !== "denied") throw new Error(`expected denial, got ${result.kind}`);
    expect(result.reason.includes("flagged for review by command safety: discards_work (score 0.90 >= 0.75)")).toBe(
      true,
    );
    expect(result.reason.includes("no approval channel is configured")).toBe(true);
    expect(bash.runs).toHaveLength(0);
  });

  test("AC-64: an approving resolver runs the tool and records the command-safety ask", async () => {
    const bash = bashStub();
    const { guard } = recordingGuard({ flagged: true, score: 0.9, threshold: 0.75, basis: "model", category: "discards_work" });
    const { resolver, requests } = recordingResolver({ decision: "allow", decidedBy: "test", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });
    expect(result.kind).toBe("ok");
    expect(bash.runs).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.rule).toBe("command-safety");
    expect(requests[0]?.command).toBe("git checkout src/a.ts");
  });

  test("AC-65: a denying resolver refuses the flagged call and the tool never runs", async () => {
    const bash = bashStub();
    const { guard } = recordingGuard({ flagged: true, score: 0.9, threshold: 0.75, basis: "model", category: "discards_work" });
    const { resolver } = recordingResolver({ decision: "deny", decidedBy: "human", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });
    expect(result.kind).toBe("denied");
    expect(bash.runs).toHaveLength(0);
  });

  test("AC-66: a not-flagged call runs the tool and never opens the ask channel", async () => {
    const bash = bashStub();
    const { guard } = recordingGuard({ flagged: false });
    const { resolver, requests } = recordingResolver({ decision: "allow", decidedBy: "test", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(bash.runs).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  test("AC-67: a policy denial never consults the guard", async () => {
    const bash = bashStub();
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const runtime = createCodingToolRuntime({
      policy: denyPolicy("/repo/proj"),
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.reason).toContain("denied by the stub policy");
    expect(assessCalls).toHaveLength(0);
  });

  test("AC-68: a policy ask verdict resolves through the resolver without consulting the guard", async () => {
    const bash = bashStub();
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const { resolver, requests } = recordingResolver({ decision: "allow", decidedBy: "test", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: askPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    await runtime.callTool("Bash", { command: "ls" });
    expect(assessCalls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.rule !== "command-safety").toBe(true);
  });

  test("AC-69: an allowed Read call never reaches the guard", async () => {
    const read = readStub();
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      commandShadow: stubShadow(guard),
      extraTools: [read.tool],
    });
    const result = await runtime.callTool("Read", { path: "a.txt" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toHaveLength(0);
  });

  test("AC-70: a commandShadow without a guard runs the allowed call with no ask synthesis", async () => {
    const bash = bashStub();
    const { resolver, requests } = recordingResolver({ decision: "allow", decidedBy: "test", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(bash.runs).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  test("AC-71: tempConfined: true reaches guard.assess verbatim with the policy root as cwd", async () => {
    const bash = bashStub();
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const policy = allowPolicy("/repo/proj");
    const runtime = createCodingToolRuntime({
      policy,
      commandShadow: stubShadow(guard),
      tempConfined: true,
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toEqual([{ command: "ls", cwd: "/repo/proj", tempConfined: true }]);
  });

  test("AC-72: an absent tempConfined option reads as false", async () => {
    const bash = bashStub();
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const policy = allowPolicy("/repo/proj");
    const runtime = createCodingToolRuntime({
      policy,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    const result = await runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0]?.command).toBe("ls");
    expect(assessCalls[0]?.cwd).toBe(policy.root);
    expect(assessCalls[0]?.tempConfined).toBe(false);
  });

  test("AC-73: the real guard on a flagged command denies headlessly and classifies exactly once", async () => {
    const classifyCalls: string[] = [];
    const classify: Classify = (command: string) => {
      classifyCalls.push(command);
      return Promise.resolve(LOW_ANSWER);
    };
    const shadow = createCommandShadow({
      classify,
      write: noopWrite,
      runId: "r1",
      timeoutMs: 1000,
      guard: { threshold: GUARD_THRESHOLD },
    });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      commandShadow: shadow,
      extraTools: [bashStub().tool],
    });
    try {
      const result = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });
      expect(result.kind).toBe("denied");
      expect(classifyCalls).toContain("git checkout src/a.ts");
      expect(classifyCalls).toHaveLength(1);
    } finally {
      await shadow.drain();
    }
  });

  test("AC-74: a rejecting guard runs the call unguarded and warns once on the command-safety stage", async () => {
    const bash = bashStub();
    const { guard } = recordingGuard(new Error("boom"));
    const { resolver, requests } = recordingResolver({ decision: "allow", decidedBy: "test", latencyMs: 1 });
    const runtime = createCodingToolRuntime({
      policy: allowPolicy("/repo/proj"),
      askResolver: resolver,
      commandShadow: stubShadow(guard),
      extraTools: [bash.tool],
    });
    await withWarnSpy(async (warnSpy) => {
      const result = await runtime.callTool("Bash", { command: "ls" });
      expect(result.kind).toBe("ok");
      expect(bash.runs).toHaveLength(1);
      expect(warnSpy.mock.calls).toHaveLength(1);
      const entry = warnSpy.mock.calls[0];
      expect(entry?.[0]).toBe("command-safety");
      expect(entry?.[1]).toBe("Command-safety guard failed; the call runs unguarded");
      expect(JSON.stringify(entry?.[2] ?? {})).toContain("boom");
      expect(requests).toHaveLength(0);
    });
  });

  test("AC-75: a RunCommand argv call takes the Exec identity and receives the joined command", async () => {
    const exec = { repoRoot: "/repo", packageWorkdir: "/repo", allowScripts: false, patterns: ["bun add*"] };
    const { guard, assessCalls } = recordingGuard({
      flagged: true,
      score: 1,
      threshold: 0.75,
      basis: "rules",
      category: "discards_work",
    });
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], "/repo"),
      commandShadow: stubShadow(guard),
      extraTools: [createRunCommandTool(new Map<string, string>(), { exec })],
    });
    const result = await runtime.callTool("RunCommand", { argv: ["git", "checkout", "src/a.ts"] });
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0]?.command).toBe("git checkout src/a.ts");
    expect(result.kind).toBe("denied");
  });
});

describe("command-safety-guard — temp confinement threading (US-004)", () => {
  /** The spec's buildCodingToolSupport fixture: raw declared Bash, stub launcher, recording guard. */
  function supportFixture(state: SandboxState): {
    support: NonNullable<ReturnType<typeof buildCodingToolSupport>>;
    assessCalls: GuardAssessInputLike[];
  } {
    const root = newTempDir("cmd-guard-support-");
    const { guard, assessCalls } = recordingGuard({ flagged: false });
    const launcher = stubLauncher(state);
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      bashApproval: "raw",
      launcher: launcher.launcher,
      commandShadow: stubShadow(guard),
    });
    if (support === undefined) throw new Error("expected coding-tool support for a raw Bash grant");
    return { support, assessCalls };
  }

  test("AC-76: an available launcher with sharedTmp false is temp-confined", async () => {
    const { support, assessCalls } = supportFixture({
      kind: "available",
      backend: "srt",
      network: "open",
      sharedTmp: false,
    });
    const result = await support.runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0]?.command).toBe("ls");
    expect(assessCalls[0]?.tempConfined).toBe(true);
  });

  test("AC-77: an available launcher without sharedTmp is not temp-confined", async () => {
    const { support, assessCalls } = supportFixture({ kind: "available", backend: "srt", network: "open" });
    const result = await support.runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0]?.tempConfined).toBe(false);
  });

  test("AC-78: a disabled launcher is not temp-confined", async () => {
    const { support, assessCalls } = supportFixture(DISABLED_SANDBOX_STATE);
    const result = await support.runtime.callTool("Bash", { command: "ls" });
    expect(result.kind).toBe("ok");
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0]?.tempConfined).toBe(false);
  });
});