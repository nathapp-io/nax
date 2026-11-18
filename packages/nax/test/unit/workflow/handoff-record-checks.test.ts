import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { HandoffRecordRead } from "@/workflow/handoff-record";
import { _handoffRecordDeps, collectHandoffRecord, readHandoffRecordFiles } from "@/workflow/handoff-record";
import { workflowFeatureDir } from "@/workflow/paths";

const FEATURE = "f1";
const BRANCH = "feat/f1";
const HEAD = "1111111111111111111111111111111111111111";
const OTHER_HEAD = "2222222222222222222222222222222222222222";
const RUN_ID = "r1";

/** One git answer the stub hands back, with what the module asked for recorded beside it. */
interface GitAnswer {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly throws?: string;
}

interface GitCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

let calls: GitCall[] = [];
let originalGit: typeof _handoffRecordDeps.git;

beforeEach(() => {
  originalGit = _handoffRecordDeps.git;
  calls = [];
});

afterEach(() => {
  _handoffRecordDeps.git = originalGit;
});

/** Answer every git call with `answer`, recording the argv and cwd it was asked with. */
function stubGit(answer: GitAnswer): void {
  _handoffRecordDeps.git = async (args, cwd) => {
    calls.push({ args, cwd });
    if (answer.throws !== undefined) throw new Error(answer.throws);
    return { stdout: answer.stdout ?? "", stderr: "", exitCode: answer.exitCode ?? 0 };
  };
}

/** The feature record a finished run leaves, with `overrides` merged over it (an `undefined` value drops the key). */
function featureRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "done", outcome: "local-only", head: HEAD, ...overrides };
}

/** A schema-version-1 result.json holding `featureWorkflow`, or one holding none at all. */
function resultJson(featureWorkflow: Record<string, unknown> | undefined, schemaVersion = 1): string {
  const file: Record<string, unknown> = { schemaVersion, runId: RUN_ID, stories: {} };
  if (featureWorkflow !== undefined) file.featureWorkflow = featureWorkflow;
  return `${JSON.stringify(file)}\n`;
}

/**
 * A PRD as `git show` prints it: every story passed unless `stories` says otherwise, and naming
 * `BRANCH` unless `branchName` or `omitBranchName` says otherwise.
 */
function prdText(
  options: {
    readonly branchName?: string;
    readonly stories?: readonly unknown[];
    readonly omitBranchName?: boolean;
  } = {},
): string {
  const prd: Record<string, unknown> = {
    project: "demo",
    feature: FEATURE,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: options.stories ?? [{ id: "US-001", passes: true, status: "passed" }],
  };
  if (options.omitBranchName !== true) prd.branchName = options.branchName ?? BRANCH;
  return `${JSON.stringify(prd)}\n`;
}

/** A story the PRD still has to run. */
function pendingStory(id: string): Record<string, unknown> {
  return { id, passes: false, status: "pending" };
}

/** Write one finished run's result.json into the feature's workflow tree; returns the repo root. */
async function writeRun(root: string, resultText: string): Promise<string> {
  const runDir = join(workflowFeatureDir(root, FEATURE), RUN_ID);
  await mkdir(runDir, { recursive: true });
  await Bun.write(join(runDir, "result.json"), resultText);
  return root;
}

/** The handoff's input over `root`, at the recorded HEAD and branch unless the test says otherwise. */
function handoffInput(root: string, overrides: { head?: string; branch?: string } = {}) {
  return {
    repoRoot: root,
    feature: FEATURE,
    head: overrides.head ?? HEAD,
    branch: overrides.branch ?? BRANCH,
  };
}

function expectOk(read: HandoffRecordRead): void {
  if (!read.ok) throw new Error(`expected an accepted record, got the refusal: ${read.reason}`);
}

function expectRefusal(read: HandoffRecordRead): string {
  if (read.ok) throw new Error("expected a refusal, got an accepted record");
  return read.reason;
}

const NOT_FINISHED = "the newest workflow run's result.json is not a finished feature record";

describe("collectHandoffRecord (US-003)", () => {
  test("a finished local-only run at HEAD with a matching committed PRD is accepted, with readHandoffRecordFiles' entries", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText() });

      const read = await collectHandoffRecord(handoffInput(dir));

      expectOk(read);
      expect(read).toEqual(await readHandoffRecordFiles(workflowFeatureDir(dir, FEATURE)));
    });
  });

  test("the committed PRD is read with git show at the pushed head, repo-rooted", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText() });

      await collectHandoffRecord(handoffInput(dir));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(["show", `${HEAD}:.nax/features/f1/prd.json`]);
      expect(calls[0]?.cwd).toBe(dir);
    });
  });

  test("a record-file refusal is returned unchanged and nothing is read from git", async () => {
    await withTempDir(async (dir) => {
      stubGit({ stdout: prdText() });

      const read = await collectHandoffRecord(handoffInput(dir));

      expect(expectRefusal(read)).toBe("no finished workflow run for this feature; run nax run first");
      expect(calls).toHaveLength(0);
    });
  });

  test("a newest result.json that is not JSON is not a finished feature record", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, "not json{");
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(NOT_FINISHED);
    });
  });

  test("a newest result.json with schemaVersion 2 is not a finished feature record", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord(), 2));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(NOT_FINISHED);
    });
  });

  test("a newest result.json with no featureWorkflow is not a finished feature record", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(undefined));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(NOT_FINISHED);
    });
  });

  test("a done feature record with no outcome is not a finished feature record", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ outcome: undefined })));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(NOT_FINISHED);
    });
  });

  test("a feature record stopped at publish says to finish the run", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ step: "publish" })));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        "the workflow stopped at publish; run nax run to finish it",
      );
    });
  });

  test("a run that already published a draft PR is diagnosed before the PRD is read", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ outcome: "draft", url: "https://x/pull/7" })));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        'the run already published a draft PR https://x/pull/7; a handoff needs a run that ended without a PR (publish "none")',
      );
      expect(calls).toHaveLength(0);
    });
  });

  test("a run that already published a ready PR without a url names no url", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ outcome: "ready" })));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        'the run already published a ready PR; a handoff needs a run that ended without a PR (publish "none")',
      );
    });
  });

  test("a pushed run at HEAD with a matching PRD is accepted", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ outcome: "pushed" })));
      stubGit({ stdout: prdText() });

      expectOk(await collectHandoffRecord(handoffInput(dir)));
    });
  });

  test("a run whose recorded head differs from HEAD is refused", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord({ head: OTHER_HEAD })));
      stubGit({ stdout: prdText() });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        "HEAD moved since the workflow finished; run nax run so the new commits are reviewed",
      );
      expect(calls).toHaveLength(0);
    });
  });

  test("a prd.json git cannot show at HEAD is not committed", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ exitCode: 128 });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json is not committed at HEAD");
    });
  });

  test("a throwing git read is the same refusal as a non-zero exit", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ throws: "git is missing" });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json is not committed at HEAD");
    });
  });

  test("a prd.json at HEAD whose text is the JSON array [] is not a PRD", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: "[]" });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json at HEAD is not a PRD");
    });
  });

  test("a prd.json at HEAD with a null userStories entry is not a PRD", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText({ stories: [null] }) });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json at HEAD is not a PRD");
    });
  });

  test("a prd.json at HEAD that is not JSON at all is not a PRD", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: "project: demo\n" });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json at HEAD is not a PRD");
    });
  });

  test("a prd.json at HEAD with no branch name is not a PRD", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText({ omitBranchName: true }) });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("prd.json at HEAD is not a PRD");
    });
  });

  test("a prd.json at HEAD naming another branch is refused with both names", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText({ branchName: "feat/other" }) });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        "prd.json names branch feat/other, not feat/f1",
      );
    });
  });

  test("a prd.json at HEAD with two pending stories counts them", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText({ stories: [pendingStory("US-002"), pendingStory("US-003")] }) });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe(
        "2 stories are still pending: US-002, US-003",
      );
    });
  });

  test("a prd.json at HEAD with one pending story says so in the singular", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, resultJson(featureRecord()));
      stubGit({ stdout: prdText({ stories: [pendingStory("US-002")] }) });

      expect(expectRefusal(await collectHandoffRecord(handoffInput(dir)))).toBe("1 story is still pending: US-002");
    });
  });
});
