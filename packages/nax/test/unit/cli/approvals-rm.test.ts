/**
 * `nax approvals rm` — atomic revocation by full entry id or by stage (US-005).
 *
 * AC1:       `registerApprovalsCommand` wires `approvals rm --stage <stage> -d <workdir>` to one
 *            `removeApprovals` call at the path `resolveApprovalsFile(workdir)` returns.
 * AC2-AC3:   `approvals rm <id> -d <workdir>` on a store holding that entry exits 0 and leaves
 *            the store without it.
 * AC4-AC5:   the stdout line `removed <id>  <stage>  <preview>`, where `<preview>` is the
 *            command's first line cut to 80 characters.
 * AC6:       several ids — exactly the entries whose ids were not given survive.
 * AC7-AC9:   one present id beside one absent id — exit 1, `Unknown id(s): <ids>` on stderr and
 *            the store's bytes untouched.
 * AC10-AC11: the same id against a store that does not exist — exit 1 and the same stderr line.
 * AC12-AC14: an id outside `^[0-9a-f]{8}$` — exit 1, `Invalid id: <id>` on stderr and no store
 *            access at all.
 * AC15-AC19: zero or several selectors — exit 1 with
 *            `Specify exactly one of <id...>, --stage <stage>, --all` on stderr, before the
 *            store is read.
 * AC20:      `--stage <stage>` removes exactly the entries whose `stage` is not `<stage>`.
 * AC21-AC22: a stage that matches nothing prints `No entries for stage <stage>` on stdout and
 *            resolves to 0.
 * AC23:      a removal by id leaves the store's taint exactly as it was read.
 *
 * Hermetic by construction: every store lives in a temp outputDir reached through a temp
 * workdir's `.nax/config.json`; stdout, stderr and the exit code are captured through the
 * injected `_approvalsCliDeps` seam, so nothing touches the real console, `process.exit`, a
 * foreign pid's liveness or any path outside the temp dir.
 *
 * `approvalsRmCommand` is resolved through the module namespace rather than a named import: the
 * export does not exist before this story, and in Bun a named import of a missing binding is a
 * link-time `SyntaxError` — the whole file would fail to load and report nothing about the
 * missing behaviour. Resolving it at call time turns that into an assertion failure naming the
 * absent export, so each AC below reports what the implementer must build. The interface places
 * it beside `registerApprovalsCommand`, so it is read from `@/cli/approvals`.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { firstCall, withTempDir } from "@test/helpers";
import { Command } from "commander";
import * as approvalsCli from "@/cli/approvals";
import { _approvalsCliDeps, registerApprovalsCommand, resolveApprovalsFile } from "@/cli/approvals";
import {
  type ApprovalEntry,
  type ApprovalsFileRead,
  type ApprovalsTaint,
  approvalId,
  approvalsPath,
  type RemovalDecision,
  type RemovalResult,
  readApprovals,
  readApprovalsFile,
} from "@/permissions";

type CliDeps = typeof _approvalsCliDeps;

const PROJECT_NAME = "approvals-rm";

const TAINT_SINCE = "2026-09-20T08:30:00.000Z";
const TAINT_RUN_ID = "run-7f3a";
const TAINT_PID = 4242;

/** Syntactically valid (8 lowercase hex) and present in no seeded store. */
const ABSENT_ID = "deadbeef";
/** Syntactically invalid: uppercase hex. */
const MALFORMED_ID = "A3F9C21E";
/** The one stderr line every selector-validation failure prints. */
const SELECTOR_MESSAGE = "Specify exactly one of <id...>, --stage <stage>, --all";
/** The cut the removal line applies to the command's first line. */
const PREVIEW_LIMIT = 80;

/** The signature the story's interface block declares. */
type RmCommand = (
  opts: {
    readonly workdir: string;
    readonly ids: readonly string[];
    readonly stage?: string;
    readonly all: boolean;
    readonly yes: boolean;
  },
  deps?: CliDeps,
) => Promise<number>;

/** The module surface, read as a plain object so the new export resolves at runtime. */
const approvalsCliSurface = approvalsCli as { approvalsRmCommand?: RmCommand };

/**
 * `approvalsRmCommand`, failing at an *assertion* (not a link-time error) while it is absent.
 * The `throw` is unreachable once the assertion passes; it exists to narrow the type.
 */
function approvalsRmCommand(): RmCommand {
  const fn = approvalsCliSurface.approvalsRmCommand;
  expect(typeof fn).toBe("function");
  if (typeof fn !== "function") {
    throw new Error("[approvals-rm] approvalsRmCommand is not exported from @/cli/approvals");
  }
  return fn;
}

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

// ---------------------------------------------------------------------------
// Harness — captures stdout, stderr and exit codes through the injected deps so
// the real streams and `process.exit` are never used.
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: CliDeps;
  readonly exitCodes: number[];
  stdout(): string;
  stderr(): string;
  stdoutLines(): readonly string[];
  stderrLines(): readonly string[];
}

function makeHarness(overrides: Partial<CliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];

  const deps: CliDeps = {
    ..._approvalsCliDeps,
    // No tty and no liveness probe: `rm` needs neither, and a probe would reach a real pid.
    isTTY: () => false,
    isProcessAlive: () => false,
    log: (text: string) => {
      out.push(text);
    },
    logErr: (text: string) => {
      err.push(text);
    },
    exit: (code: number) => {
      exitCodes.push(code);
    },
    ...overrides,
  };

  return {
    deps,
    exitCodes,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    // Split on newlines so one `log` call carrying a multi-line string still reads as lines.
    stdoutLines: () => (out.length === 0 ? [] : out.join("\n").split("\n")),
    stderrLines: () => (err.length === 0 ? [] : err.join("\n").split("\n")),
  };
}

/** A `removeApprovals` stub that removes nothing — for call-count and call-path assertions. */
function makeRemoveStub() {
  return mock(
    async (_path: string, _decide: (read: ApprovalsFileRead) => RemovalDecision): Promise<RemovalResult> => ({
      outcome: "unchanged",
    }),
  );
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
function storeBody(entries: readonly ApprovalEntry[], taint: ApprovalsTaint | undefined): string {
  const body = taint === undefined ? { entries } : { taint, entries };
  return `${JSON.stringify(body, null, 2)}\n`;
}

async function withStore(
  entries: readonly ApprovalEntry[],
  fn: (fixture: StoreFixture) => Promise<void>,
  taint?: ApprovalsTaint,
): Promise<void> {
  await withProject(async (fixture) => {
    await mkdir(dirname(fixture.storePath), { recursive: true });
    await Bun.write(fixture.storePath, storeBody(entries, taint));
    await fn(fixture);
  });
}

/** The store's bytes straight off disk — for the "unchanged" and "no file created" pins. */
async function storeBytes(path: string): Promise<string> {
  return Bun.file(path).text();
}

// ---------------------------------------------------------------------------
// Driving the surfaces under test
// ---------------------------------------------------------------------------

interface RmOptions {
  readonly ids?: readonly string[];
  readonly stage?: string;
  readonly all?: boolean;
  readonly yes?: boolean;
}

async function runRm(fixture: StoreFixture, harness: Harness, options: RmOptions = {}): Promise<number> {
  return approvalsRmCommand()(
    {
      workdir: fixture.workdir,
      ids: options.ids ?? [],
      stage: options.stage,
      all: options.all ?? false,
      yes: options.yes ?? false,
    },
    harness.deps,
  );
}

interface RegisteredProgram {
  readonly program: Command;
  readonly approvals: Command | undefined;
  readonly rm: Command | undefined;
}

function registeredProgram(harness: Harness): RegisteredProgram {
  const program = new Command();
  program.exitOverride();
  registerApprovalsCommand(program, harness.deps);
  const approvals = program.commands.find((c) => c.name() === "approvals");
  const rm = approvals?.commands.find((c) => c.name() === "rm");
  return { program, approvals, rm };
}

// ---------------------------------------------------------------------------
// AC1-AC3: the registered `approvals rm` command
// ---------------------------------------------------------------------------

describe("registerApprovalsCommand — approvals rm", () => {
  test("US-005: registers an 'approvals rm' subcommand exposing --stage, --all and -d/--dir", () => {
    const { rm } = registeredProgram(makeHarness());
    expect(rm).toBeDefined();
    if (!rm) return; // failed above: the subcommand is not registered

    const help = rm.helpInformation();
    expect(help).toContain("--stage");
    expect(help).toContain("--all");
    expect(help).toContain("--dir");
  });

  test("'approvals rm --help' does not leak the internal story tag into the user-facing --all or --yes description", () => {
    // Adversarial review: src/cli/approvals.ts:388-389 set the --all and --yes
    // descriptions to "Remove every remembered approval (US-006)" and
    // "Skip the confirmation prompt (US-006)", which puts the internal story
    // tag into the user-facing help output. Sibling options on this command
    // (--stage, -d/--dir) carry no such tag, and the approved-list help pins
    // the same rule for its --json description. Pin the spec here: the
    // substring "(US-" — the shape any internal story tag takes — must not
    // appear anywhere in the help text.
    const { rm } = registeredProgram(makeHarness());
    expect(rm).toBeDefined();
    if (!rm) return; // failed above: the subcommand is not registered

    const help = rm.helpInformation();
    expect(help).not.toContain("(US-");
  });

  test("AC1: 'approvals rm --stage execution -d <workdir>' invokes removeApprovals once at the resolved store path", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const removeStub = makeRemoveStub();
      const harness = makeHarness({ removeApprovals: removeStub });
      const { program, rm } = registeredProgram(harness);
      const expectedPath = await resolveApprovalsFile(fixture.workdir);

      expect(rm).toBeDefined();
      if (!rm) return; // failed above: the subcommand is not registered

      await program.parseAsync(["approvals", "rm", "--stage", "execution", "-d", fixture.workdir], { from: "user" });

      expect(removeStub.mock.calls).toHaveLength(1);
      const [path] = firstCall(removeStub, "removeApprovals stub");
      expect(path).toBe(expectedPath);
    });
  });

  test("AC2: 'approvals rm <id> -d <workdir>' on a store holding that entry calls deps.exit with 0", async () => {
    const entry = makeEntry();
    await withStore([entry], async (fixture) => {
      const harness = makeHarness();
      const { program, rm } = registeredProgram(harness);

      expect(rm).toBeDefined();
      if (!rm) return; // failed above: the subcommand is not registered

      await program.parseAsync(["approvals", "rm", approvalId(entry), "-d", fixture.workdir], { from: "user" });

      expect(harness.exitCodes).toEqual([0]);
    });
  });

  test("AC3: 'approvals rm <id> -d <workdir>' leaves the store without that entry", async () => {
    const entry = makeEntry();
    await withStore([entry], async (fixture) => {
      const harness = makeHarness();
      const { program, rm } = registeredProgram(harness);

      expect(rm).toBeDefined();
      if (!rm) return; // failed above: the subcommand is not registered

      await program.parseAsync(["approvals", "rm", approvalId(entry), "-d", fixture.workdir], { from: "user" });

      expect((await readApprovals(fixture.storePath)).map(approvalId)).not.toContain(approvalId(entry));
    });
  });
});

// ---------------------------------------------------------------------------
// AC4-AC5: the removal line
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — the removal line", () => {
  test("AC4: writes 'removed <id>  <stage>  <preview>' to stdout for a present id", async () => {
    const entry = makeEntry({ stage: "execution", command: "bun run test" });
    const id = approvalId(entry);

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [id] });

      expect(code).toBe(0);
      expect(harness.stdoutLines()).toContain(`removed ${id}  execution  bun run test`);
    });
  });

  test("AC4 boundary: the preview is the command's FIRST line for a multi-line command", async () => {
    const entry = makeEntry({ command: "set -e\nbun run lint\nbun run build" });
    const id = approvalId(entry);

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [id] });

      const lines = harness.stdoutLines();
      expect(lines).toContain(`removed ${id}  execution  set -e`);
      expect(lines.some((line) => line.includes("bun run lint"))).toBe(false);
    });
  });

  test("AC5: a 100-character first line is previewed as its first 80 characters", async () => {
    const firstLine = `echo ${"a".repeat(95)}`;
    const entry = makeEntry({ command: `${firstLine}\nsecond line` });
    const id = approvalId(entry);

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [id] });

      expect(firstLine).toHaveLength(100);
      expect(harness.stdoutLines()).toContain(`removed ${id}  execution  ${firstLine.slice(0, PREVIEW_LIMIT)}`);
      expect(harness.stdout()).not.toContain(firstLine);
    });
  });

  test("AC5 boundary: a first line of exactly 80 characters is not cut", async () => {
    const firstLine = "x".repeat(PREVIEW_LIMIT);
    const entry = makeEntry({ command: firstLine });
    const id = approvalId(entry);

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [id] });

      expect(harness.stdoutLines()).toContain(`removed ${id}  execution  ${firstLine}`);
    });
  });

  test("AC5 boundary: a first line of 81 characters is cut to exactly 80", async () => {
    const firstLine = "y".repeat(PREVIEW_LIMIT + 1);
    const entry = makeEntry({ command: firstLine });
    const id = approvalId(entry);

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [id] });

      const line = harness.stdoutLines().find((candidate) => candidate.startsWith(`removed ${id}  `));
      expect(line).toBe(`removed ${id}  execution  ${"y".repeat(PREVIEW_LIMIT)}`);
    });
  });
});

// ---------------------------------------------------------------------------
// AC6-AC9: several ids, all-or-nothing
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — several ids", () => {
  test("AC6: two present ids leave exactly the entries whose ids were not given", async () => {
    const first = makeEntry({ approvedAt: "2026-09-22T10:00:00.000Z" });
    const second = makeEntry({ command: "bun run lint", approvedAt: "2026-09-22T10:05:00.000Z" });
    const kept = makeEntry({ stage: "review", approvedAt: "2026-09-22T11:00:00.000Z" });

    await withStore([first, second, kept], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [approvalId(first), approvalId(second)] });

      expect(code).toBe(0);
      expect(await readApprovals(fixture.storePath)).toEqual([kept]);
    });
  });

  test("AC6 boundary: two entries sharing one id are removed together by that id", async () => {
    const duplicateA = makeEntry({ root: "/repo/worktree-a" });
    const duplicateB = makeEntry({ root: "/repo/worktree-b" });
    const kept = makeEntry({ stage: "review" });
    const sharedId = approvalId(duplicateA);

    expect(approvalId(duplicateB)).toBe(sharedId);

    await withStore([duplicateA, duplicateB, kept], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [sharedId] });

      expect(code).toBe(0);
      expect(await readApprovals(fixture.storePath)).toEqual([kept]);
    });
  });

  test("AC7: an absent id beside a present one resolves to 1", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [approvalId(entry), ABSENT_ID] });

      expect(code).toBe(1);
    });
  });

  test("AC8: an absent id beside a present one writes 'Unknown id(s): <absent id>' to stderr", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [approvalId(entry), ABSENT_ID] });

      expect(harness.stderrLines()).toContain(`Unknown id(s): ${ABSENT_ID}`);
    });
  });

  test("AC9: an absent id beside a present one leaves the store's bytes unchanged", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();
      const before = await storeBytes(fixture.storePath);

      await runRm(fixture, harness, { ids: [approvalId(entry), ABSENT_ID] });

      expect(await storeBytes(fixture.storePath)).toBe(before);
      expect(await readApprovals(fixture.storePath)).toEqual([entry]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC10-AC11: an id against a store that does not exist
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — missing store", () => {
  test("AC10: an id on a missing store resolves to 1", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [ABSENT_ID] });

      expect(code).toBe(1);
    });
  });

  test("AC11: an id on a missing store writes 'Unknown id(s): <id>' to stderr", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [ABSENT_ID] });

      expect(harness.stderrLines()).toContain(`Unknown id(s): ${ABSENT_ID}`);
    });
  });

  test("AC11 boundary: an id on a missing store creates no store file", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [ABSENT_ID] });

      expect(await Bun.file(fixture.storePath).exists()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC12-AC14: a malformed id is rejected before the store is touched
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — malformed id", () => {
  test("AC12: id 'A3F9C21E' resolves to 1", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [MALFORMED_ID] });

      expect(code).toBe(1);
    });
  });

  test("AC13: id 'A3F9C21E' writes 'Invalid id: A3F9C21E' to stderr", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [MALFORMED_ID] });

      expect(harness.stderrLines()).toContain("Invalid id: A3F9C21E");
    });
  });

  test("AC14: id 'A3F9C21E' does not invoke deps.removeApprovals", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const removeStub = makeRemoveStub();
      const harness = makeHarness({ removeApprovals: removeStub });

      await runRm(fixture, harness, { ids: [MALFORMED_ID] });

      expect(removeStub.mock.calls).toHaveLength(0);
      expect(await readApprovals(fixture.storePath)).toEqual([entry]);
    });
  });

  test.each([["a3f9c21"], ["a3f9c21e0"], ["zzzzzzzz"], ["a3f9c21-"]])(
    "AC14 boundary: id %s is rejected without invoking deps.removeApprovals",
    async (malformedId: string) => {
      const removeStub = makeRemoveStub();

      await withStore([makeEntry()], async (fixture) => {
        const harness = makeHarness({ removeApprovals: removeStub });

        const code = await runRm(fixture, harness, { ids: [malformedId] });

        expect(code).toBe(1);
        expect(harness.stderrLines()).toContain(`Invalid id: ${malformedId}`);
        expect(removeStub.mock.calls).toHaveLength(0);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// AC15-AC19: exactly one selector
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — selector validation", () => {
  test("AC15: no ids, no stage and all:false resolves to 1", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness);

      expect(code).toBe(1);
    });
  });

  test("AC16: no ids, no stage and all:false writes the selector message to stderr", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness);

      expect(harness.stderrLines()).toContain(SELECTOR_MESSAGE);
    });
  });

  test("AC17: no ids, no stage and all:false does not invoke deps.removeApprovals", async () => {
    const removeStub = makeRemoveStub();

    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness({ removeApprovals: removeStub });

      await runRm(fixture, harness);

      expect(removeStub.mock.calls).toHaveLength(0);
    });
  });

  test("AC18: one id together with all:true resolves to 1", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { ids: [approvalId(entry)], all: true });

      expect(code).toBe(1);
    });
  });

  test("AC19: one id together with all:true writes the selector message to stderr", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { ids: [approvalId(entry)], all: true });

      expect(harness.stderrLines()).toContain(SELECTOR_MESSAGE);
    });
  });

  test("AC19 boundary: ids together with a stage write the selector message and remove nothing", async () => {
    const entry = makeEntry();

    await withStore([entry], async (fixture) => {
      const harness = makeHarness();
      const before = await storeBytes(fixture.storePath);

      const code = await runRm(fixture, harness, { ids: [approvalId(entry)], stage: "execution" });

      expect(code).toBe(1);
      expect(harness.stderrLines()).toContain(SELECTOR_MESSAGE);
      expect(await storeBytes(fixture.storePath)).toBe(before);
    });
  });

  test("AC19 boundary: a stage together with all:true writes the selector message", async () => {
    await withStore([makeEntry()], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { stage: "execution", all: true });

      expect(code).toBe(1);
      expect(harness.stderrLines()).toContain(SELECTOR_MESSAGE);
    });
  });
});

// ---------------------------------------------------------------------------
// AC20-AC22: removal by stage
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — removal by stage", () => {
  test("AC20: stage 'execution' leaves exactly the entries whose stage is not execution", async () => {
    const executionA = makeEntry({ stage: "execution", approvedAt: "2026-09-22T10:00:00.000Z" });
    const executionB = makeEntry({
      stage: "execution",
      command: "bun run lint",
      approvedAt: "2026-09-22T10:05:00.000Z",
    });
    const review = makeEntry({ stage: "review", approvedAt: "2026-09-22T11:00:00.000Z" });

    await withStore([executionA, executionB, review], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { stage: "execution" });

      expect(code).toBe(0);
      expect(await readApprovals(fixture.storePath)).toEqual([review]);
    });
  });

  test("AC21: a stage matching nothing writes 'No entries for stage review' to stdout", async () => {
    await withStore([makeEntry({ stage: "execution" })], async (fixture) => {
      const harness = makeHarness();

      await runRm(fixture, harness, { stage: "review" });

      expect(harness.stdoutLines()).toContain("No entries for stage review");
    });
  });

  test("AC22: a stage matching nothing resolves to 0", async () => {
    await withStore([makeEntry({ stage: "execution" })], async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { stage: "review" });

      expect(code).toBe(0);
    });
  });

  test("AC22 boundary: a stage matching nothing rewrites nothing", async () => {
    await withStore([makeEntry({ stage: "execution" })], async (fixture) => {
      const harness = makeHarness();
      const before = await storeBytes(fixture.storePath);

      await runRm(fixture, harness, { stage: "review" });

      expect(await storeBytes(fixture.storePath)).toBe(before);
    });
  });

  test("AC22 boundary: a stage on a missing store resolves to 0 and creates no store file", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      const code = await runRm(fixture, harness, { stage: "review" });

      expect(code).toBe(0);
      expect(harness.stdoutLines()).toContain("No entries for stage review");
      expect(await Bun.file(fixture.storePath).exists()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC23: the taint marker survives a removal by id
// ---------------------------------------------------------------------------

describe("approvalsRmCommand — taint preservation", () => {
  test("AC23: removing an entry by id leaves the store's taint deep-equal to the taint read before", async () => {
    const entry = makeEntry();
    const kept = makeEntry({ stage: "review", approvedAt: "2026-09-22T11:00:00.000Z" });
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: TAINT_PID };

    await withStore(
      [entry, kept],
      async (fixture) => {
        const harness = makeHarness();
        const before = (await readApprovalsFile(fixture.storePath)).taint;

        const code = await runRm(fixture, harness, { ids: [approvalId(entry)] });

        expect(code).toBe(0);
        expect((await readApprovalsFile(fixture.storePath)).taint).toEqual(before);
        expect((await readApprovalsFile(fixture.storePath)).taint).toEqual(taint);
        expect(await readApprovals(fixture.storePath)).toEqual([kept]);
      },
      taint,
    );
  });
});
