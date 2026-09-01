# nax auth: credentials and login flows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give nax a `nax auth` command family that obtains, imports, lists and removes provider credentials, and wire the credential store into the native client so a stored credential actually reaches a run.

**Architecture:** Every `@nathapp/nax-ai` import stays inside `src/agents/native/`, where `scripts/check-nax-ai-imports.ts` confines it. nax declares its own interaction vocabulary (`AuthInteraction`, `AuthPrompt`, `AuthEvent`) and translates to nax-ai's at that boundary, so `src/cli/auth.ts` is pure terminal I/O with no wire types in it. Two tasks land in the sibling `nax-ai` repo first, because the ambient-auth probe needs knowledge that is pi-ai's and unreachable from nax.

**Tech Stack:** TypeScript, Bun, `bun:test`, commander, chalk. nax-ai `0.1.3` (to be released by Task 2), pi-ai (transitive, never imported directly by nax).

**Spec:** `docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md`

## Global Constraints

- **Two repos.** Paths are relative to `repos/nax` unless prefixed `nax-ai:`, which means `repos/nax-ai`. Tasks 1 and 2 are nax-ai; Tasks 3-11 are nax.
- **Branches.** This plan and its spec are documentation, on `docs/nax-auth-credentials-design` (PR #1789). The implementation belongs on `feat/nax-auth-credentials`, branched from `main` — see Task 2 Step 8. Task 1's nax-ai work has its own branch, `feat/ambient-auth-probe`. Do not commit code onto the docs branch.
- **The two repos have different TypeScript strictness. Do not carry idioms across.** nax-ai has `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; nax has none of the three (`strict: true` only). In nax-ai, build an optional property with a spread (`...(x !== undefined ? { x } : {})`) and never write `import type { A, type B }`. In nax, plain optional assignment is fine.
- **nax: `@nathapp/nax-ai` may be imported only from `src/agents/native/`.** Enforced by `scripts/check-nax-ai-imports.ts`, which scans `src/` only. A violation fails `bun run lint`.
- **nax-ai: `@earendil-works/pi-ai` may be imported only from `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts`, `src/auth/pi-auth.ts`.** Task 1 lands in `pi-auth.ts`, which is already allowed — **no gate change is needed.**
- **nax: no new `throw new Error` in `src/`.** `scripts/check-nax-error.ts` is a ratchet (baseline 104, currently 90). Use `NaxError(message, code, context?)` from `@/errors`.
- **Never print, log, compare or inspect a credential `key`.** It is documented opaque and may be a `$VAR` template or a `!command`. This includes prefixes and lengths.
- **`nax auth rm` must never say "logged out."** pi has no revocation; the provider-side token stays live until it expires. Say the credential was removed locally.
- **Never derive `kind` from `method`, and never assert a kind for a given provider in a test.** M5 predicted `openrouter` would return `kind: "api-key"` and its live run returned `kind: "oauth"`.
- File size limits: `SRC_LIMIT` 600 lines, `TEST_LIMIT` 800 (`scripts/check-file-sizes.ts`).
- Full gate before every nax commit: `bun run lint` (22 checks). It runs automatically in the pre-commit hook.

## File Structure

**nax-ai (Tasks 1-2):**

| File | Responsibility |
|---|---|
| `nax-ai:src/auth/pi-auth.ts` | Modified. Gains `ambientAuthAvailable()`. The only place allowed to touch pi's provider table. |
| `nax-ai:src/index.ts` | Modified. Exports `ambientAuthAvailable`. |
| `nax-ai:test/auth/ambient.test.ts` | New. Probe unit tests against the `_loginDeps.providers` seam. |

**nax (Tasks 3-11):**

| File | Responsibility |
|---|---|
| `src/agents/native/auth-types.ts` | New. nax's own interaction vocabulary. A leaf — imports nothing, so it cannot cycle. |
| `src/agents/native/credentials.ts` | New. Owns the store: `naxCredentialStore()`, `readStoredEntries()`. |
| `src/agents/native/auth.ts` | New. `runLogin`, `importPiCredentials`, `listStoredProviders`, `removeStoredProvider`, `ambientShadows`, and `toLoginInteraction`. Maps nax-ai's errors. |
| `src/agents/native/index.ts` | Modified. Re-exports the above. Owns no values. |
| `src/agents/native/client.ts` | Modified. Passes the store to `createClient`. |
| `src/agents/native/adapter.ts` | Modified. Docstring only — records why `hasCredentials()` is unfixed here. |
| `src/cli/auth-prompt.ts` | New. Echo-suppressed secret prompt with an injectable stdin seam. |
| `src/cli/auth.ts` | New. The four command implementations. Terminal I/O only. |
| `src/cli/index.ts` | Modified. Barrel exports. |
| `bin/nax.ts` | Modified. The `auth` command group. |
| `test/preload.ts` | Modified. Scrubs ambient provider env vars. |

---

### Task 1: nax-ai — the ambient-auth probe

**Files:**
- Modify: `nax-ai:src/auth/pi-auth.ts`
- Modify: `nax-ai:src/index.ts`
- Test: `nax-ai:test/auth/ambient.test.ts` (create)

**Interfaces:**
- Consumes: the existing `_loginDeps.providers()` seam in `pi-auth.ts`, which returns `readonly PiProvider[]`.
- Produces: `ambientAuthAvailable(providerId: ProviderId): Promise<boolean>`, exported from the package root. Task 8 calls it through nax's `ambientShadows()`.

**Why this is here and not in nax:** answering "would ambient auth resolve for this provider" cannot be done by enumerating environment variable names. `ProviderAuth.env` is documented as descriptive only, often absent, and never read by auth resolution. pi's `ApiKeyAuth.resolve()` returns `undefined` when a provider is not configured and already merges every ambient source (env vars, AWS profiles, Vertex ADC); `check()` is the side-effect-free variant where a provider offers one. Both are pi's, so only nax-ai can reach them.

- [ ] **Step 1: Write the failing test**

Create `nax-ai:test/auth/ambient.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { ambientAuthAvailable, _loginDeps } from "../../src/auth/pi-auth.ts";

const realProviders = _loginDeps.providers;
afterEach(() => {
  _loginDeps.providers = realProviders;
});

/** Minimal pi-shaped provider. `as never` keeps the fixture to the fields the probe reads. */
function provider(id: string, auth: unknown) {
  return { id, auth } as never;
}

describe("ambientAuthAvailable", () => {
  it("is false for a provider that is not in the catalog", async () => {
    _loginDeps.providers = async () => [];
    expect(await ambientAuthAvailable("nope")).toBe(false);
  });

  it("is false for a provider with no api-key auth", async () => {
    _loginDeps.providers = async () => [provider("codex-only", { oauth: { name: "OAuth", login: async () => ({}) } })];
    expect(await ambientAuthAvailable("codex-only")).toBe(false);
  });

  it("prefers check() when the provider offers one, and passes no credential", async () => {
    let sawCredentialKey = true;
    _loginDeps.providers = async () => [
      provider("checked", {
        apiKey: {
          name: "Checked",
          check: async (input: { credential?: unknown }) => {
            sawCredentialKey = "credential" in input;
            return { type: "api_key" as const };
          },
          resolve: async () => {
            throw new Error("resolve must not be called when check exists");
          },
        },
      }),
    ];
    expect(await ambientAuthAvailable("checked")).toBe(true);
    expect(sawCredentialKey).toBe(false);
  });

  it("is false when check() reports nothing configured", async () => {
    _loginDeps.providers = async () => [
      provider("unset", { apiKey: { name: "Unset", check: async () => undefined, resolve: async () => undefined } }),
    ];
    expect(await ambientAuthAvailable("unset")).toBe(false);
  });

  it("falls back to resolve() when there is no check()", async () => {
    _loginDeps.providers = async () => [
      provider("resolved", { apiKey: { name: "Resolved", resolve: async () => ({ apiKey: "sk-live" }) } }),
    ];
    expect(await ambientAuthAvailable("resolved")).toBe(true);
  });

  it("is false rather than throwing when the probe fails", async () => {
    _loginDeps.providers = async () => [
      provider("angry", {
        apiKey: {
          name: "Angry",
          resolve: async () => {
            throw new Error("the credential helper exited 1");
          },
        },
      }),
    ];
    expect(await ambientAuthAvailable("angry")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd repos/nax-ai && bun x vitest --run test/auth/ambient.test.ts`
Expected: FAIL — `ambientAuthAvailable` is not exported from `pi-auth.ts`.

- [ ] **Step 3: Implement the probe**

In `nax-ai:src/auth/pi-auth.ts`, add `defaultProviderAuthContext` to the existing pi-ai import. **That import is a plain `import type { ... }` today — you are adding a VALUE, so it needs its own `import { defaultProviderAuthContext } from "@earendil-works/pi-ai";` statement.** Under `verbatimModuleSyntax` you cannot add a value to an `import type` statement.

Append:

```ts
/**
 * Whether ambient auth alone would satisfy this provider.
 *
 * Enumerating env var names cannot answer this: ProviderAuth.env is
 * descriptive only, often absent, and never read by auth resolution. pi's own
 * resolve() returns undefined when a provider is not configured and already
 * merges env vars, AWS profiles and ADC files, so asking it with no credential
 * is the question exactly. check() is the side-effect-free variant, preferred
 * because resolve() may execute commands.
 *
 * A probe that throws is reported as "not available" rather than propagated:
 * this only ever decorates a diagnostic, and breaking the command it decorates
 * would be worse than a missing warning.
 */
export async function ambientAuthAvailable(providerId: ProviderId): Promise<boolean> {
  const provider = (await _loginDeps.providers()).find((candidate) => candidate.id === providerId);
  const apiKey = provider?.auth.apiKey;
  if (apiKey === undefined) return false;

  const ctx = defaultProviderAuthContext();
  const signal = new AbortController().signal;

  try {
    // Bind rather than call detached: pi's auth objects are methods that may read `this`.
    if (apiKey.check !== undefined) {
      return (await apiKey.check.bind(apiKey)({ ctx, signal })) !== undefined;
    }
    return (await apiKey.resolve.bind(apiKey)({ ctx, signal })) !== undefined;
  } catch {
    return false;
  }
}
```

Note the absent `credential` property: under `exactOptionalPropertyTypes`, omit it entirely — do not pass `credential: undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd repos/nax-ai && bun x vitest --run test/auth/ambient.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Export it from the package root**

In `nax-ai:src/index.ts`, beside the existing `export { login } from "./auth/login.ts";`:

```ts
export { ambientAuthAvailable } from "./auth/pi-auth.ts";
```

- [ ] **Step 6: Run the full gate**

Run: `cd repos/nax-ai && bun run lint && bun run typecheck && bun x vitest --run`
Expected: all pass. `check:pi-ai-imports` stays clean — `pi-auth.ts` is already on its allowlist.

- [ ] **Step 7: Commit**

```bash
cd repos/nax-ai
git checkout -b feat/ambient-auth-probe
git add src/auth/pi-auth.ts src/index.ts test/auth/ambient.test.ts
git commit -m "feat(auth): report whether ambient auth alone satisfies a provider

nax needs to tell a user that a stored credential is shadowing a working
environment variable, and cannot: ProviderAuth.env is descriptive only, often
absent, and never read by auth resolution, so env var names are not
enumerable from outside pi.

pi answers it directly instead. resolve() returns undefined when a provider is
not configured and already merges env vars, AWS profiles and ADC files, so
asking with no credential is the question exactly; check() is the
side-effect-free variant, preferred because resolve() may execute commands.

A failing probe reports false rather than throwing. It only ever decorates a
diagnostic, and breaking the command it decorates would be worse than a
missing warning."
```

---

### Task 2: nax-ai — release 0.1.3, and bump nax's pin

**Files:**
- Modify: `nax-ai:package.json` (version, via the release script)
- Modify: `package.json:68` (nax's pin)
- Modify: `bun.lock`

**Interfaces:**
- Consumes: Task 1's `ambientAuthAvailable`, and `login()` which is already on nax-ai `main` from PR #16.
- Produces: an installed `@nathapp/nax-ai@0.1.3` in nax, from which Tasks 3-10 import `login`, `ambientAuthAvailable`, `createFileCredentialStore`, and the login types.

**Why this is task 2 and not later:** `login()` merged after the 0.1.2 release commit, so no published version contains it, and nax depends on nax-ai as a plain npm dependency rather than a workspace link. Nothing downstream compiles until this lands.

**This task requires a human merge.** The release is PR-first by design.

- [ ] **Step 1: Merge Task 1**

Open a PR for `feat/ambient-auth-probe`, get CI green, merge to `main`. Pull `main` locally afterwards.

- [ ] **Step 2: Preview the version bump**

Run: `cd repos/nax-ai && bun run release --dry-run patch`
Expected: reports `0.1.2 -> 0.1.3` and the PR it would open. No files change.

- [ ] **Step 3: Open the release PR**

Run: `cd repos/nax-ai && bun run release patch`
Expected: bumps `package.json` to `0.1.3` and opens a release PR.

- [ ] **Step 4: Merge the release PR, then push the tag**

After the PR merges and CI is green on `main`:

Run: `cd repos/nax-ai && bun run release tag`
Expected: pushes the tag, which publishes to npm. The dist-tag is derived from the version by `.github/workflows/release.yml` — do not pass one.

- [ ] **Step 5: Verify the published package actually contains both**

```bash
cd /tmp && rm -rf naxai-verify && mkdir naxai-verify && cd naxai-verify
npm pack @nathapp/nax-ai@0.1.3 >/dev/null 2>&1
tar -xzf nathapp-nax-ai-0.1.3.tgz
grep -c "ambientAuthAvailable" package/dist/index.d.ts
grep -c "declare function login" package/dist/auth/login.d.ts
```

Expected: both greps print a non-zero count. **Do not skip this.** A release whose tarball lacks the export fails Task 3 with a confusing module error rather than an obvious one.

- [ ] **Step 6: Bump nax's pin**

In `package.json:68`, change `"@nathapp/nax-ai": "0.1.2"` to `"0.1.3"`, then:

Run: `bun install`
Expected: `bun.lock` updates.

- [ ] **Step 7: Verify the new surface is importable from nax**

Run: `bun -e 'import("@nathapp/nax-ai").then(m => console.log(typeof m.login, typeof m.ambientAuthAvailable, typeof m.createFileCredentialStore))'`
Expected: `function function function`

- [ ] **Step 8: Branch for the implementation, from `main`**

The spec, this plan and the ADR-027 amendment live on `docs/nax-auth-credentials-design` (PR #1789) and are documentation only. **Branch the implementation from `main` once that PR merges, not from the docs branch** — otherwise the code PR carries the docs commits and cannot be reviewed or reverted separately.

```bash
git checkout main && git pull --ff-only
git checkout -b feat/nax-auth-credentials
```

If PR #1789 has not merged yet, branching from `main` anyway is correct: nothing in Tasks 3-11 reads the spec at runtime.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: take nax-ai 0.1.3 for login() and the ambient-auth probe

login() has been on nax-ai main since PR #16 but merged after the 0.1.2
release, so no published version carried it. 0.1.3 publishes it together with
the ambient-auth probe, which nax needs to warn that a stored credential is
shadowing a working environment variable."
```

---

### Task 3: nax — the credential store and its file reader

**Files:**
- Create: `src/agents/native/credentials.ts`
- Test: `test/unit/agents/native/credentials.test.ts`

**Interfaces:**
- Consumes: `createFileCredentialStore` from `@nathapp/nax-ai` (Task 2), `globalConfigDir()` from `@/config/paths`.
- Produces:
  - `naxCredentialStore(): CredentialStore` — memoised per process.
  - `credentialFilePath(): string`
  - `readStoredEntries(): Promise<StoredEntry[]>` where `StoredEntry` is `{ providerId: string; kind: "api-key" | "oauth"; expires?: number }`
  - `_resetCredentialStore(): void` — tests only.

**Why a direct file reader:** `CredentialStore` is read/modify/delete by design and has no `list`. `auth list` needs enumeration, and widening a published interface to serve one subcommand is the wrong direction.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/credentials.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCredentialStore, credentialFilePath, naxCredentialStore, readStoredEntries } from "@/agents/native/credentials";

let dir: string;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nax-creds-"));
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
});

afterEach(() => {
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("credentialFilePath", () => {
  test("sits under the global config dir", () => {
    expect(credentialFilePath()).toBe(join(dir, "credentials"));
  });
});

describe("naxCredentialStore", () => {
  test("returns the same instance across calls", () => {
    expect(naxCredentialStore()).toBe(naxCredentialStore());
  });

  test("round-trips a credential through the real file store", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-test" }));
    const read = await naxCredentialStore().read("openrouter");
    expect(read).toEqual({ kind: "api-key", key: "sk-test" });
  });
});

describe("readStoredEntries", () => {
  test("is empty when no credential file exists", async () => {
    expect(await readStoredEntries()).toEqual([]);
  });

  test("reports provider, kind and OAuth expiry, sorted by provider", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-test" }));
    await naxCredentialStore().modify("openai-codex", async () => ({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1789038325059,
    }));

    expect(await readStoredEntries()).toEqual([
      { providerId: "openai-codex", kind: "oauth", expires: 1789038325059 },
      { providerId: "openrouter", kind: "api-key" },
    ]);
  });

  test("throws rather than reporting empty when the file is unparseable", async () => {
    writeFileSync(credentialFilePath(), "{ not json");
    await expect(readStoredEntries()).rejects.toThrow(/could not be parsed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/credentials.test.ts`
Expected: FAIL — cannot resolve `@/agents/native/credentials`.

- [ ] **Step 3: Implement**

Create `src/agents/native/credentials.ts`:

```ts
/**
 * The credential store, and the one place that reads its file directly.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts).
 *
 * The store is memoised like client.ts's client: createFileCredentialStore
 * holds a cross-process lock, and two instances over one path would each take
 * it, turning a read-modify-write into a contended wait for no reason.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CredentialStore, createFileCredentialStore } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import { globalConfigDir } from "@/config/paths";

/** One credential's public facts. Deliberately carries no key. */
export interface StoredEntry {
  providerId: string;
  kind: "api-key" | "oauth";
  expires?: number;
}

export function credentialFilePath(): string {
  return join(globalConfigDir(), "credentials");
}

let cached: CredentialStore | undefined;
let cachedPath: string | undefined;

export function naxCredentialStore(): CredentialStore {
  const path = credentialFilePath();
  // Rebuild when the path changes: NAX_GLOBAL_CONFIG_DIR moves between tests,
  // and a store pinned to a stale path would write outside the temp dir.
  if (cached === undefined || cachedPath !== path) {
    cached = createFileCredentialStore({ path });
    cachedPath = path;
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetCredentialStore(): void {
  cached = undefined;
  cachedPath = undefined;
}

/**
 * Enumerate the store by reading its file.
 *
 * CredentialStore is read/modify/delete by design and has no list, and this is
 * the only consumer that needs one. A parse failure throws rather than
 * reporting an empty store: reporting empty would look exactly like "you have
 * no credentials" for a file that is merely damaged.
 */
export async function readStoredEntries(): Promise<StoredEntry[]> {
  const path = credentialFilePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NaxError(
      `The credential file at ${path} could not be parsed. Refusing to read it.`,
      "CREDENTIAL_FILE_UNREADABLE",
      { path },
    );
  }

  const credentials = (parsed as { credentials?: Record<string, { kind?: string; expires?: number }> })?.credentials;
  if (credentials === undefined || typeof credentials !== "object") {
    throw new NaxError(
      `The credential file at ${path} could not be parsed as a credential store.`,
      "CREDENTIAL_FILE_UNREADABLE",
      { path },
    );
  }

  return Object.entries(credentials)
    .map(([providerId, value]) => {
      const kind = value?.kind === "oauth" ? ("oauth" as const) : ("api-key" as const);
      const entry: StoredEntry = { providerId, kind };
      if (kind === "oauth" && typeof value?.expires === "number") entry.expires = value.expires;
      return entry;
    })
    .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/credentials.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/credentials.ts test/unit/agents/native/credentials.test.ts
git commit -m "feat(auth): own the credential store, and read its file for listing

The store is memoised on its path rather than built per call: it holds a
cross-process lock, so two instances over one path would each take it.

Listing reads the file directly because CredentialStore is read/modify/delete
by design and has no list, and this is its only consumer. A parse failure
throws rather than reporting empty, which would look exactly like having no
credentials for a file that is merely damaged."
```

---

### Task 4: nax — the interaction vocabulary and its mapper

**Files:**
- Create: `src/agents/native/auth-types.ts`
- Create: `src/agents/native/auth.ts`
- Test: `test/unit/agents/native/auth-mapper.test.ts`

**Interfaces:**
- Consumes: nax-ai's `LoginInteraction`, `LoginPrompt`, `LoginEvent` types (Task 2).
- Produces:
  - From `auth-types.ts`: `AuthMethod`, `AuthOption`, `AuthPrompt`, `AuthLink`, `AuthEvent`, `AuthInteraction`, `AuthResult`.
  - From `auth.ts`: `toLoginInteraction(interaction: AuthInteraction): LoginInteraction` — used by Task 5's `runLogin`, and exported for this task's tests only.

**Why a separate vocabulary:** `LoginInteraction` and friends are nax-ai types, so a `src/cli/auth.ts` implementing the interaction directly would import nax-ai outside `src/agents/native/` and fail the gate. `auth-types.ts` imports nothing at all, which is what keeps it out of the import-cycle baseline.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/auth-mapper.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@/agents/native/auth-types";
import { toLoginInteraction } from "@/agents/native/auth";

function recorder() {
  const prompts: AuthPrompt[] = [];
  const events: AuthEvent[] = [];
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (event) => events.push(event),
  };
  return { interaction, prompts, events };
}

describe("toLoginInteraction", () => {
  test("passes a secret prompt through and returns the answer", async () => {
    const { interaction, prompts } = recorder();
    const answer = await toLoginInteraction(interaction).prompt({ type: "secret", message: "Key?" });
    expect(answer).toBe("answer");
    expect(prompts[0]).toEqual({ type: "secret", message: "Key?" });
  });

  test("carries a select prompt's options", async () => {
    const { interaction, prompts } = recorder();
    await toLoginInteraction(interaction).prompt({
      type: "select",
      message: "How?",
      options: [{ id: "api-key", label: "API key" }],
    });
    expect(prompts[0]).toEqual({ type: "select", message: "How?", options: [{ id: "api-key", label: "API key" }] });
  });

  test("carries a manual-code prompt's signal", async () => {
    const { interaction, prompts } = recorder();
    const signal = new AbortController().signal;
    await toLoginInteraction(interaction).prompt({ type: "manual-code", message: "Code?", signal });
    expect(prompts[0]?.type).toBe("manual-code");
    expect(prompts[0]?.signal).toBe(signal);
  });

  test("passes each event kind through unchanged", () => {
    const { interaction, events } = recorder();
    const mapped = toLoginInteraction(interaction);
    mapped.notify({ type: "info", message: "hello" });
    mapped.notify({ type: "auth-url", url: "https://example.test/auth" });
    mapped.notify({ type: "device-code", userCode: "ABCD", verificationUri: "https://example.test/device" });
    mapped.notify({ type: "progress", message: "waiting" });
    expect(events.map((e) => e.type)).toEqual(["info", "auth-url", "device-code", "progress"]);
    expect(events[1]).toEqual({ type: "auth-url", url: "https://example.test/auth" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/auth-mapper.test.ts`
Expected: FAIL — cannot resolve `@/agents/native/auth-types`.

- [ ] **Step 3: Write the vocabulary**

Create `src/agents/native/auth-types.ts`:

```ts
/**
 * nax's own login vocabulary.
 *
 * A deliberate mirror of nax-ai's LoginInteraction family. It exists so the
 * CLI can implement a terminal interaction without importing nax-ai, which
 * scripts/check-nax-ai-imports.ts confines to this directory. The mapper in
 * auth.ts is the only translation point, so a rename upstream is a one-file
 * change here.
 *
 * This module imports nothing. That is what keeps it a leaf, so the barrel can
 * re-export it without creating an import cycle.
 */

export type AuthMethod = "api-key" | "oauth";

export interface AuthOption {
  id: string;
  label: string;
  description?: string;
}

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly AuthOption[] }
  | { type: "manual-code"; message: string; placeholder?: string }
);

export interface AuthLink {
  url: string;
  label?: string;
}

export type AuthEvent =
  | { type: "info"; message: string; links?: readonly AuthLink[] }
  | { type: "auth-url"; url: string; instructions?: string }
  | {
      type: "device-code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/** `prompt` returns the entered text, or for `select` the chosen option id. Reject to cancel. */
export interface AuthInteraction {
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** Metadata only. The credential is written to the store and never returned. */
export interface AuthResult {
  providerId: string;
  method: AuthMethod;
  kind: "api-key" | "oauth";
}
```

- [ ] **Step 4: Write the mapper**

Create `src/agents/native/auth.ts`:

```ts
/**
 * Obtaining and managing credentials, in nax's vocabulary.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts). Nothing it exports carries a
 * nax-ai type, so src/cli/auth.ts can consume it without breaching that gate.
 */

import type { LoginEvent, LoginInteraction, LoginPrompt } from "@nathapp/nax-ai";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "./auth-types";

/**
 * Deliberately dumb: the two vocabularies are one-for-one by design, so this
 * is a rename boundary rather than a translation with opinions. Both sides use
 * kebab-case, so the names pass straight through.
 */
export function toLoginInteraction(interaction: AuthInteraction): LoginInteraction {
  return {
    prompt: async (prompt: LoginPrompt) => interaction.prompt(prompt as AuthPrompt),
    notify: (event: LoginEvent) => interaction.notify(event as AuthEvent),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/unit/agents/native/auth-mapper.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/auth-types.ts src/agents/native/auth.ts test/unit/agents/native/auth-mapper.test.ts
git commit -m "feat(auth): give nax its own login vocabulary and one mapper

LoginInteraction and its prompt and event types are nax-ai's, so a CLI that
implemented the interaction directly would import nax-ai outside
src/agents/native/ and fail the wire-isolation gate.

nax mirrors the vocabulary and translates once, which is the move nax-ai
itself made against pi-ai, one layer out. auth-types.ts imports nothing, so
the barrel can re-export it without creating a cycle."
```

---

### Task 5: nax — `runLogin` and the error mapping

**Files:**
- Modify: `src/agents/native/auth.ts`
- Test: `test/unit/agents/native/auth-login.test.ts`

**Interfaces:**
- Consumes: `toLoginInteraction` (Task 4), `naxCredentialStore` (Task 3), `login` from `@nathapp/nax-ai` (Task 2).
- Produces:
  - `runLogin(providerId: string, interaction: AuthInteraction): Promise<AuthResult>`
  - `_authDeps` — the test seam: `{ login, ambientAuthAvailable }`.
  - `AuthCancelledError` — a marker class, so Task 8 can exit 130 without matching on a message.

**The error contract:** nax-ai's typed errors are mapped here, not in the CLI, so nothing outside this directory needs to know their names. `LoginCancelledError` becomes `AuthCancelledError`; `OAuthFlowProhibitedError` keeps its recorded reason in the message, because that reason is the entire point of the policy file; everything else becomes a `NaxError` with a code.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/auth-login.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _authDeps, AuthCancelledError, runLogin } from "@/agents/native/auth";
import type { AuthInteraction } from "@/agents/native/auth-types";
import { _resetCredentialStore } from "@/agents/native/credentials";

const realLogin = _authDeps.login;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

const silent: AuthInteraction = { prompt: async () => "", notify: () => undefined };

beforeEach(() => {
  process.env.NAX_GLOBAL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nax-login-"));
  _resetCredentialStore();
});

afterEach(() => {
  _authDeps.login = realLogin;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("runLogin", () => {
  test("passes the store and a mapped interaction, and returns the result verbatim", async () => {
    let seen: { providerId: string; hasStore: boolean } | undefined;
    _authDeps.login = mock(async (options: { providerId: string; credentials: unknown }) => {
      seen = { providerId: options.providerId, hasStore: options.credentials !== undefined };
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    const result = await runLogin("openrouter", silent);

    expect(seen).toEqual({ providerId: "openrouter", hasStore: true });
    // kind is reported as returned, never derived from method: M5 predicted
    // api-key here and its live run returned oauth.
    expect(result).toEqual({ providerId: "openrouter", method: "oauth", kind: "oauth" });
  });

  test("does not pass a method, so nax-ai runs its own selection prompt", async () => {
    let sawMethodKey = true;
    _authDeps.login = mock(async (options: object) => {
      sawMethodKey = "method" in options;
      return { providerId: "p", method: "api-key" as const, kind: "api-key" as const };
    });
    await runLogin("p", silent);
    expect(sawMethodKey).toBe(false);
  });

  test("turns a cancellation into AuthCancelledError", async () => {
    class LoginCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "LoginCancelledError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new LoginCancelledError();
    });
    await expect(runLogin("openrouter", silent)).rejects.toBeInstanceOf(AuthCancelledError);
  });

  test("keeps a prohibited flow's recorded reason in the message", async () => {
    class OAuthFlowProhibitedError extends Error {
      constructor() {
        super('OAuth flow for "github-copilot" is prohibited: not cleared, isSubscription: true');
        this.name = "OAuthFlowProhibitedError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new OAuthFlowProhibitedError();
    });
    await expect(runLogin("github-copilot", silent)).rejects.toThrow(/not cleared/);
  });

  test("reports an unavailable method as AUTH_METHOD_UNAVAILABLE", async () => {
    class AuthMethodUnavailableError extends Error {
      constructor() {
        super("no method");
        this.name = "AuthMethodUnavailableError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new AuthMethodUnavailableError();
    });
    await expect(runLogin("nope", silent)).rejects.toMatchObject({ code: "AUTH_METHOD_UNAVAILABLE" });
  });

  test("reports any other failure as AUTH_LOGIN_FAILED", async () => {
    _authDeps.login = mock(async () => {
      throw new Error("the provider said no");
    });
    await expect(runLogin("openrouter", silent)).rejects.toMatchObject({ code: "AUTH_LOGIN_FAILED" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/auth-login.test.ts`
Expected: FAIL — `runLogin` is not exported.

- [ ] **Step 3: Implement**

In `src/agents/native/auth.ts`, extend the nax-ai import to bring in the values and add the code below. The import becomes:

```ts
import {
  ambientAuthAvailable,
  type LoginEvent,
  type LoginInteraction,
  type LoginPrompt,
  login,
} from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthResult } from "./auth-types";
import { naxCredentialStore } from "./credentials";
```

Then append:

```ts
/**
 * Cancellation is not a failure, and the CLI needs to tell them apart to exit
 * 130 silently. A marker class rather than a code match: an exit status should
 * not depend on message text.
 */
export class AuthCancelledError extends Error {
  constructor(readonly providerId: string) {
    super(`Login for "${providerId}" was cancelled`);
    this.name = "AuthCancelledError";
  }
}

/** Test seam, following the _clientDeps precedent. */
export const _authDeps = { login, ambientAuthAvailable };

/**
 * nax-ai's errors are mapped here rather than in the CLI, so its type names
 * stay behind this directory's boundary.
 *
 * A prohibited flow keeps its message: the recorded reason is the whole point
 * of the policy file, and a generic failure would discard it.
 */
function toNaxError(error: unknown, providerId: string): Error {
  if (error instanceof Error) {
    if (error.name === "LoginCancelledError") return new AuthCancelledError(providerId);
    if (error.name === "OAuthFlowProhibitedError") {
      return new NaxError(error.message, "AUTH_OAUTH_PROHIBITED", { providerId });
    }
    if (error.name === "AuthMethodUnavailableError") {
      return new NaxError(
        `No login method is available for "${providerId}".`,
        "AUTH_METHOD_UNAVAILABLE",
        { providerId },
      );
    }
    return new NaxError(
      `Login for "${providerId}" failed: ${error.message}`,
      "AUTH_LOGIN_FAILED",
      { providerId },
    );
  }
  return new NaxError(`Login for "${providerId}" failed.`, "AUTH_LOGIN_FAILED", { providerId });
}

/**
 * Obtain a credential and write it to the store.
 *
 * No `method` is passed: when a provider offers both, nax-ai runs its own
 * selection prompt. Duplicating that table here is how the two drift apart.
 *
 * The result is reported exactly as returned. kind is never derived from
 * method — M5's design predicted openrouter would report kind "api-key" and
 * its live run reported "oauth".
 */
export async function runLogin(providerId: string, interaction: AuthInteraction): Promise<AuthResult> {
  try {
    const result = await _authDeps.login({
      providerId,
      credentials: naxCredentialStore(),
      interaction: toLoginInteraction(interaction),
    });
    return { providerId: result.providerId, method: result.method, kind: result.kind };
  } catch (error) {
    throw toNaxError(error, providerId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/auth-login.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/auth.ts test/unit/agents/native/auth-login.test.ts
git commit -m "feat(auth): run a login and map nax-ai's errors at the boundary

No method is passed to login(): when a provider offers both, nax-ai runs its
own selection prompt, and duplicating that table is how the two drift apart.

The result is reported exactly as returned, never derived — M5 predicted
openrouter would report kind api-key and its live run reported oauth.

Cancellation gets a marker class rather than a code match, so the CLI's exit
130 does not depend on message text, and a prohibited flow keeps its message
because the recorded reason is the point of the policy file."
```

---

### Task 6: nax — import, list, remove, and the shadow probe

**Files:**
- Modify: `src/agents/native/auth.ts`
- Test: `test/unit/agents/native/auth-store-ops.test.ts`

**Interfaces:**
- Consumes: `naxCredentialStore`, `readStoredEntries`, `StoredEntry` (Task 3), `_authDeps.ambientAuthAvailable` (Task 5's seam, Task 1's export).
- Produces:
  - `importPiCredentials(options?: { from?: string; force?: boolean }): Promise<ImportOutcome[]>` where `ImportOutcome` is `{ providerId: string; status: "imported" | "skipped" | "unsupported" }`
  - `listStoredProviders(): Promise<StoredEntry[]>`
  - `removeStoredProvider(providerId: string): Promise<void>`
  - `ambientShadows(providerIds: readonly string[]): Promise<string[]>`
  - `DEFAULT_PI_AUTH_PATH: string`

**The translation:** pi's file is flat `{provider: {type, ...}}` with `type: "api_key" | "oauth"`; the store's file is `{version: 1, credentials: {provider: {kind, ...}}}` with `kind: "api-key" | "oauth"`. pi's OAuth entries also carry an `accountId` that is dropped — safe, and verified rather than assumed: pi derives it from the access-token JWT at request time (`extractAccountId`), and nax-ai's own round-trip already drops it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/auth-store-ops.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _authDeps,
  ambientShadows,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
} from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";

let dir: string;
let piPath: string;
const realAmbient = _authDeps.ambientAuthAvailable;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

const PI_FILE = {
  "opencode-go": { type: "api_key", key: "sk-opencode" },
  "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1789038325059, accountId: "acct-1" },
  weird: { type: "smoke-signal", key: "nope" },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nax-import-"));
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  piPath = join(dir, "pi-auth.json");
  writeFileSync(piPath, JSON.stringify(PI_FILE));
  _resetCredentialStore();
});

afterEach(() => {
  _authDeps.ambientAuthAvailable = realAmbient;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("importPiCredentials", () => {
  test("translates type to kind and the flat file into the store", async () => {
    const outcomes = await importPiCredentials({ from: piPath });

    expect(outcomes).toEqual([
      { providerId: "openai-codex", status: "imported" },
      { providerId: "opencode-go", status: "imported" },
      { providerId: "weird", status: "unsupported" },
    ]);
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-opencode" });
  });

  test("drops accountId, which pi derives from the token rather than storing authoritatively", async () => {
    await importPiCredentials({ from: piPath });
    expect(await naxCredentialStore().read("openai-codex")).toEqual({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1789038325059,
    });
  });

  test("skips an existing credential rather than overwriting it", async () => {
    await naxCredentialStore().modify("opencode-go", async () => ({ kind: "api-key", key: "sk-fresh" }));
    const outcomes = await importPiCredentials({ from: piPath });

    expect(outcomes).toContainEqual({ providerId: "opencode-go", status: "skipped" });
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-fresh" });
  });

  test("overwrites when forced", async () => {
    await naxCredentialStore().modify("opencode-go", async () => ({ kind: "api-key", key: "sk-fresh" }));
    await importPiCredentials({ from: piPath, force: true });
    expect(await naxCredentialStore().read("opencode-go")).toEqual({ kind: "api-key", key: "sk-opencode" });
  });

  test("reports a missing source file as AUTH_IMPORT_SOURCE_MISSING", async () => {
    await expect(importPiCredentials({ from: join(dir, "absent.json") })).rejects.toMatchObject({
      code: "AUTH_IMPORT_SOURCE_MISSING",
    });
  });
});

describe("listStoredProviders", () => {
  test("reports what the store holds", async () => {
    await importPiCredentials({ from: piPath });
    expect(await listStoredProviders()).toEqual([
      { providerId: "openai-codex", kind: "oauth", expires: 1789038325059 },
      { providerId: "opencode-go", kind: "api-key" },
    ]);
  });
});

describe("removeStoredProvider", () => {
  test("deletes the credential", async () => {
    await importPiCredentials({ from: piPath });
    await removeStoredProvider("opencode-go");
    expect(await naxCredentialStore().read("opencode-go")).toBeUndefined();
  });
});

describe("ambientShadows", () => {
  test("names only the providers whose ambient auth would also resolve", async () => {
    _authDeps.ambientAuthAvailable = mock(async (id: string) => id === "openrouter");
    expect(await ambientShadows(["openrouter", "opencode-go"])).toEqual(["openrouter"]);
  });

  test("reports nothing rather than throwing when the probe fails", async () => {
    _authDeps.ambientAuthAvailable = mock(async () => {
      throw new Error("probe exploded");
    });
    expect(await ambientShadows(["openrouter"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/auth-store-ops.test.ts`
Expected: FAIL — `importPiCredentials` is not exported.

- [ ] **Step 3: Implement**

Add the node imports at the top of `src/agents/native/auth.ts`, and **extend** the
`./credentials` import Task 5 already added rather than adding a second one:

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
```

```ts
// was: import { naxCredentialStore } from "./credentials";
import { naxCredentialStore, readStoredEntries, type StoredEntry } from "./credentials";
```

Then append:

```ts
export const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export interface ImportOutcome {
  providerId: string;
  status: "imported" | "skipped" | "unsupported";
}

type PiEntry = { type?: string; key?: string; access?: string; refresh?: string; expires?: number };

/**
 * pi's on-disk shape is flat and snake-cased; the store's is versioned and
 * kebab-cased. accountId is deliberately dropped: pi derives it from the
 * access-token JWT at request time rather than trusting what is stored, and
 * nax-ai's own credential round-trip already drops it.
 */
function fromPiEntry(entry: PiEntry): { kind: "api-key"; key: string } | { kind: "oauth"; access: string; refresh: string; expires: number } | undefined {
  if (entry.type === "api_key" && typeof entry.key === "string") {
    return { kind: "api-key", key: entry.key };
  }
  if (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    typeof entry.refresh === "string" &&
    typeof entry.expires === "number"
  ) {
    return { kind: "oauth", access: entry.access, refresh: entry.refresh, expires: entry.expires };
  }
  return undefined;
}

/**
 * Bring pi's credentials across.
 *
 * Existing entries are skipped rather than overwritten: import plausibly runs
 * after a fresh login, and silently replacing a credential just obtained would
 * be the worst kind of quiet data loss.
 *
 * Each write goes through modify(), which is what holds the store's
 * cross-process lock across the read-modify-write.
 */
export async function importPiCredentials(options?: { from?: string; force?: boolean }): Promise<ImportOutcome[]> {
  const path = options?.from ?? DEFAULT_PI_AUTH_PATH;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new NaxError(`No credential file to import at ${path}.`, "AUTH_IMPORT_SOURCE_MISSING", { path });
  }

  let parsed: Record<string, PiEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, PiEntry>;
  } catch {
    throw new NaxError(`The file at ${path} is not valid JSON.`, "AUTH_IMPORT_SOURCE_UNREADABLE", { path });
  }

  const store = naxCredentialStore();
  const outcomes: ImportOutcome[] = [];

  for (const providerId of Object.keys(parsed).sort()) {
    const entry = parsed[providerId];
    const credential = entry === undefined ? undefined : fromPiEntry(entry);
    if (credential === undefined) {
      outcomes.push({ providerId, status: "unsupported" });
      continue;
    }
    if (options?.force !== true && (await store.read(providerId)) !== undefined) {
      outcomes.push({ providerId, status: "skipped" });
      continue;
    }
    await store.modify(providerId, async () => credential);
    outcomes.push({ providerId, status: "imported" });
  }

  return outcomes;
}

export async function listStoredProviders(): Promise<StoredEntry[]> {
  return readStoredEntries();
}

/**
 * Removal, not revocation. pi has no revocation anywhere — its own types
 * define logout as deletion — so the provider-side token stays live until it
 * expires. Callers must not describe this as logging out.
 */
export async function removeStoredProvider(providerId: string): Promise<void> {
  await naxCredentialStore().delete(providerId);
}

/**
 * Of these providers, which would ambient auth satisfy on its own?
 *
 * A stored credential owns its provider in pi's resolution order, so any
 * provider named here has a working environment variable that the stored
 * credential is shadowing. This only ever decorates a diagnostic, so a failing
 * probe reports nothing rather than breaking the command around it.
 */
export async function ambientShadows(providerIds: readonly string[]): Promise<string[]> {
  const checked = await Promise.all(
    providerIds.map(async (providerId) => {
      try {
        return (await _authDeps.ambientAuthAvailable(providerId)) ? providerId : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return checked.filter((id): id is string => id !== undefined);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/auth-store-ops.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export the surface from the native barrel**

Task 8's `src/cli/auth.ts` must import from `@/agents/native`, not from
`@/agents/native/auth`: `scripts/check-alias-internals.ts` rejects value imports
that alias into a barrel's internals from `src/` (it exempts type-only imports,
and exempts `test/` entirely). So the barrel has to carry these names before the
CLI can use them.

In `src/agents/native/index.ts`, below the existing exports:

```ts
export {
  ambientShadows,
  AuthCancelledError,
  DEFAULT_PI_AUTH_PATH,
  type ImportOutcome,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
  runLogin,
} from "./auth";
export type { AuthEvent, AuthInteraction, AuthLink, AuthMethod, AuthOption, AuthPrompt, AuthResult } from "./auth-types";
export { credentialFilePath, naxCredentialStore, type StoredEntry } from "./credentials";
```

Run: `bun run check:alias-internals && bun run check:import-cycles`
Expected: both clean. `auth-types.ts` imports nothing, which is what keeps the cycle baseline at 135.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/auth.ts src/agents/native/index.ts test/unit/agents/native/auth-store-ops.test.ts
git commit -m "feat(auth): import from pi, list the store, and remove a credential

Import translates on two axes — pi's flat snake-cased file into the store's
versioned kebab-cased one — and writes through modify() so the cross-process
lock is held. accountId is dropped because pi derives it from the token JWT
rather than trusting what is stored.

Existing entries are skipped unless forced: import plausibly runs after a
fresh login, and replacing a credential just obtained would be quiet data
loss.

ambientShadows answers which stored credentials are shadowing a working
environment variable. It reports nothing when the probe fails, because
breaking the command it decorates would be worse than a missing warning."
```

---

### Task 7: nax — the echo-suppressed secret prompt

**Files:**
- Create: `src/cli/auth-prompt.ts`
- Test: `test/unit/cli/auth-prompt.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `promptForSecret(message: string): Promise<string>`
  - `promptForLine(message: string): Promise<string>`
  - `_authPromptDeps` — `{ stdin: PromptStdin; write: (text: string) => boolean }`
  - `PromptStdin` — the same interface shape as `ConfirmStdin` in `src/cli/confirm.ts`.
  - `PromptCancelledError` — thrown on Ctrl+C, Ctrl+D, or a closed stream.

**Why a sibling of `confirm.ts` rather than an edit to it:** `confirm.ts` carries terminal-state handling that was got wrong once already — Ctrl+D fell through to "any other key" and *confirmed* the action. Its structure is the model to copy, not to disturb.

**Write control characters as escapes, never as literal bytes.** `scripts/check-no-control-bytes.ts` fails the build on raw control bytes in source, and `confirm.ts` already uses this form.

**The invariants under test:** raw mode is entered and left exactly once on every exit path; typed characters are never echoed; Ctrl+C rejects; Ctrl+D rejects rather than submitting a partial secret; a stream that ends or errors rejects rather than hanging forever.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli/auth-prompt.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { _authPromptDeps, PromptCancelledError, type PromptStdin, promptForSecret } from "@/cli/auth-prompt";

const ETX = "\u0003";
const EOT = "\u0004";
const BACKSPACE = "\u007F";
const CR = "\r";

function makeStdin() {
  const listeners = new Map<string, ((chunk: string) => void)[]>();
  const rawModeCalls: boolean[] = [];
  const stdin: PromptStdin = {
    isTTY: true,
    setRawMode: (mode: boolean) => rawModeCalls.push(mode),
    resume: () => undefined,
    pause: () => undefined,
    setEncoding: () => undefined,
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    once: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener as () => void]),
    removeListener: (event, listener) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== (listener as unknown)),
      ),
  };
  return {
    stdin,
    rawModeCalls,
    emit: (event: string, chunk = "") => {
      for (const l of [...(listeners.get(event) ?? [])]) l(chunk);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
}

let written: string[];

beforeEach(() => {
  written = [];
  _authPromptDeps.write = (text: string) => {
    written.push(text);
    return true;
  };
});

describe("promptForSecret", () => {
  test("returns the typed value and never echoes it", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "s");
    h.emit("data", "k");
    h.emit("data", "-");
    h.emit("data", "1");
    h.emit("data", CR);

    expect(await pending).toBe("sk-1");
    expect(written.join("")).not.toContain("sk-1");
    expect(written.join("")).not.toContain("sk");
  });

  test("restores raw mode exactly once, on the submit path", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "x");
    h.emit("data", CR);
    await pending;

    expect(h.rawModeCalls).toEqual([true, false]);
    expect(h.listenerCount("data")).toBe(0);
  });

  test("rejects on Ctrl+C", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", ETX);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("rejects on Ctrl+D rather than submitting a partial secret", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "s");
    h.emit("data", EOT);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("rejects rather than hanging when the stream ends", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("end");

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("rejects rather than hanging when the stream errors", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("error");

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("handles backspace without echoing", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "a");
    h.emit("data", "b");
    h.emit("data", BACKSPACE);
    h.emit("data", CR);

    expect(await pending).toBe("a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/cli/auth-prompt.test.ts`
Expected: FAIL — cannot resolve `@/cli/auth-prompt`.

- [ ] **Step 3: Implement**

Create `src/cli/auth-prompt.ts`:

```ts
/**
 * Terminal prompts for credential entry.
 *
 * A sibling of confirm.ts rather than an extension of it. That file's
 * terminal-state handling was got wrong once — Ctrl+D fell through to the
 * "any other key" branch and confirmed the action — and its shape is worth
 * copying rather than disturbing.
 *
 * Nothing typed here is ever echoed, and the terminal is restored on every
 * exit path: submit, cancel, stream end, and stream error.
 */

import chalk from "chalk";

/** Ctrl+C. */
const ETX = "\u0003";
/** Ctrl+D. Conventionally cancel, never submit. */
const EOT = "\u0004";
const CR = "\r";
const LF = "\n";
const BACKSPACE = "\u007F";

/** The slice of process.stdin these prompts drive. Injected so tests can stand one up. */
export interface PromptStdin {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: string): unknown;
  on(event: string, listener: (chunk: string) => void): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

export const _authPromptDeps: {
  stdin: PromptStdin;
  write: (text: string) => boolean;
} = {
  stdin: process.stdin as unknown as PromptStdin,
  write: (text: string) => process.stdout.write(text),
};

function read(message: string, echo: boolean): Promise<string> {
  const { stdin } = _authPromptDeps;
  _authPromptDeps.write(`${chalk.cyan("?")} ${message} `);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData as never);
      stdin.removeListener("end", onEnd as never);
      stdin.removeListener("error", onEnd as never);
      stdin.setRawMode(false);
      stdin.pause();
      _authPromptDeps.write("\n");
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === ETX || char === EOT) {
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if (char === CR || char === LF) {
          cleanup();
          resolve(buffer);
          return;
        }
        if (char === BACKSPACE) {
          buffer = buffer.slice(0, -1);
          if (echo) _authPromptDeps.write("\b \b");
          continue;
        }
        buffer += char;
        if (echo) _authPromptDeps.write(char);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
  });
}

/** Reads a secret. Nothing is echoed, not even a masking character. */
export function promptForSecret(message: string): Promise<string> {
  return read(message, false);
}

/** Reads a visible line, for non-secret answers such as a method choice. */
export function promptForLine(message: string): Promise<string> {
  return read(message, true);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/cli/auth-prompt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/auth-prompt.ts test/unit/cli/auth-prompt.test.ts
git commit -m "feat(cli): add an echo-suppressed prompt for credential entry

A sibling of confirm.ts rather than an extension of it: that file's
terminal-state handling was got wrong once, when Ctrl+D fell through to the
any-other-key branch and confirmed the action, and its shape is worth copying
rather than disturbing.

The terminal is restored on all four exit paths — submit, cancel, stream end
and stream error — and a stream that closes without a keypress rejects instead
of leaving the promise pending with the terminal in raw mode."
```

---

### Task 8: nax — the four command implementations

**Files:**
- Create: `src/cli/auth.ts`
- Modify: `src/agents/native/auth.ts` (add `authImportOutcomeLabel`)
- Test: `test/unit/cli/auth.test.ts`

**Interfaces:**
- Consumes: `runLogin`, `importPiCredentials`, `listStoredProviders`, `removeStoredProvider`, `ambientShadows`, `AuthCancelledError` (Tasks 5-6); `promptForSecret`, `promptForLine`, `PromptCancelledError` (Task 7).
- Produces:
  - `authLoginCommand(providerId: string): Promise<number>`
  - `authImportCommand(options: { from?: string; force?: boolean }): Promise<number>`
  - `authListCommand(): Promise<number>`
  - `authRmCommand(providerId: string): Promise<number>`
  - `_cliAuthDeps` — `{ log: (text: string) => void; isTTY: () => boolean }`
  - `authImportOutcomeLabel(status: ImportOutcome["status"]): string` (from `auth.ts`)

Each command returns a process exit code rather than calling `process.exit`, so tests can assert on it and `bin/nax.ts` owns the process.

**The output rules, each with a test:** no command prints a key; `rm` never says "logged out"; `login` requires a TTY and names the environment variable path otherwise; cancellation exits 130 with no error output; a shadowed credential produces a warning, not a failure.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli/auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _authDeps } from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";
import { _cliAuthDeps, authListCommand, authLoginCommand, authRmCommand } from "@/cli/auth";

let out: string[];
const realLogin = _authDeps.login;
const realAmbient = _authDeps.ambientAuthAvailable;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  out = [];
  process.env.NAX_GLOBAL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nax-cli-auth-"));
  _resetCredentialStore();
  _cliAuthDeps.log = (text: string) => out.push(text);
  _cliAuthDeps.isTTY = () => true;
  _authDeps.ambientAuthAvailable = mock(async () => false);
});

afterEach(() => {
  _authDeps.login = realLogin;
  _authDeps.ambientAuthAvailable = realAmbient;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
});

describe("authLoginCommand", () => {
  test("refuses without a TTY and names the environment variable path", async () => {
    _cliAuthDeps.isTTY = () => false;
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/environment variable/i);
  });

  test("reports the result as returned, without deriving kind from method", async () => {
    _authDeps.login = mock(async () => ({ providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const }));
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("openrouter");
    expect(out.join("\n")).toContain("oauth");
  });

  test("exits 130 with no error output when cancelled", async () => {
    class LoginCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "LoginCancelledError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new LoginCancelledError();
    });
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(130);
    expect(out.join("\n")).not.toMatch(/error|failed/i);
  });

  test("warns, without failing, when the new credential shadows a working env var", async () => {
    _authDeps.login = mock(async () => ({
      providerId: "openrouter",
      method: "api-key" as const,
      kind: "api-key" as const,
    }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/takes precedence/i);
  });
});

describe("authListCommand", () => {
  test("says so when the store is empty", async () => {
    expect(await authListCommand()).toBe(0);
    expect(out.join("\n")).toMatch(/no credentials/i);
  });

  test("prints provider and kind but never the key", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    await authListCommand();
    const text = out.join("\n");
    expect(text).toContain("openrouter");
    expect(text).toContain("api-key");
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("sk-");
  });

  test("marks a shadowed credential", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    await authListCommand();
    expect(out.join("\n")).toMatch(/shadow/i);
  });

  test("marks an expired OAuth credential", async () => {
    await naxCredentialStore().modify("openai-codex", async () => ({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
    }));
    await authListCommand();
    expect(out.join("\n")).toMatch(/expired/i);
  });
});

describe("authRmCommand", () => {
  test("removes the credential and never claims the user is logged out", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    const code = await authRmCommand("openrouter");

    expect(code).toBe(0);
    expect(await naxCredentialStore().read("openrouter")).toBeUndefined();
    const text = out.join("\n").toLowerCase();
    expect(text).not.toContain("logged out");
    expect(text).not.toContain("log out");
    expect(text).toContain("removed locally");
  });

  test("reports a provider that has no stored credential", async () => {
    expect(await authRmCommand("absent")).toBe(1);
    expect(out.join("\n")).toMatch(/no stored credential/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/cli/auth.test.ts`
Expected: FAIL — cannot resolve `@/cli/auth`.

- [ ] **Step 3: Add the label helper**

Append to `src/agents/native/auth.ts`:

```ts
export function authImportOutcomeLabel(status: ImportOutcome["status"]): string {
  if (status === "imported") return "imported";
  if (status === "skipped") return "skipped, already present";
  return "unsupported credential type";
}
```

Add it to the barrel's `./auth` export list in `src/agents/native/index.ts` too,
in alphabetical position after `AuthCancelledError`:

```ts
  authImportOutcomeLabel,
```

Without this the CLI cannot reach it: `check:alias-internals` forbids importing
`@/agents/native/auth` directly from `src/`.

- [ ] **Step 4: Implement the commands**

Create `src/cli/auth.ts`:

```ts
/**
 * The `nax auth` commands.
 *
 * Terminal I/O only. Everything touching nax-ai lives behind
 * src/agents/native/, the only place in src/ permitted to import it, so
 * nothing here imports the wire package or its types.
 *
 * Each command returns an exit code rather than calling process.exit, so the
 * behaviour is testable and bin/nax.ts owns the process.
 */

import chalk from "chalk";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@/agents/native";
import {
  ambientShadows,
  AuthCancelledError,
  authImportOutcomeLabel,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
  runLogin,
} from "@/agents/native";
import { PromptCancelledError, promptForLine, promptForSecret } from "./auth-prompt";

export const _cliAuthDeps: {
  log: (text: string) => void;
  isTTY: () => boolean;
} = {
  log: (text: string) => console.log(text),
  isTTY: () => process.stdin.isTTY === true,
};

/** The terminal's side of a login. Secrets go through the non-echoing prompt. */
function terminalInteraction(): AuthInteraction {
  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "secret") return promptForSecret(prompt.message);
      if (prompt.type === "select") {
        _cliAuthDeps.log(prompt.message);
        for (const option of prompt.options) _cliAuthDeps.log(`  ${chalk.cyan(option.id)}  ${option.label}`);
        return promptForLine("Choose:");
      }
      return promptForLine(prompt.message);
    },
    notify: (event: AuthEvent): void => {
      switch (event.type) {
        case "auth-url":
          _cliAuthDeps.log(`\n${chalk.bold("Open this URL to continue:")}\n  ${event.url}`);
          if (event.instructions !== undefined) _cliAuthDeps.log(event.instructions);
          return;
        case "device-code":
          _cliAuthDeps.log(`\nGo to ${event.verificationUri} and enter code ${chalk.bold(event.userCode)}`);
          return;
        case "info":
          _cliAuthDeps.log(event.message);
          for (const link of event.links ?? []) _cliAuthDeps.log(`  ${link.label ?? "Link"}: ${link.url}`);
          return;
        default:
          _cliAuthDeps.log(chalk.dim(event.message));
      }
    },
  };
}

export async function authLoginCommand(providerId: string): Promise<number> {
  if (!_cliAuthDeps.isTTY()) {
    _cliAuthDeps.log(
      `${chalk.red("nax auth login needs an interactive terminal.")}\n` +
        "For CI, set the provider's environment variable instead — nax reads it when nothing is stored.",
    );
    return 1;
  }

  try {
    const result = await runLogin(providerId, terminalInteraction());
    // Reported as returned. kind is never derived from method: M5 predicted
    // openrouter would report api-key here and its live run reported oauth.
    _cliAuthDeps.log(
      `${chalk.green("Signed in to")} ${chalk.bold(result.providerId)} ` +
        chalk.dim(`(method: ${result.method}, credential: ${result.kind})`),
    );

    if ((await ambientShadows([result.providerId])).length > 0) {
      _cliAuthDeps.log(
        chalk.yellow(
          `Note: ${result.providerId} also has credentials in your environment. The stored credential ` +
            `takes precedence from now on — run \`nax auth rm ${result.providerId}\` to go back to the environment.`,
        ),
      );
    }
    return 0;
  } catch (error) {
    // Ctrl+C is not a failure: 130 and nothing on stdout.
    if (error instanceof AuthCancelledError || error instanceof PromptCancelledError) return 130;
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authImportCommand(options: { from?: string; force?: boolean }): Promise<number> {
  try {
    const outcomes = await importPiCredentials(options);
    if (outcomes.length === 0) {
      _cliAuthDeps.log("Nothing to import.");
      return 0;
    }
    for (const outcome of outcomes) {
      _cliAuthDeps.log(`  ${outcome.providerId.padEnd(20)} ${authImportOutcomeLabel(outcome.status)}`);
    }
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authListCommand(): Promise<number> {
  try {
    const entries = await listStoredProviders();
    if (entries.length === 0) {
      _cliAuthDeps.log("No credentials stored. Add one with `nax auth login <provider>`.");
      return 0;
    }

    const shadowed = new Set(await ambientShadows(entries.map((entry) => entry.providerId)));

    for (const entry of entries) {
      const expiry =
        entry.expires === undefined
          ? ""
          : entry.expires <= Date.now()
            ? chalk.red(" expired")
            : chalk.dim(` expires ${new Date(entry.expires).toISOString()}`);
      const shadow = shadowed.has(entry.providerId) ? chalk.yellow(" shadows an environment variable") : "";
      _cliAuthDeps.log(`  ${entry.providerId.padEnd(20)} ${entry.kind}${expiry}${shadow}`);
    }
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authRmCommand(providerId: string): Promise<number> {
  try {
    const stored = await listStoredProviders();
    if (!stored.some((entry) => entry.providerId === providerId)) {
      _cliAuthDeps.log(chalk.red(`No stored credential for "${providerId}".`));
      return 1;
    }

    await removeStoredProvider(providerId);

    // Never "logged out": pi has no revocation, so the provider-side token
    // stays live until it expires. Saying otherwise would be false.
    _cliAuthDeps.log(
      `Credential for ${chalk.bold(providerId)} removed locally. ` +
        chalk.dim("The token stays valid at the provider until it expires — revoke it there if you need it dead."),
    );
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/unit/cli/auth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/auth.ts src/agents/native/auth.ts src/agents/native/index.ts test/unit/cli/auth.test.ts
git commit -m "feat(cli): implement nax auth login, import, list and rm

Commands return an exit code rather than calling process.exit, so behaviour is
testable and bin/ owns the process.

login refuses without a TTY and names the environment variable as the CI path,
rather than failing obscurely. Cancellation exits 130 with nothing printed,
because Ctrl+C is not a failure.

rm says the credential was removed locally and that the token stays valid at
the provider: pi has no revocation, so calling it a logout would be false. A
test asserts the phrase never appears."
```

---

### Task 9: nax — wire the commands up, and isolate the suite

**Files:**
- Modify: `src/agents/native/index.ts`
- Modify: `src/cli/index.ts`
- Modify: `bin/nax.ts`
- Modify: `test/preload.ts`
- Test: `test/unit/cli/auth-wiring.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-8.
- Produces: the `nax auth` command group, and a suite that cannot pass for the wrong reason.

**The preload change matters beyond this feature.** A developer with `OPENROUTER_API_KEY` exported would make the ambient probe return `true` in tests that assume it is `false`, so they would pass without proving anything. `test/preload.ts` already scrubs Telegram credentials for exactly this reason; provider keys belong in the same block.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli/auth-wiring.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("auth command wiring", () => {
  test("the native barrel re-exports the auth surface", async () => {
    const barrel = await import("@/agents/native");
    expect(typeof barrel.runLogin).toBe("function");
    expect(typeof barrel.importPiCredentials).toBe("function");
    expect(typeof barrel.listStoredProviders).toBe("function");
    expect(typeof barrel.removeStoredProvider).toBe("function");
    expect(typeof barrel.ambientShadows).toBe("function");
    expect(typeof barrel.naxCredentialStore).toBe("function");
  });

  test("the cli barrel exports the four commands", async () => {
    const barrel = await import("@/cli");
    expect(typeof barrel.authLoginCommand).toBe("function");
    expect(typeof barrel.authImportCommand).toBe("function");
    expect(typeof barrel.authListCommand).toBe("function");
    expect(typeof barrel.authRmCommand).toBe("function");
  });

  test("bin registers all four subcommands under an auth group", () => {
    const source = readFileSync(join(ROOT, "bin", "nax.ts"), "utf8");
    expect(source).toContain('program.command("auth")');
    expect(source).toContain('.command("login <provider>")');
    expect(source).toContain('.command("import")');
    expect(source).toContain('.command("list")');
    expect(source).toContain('.command("rm <provider>")');
  });

  test("the preload scrubs ambient provider keys, so probes cannot pass for the wrong reason", () => {
    const source = readFileSync(join(ROOT, "test", "preload.ts"), "utf8");
    expect(source).toContain("OPENROUTER_API_KEY");
    expect(source).toContain("OPENCODE_API_KEY");
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/cli/auth-wiring.test.ts`
Expected: FAIL — the barrels do not export these names.

- [ ] **Step 3: Extend the CLI barrel**

In `src/cli/index.ts`, in alphabetical position near the top (after the `accept` export):

```ts
export {
  _cliAuthDeps,
  authImportCommand,
  authListCommand,
  authLoginCommand,
  authRmCommand,
} from "./auth";
export { _authPromptDeps, PromptCancelledError, type PromptStdin, promptForLine, promptForSecret } from "./auth-prompt";
```

- [ ] **Step 4: Register the command group**

In `bin/nax.ts`, after the `config profile` group (near line 1180), add:

```ts
// ── auth ─────────────────────────────────────────────
const authCmd = program.command("auth").description("Manage provider credentials for the native agent");

authCmd
  .command("login <provider>")
  .description("Sign in to a provider and store the credential (interactive)")
  .action(async (provider: string) => {
    process.exit(await authLoginCommand(provider));
  });

authCmd
  .command("import")
  .description("Import credentials from pi's credential file")
  .option("--from <path>", "Source file", DEFAULT_PI_AUTH_PATH)
  .option("--force", "Overwrite credentials that are already stored", false)
  .action(async (options: { from?: string; force?: boolean }) => {
    process.exit(await authImportCommand({ from: options.from, force: options.force }));
  });

authCmd
  .command("list")
  .description("List stored credentials. A stored credential takes precedence over an environment variable")
  .action(async () => {
    process.exit(await authListCommand());
  });

authCmd
  .command("rm <provider>")
  .description("Remove a stored credential locally. Does not revoke it at the provider")
  .action(async (provider: string) => {
    process.exit(await authRmCommand(provider));
  });
```

Add to `bin/nax.ts`'s imports:

```ts
import { authImportCommand, authListCommand, authLoginCommand, authRmCommand } from "../src/cli";
import { DEFAULT_PI_AUTH_PATH } from "../src/agents/native";
```

- [ ] **Step 5: Scrub ambient provider keys in the preload**

In `test/preload.ts`, directly after the Telegram scrub block, add:

```ts
// ─── Provider-credential isolation ───────────────────────────────────────────
// The ambient-auth probe asks whether a provider would resolve from the
// environment. A developer with a real key exported would make it answer true
// in tests written to expect false — they would pass without proving anything.
// Redirecting ~/.nax does not isolate env, so scrub before any test file loads.
for (const key of [
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]) {
  delete process.env[key];
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/unit/cli/auth-wiring.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify the command is really reachable**

Run: `bun run bin/nax.ts auth list`
Expected: prints "No credentials stored." (or your real credentials, if you have already imported some) and exits 0.

Run: `bun run bin/nax.ts auth --help`
Expected: lists `login`, `import`, `list`, `rm`.

- [ ] **Step 8: Run the full gate**

Run: `bun run lint && bun test`
Expected: all 22 checks pass and the suite is green. `check:nax-ai-imports` must report clean — if it names `src/cli/auth.ts`, a nax-ai type leaked past the boundary and belongs behind `src/agents/native/` instead.

- [ ] **Step 9: Commit**

```bash
git add src/cli/index.ts bin/nax.ts test/preload.ts test/unit/cli/auth-wiring.test.ts
git commit -m "feat(cli): register the nax auth command group

Also scrubs ambient provider API keys in the test preload. The ambient-auth
probe asks whether a provider resolves from the environment, so a developer
with a real key exported would make tests written to expect false pass without
proving anything. The preload already does this for Telegram credentials, for
the same reason."
```

---

### Task 10: nax — wire the store into the client, and record why `hasCredentials()` is unfixed

**Files:**
- Modify: `src/agents/native/client.ts`
- Modify: `src/agents/native/adapter.ts` (docstring only)
- Test: `test/unit/agents/native/client.test.ts` (extend)

**Interfaces:**
- Consumes: `naxCredentialStore` (Task 3).
- Produces: nothing new. This is the change that makes every earlier task matter.

**This is the point of the plan.** Until `ClientOptions.credentials` is set, the store is never consulted and `nax auth login` has no effect on a run.

**Do not "fix" `hasCredentials()` here.** §6 of the spec records why it cannot be done at that seam and moves it to plan 3. This task only makes the reason discoverable in the code.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/agents/native/client.test.ts`:

```ts
test("passes a credential store to createClient, so a stored credential reaches a run", async () => {
  let sawCredentials = false;
  _clientDeps.build = async () => {
    // The real buildNativeClient is what we are asserting about, so call it
    // through a createClient spy rather than replacing the whole builder.
    throw new Error("unused");
  };

  // Assert on the source instead: buildNativeClient's options object is not
  // observable from outside, and a client built for real would load the
  // catalog.
  const source = await Bun.file(new URL("../../../../src/agents/native/client.ts", import.meta.url)).text();
  sawCredentials = /credentials:\s*naxCredentialStore\(\)/.test(source);
  expect(sawCredentials).toBe(true);
});
```

**Note on why this test is shaped this way:** `buildNativeClient` constructs and returns a `Client`; the options it passed are not readable from the result, and `test/preload.ts` replaces `_clientDeps.build` with a sentinel before any test file loads precisely so a real client never leaks into the module cache. A source assertion is the honest way to pin this without loading a real catalog. If you prefer a behavioural test, inject a `createClient` spy through a new seam — but do not remove the preload sentinel to get one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/client.test.ts`
Expected: FAIL — `client.ts` passes no `credentials`.

- [ ] **Step 3: Wire the store**

In `src/agents/native/client.ts`, add the import and the field:

```ts
import { naxCredentialStore } from "./credentials";
```

```ts
export async function buildNativeClient(): Promise<Client> {
  return createClient({
    providers: await piProviders(),
    protocols: piProtocols(),
    // Without this the store is never consulted and `nax auth login` has no
    // effect on a run. pi resolves store first, then ambient sources, so a
    // stored credential owns its provider and CI with only an env var keeps
    // working.
    credentials: naxCredentialStore(),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Record the constraint on `hasCredentials()`**

Replace the body comment of `hasCredentials()` in `src/agents/native/adapter.ts` with:

```ts
  /**
   * Reports client construction, not credential resolution — so it is
   * effectively always true, and AgentManager.validateCredentials() cannot
   * prune this agent.
   *
   * That is known and deliberate for now. Answering honestly means asking
   * whether a specific provider resolves, and this method takes no provider:
   * the registry receives the manager's config slice, and
   * agentManagerConfigSelector excludes config.models by design under ADR-019.
   * Probing every provider in the catalog is not an alternative, because
   * pi's resolve() may execute commands.
   *
   * The fix belongs to Phase A plan 3, which does model resolution and has a
   * provider legitimately in scope. Until then a missing or bad credential
   * surfaces per provider at request time, through the typed mapping from
   * ProtocolError.kind "auth" to availability / fail-auth.
   *
   * See docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md §6.
   */
  async hasCredentials(): Promise<boolean> {
```

Leave the implementation exactly as it is.

- [ ] **Step 6: Run the full gate**

Run: `bun run lint && bun test`
Expected: green. `check:file-sizes` still reports baseline 17 or fewer oversized files.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/client.ts src/agents/native/adapter.ts test/unit/agents/native/client.test.ts
git commit -m "feat(auth): pass the credential store to the native client

Until now ClientOptions.credentials was unset, so the store was never
consulted and a stored credential could not reach a run. This one field is
what makes nax auth login do anything.

Also records in adapter.ts why hasCredentials() is still dishonest and where
the fix lives. Answering it means asking whether a specific provider resolves,
and the method takes no provider: the registry receives a config slice that
excludes config.models by design under ADR-019. Plan 3 has a provider in scope
and is where it belongs."
```

---

### Task 11: live verification

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md` (record the result)

**Interfaces:**
- Consumes: the whole feature.
- Produces: evidence, and a recorded result. No source changes.

**Why manual:** real OAuth flows open a browser and run a loopback callback server, so they are not fixture-recordable. This mirrors how nax-ai M5 recorded its own live check.

- [ ] **Step 1: Import the real pi credentials**

Run: `bun run bin/nax.ts auth import`
Expected: one line per provider in `~/.pi/agent/auth.json`, each `imported`. No key material in the output.

- [ ] **Step 2: Confirm the file is owner-only**

Run: `ls -l ~/.nax/credentials`
Expected: mode `-rw-------` (0600).

- [ ] **Step 3: List, and check the shadow warning is honest**

Run: `bun run bin/nax.ts auth list`
Expected: each imported provider with its kind; OAuth entries show an expiry. No keys.

Then export a provider key you already have stored and list again:

Run: `OPENROUTER_API_KEY=whatever bun run bin/nax.ts auth list`
Expected: that provider is marked as shadowing an environment variable, and the others are not. If every row is marked, the probe is returning true unconditionally — investigate before continuing.

- [ ] **Step 4: Prove the stored credential is the one a run uses**

Run a real completion over the native path — the `classify-route` op is the cheapest — with the environment variable unset, so only the store can satisfy it.

Expected: the call succeeds. That is the end-to-end proof: store to client to provider.

- [ ] **Step 5: Verify a login from the bundle, not just from source**

Run: `bun run build && node dist/nax.js auth login openrouter`

Expected: the flow runs to completion. **This step is not redundant with a source-run login.** pi loads OAuth flows through a deliberately bundler-opaque dynamic import, so they resolve from `node_modules` at runtime — a bundle is the case that can break while source passes.

- [ ] **Step 6: Confirm rm does not overclaim**

Run: `bun run bin/nax.ts auth rm openrouter`
Expected: says the credential was removed locally and the token remains valid at the provider. It must not say "logged out".

- [ ] **Step 7: Record the result**

Append a "Live verification" paragraph to the spec, stating the date, which providers were exercised, the method and kind each reported, that the file was 0600, and that the bundled login worked. Note any result that differed from what this plan predicted — the openrouter kind is exactly the kind of prediction that has already been wrong once.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md
git commit -m "docs: record the live verification of nax auth"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task. §1 the boundary and §2 the module layout → Tasks 3, 4, 7, 8 (each file lands where the layout says, and Task 9's wiring test asserts the gate stays clean). §3 interactive-only login → Tasks 5 and 8; the no-`--method` rule is pinned by a test in Task 5, and the TTY refusal by one in Task 8. §4 import, list, remove → Task 6 for the logic and Task 8 for the output. §5 the store wiring, the resolution order and the shadow warning → Tasks 1, 6, 8 and 10. §6 `hasCredentials()` → Task 10, which records the constraint rather than fixing it, as the spec now requires. §7 the error table → Task 5's `toNaxError` and its five error tests. Security invariants → tests in Tasks 6, 7 and 8 (no key printed, no key in argv by construction, echo suppressed, terminal restored, parse failure refuses). Testing section → Task 9's preload scrub. Verification → Task 11.

**Prerequisite coverage.** The spec's release prerequisite is Tasks 1 and 2, and Task 2 Step 5 verifies the published tarball actually contains both exports rather than trusting the release succeeded.

**Placeholder scan.** No TBDs. Every code step carries real code. No step says "similar to Task N" — Task 8's terminal interaction and Task 7's prompt are written out in full even though they are related.

**Type consistency.** `AuthInteraction`, `AuthPrompt`, `AuthEvent` are defined in Task 4 and used under those names in Tasks 5 and 8. `AuthResult` is `{providerId, method, kind}` in Tasks 4, 5 and 8. `StoredEntry` is `{providerId, kind, expires?}` in Tasks 3, 6 and 8. `ImportOutcome["status"]` is `"imported" | "skipped" | "unsupported"` in Task 6 and consumed by `authImportOutcomeLabel` in Task 8. `_authDeps` is introduced in Task 5 with `login` and extended in use — not redefined — by Task 6's `ambientAuthAvailable`; both are set in the same object literal in Task 5 Step 3, so Task 6 adds no new seam. `naxCredentialStore` and `_resetCredentialStore` keep their names across Tasks 3, 5, 6, 8 and 10.

**Ordering notes for the executor.**
1. Tasks 1 and 2 must precede everything. Nothing else typechecks against nax-ai 0.1.2, because `login()` and `ambientAuthAvailable` are not in it.
2. Task 6 uses `_authDeps.ambientAuthAvailable`, which Task 5 Step 3 defines in the same object literal as `login`. Executing Task 6 first leaves that seam undefined.
3. **The native barrel is extended in Task 6, not Task 8.** `src/cli/auth.ts` must import from `@/agents/native` rather than `@/agents/native/auth`, because `scripts/check-alias-internals.ts` rejects value imports aliasing into a barrel's internals from `src/` — it exempts type-only imports, and exempts `test/` entirely, which is why Task 8's *test* may import `@/agents/native/auth` directly while its *source* may not.

**A self-review correction worth recording.** The first draft of this plan had Task 8's CLI importing from the barrel while Task 9 was what populated it, and had Task 6 re-importing a symbol Task 5 already imported. Both would have failed at the executor's first `bun run lint`, not at review.

**One thing the executor should not do.** Do not remove the `_clientDeps.build` sentinel in `test/preload.ts` to make Task 10's assertion behavioural. That sentinel exists because an unmocked build memoises a real client into the module cache for the rest of the process, silently defeating every later test's own override.
