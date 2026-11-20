import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdvanceReviewedHeadInput } from "@/bot/reviewed-head";
import { _reviewedHeadDeps, advanceReviewedHead } from "@/bot/reviewed-head";
import { type ForgeDeps, type PrComment, type PrRef, withNaxBotMarker } from "@/forge";
import { type ItemIndex, parseItemIndexSettled, renderItemIndex } from "@/workflow/item-threads";

const LOGIN = "bot";
/** The head the index names today — the head the review read at preparation. */
const PREVIOUS_HEAD = "a".repeat(40);
/** The head the review just covered. */
const HEAD = "b".repeat(40);
/** The merge base the review diffed against. */
const BASE = "c".repeat(40);
/** The base the index names today. */
const PREVIOUS_BASE = "d".repeat(40);
/** A reviewed head some other writer owns. */
const OTHER_HEAD = "e".repeat(40);

const KEY_A = "w-B3.12345678";
const KEY_B = "w-B4.87654321";
const KEY_C = "w-B5.11223344";

const REF: PrRef = { forge: "github", host: "github.com", repo: "org/repo", number: 7 };
const CWD = "/checkout";
const DEPS: ForgeDeps = {
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  readText: async () => null,
};

const comment = (id: string, body: string, author = LOGIN): PrComment => ({
  id,
  kind: "comment",
  author,
  body,
  createdAt: "2026-01-01T00:00:00Z",
});

/** The bot's own index comment, rendered from an index. */
const indexComment = (id: string, index: ItemIndex, settled = 0): PrComment =>
  comment(id, withNaxBotMarker(renderItemIndex(index, settled), "w-index"));

/** The first index line the older writers wrote: no settled count. */
const legacyIndexBody = (index: { readonly keys: readonly string[]; readonly reviewedHead?: string }): string =>
  [
    `nax workflow open items: ${index.keys.length}`,
    `Reviewed head: ${index.reviewedHead ?? "none"}`,
    ...index.keys.map((key) => `- ${key}`),
  ].join("\n");

/** The index as the review found it: a reviewed pair of its own, to be replaced. */
const staleIndex: ItemIndex = {
  keys: [KEY_A, KEY_B],
  reviewedHead: PREVIOUS_HEAD,
  reviewedBase: PREVIOUS_BASE,
};

const input = (overrides: Partial<AdvanceReviewedHeadInput> = {}): AdvanceReviewedHeadInput => ({
  ref: REF,
  login: LOGIN,
  expectedHead: PREVIOUS_HEAD,
  head: HEAD,
  base: BASE,
  deps: DEPS,
  cwd: CWD,
  ...overrides,
});

/** The index line the edited comment carries. */
const firstIndexLine = (body: string): string =>
  body.split("\n").find((line) => line.startsWith("nax workflow items:")) ?? "";

/** The body the first edit wrote. */
const editedBody = (): string => String(editComment.mock.calls[0]?.[2] ?? "");

const listPrComments = mock(async (_ref: PrRef, _deps: ForgeDeps, _cwd: string): Promise<PrComment[]> => []);
const editComment = mock(
  async (
    _ref: PrRef,
    _comment: Pick<PrComment, "id" | "kind">,
    _body: string,
    _deps: ForgeDeps,
    _cwd: string,
  ): Promise<void> => {},
);
const original = { ..._reviewedHeadDeps };

beforeEach(() => {
  listPrComments.mockClear();
  editComment.mockClear();
  listPrComments.mockImplementation(async (): Promise<PrComment[]> => []);
  editComment.mockImplementation(async (): Promise<void> => {});
  Object.assign(_reviewedHeadDeps, { listPrComments, editComment });
});
afterEach(() => Object.assign(_reviewedHeadDeps, original));

describe("advanceReviewedHead", () => {
  test("AC-1 advances when the re-read index still carries the expected reviewed head", async () => {
    listPrComments.mockImplementation(async () => [indexComment("index", staleIndex)]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "advanced" });
    expect(listPrComments).toHaveBeenCalledWith(REF, DEPS, CWD);
  });

  test("AC-2 edits the re-read index once, keeping its keys, pending reopens and settled count", async () => {
    const fresh: ItemIndex = {
      keys: [KEY_A, KEY_B],
      reviewedHead: PREVIOUS_HEAD,
      reviewedBase: PREVIOUS_BASE,
      pendingReopens: [{ key: KEY_A, commentId: "42" }],
    };
    const own = indexComment("index", fresh, 1);
    listPrComments.mockImplementation(async () => [own]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "advanced" });
    expect(editComment).toHaveBeenCalledTimes(1);
    expect(editComment).toHaveBeenCalledWith(
      REF,
      own,
      withNaxBotMarker(renderItemIndex({ ...fresh, reviewedHead: HEAD, reviewedBase: BASE }, 1), "w-index"),
      DEPS,
      CWD,
    );
  });

  test("AC-3 keeps the settled count of the re-read index", async () => {
    const fresh: ItemIndex = { keys: [KEY_A, KEY_B, KEY_C], reviewedHead: PREVIOUS_HEAD, reviewedBase: PREVIOUS_BASE };
    listPrComments.mockImplementation(async () => [indexComment("index", fresh, 2)]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "advanced" });
    expect(firstIndexLine(editedBody())).toBe("nax workflow items: 3 (2 settled)");
  });

  test("AC-4 rewrites a legacy index line in the modern form", async () => {
    const legacy = comment(
      "legacy",
      withNaxBotMarker(legacyIndexBody({ keys: [KEY_A, KEY_B], reviewedHead: PREVIOUS_HEAD }), "w-index"),
    );
    listPrComments.mockImplementation(async () => [legacy]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "advanced" });
    expect(firstIndexLine(editedBody())).toBe("nax workflow items: 2 (0 settled)");
  });

  test("AC-5 advances an index that names no reviewed head yet", async () => {
    listPrComments.mockImplementation(async () => [indexComment("index", { keys: [KEY_A] })]);
    expect(await advanceReviewedHead(input({ expectedHead: undefined }))).toEqual({ kind: "advanced" });
  });

  test("AC-6 skips with moved when another writer moved the reviewed head", async () => {
    listPrComments.mockImplementation(async () => [indexComment("index", { keys: [KEY_A], reviewedHead: OTHER_HEAD })]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "skipped", reason: "moved" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-7 reports unchanged when the index already carries the reviewed pair", async () => {
    listPrComments.mockImplementation(async () => [
      indexComment("index", { keys: [KEY_A], reviewedHead: HEAD, reviewedBase: BASE }),
    ]);
    expect(await advanceReviewedHead(input({ expectedHead: HEAD }))).toEqual({ kind: "unchanged" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-8 skips with no-index when the re-read finds no own index comment", async () => {
    listPrComments.mockImplementation(async () => []);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "skipped", reason: "no-index" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-8 skips with no-index when the only index comment belongs to another author", async () => {
    const other = comment("other", withNaxBotMarker(renderItemIndex(staleIndex, 0), "w-index"), "someone");
    listPrComments.mockImplementation(async () => [other]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "skipped", reason: "no-index" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-9 skips with unparseable when the own index comment does not parse", async () => {
    listPrComments.mockImplementation(async () => [comment("index", withNaxBotMarker("not an index", "w-index"))]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "skipped", reason: "unparseable" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-10 skips with invalid-sha when the head is not a 40-character sha", async () => {
    expect(await advanceReviewedHead(input({ head: "not-a-sha" }))).toEqual({ kind: "skipped", reason: "invalid-sha" });
    expect(listPrComments).not.toHaveBeenCalled();
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-11 skips with invalid-sha when the base is not a 40-character sha", async () => {
    expect(await advanceReviewedHead(input({ base: "not-a-sha" }))).toEqual({ kind: "skipped", reason: "invalid-sha" });
    expect(listPrComments).not.toHaveBeenCalled();
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-12 fails without editing when the comment read rejects", async () => {
    listPrComments.mockImplementation(async () => {
      throw new Error("read failed");
    });
    expect(await advanceReviewedHead(input())).toEqual({ kind: "failed" });
    expect(editComment).not.toHaveBeenCalled();
  });

  test("AC-13 fails when the index edit rejects", async () => {
    listPrComments.mockImplementation(async () => [indexComment("index", staleIndex)]);
    editComment.mockImplementation(async () => {
      throw new Error("edit failed");
    });
    expect(await advanceReviewedHead(input())).toEqual({ kind: "failed" });
  });

  test("AC-14 edits the newer own index comment, not the older one", async () => {
    const older = indexComment("older", staleIndex);
    const newer = indexComment("newer", staleIndex);
    listPrComments.mockImplementation(async () => [older, newer]);
    expect(await advanceReviewedHead(input())).toEqual({ kind: "advanced" });
    expect(editComment).toHaveBeenCalledTimes(1);
    expect(editComment.mock.calls[0]?.[1]).toEqual(newer);
  });

  test("AC-15 advances when only the reviewed base differs", async () => {
    listPrComments.mockImplementation(async () => [
      indexComment("index", { keys: [KEY_A], reviewedHead: HEAD, reviewedBase: PREVIOUS_BASE }),
    ]);
    expect(await advanceReviewedHead(input({ expectedHead: HEAD }))).toEqual({ kind: "advanced" });
  });

  test("AC-16 skips with moved when the index lost the reviewed head the review read", async () => {
    listPrComments.mockImplementation(async () => [indexComment("index", { keys: [KEY_A] })]);
    expect(await advanceReviewedHead(input({ expectedHead: PREVIOUS_HEAD }))).toEqual({
      kind: "skipped",
      reason: "moved",
    });
    expect(editComment).not.toHaveBeenCalled();
  });
});

describe("parseItemIndexSettled", () => {
  test("AC-17 reads the settled count of a modern index line", () => {
    const body = withNaxBotMarker(renderItemIndex({ keys: [KEY_A, KEY_B, KEY_C] }, 2), "w-index");
    expect(body.split("\n")[2]).toBe("nax workflow items: 3 (2 settled)");
    expect(parseItemIndexSettled(body)).toBe(2);
  });

  test("AC-18 reads no settled count from a legacy index line", () => {
    const body = withNaxBotMarker(legacyIndexBody({ keys: [KEY_A, KEY_B] }), "w-index");
    expect(parseItemIndexSettled(body)).toBe(0);
  });

  test("AC-19 returns null for a body the index parser rejects", () => {
    const notAnIndex = withNaxBotMarker("not an index", "w-index");
    const impossibleCount = withNaxBotMarker(
      ["nax workflow items: 1 (3 settled)", "Reviewed head: none", `- ${KEY_A}`].join("\n"),
      "w-index",
    );
    expect(parseItemIndexSettled(notAnIndex)).toBeNull();
    expect(parseItemIndexSettled(impossibleCount)).toBeNull();
  });
});
