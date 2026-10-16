/**
 * SPEC-workflow-record-promote US-002: `readPrState` reads what the forge CLI reports about one
 * PR/MR and normalises it — the draft flag, the body and the url — for `nax workflow record`.
 */
import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import type { ForgeDeps, ForgeRunResult } from "@/forge";
import { readPrState } from "@/workflow/pr-state";

const PR = "https://gh/pr/7";
const CWD = "/repo";

/** A forge stub answering every call with `result`, recording each argv. */
function forge(result: Partial<ForgeRunResult> = {}): { deps: ForgeDeps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

/** Runs `readPrState` requiring a `WORKFLOW_PR_READ_FAILED` NaxError, and returns it. */
async function readFailure(stdout: string, exitCode = 0, stderr = ""): Promise<Error & { code: string }> {
  const f = forge({ stdout, exitCode, stderr });
  let caught: unknown;
  try {
    await readPrState("github", PR, f.deps, CWD);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("WORKFLOW_PR_READ_FAILED");
  return caught;
}

/** The same refusal for a GitLab MR, whose draft flag has its own two names. */
async function gitlabFailure(stdout: string): Promise<Error & { code: string }> {
  const f = forge({ stdout });
  let caught: unknown;
  try {
    await readPrState("gitlab", "7", f.deps, CWD);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("WORKFLOW_PR_READ_FAILED");
  return caught;
}

describe("readPrState", () => {
  test("AC-1: runs `gh pr view <ref> --json isDraft,body,url` and returns the three fields", async () => {
    const f = forge({ stdout: '{"isDraft":true,"body":"B","url":"https://gh/pr/7"}' });
    const state = await readPrState("github", PR, f.deps, CWD);
    expect(f.calls).toEqual([["gh", "pr", "view", PR, "--json", "isDraft,body,url"]]);
    expect(state).toEqual({ isDraft: true, body: "B", url: "https://gh/pr/7" });
  });

  test("AC-2: normalises a GitLab MR's draft, description and web_url", async () => {
    const f = forge({ stdout: '{"draft":true,"description":"D","web_url":"https://gl/mr/7"}' });
    const state = await readPrState("gitlab", "7", f.deps, CWD);
    expect(f.calls).toEqual([["glab", "mr", "view", "7", "--output", "json"]]);
    expect(state).toEqual({ isDraft: true, body: "D", url: "https://gl/mr/7" });
  });

  test("AC-2: work_in_progress reads as a draft too", async () => {
    const f = forge({ stdout: '{"work_in_progress":true}' });
    const state = await readPrState("gitlab", "7", f.deps, CWD);
    expect(state.isDraft).toBe(true);
    expect(state.body).toBe("");
    expect(state.url).toBeUndefined();
  });

  test("a ready PR is not a draft", async () => {
    const f = forge({ stdout: '{"isDraft":false,"body":"B","url":"https://gh/pr/7"}' });
    expect((await readPrState("github", PR, f.deps, CWD)).isDraft).toBe(false);
  });

  test("a forge answer with no draft flag is a read failure, not a ready PR", async () => {
    const err = await readFailure("{}");
    expect(err.message).toBe(`cannot read PR ${PR}: the forge reported no isDraft boolean`);
  });

  test("a non-boolean isDraft is a read failure too", async () => {
    const err = await readFailure('{"isDraft":"true"}');
    expect(err.message).toBe(`cannot read PR ${PR}: the forge reported no isDraft boolean`);
  });

  test("GitHub takes only its own field: GitLab's draft name is not readiness", async () => {
    const err = await readFailure('{"draft":false,"body":"B"}');
    expect(err.message).toBe(`cannot read PR ${PR}: the forge reported no isDraft boolean`);
  });

  test("a GitLab MR with no draft flag is a read failure", async () => {
    const err = await gitlabFailure('{"description":"D","web_url":"https://gl/mr/7"}');
    expect(err.message).toBe("cannot read PR 7: the forge reported no draft or work_in_progress boolean");
  });

  test("GitLab falls back to its legacy field when the modern one is missing or malformed", async () => {
    const legacy = forge({ stdout: '{"work_in_progress":true}' });
    expect((await readPrState("gitlab", "7", legacy.deps, CWD)).isDraft).toBe(true);
    const malformed = forge({ stdout: '{"draft":"yes","work_in_progress":false}' });
    expect((await readPrState("gitlab", "7", malformed.deps, CWD)).isDraft).toBe(false);
  });

  test("AC-3: a non-zero exit fails with the forge's stderr as the detail", async () => {
    const err = await readFailure("", 1, "not found\n");
    expect(err.message).toBe(`cannot read PR ${PR}: not found`);
  });

  test("AC-3: a non-zero exit with no stderr still names the failure", async () => {
    const err = await readFailure("", 128, "");
    expect(err.message).toBe(`cannot read PR ${PR}: exit 128`);
  });

  test("AC-4: stdout that is not JSON fails with WORKFLOW_PR_READ_FAILED", async () => {
    const err = await readFailure("not json at all");
    expect(err.message).toBe(`cannot read PR ${PR}: unparseable output: not json at all`);
  });

  test("AC-4: stdout that is a JSON array, not an object, is unparseable output too", async () => {
    const err = await readFailure("[]");
    expect(err.message).toBe(`cannot read PR ${PR}: unparseable output: []`);
  });
});
