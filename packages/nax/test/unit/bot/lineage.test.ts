import { describe, expect, mock, test } from "bun:test";
import { computeLineage, type LineageDeps, type LineageInput } from "@/bot/lineage";
import type { BotPushEntry } from "@/bot/push-ledger";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const PUSH = "3".repeat(40);
const EARLIER_PUSH = "4".repeat(40);
const BLAMED = "5".repeat(40);
const OLDER_BASE = "6".repeat(40);
const WORKTREE = "/checkout";
const FILE = "src/a.ts";

/** One recorded bot push, defaulting to a first-generation fix of `f-a`. */
function entry(overrides: Partial<BotPushEntry> = {}): BotPushEntry {
  return {
    base: BASE,
    sha: PUSH,
    at: "2026-01-01T00:00:00.000Z",
    items: [{ key: "f-a", generation: 0, issue: "lock leaks" }],
    ...overrides,
  };
}

/** What `git blame --porcelain -L` prints for a line: the blamed commit, then its provenance. */
function blamed(sha: string): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: `${sha} 1 1 1\nfilename ${FILE}\n\tconst x = 1;\n`, stderr: "" };
}

type AncestryAnswer = "yes" | "no" | "error";
interface StubInput {
  /** What blame reports for the target's line; a non-zero exit answers with the failure. */
  readonly blame?: { exitCode: number; stdout: string; stderr: string };
  /** Every ancestry question, keyed `${ancestor}>${descendant}`; an unasked pair fails loudly. */
  readonly ancestry?: Readonly<Record<string, AncestryAnswer>>;
}

/** A git that answers only the questions a test declared, so an extra call is a visible bug. */
function stubGit(input: StubInput = {}): { runGit: LineageDeps["runGit"]; calls: string[][] } {
  const calls: string[][] = [];
  const runGit = mock(async (args: string[], workdir: string) => {
    expect(workdir).toBe(WORKTREE);
    calls.push(args);
    if (args[0] === "blame") return input.blame ?? blamed(PUSH);
    const [, , ancestor, descendant] = args;
    const answer = input.ancestry?.[`${ancestor}>${descendant}`];
    if (answer === undefined) throw new Error(`unexpected ancestry question ${ancestor} > ${descendant}`);
    if (answer === "error") return { exitCode: 2, stdout: "", stderr: "git exploded" };
    return { exitCode: answer === "yes" ? 0 : 1, stdout: "", stderr: "" };
  });
  return { runGit, calls };
}

function lineageInput(overrides: Partial<LineageInput> = {}): LineageInput {
  return {
    targets: [{ key: "f-x", file: FILE, line: 12 }],
    entries: [entry()],
    worktree: WORKTREE,
    head: HEAD,
    ...overrides,
  };
}

describe("computeLineage ancestry", () => {
  test("AC-1 gives a finding on the push's own commit generation 1 and the push's items as parents", async () => {
    const { runGit } = stubGit({ blame: blamed(PUSH), ancestry: { [`${PUSH}>${HEAD}`]: "yes" } });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.lineage.get("f-x")).toEqual({ generation: 1, parents: ["f-a"], pushSha: PUSH });
    expect(result.unknown.size).toBe(0);
    expect(result.unreachable).toBe(0);
  });
  test("AC-2 attributes a line the push added to the push that added it", async () => {
    const { runGit } = stubGit({
      blame: blamed(BLAMED),
      ancestry: { [`${PUSH}>${HEAD}`]: "yes", [`${BLAMED}>${PUSH}`]: "yes", [`${BLAMED}>${BASE}`]: "no" },
    });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.lineage.get("f-x")).toEqual({ generation: 1, parents: ["f-a"], pushSha: PUSH });
  });
  test("AC-3 gives no lineage for a line older than the push's base", async () => {
    const { runGit } = stubGit({
      blame: blamed(BLAMED),
      ancestry: { [`${PUSH}>${HEAD}`]: "yes", [`${BLAMED}>${PUSH}`]: "yes", [`${BLAMED}>${BASE}`]: "yes" },
    });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.lineage.has("f-x")).toBe(false);
    expect(result.unknown.size).toBe(0);
  });
  test("AC-4 takes its generation one past the highest parent generation", async () => {
    const items = [
      { key: "f-a", generation: 1, issue: "lock leaks" },
      { key: "f-b", generation: 2, issue: "fd leak" },
    ];
    const { runGit } = stubGit({ blame: blamed(PUSH), ancestry: { [`${PUSH}>${HEAD}`]: "yes" } });
    const result = await computeLineage(lineageInput({ entries: [entry({ items })] }), { runGit });
    expect(result.lineage.get("f-x")).toEqual({ generation: 3, parents: ["f-a", "f-b"], pushSha: PUSH });
  });
  test("AC-5 prefers the later of two matching pushes in the ledger order", async () => {
    const older = entry({
      sha: EARLIER_PUSH,
      base: OLDER_BASE,
      items: [{ key: "f-old", generation: 0, issue: "old" }],
    });
    const newer = entry({ sha: PUSH, base: BASE, items: [{ key: "f-new", generation: 1, issue: "new" }] });
    const { runGit } = stubGit({
      blame: blamed(BLAMED),
      ancestry: {
        [`${EARLIER_PUSH}>${HEAD}`]: "yes",
        [`${PUSH}>${HEAD}`]: "yes",
        [`${BLAMED}>${EARLIER_PUSH}`]: "yes",
        [`${BLAMED}>${OLDER_BASE}`]: "no",
        [`${BLAMED}>${PUSH}`]: "yes",
        [`${BLAMED}>${BASE}`]: "no",
      },
    });
    const result = await computeLineage(lineageInput({ entries: [older, newer] }), { runGit });
    expect(result.lineage.get("f-x")).toEqual({ generation: 2, parents: ["f-new"], pushSha: PUSH });
  });
});

describe("computeLineage history gaps", () => {
  test("AC-6 skips a push the head cannot reach and counts it", async () => {
    const { runGit, calls } = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: "no" } });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.unreachable).toBe(1);
    expect(result.lineage.size).toBe(0);
    expect(calls.some((args) => args[0] === "blame")).toBe(false);
  });
  test("AC-7 reports a finding whose blame failed as unknown, with no lineage", async () => {
    const { runGit } = stubGit({
      blame: { exitCode: 128, stdout: "", stderr: "fatal: no such path" },
      ancestry: { [`${PUSH}>${HEAD}`]: "yes" },
    });
    const result = await computeLineage(lineageInput(), { runGit });
    expect([...result.unknown]).toEqual(["f-x"]);
    expect(result.lineage.has("f-x")).toBe(false);
  });
  test("AC-8 runs no blame for a finding with no file or no line", async () => {
    const { runGit, calls } = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: "yes" } });
    const result = await computeLineage(
      lineageInput({ targets: [{ key: "no-file" }, { key: "no-line", file: FILE }] }),
      { runGit },
    );
    expect(calls.some((args) => args[0] === "blame")).toBe(false);
    expect(result.lineage.size).toBe(0);
    expect(result.unknown.size).toBe(0);
  });
  test("AC-9 asks git blame for exactly the finding's line and file at the head", async () => {
    const { runGit, calls } = stubGit({ blame: blamed(PUSH), ancestry: { [`${PUSH}>${HEAD}`]: "yes" } });
    await computeLineage(lineageInput(), { runGit });
    expect(calls).toContainEqual(["blame", "--porcelain", "-L", "12,12", HEAD, "--", FILE]);
  });
  test("AC-22 counts an entry whose reachability check failed as unreachable, not as unknown", async () => {
    const { runGit } = stubGit({ ancestry: { [`${PUSH}>${HEAD}`]: "error" } });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.unreachable).toBe(1);
    expect(result.unknown.size).toBe(0);
    expect(result.lineage.size).toBe(0);
  });
  test.each([
    ["a non-0/1 exit code", "error" as const],
    ["a spawn failure", "throw" as const],
  ])("AC-23 records a finding whose matching ancestry check hit %s as unknown", async (_name, failure) => {
    const { runGit: stub } = stubGit({
      blame: blamed(BLAMED),
      ancestry: { [`${PUSH}>${HEAD}`]: "yes", [`${BLAMED}>${PUSH}`]: "error" },
    });
    const runGit: LineageDeps["runGit"] =
      failure === "throw"
        ? async (args, workdir) => {
            if (args[2] === BLAMED) throw new Error("spawn git ENOENT");
            return stub(args, workdir);
          }
        : stub;
    const result = await computeLineage(lineageInput(), { runGit });
    expect([...result.unknown]).toEqual(["f-x"]);
    expect(result.lineage.has("f-x")).toBe(false);
    expect(result.unreachable).toBe(0);
  });
  test("AC-23 GIVEN a plain exit 1 from the matching check THEN the finding is simply not matched", async () => {
    const { runGit } = stubGit({
      blame: blamed(BLAMED),
      ancestry: { [`${PUSH}>${HEAD}`]: "yes", [`${BLAMED}>${PUSH}`]: "no" },
    });
    const result = await computeLineage(lineageInput(), { runGit });
    expect(result.unknown.size).toBe(0);
    expect(result.lineage.has("f-x")).toBe(false);
  });
  test("records nothing when the ledger holds no entry and asks git nothing", async () => {
    const { runGit, calls } = stubGit();
    const result = await computeLineage(lineageInput({ entries: [] }), { runGit });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ unreachable: 0 });
    expect(result.lineage.size).toBe(0);
  });
});
