# SPEC: koda memory provider

## Summary

Feature 3 of the nax memory slice (design `docs/superpowers/specs/2026-11-02-nax-memory-design.md`,
sections 6.4, 6.9, 6.10 and 8). Features 1, 2, 4 and 5 (`memory-store` #2769, `memory-chat` #2771,
`memory-run-stages` #2772, `memory-mcp-provider` #2773) shipped the mirror, the outbox, the sync loop,
the memory host, the `nax-memory` tools, the chat / run / CLI surfaces and the `local` and `mcp`
providers. koda shipped its side of the contract (koda #376-#380, koda main `c51cf74e`): a `NOTE`
memory kind, full-text search, user-scope notes, an export change feed with a cursor, and a
server-side proposal write mode.

This feature adds the third provider, `memory.provider: "koda"`, which makes a koda project the
authoritative store behind the mirror:

- config: `memory.provider` accepts `"koda"`; a new `memory.koda` block (`url`, `project`,
  `headers`); `url` and `headers` are accepted in the global config only;
- a small koda HTTP client (envelope, timeout, error classification, no header leakage);
- a pure mapping from koda's export feed to mirror pages: per-slug reconciliation of notes and
  tombstones, and an incremental merge of koda `DECISION` rows;
- a koda provider: `reachable`, `push` (save and forget, direct and proposal), `pull` (export
  feed, both scopes), `search` (koda full-text);
- tracking of proposal saves koda answered `202`, so a rejected proposal leaves the mirror instead
  of sitting `pending` forever;
- the memory host composes the koda provider;
- `nax memory link <koda-project>` and `nax memory reset`.

## Motivation

Today a note saved in nax chat or a `nax run` lives only in one machine's mirror (`local`) or in an
MCP server that koda cannot read. The user ruled (2026-11-02) that nax chat and koda threads share
ONE memory with koda as the source of truth, and that nax pulls a per-project mirror (pull
architecture, design 6.5). koda now exposes everything that needs. The provider seam, the outbox
and the sync loop were built for exactly this provider; `local` never exercises a remote cursor
and `mcp` has none, so this is also the first provider that pulls.

## Design

### Behaviour

`memory.provider: "koda"` makes the host compose a koda provider for the koda project named by
`memory.koda.project`. The mirror stays the store every surface reads; the index, `get` and local
keyword search are unchanged. koda's wire contract (verified against koda `c51cf74e`):

- every path is relative to `memory.koda.url`, the API root including koda's global prefix
  (`https://koda.example/api`);
- authentication is the configured headers, normally `Authorization: Bearer <agent key>`. The
  agent needs a project role carrying `project.read` (for `GET projects/<slug>`), `memory.read`
  and `memory.create`; superseding or retiring a row another principal owns also needs
  `memory.update`;
- a success body is `{ "ret": 0, "data": <payload> }`; an error body is
  `{ "ret": <code>, "message": "<text>" }`;
- routes address the project by **slug** in the path; `POST memory` and the retire body take the
  project **id**, which the provider learns once from `GET projects/<slug>`.

| Operation | koda provider behaviour |
|---|---|
| `reachable` | `GET projects/<slug>/memory/write-mode`; `true` on a 2xx whose `data.mode` is `"direct"` or `"proposal"`, `false` otherwise (a throw included). It checks the key and the membership, which `GET health` would not. |
| `push` save | `POST memory` with the body below; `201` resolves `{ id: <koda id>, status: "active" }`; `202` records the approval and resolves `{ id: <clientId>, status: "pending" }`. |
| `push` forget | finds the slug's active note (forget lookup, below); none resolves `{ id: <clientId>, status: "deleted" }`; else `POST memory/notes/<id>/retire`: `201` resolves `deleted`, `202` resolves `pending`, `404` and `409` resolve `deleted`. |
| `pull` | `GET projects/<slug>/memory/export`, reconciled per slug (below); decisions merged on project pages; at the scope's last page, resolves the recorded proposals of that scope. |
| `search` | `GET projects/<slug>/memory` with `text`, `kind=NOTE` and the scope; records mapped to hits in koda's rank order. |

The provider id is `koda:<project>`, so `nax memory status` prints `provider: koda:rs-stock`.

**Write mode is koda's.** koda decides direct vs proposal from its own approval policy for the
calling agent; the request's `writeMode` is not sent. A `201` is active and a `202` is pending
whatever `memory.writeMode` says locally. `memory.writeMode` keeps its existing local meaning
(how an offline save is marked while it waits in the outbox).

**Idempotency.** koda has no client idempotency key. The save carries `sourceId: <clientId>`:
koda returns the existing row for an identical restatement (same object, predicate, description,
sourceType and sourceId), so re-pushing a queued entry whose first answer was lost does not
create a second row. A note's koda id changes on every content change (supersession), which is
why the mirror stays keyed by scope and slug.

### Save request body (the wire shape)

```json
{
  "projectId": "<koda project id from GET projects/<slug>>",
  "kind": "NOTE",
  "subject": "<slug>",
  "predicate": "<type: user | feedback | project | reference>",
  "object": "<body>",
  "description": "<description>",
  "scope": "<project | user>",
  "sourceType": "<note.source, e.g. nax-chat>",
  "sourceId": "<clientId>"
}
```

Every key is always present, with exactly these names. `projectId` is sent for user-scope notes
too (koda requires it for membership). No other key is sent.

### Retire request body

`POST memory/notes/<koda id>/retire` with `{ "projectId": "<koda project id>", "reason": "<reason>" }`;
`reason` is omitted when the forget's reason is the empty string.

### Forget lookup (`src/memory/koda-lookup.ts`)

```ts
export function findActiveKodaNote(input: {
  readonly client: KodaClient;
  readonly project: string;            // koda project slug
  readonly scope: MemoryScope;
  readonly slug: string;
}): Promise<KodaMemoryItem | null>;
export const MEMORY_KODA_LOOKUP_MAX_PAGES = 10;
```

`GET projects/<slug>/memory` with query `kind=NOTE`, `subject=<slug>`, `scope=<scope>`,
`status=active`, `size=100` and `current=<page>` starting at `1`. A forget runs the lookup first;
only when it finds a row does it fetch the project id (`GET projects/<slug>`, memoised) and send
the retire. The `404`/`409` → `deleted` mapping applies to the retire request only: a `404` from
the lookup or from `GET projects/<slug>` is transient like any other failure of those requests.
A forget can cost up to `MEMORY_KODA_LOOKUP_MAX_PAGES` + 2 requests, which may outlast sync's
10 s race; the retry is safe because retiring an already retired note answers `409` → `deleted`. koda's `subject` filter is a
prefix match, so the answer is the first record whose `subject` equals the slug exactly and whose
`scope` equals the scope. The lookup asks the next page while no record matches and the answer's
`data.hasNext` is `true`, up to `MEMORY_KODA_LOOKUP_MAX_PAGES` pages; no match with `hasNext`
false resolves `null`; reaching the page cap without a match throws `NaxError`
`MEMORY_KODA_LOOKUP_EXHAUSTED` (transient). It is used by the forget and by proposal resolution.

### Export feed and reconciliation (`src/memory/koda-mapping.ts`)

`GET projects/<slug>/memory/export` with query `since=<cursor>` (omitted when the cursor is
`null`) and `take=<min(take, 500)>`. The answer's `data` is
`{ items: KodaMemoryItem[], nextCursor: string | null, hasMore: boolean }`, ordered by
`(updatedAt, id)` ascending. Each row appears once, at its latest `updatedAt`: a supersession,
retirement or soft delete rewrites the row in place and moves it to the end of the feed. koda
withholds rows changed in the last 5 seconds (`MEMORY_EXPORT_SETTLE_MS`), so a write shows up on
a later sync. Rows of both scopes arrive in one feed (the project's rows, plus the calling
principal's user-scope rows); there is no scope parameter, so a user-scope pull reads the same
feed as a project pull and keeps only the user rows. The page answers
`{ notes, decisions?, nextCursor: data.nextCursor ?? undefined, done: data.hasMore !== true }`.

nax-agent's sync applies a page's notes by slug, and a tombstone deletes the slug's note
unconditionally (`syncMemory`, `packages/nax-agent/src/memory/sync.ts:332`). koda's feed carries
rows for ids the mirror no longer holds (a superseded predecessor; an older retired note
soft-deleted later), so applying rows one by one would let such a row delete a newer note. The
mapping therefore reconciles a page into at most one note per slug, with these rules, in this order:

| # | Row | Effect |
|---|---|---|
| R1 | `kind` is not `"NOTE"`, or `scope` is not the page's scope | not a note of this page (DECISION rows go to the decision merge) |
| R2 | `subject` fails `MEMORY_SLUG_RE`, `predicate` is not one of `user`, `feedback`, `project`, `reference`, or a required field (`id`, `subject`, `predicate`, `object`, `description`, `updatedAt`, `status`) is missing or not a string | skipped and counted |
| R3 | `status` is `"superseded"` | adds no note. When its `id` equals the slug's current id (the current note of this page if one is set, else the mirror's note id), the slug's current id becomes *unknown*: its successor may be an active row or a tombstone later in the page |
| R4 | `status` is `"active"` and `deletedAt` is absent | becomes the slug's current note, status `active` |
| R5 | `status` is `"rejected"`, or `deletedAt` is present | a tombstone, applied only when its `id` equals the slug's current id (the current note of this page if one is set, else the mirror's note id for the slug), or when R3 made that id unknown. A tombstone that applies sets the current note to the row with status `rejected` (`deleted` when `deletedAt` is present); one that does not apply is ignored |
| R6 | output | the current note of every slug that has one, in slug code-point order |

A row maps to a `MemoryNote` as: `id` = row `id`; `slug` = `subject`; `type` = `predicate`;
`scope` = the page's scope; `description` = `description`; `body` = `object`; `updatedAt` =
`updatedAt`; `source` = `sourceType` with whitespace runs collapsed to one space, cut to
`MEMORY_SOURCE_MAX_CHARS`, or `"koda"` when absent or blank.

The mirror ids R5 compares against are read before the page is reconciled: the provider reads
the mirror note of every distinct slug the page's rows of this scope name, through the `readNote`
it was given, and passes the ids as a map.

A local edit that koda answered `202` sits in the mirror as `pending` until the proposal resolves;
a pull whose page carries the slug's unchanged active row (R4) replaces the pending edit with that
row. The approved row arrives later through the feed. This is accepted behaviour.

**Decisions.** `DECISION` rows are merged only on project pages. A `DECISION` row whose `id`,
`subject`, `predicate`, `object`, `updatedAt` or `status` is missing or not a string is skipped
and counted with the note skips. A page with no valid `DECISION` row answers `decisions`
undefined, so `decisions.jsonl` is not rewritten. A page with one or more merges them into the
mirror's current decisions (`readDecisions`; sync writes `decisions.jsonl` after each page, so a
later page sees the earlier one) by `id`: an `active` row with no `deletedAt` sets
`{ id, subject, predicate, object, updatedAt, status: "active" }`; any other row removes its id.
The merged list is ordered by `updatedAt` descending then `id`, and cut to
`MEMORY_KODA_DECISIONS_MAX` (500). Rows of other kinds (`FACT`, `PREFERENCE`, `CONSTRAINT`,
`INCIDENT_PATTERN`) are ignored.

**Hits.** A search record maps to `{ slug: subject, scope: record scope, type: predicate,
description, status: "active", score: <records.length - index>, snippet: <object with whitespace
runs collapsed, first 200 characters> }`; a record that fails R2 maps to `null` and is dropped.

The mapping module's contract:

```ts
export interface KodaMemoryItem {
  readonly id: string;
  readonly kind: string;               // "NOTE" | "DECISION" | other koda kinds
  readonly scope: string;              // "project" | "user"
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly description?: string;
  readonly status: string;             // "active" | "superseded" | "rejected"
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
  readonly sourceType?: string;
}
export const KODA_NOTE_TYPES = ["user", "feedback", "project", "reference"] as const satisfies readonly MemoryNoteType[];
export const MEMORY_KODA_DECISIONS_MAX = 500;
/** Shape check only: an array of objects. Throws MEMORY_KODA_BAD_RESPONSE when `value` is not an array. */
export function parseKodaItems(value: unknown): readonly KodaMemoryItem[];
export function reconcileKodaNotes(
  items: readonly KodaMemoryItem[],
  scope: MemoryScope,
  mirrorIds: ReadonlyMap<string, string>,   // slug -> the mirror note's id
): { readonly notes: readonly MemoryNote[]; readonly skipped: number };
export function mergeKodaDecisions(
  current: readonly MemoryDecision[],
  items: readonly KodaMemoryItem[],
): { readonly decisions: readonly MemoryDecision[] | undefined; readonly skipped: number };
export function kodaHitOf(record: KodaMemoryItem, index: number, total: number): MemoryHit | null;
```

`MEMORY_NOTE_TYPES` is not exported from the `@nathapp/nax-agent` entry, which is why
`KODA_NOTE_TYPES` is declared here (the pattern `NOTE_TYPES` follows in `src/cli/memory-cli-deps.ts`).

### Proposal tracking (`src/memory/koda-approvals.ts`, resolution in `src/memory/koda-pull.ts`)

A `202` save means koda opened an approval request and wrote no row. If it is executed, the row
appears in the export feed and a later pull replaces the mirror's pending note. If it is rejected,
nothing ever appears, so the provider records each `202` save in `koda-approvals.json` in the
project mirror directory:

```json
{ "version": 1, "approvals": [ { "approvalId": "apr_1", "scope": "project", "slug": "replay-budget", "clientId": "c_9" } ] }
```

```ts
export interface KodaApproval { readonly approvalId: string; readonly scope: MemoryScope; readonly slug: string; readonly clientId: string }
export interface KodaApprovals {
  list(): Promise<readonly KodaApproval[]>;
  record(entry: KodaApproval): Promise<void>;
  drop(approvalIds: readonly string[]): Promise<void>;
}
export function createKodaApprovals(input: { readonly dir: string; readonly logger: MemoryLogger }): KodaApprovals;
export const _kodaApprovalsDeps: { write(path: string, text: string): Promise<void>; rename(from: string, to: string): Promise<void> };
```

A record for a scope and slug that already has one replaces it. The file is written to a
temporary path and renamed into place (the `mcp-id-map.ts` pattern). An unreadable or invalid
file reads as no approvals and is logged at warn once per `KodaApprovals` instance.

At the last page of a pull (`done`), the provider resolves at most
`MEMORY_KODA_APPROVAL_CHECKS_MAX` (20) recorded approvals of that pull's scope, oldest record
first, by asking `GET approvals/<approvalId>` and reading `data.status`:

| koda status | Effect |
|---|---|
| `pending`, `approved` | kept (`approved` can still settle to `executed` or `failed`) |
| `executed` | dropped (the row arrives through the feed) |
| `rejected`, `expired`, `cancelled`, `failed` | dropped, and the slug is restored (below) |
| `404` | dropped; nothing restored |
| any other failure | kept; logged at warn |

**Restoring a slug.** Only when the mirror's note for that scope and slug still has `id` equal to
the record's `clientId` and status `pending`, and the page has no note for that slug already, the
provider calls `findActiveKodaNote` for the slug: an active row is added to the page as that
slug's note (status `active`), which puts back the note an edit proposal had replaced locally;
no active row adds a tombstone for the slug: the mirror's pending note itself with `status: "rejected"` (every field comes from that note, so sync's record check accepts it). A lookup that throws keeps
the record (retried on a later pull) and adds nothing.

Resolving at the scope's own last page matters: sync writes a page's notes to the page's scope,
so a user-scope note on a project page would land in the project mirror.

### HTTP client (`src/memory/koda-http.ts`)

```ts
export interface KodaResponse { readonly status: number; readonly data: unknown }
export interface KodaClient {
  get(path: string, query?: Readonly<Record<string, string | number | undefined>>): Promise<KodaResponse>;
  post(path: string, body: unknown): Promise<KodaResponse>;
}
export function createKodaClient(input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): KodaClient;
export function kodaStatusOf(error: unknown): number | undefined;
export const MEMORY_KODA_REQUEST_TIMEOUT_MS = 4000;
export const _kodaClientDeps: { fetch: (input: string, init: RequestInit) => Promise<Response> };
```

- URL: `url` with trailing `/` removed, then `/`, then `path`; query keys appended in insertion
  order with `URLSearchParams`, keys whose value is `undefined` skipped.
- Headers: the configured headers plus `accept: application/json`; a `post` adds
  `content-type: application/json` and the JSON-encoded body.
- A 2xx answer whose body parses as JSON resolves `{ status, data: body.data }`.
- A 2xx answer whose body is not JSON throws `NaxError` `MEMORY_KODA_BAD_RESPONSE`.
- A non-2xx answer throws `NaxError` `MEMORY_KODA_HTTP` with `context.status` set to the HTTP
  status and the message `[memory] koda <METHOD> <path> answered <status>: <message>`, where
  `<message>` is the body's `message` when it is a string, else the response's status text.
- No answer within `timeoutMs` aborts the request and throws `MEMORY_KODA_TIMEOUT`; a fetch that
  rejects throws `MEMORY_KODA_UNREACHABLE` with the rejection as `cause`.
- `kodaStatusOf(error)` returns `context.status` of a `MEMORY_KODA_HTTP` error, else `undefined`.
- Header values never appear in any error message, error context or log line.

The host builds the client with `MEMORY_KODA_REQUEST_TIMEOUT_MS` (4 s), well under sync's 10 s
per-operation race (`MEMORY_OP_TIMEOUT_MS`), so a save's two requests (project id, then
`POST memory`) settle inside one race.

### Error classification (provider)

| Answer | save | forget (retire) |
|---|---|---|
| `400`, `403`, `413`, `422` | `MEMORY_PUSH_REJECTED` with koda's message | same |
| `409` | `MEMORY_PUSH_REJECTED` | resolves `deleted` (the note is no longer active) |
| `404` | rethrown (transient: a wrong slug or lost membership is a config problem; the entry stays queued) | resolves `deleted` (the note is gone) |
| `401`, `408`, `429`, `5xx`, timeout, unreachable, bad response | rethrown (transient) | rethrown (transient) |

`403` is permanent for a write: koda refuses a principal that lacks `memory.create`, or lacks
`memory.update` on another principal's row, and the drain stops at the first transient failure,
so a transient `403` would block every later write. A rejected entry is retried by the user
through the outbox's existing rejected-entry handling. `401` (a bad key) stays transient: fixing
the key delivers everything queued. Any failure of the forget lookup itself is transient.

### Config

```jsonc
// ~/.nax/config.json (global)
"memory": {
  "koda": {
    "url": "https://koda.example/api",
    "headers": { "Authorization": "Bearer <agent key>" }
  }
}
// <repo>/.nax/config.json (project) — what `nax memory link rs-stock` writes
"memory": { "provider": "koda", "koda": { "project": "rs-stock" } }
```

`MemoryKodaConfigSchema` (new, in `src/config/schemas-memory.ts`) is `.strict()`: `url` is an
optional `https:` URL, or an `http:` URL to a loopback host (the existing `isRemotePlainHttp`,
`src/config/schemas-model.ts:184`, decides; a remote plain-http url fails with the message
`memory.koda.url must use https unless the host is loopback`, because the bearer key travels with
every request); `project` is an optional string matching
`KODA_PROJECT_SLUG_RE` (`^[a-z0-9][a-z0-9-]{0,99}$`, koda's slug rule); `headers` is an optional
record of strings defaulting to `{}`. `memory.provider` accepts `"local" | "mcp" | "koda"`.
`memory.koda` has no default and is absent from `NaxConfigSchema.parse({}).memory`. The file's
header comment, which says `koda` is rejected until this feature, is updated.

New cross-section rules in `validateMemoryProvider`:

| Condition | Issue path | Message |
|---|---|---|
| `memory.provider` is `"koda"` and `memory.koda.url` is absent | `["memory", "koda", "url"]` | `memory.provider "koda" needs memory.koda.url in ~/.nax/config.json` |
| `memory.provider` is `"koda"` and `memory.koda.project` is absent | `["memory", "koda", "project"]` | `memory.provider "koda" needs memory.koda.project (run nax memory link <koda-project>)` |

Proposal write mode is allowed with `"koda"` (koda holds pending writes).

**Global only.** `rejectGlobalOnlyKeys(layerConf, layerName)` (`src/config/global-only-keys.ts`)
also throws `NaxError` `MEMORY_KODA_CONFIG_NOT_GLOBAL` with the message
`memory.koda.<key> belongs in ~/.nax/config.json and cannot be set in <layerName>` when the layer
sets `memory.koda.url` or `memory.koda.headers`. It already runs on the project, profile, package
and CLI layers (`loader.ts:139`, `:197`, `:346`, `:461`, `profile.ts:112`). `memory.koda.project`
is allowed in every layer. `nax config` already masks every value of a `headers` map
(`maskProfileValues`, `src/cli/config-profile.ts`), so no masking change is needed.

The `@/config` barrel (`src/config/index.ts`) also exports `KODA_PROJECT_SLUG_RE`,
`MemoryKodaConfigSchema` and the type `MemoryKodaConfig`, beside the existing memory exports.

`FIELD_DESCRIPTIONS` (`src/cli/config-descriptions.ts`) gains `memory.koda`, `memory.koda.url`,
`memory.koda.project` and `memory.koda.headers`, and the `memory.provider` description names
`"koda"`.

### Provider modules

```ts
// src/memory/koda-provider.ts
export const MEMORY_KODA_PROVIDER_PREFIX = "koda:";
export const MEMORY_KODA_APPROVAL_CHECKS_MAX = 20;
export interface CreateKodaMemoryProviderInput {
  readonly client: KodaClient;
  readonly project: string;                                   // koda project slug
  readonly approvals: KodaApprovals;
  readonly readNote: (scope: MemoryScope, slug: string) => Promise<MemoryNote | null>;
  readonly readDecisions: () => Promise<readonly MemoryDecision[]>;
  readonly logger: MemoryLogger;
}
export function createKodaMemoryProvider(input: CreateKodaMemoryProviderInput): MemoryProvider;

// src/memory/koda-pull.ts — the pull, kept out of koda-provider.ts for the 600-line cap
export function pullKodaPage(
  input: CreateKodaMemoryProviderInput,
  request: { readonly scope: MemoryScope; readonly cursor: string | null; readonly take: number },
): Promise<MemoryPage>;
```

US-005 creates `koda-provider.ts` with `pull` resolving `{ notes: [], done: true }` and `search`
resolving `[]`; US-006 replaces `search` and adds the forget; US-007 replaces `pull` with a call
to `pullKodaPage`; US-008 adds proposal resolution to `pullKodaPage`.

### Host (`src/memory/host.ts`)

`composeMemory` gains a third branch. For `provider: "koda"` it builds, through `_memoryHostDeps`:

```ts
const client = _memoryHostDeps.createKodaClient({ url, headers, timeoutMs: MEMORY_KODA_REQUEST_TIMEOUT_MS });
const approvals = _memoryHostDeps.createKodaApprovals({ dir: dirs.projectDir, logger: input.logger });
const provider = _memoryHostDeps.createKodaMemoryProvider({
  client, project, approvals,
  readNote: (scope, slug) => store.readNote(scope, slug),
  readDecisions: () => store.readDecisions(),
  logger: input.logger,
});
```

A config that reaches the host with `provider: "koda"` but no `url` or no `project` (a bypassed
load) throws `NaxError` `MEMORY_KODA_CONFIG_MISSING` at host creation. A koda-backed host owns no
pool; `close()` stays the existing no-op for it. `host.search` already asks a provider that has
`search` for project-scope and unscoped queries (`host-remote-search.ts`), so koda's hits are
merged first with no host change beyond composition.

### CLI (`src/cli/memory-admin.ts`, registered from `src/cli/memory.ts`)

```ts
export const _memoryAdminDeps: {
  readText(path: string): Promise<string | null>;          // null when the file does not exist
  writeText(path: string, text: string): Promise<void>;    // creates parent directories
  rename(from: string, to: string): Promise<void>;
  listDir(path: string): Promise<readonly string[]>;       // entry names; [] when the directory does not exist
  removePath(path: string): Promise<void>;                 // recursive; a missing path is not an error
};
export interface MemoryLinkOptions { readonly dir: string; readonly json?: boolean; readonly force?: boolean }
export function memoryLinkCommand(slug: string, opts: MemoryLinkOptions, deps?: MemoryCliDeps): Promise<number>;
export function memoryResetCommand(opts: MemoryCliOptions, deps?: MemoryCliDeps): Promise<number>;
export function registerMemoryAdminCommands(memory: Command, deps?: MemoryCliDeps): Command;
```

`nax memory link <koda-project> [-d <dir>] [--force] [--json]`, in this order:

1. `<koda-project>` failing `KODA_PROJECT_SLUG_RE` → stderr
   `[memory] "<koda-project>" is not a koda project slug`, exit 1, nothing written.
2. Resolves the repo root with `deps.findProjectDir` and reads `<repoRoot>/.nax/config.json`
   through `_memoryAdminDeps.readText` BEFORE loading the config (the loader throws on invalid
   project JSON first); unparsable JSON → stderr `[memory] cannot link: <path> is not valid JSON`,
   and JSON that is not an object (an array, `null`, a number) → stderr
   `[memory] cannot link: <path> is not a JSON object`; both exit 1, nothing written. Absent reads as `{}`.
   This parsed object is the *raw project config*.
3. Loads the merged config as the other `nax memory` subcommands do. A load error (for example a
   project already linked while the global `url` is missing) is reported through the existing
   `withMemoryErrors` path, exit 1.
4. No `memory.koda.url` in the loaded config → stderr
   `[memory] memory.koda.url is not set in ~/.nax/config.json`, exit 1, nothing written.
5. The raw project config already names a different `memory.koda.project` and `--force` is not set →
   stderr `[memory] already linked to koda project "<old>"; pass --force to relink (the project mirror is rebuilt)`,
   exit 1, nothing written. With `--force` (a *forced relink*: a different project is replaced),
   the host for the current config is opened; memory disabled (no host) skips this check and step 8;
   when its `status().queued + status().rejected > 0` → stderr
   `[memory] <n> writes are not delivered; run nax memory sync (or nax memory forget) before relinking`,
   exit 1, nothing written.
6. Probes `GET projects/<koda-project>/memory/write-mode` with a client built from the loaded
   `url` and `headers` (`MEMORY_PROBE_TIMEOUT_MS`); a throw, or a 2xx whose `data.mode` is not
   `"direct"` or `"proposal"` (the rule `reachable()` uses) → stderr `[memory] koda project "<koda-project>" is not reachable: <reason>`,
   exit 1, nothing written.
7. Sets `memory.provider` to `"koda"` and `memory.koda.project` to the slug **in the raw project
   config from step 2** — never the merged config, which holds the global `url` and `headers` —
   keeping every other key and value of it; writes `JSON.stringify(config, null, 2)` plus a newline through
   `_memoryAdminDeps.writeText` to `config.json.tmp` and `_memoryAdminDeps.rename` onto
   `config.json`.
8. Only a forced relink (step 5's case) then removes the host's `dirs.projectDir` through `_memoryAdminDeps.removePath`,
   so the next sync pulls the new project from the start (project A's export cursor would
   otherwise decode in project B and skip its older rows).
9. stdout `linked <repoRoot> to koda project <slug> (write mode: <mode>)`, or with `--json` one
   document `{ "project": "<slug>", "writeMode": "<mode>", "configPath": "<path>" }`; exit 0.

Linking the same project again rewrites the same values, needs no `--force`, and removes nothing,
also when `--force` is passed. Linking a
project whose config names provider `local` or `mcp` (no koda project) needs no `--force`; the
notes already in the mirror stay local (Out of Scope: migration).

`nax memory reset [-d <dir>] [--json]`:

1. Opens the host as the other subcommands do; memory disabled keeps the existing disabled
   error (`memoryDisabledError`) and exit code.
2. A provider id not starting with `koda:` → stderr
   `[memory] reset needs memory.provider "koda": the <provider id> mirror is the only copy of its notes`,
   exit 1, nothing deleted.
3. `status().queued + status().rejected > 0` → stderr
   `[memory] <n> writes are not delivered; run nax memory sync (or nax memory forget) before reset`,
   exit 1, nothing deleted.
4. Removes every entry `_memoryAdminDeps.listDir` lists in the host's `dirs.projectDir`, through `_memoryAdminDeps.removePath`, except `koda-approvals.json` (records of
   proposals still pending in koda, including user-scope ones whose notes live in the untouched
   user mirror), then runs `host.sync()` and prints its result exactly as `nax memory sync`
   does (`formatMemorySyncResult`, or one JSON document with `--json`).
5. Exit `0` when the sync outcome is `"synced"`, else `1` (an `unreachable` reset leaves an empty
   mirror, which the user must hear about).

### Integration

Read, unchanged (verified):

- `MemoryProvider`, `MemoryPage`, `MemoryPushResult`, `MemoryWriteRequest`
  (`packages/nax-agent/src/memory/provider-types.ts`); `MemoryNote`, `MemoryDecision`,
  `MemoryHit`, `MemoryNoteType`, `MemoryScope`, `MEMORY_SLUG_RE`, `MEMORY_SOURCE_MAX_CHARS`,
  `MEMORY_OP_TIMEOUT_MS`, `MEMORY_PROBE_TIMEOUT_MS` (`.../types.ts`), `isMemoryPushRejected`, all
  exported from `@nathapp/nax-agent`.
- `syncMemory` applies a page by slug, skips keys the outbox holds, and a tombstone deletes
  (`sync.ts:316-340`); sync outcomes are `"synced" | "unreachable" | "locked" | "failed"`
  (`sync.ts:98`); `applyPushed` writes a save's returned `id` and `status` into the mirror and
  deletes on a forget's `deleted` (`delivery.ts`).
- `MemoryStore.readNote(scope, slug)` and `MemoryStore.readDecisions()` (`store.ts:141`, `:145`).
- `searchRemote` / `mergeRemoteFirst` (`src/memory/host-remote-search.ts`).
- `createMcpIdMap` (`src/memory/mcp-id-map.ts`) — the temp + rename write pattern to mirror.
- `maskProfileValues` masks `headers` maps (`src/cli/config-profile.ts:147`, `:166`).
- `memorySyncCommand` (`src/cli/memory-read.ts:74`); `formatMemorySyncResult`
  (`src/memory/format.ts`, exported from `@/memory`); `withMemoryHost`, `memoryContext`,
  `memoryDisabledError`, `MemoryCliDeps`, `MemoryCliOptions` (`src/cli/memory-cli-deps.ts`);
  `memoryStatusCommand` (`src/cli/memory.ts:116`).

Changed — the baseline exists only to locate the code; it is never the interface to implement:

- `MemoryConfigSchema.provider` — Baseline: `z.enum(["local", "mcp"]).default("local")`.
  Target: `z.enum(["local", "mcp", "koda"]).default("local")`, plus `koda: MemoryKodaConfigSchema.optional()`.
- `validateMemoryProvider(data, ctx)` — Baseline: the four MCP rules. Target: the four MCP rules
  plus the two koda rules above; `MemoryProviderInput.memory` gains `koda?: { url?: string; project?: string }`.
- `rejectGlobalOnlyKeys(layerConf, layerName)` — Baseline: rejects `trust` and `auth`. Target:
  also rejects `memory.koda.url` and `memory.koda.headers`.
- `MemoryConfig` (`src/config/runtime-types-memory.ts`) — Baseline: `provider: "local" | "mcp"`.
  Target: `provider: "local" | "mcp" | "koda"`, and gains `koda?: MemoryKodaConfig` with `MemoryKodaConfig = { url?: string; project?: string; headers: Record<string, string> }`.
- `composeMemory` / `_memoryHostDeps` (`src/memory/host.ts`) — Target: `_memoryHostDeps` gains
  `createKodaClient`, `createKodaApprovals`, `createKodaMemoryProvider`; `composeMemory` takes
  the koda branch for `provider: "koda"`.
- `registerMemoryCommand` (`src/cli/memory.ts:176`) — Target: also calls
  `registerMemoryAdminCommands(memory, deps)`, which adds `link` and `reset` after `approve`.
- `src/memory/index.ts` barrel — Target: also exports `createKodaClient`, `kodaStatusOf`,
  `MEMORY_KODA_REQUEST_TIMEOUT_MS`, `createKodaApprovals`, `createKodaMemoryProvider`,
  `MEMORY_KODA_PROVIDER_PREFIX`.

File budgets: `host.ts` 498/600, `schemas-memory.ts` 144, `config-descriptions.ts` 483,
`global-only-keys.ts` 23, `memory.ts` 199.

### Failure Handling

| Situation | Behaviour |
|---|---|
| koda unreachable, wrong key, lost membership at sync | `reachable` is `false`; sync records `unreachable`; the session runs on the mirror; writes stay queued |
| save or retire answered `400` / `403` / `413` / `422` | `MEMORY_PUSH_REJECTED` with koda's message; the outbox marks the entry rejected and the drain continues |
| save answered `409` | `MEMORY_PUSH_REJECTED` |
| retire answered `404` or `409` | resolves `deleted`; the mirror drops the note |
| any push answered `401` / `408` / `429` / `5xx`, a timeout, no answer, a non-JSON body; a save answered `404`; any forget-lookup failure | rethrown; the entry stays queued; sync records the error |
| forget lookup reaches `MEMORY_KODA_LOOKUP_MAX_PAGES` without a match | `MEMORY_KODA_LOOKUP_EXHAUSTED` (transient) |
| export answer whose `data.items` is not an array or whose `data.hasMore` is not a boolean | `MEMORY_KODA_BAD_RESPONSE`; sync keeps the last checkpointed cursor |
| export row that fails R2, or an invalid `DECISION` row | skipped, counted, logged at warn once per page with the count |
| `GET projects/<slug>` answer without a string `data.id` | `MEMORY_KODA_BAD_RESPONSE`; the project id is not memoised |
| approval status read fails (other than `404`), or the restoring lookup fails | the record is kept; warn |
| `koda-approvals.json` unreadable or invalid | read as empty; warn once |
| search fails | the host's existing remote-search guard logs a warn and answers from the mirror |
| `nax memory link`: slug invalid, project config unparsable, no url, different project without `--force`, undelivered writes on a forced relink, probe fails | stderr message, exit 1, nothing written |
| `nax memory reset` on a non-koda provider or with undelivered writes | stderr message, exit 1, nothing deleted |
| `nax memory reset` whose sync is not `synced` | result printed, exit 1 |

## Out of Scope

- A degraded mode for a koda older than `c51cf74e`: the provider needs koda #376-#379 deployed; an older koda answers `400` to a `NOTE` save and the outbox marks it rejected.
- Migrating notes already in a `local` or `mcp` mirror into koda when a project is first linked: they stay in the mirror and are not pushed.
- Remote search of user-scope notes: the host asks a provider's `search` only for project-scope and unscoped queries (`host-remote-search.ts`), and that is unchanged.
- Showing koda's own write mode, or a mismatch with `memory.writeMode`, in `nax memory status`.
- Credential sources for `memory.koda.headers` other than literal values: no `${VAR}` expansion and no `auth`/exec credential source.
- Resetting the user mirror: `nax memory reset` and a forced relink remove project mirror files only.
- Approval records after a forced relink: the relink removes `koda-approvals.json` with the rest of the project mirror (the approvals belong to the old koda project), so a user-scope note pending in the old project stays `pending` in the user mirror until forgotten.
- A supersession and a retirement of one note that land on two different export pages: R3/R5 track an unknown current id within one page only, so the stale active note survives until the next change to that slug.
- Guarding `nax memory reset` or a forced `nax memory link` against another nax process using the same mirror at the same time.
- De-duplicating koda approval requests when a `202` save is re-pushed because its first answer was lost.
- Tracking proposal forgets: a rejected proposal forget leaves the note active in koda and in the mirror, and needs no reconciliation.
- Keeping a pending local edit visible while its proposal is open: a pull carrying the slug's unchanged active row replaces it until the approved row arrives.
- Mirroring koda memory kinds other than `NOTE` and `DECISION` (`FACT`, `PREFERENCE`, `CONSTRAINT`, `INCIDENT_PATTERN`).
- Inferring the koda project from the git remote; `nax memory link` takes the slug as an argument.
- Preserving comments or formatting in `.nax/config.json` when `nax memory link` rewrites it (the file is plain JSON, rewritten with two-space indentation).
- Changes to the `nax-memory` tool instructions, the chat, the run stages or the ACP surfaces: they read the host and need none.
- Retries or backoff inside the provider: a transient failure leaves the entry in the outbox for the next sync.
- Any change in the koda repository.
- Any change in `packages/nax-agent`.

## Stories

All stories run in `packages/nax`. The feature is one capability (the koda provider and its two
CLI entry points) at 12 stories; the split is by module and operation so each story stays under
the 24-AC gate.

**US-001: Config for the koda provider.** No dependencies. Workdir: `packages/nax`. Widens `memory.provider` to `"local" | "mcp" | "koda"`, adds `MemoryKodaConfigSchema`, `KODA_PROJECT_SLUG_RE` and `MemoryKodaConfig` (exported from `@/config`), the two koda rules and the plain-http rule in `validateMemoryProvider` / the schema, and widens `MemoryConfig.provider`.

**US-002: koda HTTP client.** No dependencies. Workdir: `packages/nax`. Creates `src/memory/koda-http.ts` with `createKodaClient`, `kodaStatusOf`, `MEMORY_KODA_REQUEST_TIMEOUT_MS` and `_kodaClientDeps`.

**US-003: Export reconciliation and decision merge.** No dependencies. Workdir: `packages/nax`. Creates `src/memory/koda-mapping.ts` with `KodaMemoryItem`, `KODA_NOTE_TYPES`, `parseKodaItems`, `reconcileKodaNotes`, `mergeKodaDecisions` and `MEMORY_KODA_DECISIONS_MAX`, all pure.

**US-004: Proposal records.** No dependencies. Workdir: `packages/nax`. Creates `src/memory/koda-approvals.ts` with `createKodaApprovals` (`list`, `record`, `drop`), `KodaApproval`, `KodaApprovals` and `_kodaApprovalsDeps`.

**US-005: koda provider: reachability and save.** Depends on US-002, US-004. Workdir: `packages/nax`. Creates `src/memory/koda-provider.ts` with `createKodaMemoryProvider`, `CreateKodaMemoryProviderInput`, `MEMORY_KODA_PROVIDER_PREFIX` and `MEMORY_KODA_APPROVAL_CHECKS_MAX`: `id`, `reachable`, the memoised project id, and `push` for a save with its error classification and the `202` approval record. `pull` resolves `{ notes: [], done: true }` and `search` resolves `[]` until later stories replace them.

**US-006: koda provider: forget and search.** Depends on US-003, US-005. Workdir: `packages/nax`. Creates `src/memory/koda-lookup.ts` with `findActiveKodaNote` and `MEMORY_KODA_LOOKUP_MAX_PAGES`; adds `kodaHitOf` to `src/memory/koda-mapping.ts`; adds `push` for a forget (lookup, retire, classification) and `search` (koda full-text, hits through `kodaHitOf`) to `createKodaMemoryProvider`.

**US-007: koda provider: pull.** Depends on US-003, US-006. Workdir: `packages/nax`. Creates `src/memory/koda-pull.ts` with `pullKodaPage` (export feed, reconciliation through `reconcileKodaNotes`, the decision merge through `mergeKodaDecisions`) and makes the provider's `pull` call it.

**US-008: Proposal resolution.** Depends on US-007. Workdir: `packages/nax`. Adds the last-page resolution of recorded approvals to `pullKodaPage`: status read, drop/keep, and slug restoration through `findActiveKodaNote`.

**US-009: Host composition.** Depends on US-001, US-008. Workdir: `packages/nax`. Adds the koda branch to `composeMemory`, the three `_memoryHostDeps` entries, `MEMORY_KODA_CONFIG_MISSING`, and the barrel exports.

**US-010: `nax memory link`.** Depends on US-009. Workdir: `packages/nax`. Creates `src/cli/memory-admin.ts` with `_memoryAdminDeps`, `memoryLinkCommand` and `registerMemoryAdminCommands` (registering `link`), registered from `registerMemoryCommand`.

**US-011: `nax memory reset`.** Depends on US-010. Workdir: `packages/nax`. Adds `memoryResetCommand` to `src/cli/memory-admin.ts` and registers `reset` in `registerMemoryAdminCommands`.

**US-012: Global-only koda credentials and config descriptions.** Depends on US-001. Workdir: `packages/nax`. Extends `rejectGlobalOnlyKeys` to reject `memory.koda.url` and `memory.koda.headers` outside the global config, and adds the `FIELD_DESCRIPTIONS` entries for the `memory.koda` keys.

### Context Files

**US-001**

- `packages/nax/src/config/schemas-memory.ts` — the schema and `validateMemoryProvider` this story widens
- `packages/nax/src/config/runtime-types-memory.ts` — the hand-written `MemoryConfig` type
- `packages/nax/src/config/index.ts` — the `@/config` barrel's memory exports (lines 56, 141-149)

**US-012**

- `packages/nax/src/config/global-only-keys.ts` — the global-only guard this story extends
- `packages/nax/src/cli/config-descriptions.ts` — the memory descriptions block (lines 455-475)
- `packages/nax/src/config/loader.ts` — where `rejectGlobalOnlyKeys` runs per layer (lines 139, 197, 346, 461)

**US-002**

- `packages/nax/src/plugins/builtin/reporter-shared/post-json.ts` — an existing `fetch` deps seam
- `packages/nax/src/memory/mcp-provider.ts` — `NaxError` usage and stage naming in a memory provider

**US-003**

- `packages/nax-agent/src/memory/types.ts` — `MemoryNote`, `MemoryDecision`, `MemoryNoteType`, `MEMORY_SLUG_RE`, `MEMORY_SOURCE_MAX_CHARS`
- `packages/nax-agent/src/memory/sync.ts` — how a page is applied (lines 266-340)
- `packages/nax/src/memory/mcp-results.ts` — an existing provider-side parser

**US-004**

- `packages/nax/src/memory/mcp-id-map.ts` — the temp + rename file pattern and its deps seam
- `packages/nax/src/memory/paths.ts` — `MemoryDirs` and `MemoryLogger`

**US-005**

- `packages/nax-agent/src/memory/provider-types.ts` — the provider seam and `MemoryWriteRequest`
- `packages/nax/src/memory/mcp-provider.ts` — the existing remote provider and its `MEMORY_PUSH_REJECTED` refusals
- `packages/nax/src/memory/koda-http.ts` — created by US-002, used here
- `packages/nax/src/memory/koda-approvals.ts` — created by US-004, used here

**US-006**

- `packages/nax/src/memory/koda-provider.ts` — created by US-005, extended here
- `packages/nax/src/memory/koda-mapping.ts` — created by US-003, extended here with `kodaHitOf`
- `packages/nax/src/memory/host-remote-search.ts` — how `search` is called

**US-007**

- `packages/nax/src/memory/koda-provider.ts` — created by US-005, its `pull` replaced here
- `packages/nax/src/memory/koda-mapping.ts` — created by US-003, used here
- `packages/nax-agent/src/memory/sync.ts` — how `pull` pages are consumed

**US-008**

- `packages/nax/src/memory/koda-pull.ts` — created by US-007, extended here
- `packages/nax/src/memory/koda-approvals.ts` — created by US-004, read and dropped here
- `packages/nax/src/memory/koda-lookup.ts` — created by US-006, used here

**US-009**

- `packages/nax/src/memory/host.ts` — `composeMemory`, `composeMcp`, `_memoryHostDeps`
- `packages/nax/src/memory/index.ts` — the barrel
- `packages/nax/test/unit/memory/host-mcp.test.ts` — how the MCP branch is tested

**US-010**

- `packages/nax/src/cli/memory.ts` — `registerMemoryCommand`
- `packages/nax/src/cli/memory-cli-deps.ts` — `MemoryCliDeps`, `withMemoryHost`, `memoryContext`
- `packages/nax/test/unit/cli/memory-read.test.ts` — how the memory subcommands are tested

**US-011**

- `packages/nax/src/cli/memory-admin.ts` — created by US-010, extended here
- `packages/nax/src/cli/memory-read.ts` — `memorySyncCommand` and its output
- `packages/nax/src/memory/format.ts` — `formatMemorySyncResult`

### Creates

**US-002**

- `packages/nax/src/memory/koda-http.ts`
- `packages/nax/test/unit/memory/koda-http.test.ts`

**US-003**

- `packages/nax/src/memory/koda-mapping.ts`
- `packages/nax/test/unit/memory/koda-mapping.test.ts`

**US-004**

- `packages/nax/src/memory/koda-approvals.ts`
- `packages/nax/test/unit/memory/koda-approvals.test.ts`

**US-005**

- `packages/nax/src/memory/koda-provider.ts`
- `packages/nax/test/unit/memory/koda-provider-save.test.ts`

**US-006**

- `packages/nax/src/memory/koda-lookup.ts`
- `packages/nax/test/unit/memory/koda-provider-forget-search.test.ts`

**US-007**

- `packages/nax/src/memory/koda-pull.ts`
- `packages/nax/test/unit/memory/koda-provider-pull.test.ts`

**US-008**

- `packages/nax/test/unit/memory/koda-pull-approvals.test.ts`

**US-009**

- `packages/nax/test/unit/memory/host-koda.test.ts`

**US-010**

- `packages/nax/src/cli/memory-admin.ts`
- `packages/nax/test/unit/cli/memory-admin-link.test.ts`

**US-011**

- `packages/nax/test/unit/cli/memory-admin-reset.test.ts`

### Modifies

**US-001**

- `packages/nax/test/unit/config/schemas-memory.test.ts` — the test "AC-2: provider 'koda' fails on ['memory', 'provider']" (line 47) and the test "AC-13: provider 'koda' still fails at ['memory','provider']" (line 293) assert that `"koda"` is not a valid provider. This feature makes it valid; both tests are replaced by assertions that `provider: "koda"` with `memory.koda.url` and `memory.koda.project` parses, and that `provider: "koda"` with no `memory.koda` block fails at `["memory", "koda", "url"]`.
- `packages/nax/src/config/schemas-memory.ts` — adds `MemoryKodaConfigSchema`, `KODA_PROJECT_SLUG_RE`, `"koda"` in the provider enum and the two koda rules; the header comment stops saying `koda` is rejected.
- `packages/nax/src/config/runtime-types-memory.ts` — `MemoryConfig.provider` widens to `"local" | "mcp" | "koda"`, `MemoryConfig` gains `koda?: MemoryKodaConfig`, and `MemoryKodaConfig` is added.
- `packages/nax/src/config/index.ts` — the config barrel also exports `KODA_PROJECT_SLUG_RE`, `MemoryKodaConfigSchema` and the type `MemoryKodaConfig`.

**US-012**

- `packages/nax/src/config/global-only-keys.ts` — `rejectGlobalOnlyKeys` also rejects `memory.koda.url` and `memory.koda.headers`.
- `packages/nax/src/cli/config-descriptions.ts` — adds the four `memory.koda` entries and names `"koda"` in the `memory.provider` entry.

**US-009**

- `packages/nax/src/memory/host.ts` — `_memoryHostDeps` gains `createKodaClient`, `createKodaApprovals` and `createKodaMemoryProvider`; `composeMemory` gains the koda branch.
- `packages/nax/src/memory/index.ts` — the barrel gains the koda exports listed under Integration.

**US-010**

- `packages/nax/src/cli/memory.ts` — `registerMemoryCommand` also calls `registerMemoryAdminCommands(memory, deps)` after the read and write subcommands.
- `packages/nax/test/unit/cli/memory-read.test.ts` — the subcommand-name list asserted at line 299 (`["status", "list", "show", "sync", "save", "forget", "approve"]`) gains `"link"` after `"approve"`.
- `packages/nax/test/unit/cli/memory-forget.test.ts` — the subcommand-name list asserted at line 359 gains `"link"` after `"approve"`.
- `packages/nax/test/unit/cli/memory-save.test.ts` — the subcommand-name list asserted near line 287 gains `"link"` after `"approve"`.
- `packages/nax/test/unit/cli/memory-smoke-fixes.test.ts` — the subcommand-name list asserted near line 336 gains `"link"` after `"approve"`.

**US-011**

- `packages/nax/test/unit/cli/memory-read.test.ts` — the subcommand-name list asserted at line 299 gains `"reset"` after `"link"`.
- `packages/nax/test/unit/cli/memory-forget.test.ts` — the subcommand-name list asserted at line 359 gains `"reset"` after `"link"`.
- `packages/nax/test/unit/cli/memory-save.test.ts` — the subcommand-name list asserted near line 287 gains `"reset"` after `"link"`.
- `packages/nax/test/unit/cli/memory-smoke-fixes.test.ts` — the subcommand-name list asserted near line 336 gains `"reset"` after `"link"`.

### Seams

- US-005 calls `createKodaClient`'s `KodaClient` (US-002) and `createKodaApprovals` (US-004): US-005's tests drive the provider over a real `createKodaClient` with `_kodaClientDeps.fetch` stubbed, and over a real `createKodaApprovals` in a temporary directory, and assert the captured requests and the recorded file.
- US-006 calls `kodaHitOf` from `search`, and US-007 calls `reconcileKodaNotes` and `mergeKodaDecisions` (US-003) from `pull`: their tests drive `search`/`pull` on the provider with stubbed `fetch` and assert the mapped result, so the mapping is exercised through the provider.
- US-008 resolves the approvals US-005 records and calls `findActiveKodaNote` (US-006): its tests record approvals through a real `createKodaApprovals`, drive the provider's `pull` to the last page with stubbed `fetch`, and assert the requests and the page.
- US-009 calls `createKodaClient`, `createKodaApprovals` and `createKodaMemoryProvider` through `_memoryHostDeps`: its tests stub the three entries, trigger `createMemoryHost`, and assert each was invoked with the expected arguments; one AC triggers `memoryStatusCommand` (the `nax memory status` action) and asserts the printed provider id.
- US-010 and US-011 build their commands on the host and the client: their tests trigger `memoryLinkCommand` / `memoryResetCommand` with `_kodaClientDeps.fetch`, `_memoryAdminDeps` and the host stubbed, and one AC each runs the subcommand through the program `registerMemoryCommand` builds.

## Acceptance Criteria

### US-001

1. [unit] `NaxConfigSchema.safeParse` of `{ memory: { provider: "koda", koda: { url: "https://koda.example/api", project: "rs-stock" } } }` succeeds and the parsed `memory.provider` is `"koda"`.
2. [unit] The parsed `memory.koda` of that config equals `{ url: "https://koda.example/api", project: "rs-stock", headers: {} }`.
3. [unit] `NaxConfigSchema.parse({}).memory` has no `koda` key.
4. [unit] `NaxConfigSchema.safeParse` of `{ memory: { provider: "koda" } }` reports the message `memory.provider "koda" needs memory.koda.url in ~/.nax/config.json` at the path `["memory", "koda", "url"]`.
5. [unit] `NaxConfigSchema.safeParse` of `{ memory: { provider: "koda", koda: { url: "https://koda.example/api" } } }` reports the message `memory.provider "koda" needs memory.koda.project (run nax memory link <koda-project>)` at the path `["memory", "koda", "project"]`.
6. [unit] `NaxConfigSchema.safeParse` of `{ memory: { provider: "koda" } }` raises both the url issue and the project issue.
7. [unit] `NaxConfigSchema.safeParse` of a koda config with `memory.koda.url` set to `"ftp://koda.example"` fails with an issue whose path starts with `["memory", "koda", "url"]`.
8. [unit] `NaxConfigSchema.safeParse` of a koda config with `memory.koda.project` set to `"RS_Stock"` fails with an issue whose path starts with `["memory", "koda", "project"]`.
9. [unit] `NaxConfigSchema.safeParse` of a koda config with an extra key `memory.koda.token` fails (the block is strict).
10. [unit] `NaxConfigSchema.safeParse` of a koda config with `memory.writeMode: "proposal"` succeeds.
11. [unit] `NaxConfigSchema.safeParse` of `{ memory: { provider: "local", koda: { project: "rs-stock" } } }` succeeds (a koda block under another provider is valid and unused).
12. [unit] `KODA_PROJECT_SLUG_RE`, imported from `@/config`, accepts `"rs-stock"`.
13. [unit] `KODA_PROJECT_SLUG_RE` rejects `"-rs"`.
14. [unit] `MemoryKodaConfigSchema`, imported from `@/config`, parses `{ project: "rs-stock" }` to `{ project: "rs-stock", headers: {} }`.
15. [unit] `NaxConfigSchema.safeParse` of a koda config with `memory.koda.url` `"http://koda.example/api"` reports the message `memory.koda.url must use https unless the host is loopback`.
16. [unit] `NaxConfigSchema.safeParse` of a koda config with `memory.koda.url` `"http://localhost:8030/api"` succeeds.

### US-002

1. [unit] `createKodaClient({ url: "https://k.example/api/", headers: {}, timeoutMs: 1000 }).get("projects/rs/memory/export", { since: undefined, take: 200 })` calls `_kodaClientDeps.fetch` once with the URL `https://k.example/api/projects/rs/memory/export?take=200`.
2. [unit] `get` with query `{ kind: "NOTE", subject: "a b" }` calls `fetch` with the URL ending `?kind=NOTE&subject=a+b`.
3. [unit] `get` sends method `GET`, the configured headers and `accept: application/json`, and no body.
4. [unit] `post("memory", { a: 1 })` sends method `POST`, the header `content-type: application/json` and the body `{"a":1}`.
5. [unit] A `200` answer with body `{"ret":0,"data":{"id":"p1"}}` resolves `{ status: 200, data: { id: "p1" } }`.
6. [unit] A `202` answer with body `{"ret":0,"data":{"id":"apr_1"}}` resolves with `status` `202`.
7. [unit] A `200` answer whose body is `not json` rejects with `NaxError` code `MEMORY_KODA_BAD_RESPONSE`.
8. [unit] A `422` answer with body `{"ret":-2,"message":"description is required"}` rejects with `NaxError` code `MEMORY_KODA_HTTP` whose message is `[memory] koda POST memory answered 422: description is required`.
9. [unit] A `503` answer with a non-JSON body rejects with code `MEMORY_KODA_HTTP` whose message ends with the response's status text.
10. [unit] `kodaStatusOf` of the error from a `422` answer returns `422`.
11. [unit] `kodaStatusOf` of a `MEMORY_KODA_TIMEOUT` error returns `undefined`.
12. [unit] A `fetch` that never settles makes `get` reject with code `MEMORY_KODA_TIMEOUT` after `timeoutMs`.
13. [unit] When `get` times out, the abort signal passed to `fetch` is aborted.
14. [unit] A `fetch` that rejects with `TypeError("connection refused")` makes `get` reject with code `MEMORY_KODA_UNREACHABLE` whose `cause` is that `TypeError`.
15. [unit] With headers `{ Authorization: "Bearer s3cr3t-key" }`, the error from a `401` answer has a message and a serialised context that do not include the text `s3cr3t-key`.
16. [unit] `MEMORY_KODA_REQUEST_TIMEOUT_MS` is `4000`.

### US-003

1. [unit] `reconcileKodaNotes` of one `NOTE` row `{ id: "k1", kind: "NOTE", scope: "project", subject: "replay-budget", predicate: "project", object: "Budget 2,048 MiB.", description: "replay budget", status: "active", updatedAt: "2026-11-04T01:00:00.000Z", sourceType: "nax-chat" }` for scope `project` and an empty mirror map returns `{ notes: [{ id: "k1", slug: "replay-budget", type: "project", scope: "project", description: "replay budget", body: "Budget 2,048 MiB.", updatedAt: "2026-11-04T01:00:00.000Z", source: "nax-chat", status: "active" }], skipped: 0 }`.
2. [unit] A `NOTE` row with `scope: "user"` on a `project` page yields no note.
3. [unit] A row whose `predicate` is `"fact"` makes `reconcileKodaNotes` return `{ notes: [], skipped: 1 }`.
4. [unit] A row whose `subject` is `"Bad Slug"` makes `reconcileKodaNotes` return `{ notes: [], skipped: 1 }`.
5. [unit] A `NOTE` row with no `description` makes `reconcileKodaNotes` return `{ notes: [], skipped: 1 }`.
6. [unit] A row with `status: "superseded"` whose `id` equals the mirror's id for its slug yields no note.
7. [unit] Rows in feed order `[superseded k1, active k2]` for one slug, with the mirror holding `k1`, yield one note with `id` `k2` and status `active`.
8. [unit] Rows in feed order `[active k2, rejected k1]` for one slug yield one note with `id` `k2` and status `active` (a stale tombstone does not apply).
9. [unit] Rows in feed order `[superseded k1, deleted k2]` for one slug (`k2` with `deletedAt`), with the mirror holding `k1`, yield one note with `id` `k2` and status `deleted`.
10. [unit] A `rejected` row `k1` with the mirror holding `k1` for its slug and no other row yields one note with `id` `k1` and status `rejected`.
11. [unit] A row `k1` with `status: "active"` and a `deletedAt` value, with the mirror holding `k1`, yields one note with status `deleted`.
12. [unit] A `rejected` row `k1` with the mirror holding `k9` for its slug yields no note.
13. [unit] A `rejected` row `k1` with no mirror note for its slug yields no note.
14. [unit] Rows for slugs `b-note` and `a-note` yield notes in the order `a-note`, `b-note`.
15. [unit] A row with `sourceType` absent yields `source` `"koda"`.
16. [unit] A row with `sourceType` `"nax  run\n x"` yields `source` `"nax run x"`.
17. [unit] `mergeKodaDecisions(current, items)` with items holding no `DECISION` row returns `decisions` undefined.
18. [unit] `mergeKodaDecisions` with `current` `[d1 active]` and an active `DECISION` row `d2` with a later `updatedAt` returns `decisions` `[d2, d1]`.
19. [unit] `mergeKodaDecisions` with `current` `[d1 active]` and a `DECISION` row `d1` with `status: "superseded"` returns `decisions` `[]`.
20. [unit] `mergeKodaDecisions` with an active `DECISION` row `d1` carrying `deletedAt` removes `d1`.
21. [unit] `mergeKodaDecisions` with only a `DECISION` row lacking `object` returns `{ decisions: undefined, skipped: 1 }`.
22. [unit] `mergeKodaDecisions` with 501 active decisions returns `decisions` equal to the 500 with the newest `updatedAt` (`MEMORY_KODA_DECISIONS_MAX`), newest first.
23. [unit] `parseKodaItems` of a value that is not an array throws `NaxError` code `MEMORY_KODA_BAD_RESPONSE`.

### US-004

1. [unit] `createKodaApprovals({ dir, logger }).list()` on a directory with no `koda-approvals.json` resolves `[]`.
2. [unit] `record({ approvalId: "apr_1", scope: "project", slug: "a", clientId: "c1" })` followed by `list()` resolves exactly that one record.
3. [unit] After `record`, the file `koda-approvals.json` in `dir` parses as `{ "version": 1, "approvals": [ ... ] }` holding the record.
4. [unit] Recording `apr_2` for the same scope and slug as `apr_1` leaves one record, `apr_2`.
5. [unit] Recording for slug `a` in scope `project` and slug `a` in scope `user` leaves two records.
6. [unit] `drop(["apr_1"])` removes that record and keeps the others.
7. [unit] A write goes through `_kodaApprovalsDeps.write` to a temporary path and `_kodaApprovalsDeps.rename` onto `koda-approvals.json`.
8. [unit] A `koda-approvals.json` holding `not json` makes `list()` resolve `[]` and log one warn.
9. [unit] A file with `version: 2` makes `list()` resolve `[]` and log one warn.
10. [unit] Two `list()` calls on one instance over the same invalid file log the warn once.

### US-005

1. [unit] `createKodaMemoryProvider({ project: "rs-stock", ... }).id` is `"koda:rs-stock"`.
2. [unit] `MEMORY_KODA_PROVIDER_PREFIX` is `"koda:"` and `MEMORY_KODA_APPROVAL_CHECKS_MAX` is `20`.
3. [unit] `reachable()` requests `GET projects/rs-stock/memory/write-mode` and resolves `true` when `data.mode` is `"proposal"`.
4. [unit] `reachable()` resolves `false` when the answer is a `401`.
5. [unit] `reachable()` resolves `false` when the `200` answer's `data.mode` is absent.
6. [unit] A save `push` first requests `GET projects/rs-stock`, then `POST memory` with the body `{ "projectId": "p1", "kind": "NOTE", "subject": "replay-budget", "predicate": "project", "object": "<body>", "description": "<description>", "scope": "project", "sourceType": "nax-chat", "sourceId": "c1" }`, where `p1` is `data.id` of the project answer and `c1` is the request's `clientId`.
7. [unit] The `POST memory` body has exactly the nine keys of the save request body and no `writeMode` key, also when the request's `writeMode` is `"proposal"`.
8. [unit] A user-scope save sends `"scope": "user"` and the project id.
9. [unit] Two saves on one provider request `GET projects/rs-stock` once.
10. [unit] A `GET projects/rs-stock` answer without a string `data.id` rejects the save with `MEMORY_KODA_BAD_RESPONSE`, and the next save requests the project again.
11. [unit] A `201` save answer with `data.id` `"k7"` resolves `{ id: "k7", status: "active" }`.
12. [unit] A `202` save answer with `data.id` `"apr_1"` resolves `{ id: "c1", status: "pending" }`.
13. [unit] A `202` save answer records `{ approvalId: "apr_1", scope: "project", slug: "replay-budget", clientId: "c1" }` in the provider's approvals.
14. [unit] A `422` save answer rejects with an error `isMemoryPushRejected` recognises, whose message includes koda's message.
15. [unit] A `403` save answer rejects with an error `isMemoryPushRejected` recognises.
16. [unit] A `409` save answer rejects with an error `isMemoryPushRejected` recognises.
17. [unit] A `401` save answer rejects with an error `isMemoryPushRejected` does not recognise.
18. [unit] A `404` save answer rejects with an error `isMemoryPushRejected` does not recognise.
19. [unit] A `503` save answer rejects with an error `isMemoryPushRejected` does not recognise.

### US-006

1. [unit] `findActiveKodaNote` for scope `project` and slug `replay-budget` requests the URL `<url>/projects/rs-stock/memory?kind=NOTE&subject=replay-budget&scope=project&status=active&size=100&current=1`.
2. [unit] `findActiveKodaNote` skips a record whose `subject` is `replay-budget-2` and returns the record whose `subject` is `replay-budget`.
3. [unit] `findActiveKodaNote` whose first page has no match and `hasNext: true` requests `current=2` and returns the match found there.
4. [unit] `findActiveKodaNote` with no match and `hasNext: false` resolves `null`.
5. [unit] `findActiveKodaNote` whose pages all have `hasNext: true` and no match rejects with `MEMORY_KODA_LOOKUP_EXHAUSTED` after `MEMORY_KODA_LOOKUP_MAX_PAGES` (10) requests.
6. [unit] A forget `push` whose lookup finds nothing resolves `{ id: <clientId>, status: "deleted" }` and sends no request other than the lookup.
7. [unit] A forget whose lookup finds record `k7` sends `POST memory/notes/k7/retire` with the JSON body `{ "projectId": "p1", "reason": "stale" }`.
8. [unit] A forget whose reason is `""` sends the retire body `{ "projectId": "p1" }`.
9. [unit] A `201` retire answer resolves `{ id: <clientId>, status: "deleted" }`.
10. [unit] A `202` retire answer resolves `{ id: <clientId>, status: "pending" }`.
11. [unit] A `404` retire answer resolves `{ id: <clientId>, status: "deleted" }`.
12. [unit] A `409` retire answer resolves `{ id: <clientId>, status: "deleted" }`.
13. [unit] A `422` retire answer rejects with an error `isMemoryPushRejected` recognises.
14. [unit] A `403` retire answer rejects with an error `isMemoryPushRejected` recognises.
15. [unit] A forget whose lookup finds `k7` and whose `GET projects/rs-stock` answers `404` rejects with an error `isMemoryPushRejected` does not recognise, and sends no retire.
16. [unit] A `500` answer to the forget lookup rejects with an error `isMemoryPushRejected` does not recognise.
17. [unit] `search({ scope: "project", text: "replay budget", limit: 5 })` requests the URL `<url>/projects/rs-stock/memory?kind=NOTE&scope=project&text=replay+budget&size=5`.
18. [unit] `search` with a 150-character text sends its first 100 characters as `text`.
19. [unit] `search` with `limit: 500` sends `size=100`.
20. [unit] `search` with text `"   "` resolves `[]` without a request.
21. [unit] A search answer with `records` `[r1, r2]` resolves hits in that order with scores `2` and `1`.
22. [unit] A search answer with three valid records and `limit: 2` resolves two hits.
23. [unit] `kodaHitOf` of a record whose `object` is 300 characters with line breaks returns a `snippet` of at most 200 characters containing no line break.
24. [unit] `kodaHitOf` of a record whose `predicate` is `"decision"` returns `null`.

### US-007

1. [unit] The provider's `pull({ scope: "project", cursor: null, take: 200 })` requests `GET projects/rs-stock/memory/export?take=200` with no `since`.
2. [unit] `pull` with `cursor: "c_abc"` and `take: 200` requests the export with `since=c_abc` and `take=200`.
3. [unit] `pull` with `take: 900` requests the export with `take=500`.
4. [unit] An export answer `{ items: [<active project NOTE k1>], nextCursor: "n1", hasMore: true }` resolves a page with one active note `k1`, `nextCursor` `"n1"` and `done` `false`.
5. [unit] An export answer with `hasMore: false` and `nextCursor: null` resolves `done` `true` and `nextCursor` undefined.
6. [unit] A project pull whose items include a `user`-scope `NOTE` returns no note for it.
7. [unit] A user pull over an answer holding a `user`-scope `NOTE` returns that note.
8. [unit] A pull calls `readNote` once for each distinct slug named by a row of the pull's scope that passes R2.
9. [unit] A `rejected` row `k1` in a pull yields a note with status `rejected` when `readNote` returns a note with `id` `k1`.
10. [unit] A project pull whose items include an active `DECISION` row returns `decisions` merged with what `readDecisions` returned.
11. [unit] A project pull whose items include no `DECISION` row returns `decisions` undefined.
12. [unit] A user pull whose items include a `DECISION` row returns `decisions` undefined and does not call `readDecisions`.
13. [unit] An export answer whose `data.items` is absent rejects with `MEMORY_KODA_BAD_RESPONSE`.
14. [unit] An export answer whose `data.hasMore` is the string `"false"` rejects with `MEMORY_KODA_BAD_RESPONSE`.
15. [unit] A page with one invalid `NOTE` row logs one warn naming the skipped count `1`.
16. [integration] `syncMemory` over a store and the koda provider whose `fetch` answers the probe and an export page `[active k1 for slug a, rejected k0 for slug a]` with the mirror holding `k0` for slug `a` leaves the mirror note `a` with `id` `k1`.

### US-008

1. [unit] A last project page (`hasMore: false`) with a recorded project approval `apr_1` requests `GET approvals/apr_1`.
2. [unit] A page with `hasMore: true` requests no approval.
3. [unit] A last user page requests only the approvals recorded for scope `user`.
4. [unit] A last page with 25 recorded approvals of its scope requests `MEMORY_KODA_APPROVAL_CHECKS_MAX` (20) of them, the oldest records first.
5. [unit] An approval answered `pending` keeps the record.
6. [unit] An approval answered `approved` keeps the record.
7. [unit] An approval answered `executed` drops the record and adds no note.
8. [unit] An approval answered `404` drops the record and adds no note.
9. [unit] An approval answered `500` keeps the record and logs a warn.
10. [unit] An approval answered `rejected` drops the record.
11. [unit] An approval answered `failed`, whose mirror note has `id` equal to its `clientId` and status `pending`, with no active koda row for the slug, adds to the page the mirror's pending note with `status` `"rejected"` and every other field unchanged.
12. [unit] An approval answered `rejected`, whose mirror note is pending with its `clientId`, with an active koda row `k1` for the slug, adds `k1` to the page as the slug's note with status `active`.
13. [unit] An approval answered `expired` whose mirror note has a different `id` adds no note and makes no lookup request.
14. [unit] An approval answered `cancelled` for a slug the page already holds a note for adds no second note and makes no lookup request.
15. [unit] An approval answered `rejected` whose restoring lookup answers `500` keeps the record and adds no note.
16. [integration] `syncMemory` over a store holding a pending note `a` with id `c1`, a recorded approval `apr_1` for it answered `rejected`, an empty export page and no active koda row, leaves no project note `a` in the mirror.

### US-009

1. [unit] `createMemoryHost` with `memory.provider: "koda"`, `memory.koda` `{ url: "https://k/api", project: "rs-stock", headers: { Authorization: "Bearer x" } }` calls `_memoryHostDeps.createKodaClient` once with `{ url: "https://k/api", headers: { Authorization: "Bearer x" }, timeoutMs: MEMORY_KODA_REQUEST_TIMEOUT_MS }`.
2. [unit] It calls `_memoryHostDeps.createKodaApprovals` once with `dir` equal to the host's `dirs.projectDir`.
3. [unit] It calls `_memoryHostDeps.createKodaMemoryProvider` once with `project` `"rs-stock"`, the client and the approvals the two stubs returned.
4. [unit] The `readNote` handed to the provider resolves the note the mirror store holds for a scope and slug.
5. [unit] The `readDecisions` handed to the provider resolves the decisions the mirror store holds.
6. [unit] The host's `providerId` is `"koda:rs-stock"`.
7. [unit] A host with `provider: "koda"` calls neither `createMcpPool` nor `createLocalMemoryProvider`.
8. [unit] `createMemoryHost` with `provider: "koda"` and no `memory.koda.project` (config built without the schema) rejects with `NaxError` code `MEMORY_KODA_CONFIG_MISSING`.
9. [unit] `close()` on a koda-backed host resolves and can be called twice.
10. [integration] `host.sync()` on a koda-backed host whose stubbed `fetch` answers the write-mode probe and one export page holding an active project `NOTE` writes that note into the mirror, and `host.getNote("project", <slug>)` returns it.
11. [integration] `host.save` of a note on a koda-backed host followed by `host.sync()` with `fetch` answering `201` leaves the mirror note with the koda id and status `active`.
12. [integration] `host.search` on a koda-backed host returns the koda hit ahead of a local hit with a different slug.
13. [cli] `memoryStatusCommand` with `--json` for a repository configured with `provider: "koda"` and project `rs-stock` prints a document whose `provider` is `"koda:rs-stock"`.
14. [unit] `createKodaClient`, `kodaStatusOf`, `MEMORY_KODA_REQUEST_TIMEOUT_MS`, `createKodaApprovals`, `createKodaMemoryProvider` and `MEMORY_KODA_PROVIDER_PREFIX` are importable from the `@/memory` barrel.

### US-010

1. [cli] `memoryLinkCommand("rs-stock", { dir })` with a global `memory.koda.url` and a probe answering `{"ret":0,"data":{"mode":"direct"}}` writes `<repoRoot>/.nax/config.json` whose `memory.provider` is `"koda"` and `memory.koda.project` is `"rs-stock"`, and returns `0`.
2. [cli] The link keeps every other key of the raw project config, including other `memory` keys.
3. [cli] With a global config holding `memory.koda.url` and `memory.koda.headers`, the written project config has no `memory.koda.url` key and no `memory.koda.headers` key.
4. [cli] The link writes `<repoRoot>/.nax/config.json` when the file does not exist.
5. [cli] The written text is `JSON.stringify(config, null, 2)` followed by one newline.
6. [cli] The link writes through `_memoryAdminDeps.writeText` to `config.json.tmp` and `_memoryAdminDeps.rename` onto `config.json`.
7. [cli] The link probes `GET <url>/projects/rs-stock/memory/write-mode` with the global config's headers.
8. [cli] The link prints `linked <repoRoot> to koda project rs-stock (write mode: direct)`.
9. [cli] With `--json`, the link prints one document `{ "project": "rs-stock", "writeMode": "direct", "configPath": "<path>" }`.
10. [cli] `memoryLinkCommand("RS stock", ...)` prints `[memory] "RS stock" is not a koda project slug` to stderr, returns `1` and calls `_memoryAdminDeps.writeText` zero times.
11. [cli] With no `memory.koda.url` in the loaded config, the link prints `[memory] memory.koda.url is not set in ~/.nax/config.json` to stderr, returns `1` and writes nothing.
12. [cli] With the probe answered `403`, the link prints a stderr line starting `[memory] koda project "rs-stock" is not reachable:`, returns `1` and writes nothing.
13. [cli] With the probe answered `200` and `data.mode` `"other"`, the link prints a stderr line starting `[memory] koda project "rs-stock" is not reachable:`, returns `1` and writes nothing.
14. [cli] With `_memoryAdminDeps.readText` returning `{ broken` for the project config, the link prints `[memory] cannot link: <path> is not valid JSON` to stderr, returns `1` and writes nothing.
15. [cli] With `_memoryAdminDeps.readText` returning `[1]` for the project config, the link prints `[memory] cannot link: <path> is not a JSON object` to stderr, returns `1` and writes nothing.
16. [cli] With the project config naming `memory.koda.project` `"other"` and no `--force`, the link prints `[memory] already linked to koda project "other"; pass --force to relink (the project mirror is rebuilt)` to stderr, returns `1` and writes nothing.
17. [cli] With the project config naming `"other"`, `--force`, and a host status of `queued: 1, rejected: 0`, the link prints `[memory] 1 writes are not delivered; run nax memory sync (or nax memory forget) before relinking` to stderr, returns `1` and writes nothing.
18. [cli] With the project config naming `"other"`, `--force` and nothing undelivered, the link writes the config and then calls `_memoryAdminDeps.removePath` with the host's `dirs.projectDir`.
19. [cli] With the project config already naming `"rs-stock"` and `--force`, the link succeeds and calls `_memoryAdminDeps.removePath` zero times.
20. [cli] Running `nax memory link rs-stock` through the program `registerMemoryCommand` builds reaches `memoryLinkCommand` with the slug `rs-stock`.

### US-011

1. [cli] `memoryResetCommand({ dir })` on a host whose provider id is `"local"` prints `[memory] reset needs memory.provider "koda": the local mirror is the only copy of its notes` to stderr, returns `1` and calls `_memoryAdminDeps.removePath` zero times.
2. [cli] `memoryResetCommand` on a koda host whose status reports `queued: 1, rejected: 1` prints `[memory] 2 writes are not delivered; run nax memory sync (or nax memory forget) before reset` to stderr, returns `1` and removes nothing.
3. [cli] `memoryResetCommand` with memory disabled prints the existing memory-disabled error and returns the same exit code `nax memory sync` returns when memory is disabled.
4. [cli] `memoryResetCommand` on a koda host with nothing undelivered removes every entry of `dirs.projectDir` except `koda-approvals.json`.
5. [cli] The reset keeps `koda-approvals.json` in `dirs.projectDir` byte-identical.
6. [cli] The reset leaves `dirs.userDir` untouched.
7. [cli] The reset calls `host.sync()` once, after the removal.
8. [cli] The reset prints the sync result as `formatMemorySyncResult` renders it.
9. [cli] With `--json`, the reset prints the sync result as one JSON document.
10. [cli] The reset returns `0` when the sync outcome is `"synced"`.
11. [cli] The reset returns `1` when the sync outcome is `"unreachable"`.
12. [cli] Running `nax memory reset` through the program `registerMemoryCommand` builds reaches `memoryResetCommand`, and the `memory` command's subcommand names are `["status", "list", "show", "sync", "save", "forget", "approve", "link", "reset"]`.

### US-012

1. [unit] `rejectGlobalOnlyKeys({ memory: { koda: { url: "https://k/api" } } }, "project")` throws `NaxError` with code `MEMORY_KODA_CONFIG_NOT_GLOBAL` and the message `memory.koda.url belongs in ~/.nax/config.json and cannot be set in project`.
2. [unit] `rejectGlobalOnlyKeys({ memory: { koda: { headers: { Authorization: "Bearer x" } } } }, "profile:p")` throws `NaxError` with code `MEMORY_KODA_CONFIG_NOT_GLOBAL` and a message naming `memory.koda.headers` and `profile:p`.
3. [unit] `rejectGlobalOnlyKeys({ memory: { koda: { project: "rs-stock" } } }, "project")` returns its input unchanged.
4. [integration] `loadConfig` for a repository whose `.nax/config.json` sets `memory.koda.url` rejects with code `MEMORY_KODA_CONFIG_NOT_GLOBAL`.
5. [integration] `loadConfig` with a global config setting `memory.koda.url` and `memory.koda.headers` and a project config setting `memory.provider: "koda"` and `memory.koda.project` resolves `memory.koda` to the union of the two layers.
6. [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for `memory.koda`.
7. [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for `memory.koda.url`.
8. [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for `memory.koda.project`.
9. [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for `memory.koda.headers`.
10. [unit] The `FIELD_DESCRIPTIONS` entry for `memory.provider` mentions `"koda"`.
