import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _repairDeps,
  activateRunState,
  activeKeepers,
  type RunStateHandle,
  repairRunState,
  unregisterKeeper,
} from "@/runstate";
import { runStateWrite } from "@/runstate/store";
import { gitWithTimeout } from "@/utils/git";

const PRD = ".nax/features/f/prd.json";
const NAX_PRD = '{"stories":"nax"}';
let dir: string;
let handle: RunStateHandle | undefined;

/** nax's own write: recorded by the keeper (Task 8 later routes the real writers through runStateWrite). */
async function naxWrite(path: string, content: string): Promise<void> {
  await runStateWrite(path, { content }, async () => {
    await Bun.write(path, content);
  });
}
const warnings: { message: string; data?: Record<string, unknown> }[] = [];
const origLogger = _repairDeps.logger;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

beforeEach(async () => {
  dir = makeTempDir();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
  ])
    await git(...args);
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  writeFileSync(join(dir, PRD), '{"stories":"seed"}');
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  _repairDeps.logger = () => ({
    warn: (_s: string, message: string, data?: Record<string, unknown>) => warnings.push({ message, data }),
  });
  handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
  await naxWrite(join(dir, PRD), NAX_PRD);
});

afterEach(() => {
  handle?.deactivate();
  for (const k of activeKeepers()) unregisterKeeper(k);
  _repairDeps.logger = origLogger;
  warnings.length = 0;
  cleanupTempDir(dir);
});

const ctx = { trigger: "turn" as const, storyId: "US-002", sessionName: "s1", stage: "implementer", turn: 3 };

describe("repairRunState (#2497)", () => {
  test("restores a reverted file and warns with session, step and turn", async () => {
    await git("checkout", "--", PRD);
    const records = await repairRunState(ctx);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
    expect(records).toEqual([{ path: join(dir, PRD), rel: PRD, damage: ["modified"], restored: true }]);
    expect(warnings[0]?.message).toBe(`US-002 implementer turn 3: ${PRD} modified by the agent; restored`);
    expect(Object.keys(warnings[0]?.data ?? {})[0]).toBe("storyId");
  });

  test("recreates a deleted feature directory", async () => {
    rmSync(join(dir, ".nax/features/f"), { recursive: true, force: true });
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["missing"]);
    expect(await Bun.file(join(dir, PRD)).text()).toBe(NAX_PRD);
  });

  test("clears skip-worktree on a tracked file", async () => {
    await git("update-index", "--skip-worktree", PRD);
    const records = await repairRunState(ctx);
    expect(records[0]?.damage).toEqual(["hidden"]);
    expect(await git("ls-files", "-v", "--", PRD)).toMatch(/^H /);
  });

  test("an intact file is not reported", async () => {
    expect(await repairRunState(ctx)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a file being written by nax is skipped", async () => {
    const keeper = activeKeepers()[0];
    keeper?.begin(join(dir, PRD));
    await git("checkout", "--", PRD);
    expect(await repairRunState(ctx)).toEqual([]);
    keeper?.end(join(dir, PRD));
  });

  test("a workflow ledger tracked under the root gets one repair line", async () => {
    const ledger = join(dir, ".nax/features/f/workflow/run-1/ledger.md");
    mkdirSync(join(dir, ".nax/features/f/workflow/run-1"), { recursive: true });
    await naxWrite(ledger, "# Workflow ledger\n");
    await git("checkout", "--", PRD);
    await repairRunState(ctx);
    expect(await Bun.file(ledger).text()).toBe(`# Workflow ledger\nUS-002: run-state repaired: ${PRD} (modified)\n`);
    expect(await repairRunState(ctx)).toEqual([]); // the ledger line is nax's own write, never flagged
  });

  test("a nax write recorded while the repair awaits git is not reverted", async () => {
    const origHidden = _repairDeps.hiddenNaxPaths;
    _repairDeps.hiddenNaxPaths = async (workdir, logger) => {
      await naxWrite(join(dir, PRD), '{"stories":"newer"}');
      return origHidden(workdir, logger);
    };
    const records = await repairRunState(ctx);
    _repairDeps.hiddenNaxPaths = origHidden;
    expect(records).toEqual([]);
    expect(await Bun.file(join(dir, PRD)).text()).toBe('{"stories":"newer"}');
  });

  test("a hidden file whose flag could not be cleared is not reported restored", async () => {
    await git("update-index", "--skip-worktree", PRD);
    const origClear = _repairDeps.clearNaxIndexFlags;
    _repairDeps.clearNaxIndexFlags = async () => [];
    const records = await repairRunState(ctx);
    _repairDeps.clearNaxIndexFlags = origClear;
    expect(records[0]?.restored).toBe(false);
  });

  test("a failing ledger note keeps the repair records", async () => {
    const ledger = join(dir, ".nax/features/f/workflow/run-1/ledger.md");
    mkdirSync(join(dir, ".nax/features/f/workflow/run-1"), { recursive: true });
    await naxWrite(ledger, "# Workflow ledger\n");
    rmSync(join(dir, ".nax/features/f/workflow"), { recursive: true, force: true });
    writeFileSync(join(dir, ".nax/features/f/workflow"), "not a directory");
    await git("checkout", "--", PRD);
    const records = await repairRunState(ctx);
    expect(records.some((r) => r.rel === PRD && r.restored)).toBe(true);
  });

  test("never rejects when git fails; falls back to the flag sweep with no keeper", async () => {
    const origHidden = _repairDeps.hiddenNaxPaths;
    _repairDeps.hiddenNaxPaths = async () => {
      throw new Error("git gone");
    };
    await expect(repairRunState(ctx)).resolves.toEqual([]);
    _repairDeps.hiddenNaxPaths = origHidden;

    handle?.deactivate();
    const swept: string[] = [];
    const origClear = _repairDeps.clearNaxIndexFlags;
    _repairDeps.clearNaxIndexFlags = async (workdir) => {
      swept.push(workdir);
      return [];
    };
    await repairRunState({ trigger: "run-end", workdir: dir });
    _repairDeps.clearNaxIndexFlags = origClear;
    expect(swept).toEqual([dir]);
  });

  describe("the .nax flag sweep with a keeper active (#2490)", () => {
    const SPEC = ".nax/features/f/spec.md";
    async function hideSpec(): Promise<void> {
      writeFileSync(join(dir, SPEC), "spec");
      await git("add", "-f", SPEC);
      await git("commit", "-q", "-m", "spec");
      await git("update-index", "--skip-worktree", SPEC);
    }
    const tag = async (): Promise<string> => (await git("ls-files", "-v", "--", SPEC)).slice(0, 2);

    test("run-end clears flags on files the keeper does not hold", async () => {
      await hideSpec();
      expect(await tag()).toBe("S ");
      await repairRunState({ trigger: "run-end", workdir: dir });
      expect(await tag()).toBe("H ");
    });

    test("crash clears them too", async () => {
      await hideSpec();
      await repairRunState({ trigger: "crash", workdir: dir });
      expect(await tag()).toBe("H ");
    });

    test("a turn repair leaves them (scope of the per-turn check)", async () => {
      await hideSpec();
      await repairRunState({ trigger: "turn", workdir: dir });
      expect(await tag()).toBe("S ");
    });
  });
});
