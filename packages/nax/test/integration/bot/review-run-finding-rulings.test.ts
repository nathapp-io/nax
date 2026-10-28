import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeScriptedCallOp, makeTestRuntime } from "@test/helpers";
import { _findingRulingsDeps, recordFindingRulings } from "@/bot/finding-rulings";
import { _postDeps, type BotReviewArtifact } from "@/bot/post";
import { findingKey } from "@/bot/render";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps } from "@/bot/review-step";
import { _rulingsDeps } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrInfo, type PrThread, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { botPrStaticReviewOp, type PrReviewVerdict } from "@/operations";
import { itemKey, renderItemIndex, renderItemOpener } from "@/workflow/item-threads";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const findingDeps = { ..._findingRulingsDeps };
const postDeps = { ..._postDeps };
const stepDeps = { ..._reviewStepDeps };
const workflowDeps = { ..._workflowDeps };
const rulingDeps = { ..._rulingsDeps };
const config = makeNaxConfig();
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
const finding = {
  kind: "quality" as const,
  severity: "important" as const,
  issue: "Missing check",
  file: "src/check.ts",
  line: 4,
};
const key = findingKey(finding);
const comment = (id: string, author: string, body: string): PrComment => ({
  id,
  author,
  body,
  kind: "thread",
  createdAt: "",
});
let runtime: ReturnType<typeof makeTestRuntime>;
let info: PrInfo;
let threads: PrThread[];
let artifact: BotReviewArtifact | undefined;
let prompt: string;
let operation: unknown;
let verdict: PrReviewVerdict;
const record = mock(recordFindingRulings);
const access = mock(async () => true);
const echo = mock(async () => {});
const resolve = mock(async () => {});
const forge = mock(async (_argv: string[], _opts: { cwd: string }) => ({
  exitCode: 0,
  stdout: '{"id": 999}',
  stderr: "",
}));

function findingThread(reply: string, resolved = false): PrThread {
  return {
    id: "T1",
    replyTo: "C1",
    resolved,
    outdated: false,
    path: finding.file,
    line: finding.line,
    comments: [
      comment("101", "bot", withNaxBotMarker("**Important** Missing check", key)),
      comment("C2", "writer", reply),
    ],
  };
}

beforeEach(() => {
  initLogger({ level: "silent" });
  runtime = makeTestRuntime({ config });
  info = {
    number: 7,
    title: "PR",
    body: "ordinary PR",
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: "a".repeat(40),
    crossRepo: false,
  };
  threads = [findingThread("waive: out of scope")];
  artifact = undefined;
  prompt = "";
  operation = undefined;
  verdict = {
    intent: "pass",
    quality: "approved",
    findings: [],
    threads: [],
    comments: [],
    cannotVerify: [],
    inspectedFiles: [],
  };
  for (const fn of [record, access, echo, resolve, forge]) fn.mockClear();
  forge.mockImplementation(async () => ({ exitCode: 0, stdout: '{"id":999}', stderr: "" }));
  access.mockImplementation(async () => true);
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info, threads: () => threads }),
    recordFindingRulings: record,
    hasWriteAccess: access,
    forge: { run: forge },
  });
  Object.assign(_findingRulingsDeps, { replyToThread: echo, resolveThread: resolve });
  _postDeps.writeArtifact = async (_path, value) => {
    artifact = value;
    return 0;
  };
  _reviewStepDeps.writeBranchReviewPackage = async () => [];
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.callOp = makeScriptedCallOp((op, value) => {
    operation = op;
    if (typeof value === "object" && value !== null && "prompt" in value) prompt = String(value.prompt);
    return verdict;
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_findingRulingsDeps, findingDeps);
  Object.assign(_postDeps, postDeps);
  Object.assign(_reviewStepDeps, stepDeps);
  Object.assign(_workflowDeps, workflowDeps);
  Object.assign(_rulingsDeps, rulingDeps);
  await runtime.close();
  resetLogger();
});

describe("runBotReview finding rulings", () => {
  test.each([true, false])("US-002 AC-17/18: re-raised own finding reopens only when resolved=%s", async (resolved) => {
    const thread = findingThread("no ruling", resolved);
    threads = [{ ...thread, comments: thread.comments.slice(0, 1) }];
    verdict = { ...verdict, findings: [finding] };
    forge.mockImplementation(async () => {
      expect(artifact?.agreed).toContainEqual(expect.objectContaining({ key }));
      return { exitCode: 0, stdout: '{"id":999}', stderr: "" };
    });
    const result = await runBotReview(input);
    expect(result).toMatchObject({ outcome: "posted", inlineFindings: 1 });
    const calls = forge.mock.calls.map(([argv]) => argv);
    expect(calls[0]).toContain("PATCH");
    expect(calls[0]).toContain("repos/o/r/pulls/comments/101");
    const reopen = calls.filter((argv) => argv.some((arg) => arg.includes("unresolveReviewThread")));
    expect(reopen).toHaveLength(resolved ? 1 : 0);
    if (resolved) {
      expect(calls[1]).toEqual(reopen[0]);
      expect(reopen[0]).toContain("id=T1");
    }
  });
  test("AC-1 passes raw own finding thread to recorder", async () => {
    await runBotReview(input);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0].threads).toEqual(threads);
    expect(echo).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  test("AC-2 removes waived finding from real review prompt", async () => {
    await runBotReview(input);
    expect(prompt).toContain("PR");
    expect(prompt).not.toContain("Your earlier finding");
  });
  test("AC-3 carries finding key and waived disposition into settled prompt section", async () => {
    await runBotReview(input);
    expect(prompt).toMatch(new RegExp(`## Settled rulings[\\s\\S]*${key}[\\s\\S]*waived`));
  });
  test("AC-4 counts finding echo on unmarked PR artifact", async () => {
    await runBotReview(input);
    expect(artifact?.rulings).toEqual({ recorded: 1, open: 0, asked: 0 });
  });
  test("AC-5 excludes re-raised resolved waived finding from agreed artifact", async () => {
    threads = [findingThread("waive: a", true)];
    verdict = { ...verdict, findings: [finding] };
    await runBotReview(input);
    expect(artifact).toBeDefined();
    expect(artifact?.agreed.some((item) => item.key === key)).toBe(false);
  });
  test("AC-6 never edits or posts re-raised resolved waived inline finding", async () => {
    threads = [findingThread("waive: a", true)];
    verdict = { ...verdict, findings: [finding] };
    const result = await runBotReview(input);
    expect(result).toMatchObject({ outcome: "posted", inlineFindings: 0 });
    expect(forge.mock.calls.some((args) => JSON.stringify(args).includes("Missing check"))).toBe(false);
  });
  test("AC-7 keeps confirmed finding as fix work", async () => {
    threads = [findingThread("confirm")];
    await runBotReview(input);
    expect(artifact?.agreed).toContainEqual(expect.objectContaining({ kind: "finding", key }));
    expect(echo).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(["confirm", "verified"])("restores fix work after waive → resolve → %s", async (keyword) => {
    const thread = findingThread("waive: a", true);
    threads = [{ ...thread, comments: [...thread.comments, comment("C3", "writer", keyword)] }];
    await runBotReview(input);
    expect(artifact?.agreed).toContainEqual(expect.objectContaining({ kind: "finding", key }));
    expect(prompt).not.toContain("Your earlier finding");
    expect(echo).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("a new confirmation after a prior successful fix restores work again", async () => {
    const thread = findingThread("confirm", true);
    threads = [
      {
        ...thread,
        comments: [
          ...thread.comments,
          comment("C3", "bot", withNaxBotMarker("Fixed in abc1234", `fix-${key}`)),
          comment("C4", "writer", "confirm: still broken"),
        ],
      },
    ];
    await runBotReview(input);
    expect(artifact?.agreed).toContainEqual(expect.objectContaining({ kind: "finding", key }));
    expect(prompt).not.toContain("Your earlier finding");
  });
  test("a successful fix after confirmation does not restore resolved fix work", async () => {
    const thread = findingThread("confirm", true);
    threads = [
      {
        ...thread,
        comments: [...thread.comments, comment("C3", "bot", withNaxBotMarker("Fixed in abc1234", `fix-${key}`))],
      },
    ];
    await runBotReview(input);
    expect(artifact?.agreed).toEqual([]);
    expect(echo).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-8 hides confirmed finding from review earlier verdicts", async () => {
    threads = [findingThread("confirm")];
    await runBotReview(input);
    expect(prompt).not.toContain("Your earlier finding");
    expect(prompt).toContain("confirmed");
  });
  test("AC-9 sums workflow item and finding echoes", async () => {
    info = { ...info, body: NAX_WORKFLOW_PR_MARKER };
    const item = { id: "F1", kind: "finding" as const, issue: "Item issue" };
    const wKey = itemKey(item);
    threads.push({
      ...findingThread("waive: item"),
      id: "W1",
      comments: [
        comment("W0", "bot", withNaxBotMarker(renderItemOpener(item), wKey)),
        comment("W2", "writer", "waive: item"),
      ],
    });
    _botReviewDeps.listPrComments = async () => [
      comment("index", "bot", withNaxBotMarker(renderItemIndex({ keys: [wKey] }), "w-index")),
    ];
    Object.assign(_rulingsDeps, {
      hasWriteAccess: access,
      readPrInfo: async () => info,
      replyToThread: echo,
      resolveThread: resolve,
    });
    await runBotReview(input);
    expect(artifact?.rulings?.recorded).toBe(2);
  });
  test("AC-10 ignores non-writer waiver and preserves open earlier finding", async () => {
    access.mockImplementation(async () => false);
    verdict = { ...verdict, earlier: [{ id: "T1", status: "open", reason: "still valid" }] };
    await runBotReview(input);
    expect(artifact?.agreed).toContainEqual(expect.objectContaining({ key, kind: "finding" }));
    expect(record).toHaveBeenCalledTimes(1);
    expect(echo).not.toHaveBeenCalled();
  });
  test("AC-11 settles authorized finding in static mode", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: info.headSha, reasons: ["fork"] });
    await runBotReview(input);
    expect(operation).toBe(botPrStaticReviewOp);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(artifact?.rulings).toEqual({ recorded: 1, open: 0, asked: 0 });
  });
  test("AC-12 shares cached login permission across triage and recorder", async () => {
    _botReviewDeps.listPrComments = async () => [{ ...comment("general", "writer", "please review"), kind: "comment" }];
    record.mockImplementationOnce(async (value) => {
      // Triage must have checked this login before the recorder reads its reply.
      expect(access).toHaveBeenCalledTimes(1);
      return recordFindingRulings(value);
    });
    await runBotReview(input);
    expect(record).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledTimes(1);
    expect(echo).toHaveBeenCalledTimes(1);
  });
});
