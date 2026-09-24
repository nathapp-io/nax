/**
 * `nax approvals rm --all` — guarded full revocation and store-failure mapping (US-006).
 *
 * Split from `approvals-rm.test.ts` by concern: that file pins the id / `--stage`
 * selectors (US-005), this one pins the `--all` guard and the store-error surface.
 *
 * AC1-AC2:   `all: true, yes: true` empties the store and never consults `deps.confirm`.
 * AC3:       `yes: false` on a TTY consults the prompt once; a `true` answer empties the store.
 * AC4-AC6:   a `false` answer resolves to 1, writes `Aborted` on stderr and leaves the bytes alone.
 * AC7-AC9:   `yes: false` with `deps.isTTY()` false refuses without prompting and without a write.
 * AC10-AC12: a missing store prints `No remembered approvals at <path>` on stdout, resolves to 0
 *            and never prompts.
 * AC13-AC15: an existing store with no entries does the same.
 * AC16-AC18: an unparseable store resolves to 1, writes
 *            `approvals.json could not be parsed; not rewriting it` on stderr and is not rewritten.
 * AC19:      a removal that drops a malformed array element reports `<n> malformed entries dropped`.
 * AC20-AC23: a `deps.removeApprovals` rejection is mapped to one actionable stderr line —
 *            `a nax run is writing <path>; retry` for a `FILE_LOCK_TIMEOUT` `NaxError`,
 *            `Failed to update <path>: <message>` for anything else — with exit 1 either way.
 *
 * Hermetic by construction: every store lives in a temp outputDir reached through a temp
 * workdir's `.nax/config.json`; stdout, stderr, the confirmation answer and the exit code are
 * captured through the injected `_approvalsCliDeps` seam, so nothing touches the real console,
 * `process.exit`, a real TTY, or any path outside the temp dir. The confirmation gate is driven
 * by the injected `deps.confirm` / `deps.isTTY`, never by a real prompt.
 *
 * The two refusals that a *negative* control would otherwise pass for free (`deps.confirm` not
 * invoked, bytes unchanged) each carry a companion assertion from the same scenario, so a run
 * that never reaches the branch under test still fails here.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _approvalsCliDeps, approvalsRmCommand, resolveApprovalsFile } from "@/cli/approvals";
import { NaxError } from "@/errors";
import {
  type ApprovalEntry,
  type ApprovalsFileRead,
  approvalsPath,
  type RemovalDecision,
  type RemovalResult,
  readApprovals,
} from "@/permissions";

type CliDeps = typeof _approvalsCliDeps;

const PROJECT_NAME = "approvals-rm-all";

/** The refusal `removeApprovals` reports for a store whose bytes it cannot parse (US-002). */
const PARSE_REFUSAL = "approvals.json could not be parsed; not rewriting it";
/** The single stderr line for a declined or impossible confirmation. */
const ABORTED = "Aborted";

/** `No remembered approvals at <path>` — the precheck notice for an empty or missing store. */
const missingNotice = (path: string): string => `No remembered approvals at ${path}`;
/** The `<n> malformed entries dropped` line a rewriting removal prints. */
const malformedDropped = (n: number): string => `${n} malformed entries dropped`;
/** The locked-store line: another nax run is mid-write. */
const lockTimeoutLine = (path: string): string => `a nax run is writing ${path}; retry`;
/** The catch-all store-failure line. */
const updateFailedLine = (path: string, message: string): string => `Failed to update ${path}: ${message}`;

function makeEntry(overrides: Partial<ApprovalEntry> = {}): ApprovalEntry {
  return {
    stage: "execution",
    command: "bun run test",
    root: "/repo",
    origin: "escalate",
    matchedRule: null,
    approvedAt: "2026-09-22T10:00:00.000Z",
    approvedBy: "telegram:123",
    naxCommit: "7b37dbf74",
    ...overrides,
  };
}

function makeConfirmStub(resolves: boolean) {
  return mock(async (_question: string): Promise<boolean> => resolves);
}

type ConfirmStub = ReturnType<typeof makeConfirmStub>;

/** A `removeApprovals` stub that rejects with `err` — the failure-mapping seam. */
function makeRejectingRemoveStub(err: Error): CliDeps["removeApprovals"] {
  return mock(async (_path: string, _decide: (read: ApprovalsFileRead) => RemovalDecision): Promise<RemovalResult> => {
    throw err;
  });
}

/** A `removeApprovals` stub reporting one removed entry and `droppedMalformed` drops. */
function makeRemovedStub(entry: ApprovalEntry, droppedMalformed: number): CliDeps["removeApprovals"] {
  return mock(
    async (_path: string, _decide: (read: ApprovalsFileRead) => RemovalDecision): Promise<RemovalResult> => ({
      outcome: "removed",
      removed: [entry],
      droppedMalformed,
    }),
  );
}

// ---------------------------------------------------------------------------
// Harness — captures stdout, stderr and exit codes through the injected deps so
// the real streams, the real prompt and `process.exit` are never used.
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /** `deps.isTTY()` — `false` (no terminal) unless a test asks for one. */
  readonly isTTY?: boolean;
  /** What the injected confirmation prompt answers when it IS consulted. */
  readonly confirmResolves?: boolean;
  readonly removeApprovals?: CliDeps["removeApprovals"];
}

interface Harness {
  readonly deps: CliDeps;
  readonly confirm: ConfirmStub;
  readonly exitCodes: readonly number[];
  stdout(): string;
  stderr(): string;
  stdoutLines(): readonly string[];
  stderrLines(): readonly string[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const confirm = makeConfirmStub(options.confirmResolves ?? true);

  const deps: CliDeps = {
    ..._approvalsCliDeps,
    // No real TTY and no liveness probe: a probe would reach a real pid.
    isTTY: () => options.isTTY ?? false,
    isProcessAlive: () => false,
    confirm,
    log: (text: string) => {
      out.push(text);
    },
    logErr: (text: string) => {
      err.push(text);
    },
    exit: (code: number) => {
      exitCodes.push(code);
    },
    ...(options.removeApprovals === undefined ? {} : { removeApprovals: options.removeApprovals }),
  };

  return {
    deps,
    confirm,
    exitCodes,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    // Split on newlines so one `log` call carrying a multi-line string still reads as lines.
    stdoutLines: () => (out.length === 0 ? [] : out.join("\n").split("\n")),
    stderrLines: () => (err.length === 0 ? [] : err.join("\n").split("\n")),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — a temp workdir whose `.nax/config.json` names the project and
// points an absolute outputDir inside the same temp dir.
// ---------------------------------------------------------------------------

interface StoreFixture {
  readonly workdir: string;
  readonly outputDir: string;
  readonly storePath: string;
}

/** A named project with NO store on disk (the missing-store cases). */
async function withProject(fn: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const workdir = join(dir, "project");
    const outputDir = join(dir, "out");
    await mkdir(join(workdir, ".nax"), { recursive: true });
    await Bun.write(join(workdir, ".nax", "config.json"), JSON.stringify({ name: PROJECT_NAME, outputDir }));
    await fn({ workdir, outputDir, storePath: approvalsPath(outputDir) });
  });
}

/** Serialize a store the way the store writer does, so a read sees exactly `entries`. */
function storeBody(entries: readonly ApprovalEntry[]): string {
  return `${JSON.stringify({ entries }, null, 2)}\n`;
}

async function withStore(
  entries: readonly ApprovalEntry[],
  fn: (fixture: StoreFixture) => Promise<void>,
): Promise<void> {
  await withProject(async (fixture) => {
    await mkdir(dirname(fixture.storePath), { recursive: true });
    await Bun.write(fixture.storePath, storeBody(entries));
    await fn(fixture);
  });
}

/** Raw bytes on disk — for the unparseable and mixed-element stores. */
async function withRawStore(body: string, fn: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await withProject(async (fixture) => {
    await mkdir(dirname(fixture.storePath), { recursive: true });
    await Bun.write(fixture.storePath, body);
    await fn(fixture);
  });
}

/** The store's bytes straight off disk — for the "unchanged" pins. */
async function storeBytes(path: string): Promise<string> {
  return Bun.file(path).text();
}

// ---------------------------------------------------------------------------
// Driving the surface under test
// ---------------------------------------------------------------------------

async function runRm(
  fixture: StoreFixture,
  harness: Harness,
  options: { readonly yes: boolean } = { yes: false },
): Promise<number> {
  return approvalsRmCommand({ workdir: fixture.workdir, ids: [], all: true, yes: options.yes }, harness.deps);
}

/**
 * `runRm`, with a rejection mapped to `NaN`. AC20-AC23 pin a store error being
 * turned into a stderr line plus exit 1, so a command that lets the error escape
 * as a rejection must fail at the AC's own assertion rather than abort the test
 * with an unhandled throw before it gets there.
 */
async function runRmToleratingRejection(
  fixture: StoreFixture,
  harness: Harness,
  options: { readonly yes: boolean },
): Promise<number> {
  try {
    return await runRm(fixture, harness, options);
  } catch {
    // The escape IS the defect under test; `NaN` reports it at the assertion.
    return Number.NaN;
  }
}

// ---------------------------------------------------------------------------
// AC1-AC9: the confirmation gate
// ---------------------------------------------------------------------------

describe("US-006 approvalsRmCommand --all — confirmation", () => {
  test("AC1: with all:true, yes:true the store is left empty", async () => {
    const first = makeEntry({ approvedAt: "2026-09-22T10:00:00.000Z" });
    const second = makeEntry({ command: "bun run lint", approvedAt: "2026-09-22T10:05:00.000Z" });

    await withStore([first, second], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { yes: true });

      expect(await readApprovals(fixture.storePath)).toEqual([]);
    });
  });

  test("AC2: with all:true, yes:true does not invoke deps.confirm", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      // The injected prompt would DECLINE. Skipping it must still revoke, so a
      // `--yes` that quietly deferred to the prompt cannot pass this test.
      const harness = makeHarness({ confirmResolves: false });

      await runRm(fixture, harness, { yes: true });

      expect(harness.confirm.mock.calls).toHaveLength(0);
      expect(await readApprovals(fixture.storePath)).toEqual([]);
    });
  });

  test("AC3: on a TTY whose deps.confirm resolves true, the store is left empty", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });

      await runRm(fixture, harness, { yes: false });

      // The gate has to be the prompt's: an `--all` that revoked without asking
      // would leave the store empty too, so the invocation itself is pinned.
      expect(harness.confirm.mock.calls).toHaveLength(1);
      expect(await readApprovals(fixture.storePath)).toEqual([]);
    });
  });

  test("AC4: on a TTY whose deps.confirm resolves false, resolves to 1", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: false });

      const code = await runRm(fixture, harness, { yes: false });

      expect(code).toBe(1);
    });
  });

  test("AC5: on a TTY whose deps.confirm resolves false, writes 'Aborted' to stderr", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: false });

      await runRm(fixture, harness, { yes: false });

      expect(harness.stderrLines()).toContain(ABORTED);
    });
  });

  test("AC6: on a TTY whose deps.confirm resolves false, the store's bytes are unchanged", async () => {
    const entry = makeEntry();
    const kept = makeEntry({ stage: "review", approvedAt: "2026-09-22T11:00:00.000Z" });

    await withStore([entry, kept], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: false });
      const before = await storeBytes(fixture.storePath);

      await runRm(fixture, harness, { yes: false });

      // Guard: the untouched bytes must be the DECLINED prompt's doing. Without
      // this, a run that never asked would satisfy the byte comparison by
      // accident and pin nothing about the declined branch.
      expect(harness.confirm.mock.calls).toHaveLength(1);
      expect(await storeBytes(fixture.storePath)).toBe(before);
      expect(await readApprovals(fixture.storePath)).toEqual([entry, kept]);
    });
  });

  test("AC7: without a TTY and without --yes, resolves to 1", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ isTTY: false, confirmResolves: true });

      const code = await runRm(fixture, harness, { yes: false });

      expect(code).toBe(1);
    });
  });

  test("AC8: without a TTY and without --yes, writes 'Aborted' to stderr", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ isTTY: false, confirmResolves: true });

      await runRm(fixture, harness, { yes: false });

      expect(harness.stderrLines()).toContain(ABORTED);
    });
  });

  test("AC9: without a TTY and without --yes, does not invoke deps.confirm", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      // The prompt would ANSWER YES. Refusing without asking is the point, so a
      // run that consulted it anyway would revoke and fail the second assertion.
      const harness = makeHarness({ isTTY: false, confirmResolves: true });
      const before = await storeBytes(fixture.storePath);

      const code = await runRm(fixture, harness, { yes: false });

      expect(harness.confirm.mock.calls).toHaveLength(0);
      expect(code).toBe(1);
      expect(await storeBytes(fixture.storePath)).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// AC10-AC15: nothing to revoke — reported before any prompt
// ---------------------------------------------------------------------------

describe("US-006 approvalsRmCommand --all — nothing to revoke", () => {
  test("AC10: a missing store writes 'No remembered approvals at <path>' to stdout", async () => {
    await withProject(async (fixture) => {
      // A TTY whose prompt would CONFIRM: the precheck must short-circuit before it.
      const harness = makeHarness({ isTTY: true, confirmResolves: true });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRm(fixture, harness, { yes: false });

      expect(harness.stdoutLines()).toContain(missingNotice(path));
    });
  });

  test("AC11: a missing store resolves to 0", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });

      const code = await runRm(fixture, harness, { yes: false });

      expect(code).toBe(0);
      expect(await Bun.file(fixture.storePath).exists()).toBe(false);
    });
  });

  test("AC12: a missing store does not invoke deps.confirm", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRm(fixture, harness, { yes: false });

      expect(harness.confirm.mock.calls).toHaveLength(0);
      expect(harness.stdoutLines()).toContain(missingNotice(path));
    });
  });

  test("AC13: an existing store with no entries writes 'No remembered approvals at <path>' to stdout", async () => {
    await withStore([], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRm(fixture, harness, { yes: false });

      expect(harness.stdoutLines()).toContain(missingNotice(path));
    });
  });

  test("AC14: an existing store with no entries resolves to 0", async () => {
    await withStore([], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });

      const code = await runRm(fixture, harness, { yes: false });

      expect(code).toBe(0);
      expect(await readApprovals(fixture.storePath)).toEqual([]);
    });
  });

  test("AC15: an existing store with no entries does not invoke deps.confirm", async () => {
    await withStore([], async (fixture) => {
      const harness = makeHarness({ isTTY: true, confirmResolves: true });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRm(fixture, harness, { yes: false });

      expect(harness.confirm.mock.calls).toHaveLength(0);
      expect(harness.stdoutLines()).toContain(missingNotice(path));
    });
  });
});

// ---------------------------------------------------------------------------
// AC16-AC18: an unparseable store is refused, not rewritten
// ---------------------------------------------------------------------------

describe("US-006 approvalsRmCommand --all — unparseable store", () => {
  test("AC16: resolves to 1", async () => {
    await withRawStore("{ not json", async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { yes: true });

      expect(code).toBe(1);
    });
  });

  test("AC17: writes 'approvals.json could not be parsed; not rewriting it' to stderr", async () => {
    await withRawStore("{ not json", async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { yes: true });

      expect(harness.stderrLines()).toContain(PARSE_REFUSAL);
    });
  });

  test("AC18: leaves the store's bytes unchanged", async () => {
    await withRawStore("{ not json", async (fixture) => {
      const harness = makeHarness();
      const before = await storeBytes(fixture.storePath);

      await runRm(fixture, harness, { yes: true });

      expect(await storeBytes(fixture.storePath)).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// AC19: malformed elements dropped by a rewriting removal
// ---------------------------------------------------------------------------

describe("US-006 approvalsRmCommand — dropped malformed elements", () => {
  test("AC19: a removal that drops 1 malformed element writes '1 malformed entries dropped' to stderr", async () => {
    const entry = makeEntry();

    // The store really holds one malformed element beside the valid entry, and
    // the removal result reports the same count, so the line is pinned whichever
    // of the two the command reads it from.
    await withRawStore(`${JSON.stringify({ entries: [entry, null] }, null, 2)}\n`, async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRemovedStub(entry, 1) });

      const code = await runRm(fixture, harness, { yes: true });

      expect(code).toBe(0);
      expect(harness.stderrLines()).toContain(malformedDropped(1));
    });
  });

  test("AC19 boundary: a removal that drops nothing writes no malformed-dropped line", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRemovedStub(entry, 0) });

      await runRm(fixture, harness, { yes: true });

      expect(harness.stderrLines().some((line) => line.includes("malformed entries dropped"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC20-AC23: store failures become actionable stderr lines
// ---------------------------------------------------------------------------

describe("US-006 approvalsRmCommand — store failure mapping", () => {
  test("AC20: a FILE_LOCK_TIMEOUT NaxError resolves to 1", async () => {
    const lockError = new NaxError("Timed out acquiring path lock", "FILE_LOCK_TIMEOUT", {
      stage: "file-lock",
      lockName: "path",
    });

    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRejectingRemoveStub(lockError) });

      const code = await runRmToleratingRejection(fixture, harness, { yes: true });

      expect(code).toBe(1);
    });
  });

  test("AC21: a FILE_LOCK_TIMEOUT NaxError writes 'a nax run is writing <path>; retry' to stderr", async () => {
    const lockError = new NaxError("Timed out acquiring path lock", "FILE_LOCK_TIMEOUT", { stage: "file-lock" });

    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRejectingRemoveStub(lockError) });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRmToleratingRejection(fixture, harness, { yes: true });

      expect(harness.stderrLines()).toContain(lockTimeoutLine(path));
    });
  });

  test("AC22: an EACCES Error resolves to 1", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRejectingRemoveStub(new Error("EACCES")) });

      const code = await runRmToleratingRejection(fixture, harness, { yes: true });

      expect(code).toBe(1);
    });
  });

  test("AC23: an EACCES Error writes 'Failed to update <path>: EACCES' to stderr", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRejectingRemoveStub(new Error("EACCES")) });
      const path = await resolveApprovalsFile(fixture.workdir);

      await runRmToleratingRejection(fixture, harness, { yes: true });

      expect(harness.stderrLines()).toContain(updateFailedLine(path, "EACCES"));
    });
  });

  test("AC23 boundary: a non-lock failure leaves the store's bytes untouched", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness({ removeApprovals: makeRejectingRemoveStub(new Error("EACCES")) });
      const before = await storeBytes(fixture.storePath);

      const code = await runRmToleratingRejection(fixture, harness, { yes: true });

      expect(code).toBe(1);
      expect(await storeBytes(fixture.storePath)).toBe(before);
      expect(await readApprovals(fixture.storePath)).toEqual([entry]);
    });
  });
});
