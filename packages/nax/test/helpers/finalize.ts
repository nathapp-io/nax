import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _featureDeps } from "@/workflow/feature-deps";
import { _workflowDeps } from "@/workflow/step-context";
import { makeAdviceDecision } from "./advice";
export function makeFinalizeAdvisor(approve: boolean, asked: string[] = []): Advisor {
  return {
    advise: async (q) => {
      asked.push(q.kind);
      return {
        decision: makeAdviceDecision({
          action: approve ? { type: "approve" } : { type: "hold", reason: "r" },
          rationale: approve ? "clean" : "risky",
        }),
      };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
}

type PromoteKept = { status: "draft" | "already-ready"; url?: string };
type PromoteReady = { status: "opened" | "promoted" | "already-ready"; url?: string };

interface Call {
  name: string;
  arg?: unknown;
  keepDraft?: boolean;
  body?: string;
  message?: string;
  skipCommit?: boolean;
}

interface WireOpts {
  ci?: "green" | "failed" | "pending";
  pushFails?: boolean;
  promoteThrows?: boolean;
  alreadyReady?: boolean;
  onCi?: () => void;
  /** Per-call `commitLedger` results; the queue falls back to `true` (a commit was made). */
  ledger?: readonly boolean[];
  /** 1-based `commitLedger` call that throws instead of answering (a locked index, a missing git). */
  ledgerThrowsAt?: number;
  /**
   * What `_workflowDeps.resolveFeatureSpec` answers (US-007): `{ path }` for a resolved spec, `null`
   * for no spec source, an Error to reject. Absent leaves the real resolver wired.
   */
  spec?: { path: string } | null | Error;
}

/** Wires every forge-side dep; returns the call log. */
export function wireFinalize(opts: WireOpts = {}) {
  const calls: Call[] = [];
  const ledgerResults = [...(opts.ledger ?? [])];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async (projectDir, feature) => {
    calls.push({ name: "ledger", arg: [projectDir, feature] });
    if (opts.ledgerThrowsAt === calls.filter((c) => c.name === "ledger").length) throw new Error("index.lock exists");
    return ledgerResults.shift() ?? true;
  };
  _featureDeps.commitAndPush = async (repoRoot, branch, message, pushOpts) => {
    calls.push({ name: "push", arg: [repoRoot, branch], message, skipCommit: pushOpts?.skipCommit ?? false });
    if (opts.pushFails) throw new Error("rejected: non-fast-forward");
    return { committed: false, pushed: true };
  };
  _featureDeps.openDraftFinishPr = async (args) => {
    calls.push({ name: "draft", arg: args.body });
    return { url: "https://gh/pr/7" };
  };
  _featureDeps.waitForChecks = async () => {
    calls.push({ name: "ci" });
    opts.onCi?.();
    return { outcome: opts.ci ?? "pending", detail: "d" };
  };
  async function fakePromote(args: OpenOrPromoteArgs & { keepDraft: true }, deps: ForgeDeps): Promise<PromoteKept>;
  async function fakePromote(args: OpenOrPromoteArgs & { keepDraft?: false }, deps: ForgeDeps): Promise<PromoteReady>;
  async function fakePromote(args: OpenOrPromoteArgs, deps: ForgeDeps): Promise<PromoteKept | PromoteReady>;
  async function fakePromote(args: OpenOrPromoteArgs): Promise<PromoteKept | PromoteReady> {
    calls.push({ name: "promote", keepDraft: args.keepDraft, body: args.body });
    if (opts.promoteThrows) throw new Error("gh edit failed");
    if (opts.alreadyReady && args.keepDraft) return { status: "already-ready", url: "https://gh/pr/7" };
    return args.keepDraft
      ? { status: "draft", url: "https://gh/pr/7" }
      : { status: "promoted", url: "https://gh/pr/7" };
  }
  _featureDeps.openOrPromotePr = fakePromote;
  _workflowDeps.readTrustedDecisions = async () => [];
  // A clean tree by default: an unreadable one is a readiness reason now (nax#2550).
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  if (opts.spec !== undefined) {
    const spec = opts.spec;
    _workflowDeps.resolveFeatureSpec = async () => {
      if (spec instanceof Error) throw spec;
      return { specSource: spec };
    };
  }
  return calls;
}
