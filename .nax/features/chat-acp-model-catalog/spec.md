# SPEC: chat ACP model catalog without a first open

Closes: #2746

## Summary

In `nax chat`, `/model` lists each installed ACP agent's own models (`acp:<agent>/<model>`) and effort levels before that agent has been opened in the current chat process. The catalog gets them three ways. First, the last offer learned per agent is saved to `acp-offers.json` in the chat sessions dir and loaded at chat start. Second, at chat start a background probe runs for every installed agent that has no known offer: it launches the agent, opens an ACP session with no tools, reads the offered models and efforts, and closes it. Third, a new `/model refresh` command re-probes every installed agent and prints one result line per agent. A normal open of an ACP agent still learns its offer, as it does today, and now also saves it.

## Motivation

- #2746 (canary.9, main `199df884f`): `/model` shows only the bare rows `acp:claude`, `acp:codex`, `acp:cursor` until that agent has been opened once in the current chat process. A user who wants to start on, or switch to, a specific ACP model cannot see or pick it first.
- Cause: `createAcpCatalog` (`packages/nax/src/chat/acp/acp-catalog.ts`) learns `offeredModels` / `offeredEfforts` only in `opened()`, which `reportAcpOpens` (`packages/nax/src/chat/acp/acp-host.ts`) calls after a successful open. The catalog lives only in memory and nothing asks an agent ahead of time.
- User rulings (2026-10-30): save the offer and also probe in the background, probing at chat start only installed agents that have no known offer (at most once per agent per start; an agent that keeps reporting no models or failing is probed again at each start), and add a manual re-probe command.

## Design

### Integration

Symbols this feature only **reads** (verified on main `a421fdd68`):

- `ACP_CHAT_AGENTS = ["claude", "codex", "cursor"] as const`, `type AcpChatAgent`, `acpAgentLabel(agent): string` (labels `Claude Code`, `Codex`, `Cursor`), `acpModelRows(agent, offeredModels)`, `acpEffortLevels(offeredEfforts)`, `parseChatAcpModel(model)` (`packages/nax/src/chat/acp/acp-model.ts`).
- `resolveChatSessionsDir(env): string` (`packages/nax/src/chat/open-chat-session.ts`): `env.NAX_AGENT_SESSIONS_DIR` or the default sessions dir under the global config dir.
- `createAgentSession(options: CreateAgentSessionOptions): Promise<AgentSession>` and `createMemoryTranscriptStore()` (`@nathapp/nax-agent`). `CreateAgentSessionOptions` requires `backend`, `profile` and `transcriptStore`; `workdir`, `tools`, `instructions` and `sessionId` are optional. `AgentSession.backend.capabilities` is the record `reportAcpOpens` already reads, and it carries `offeredModels` / `offeredEfforts`. `AgentSession.close(): Promise<void>`. `packages/nax/src/chat/subagent-session.ts` already opens a session with `createMemoryTranscriptStore()`; it is the pattern to mirror.
- `acpBackend(input: AcpBackendOptions): SessionBackend` (`@nathapp/nax-agent-acp/client`); `AcpBackendOptions` accepts `agent`, `allowUnsandboxed`, `inheritEnv` and `initializeTimeoutMs` (default `DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000`, applied to each open step). `acpSessionOptions` (`packages/nax/src/chat/acp/acp-session-options.ts`) is the existing chat call site: `acpBackend({ agent, allowUnsandboxed: true, inheritEnv: true, ... })`.
- `launchCandidateKind(agent, env)` through `_acpCatalogDeps` (the existing installed-binary probe, run once per catalog).
- The atomic write pattern in `packages/nax/src/chat/jobs/job-store.ts` (`writeJobRecord`): write `<name>.<uuid>.tmp` with `Bun.write`, then `renameSync` onto the final name, with the file system calls behind a `_jobStoreDeps` object.
- `NativeChatHost.teardown()` (`packages/nax/src/chat/chat-host.ts`): the final close path, run once from `close()`.
- `runSlashCommand` `case "model"` (`packages/nax/src/tui/chat/slash-commands.ts`): `/model` with no argument returns `{ kind: "picker", picker: "model" }`; with an argument it calls `host.switchTo({ model: arg })`. `show(text)` writes a transcript note.

Symbols this feature **changes**. Each baseline exists only to locate the code; it is never the interface to implement.

- `createAcpCatalog` input (`acp-catalog.ts`).
  Baseline: `createAcpCatalog(input: { readonly env: Readonly<Record<string, string | undefined>> }): AcpCatalog`.
  Target: `createAcpCatalog(input: { readonly env; readonly sessionsDir?: string; readonly logger?: Pick<Logger, "warn" | "debug"> }): AcpCatalog`. Without `sessionsDir` nothing is loaded or saved (the existing tests' `createAcpCatalog({ env: {} })` keeps today's memory-only behaviour). With it, the catalog builds its store with `_acpCatalogDeps.createAcpOfferStore({ path: acpOffersPath(sessionsDir), logger })`. `_acpCatalogDeps` also gains `probeAcpAgent` (US-002), the seam through which the catalog probes.
- `AcpCatalog` interface (`acp-catalog.ts`).
  Baseline: `rows`, `effortLevels`, `installed`, `unavailable`, `opened`, `failed`.
  Target: the same six members plus `load(): Promise<void>` (US-001), `warm(cwd: string): void` and `close(): void` (US-002), and `refresh(cwd: string): Promise<readonly AcpRefreshResult[]>` (US-003).
- `opened(model, capabilities)` (`acp-catalog.ts`).
  Baseline: stores the reported `offeredModels` / `offeredEfforts` in memory and clears the agent's recorded failure.
  Target: the same, then, when the catalog has a store and either list was reported, saves every agent's current offer through the store without awaiting it.
- `composeChat` (`packages/nax/src/cli/chat.ts`).
  Baseline: `acp: deps.createAcpCatalog({ env: deps.env })` inline in the `createChatHost` call.
  Target: `const acp = deps.createAcpCatalog({ env: deps.env, sessionsDir: resolveChatSessionsDir(deps.env), logger })`, then `await acp.load()` before `createChatHost` (US-001), then `acp.warm(cwd)` once `startHost` has resolved (US-002), so the chat's own first open has already learned its agent and that agent is not probed alongside it, and `acp` is passed as the host's `acp`.
- `NativeChatHost.teardown()` (`chat-host.ts`). Target: calls `this.deps.acp?.close()` before draining the session operations (US-002).
- `ChatHost` interface (`chat-host.ts`). Target: gains optional `refreshAcpModels?(): Promise<readonly AcpRefreshResult[]>`; `NativeChatHost` implements it as `this.deps.acp?.refresh(this.deps.cwd)`, or `[]` without a catalog (US-003).
- `runSlashCommand` `case "model"` (`slash-commands.ts`). Target: the argument `refresh` runs the refresh (US-003); every other argument still switches.

### New modules

`packages/nax/src/chat/acp/acp-offer-store.ts` (US-001):

```ts
export interface AcpOffer {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}
export interface AcpOfferStore {
  load(): Promise<ReadonlyMap<AcpChatAgent, AcpOffer>>;
  save(offers: ReadonlyMap<AcpChatAgent, AcpOffer>): Promise<void>;
}
export const ACP_OFFERS_FILE = "acp-offers.json";
export function acpOffersPath(sessionsDir: string): string; // join(sessionsDir, ACP_OFFERS_FILE)
export function createAcpOfferStore(input: { readonly path: string; readonly logger?: Pick<Logger, "warn"> }): AcpOfferStore;
export const _acpOfferStoreDeps = { /* read, write, rename, mkdir, randomUUID */ };
```

`packages/nax/src/chat/acp/acp-probe.ts` (US-002):

```ts
export const ACP_PROBE_TIMEOUT_MS = 20_000;
export const _acpProbeDeps = { createAgentSession, acpBackend, createMemoryTranscriptStore };
/** Opens a tool-less ACP session on the agent, returns its backend capabilities, and closes it. */
export async function probeAcpAgent(input: { readonly agent: AcpChatAgent; readonly cwd: string }): Promise<Readonly<Record<string, unknown>>> {
  const session = await _acpProbeDeps.createAgentSession({
    backend: _acpProbeDeps.acpBackend({ agent: input.agent, allowUnsandboxed: true, inheritEnv: true, initializeTimeoutMs: ACP_PROBE_TIMEOUT_MS }),
    profile: "ask",
    workdir: input.cwd,
    tools: [],
    transcriptStore: _acpProbeDeps.createMemoryTranscriptStore(),
  });
  try {
    return session.backend.capabilities;
  } finally {
    await session.close().catch(() => undefined);
  }
}
```

`AcpRefreshResult` (US-003, exported from `acp-catalog.ts` and the `@/chat/acp` barrel):

```ts
export type AcpRefreshResult =
  | { readonly agent: AcpChatAgent; readonly outcome: "learned"; readonly models: number }
  | { readonly agent: AcpChatAgent; readonly outcome: "not installed" }
  | { readonly agent: AcpChatAgent; readonly outcome: "failed"; readonly reason: string };
```

### File Format

`<sessionsDir>/acp-offers.json`:

```json
{
  "version": 1,
  "agents": {
    "codex": { "models": ["gpt-6.1-codex", "gpt-6.1-codex-mini"], "efforts": ["low", "medium", "high"] },
    "claude": { "models": ["default", "opus", "sonnet"], "efforts": [] }
  }
}
```

- `version` must be `1`. Keys under `agents` that are not in `ACP_CHAT_AGENTS` are ignored. An agent entry whose `models` is not an array is ignored; non-string elements of `models` or `efforts` are dropped; a missing or non-array `efforts` reads as `[]`.
- The model ids are the agent's offered ids as `offeredChoices` already cleaned them (secret-redacted, length-capped) before they reached `capabilities`; the store writes them unchanged.

### Catalog composition

Where the offers come from:

1. **Learned this process**: `opened()` after a real open, or a successful probe. This always wins.
2. **Saved**: `load()` never rejects (a store error is logged as one `warn` on stage `chat` and leaves the catalog empty) and fills an agent from the file only when nothing has been learned for it yet in this process.
3. **Probe at start**: `warm(cwd)` probes each agent that is installed and still has no models after steps 1-2. An agent with a saved or learned offer is not probed.
4. **Manual**: `refresh(cwd)` probes every installed agent regardless of steps 1-3.

An agent **has a known offer** when its models list is non-empty; an offer with no models counts as none, so such an agent is probed again at the next start. A save writes only agents with a known offer. Saves are serialised: a save starts only after the previous one has settled, so an older snapshot can never land last.

At most one probe per agent is in flight: a `warm` or `refresh` that finds a probe for that agent already running reuses it rather than starting another. A probe that succeeds is handled exactly as `opened(\`acp:<agent>\`, capabilities)`. A probe that fails is handled exactly as `failed(\`acp:<agent>\`, error)` and logged at debug. After `close()`, a probe that settles is not learned, not recorded as a failure, and not saved.

`ACP_PROBE_TIMEOUT_MS` is a named constant, not a config key: it bounds a background probe nobody waits on, and the chat open path keeps its own configured timeouts.

`/model refresh` runs when the first argument is exactly the lowercase `refresh` (further arguments are ignored); any other first argument, including `Refresh`, is still a model switch, so a model whose id is literally `refresh` cannot be picked by name (it remains pickable in the picker).

A refresh result's `models` is the number of model ids the probe reported, not the number of rows the picker shows. A refresh result's `failed` reason is the catalog's existing open-failure reason (`not logged in` for `AGENT_SESSION_AUTH_REQUIRED`, the message's first line for `AGENT_SESSION_BACKEND_UNAVAILABLE`); for any other error it is the error message's first line cut to 120 characters, and `probe failed` when that is empty.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `acp-offers.json` missing | `load()` resolves an empty map; no log. |
| `acp-offers.json` unreadable, not JSON, or `version` other than `1` | `load()` resolves an empty map and logs one `warn` on stage `chat` naming the path; the file is left as it is and is overwritten by the next save. |
| A save fails (write or rename throws) | The rejection is logged as one `warn` on stage `chat`; `opened()` and probe handling never throw because of it; the temp file is removed on a best-effort basis. |
| A probe's open fails | Handled as `failed(\`acp:<agent>\`, error)`: an `AGENT_SESSION_AUTH_REQUIRED` error makes `unavailable` report `not logged in` and a backend-unavailable error its first line, as today; any other error records nothing. The error is logged at debug and never reaches the caller of `warm`. |
| A probe's open succeeds but its close throws | The capabilities are still returned; the close error is swallowed. |
| A probe never settles | It is bounded by `ACP_PROBE_TIMEOUT_MS` per open step through `initializeTimeoutMs`. |
| The chat closes while a probe runs | `close()` does not wait; the late result is dropped. |

## Out of Scope

- An open `/model` picker does not re-render when a probe finishes; the new rows appear the next time the picker opens (`ChatHost.models` already reads the catalog live).
- Hiding the probe's session from the agent's own session or resume list: an agent such as Claude Code or Codex may list the short probe session as one of its sessions.
- Killing an in-flight probe's agent process when the chat quits; `close()` only drops the probe's result, and the process ends when its open settles or the nax process exits.
- Re-checking whether an agent's binary is installed during a chat: the install probe runs once per catalog, so an agent installed mid-chat reads `not installed` in `/model refresh` until the next chat.
- A progress note while `/model refresh` waits on its probes; the result lines appear when every probe has settled.
- Merging the offers file across concurrent chat processes: each save rewrites the whole file atomically, and the last writer wins.
- Expiry or a time-to-live on saved offers: a saved offer stays until a later open, probe or refresh replaces it.
- Probing on a schedule, or probing again during a chat other than through `/model refresh`.
- Changing how an ACP open applies a requested model or effort, or how `acpModelRows` / `acpEffortLevels` filter offered ids.
- Native model discovery (`discoverModels`, `chatModelChoices`) is unchanged.
- The `/help` text and `COMMAND_DESCRIPTIONS.model` are unchanged; `/model refresh` is not listed separately in the slash menu.

## Stories

**US-001: Save and load each ACP agent's offer.** No dependencies. Workdir: `packages/nax`. Add `acp-offer-store.ts` (load and atomic save of `acp-offers.json`), give `createAcpCatalog` optional `sessionsDir` and `logger`, add `AcpCatalog.load()`, have `opened()` save the offers, and have `composeChat` create the catalog with the sessions dir and await `load()` before creating the host.

**US-002: Probe agents with no known offer at chat start.** Depends on US-001. Workdir: `packages/nax`. Add `acp-probe.ts` (`probeAcpAgent`), add `AcpCatalog.warm(cwd)` and `AcpCatalog.close()` with the one-probe-per-agent rule, call `acp.warm(cwd)` from `composeChat` after `startHost` has resolved, and call `acp.close()` from `NativeChatHost.teardown()`.

**US-003: `/model refresh` re-probes every installed agent.** Depends on US-002. Workdir: `packages/nax`. Add `AcpRefreshResult` and `AcpCatalog.refresh(cwd)`, add optional `ChatHost.refreshAcpModels()` implemented by `NativeChatHost`, and make `/model refresh` print one line per agent.

### Context Files

**US-001**
- `packages/nax/src/chat/acp/acp-catalog.ts` — the catalog this story extends.
- `packages/nax/src/chat/jobs/job-store.ts` — the temp-file-then-rename write pattern and `_jobStoreDeps` seam to mirror.
- `packages/nax/src/chat/open-chat-session.ts` — `resolveChatSessionsDir`.
- `packages/nax/src/cli/chat.ts` — `composeChat`, where the catalog is created.
- `packages/nax/test/unit/chat/acp/acp-catalog.test.ts` — existing catalog test style and `_acpCatalogDeps` use.

**US-002**
- `packages/nax/src/chat/acp/acp-catalog.ts` — the catalog this story extends.
- `packages/nax/src/chat/acp/acp-session-options.ts` — the existing `acpBackend({ agent, allowUnsandboxed: true, inheritEnv: true })` call.
- `packages/nax/src/chat/subagent-session.ts` — a session opened on `createMemoryTranscriptStore()`.
- `packages/nax/src/chat/chat-host.ts` — `NativeChatHost.teardown()`.
- `packages/nax/src/cli/chat.ts` — `composeChat`.

**US-003**
- `packages/nax/src/chat/acp/acp-catalog.ts` — the catalog this story extends.
- `packages/nax/src/chat/chat-host.ts` — the `ChatHost` interface and `NativeChatHost`.
- `packages/nax/src/tui/chat/slash-commands.ts` — `runSlashCommand` `case "model"`.
- `packages/nax/test/unit/tui/chat/slash-commands-acp.test.ts` — slash-command test style with a fake host.

### Creates

**US-001**
- `packages/nax/src/chat/acp/acp-offer-store.ts`
- `packages/nax/test/unit/chat/acp/acp-offer-store.test.ts`

**US-002**
- `packages/nax/src/chat/acp/acp-probe.ts`
- `packages/nax/test/unit/chat/acp/acp-probe.test.ts`

**US-003**
- `packages/nax/test/unit/chat/acp/acp-catalog-refresh.test.ts`
- `packages/nax/test/unit/tui/chat/slash-commands-model-refresh.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/cli/chat.test.ts` — the fixture spreads `api._chatCommandDeps`, so every `chatCommand` test would use the real `createAcpCatalog` and read the real sessions dir; make the fixture's default `createAcpCatalog` return `stubAcpCatalog()`. Separately, the test "US-008 AC-1" asserts `createAcpCatalog` was called with exactly `{ env: f.deps.env }`; `composeChat` now also passes `sessionsDir` and `logger`. Replace it with an assertion that the call's `env` is `f.deps.env` and its `sessionsDir` equals `resolveChatSessionsDir(f.deps.env)`. `stubAcpCatalog()` must also gain `load: async () => {}` to satisfy the widened `AcpCatalog` interface, and the file gains the US-001 AC-16 and AC-20 tests.
- `packages/nax/test/unit/chat/chat-host-acp.test.ts` — `stubCatalog()` builds a closed `AcpCatalog` literal; add `load: async () => {}` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp-models.test.ts` — its local `AcpCatalog` fake is a closed literal; add `load: async () => {}` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp-switch.test.ts` — its local `AcpCatalog` fake is a closed literal; add `load: async () => {}` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-host.test.ts` — its local `AcpCatalog` fake is a closed literal; add `load: async () => {}` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its fixture spreads `_chatCommandDeps`, so it would use the real `createAcpCatalog`, read the real sessions dir and (after US-002) probe real agents. Override `createAcpCatalog` in the fixture with a local stub catalog whose new members are no-ops (`load`). No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-catalog.test.ts` — gains the new `load`, saved-offer and save-on-open cases (US-001 AC-10 to AC-15, AC-17 to AC-19); existing cases keep `createAcpCatalog({ env })` without `sessionsDir` and are unchanged.

**US-002**
- `packages/nax/test/unit/cli/chat.test.ts` — `stubAcpCatalog()` must gain `warm: () => {}` and `close: () => {}` to satisfy the widened `AcpCatalog` interface, and the file gains the US-002 AC-13 and AC-14 tests. Existing assertions unchanged.
- `packages/nax/test/unit/chat/chat-host-acp.test.ts` — `stubCatalog()` must gain `warm: () => {}` and `close: mock(() => {})` to satisfy the widened `AcpCatalog` interface, and the file gains the US-002 AC-15 test. Existing assertions unchanged.
- `packages/nax/test/unit/chat/chat-host-acp-models.test.ts` — its local `AcpCatalog` fake is a closed literal; add `warm: () => {}` and `close: () => {}` so it satisfies the widened interface. `chat-host-acp-models` and `chat-host-acp-switch` close real hosts, so without `close` their teardown throws. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp-switch.test.ts` — its local `AcpCatalog` fake is a closed literal; add `warm: () => {}` and `close: () => {}` so it satisfies the widened interface. `chat-host-acp-models` and `chat-host-acp-switch` close real hosts, so without `close` their teardown throws. No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-host.test.ts` — its local `AcpCatalog` fake is a closed literal; add `warm: () => {}` and `close: () => {}` so it satisfies the widened interface. `chat-host-acp-models` and `chat-host-acp-switch` close real hosts, so without `close` their teardown throws. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its fixture spreads `_chatCommandDeps`, so it would use the real `createAcpCatalog`, read the real sessions dir and (after US-002) probe real agents. Override `createAcpCatalog` in the fixture with a local stub catalog whose new members are no-ops (`warm`, `close`). No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-catalog.test.ts` — gains the `warm` and `close` cases (US-002 AC-6 to AC-12); existing cases unchanged.

**US-003**
- `packages/nax/test/unit/cli/chat.test.ts` — `stubAcpCatalog()` must gain `refresh: async () => []` to satisfy the widened `AcpCatalog` interface. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp.test.ts` — `stubCatalog()` must gain `refresh: mock(async () => [])` to satisfy the widened `AcpCatalog` interface, and the file gains the US-003 AC-7 and AC-8 tests. Existing assertions unchanged.
- `packages/nax/test/unit/chat/chat-host-acp-models.test.ts` — its local `AcpCatalog` fake is a closed literal; add `refresh: async () => []` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp-switch.test.ts` — its local `AcpCatalog` fake is a closed literal; add `refresh: async () => []` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-host.test.ts` — its local `AcpCatalog` fake is a closed literal; add `refresh: async () => []` so it satisfies the widened interface. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its fixture spreads `_chatCommandDeps`, so it would use the real `createAcpCatalog`, read the real sessions dir and (after US-002) probe real agents. Override `createAcpCatalog` in the fixture with a local stub catalog whose new members are no-ops (`refresh`). No assertion changes.

### Seams

- US-001 -> `composeChat`: `createAcpCatalog` receives `sessionsDir`, and `load()` is awaited before `createChatHost` is called (US-001 AC-16, AC-20).
- US-002 -> `composeChat` and `NativeChatHost`: `warm` is called with the chat's cwd after `startHost` resolves; `close` is called by the host's close (US-002 AC-13, AC-14, AC-15).
- US-003 -> `/model refresh`: the slash command calls `ChatHost.refreshAcpModels`, which calls `AcpCatalog.refresh` with the host's cwd (US-003 AC-7, AC-10).

## Acceptance Criteria

### US-001

1. [unit] `acpOffersPath("/s")` returns the path `/s/acp-offers.json` (joined with the platform separator).
2. [unit] `createAcpOfferStore({ path }).load()` resolves an empty map when no file exists at `path`, and calls no logger method.
3. [unit] `load()` on a file holding `{"version":1,"agents":{"codex":{"models":["m1","m2"],"efforts":["high"]}}}` resolves a map whose `codex` entry is `{ models: ["m1","m2"], efforts: ["high"] }` and which has no other entry.
4. [unit] `load()` ignores an `agents` key that is not `claude`, `codex` or `cursor`, drops non-string elements of `models` and `efforts`, ignores an agent entry whose `models` is not an array, and reads a missing `efforts` as `[]`.
5. [unit] `load()` on a file that is not valid JSON resolves an empty map and calls `logger.warn` once with stage `chat` and a message naming the path.
6. [unit] `load()` on a file whose `version` is `2` resolves an empty map and calls `logger.warn` once with stage `chat`.
7. [unit] `save(new Map([["cursor", { models: ["a"], efforts: [] }]]))` writes a temp file in the same directory whose name ends in `.tmp`, then renames it onto `path`, and a following `load()` on the same path resolves `cursor` as `{ models: ["a"], efforts: [] }`.
8. [unit] `save` creates the parent directory of `path` when it does not exist.
9. [unit] When the rename throws, `save` rejects with that error and the temp file it wrote no longer exists.
10. [unit] With `createAcpCatalog({ env, sessionsDir })` whose store's `load` resolves `codex` as `{ models: ["m1"], efforts: ["high"] }`, after `await catalog.load()` `rows()` includes `acp:codex/m1` and `effortLevels("acp:codex")` includes `high`, with no `opened()` call.
11. [unit] When `opened("acp:codex", { offeredModels: ["live"] })` runs before `load()` resolves a saved `codex` offer of `["saved"]`, `rows()` includes `acp:codex/live` and not `acp:codex/saved`.
12. [unit] `opened("acp:claude", { offeredModels: ["opus"], offeredEfforts: [] })` on a catalog with a `sessionsDir` calls the store's `save` once with a map whose `claude` entry is `{ models: ["opus"], efforts: [] }` and which also carries every other agent's offer known at that moment.
13. [unit] `opened("acp:claude", {})` (neither list reported) does not call the store's `save`.
14. [unit] When the store's `save` rejects, `opened()` returns normally and `logger.warn` is called once with stage `chat`; no unhandled rejection is raised.
15. [unit] `createAcpCatalog({ env })` with no `sessionsDir` never creates a store: `load()` resolves without reading a file and `opened()` never saves.
16. [integration] Running the chat command (`chatCommand`) with a stub `createAcpCatalog` calls it once with `env` equal to the command's env and `sessionsDir` equal to `resolveChatSessionsDir(env)`.
17. [unit] Two `opened()` calls that each learn models start their saves in order: the second save's write does not begin until the first save has settled.
18. [unit] A save made when `codex` has a known offer and `cursor` has only `efforts` reported (no models) writes `codex` and no `cursor` entry.
19. [unit] When the store's `load` rejects, `catalog.load()` resolves, `logger.warn` is called once with stage `chat`, and `rows()` still lists the bare `acp:<agent>` rows.
20. [integration] Running the chat command with a stub catalog whose `load` is a spy calls `load` once, and that call happens before `createChatHost` is called.

### US-002

1. [unit] `probeAcpAgent({ agent: "codex", cwd: "/r" })` calls `_acpProbeDeps.acpBackend` once with `{ agent: "codex", allowUnsandboxed: true, inheritEnv: true, initializeTimeoutMs: 20000 }`.
2. [unit] `probeAcpAgent` calls `_acpProbeDeps.createAgentSession` once with `profile` `"ask"`, `workdir` `"/r"`, `tools` `[]`, a `transcriptStore` from `_acpProbeDeps.createMemoryTranscriptStore`, and the backend returned by `acpBackend`.
3. [unit] When the created session's `backend.capabilities` is `{ offeredModels: ["m"] }`, `probeAcpAgent` resolves that record and the session's `close` was called once.
4. [unit] When the session's `close` rejects, `probeAcpAgent` still resolves the capabilities.
5. [unit] When `createAgentSession` rejects with an error, `probeAcpAgent` rejects with that same error.
6. [unit] `catalog.warm("/r")` with `codex` installed and nothing known for it calls `_acpCatalogDeps.probeAcpAgent` once with `{ agent: "codex", cwd: "/r" }`, and returns before that probe settles.
7. [unit] `warm` does not probe an agent whose binary does not resolve (`launchCandidateKind` returns `undefined`).
8. [unit] `warm` does not probe an agent that has a saved offer from `load()` or a learned offer from `opened()`.
9. [unit] When the probe for `codex` resolves `{ offeredModels: ["m1"], offeredEfforts: ["low"] }`, `rows()` then includes `acp:codex/m1`, `effortLevels("acp:codex")` includes `low`, and the store's `save` is called with `codex` as `{ models: ["m1"], efforts: ["low"] }`.
10. [unit] When the probe for `codex` rejects with a `NaxError` whose code is `AGENT_SESSION_AUTH_REQUIRED`, `unavailable("acp:codex")` returns `not logged in`, `logger.debug` is called, and no unhandled rejection is raised.
11. [unit] Calling `warm("/r")` twice while the first probe for `codex` is still pending calls `probeAcpAgent` for `codex` only once.
12. [unit] After `catalog.close()`, a pending probe that then resolves `{ offeredModels: ["m1"] }` adds no `acp:codex/m1` row and does not call the store's `save`; one that then rejects with `AGENT_SESSION_AUTH_REQUIRED` leaves `unavailable("acp:codex")` `undefined`.
13. [integration] Running the chat command with a stub catalog calls its `warm` once with the command's cwd, after the stub host's `start` has resolved.
14. [integration] Running the chat command with a stub catalog whose `warm` is a spy and a stub host whose `start` rejects never calls `warm`.
15. [unit] `close()` on a `NativeChatHost` built with a stub catalog calls the catalog's `close` once, and a second `close()` on the host does not call it again.

### US-003

1. [unit] `catalog.refresh("/r")` with every agent installed calls `probeAcpAgent` once per agent with `cwd` `"/r"`, including an agent that already has a saved or learned offer.
2. [unit] `refresh` resolves one result per agent in the order `claude`, `codex`, `cursor`.
3. [unit] For an agent whose probe resolves `{ offeredModels: ["a", "b"] }`, its result is `{ agent, outcome: "learned", models: 2 }` and `rows()` then includes `acp:<agent>/a` and `acp:<agent>/b`.
4. [unit] For an agent whose binary does not resolve, its result is `{ agent, outcome: "not installed" }` and no probe runs for it.
5. [unit] For an agent whose probe rejects with a `NaxError` coded `AGENT_SESSION_AUTH_REQUIRED`, its result is `{ agent, outcome: "failed", reason: "not logged in" }`; for one that rejects with a plain `Error("boom\nmore")`, its result is `{ agent, outcome: "failed", reason: "boom" }`.
6. [unit] `refresh` called while a `warm` probe for `codex` is pending reuses that probe: `probeAcpAgent` is called for `codex` only once and the `codex` result reflects that probe's outcome.
7. [unit] `NativeChatHost.refreshAcpModels()` calls its catalog's `refresh` once with the host's cwd and resolves what `refresh` resolves.
8. [unit] `NativeChatHost.refreshAcpModels()` on a host built without a catalog resolves `[]`.
9. [unit] `/model refresh` with a host whose `refreshAcpModels` resolves `[{ agent: "claude", outcome: "learned", models: 3 }, { agent: "codex", outcome: "not installed" }, { agent: "cursor", outcome: "failed", reason: "not logged in" }]` shows `Claude Code: 3 models`, `Codex: not installed` and `Cursor: failed: not logged in` as three transcript notes in that order, and does not call `host.switchTo`.
10. [unit] `/model refresh` calls `host.refreshAcpModels` exactly once and returns no picker outcome.
11. [unit] `/model refresh` with a host that has no `refreshAcpModels`, or whose `refreshAcpModels` resolves `[]`, shows `no ACP agents to refresh`.
12. [unit] A learned result with `models: 1` shows `1 model` (singular), for example `Codex: 1 model`.
13. [unit] For an agent whose probe resolves `{ offeredEfforts: ["low"] }` with no models, its result is `{ agent, outcome: "learned", models: 0 }` and `/model refresh` shows `<Label>: 0 models` for it.
14. [unit] For an agent whose probe rejects with a `NaxError` coded `AGENT_SESSION_BACKEND_UNAVAILABLE` and message `spawn failed\ndetail`, its result's reason is `spawn failed`; for one that rejects with `new Error("")`, its reason is `probe failed`.
15. [unit] `/model Refresh` calls `host.switchTo({ model: "Refresh" })` and not `refreshAcpModels`; `/model refresh extra` calls `refreshAcpModels` once and not `switchTo`.
16. [unit] A probe that rejects with an error whose first line is 200 characters long gives a `failed` reason of exactly its first 120 characters.
17. [unit] `/model acp:codex/m1` still calls `host.switchTo({ model: "acp:codex/m1" })`, and `/model` with no argument still returns the `model` picker outcome.
