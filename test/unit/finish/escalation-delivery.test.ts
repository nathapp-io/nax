/**
 * Regression tests for the escalation-delivery defects found reviewing the
 * native finish port against `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md`.
 *
 * Each test here fails against the code as merged in #1630 — they are written
 * to pin behaviour the port lost relative to the acpx plugin it replaced, so a
 * later change that reintroduces the loss is caught rather than shipped.
 *
 * - The result file must exist *before* delivery is attempted (#1399): the one
 *   path whose job is to say a human is needed was the one path with no
 *   fallback, and an external kill mid-delivery must not erase the trail.
 * - An aborted run must not push a commit or post to the forge. Cancelling is
 *   not an escalation; the trail is still written so the run is auditable.
 * - A `writeResult` failure must not deliver the escalation twice.
 * - CRITICAL, found reviewing #1675 (#1674 part 1): an escalation that was
 *   never DELIVERED must never update the finish ledger — otherwise a later
 *   run at the same HEAD silently skips (`already-finished`) and the human's
 *   page is lost forever. `escalation-delivery` describe block below covers
 *   every way delivery can fail to happen (undelivered, run-aborted, no forge
 *   detected) and pins the one case where it legitimately does deliver.
 */
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AcceptanceGroupResult, ResolveResult } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import type { AuditTarget, FinishContext, FinishMachineDeps, FinishOps, FinishState } from "@/finish";
import {
  _acceptanceGateDeps,
  _finishContextDeps,
  _finishGitDeps,
  _qualityGateDeps,
  createFinishState,
  loadFinishContext,
  readLedger,
  runFinishMachine,
} from "@/finish";

const originalGit = _finishGitDeps.git;
const originalContextGit = _finishContextDeps.git;
const originalAcceptanceRun = _acceptanceGateDeps.run;
const originalQuality = { ..._qualityGateDeps };
afterEach(() => {
  _finishGitDeps.git = originalGit;
  _finishContextDeps.git = originalContextGit;
  _acceptanceGateDeps.run = originalAcceptanceRun;
  _qualityGateDeps.run = originalQuality.run;
  _qualityGateDeps.loadConfig = originalQuality.loadConfig;
  _qualityGateDeps.loadPackageOverride = originalQuality.loadPackageOverride;
});

/**
 * Points `_finishContextDeps.git` (context.ts's own git seam, distinct from
 * `_finishGitDeps` above which machine.ts/commit.ts use) at a fixed HEAD, so
 * a post-escalation `loadFinishContext` call can check whether the ledger's
 * entry check now fires for it.
 */
function stubContextGitAtHead(sha: string): void {
  _finishContextDeps.git = async (args: string[]) => {
    if (args[0] === "remote" && args[1] === "show") return { stdout: "  HEAD branch: main\n", stderr: "", exitCode: 0 };
    if (args[0] === "rev-list") return { stdout: "1\n", stderr: "", exitCode: 0 };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${sha}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function baseContext(overrides: Partial<FinishContext> = {}): FinishContext {
  const group: AcceptanceGroupResult = {
    packageDir: "",
    testPath: "test/acceptance/feat.test.ts",
    exists: true,
    cwd: "",
  };
  return {
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
    acceptanceStatus: "ok",
    groups: [group],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
    ...overrides,
  };
}

function baseState(): FinishState {
  return createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
}

function installStubs(trail: string[]): void {
  _finishGitDeps.git = async (args: string[]) => {
    if (args[0] === "rev-parse") return { stdout: "sha1", stderr: "", exitCode: 0 };
    if (args[0] === "status") return { stdout: " M file.ts\n", stderr: "", exitCode: 0 };
    if (args[0] === "commit") trail.push("commit");
    if (args[0] === "push") trail.push("push");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  _acceptanceGateDeps.run = async () => ({
    commandName: "acceptance",
    command: "bun test",
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
  });
  _qualityGateDeps.loadConfig = async () => DEFAULT_CONFIG;
  _qualityGateDeps.loadPackageOverride = async () => null;
}

function makeOps(trail: string[], overrides: Partial<FinishOps> = {}): FinishOps {
  return {
    review: async (phase) => {
      trail.push(`review:${phase}`);
      return { findings: [], gaps: [] };
    },
    fix: async () => ({}),
    openDraftPr: async () => null,
    promotePr: async () => ({ status: "opened" as const }),
    escalate: async () => {
      trail.push("escalate");
      return {};
    },
    ...overrides,
  };
}

function makeDeps(opts: {
  auditDir: string;
  ops?: Partial<FinishOps>;
  context?: Partial<FinishContext>;
  signal?: AbortSignal;
  runSignal?: AbortSignal;
}): { deps: FinishMachineDeps; trail: string[] } {
  const trail: string[] = [];
  installStubs(trail);
  const audit: AuditTarget = { auditDir: opts.auditDir, runId: "run-1" };
  let tick = 0;
  return {
    trail,
    deps: {
      context: baseContext(opts.context),
      ops: makeOps(trail, opts.ops),
      audit,
      signal: opts.signal,
      runSignal: opts.runSignal,
      now: () => {
        tick += 1;
        return `2026-08-20T00:00:${String(tick).padStart(2, "0")}.000Z`;
      },
    },
  };
}

test("the escalation result file is written before delivery is attempted (#1399)", async () => {
  await withTempDir(async (dir) => {
    let resultOnDiskDuringDelivery: string | null = null;
    const { deps } = makeDeps({
      auditDir: dir,
      context: { route: "escalate", reason: "context could not be resolved" },
      ops: {
        escalate: async () => {
          resultOnDiskDuringDelivery = await readFile(join(dir, "run-1.result.json"), "utf8").catch(() => null);
          return {};
        },
      },
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(resultOnDiskDuringDelivery).not.toBeNull();
    expect(JSON.parse(resultOnDiskDuringDelivery ?? "{}").status).toBe("escalated");
  });
});

test("the delivered url and deliveryError still land in the final result file", async () => {
  await withTempDir(async (dir) => {
    const { deps } = makeDeps({
      auditDir: dir,
      context: { route: "escalate", reason: "needs a human" },
      ops: { escalate: async () => ({ url: "https://forge.example/pr/9", deliveryError: "comment rejected" }) },
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.url).toBe("https://forge.example/pr/9");
    expect(result.deliveryError).toBe("comment rejected");
    const onDisk = JSON.parse(await readFile(join(dir, "run-1.result.json"), "utf8"));
    expect(onDisk.url).toBe("https://forge.example/pr/9");
    expect(onDisk.deliveryError).toBe("comment rejected");
  });
});

test("an aborted run records the escalation but never delivers it", async () => {
  await withTempDir(async (dir) => {
    const runController = new AbortController();
    runController.abort();
    const { deps, trail } = makeDeps({
      auditDir: dir,
      signal: runController.signal,
      runSignal: runController.signal,
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    // No delivery, and specifically no push and no forge write.
    expect(trail).not.toContain("escalate");
    expect(trail).not.toContain("push");
    expect(result.deliveryError).toMatch(/abort/i);
    // The trail still exists for a human to read.
    const onDisk = JSON.parse(await readFile(join(dir, "run-1.result.json"), "utf8"));
    expect(onDisk.status).toBe("escalated");

    // CRITICAL (post-#1675 review): an aborted, undelivered escalation must
    // NOT update the ledger — the human was never actually paged, so a later
    // run at the same HEAD must not silently skip and lose that page.
    expect(await readLedger(dir)).toBeNull();
  });
});

test("an undelivered escalation (deliveryError, no url) does not update the ledger, so a re-run does not skip", async () => {
  await withTempDir(async (dir) => {
    const { deps } = makeDeps({
      auditDir: dir,
      context: { route: "escalate", reason: "needs a human" },
      ops: { escalate: async () => ({ deliveryError: "comment rejected" }) },
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(result.deliveryError).toBe("comment rejected");
    expect(await readLedger(dir)).toBeNull();

    // A second finish attempt at the identical HEAD must still see this as
    // work to do — the ledger must not report "already-finished".
    stubContextGitAtHead("sha1");
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      status: "ok",
      featureName: "feat",
      specSource: { kind: "markdown", path: ".nax/features/feat/spec.md" },
      acceptance: { status: "ok", enabled: true, groups: [] },
      testPatterns: { regex: [], resolution: "detected" },
      message: "resolved",
    });
    const ctx = await loadFinishContext("feat", "/repo", { branch: "feat/x", auditDir: dir, rerun: "on-change" });
    expect(ctx.route).not.toBe("already-finished");
  });
});

test("forgeKind === null ('no forge detected') does not update the ledger", async () => {
  await withTempDir(async (dir) => {
    const { deps } = makeDeps({
      auditDir: dir,
      context: { route: "escalate", reason: "needs a human" },
      ops: { escalate: async () => ({ deliveryError: "no forge detected" }) },
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(result.deliveryError).toBe("no forge detected");
    expect(await readLedger(dir)).toBeNull();
  });
});

test("a DELIVERED escalation (url, no deliveryError) DOES update the ledger, and a re-run at the same HEAD skips", async () => {
  await withTempDir(async (dir) => {
    const { deps } = makeDeps({
      auditDir: dir,
      context: { route: "escalate", reason: "needs a human" },
      ops: { escalate: async () => ({ url: "https://forge.example/pr/9" }) },
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(result.url).toBe("https://forge.example/pr/9");
    expect(result.deliveryError).toBeUndefined();
    const ledger = await readLedger(dir);
    expect(ledger).not.toBeNull();
    expect(ledger?.status).toBe("escalated");
    expect(ledger?.prUrl).toBe("https://forge.example/pr/9");

    stubContextGitAtHead("sha1");
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      status: "ok",
      featureName: "feat",
      specSource: { kind: "markdown", path: ".nax/features/feat/spec.md" },
      acceptance: { status: "ok", enabled: true, groups: [] },
      testPatterns: { regex: [], resolution: "detected" },
      message: "resolved",
    });
    const ctx = await loadFinishContext("feat", "/repo", { branch: "feat/x", auditDir: dir, rerun: "on-change" });
    expect(ctx.route).toBe("already-finished");
  });
});

test("a phase-deadline abort still delivers — only a run abort suppresses delivery", async () => {
  await withTempDir(async (dir) => {
    const deadline = new AbortController();
    deadline.abort();
    const { deps, trail } = makeDeps({
      auditDir: dir,
      // The phase signal fired, but the run's own signal did not.
      signal: deadline.signal,
      runSignal: new AbortController().signal,
    });

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(trail).toContain("escalate");
  });
});

test("a writeResult failure does not deliver the escalation twice", async () => {
  await withTempDir(async (dir) => {
    let deliveries = 0;
    const { deps } = makeDeps({
      auditDir: join(dir, "audit"),
      context: { route: "escalate", reason: "needs a human" },
      ops: {
        escalate: async () => {
          deliveries += 1;
          return {};
        },
      },
    });
    // A path that cannot be created: `file` is a regular file, so mkdir -p under
    // it fails, and every writeResult in this run throws.
    await Bun.write(join(dir, "audit"), "not a directory");

    const result = await runFinishMachine(baseState(), deps);

    expect(result.status).toBe("escalated");
    expect(deliveries).toBe(1);
  });
});
