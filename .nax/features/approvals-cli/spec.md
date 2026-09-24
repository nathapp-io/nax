# SPEC: nax approvals list/rm — the revocation surface D20 relies on

## Summary

Adds `nax approvals list` and `nax approvals rm`, so an operator can see every remembered bash
approval for a project, see whether the approvals cache is currently trusted or tainted, and revoke
grants. The approvals store (`src/permissions/approvals-store.ts`) gains a derived entry id
(`approvalId`), a read that reports what the lenient cache read hides
(`readApprovalsFileDetailed`), and a locked read-decide-write delete (`removeApprovals`) that
preserves the taint marker. The file format, the cache key and the cache link are unchanged.

## Motivation

Verified on `main` @ `3b7834208`:

- Master-plan decision D20 (2026-09-22) ruled that a remembered approval has **no expiry**, and
  justified it by the entry being "auditable and revocable" through a `nax approvals list/rm`
  surface. That surface does not exist: `bin/nax.ts` registers no `approvals` command, and
  `approvals-store.ts` exports only `approvalsPath`, `readApprovalsFile`, `readApprovals`,
  `writeApprovalsFile`, `appendApproval` and `findApproval`. There is no delete.
- The cross-phase P0-P5 review recorded this as finding #11 (MEDIUM): a standing grant that
  cannot be listed or revoked is not the grant D20 approved.
- Today the only way to revoke a grant is to hand-edit `~/.nax/<project>/approvals.json` while
  a run may be appending to it under `withPathFileLock`, and a hand edit can drop the `taint`
  marker (#2199) that keeps the cache off after a forge-capable run.

## Design

### Approach

Deterministic file I/O and terminal output; no LLM, no network. The store module owns every
read and write of `approvals.json`; the CLI module is terminal I/O only and reaches the store
through the `src/permissions` barrel. Two rulings from brainstorming (2026-09-24) are fixed:

1. **Commands print raw.** `list` shows each command byte-for-byte as stored. Masking secrets
   is an egress concern (the Telegram/webhook prompt, review #9) and `approvals.json` itself
   stays raw by that ruling.
2. **`rm` addresses entries by a derived 8-hex id**, not by list position (unsafe while a run
   appends) and not by retyping the byte-exact command (impractical for heredocs).

### Integration

Symbols this feature **changes**. The baseline only locates the code; it is never the interface
to implement.

**`readApprovalsFile`** — `src/permissions/approvals-store.ts:88` (US-001)
- Baseline: `readApprovalsFile(path: string): Promise<ApprovalsFile>`, parses inline.
- Target: same signature and same results for every input; implemented as
  `(await readApprovalsFileDetailed(path)).file`.

Symbols this feature **adds**:

```ts
// src/permissions/approvals-store.ts (US-001 read side, US-002 removal), re-exported by src/permissions/index.ts
export type ApprovalsFileState = "ok" | "missing" | "unparseable";

export interface ApprovalsFileRead {
  readonly file: ApprovalsFile;           // entries + taint, exactly what readApprovalsFile returns
  readonly state: ApprovalsFileState;
  readonly droppedMalformed: number;      // array elements isApprovalEntry rejected
}

export function approvalId(entry: ApprovalEntry): string;
export async function readApprovalsFileDetailed(path: string): Promise<ApprovalsFileRead>;

export type RemovalDecision =
  | { readonly remove: (entry: ApprovalEntry) => boolean }
  | { readonly refuse: string };

export type RemovalResult =
  | { readonly outcome: "removed"; readonly removed: readonly ApprovalEntry[]; readonly droppedMalformed: number }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "refused"; readonly reason: string };

export async function removeApprovals(
  path: string,
  decide: (read: ApprovalsFileRead) => RemovalDecision,
): Promise<RemovalResult>;
```

```ts
// src/cli/approvals.ts (US-003 creates; US-004, US-005, US-006 extend)
export const _approvalsCliDeps: {
  readApprovalsFileDetailed: (path: string) => Promise<ApprovalsFileRead>;
  removeApprovals: typeof removeApprovals;
  isProcessAlive: (pid: number) => boolean;   // default: _approvalsTaintDeps.isProcessAlive
  confirm: (question: string) => Promise<boolean>; // default: promptForConfirmation
  isTTY: () => boolean;
  log: (text: string) => void;                // stdout
  logErr: (text: string) => void;             // stderr
  exit: (code: number) => void;               // default: process.exit
};
export async function resolveApprovalsFile(workdir: string): Promise<string>;
export async function approvalsListCommand(opts: { workdir: string; json: boolean }, deps?: typeof _approvalsCliDeps): Promise<number>;
export async function approvalsRmCommand(
  opts: { workdir: string; ids: readonly string[]; stage?: string; all: boolean; yes: boolean },
  deps?: typeof _approvalsCliDeps,
): Promise<number>;
export function registerApprovalsCommand(program: Command, deps?: typeof _approvalsCliDeps): void;
```

```ts
// src/cli/approvals-format.ts (US-003 creates; US-004 adds toListJson; US-005 adds formatRemovedLine) -- pure, no I/O
export function formatTrustLine(taint: ApprovalsTaint | undefined, isAlive: (pid: number) => boolean): string;
export function formatEntryBlock(entry: ApprovalEntry): readonly string[];   // entry line, root line, command lines
export function toListJson(path: string, read: ApprovalsFileRead): object;   // the `--json` body
export function formatRemovedLine(entry: ApprovalEntry): string;             // `removed <id>  <stage>  <preview>`
```

Symbols this feature reads but does **not** change:

- `ApprovalEntry`, `ApprovalsFile`, `ApprovalsTaint`, `approvalsPath(outputDir)`,
  `writeApprovalsFile(path, file)`, `appendApproval(path, entry)` — `src/permissions/approvals-store.ts`
- `withPathFileLock(targetPath, operation)` — `src/utils/path-file-lock.ts:27`; throws
  `NaxError` code `FILE_LOCK_TIMEOUT` after its default 5 s (`src/utils/file-lock.ts:204`)
- `_approvalsTaintDeps.isProcessAlive(pid)` — `src/permissions/approvals-taint.ts`
- `projectOutputDir(projectKey, outputDirOverride)` — `src/runtime/paths.ts:19`
- `loadConfig(workdir)` — `src/config`
- `promptForConfirmation(question)` — `src/cli/confirm.ts:66`

Patterns to follow:

- `registerStatusCommand(program, deps)` in `src/cli/status-dispatch.ts:148` — a `register*`
  function on a commander `Command` with injectable deps; `bin/nax.ts` calls it once. Its test
  (`test/unit/cli/status-dispatch.test.ts:231`) builds `new Command()`, calls `exitOverride()`,
  registers, and drives `program.parseAsync([...], { from: "user" })`.
- `authListCommand` / `_cliAuthDeps` in `src/cli/auth.ts` — command functions return an exit
  code; output goes through an injected `log`.
- Store resolution copies `src/cli/runs.ts:14-19`: `loadConfig(workdir)` with a failure read as
  no config, project key `config?.name?.trim() || basename(workdir)`, then
  `projectOutputDir(key, config?.outputDir)`. This is the same key `createRuntime` uses
  (`src/runtime/index.ts:319`), so the CLI opens the file a run writes.

`bin/nax.ts` gains one import and one call, `registerApprovalsCommand(program)`, next to the
`auth` group. Formatting helpers live in `src/cli/approvals-format.ts` so neither file nears the
600-line gate.

### Entry id

`approvalId(entry)` is the first 8 lowercase hex characters of the SHA-256 digest of
`stage + "\0" + command + "\0" + approvedAt`, where a missing or non-string `approvedAt` is read
as `""`. It is computed on every read and never stored. It is stable when other entries are added
or removed; two entries recorded for the same (stage, command) at different times get different
ids; two entries with an identical triple share an id and are removed together.

### Detailed read

`readApprovalsFileDetailed(path)` classifies the file:

| File | `state` | `file` |
|---|---|---|
| absent | `missing` | `{ entries: [], taint: undefined }` |
| not JSON, top level not a non-null non-array object, or `entries` present and not an array | `unparseable` | `{ entries: [], taint: undefined }` |
| otherwise | `ok` | entries filtered by `isApprovalEntry`, taint parsed by `parseTaint` (both unchanged) |

`droppedMalformed` counts the array elements `isApprovalEntry` rejected (0 unless `ok`).

### Removal rules

`removeApprovals(path, decide)` runs entirely inside `withPathFileLock(path)`, in this order:

1. Read with `readApprovalsFileDetailed(path)`.
2. `state === "unparseable"` -> `{ outcome: "refused", reason: "approvals.json could not be parsed; not rewriting it" }`, no write. Rewriting would erase whatever the file holds.
3. `decide(read)` returns `{ refuse }` -> `{ outcome: "refused", reason: refuse }`, no write.
4. No entry selected (this includes a `missing` file) -> `{ outcome: "unchanged" }`, no write, no file or directory created.
5. Otherwise write `{ taint: read.file.taint, entries: <not selected> }` with `writeApprovalsFile`
   and return `{ outcome: "removed", removed, droppedMalformed }`.

The taint marker is written back exactly as read. Nothing in this feature clears a taint; only a
trusted run does, through `clearApprovalsTaint` (unchanged).

### CLI Behavior

```
nax approvals list [--json] [-d <dir>]
nax approvals rm <id...>          [-d <dir>]
nax approvals rm --stage <stage>  [-d <dir>]
nax approvals rm --all [--yes]    [-d <dir>]
```

- `-d/--dir` defaults to the current directory.
- stdout: listings, `--json` output, removal confirmations, "nothing there" messages.
- stderr: warnings, usage errors, `Aborted`, and failures.
- The registered action passes the command function's return value to `deps.exit`.

**`list` human output** (stdout), for an `ok` store:

```
Approvals store: /Users/x/.nax/my-project/approvals.json
Cache: trusted
2 remembered approvals

a3f9c21e  execution  escalate  2026-09-22T10:14:03.620Z  telegram  naxCommit 57454e7ab
          root /repo/.nax-wt/US-002
          $ bun run test
0b77e514  rectification  escalate  2026-09-22T10:20:41.910Z  telegram  naxCommit 57454e7ab
          root /repo
          $ cat <<'EOF' > notes.txt
            hello
            EOF
```

- Entry line: `<id>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>`, fields
  separated by two spaces.
- Then `          root <root>` (10 spaces), then the command's first line as `          $ <line>`,
  then each further command line prefixed by 12 spaces.
- Trust line for a tainted store:
  `Cache: TAINTED since <since> by run <runId> (pid <n>, alive) -- the cache is OFF; a trusted run will discard these entries.`
  with `exited` in place of `alive` when `isProcessAlive(pid)` is false, and `(pid unknown)` when
  the taint carries no pid.
- The count line reads `<n> remembered approvals` and is printed for an empty `ok` store too.

**`list --json`** prints one JSON object on stdout:

```json
{
  "path": "/Users/x/.nax/my-project/approvals.json",
  "state": "ok",
  "taint": { "since": "2026-09-23T09:00:00.000Z", "runId": "r-1", "pid": 4242 },
  "droppedMalformed": 0,
  "entries": [
    {
      "id": "a3f9c21e",
      "stage": "execution",
      "command": "bun run test",
      "root": "/repo/.nax-wt/US-002",
      "origin": "escalate",
      "matchedRule": null,
      "approvedAt": "2026-09-22T10:14:03.620Z",
      "approvedBy": "telegram",
      "naxCommit": "57454e7ab"
    }
  ]
}
```

`taint` is `null` when the store has none. For an unparseable store the body carries `state: "unparseable"`,
`taint: null`, `droppedMalformed: 0` and an empty `entries` array, and the parse warning still goes
to stderr, so stdout stays a single JSON object.

**`rm`** requires exactly one selector: one or more ids, `--stage <stage>`, or `--all`.

- Ids must match `^[0-9a-f]{8}$`; a malformed id is rejected before the store is read.
- Id removal is all-or-nothing: if any id matches no entry, nothing is removed.
- `--all` asks `promptForConfirmation` unless `--yes` is given; without a TTY and without
  `--yes` it refuses without prompting. An empty or missing store is reported before any prompt.
- Each removed entry prints `removed <id>  <stage>  <preview>` on stdout, where `<preview>` is
  the command's first line cut to 80 characters.

**Exit codes**

| Exit | When |
|---|---|
| 0 | `list` succeeded (including missing and unparseable stores); `rm` removed entries; `rm --stage`/`--all` matched nothing |
| 1 | usage error; malformed or unknown id; `--all` declined or refused; unparseable store on `rm`; lock timeout; write failure |

### Failure Handling

| Case | Behaviour | Owner |
|---|---|---|
| `loadConfig` throws | read as no config: key = `basename(workdir)`, default output dir | US-003 |
| store missing on `list` | stdout `No remembered approvals at <path>`, exit 0 | US-004 |
| store unparseable on `list` | stderr `approvals.json could not be parsed; the cache reads it as empty`, stdout `No remembered approvals at <path>` (or the JSON body with `--json`), exit 0 | US-004 |
| malformed elements on `list` | stderr `<n> malformed entries ignored`, listing continues | US-004 |
| zero or several `rm` selectors | stderr `Specify exactly one of <id...>, --stage <stage>, --all`, exit 1, store not read | US-005 |
| malformed id | stderr `Invalid id: <id>`, exit 1, store not read | US-005 |
| unknown id(s) | stderr `Unknown id(s): <ids>`, exit 1, store untouched | US-005 |
| `--stage` matches nothing | stdout `No entries for stage <stage>`, exit 0, no write | US-005 |
| `--all` on an empty or missing store | stdout `No remembered approvals at <path>`, exit 0, no prompt, no write | US-006 |
| `--all` declined, or non-TTY without `--yes` | stderr `Aborted`, exit 1, no write | US-006 |
| store unparseable on `rm` | stderr `approvals.json could not be parsed; not rewriting it`, exit 1, file untouched | US-006 |
| malformed elements dropped by an `rm` rewrite | stderr `<n> malformed entries dropped` | US-006 |
| `FILE_LOCK_TIMEOUT` from the store | stderr `a nax run is writing <path>; retry`, exit 1 | US-006 |
| any other error from the store | stderr `Failed to update <path>: <message>`, exit 1 | US-006 |

## Out of Scope

- `nax approvals add`, or any other way to create a remembered approval outside the human ask link.
- Expiry, `--older-than`, or any time-based pruning of remembered approvals (D20: expiry NONE).
- Id-prefix or partial-id matching in `nax approvals rm`; ids are exactly 8 hex characters.
- Clearing or rewriting the approvals `taint` marker from the CLI; only a trusted run clears it through `clearApprovalsTaint`.
- Masking or redacting secrets in `nax approvals list` output; commands print raw by ruling.
- Any change to the `approvals.json` file format, the cache key, `findApproval`, `createApprovalsLink` or `approvals-taint.ts`.
- A confirmation prompt for `rm <id...>` or `rm --stage`; revoking a grant can only cost prompts.
- `docs/guides/configuration.md` and `src/cli/config-descriptions.ts`; review #22 owns them.
- Refactoring the duplicated output-dir resolution in `src/cli/runs.ts` and `src/cli/status-cost.ts`.

## Stories

Each acceptance criterion below states one assertion, so the planned count matches the spec
count; the project cap is 24 per story (`precheck.storySizeGate.maxAcCount`).

1. **US-001: Store read side — entry id and detailed read** — no dependencies.
   Adds `approvalId` and `readApprovalsFileDetailed` (with `ApprovalsFileState`,
   `ApprovalsFileRead`) to `src/permissions/approvals-store.ts` and reimplements
   `readApprovalsFile` over the detailed read with unchanged results.
2. **US-002: Store removal — `removeApprovals`** — depends on US-001.
   Adds `RemovalDecision`, `RemovalResult` and `removeApprovals` to
   `src/permissions/approvals-store.ts`, following the Removal rules above, and adds one module
   docblock line naming `src/cli/approvals.ts` as the revocation surface D20 relies on.
3. **US-003: `nax approvals list` — command and human output** — depends on US-001.
   Creates `src/cli/approvals.ts` (`_approvalsCliDeps`, `resolveApprovalsFile`,
   `approvalsListCommand`, `registerApprovalsCommand` with the `list` subcommand) and
   `src/cli/approvals-format.ts` (`formatTrustLine`, `formatEntryBlock`). Registers the command
   in `bin/nax.ts` and adds a `### nax approvals list` section to `docs/guides/cli-reference.md`.
4. **US-004: `nax approvals list` — store states and `--json`** — depends on US-003.
   Adds the missing / unparseable / malformed-element handling of `approvalsListCommand` and the
   `--json` output (`toListJson` in `src/cli/approvals-format.ts`), and documents `--json` in the
   `### nax approvals list` section.
5. **US-005: `nax approvals rm` — by id and by stage** — depends on US-002 and US-003.
   Adds `approvalsRmCommand` with selector validation, id and `--stage` removal, the `rm`
   subcommand in `registerApprovalsCommand`, and `formatRemovedLine` in
   `src/cli/approvals-format.ts`.
6. **US-006: `nax approvals rm --all` and store failure mapping** — depends on US-005.
   Adds `--all` with confirmation to `approvalsRmCommand`, maps the store's refusals and errors
   to the messages in Failure Handling, adds a `### nax approvals rm` section to
   `docs/guides/cli-reference.md`, and adds one sentence to
   `docs/adr/ADR-030-bash-approval-modes.md` ("The approvals cache's trust boundary") saying
   grants are listed and revoked with `nax approvals`, which never clears a taint.

### Context Files

**US-001**
- `src/permissions/approvals-store.ts` — the module extended; `isApprovalEntry` and `parseTaint` stay the parsing SSOT
- `test/unit/permissions/approvals-store.test.ts` — existing store tests to extend

**US-002**
- `src/permissions/approvals-store.ts` — `appendApproval` shows the lock pattern `removeApprovals` mirrors
- `src/permissions/approvals-taint.ts` — how the taint marker is written and why it must survive
- `src/utils/path-file-lock.ts` — the lock `removeApprovals` takes

**US-003**
- `src/cli/status-dispatch.ts` — `registerStatusCommand(program, deps)` pattern
- `test/unit/cli/status-dispatch.test.ts` — driving a registered command with `parseAsync`
- `src/cli/auth.ts` — command functions returning exit codes, injected `log`
- `src/cli/runs.ts` — output-dir resolution to copy
- `bin/nax.ts` — where the `auth` group is registered

**US-004**
- `src/cli/approvals.ts` — created by US-003, extended here
- `src/cli/approvals-format.ts` — created by US-003, extended here
- `test/unit/cli/approvals.test.ts` — created by US-003; fixture helpers to reuse

**US-005**
- `src/cli/approvals.ts` — created by US-003, extended here
- `src/cli/approvals-format.ts` — created by US-003, extended here
- `test/unit/cli/approvals.test.ts` — created by US-003; fixture helpers to reuse

**US-006**
- `src/cli/approvals.ts` — extended by US-005, extended again here
- `src/cli/confirm.ts` — `promptForConfirmation`
- `test/unit/cli/approvals-rm.test.ts` — created by US-005; fixture helpers to reuse
- `docs/adr/ADR-030-bash-approval-modes.md` — the trust-boundary section to amend
- `docs/guides/cli-reference.md` — where the `list` section from US-003 sits

### Creates

**US-001**

_None — US-001 extends existing files only._

**US-002**
- `test/unit/permissions/approvals-store-remove.test.ts` — `removeApprovals` tests

**US-003**
- `src/cli/approvals.ts` — deps, store resolution, `list` command, command registration
- `src/cli/approvals-format.ts` — pure formatters for the trust line and entry block
- `test/unit/cli/approvals.test.ts` — store resolution, registration and human `list` tests

**US-004**
- `test/unit/cli/approvals-list-states.test.ts` — missing / unparseable / malformed and `--json` tests

**US-005**
- `test/unit/cli/approvals-rm.test.ts` — id and `--stage` removal tests

**US-006**
- `test/unit/cli/approvals-rm-all.test.ts` — `--all` and failure-mapping tests

### Modifies

None. Every change is additive: `readApprovalsFile` keeps its signature and its result for every
input, the existing `approvals-store.test.ts` cases (including "a malformed file reads as empty
rather than throwing") stay valid unchanged, and no test enumerates the `src/permissions` barrel's
exports or asserts on the full set of `bin/nax.ts` commands.

### Seams

- US-001 -> US-003: `readApprovalsFileDetailed` is invoked by `nax approvals list` (US-003 AC 4).
- US-002 -> US-005: `removeApprovals` is invoked by `nax approvals rm` (US-005 AC 1).
- US-003 -> bin: `registerApprovalsCommand` is the entry point; every CLI seam AC drives it
  through `program.parseAsync` on a fresh `Command`. The one-line call in `bin/nax.ts` is
  verified by the build/static gate (`bun run typecheck`) and the manual smoke recorded in
  US-003's verification note.

## Acceptance Criteria

### US-001: Store read side — entry id and detailed read

1. [unit] `approvalId(entry)` returns a string of exactly 8 lowercase hexadecimal characters.
2. [unit] `approvalId` returns the same value for two entries whose `stage`, `command` and `approvedAt` are identical.
3. [unit] `approvalId` returns different values for two entries with the same `stage` and `command` but different `approvedAt`.
4. [unit] `approvalId(entry)` equals the first 8 hex characters of the SHA-256 digest of `stage + "\0" + command + "\0" + approvedAt`.
5. [unit] `approvalId` on an entry whose `approvedAt` is missing returns the value computed with `approvedAt` as `""`.
6. [unit] `readApprovalsFileDetailed(path)` on a path with no file resolves to a value deep-equal to `{ state: "missing", file: { entries: [], taint: undefined }, droppedMalformed: 0 }`.
7. [unit] `readApprovalsFileDetailed` on a file whose content is not valid JSON returns `state: "unparseable"`.
8. [unit] `readApprovalsFileDetailed` on a file whose top-level JSON value is an array returns `state: "unparseable"`.
9. [unit] `readApprovalsFileDetailed` on a file whose `entries` value is a string returns `state: "unparseable"`.
10. [unit] `readApprovalsFileDetailed` on a file whose content is not valid JSON returns `file` deep-equal to `{ entries: [], taint: undefined }`.
11. [unit] `readApprovalsFileDetailed` on a file holding two valid entries and one `null` element returns `state: "ok"`.
12. [unit] `readApprovalsFileDetailed` on a file holding two valid entries and one `null` element returns `file.entries` deep-equal to the two valid entries.
13. [unit] `readApprovalsFileDetailed` on a file holding two valid entries and one `null` element returns `droppedMalformed: 1`.
14. [unit] `readApprovalsFileDetailed` on a file whose `taint` is `{ since: "s", runId: "r", pid: 7 }` returns `file.taint` deep-equal to that object.
15. [unit] `readApprovalsFile(path)` on a valid tainted file returns a value deep-equal to `readApprovalsFileDetailed(path).file`.
16. [unit] `readApprovalsFile(path)` on a file whose `entries` value is a string returns an empty `entries` array.

**Verification note:** the `readApprovalsFile` reimplementation is behaviour-preserving; the
existing `test/unit/permissions/approvals-store.test.ts` and `approvals-link.test.ts` suites stay
green under `bun run test`.

### US-002: Store removal — `removeApprovals`

1. [unit] `removeApprovals` on a path with no file resolves to `{ outcome: "unchanged" }`.
2. [unit] After `removeApprovals` on a path with no file, no file exists at that path.
3. [unit] `removeApprovals` on a path with no file invokes `decide` once with a read whose `state` is `"missing"`.
4. [unit] `removeApprovals` on an unparseable file resolves to `{ outcome: "refused", reason: "approvals.json could not be parsed; not rewriting it" }`.
5. [unit] After `removeApprovals` on an unparseable file, the file's bytes are unchanged.
6. [unit] `removeApprovals` on an unparseable file does not invoke `decide`.
7. [unit] `removeApprovals` whose `decide` returns `{ refuse: "Unknown id(s): deadbeef" }` resolves to `{ outcome: "refused", reason: "Unknown id(s): deadbeef" }`.
8. [unit] After `removeApprovals` whose `decide` returns a `refuse`, the file's bytes are unchanged.
9. [unit] `removeApprovals` whose `remove` predicate selects no entry resolves to `{ outcome: "unchanged" }`.
10. [unit] After `removeApprovals` whose `remove` predicate selects no entry, the file's bytes are unchanged.
11. [unit] `removeApprovals` whose `remove` predicate selects one of three entries resolves with `removed` deep-equal to that one entry.
12. [unit] After `removeApprovals` removes one of three entries, `readApprovals(path)` returns exactly the other two entries.
13. [unit] After `removeApprovals` removes an entry from a tainted store, `readApprovalsFile(path).taint` deep-equals the taint read before the call.
14. [unit] After `removeApprovals` removes an entry from an untainted store, `readApprovalsFile(path).taint` is `undefined`.
15. [unit] `removeApprovals` removing an entry from a file that also holds one malformed element resolves with `droppedMalformed: 1`.
16. [integration] Given a store holding only entry A, when `removeApprovals` selecting A and `appendApproval` adding entry B are started concurrently on the same path, `readApprovals(path)` after both settle deep-equals `[B]`.

### US-003: `nax approvals list` — command and human output

1. [unit] `resolveApprovalsFile(workdir)` for a workdir whose `.nax/config.json` sets `name` and an absolute `outputDir` returns `<outputDir>/approvals.json`.
2. [unit] `resolveApprovalsFile(workdir)` for a workdir with no `name` in its config returns `approvalsPath(projectOutputDir(basename(workdir), undefined))`.
3. [unit] `resolveApprovalsFile(workdir)` for a workdir whose `.nax/config.json` is not valid JSON returns `approvalsPath(projectOutputDir(basename(workdir), undefined))`.
4. [integration] With `_approvalsCliDeps.readApprovalsFileDetailed` stubbed, `program.parseAsync(["approvals", "list", "-d", workdir], { from: "user" })` on a fresh `Command` passed to `registerApprovalsCommand` invokes the stub once with the path `resolveApprovalsFile(workdir)` returns.
5. [integration] `program.parseAsync(["approvals", "list", "-d", workdir], { from: "user" })` on a store with one entry calls `deps.exit` with `0`.
6. [unit] `approvalsListCommand` on an untainted store with entries writes `Approvals store: <path>` and `Cache: trusted` as its first two stdout lines.
7. [unit] `approvalsListCommand` on a store with 2 entries writes the stdout line `2 remembered approvals`.
8. [unit] `approvalsListCommand` on an empty untainted store writes the stdout line `0 remembered approvals`.
9. [unit] `approvalsListCommand` writes each entry's first line as `<approvalId>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>`.
10. [unit] `approvalsListCommand` writes each entry's root line as 10 spaces followed by `root <root>`.
11. [unit] `approvalsListCommand` writes a single-line command as 10 spaces followed by `$ <command>`.
12. [unit] `approvalsListCommand` writes the second and later lines of a multi-line command each prefixed by 12 spaces.
13. [unit] `approvalsListCommand` writes a command containing `API_KEY=abc123` to stdout with `API_KEY=abc123` unaltered.
14. [unit] `approvalsListCommand` on a store tainted with pid 4242 where `isProcessAlive(4242)` is true writes the trust line `Cache: TAINTED since <since> by run <runId> (pid 4242, alive) -- the cache is OFF; a trusted run will discard these entries.`
15. [unit] `approvalsListCommand` on a store tainted with pid 4242 where `isProcessAlive(4242)` is false writes a trust line containing `(pid 4242, exited)`.
16. [unit] `approvalsListCommand` on a store whose taint has no pid writes a trust line containing `(pid unknown)`.

**Verification note:** the `registerApprovalsCommand(program)` call in `bin/nax.ts` is verified by
`bun run typecheck` and by the manual smoke `bun bin/nax.ts approvals list -d <temp project>`.

### US-004: `nax approvals list` — store states and `--json`

1. [unit] `approvalsListCommand` on a missing store writes `No remembered approvals at <path>` to stdout.
2. [unit] `approvalsListCommand` on a missing store resolves to `0`.
3. [unit] `approvalsListCommand` on an unparseable store writes `approvals.json could not be parsed; the cache reads it as empty` to stderr.
4. [unit] `approvalsListCommand` on an unparseable store writes `No remembered approvals at <path>` to stdout.
5. [unit] `approvalsListCommand` on an unparseable store resolves to `0`.
6. [unit] `approvalsListCommand` on a store with 1 malformed element writes `1 malformed entries ignored` to stderr.
7. [unit] `approvalsListCommand` on a store with 1 malformed element and 1 valid entry writes the valid entry's first line to stdout.
8. [unit] `approvalsListCommand` with `json: true` writes to stdout exactly one JSON object whose keys are `path`, `state`, `taint`, `droppedMalformed` and `entries`.
9. [unit] `approvalsListCommand` with `json: true` writes each element of `entries` deep-equal to `{ id: approvalId(entry), ...entry }`.
10. [unit] `approvalsListCommand` with `json: true` on an untainted store writes `taint` as `null`.
11. [unit] `approvalsListCommand` with `json: true` on a tainted store writes `taint` deep-equal to the store's taint.
12. [unit] `approvalsListCommand` with `json: true` on a missing store writes `state` as `"missing"`.
13. [unit] `approvalsListCommand` with `json: true` on a missing store writes `entries` as an empty array.
14. [unit] `approvalsListCommand` with `json: true` on an unparseable store writes a stdout JSON object deep-equal to `{ path, state: "unparseable", taint: null, droppedMalformed: 0, entries: [] }`.
15. [unit] `approvalsListCommand` with `json: true` on an unparseable store writes `approvals.json could not be parsed; the cache reads it as empty` to stderr.

### US-005: `nax approvals rm` — by id and by stage

1. [integration] With `_approvalsCliDeps.removeApprovals` stubbed to resolve `{ outcome: "unchanged" }`, `program.parseAsync(["approvals", "rm", "--stage", "execution", "-d", workdir], { from: "user" })` on a fresh `Command` passed to `registerApprovalsCommand` invokes the stub once with the path `resolveApprovalsFile(workdir)` returns.
2. [integration] `program.parseAsync(["approvals", "rm", <id>, "-d", workdir], { from: "user" })` on a store holding that entry calls `deps.exit` with `0`.
3. [integration] After `program.parseAsync(["approvals", "rm", <id>, "-d", workdir], { from: "user" })` on a store holding that entry, `readApprovals(path)` no longer returns that entry.
4. [unit] `approvalsRmCommand` with one id present in the store writes `removed <id>  <stage>  <preview>` to stdout.
5. [unit] `approvalsRmCommand` removing an entry whose command's first line is 100 characters writes a removal line whose `<preview>` is that line's first 80 characters.
6. [unit] After `approvalsRmCommand` with two ids both present, `readApprovals(path)` returns exactly the entries whose ids were not given.
7. [unit] `approvalsRmCommand` with one present id and one absent id resolves to `1`.
8. [unit] `approvalsRmCommand` with one present id and one absent id writes `Unknown id(s): <absent id>` to stderr.
9. [unit] After `approvalsRmCommand` with one present id and one absent id, the store file's bytes are unchanged.
10. [unit] `approvalsRmCommand` with an id on a missing store resolves to `1`.
11. [unit] `approvalsRmCommand` with an id on a missing store writes `Unknown id(s): <id>` to stderr.
12. [unit] `approvalsRmCommand` with id `A3F9C21E` resolves to `1`.
13. [unit] `approvalsRmCommand` with id `A3F9C21E` writes `Invalid id: A3F9C21E` to stderr.
14. [unit] `approvalsRmCommand` with id `A3F9C21E` does not invoke `deps.removeApprovals`.
15. [unit] `approvalsRmCommand` with no ids, no `stage` and `all: false` resolves to `1`.
16. [unit] `approvalsRmCommand` with no ids, no `stage` and `all: false` writes `Specify exactly one of <id...>, --stage <stage>, --all` to stderr.
17. [unit] `approvalsRmCommand` with no ids, no `stage` and `all: false` does not invoke `deps.removeApprovals`.
18. [unit] `approvalsRmCommand` with one id and `all: true` resolves to `1`.
19. [unit] `approvalsRmCommand` with one id and `all: true` writes `Specify exactly one of <id...>, --stage <stage>, --all` to stderr.
20. [unit] After `approvalsRmCommand` with `stage: "execution"`, `readApprovals(path)` returns exactly the entries whose `stage` is not `execution`.
21. [unit] `approvalsRmCommand` with `stage: "review"` on a store with no `review` entry writes `No entries for stage review` to stdout.
22. [unit] `approvalsRmCommand` with `stage: "review"` on a store with no `review` entry resolves to `0`.
23. [unit] After `approvalsRmCommand` removes an entry by id from a tainted store, `readApprovalsFile(path).taint` deep-equals the taint read before the call.

### US-006: `nax approvals rm --all` and store failure mapping

1. [unit] After `approvalsRmCommand` with `all: true, yes: true`, `readApprovals(path)` returns an empty array.
2. [unit] `approvalsRmCommand` with `all: true, yes: true` does not invoke `deps.confirm`.
3. [unit] After `approvalsRmCommand` with `all: true, yes: false` on a TTY whose `deps.confirm` resolves `true`, `readApprovals(path)` returns an empty array.
4. [unit] `approvalsRmCommand` with `all: true, yes: false` on a TTY whose `deps.confirm` resolves `false` resolves to `1`.
5. [unit] `approvalsRmCommand` with `all: true, yes: false` on a TTY whose `deps.confirm` resolves `false` writes `Aborted` to stderr.
6. [unit] After `approvalsRmCommand` with `all: true, yes: false` on a TTY whose `deps.confirm` resolves `false`, the store file's bytes are unchanged.
7. [unit] `approvalsRmCommand` with `all: true, yes: false` when `deps.isTTY()` is false resolves to `1`.
8. [unit] `approvalsRmCommand` with `all: true, yes: false` when `deps.isTTY()` is false writes `Aborted` to stderr.
9. [unit] `approvalsRmCommand` with `all: true, yes: false` when `deps.isTTY()` is false does not invoke `deps.confirm`.
10. [unit] `approvalsRmCommand` with `all: true` on a missing store writes `No remembered approvals at <path>` to stdout.
11. [unit] `approvalsRmCommand` with `all: true` on a missing store resolves to `0`.
12. [unit] `approvalsRmCommand` with `all: true` on a missing store does not invoke `deps.confirm`.
13. [unit] `approvalsRmCommand` with `all: true` on an existing store whose `entries` is empty writes `No remembered approvals at <path>` to stdout.
14. [unit] `approvalsRmCommand` with `all: true` on an existing store whose `entries` is empty resolves to `0`.
15. [unit] `approvalsRmCommand` with `all: true` on an existing store whose `entries` is empty does not invoke `deps.confirm`.
16. [unit] `approvalsRmCommand` with `all: true, yes: true` on an unparseable store resolves to `1`.
17. [unit] `approvalsRmCommand` with `all: true, yes: true` on an unparseable store writes `approvals.json could not be parsed; not rewriting it` to stderr.
18. [unit] After `approvalsRmCommand` with `all: true, yes: true` on an unparseable store, the store file's bytes are unchanged.
19. [unit] `approvalsRmCommand` whose removal drops 1 malformed element writes `1 malformed entries dropped` to stderr.
20. [unit] `approvalsRmCommand` whose `deps.removeApprovals` rejects with a `NaxError` of code `FILE_LOCK_TIMEOUT` resolves to `1`.
21. [unit] `approvalsRmCommand` whose `deps.removeApprovals` rejects with a `NaxError` of code `FILE_LOCK_TIMEOUT` writes `a nax run is writing <path>; retry` to stderr.
22. [unit] `approvalsRmCommand` whose `deps.removeApprovals` rejects with `new Error("EACCES")` resolves to `1`.
23. [unit] `approvalsRmCommand` whose `deps.removeApprovals` rejects with `new Error("EACCES")` writes `Failed to update <path>: EACCES` to stderr.

**Verification note:** manual smoke `bun bin/nax.ts approvals rm --all --yes -d <temp project>`.
