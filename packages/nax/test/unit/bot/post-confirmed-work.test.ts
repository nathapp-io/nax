import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeBotFixEnv, makeTempDir } from "@test/helpers";
import { type BotReviewArtifact, type PostReviewInput, postPrReview } from "@/bot/post";
import { earlierCounts } from "@/bot/post-earlier";
import { withNaxBotMarker } from "@/forge";

const env = makeBotFixEnv();
const key = "w-D-1.12345678";
const issue = "Open item **D-1** (advisor): change required";
const thread = {
  id: "D",
  replyTo: "91",
  path: "anchor.ts",
  line: 42,
  resolved: false,
  outdated: false,
  comments: [
    {
      id: "opener",
      author: "bot",
      kind: "thread" as const,
      createdAt: "",
      body: withNaxBotMarker(`${issue}\n\nRule on it`, key),
    },
  ],
};
const run = mock(async (_argv: string[], _opts: { cwd: string }) => ({ exitCode: 0, stdout: '{"id":42}', stderr: "" }));
let stateDir: string;
let input: PostReviewInput;
async function artifact(): Promise<BotReviewArtifact> {
  return Bun.file(join(stateDir, "bot-review.json")).json();
}
beforeEach(() => {
  stateDir = makeTempDir("post-confirmed-");
  run.mockClear();
  input = {
    ref: env.ref,
    info: { ...env.info, headSha: "a".repeat(40) },
    verdict: {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    },
    threads: [],
    comments: [],
    own: [],
    login: "bot",
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: { run, readText: async () => null },
    cwd: stateDir,
    itemConfirmed: [{ thread, reason: "change X" }],
  };
});
afterEach(() => cleanupTempDir(stateDir));

describe("postPrReview confirmed advisor work", () => {
  test("AC-9/11/12 persists required work using opener issue, not its anchor", async () => {
    await postPrReview(input);
    expect((await artifact()).agreed).toEqual([
      { kind: "finding", key, issue, severity: "important", suggestion: "change X" },
    ]);
  });
  test("AC-10 omits default confirmation suggestion", async () => {
    await postPrReview({ ...input, itemConfirmed: [{ thread, reason: "confirmed" }] });
    expect((await artifact()).agreed).toEqual([{ kind: "finding", key, issue, severity: "important" }]);
  });
  test("AC-16 counts confirmed provenance as open despite fixed verdict", () => {
    expect(
      earlierCounts({
        ...input,
        earlier: [thread],
        verdict: { ...input.verdict, earlier: [{ id: thread.id, status: "fixed", reason: "model" }] },
      }),
    ).toEqual({ open: 1, fixed: 0, withdrawn: 0 });
  });
  test.each(["fixed", "withdrawn"] as const)(
    "AC-13/14/15/16 confirmation dominates %s verdict and duplicate earlier inputs",
    async (status) => {
      const value = {
        ...input,
        earlier: [thread],
        itemEarlier: [thread],
        verdict: { ...input.verdict, earlier: [{ id: thread.id, status, reason: "model changed its mind" }] },
      };
      await postPrReview(value);
      expect(run.mock.calls).toHaveLength(1); // Summary only: no reply, edit or resolve request.
      expect(run.mock.calls[0]?.[0].join(" ")).not.toContain("resolveReviewThread");
      expect((await artifact()).agreed).toEqual([
        { kind: "finding", key, issue, severity: "important", suggestion: "change X" },
      ]);
      expect(earlierCounts(value)).toEqual({ open: 1, fixed: 0, withdrawn: 0 });
    },
  );
});
