/**
 * US-001 (SPEC-workflow-record-promote): the decisions sidecar module that `nax workflow record`
 * and `nax workflow promote` share — entry validation, the item cross-check, the merge and the two
 * file helpers.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { assertDefined, assertNaxError, withTempDir } from "@test/helpers";
import {
  checkEntriesAgainstItems,
  type DecisionEntry,
  type DecisionsSidecar,
  isoStamp,
  mergeDecisions,
  newestSidecar,
  parseDecisionEntries,
  sidecarFileName,
  sidecarKindFor,
  writeSidecar,
} from "@/workflow/decisions-sidecar";
import type { OpenItem } from "@/workflow/types";

/** A valid entry; every validation case overrides exactly one field. */
const entry = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: "B1",
  kind: "finding",
  disposition: "fixed",
  reason: "retry path fixed",
  sha: "a1b2c3d",
  ...over,
});

/** A valid sidecar. */
const sidecar = (over: Partial<DecisionsSidecar> = {}): DecisionsSidecar => ({
  artifact: "run-1/result.json",
  feature: "auth",
  resumedAt: "2026-10-13T09-12-00-417Z",
  reasons: ["a ruling is held"],
  decisions: [entry()],
  outcome: "pending",
  ...over,
});

/** An open item as the run's verdict lists it. */
const openItem = (id: string, kind: OpenItem["kind"]): OpenItem => ({ id, kind, issue: `${id} is open` });

/** The open-item kinds a sidecar entry maps to itself (every kind the run lists but `ruling`). */
const SELF_KINDS: readonly Exclude<OpenItem["kind"], "ruling">[] = [
  "finding",
  "advisor",
  "gate",
  "ci",
  "story",
  "cannot-verify",
  "reason",
];

/**
 * Runs `run`, requiring a `WORKFLOW_DECISIONS_INVALID` NaxError, and returns its message so each AC
 * can pin the exact text. Fails the test when nothing was thrown at all.
 */
function invalidMessage(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("WORKFLOW_DECISIONS_INVALID");
  return caught.message;
}

/** The async twin of `invalidMessage`, for the file helpers: the refusal, as its message. */
async function invalidMessageOf(run: () => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("WORKFLOW_DECISIONS_INVALID");
  return caught.message;
}

/** The refusal `newestSidecar` gives for this run directory, as its message. */
async function sidecarFailure(runDir: string): Promise<string> {
  return invalidMessageOf(() => newestSidecar(runDir));
}

describe("parseDecisionEntries", () => {
  test("AC-1: returns the one valid entry unchanged", () => {
    const raw = [{ id: "B1", kind: "finding", disposition: "fixed", reason: "retry path fixed", sha: "a1b2c3d" }];
    expect(parseDecisionEntries(raw)).toEqual([
      { id: "B1", kind: "finding", disposition: "fixed", reason: "retry path fixed", sha: "a1b2c3d" },
    ]);
  });

  test("AC-2: rejects anything that is not a JSON array", () => {
    expect(invalidMessage(() => parseDecisionEntries({ decisions: [] }))).toBe("decisions must be a JSON array");
  });

  test("AC-3: names the entry by position when its id is not a non-empty string", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ id: "" })]))).toBe(
      "decision 1: id must be a non-empty string",
    );
  });

  test("AC-4: rejects a disposition outside the vocabulary", () => {
    expect(invalidMessage(() => parseDecisionEntries([{ ...entry(), disposition: "accepted" }]))).toBe(
      "decision B1: disposition must be one of fixed, waived, confirmed, overridden, verified",
    );
  });

  test("AC-5: a fixed entry requires a sha", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ sha: undefined })]))).toBe(
      "decision B1: disposition fixed requires a sha",
    );
  });

  test("AC-6: a sha on a non-fixed entry is refused", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ disposition: "waived", sha: "a1b2c3d" })]))).toBe(
      "decision B1: sha is only allowed when disposition is fixed",
    );
  });

  test("AC-7: a sha that is not 7 to 40 hex characters is refused", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ sha: "xyz" })]))).toBe(
      "decision B1: sha must be 7 to 40 hex characters",
    );
  });

  test("AC-8: a reason with a second line is refused", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ reason: "line one\nline two" })]))).toBe(
      "decision B1: reason must be one non-empty line",
    );
  });

  test("AC-9: a blank reason is refused", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry({ reason: "   " })]))).toBe(
      "decision B1: reason must be one non-empty line",
    );
  });

  test("AC-10: a repeated id is refused", () => {
    expect(invalidMessage(() => parseDecisionEntries([entry(), entry({ reason: "a second reason" })]))).toBe(
      "decision B1 appears twice",
    );
  });

  test("AC-11: rejects a kind outside the sidecar vocabulary", () => {
    expect(invalidMessage(() => parseDecisionEntries([{ ...entry(), kind: "bug" }]))).toBe(
      "decision B1: kind must be one of finding, advisor, gate, ci, story, cannot-verify, minor, reason",
    );
  });

  test("an empty array is valid, and a non-object entry is named by position", () => {
    expect(parseDecisionEntries([])).toEqual([]);
    expect(invalidMessage(() => parseDecisionEntries([entry(), "B2"]))).toBe(
      "decision 2: id must be a non-empty string",
    );
  });
});

describe("sidecarKindFor", () => {
  test("AC-12: a ruling item is an advisor entry; a finding item is a finding entry", () => {
    expect(sidecarKindFor(openItem("D-1", "ruling"))).toBe("advisor");
    expect(sidecarKindFor(openItem("B1", "finding"))).toBe("finding");
  });

  test("AC-12: every kind but ruling maps to itself", () => {
    for (const kind of SELF_KINDS) {
      expect(sidecarKindFor(openItem("X-1", kind))).toBe(kind);
    }
  });
});

describe("checkEntriesAgainstItems", () => {
  test("AC-13: an unknown id names the open ids", () => {
    const items = [openItem("B1", "finding"), openItem("B2", "finding")];
    expect(invalidMessage(() => checkEntriesAgainstItems([entry({ id: "B9" })], items))).toBe(
      "unknown item B9; open items: B1, B2",
    );
  });

  test("AC-14: with no open items at all, the open ids read as none", () => {
    expect(invalidMessage(() => checkEntriesAgainstItems([entry({ id: "B9" })], []))).toBe(
      "unknown item B9; open items: none",
    );
  });

  test("AC-15: a ci entry and a minor entry may name no open item", () => {
    const entries = [
      entry({ id: "check:e2e", kind: "ci", disposition: "verified", sha: undefined }),
      entry({ id: "m1", kind: "minor", disposition: "waived", sha: undefined }),
    ];
    expect(() => checkEntriesAgainstItems(entries, [openItem("B1", "finding")])).not.toThrow();
  });

  test("AC-16: an entry whose kind disagrees with the item it names is refused", () => {
    expect(
      invalidMessage(() => checkEntriesAgainstItems([entry({ kind: "advisor" })], [openItem("B1", "finding")])),
    ).toBe("decision B1 has kind advisor but the open item is finding");
  });

  test("a ruling item is named by an advisor entry, and a ci item by a ci entry", () => {
    expect(() =>
      checkEntriesAgainstItems(
        [entry({ id: "D-1", kind: "advisor", disposition: "confirmed", sha: undefined })],
        [openItem("D-1", "ruling")],
      ),
    ).not.toThrow();
    expect(() =>
      checkEntriesAgainstItems(
        [entry({ id: "_run:ci", kind: "ci", disposition: "verified", sha: undefined })],
        [openItem("_run:ci", "ci")],
      ),
    ).not.toThrow();
  });
});

describe("mergeDecisions", () => {
  test("AC-17: an incoming entry replaces the one it names, keeping its position", () => {
    const existing = [entry({ id: "B1" }), entry({ id: "B2", reason: "the old reason" })];
    const incoming = [entry({ id: "B2", reason: "the new reason" }), entry({ id: "B3" })];
    expect(mergeDecisions(existing, incoming).map((e) => e.id)).toEqual(["B1", "B2", "B3"]);
    expect(mergeDecisions(existing, incoming)[1]?.reason).toBe("the new reason");
  });

  test("the merged list copies: neither input is mutated", () => {
    const existing = [entry({ id: "B1" })];
    const incoming = [entry({ id: "B2" }), entry({ id: "B1", reason: "the new reason" })];
    mergeDecisions(existing, incoming);
    expect(existing).toEqual([entry({ id: "B1" })]);
    expect(incoming).toEqual([entry({ id: "B2" }), entry({ id: "B1", reason: "the new reason" })]);
  });

  test("nothing incoming leaves the existing entries in place", () => {
    expect(mergeDecisions([entry({ id: "B1" })], [])).toEqual([entry({ id: "B1" })]);
  });
});

describe("isoStamp and sidecarFileName", () => {
  test("AC-18: the file name is the stamp with ':' and '.' replaced by '-'", () => {
    expect(sidecarFileName(new Date("2026-10-13T09:12:00.417Z"))).toBe("decisions-2026-10-13T09-12-00-417Z.json");
  });

  test("isoStamp is the UTC form the resumedAt field carries", () => {
    expect(isoStamp(new Date("2026-10-13T09:12:00.417Z"))).toBe("2026-10-13T09-12-00-417Z");
    expect(isoStamp(new Date("2026-10-13T09:12:00.417Z"))).not.toContain(":");
  });
});

describe("newestSidecar and writeSidecar", () => {
  test("AC-19: returns the newest sidecar with its parsed contents, and null when the run has none", async () => {
    await withTempDir(async (runDir) => {
      const older = join(runDir, "decisions-2026-10-13T09-12-00-000Z.json");
      const newer = join(runDir, "decisions-2026-10-14T10-00-00-000Z.json");
      const olderSidecar = sidecar({ resumedAt: "2026-10-13T09-12-00-000Z", outcome: "pending" });
      const newerSidecar = sidecar({ resumedAt: "2026-10-14T10-00-00-000Z", outcome: "promoted" });
      await Bun.write(join(runDir, "result.json"), "{}\n");
      await Bun.write(older, JSON.stringify(olderSidecar));
      await Bun.write(newer, JSON.stringify(newerSidecar));

      expect(await newestSidecar(runDir)).toEqual({ path: newer, sidecar: newerSidecar });
    });

    await withTempDir(async (runDir) => {
      await Bun.write(join(runDir, "result.json"), "{}\n");
      expect(await newestSidecar(runDir)).toBeNull();
    });
  });

  test("AC-20: a written sidecar reads back, and no other file is left in the run directory", async () => {
    await withTempDir(async (runDir) => {
      const path = join(runDir, sidecarFileName(new Date("2026-10-13T09:12:00.417Z")));
      await Bun.write(join(runDir, "result.json"), "{}\n");
      const before = await readdir(runDir);
      const written = sidecar();

      await writeSidecar(path, written);

      expect(await newestSidecar(runDir)).toEqual({ path, sidecar: written });
      const after = await readdir(runDir);
      expect([...after].sort(byCodePoint)).toEqual(
        [...before, "decisions-2026-10-13T09-12-00-417Z.json"].sort(byCodePoint),
      );
    });
  });

  test("newestSidecar ignores every file that is not a decisions-*.json", async () => {
    await withTempDir(async (runDir) => {
      await Bun.write(join(runDir, "result.json"), "{}\n");
      await Bun.write(join(runDir, "notes.txt"), "x\n");
      await Bun.write(join(runDir, "decisions-2026-10-14T10-00-00-000Z.json.tmp"), JSON.stringify(sidecar()));
      expect(await newestSidecar(runDir)).toBeNull();
    });
  });

  test("the newest sidecar is validated rather than trusted: an invalid entry is refused", async () => {
    await withTempDir(async (runDir) => {
      const path = join(runDir, "decisions-2026-10-14T10-00-00-000Z.json");
      const handWritten = { ...sidecar(), decisions: [{ ...entry(), disposition: "accepted" }] };
      await Bun.write(path, JSON.stringify(handWritten));

      expect(await sidecarFailure(runDir)).toBe(
        `invalid decisions sidecar ${path}: decision B1: disposition must be one of fixed, waived, confirmed, overridden, verified`,
      );
    });
  });

  test("a persisted sidecar missing a field is refused, naming the field", async () => {
    await withTempDir(async (runDir) => {
      const path = join(runDir, "decisions-2026-10-14T10-00-00-000Z.json");
      const cases: readonly { readonly body: string; readonly detail: string }[] = [
        {
          body: JSON.stringify({ ...sidecar(), outcome: "done" }),
          detail: "outcome must be one of pending, promoted, verified-ready, abandoned",
        },
        { body: JSON.stringify({ ...sidecar(), artifact: "" }), detail: "artifact must be a non-empty string" },
        { body: JSON.stringify({ ...sidecar(), feature: 7 }), detail: "feature must be a non-empty string" },
        {
          body: JSON.stringify({ ...sidecar(), resumedAt: undefined }),
          detail: "resumedAt must be a non-empty string",
        },
        { body: JSON.stringify({ ...sidecar(), reasons: "none" }), detail: "reasons must be an array of strings" },
        { body: JSON.stringify({ ...sidecar(), url: 7 }), detail: "url must be a string" },
        {
          body: JSON.stringify({ ...sidecar(), decisions: { B1: "fixed" } }),
          detail: "decisions must be a JSON array",
        },
      ];
      for (const one of cases) {
        await Bun.write(path, one.body);
        expect(await sidecarFailure(runDir)).toBe(`invalid decisions sidecar ${path}: ${one.detail}`);
      }
    });
  });

  test("the newest candidate is authoritative: an unparsable one is refused, not skipped", async () => {
    await withTempDir(async (runDir) => {
      const older = join(runDir, "decisions-2026-10-13T09-12-00-000Z.json");
      const newest = join(runDir, "decisions-2026-10-14T10-00-00-000Z.json");
      await Bun.write(older, JSON.stringify(sidecar({ resumedAt: "2026-10-13T09-12-00-000Z" })));

      await Bun.write(newest, "{not json");
      expect(await sidecarFailure(runDir)).toBe(`invalid decisions sidecar ${newest}: unreadable or not valid JSON`);

      await Bun.write(newest, "[]");
      expect(await sidecarFailure(runDir)).toBe(`invalid decisions sidecar ${newest}: not a JSON object`);
    });
  });

  test("a run directory that does not exist has no sidecar", async () => {
    await withTempDir(async (runDir) => {
      expect(await newestSidecar(join(runDir, "no-such-run"))).toBeNull();
    });
  });

  test("writeSidecar creates the run directory it is given", async () => {
    await withTempDir(async (runDir) => {
      const path = join(runDir, "run-9", sidecarFileName(new Date("2026-10-13T09:12:00.417Z")));
      await writeSidecar(path, sidecar());
      expect((await newestSidecar(join(runDir, "run-9")))?.path).toBe(path);
    });
  });
});

describe("writeSidecar under concurrent writers", () => {
  test("every concurrent write to one sidecar publishes whole, and no temporary file is left behind", async () => {
    await withTempDir(async (runDir) => {
      const path = join(runDir, sidecarFileName(new Date("2026-10-13T09:12:00.417Z")));
      await Bun.write(join(runDir, "result.json"), "{}\n");
      // One distinct sidecar per writer, so the winner is identifiable and every writer is observable.
      const writers = Array.from({ length: 16 }, (_, i) =>
        sidecar({ decisions: [entry({ reason: `ruling ${i}`, sha: `a1b2c3${i.toString(16)}` })] }),
      );

      const settled = await Promise.allSettled(writers.map((one) => writeSidecar(path, one)));

      expect(settled.map((one) => (one.status === "rejected" ? String(one.reason) : "ok"))).toEqual(
        writers.map(() => "ok"),
      );
      const after = await readdir(runDir);
      expect([...after].sort(byCodePoint)).toEqual(["result.json", basename(path)].sort(byCodePoint));
      const found = await newestSidecar(runDir);
      assertDefined(found, "the sidecar the writers published");
      expect(writers).toContainEqual(found.sidecar);
    });
  });

  test("a write that cannot be published removes its own temporary file", async () => {
    await withTempDir(async (runDir) => {
      // Renaming a file over a directory fails; the temporary sibling must not survive the attempt.
      const target = join(runDir, "decisions-target");
      await mkdir(target);

      await expect(writeSidecar(target, sidecar())).rejects.toThrow();
      expect(await readdir(runDir)).toEqual(["decisions-target"]);
      expect(await readdir(target)).toEqual([]);
    });
  });
});
