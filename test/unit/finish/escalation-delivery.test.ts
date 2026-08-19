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
 */
import { afterEach, expect, test } from "bun:test";
import type { AcceptanceGroupResult } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import { _acceptanceGateDeps, _finishGitDeps, _qualityGateDeps, createFinishState, runFinishMachine } from "@/finish";
import type { AuditTarget, FinishContext, FinishMachineDeps, FinishOps, FinishState } from "@/finish";
import { withTempDir } from "@test/helpers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const originalGit = _finishGitDeps.git;
const originalAcceptanceRun = _acceptanceGateDeps.run;
const originalQuality = { ..._qualityGateDeps };
afterEach(() => {
  _finishGitDeps.git = originalGit;
  _acceptanceGateDeps.run = originalAcceptanceRun;
  _qualityGateDeps.run = originalQuality.run;
  _qualityGateDeps.loadConfig = originalQuality.loadConfig;
  _qualityGateDeps.loadPackageOverride = originalQuality.loadPackageOverride;
});

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
