/**
 * `nax approvals list` — store states, warnings and `--json` (US-004).
 *
 * AC1-AC2:   a missing store prints `No remembered approvals at <path>` and resolves to 0.
 * AC3-AC5:   an unparseable store warns on stderr, prints the empty listing and resolves to 0.
 * AC6-AC7:   malformed array elements are reported on stderr and the valid entries still list.
 * AC8-AC15:  `--json` prints one object, keys exactly
 *            `path`, `state`, `taint`, `droppedMalformed` and `entries`, each entry
 *            `{ id: approvalId(entry), ...entry }`, `taint: null` when the store has none,
 *            and `state: "unparseable"` with `entries: []` for a store whose bytes are not JSON
 *            while the parse warning stays on stderr.
 *
 * The three states are produced for real, from a temp workdir whose `.nax/config.json` names the
 * project and points an absolute `outputDir` inside the same temp dir:
 *   - missing      — the store file (and its output dir) is never created.
 *   - unparseable  — the file exists and its bytes are not the `{ entries, taint }` shape.
 *   - malformed    — the file parses, but some array elements are not approval entries.
 *
 * Hermetic by construction: stdout, stderr and the exit code are captured through the injected
 * `_approvalsCliDeps` seam, so nothing touches the real console, no process is spawned, and no
 * path outside the temp dir is written.
 *
 * Every AC is pinned through `approvalsListCommand` — the surface the ACs name — including the
 * `--json` body, so the pure body builder's module placement stays the implementer's choice.
 * AC1's "no warning on the missing path" guard and AC7's listing assertion already hold in
 * US-003 and are kept as regression pins.
 */

import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import { Command } from "commander";
import { _approvalsCliDeps, approvalsListCommand, registerApprovalsCommand } from "@/cli/approvals";
import { type ApprovalEntry, type ApprovalsTaint, approvalId, approvalsPath } from "@/permissions";

type CliDeps = typeof _approvalsCliDeps;

const PROJECT_NAME = "approvals-list-states";
/** The warning printed for a store whose bytes the cache cannot parse. */
const PARSE_WARNING = "approvals.json could not be parsed; the cache reads it as empty";

const TAINT_SINCE = "2026-09-20T08:30:00.000Z";
const TAINT_RUN_ID = "run-7f3a";
const TAINT_PID = 4242;

/** The five keys of the `--json` body, sorted. */
const JSON_KEYS = ["droppedMalformed", "entries", "path", "state", "taint"];

function makeEntry(overrides: Partial<ApprovalEntry> = {}): ApprovalEntry {
  return {
    stage: "implementer",
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

interface StoreFixture {
  readonly workdir: string;
  readonly outputDir: string;
  readonly storePath: string;
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

function makeHarness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];

  const deps: CliDeps = {
    ..._approvalsCliDeps,
    log: (text: string) => {
      out.push(text);
    },
    logErr: (text: string) => {
      err.push(text);
    },
    exit: (code: number) => {
      exitCodes.push(code);
    },
  };

  return {
    deps,
    exitCodes,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    stdoutLines: () => out,
    stderrLines: () => err,
  };
}

/**
 * Stdout parsed to be ONE JSON object, or null when stdout is not a single JSON
 * object. Pre-implementation stdout is the human listing, so the caller's
 * assertion — not a `JSON.parse` throw — reports the missing behaviour.
 *
 * The entries/fromEntries round-trip is only there to name an index signature
 * for the parse result without an `as` cast, which the escape-hatch ratchet
 * counts. Values come out `unknown` and every assertion reads them via `expect`.
 */
function jsonObjectOrNull(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all; the caller asserts on the null.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return Object.fromEntries(Object.entries(parsed));
}

/** The one JSON object `--json` prints, asserting it really is one object. */
function jsonBody(harness: Harness): Record<string, unknown> {
  const body = jsonObjectOrNull(harness.stdout().trim());
  expect(body).not.toBeNull();
  assertDefined(body, "the --json body on stdout");
  return body;
}

// ---------------------------------------------------------------------------
// Fixtures — a temp workdir with a named project and an absolute output dir.
// ---------------------------------------------------------------------------

async function withProject(fn: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const workdir = join(dir, "project");
    const outputDir = join(dir, "out");
    await mkdir(join(workdir, ".nax"), { recursive: true });
    await Bun.write(join(workdir, ".nax", "config.json"), JSON.stringify({ name: PROJECT_NAME, outputDir }));
    await fn({ workdir, outputDir, storePath: approvalsPath(outputDir) });
  });
}

/** A store whose bytes are exactly `content` — the not-valid-JSON cases. */
async function withRawStore(content: string, fn: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await withProject(async (fixture) => {
    await mkdir(dirname(fixture.storePath), { recursive: true });
    await Bun.write(fixture.storePath, content);
    await fn(fixture);
  });
}

/** A store holding `body`, serialized the way the store writer serializes it. */
async function withStore(body: unknown, fn: (fixture: StoreFixture) => Promise<void>): Promise<void> {
  await withRawStore(`${JSON.stringify(body, null, 2)}\n`, fn);
}

/** The resolved store path's "no store here" notice. */
function missingNotice(fixture: StoreFixture): string {
  return `No remembered approvals at ${fixture.storePath}`;
}

async function list(fixture: StoreFixture, harness: Harness, json = false): Promise<number> {
  return approvalsListCommand({ workdir: fixture.workdir, json }, harness.deps);
}

// ---------------------------------------------------------------------------
// AC1-AC2: a missing store
// ---------------------------------------------------------------------------

describe("approvalsListCommand — missing store", () => {
  test("AC1: writes 'No remembered approvals at <path>' to stdout", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stdout()).toContain(missingNotice(fixture));
    });
  });

  test("AC1 boundary: the notice is the whole of stdout — no store header, no count", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stdoutLines()).toEqual([missingNotice(fixture)]);
    });
  });

  test("AC1 boundary: a missing store writes no warning to stderr", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderr()).toBe("");
    });
  });

  test("AC2: resolves to 0, without listing a missing store as an empty store", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      expect(await list(fixture, harness)).toBe(0);
      expect(harness.stdoutLines()).not.toContain("0 remembered approvals");
    });
  });
});

// ---------------------------------------------------------------------------
// AC3-AC5: an unparseable store
// ---------------------------------------------------------------------------

describe("approvalsListCommand — unparseable store", () => {
  test("AC3: writes 'approvals.json could not be parsed; the cache reads it as empty' to stderr", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderr()).toContain(PARSE_WARNING);
    });
  });

  test("AC3 boundary: the parse warning is the only stderr line", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderrLines()).toEqual([PARSE_WARNING]);
    });
  });

  test("AC4: writes 'No remembered approvals at <path>' to stdout", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stdout()).toContain(missingNotice(fixture));
    });
  });

  test("AC4 boundary: an empty listing, not a header and a zero count", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stdoutLines()).toEqual([missingNotice(fixture)]);
    });
  });

  test("AC5: resolves to 0, without listing an unparseable store as an empty store", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      expect(await list(fixture, harness)).toBe(0);
      expect(harness.stdoutLines()).not.toContain("0 remembered approvals");
    });
  });
});

// ---------------------------------------------------------------------------
// AC6-AC7: malformed elements
// ---------------------------------------------------------------------------

describe("approvalsListCommand — malformed elements", () => {
  test("AC6: writes '1 malformed entries ignored' to stderr for one malformed element", async () => {
    await withStore({ entries: [null] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderr()).toContain("1 malformed entries ignored");
    });
  });

  test("AC6 boundary: reports the exact count, not a fixed 1, for two dropped elements", async () => {
    await withStore({ entries: [null, "not-an-entry"] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderr()).toContain("2 malformed entries ignored");
    });
  });

  test("AC7: still writes the valid entry's first line to stdout beside a malformed element", async () => {
    const entry = makeEntry({ stage: "verifier", command: "bun run verify" });

    await withStore({ entries: [null, entry] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stdoutLines()).toContain(
        `${approvalId(entry)}  verifier  escalate  2026-09-22T10:00:00.000Z  telegram:123  naxCommit 7b37dbf74`,
      );
    });
  });

  test("AC7 boundary: reports the drop on stderr and lists the valid entry in the same run", async () => {
    const entry = makeEntry();

    await withStore({ entries: [null, entry] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness);

      expect(harness.stderrLines()).toEqual(["1 malformed entries ignored"]);
      expect(harness.stdoutLines()).toContain(
        `${approvalId(entry)}  implementer  escalate  2026-09-22T10:00:00.000Z  telegram:123  naxCommit 7b37dbf74`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// AC8-AC11: the `--json` body
// ---------------------------------------------------------------------------

describe("approvalsListCommand — --json body", () => {
  test("AC8: writes exactly the keys path, state, taint, droppedMalformed and entries", async () => {
    await withStore({ entries: [makeEntry()] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(Object.keys(jsonBody(harness)).sort()).toEqual(JSON_KEYS);
    });
  });

  test("AC8 boundary: a missing store is still one JSON object with those five keys", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(Object.keys(jsonBody(harness)).sort()).toEqual(JSON_KEYS);
    });
  });

  test("AC8 boundary: a dropped element is counted in droppedMalformed and the kept entry still lists", async () => {
    const entry = makeEntry();

    await withStore({ entries: [null, entry] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      const body = jsonBody(harness);
      expect(body.droppedMalformed).toBe(1);
      expect(body.entries).toEqual([{ id: approvalId(entry), ...entry }]);
    });
  });

  test("AC9: each entry is deep-equal to { id: approvalId(entry), ...entry }", async () => {
    const first = makeEntry();
    const second = makeEntry({ command: "bun run lint", approvedAt: "2026-09-22T11:00:00.000Z" });

    await withStore({ entries: [first, second] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).entries).toEqual([
        { id: approvalId(first), ...first },
        { id: approvalId(second), ...second },
      ]);
    });
  });

  test("AC9 boundary: an element holding only stage and command serializes with no field invented", async () => {
    // `isApprovalEntry` requires stage and command alone, and `approvalId` hashes
    // (stage, command, approvedAt) with a missing approvedAt read as "" — so this
    // pair's id is the one the same pair carries when approvedAt is absent.
    const minimalOnDisk = { stage: "implementer", command: "bun run test" };
    const expectedId = approvalId(makeEntry({ ...minimalOnDisk, approvedAt: "" }));

    await withStore({ entries: [minimalOnDisk] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).entries).toEqual([{ id: expectedId, ...minimalOnDisk }]);
    });
  });

  test("AC10: an untainted store writes taint as null", async () => {
    await withStore({ entries: [makeEntry()] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).taint).toBeNull();
    });
  });

  test("AC10 boundary: an explicit taint null in the store also writes taint as null", async () => {
    await withStore({ entries: [], taint: null }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).taint).toBeNull();
    });
  });

  test("AC11: a tainted store writes taint deep-equal to the store's taint", async () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: TAINT_PID };

    await withStore({ entries: [], taint }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).taint).toEqual({ since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: TAINT_PID });
    });
  });

  test("AC11 boundary: a taint written without a pid serializes without one", async () => {
    await withStore({ entries: [], taint: { since: TAINT_SINCE, runId: TAINT_RUN_ID } }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).taint).toEqual({ since: TAINT_SINCE, runId: TAINT_RUN_ID });
    });
  });
});

// ---------------------------------------------------------------------------
// AC12-AC15: the `--json` states
// ---------------------------------------------------------------------------

describe("approvalsListCommand — --json states", () => {
  test("AC12: a missing store writes state as 'missing'", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).state).toBe("missing");
    });
  });

  test("AC12 boundary: a readable store writes state as 'ok'", async () => {
    await withStore({ entries: [makeEntry()] }, async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).state).toBe("ok");
    });
  });

  test("AC13: a missing store writes entries as an empty array", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).entries).toEqual([]);
    });
  });

  test("AC13 boundary: a missing store still names the resolved store path", async () => {
    await withProject(async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness).path).toBe(fixture.storePath);
    });
  });

  test("AC14: a store whose content is not valid JSON writes { path, state: 'unparseable', taint: null, droppedMalformed: 0, entries: [] }", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness)).toEqual({
        path: fixture.storePath,
        state: "unparseable",
        taint: null,
        droppedMalformed: 0,
        entries: [],
      });
    });
  });

  test("AC14 boundary: a store whose top-level value is a JSON array is unparseable in the body too", async () => {
    await withRawStore("[1, 2, 3]\n", async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(jsonBody(harness)).toEqual({
        path: fixture.storePath,
        state: "unparseable",
        taint: null,
        droppedMalformed: 0,
        entries: [],
      });
    });
  });

  test("AC15: --json on an unparseable store writes the parse warning to stderr", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(harness.stderr()).toContain(PARSE_WARNING);
    });
  });

  test("AC15 boundary: the warning stays off stdout, which carries the JSON body alone", async () => {
    await withRawStore('{"entries": [', async (fixture) => {
      const harness = makeHarness();

      await list(fixture, harness, true);

      expect(harness.stdout()).not.toContain(PARSE_WARNING);
      expect(jsonBody(harness).state).toBe("unparseable");
    });
  });
});

// ---------------------------------------------------------------------------
// The `--json` flag reaches the command through the registered subcommand
// ---------------------------------------------------------------------------

describe("registerApprovalsCommand — --json wiring", () => {
  test("AC8: 'approvals list --json' prints the JSON body and exits 0", async () => {
    await withStore({ entries: [makeEntry()] }, async (fixture) => {
      const harness = makeHarness();
      const program = new Command();
      program.exitOverride();
      registerApprovalsCommand(program, harness.deps);

      await program.parseAsync(["approvals", "list", "-d", fixture.workdir, "--json"], { from: "user" });

      expect(harness.exitCodes).toEqual([0]);
      expect(jsonBody(harness).path).toBe(fixture.storePath);
    });
  });
});
