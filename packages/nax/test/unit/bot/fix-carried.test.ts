import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { carriedRecordBody, carriedRecordKey } from "@/bot/carried-record";
import { _fixCarriedDeps, withCarriedFixFindings } from "@/bot/fix-carried";
import type { AgreedItem } from "@/bot/post";
import { ownComments, withNaxBotMarker } from "@/forge";

const head = "a".repeat(40);
const carried = { key: "f-carry", severity: "important" as const, issue: "Race", raisedBy: "review-B" };
function envFor(agreed: readonly AgreedItem[] = [], recordHead = head) {
  const env = makeBotFixEnv(agreed);
  const { body } = carriedRecordBody({ headSha: recordHead, findings: [carried] });
  return {
    ...env,
    info: { ...env.info, headSha: head },
    review: { ...env.review, headSha: head },
    own: ownComments(
      [
        {
          id: "1",
          kind: "comment",
          author: "bot",
          body: withNaxBotMarker(body, carriedRecordKey(recordHead)),
          createdAt: "",
        },
      ],
      "bot",
    ),
  };
}
afterEach(() => mock.restore());

describe("withCarriedFixFindings", () => {
  test("adds the durable finding with its review provenance and keeps the artifact immutable", async () => {
    spyOn(_fixCarriedDeps, "readSettledKeys").mockResolvedValue(new Set());
    const env = envFor();
    const result = await withCarriedFixFindings(env);
    expect(result.review.agreed).toEqual([{ kind: "finding", ...carried }]);
    expect(env.review.agreed).toEqual([]);
  });
  test("does not duplicate an artifact finding or overwrite its newer details", async () => {
    const item = { kind: "finding" as const, ...carried, issue: "Latest details" };
    const read = spyOn(_fixCarriedDeps, "readSettledKeys");
    expect((await withCarriedFixFindings(envFor([item]))).review.agreed).toEqual([item]);
    expect(read).not.toHaveBeenCalled();
  });
  test("does not offer settled carry work to the fixer", async () => {
    spyOn(_fixCarriedDeps, "readSettledKeys").mockResolvedValue(new Set([carried.key]));
    expect((await withCarriedFixFindings(envFor())).review.agreed).toEqual([]);
  });
  test.each([false, true])("withdrawn carry is actionable only if reconfirmed: %s", async (confirmed) => {
    spyOn(_fixCarriedDeps, "readSettledKeys").mockResolvedValue(new Set());
    spyOn(_fixCarriedDeps, "readConfirmedKeys").mockResolvedValue(new Set(confirmed ? [carried.key] : []));
    const base = envFor();
    const result = await withCarriedFixFindings({
      ...base,
      review: {
        ...base.review,
        events: [
          {
            type: "finding-withdrawn",
            key: carried.key,
            threadId: "T1",
            finding: "Race",
            reason: "Incorrect",
            disagreedBy: ["alice"],
          },
        ],
      },
    });
    expect(result.review.agreed).toEqual(confirmed ? [{ kind: "finding", ...carried }] : []);
  });
  test("does not use another head's carry", async () => {
    expect((await withCarriedFixFindings(envFor([], "b".repeat(40)))).review.agreed).toEqual([]);
  });
  test("unreadable carry stays out of fixer inputs", async () => {
    const env = envFor();
    const own = env.own.map((entry) => ({ ...entry, comment: { ...entry.comment, body: "unreadable" } }));
    expect((await withCarriedFixFindings({ ...env, own })).review.agreed).toEqual([]);
  });
  test("honors the effective blocking trigger policy", async () => {
    const base = envFor();
    const env = { ...base, review: { ...base.review, blockingTriggers: ["own-concurrency" as const] } };
    expect((await withCarriedFixFindings(env)).review.agreed).toEqual([]);
  });
  test("an unreadable settlement stops preparation instead of fixing potentially settled work", async () => {
    spyOn(_fixCarriedDeps, "readSettledKeys").mockRejectedValue(new Error("offline"));
    await expect(withCarriedFixFindings(envFor())).rejects.toThrow("offline");
  });
});
