# M5 — login flows: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give nax-ai a `login()` that obtains credentials — api-key entry and OAuth — behind the existing allowlist gate, so a consumer CLI has something to call.

**Architecture:** One free function `login()` in `src/auth/login.ts` speaks nax-ai's own vocabulary and never imports pi-ai. All pi contact stays in `src/auth/pi-auth.ts`, already the sole allowlisted auth adapter, which resolves a provider's real auth methods and returns nax-shaped runner closures. Credentials are written through the caller's `CredentialStore.modify()`, inheriting its cross-process lock; `login()` returns metadata, never the secret.

**Tech Stack:** TypeScript 7 (exact pin), ESM-only, Node >= 22.19, Vitest, Biome. Upstream client `@earendil-works/pi-ai` (exact pin).

**Spec:** [`../specs/2026-09-01-nax-ai-m5-login-flows-design.md`](../specs/2026-09-01-nax-ai-m5-login-flows-design.md)

## Global Constraints

- **Only three files may import pi-ai**: `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts`, `src/auth/pi-auth.ts`. `bun run check:pi-ai-imports` enforces it, scanning `src/` only — **test files may import pi types freely**.
- **No `Bun.*` and no `bun:` imports anywhere in `src/`.** `bun run check:no-bun-apis` enforces it.
- **`exactOptionalPropertyTypes` is on.** Build optional properties conditionally (`...(x !== undefined ? { x } : {})`). On a class, declare `readonly f: T | undefined` rather than `readonly f?: T` — assigning a possibly-undefined constructor parameter to an optional field is a type error under this flag.
- **Imports carry explicit `.ts` extensions** — `nodenext` resolution, not bundler.
- **Opaque values stay opaque.** A credential `key` is never inspected, compared, logged or synthesised — the one permitted check is the emptiness test in Task 7, which reads its length and never its content. Never substitute `""` for an absent value.
- **Tests** live under `test/`, mirroring `src/`, named `*.test.ts`, using Vitest.
- **A regression test must be shown to fail against the old code before it counts.**
- Commands: `bun run test` · `bun run typecheck` · `bun run lint`

---

## File Structure

| File | Responsibility | Imports pi-ai? |
|:---|:---|:---|
| `src/auth/oauth-policy.ts` | *(modify)* the allowlist; `github-copilot` moves out | no |
| `src/auth/login-types.ts` | *(create)* the login vocabulary — prompts, events, options, result | no |
| `src/auth/login-errors.ts` | *(create)* `AuthMethodUnavailableError`, `LoginCancelledError`, `LoginFailedError` | no |
| `src/auth/login.ts` | *(create)* `login()` — method selection, orchestration, storage | no |
| `src/auth/pi-auth.ts` | *(modify)* `resolveLoginTarget`, `toPiInteraction`, `_loginDeps` | **yes** (already allowlisted) |
| `src/index.ts` | *(modify)* public exports | no |

`login-types.ts` and `login-errors.ts` are split because the errors are values and the vocabulary is types: a consumer importing the union to render a prompt should not pull in three classes, and `pi-auth.ts` needs the errors without needing the whole vocabulary.

---

### Task 1: `github-copilot` leaves the allowlist

**Files:**
- Modify: `src/auth/oauth-policy.ts:26-39`
- Test: `test/oauth-policy.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PERMITTED_OAUTH_FLOWS` is `["openai-codex", "openrouter"]`; `PROHIBITED_OAUTH_FLOWS` gains a `"github-copilot"` key. Later tasks rely on `isOAuthFlowPermitted("github-copilot") === false`.

**Why:** pi reports `isSubscription: true` for `github-copilot`, which fails the allowlist's own "first-party developer credential rather than a consumer subscription" clause and was never established against the alternative one. It moves into `PROHIBITED_OAUTH_FLOWS` rather than being deleted, because an absent entry raises the generic "Unknown OAuth flow" error that reads as a typo — inviting exactly the "fix" that file exists to prevent.

- [ ] **Step 1: Write the failing test**

Append to the `describe("oauth policy", ...)` block in `test/oauth-policy.test.ts`:

```ts
  it("does not permit the github-copilot flow", () => {
    expect(isOAuthFlowPermitted("github-copilot")).toBe(false);
    expect(PERMITTED_OAUTH_FLOWS).not.toContain("github-copilot");
  });

  it("records why github-copilot is not cleared, and does not overstate it", () => {
    // The reason must survive, or a future reader restores the entry as an
    // oversight. It must also not claim a ToS violation we have not
    // established — that is anthropic's case, not this one.
    expect(PROHIBITED_OAUTH_FLOWS["github-copilot"]).toMatch(/not cleared/i);
    expect(PROHIBITED_OAUTH_FLOWS["github-copilot"]).not.toMatch(/ToS violation/i);
  });

  it("still permits openrouter", () => {
    expect(isOAuthFlowPermitted("openrouter")).toBe(true);
    expect(() => assertOAuthFlowPermitted("openrouter")).not.toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/oauth-policy.test.ts`
Expected: FAIL — `isOAuthFlowPermitted("github-copilot")` returns `true`, and `PROHIBITED_OAUTH_FLOWS["github-copilot"]` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/auth/oauth-policy.ts`, remove `"github-copilot"` from the permitted array and add the prohibited entry:

```ts
export const PERMITTED_OAUTH_FLOWS: readonly ProviderId[] = Object.freeze(["openai-codex", "openrouter"]);

/**
 * OAuth flows that must never be registered, with the reason recorded so a
 * future reader does not "fix" the omission.
 */
export const PROHIBITED_OAUTH_FLOWS: Readonly<Record<ProviderId, string>> = Object.freeze({
  anthropic:
    "Anthropic subscription OAuth outside the official Claude CLI is server-blocked and a Consumer ToS violation. Route Claude subscription traffic through the official CLI instead.",
  "github-copilot":
    "Not cleared: the upstream catalog marks this flow isSubscription: true, which fails this allowlist's 'first-party developer credential rather than a consumer subscription' clause, and its terms were never checked against the other one. This is an unresolved terms question, not an established violation like anthropic's — a review may reverse it on evidence. The provider's api-key login is unaffected.",
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS. `test/providers/catalog.test.ts` must stay green — confirm it does. It will, because `normaliseCatalog` calls the gate only when `rawProvider.auth.kind === "oauth"` (`src/providers/catalog.ts:63`) and `github-copilot` declares both auth kinds, so `toProviderAuth` maps it to `api-key` and the gate is never reached for it. **If a catalog test does fail, stop** — that means a provider is now unloadable, which is the failure mode this entry was checked against.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-policy.ts test/oauth-policy.test.ts
git commit -m "feat(auth): drop github-copilot from the OAuth allowlist"
```

---

### Task 2: The login vocabulary and its errors

**Files:**
- Create: `src/auth/login-types.ts`
- Create: `src/auth/login-errors.ts`
- Test: `test/auth/login-errors.test.ts`

**Interfaces:**
- Consumes: `CredentialStore`, `ProviderId`, `StoredCredential` from `src/types.ts`.
- Produces: types `LoginMethod`, `LoginOption`, `LoginPrompt`, `LoginLink`, `LoginEvent`, `LoginInteraction`, `LoginOptions`, `LoginResult`; classes `AuthMethodUnavailableError(providerId, requested?)`, `LoginCancelledError(providerId)`, `LoginFailedError(providerId, reason)`. Every later task uses these names.

- [ ] **Step 1: Write the failing test**

Create `test/auth/login-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AuthMethodUnavailableError,
  LoginCancelledError,
  LoginFailedError,
} from "../../src/auth/login-errors.ts";

describe("login errors", () => {
  it("names the provider when no method is available", () => {
    const error = new AuthMethodUnavailableError("acme");
    expect(error.name).toBe("AuthMethodUnavailableError");
    expect(error.providerId).toBe("acme");
    expect(error.requested).toBeUndefined();
    expect(error.message).toMatch(/acme/);
  });

  it("distinguishes a requested method that is unavailable", () => {
    const error = new AuthMethodUnavailableError("acme", "oauth");
    expect(error.requested).toBe("oauth");
    expect(error.message).toMatch(/oauth/);
  });

  it("reports cancellation as its own error, not a failure", () => {
    const error = new LoginCancelledError("acme");
    expect(error.name).toBe("LoginCancelledError");
    expect(error).not.toBeInstanceOf(LoginFailedError);
  });

  it("carries the reason a login failed", () => {
    const error = new LoginFailedError("acme", "the flow returned no credential");
    expect(error.name).toBe("LoginFailedError");
    expect(error.message).toMatch(/returned no credential/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/login-errors.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/login-errors.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth/login-types.ts`:

```ts
/**
 * The vocabulary of a login, in nax-ai's own terms.
 *
 * pi-ai's equivalents are snake_case (`auth_url`, `device_code`, `manual_code`,
 * `api_key`); these are kebab-case, matching `ProtocolError.kind`'s
 * `rate-limit` and `bad-request`. That translation is the boundary: it is what
 * keeps a rename upstream from becoming a breaking change here.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "../types.ts";

export type LoginMethod = "api-key" | "oauth";

export interface LoginOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * `signal` cancels this one prompt — a flow uses it when an out-of-band event
 * resolves the step, e.g. a manual-code prompt raced against a callback
 * server. It is not the whole login's signal, which lives on `LoginOptions`.
 */
export type LoginPrompt = { readonly signal?: AbortSignal } & (
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "select"; readonly message: string; readonly options: readonly LoginOption[] }
  | { readonly type: "manual-code"; readonly message: string; readonly placeholder?: string }
);

export interface LoginLink {
  readonly url: string;
  readonly label?: string;
}

export type LoginEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly LoginLink[] }
  | { readonly type: "auth-url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device-code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string };

/**
 * Login interaction, serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered text or, for `select`, the chosen option id.
 * Reject it to cancel.
 */
export interface LoginInteraction {
  prompt(prompt: LoginPrompt): Promise<string>;
  notify(event: LoginEvent): void;
}

export interface LoginOptions {
  readonly providerId: ProviderId;
  readonly credentials: CredentialStore;
  readonly interaction: LoginInteraction;
  /** Skips the method prompt. Throws if the named method is unavailable. */
  readonly method?: LoginMethod;
  readonly signal?: AbortSignal;
}

/**
 * Metadata, deliberately not the credential: `login()` has already written it
 * to the store, and returning the secret would create a second copy with no
 * consumer. A caller that cannot obtain it cannot leak it.
 */
export interface LoginResult {
  readonly providerId: ProviderId;
  readonly method: LoginMethod;
  readonly kind: StoredCredential["kind"];
}
```

Create `src/auth/login-errors.ts`:

```ts
import type { ProviderId } from "../types.ts";
import type { LoginMethod } from "./login-types.ts";

/**
 * The provider offers no login method this package can run — either none at
 * all, or not the one the caller named. Distinct from a policy refusal, which
 * raises OAuthFlowProhibitedError: an absence and a prohibition send a reader
 * to different problems.
 */
export class AuthMethodUnavailableError extends Error {
  readonly providerId: ProviderId;
  // Declared as `| undefined` rather than optional: under
  // exactOptionalPropertyTypes, assigning a possibly-undefined parameter to an
  // optional field is a type error.
  readonly requested: LoginMethod | undefined;

  constructor(providerId: ProviderId, requested?: LoginMethod) {
    super(
      requested === undefined
        ? `Provider "${providerId}" offers no login method this package can run.`
        : `Provider "${providerId}" does not offer "${requested}" login.`,
    );
    this.name = "AuthMethodUnavailableError";
    this.providerId = providerId;
    this.requested = requested;
  }
}

/** The user cancelled, or the caller aborted. Not a failure. */
export class LoginCancelledError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Login to "${providerId}" was cancelled.`);
    this.name = "LoginCancelledError";
    this.providerId = providerId;
  }
}

/** The flow ran and did not produce a usable credential. */
export class LoginFailedError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, reason: string) {
    super(`Login to "${providerId}" failed: ${reason}`);
    this.name = "LoginFailedError";
    this.providerId = providerId;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/auth/login-errors.test.ts && bun run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login-types.ts src/auth/login-errors.ts test/auth/login-errors.test.ts
git commit -m "feat(auth): the login vocabulary and its errors"
```

---

### Task 3: `resolveLoginTarget` — dispatch off pi's own provider auth

**Files:**
- Modify: `src/auth/pi-auth.ts`
- Test: `test/auth/pi-auth-login.test.ts`

**Interfaces:**
- Consumes: `AuthMethodUnavailableError`, `LoginFailedError` (Task 2); `isOAuthFlowPermitted`, `assertOAuthFlowPermitted` from `./oauth-policy.ts`; the module-private `fromPi` already in this file.
- Produces:
  - `export interface LoginRunner { readonly label: string; run(interaction: LoginInteraction, signal: AbortSignal): Promise<StoredCredential> }`
  - `export interface LoginTarget { readonly apiKey?: LoginRunner; readonly oauth?: LoginRunner }`
  - `export async function resolveLoginTarget(providerId: ProviderId): Promise<LoginTarget>`
  - `export const _loginDeps = { providers }` — the test seam.

**Why this exists at all:** `toProviderAuth` (`src/providers/pi-catalog.ts:29`) resolves api-key over oauth when a provider declares both, so `ResolvedProvider.auth.kind` reports `api-key` for `openrouter`. Dispatching on it would silently never run OAuth. It also hides `anthropic`'s OAuth, which is the one case where hiding is correct — and the projection cannot tell the two apart, which is why it must not be the dispatcher.

`toPiInteraction` is written in Task 4; for this task stub it as a function that throws, so the runner compiles and the dispatch is tested on its own.

- [ ] **Step 1: Write the failing test**

Create `test/auth/pi-auth-login.test.ts`:

```ts
import type { Provider as PiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthMethodUnavailableError } from "../../src/auth/login-errors.ts";
import { _loginDeps, resolveLoginTarget } from "../../src/auth/pi-auth.ts";

/**
 * A pi provider is a large structural type and this suite reads four fields of
 * it, so the doubles are built narrow and cast. Widening them would test the
 * cast, not the dispatch.
 */
function piProvider(input: {
  id: string;
  apiKey?: { name: string; withLogin: boolean };
  oauth?: { name: string; loginLabel?: string };
}): PiProvider {
  return {
    id: input.id,
    name: input.id,
    auth: {
      ...(input.apiKey !== undefined
        ? { apiKey: { name: input.apiKey.name, ...(input.apiKey.withLogin ? { login: async () => ({ type: "api_key", key: "k" }) } : {}) } }
        : {}),
      ...(input.oauth !== undefined
        ? {
            oauth: {
              name: input.oauth.name,
              ...(input.oauth.loginLabel !== undefined ? { loginLabel: input.oauth.loginLabel } : {}),
              login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
            },
          }
        : {}),
    },
  } as unknown as PiProvider;
}

const real = _loginDeps.providers;
afterEach(() => {
  _loginDeps.providers = real;
});

function withProviders(providers: readonly PiProvider[]): void {
  _loginDeps.providers = async () => providers;
}

describe("resolveLoginTarget", () => {
  it("offers oauth for a provider the catalog projection reports as api-key", async () => {
    // openrouter declares both, so toProviderAuth maps it to "api-key". This is
    // the trap: dispatching on the projection would never run its OAuth flow.
    withProviders([
      piProvider({ id: "openrouter", apiKey: { name: "OpenRouter API key", withLogin: true }, oauth: { name: "OpenRouter OAuth" } }),
    ]);

    const target = await resolveLoginTarget("openrouter");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for a provider outside the allowlist", async () => {
    withProviders([
      piProvider({ id: "anthropic", apiKey: { name: "Anthropic API key", withLogin: true }, oauth: { name: "Anthropic (Claude Pro/Max)" } }),
    ]);

    const target = await resolveLoginTarget("anthropic");

    expect(target.oauth).toBeUndefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for github-copilot, whose entry is not cleared", async () => {
    withProviders([
      piProvider({ id: "github-copilot", apiKey: { name: "GitHub token", withLogin: true }, oauth: { name: "GitHub Copilot" } }),
    ]);

    expect((await resolveLoginTarget("github-copilot")).oauth).toBeUndefined();
  });

  it("offers oauth only, for a provider with no api-key auth", async () => {
    withProviders([piProvider({ id: "openai-codex", oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } })]);

    const target = await resolveLoginTarget("openai-codex");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeUndefined();
  });

  it("does not offer an api-key method the provider cannot run interactively", async () => {
    // Ambient-only providers omit `login`; offering one would prompt for a key
    // the provider has no way to accept.
    withProviders([piProvider({ id: "bedrock", apiKey: { name: "AWS profile", withLogin: false } })]);

    expect((await resolveLoginTarget("bedrock")).apiKey).toBeUndefined();
  });

  it("prefers the oauth loginLabel over its name when both exist", async () => {
    withProviders([piProvider({ id: "openrouter", oauth: { name: "OpenRouter OAuth", loginLabel: "Sign in with OpenRouter" } })]);

    expect((await resolveLoginTarget("openrouter")).oauth?.label).toBe("Sign in with OpenRouter");
  });

  it("rejects an unknown provider", async () => {
    withProviders([]);
    await expect(resolveLoginTarget("nope")).rejects.toThrow(AuthMethodUnavailableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/pi-auth-login.test.ts`
Expected: FAIL — `resolveLoginTarget` and `_loginDeps` are not exported from `src/auth/pi-auth.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/auth/pi-auth.ts`. Extend the existing import on line 8 to include `Provider as PiProvider`, and add the new imports:

```ts
import type {
  AuthEvent as PiAuthEvent,
  AuthPrompt as PiAuthPrompt,
  Credential,
  MutableModels,
  Provider as PiProvider,
  CredentialStore as PiCredentialStore,
} from "@earendil-works/pi-ai";
import type { CredentialStore, ModelRef, ProviderId, StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError, LoginFailedError } from "./login-errors.ts";
import type { LoginInteraction } from "./login-types.ts";
import { assertOAuthFlowPermitted, isOAuthFlowPermitted } from "./oauth-policy.ts";
import type { AuthResolver, ResolvedAuth } from "./resolver.ts";
```

Then append:

```ts
export interface LoginRunner {
  /** Shown in the method prompt when a provider offers both. */
  readonly label: string;
  run(interaction: LoginInteraction, signal: AbortSignal): Promise<StoredCredential>;
}

export interface LoginTarget {
  readonly apiKey?: LoginRunner;
  readonly oauth?: LoginRunner;
}

/**
 * Test seam. The real read is a dynamic import because pi-ai's provider table
 * is large and only login needs it, matching pi-catalog.ts's own pattern.
 */
export const _loginDeps = {
  providers: async (): Promise<readonly PiProvider[]> => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    return builtinProviders();
  },
};

function required(credential: Credential, providerId: ProviderId): StoredCredential {
  const stored = fromPi(credential);
  if (stored === undefined) throw new LoginFailedError(providerId, "the flow returned no credential");
  return stored;
}

/**
 * Resolves which logins a provider can actually run.
 *
 * Reads pi's own two auth fields, NOT ResolvedProvider.auth: toProviderAuth
 * resolves api-key over oauth when a provider declares both, which hides
 * openrouter's OAuth flow (wrong) and anthropic's (right) indistinguishably.
 *
 * The allowlist is applied per method, not per provider, so a provider with a
 * disallowed OAuth flow keeps its api-key login.
 */
export async function resolveLoginTarget(providerId: ProviderId): Promise<LoginTarget> {
  const provider = (await _loginDeps.providers()).find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new AuthMethodUnavailableError(providerId);

  const target: { apiKey?: LoginRunner; oauth?: LoginRunner } = {};

  const apiKeyAuth = provider.auth.apiKey;
  if (apiKeyAuth?.login !== undefined) {
    // bind rather than call detached: pi's flows are object methods and may
    // read `this`.
    const run = apiKeyAuth.login.bind(apiKeyAuth);
    target.apiKey = {
      label: apiKeyAuth.name,
      run: async (interaction, signal) => required(await run({ ...toPiInteraction(interaction), signal }), providerId),
    };
  }

  const oauthAuth = provider.auth.oauth;
  if (oauthAuth !== undefined && isOAuthFlowPermitted(providerId)) {
    const run = oauthAuth.login.bind(oauthAuth);
    target.oauth = {
      label: oauthAuth.loginLabel ?? oauthAuth.name,
      run: async (interaction, signal) => {
        // Before the loader is touched, not after: pi bundles every flow behind
        // one lazy loader, so the gate must sit in front of it.
        assertOAuthFlowPermitted(providerId);
        return required(await run({ ...toPiInteraction(interaction), signal }), providerId);
      },
    };
  }

  return target;
}
```

Add the temporary stub that Task 4 replaces — without it this task does not compile. Give
it Task 4's real return signature, not a `never` one: both compile here, but this way the
Task 4 replacement is guaranteed signature-compatible rather than merely assignable.

```ts
function toPiInteraction(_interaction: LoginInteraction): {
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
} {
  throw new Error("toPiInteraction is implemented in Task 4");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun x vitest --run test/auth/pi-auth-login.test.ts && bun run typecheck && bun run check:pi-ai-imports`
Expected: PASS. The import gate must stay green — the new pi import is inside `src/auth/pi-auth.ts`, which is allowlisted.

- [ ] **Step 5: Commit**

```bash
git add src/auth/pi-auth.ts test/auth/pi-auth-login.test.ts
git commit -m "feat(auth): resolve a provider's real login methods"
```

---

### Task 4: `toPiInteraction` — the boundary translation

**Files:**
- Modify: `src/auth/pi-auth.ts` (replace the Task 3 stub)
- Test: `test/auth/pi-auth-login.test.ts` (append)

**Interfaces:**
- Consumes: `LoginInteraction`, `LoginPrompt`, `LoginEvent` (Task 2).
- Produces: module-private `toPiInteraction(interaction: LoginInteraction): { prompt(p: PiAuthPrompt): Promise<string>; notify(e: PiAuthEvent): void }`. Nothing outside this file uses it.

**Direction of travel:** pi *calls* us. It hands a pi-shaped prompt in and we present a nax-shaped one to the consumer; it hands a pi-shaped event in and we forward a nax-shaped one. Only the four names differ: `manual_code`/`auth_url`/`device_code` become `manual-code`/`auth-url`/`device-code`. `text`, `secret`, `select`, `info` and `progress` pass through unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/auth/pi-auth-login.test.ts`. Add `LoginEvent`, `LoginPrompt` to the type
imports from `../../src/auth/login-types.ts`, and add `AuthEvent`, `AuthPrompt` — unaliased,
there is no local collision in this file — to the **existing** `import type { Provider as
PiProvider } from "@earendil-works/pi-ai";` line. Bare names only: an inner `type` modifier
inside an `import type { ... }` is **TS2206** under `verbatimModuleSyntax`.

```ts
describe("interaction translation", () => {
  function recorder() {
    const prompts: LoginPrompt[] = [];
    const events: LoginEvent[] = [];
    return {
      prompts,
      events,
      interaction: {
        prompt: async (prompt: LoginPrompt) => {
          prompts.push(prompt);
          return "answer";
        },
        notify: (event: LoginEvent) => {
          events.push(event);
        },
      },
    };
  }

  /** Drives the translation the way pi does: through a resolved runner. */
  async function drive(input: { prompt?: AuthPrompt; event?: AuthEvent }) {
    const seen = recorder();
    withProviders([
      {
        id: "acme",
        name: "acme",
        auth: {
          apiKey: {
            name: "Acme API key",
            login: async (interaction: { prompt(p: AuthPrompt): Promise<string>; notify(e: AuthEvent): void }) => {
              if (input.event !== undefined) interaction.notify(input.event);
              if (input.prompt !== undefined) await interaction.prompt(input.prompt);
              return { type: "api_key", key: "k" };
            },
          },
        },
      } as unknown as PiProvider,
    ]);
    const target = await resolveLoginTarget("acme");
    await target.apiKey?.run(seen.interaction, new AbortController().signal);
    return seen;
  }

  it("renames manual_code to manual-code", async () => {
    const seen = await drive({ prompt: { type: "manual_code", message: "Paste the URL" } });
    expect(seen.prompts[0]).toEqual({ type: "manual-code", message: "Paste the URL" });
  });

  it("passes a secret prompt through unchanged", async () => {
    const seen = await drive({ prompt: { type: "secret", message: "API key", placeholder: "sk-..." } });
    expect(seen.prompts[0]).toEqual({ type: "secret", message: "API key", placeholder: "sk-..." });
  });

  it("carries select options through", async () => {
    const seen = await drive({
      prompt: { type: "select", message: "Pick", options: [{ id: "a", label: "A", description: "first" }] },
    });
    expect(seen.prompts[0]).toEqual({
      type: "select",
      message: "Pick",
      options: [{ id: "a", label: "A", description: "first" }],
    });
  });

  it("renames auth_url to auth-url", async () => {
    const seen = await drive({ event: { type: "auth_url", url: "https://x", instructions: "open it" } });
    expect(seen.events[0]).toEqual({ type: "auth-url", url: "https://x", instructions: "open it" });
  });

  it("renames device_code to device-code and keeps its timings", async () => {
    const seen = await drive({
      event: { type: "device_code", userCode: "ABCD", verificationUri: "https://v", intervalSeconds: 5 },
    });
    expect(seen.events[0]).toEqual({
      type: "device-code",
      userCode: "ABCD",
      verificationUri: "https://v",
      intervalSeconds: 5,
    });
  });

  it("omits an absent optional rather than setting it undefined", async () => {
    // exactOptionalPropertyTypes: an absent field and a field set to undefined
    // are different things, and a consumer rendering `"instructions" in event`
    // would see the wrong answer.
    const seen = await drive({ event: { type: "auth_url", url: "https://x" } });
    expect(seen.events[0]).not.toHaveProperty("instructions");
  });

  it("returns the consumer's answer to pi", async () => {
    const seen = await drive({ prompt: { type: "text", message: "Name" } });
    expect(seen.prompts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/pi-auth-login.test.ts -t "interaction translation"`
Expected: FAIL with "toPiInteraction is implemented in Task 4".

- [ ] **Step 3: Write minimal implementation**

Replace the Task 3 stub in `src/auth/pi-auth.ts`. `PiAuthPrompt` and `PiAuthEvent` are
already imported (Task 3); add `LoginEvent, LoginPrompt` to the `./login-types.ts` type
import.

> **Do not write an inner `type` modifier** inside those `import type { ... }` statements —
> `import type { A, type B }` is **TS2206** under `verbatimModuleSyntax`, which this repo
> enables. Add bare names to the existing `import type` line.

```ts
function fromPiPrompt(prompt: PiAuthPrompt): LoginPrompt {
  const signal = prompt.signal !== undefined ? { signal: prompt.signal } : {};
  switch (prompt.type) {
    case "manual_code":
      return {
        ...signal,
        type: "manual-code",
        message: prompt.message,
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
      };
    case "select":
      return { ...signal, type: "select", message: prompt.message, options: prompt.options };
    default:
      return {
        ...signal,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
      };
  }
}

function fromPiEvent(event: PiAuthEvent): LoginEvent {
  switch (event.type) {
    case "auth_url":
      return {
        type: "auth-url",
        url: event.url,
        ...(event.instructions !== undefined ? { instructions: event.instructions } : {}),
      };
    case "device_code":
      return {
        type: "device-code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    case "info":
      return { type: "info", message: event.message, ...(event.links !== undefined ? { links: event.links } : {}) };
    default:
      return { type: "progress", message: event.message };
  }
}

/**
 * Presents a consumer's LoginInteraction to pi. pi calls us, so this maps
 * inward: pi's snake_case names become nax-ai's kebab-case ones.
 */
function toPiInteraction(interaction: LoginInteraction): {
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
} {
  return {
    prompt: async (prompt) => interaction.prompt(fromPiPrompt(prompt)),
    notify: (event) => {
      interaction.notify(fromPiEvent(event));
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/pi-auth.ts test/auth/pi-auth-login.test.ts
git commit -m "feat(auth): translate pi's login interaction at the boundary"
```

---

### Task 5: `login()` — one method, stored through `modify`

**Files:**
- Create: `src/auth/login.ts`
- Test: `test/auth/login.test.ts`

**Interfaces:**
- Consumes: `resolveLoginTarget`, `LoginTarget`, `LoginRunner` (Task 3); `LoginOptions`, `LoginResult`, `LoginMethod` (Task 2); `AuthMethodUnavailableError` (Task 2); `createMemoryCredentialStore` from `src/credentials/memory-store.ts` in tests.
- Produces: `export async function login(options: LoginOptions): Promise<LoginResult>` and `export const _resolveTarget = { resolve: resolveLoginTarget }` — the seam later tasks and tests replace.

- [ ] **Step 1: Write the failing test**

Create `test/auth/login.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resolveTarget, login } from "../../src/auth/login.ts";
import type { LoginTarget } from "../../src/auth/pi-auth.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import type { LoginInteraction } from "../../src/auth/login-types.ts";

const real = _resolveTarget.resolve;
afterEach(() => {
  _resolveTarget.resolve = real;
});

function withTarget(target: LoginTarget): void {
  _resolveTarget.resolve = async () => target;
}

/** Fails the test if the flow tries to interact; individual tests override it. */
const silent: LoginInteraction = {
  prompt: async () => {
    throw new Error("no prompt expected");
  },
  notify: () => {},
};

describe("login", () => {
  it("runs the only available method and stores the credential", async () => {
    withTarget({
      apiKey: { label: "Acme API key", run: async () => ({ kind: "api-key", key: "sk-live" }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result).toEqual({ providerId: "acme", method: "api-key", kind: "api-key" });
    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-live" });
  });

  it("runs the only available method when it is oauth", async () => {
    withTarget({
      oauth: { label: "Acme OAuth", run: async () => ({ kind: "oauth", access: "a", refresh: "r", expires: 9 }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result.method).toBe("oauth");
    expect(result.kind).toBe("oauth");
    expect(await credentials.read("acme")).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 9 });
  });

  it("writes through modify, so the store's lock covers the write", async () => {
    // A bare write would bypass the cross-process lock that makes concurrent
    // logins and OAuth refreshes safe.
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk" }) } });
    const credentials = createMemoryCredentialStore();
    const modify = vi.spyOn(credentials, "modify");

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(modify).toHaveBeenCalledWith("acme", expect.any(Function));
  });

  it("overwrites an existing credential for the provider", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-new" }) } });
    const credentials = createMemoryCredentialStore({ acme: { kind: "api-key", key: "sk-old" } });

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-new" });
  });

  it("does not return the credential", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-secret" }) } });

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent });

    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("rejects a provider with no usable method", async () => {
    withTarget({});
    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });
});
```

Add `import { AuthMethodUnavailableError } from "../../src/auth/login-errors.ts";` to the imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/login.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/login.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth/login.ts`:

```ts
/**
 * Obtaining a credential, as opposed to holding or using one.
 *
 * This module never imports pi-ai: every provider-specific step is behind a
 * LoginRunner that pi-auth.ts resolved. The credential is written to the
 * caller's store before this returns, and never handed back.
 */

import type { StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError } from "./login-errors.ts";
import type { LoginMethod, LoginOptions, LoginResult } from "./login-types.ts";
import { type LoginRunner, resolveLoginTarget } from "./pi-auth.ts";

/** Test seam. */
export const _resolveTarget = { resolve: resolveLoginTarget };

export async function login(options: LoginOptions): Promise<LoginResult> {
  const { providerId, credentials, interaction, signal } = options;
  const target = await _resolveTarget.resolve(providerId);

  const available: { method: LoginMethod; runner: LoginRunner }[] = [];
  if (target.apiKey !== undefined) available.push({ method: "api-key", runner: target.apiKey });
  if (target.oauth !== undefined) available.push({ method: "oauth", runner: target.oauth });

  const chosen = available[0];
  if (chosen === undefined) throw new AuthMethodUnavailableError(providerId);

  const credential: StoredCredential = await chosen.runner.run(interaction, signal ?? new AbortController().signal);

  // modify, never a bare write: it is what holds the store's lock across the
  // whole read-modify-write.
  await credentials.modify(providerId, async () => credential);

  return { providerId, method: chosen.method, kind: credential.kind };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun x vitest --run test/auth/login.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login.ts test/auth/login.test.ts
git commit -m "feat(auth): login() runs a provider's single method and stores the result"
```

---

### Task 6: Method selection when a provider offers both

**Files:**
- Modify: `src/auth/login.ts`
- Test: `test/auth/login.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: no new exports. `login()` now honours `options.method` and prompts a `select` when two methods are available.

- [ ] **Step 1: Write the failing test**

Append to `test/auth/login.test.ts`:

```ts
describe("login method selection", () => {
  // Declared as standalone runners rather than plucked back off a LoginTarget:
  // reading an optional property out gives `LoginRunner | undefined`, which
  // will not assign to an optional property under exactOptionalPropertyTypes
  // (TS2375).
  const apiKeyRunner: LoginRunner = {
    label: "Acme API key",
    run: async () => ({ kind: "api-key", key: "sk" }),
  };
  const oauthRunner: LoginRunner = {
    label: "Sign in with Acme",
    run: async () => ({ kind: "oauth", access: "a", refresh: "r", expires: 1 }),
  };
  const both: LoginTarget = { apiKey: apiKeyRunner, oauth: oauthRunner };

  it("prompts for the method when both are available, labelled from the runners", async () => {
    withTarget(both);
    const prompts: LoginPrompt[] = [];
    const interaction: LoginInteraction = {
      prompt: async (prompt) => {
        prompts.push(prompt);
        return "oauth";
      },
      notify: () => {},
    };

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction });

    expect(prompts[0]).toEqual({
      type: "select",
      message: expect.stringContaining("acme"),
      options: [
        { id: "api-key", label: "Acme API key" },
        { id: "oauth", label: "Sign in with Acme" },
      ],
    });
    expect(result.method).toBe("oauth");
  });

  it("runs the method the user selected", async () => {
    withTarget(both);
    const interaction: LoginInteraction = { prompt: async () => "api-key", notify: () => {} };

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction });

    expect(result.method).toBe("api-key");
  });

  it("does not prompt when the caller named a method", async () => {
    withTarget(both);

    const result = await login({
      providerId: "acme",
      credentials: createMemoryCredentialStore(),
      interaction: silent, // throws if prompted
      method: "oauth",
    });

    expect(result.method).toBe("oauth");
  });

  it("rejects a named method the provider does not offer", async () => {
    withTarget({ apiKey: apiKeyRunner });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent, method: "oauth" }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });

  it("reports which method was unavailable", async () => {
    withTarget({ apiKey: apiKeyRunner });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent, method: "oauth" }),
    ).rejects.toMatchObject({ requested: "oauth" });
  });

  it("rejects an unrecognised selection rather than defaulting", async () => {
    // Silently falling back to the first method would bill a call against a
    // credential path the user did not choose.
    withTarget(both);
    const interaction: LoginInteraction = { prompt: async () => "neither", notify: () => {} };

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });
});
```

Add `LoginPrompt` to the type imports from `../../src/auth/login-types.ts`, and
`LoginRunner`, `LoginTarget` to those from `../../src/auth/pi-auth.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/login.test.ts -t "login method selection"`
Expected: FAIL — `login()` currently takes `available[0]` unconditionally, so the select prompt is never issued and `method` is ignored.

- [ ] **Step 3: Write minimal implementation**

In `src/auth/login.ts`, replace these three lines from Task 5 —

```ts
  const chosen = available[0];
  if (chosen === undefined) throw new AuthMethodUnavailableError(providerId);

  const credential: StoredCredential = await chosen.runner.run(interaction, signal ?? new AbortController().signal);
```

— with:

```ts
  if (available.length === 0) throw new AuthMethodUnavailableError(providerId);

  const chosen = await select(available, options);

  const credential: StoredCredential = await chosen.runner.run(interaction, signal ?? new AbortController().signal);
```

And add above `login()`:

```ts
type Choice = { method: LoginMethod; runner: LoginRunner };

async function select(available: readonly Choice[], options: LoginOptions): Promise<Choice> {
  const { providerId, method, interaction } = options;

  if (method !== undefined) {
    const named = available.find((choice) => choice.method === method);
    if (named === undefined) throw new AuthMethodUnavailableError(providerId, method);
    return named;
  }

  const only = available.length === 1 ? available[0] : undefined;
  if (only !== undefined) return only;

  const answer = await interaction.prompt({
    type: "select",
    message: `How do you want to sign in to "${providerId}"?`,
    options: available.map((choice) => ({ id: choice.method, label: choice.runner.label })),
  });

  const picked = available.find((choice) => choice.method === answer);
  // An unrecognised answer is not a reason to guess: falling back to the first
  // method would bill against a credential path the user did not choose.
  if (picked === undefined) throw new AuthMethodUnavailableError(providerId);
  return picked;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test && bun run typecheck`
Expected: PASS, including every test from Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login.ts test/auth/login.test.ts
git commit -m "feat(auth): choose between a provider's two login methods"
```

---

### Task 7: Failure paths — empty key, cancellation, prohibited flow

**Files:**
- Modify: `src/auth/login.ts`
- Test: `test/auth/login.test.ts` (append)

**Interfaces:**
- Consumes: `LoginCancelledError`, `LoginFailedError` (Task 2); `OAuthFlowProhibitedError` from `./oauth-policy.ts`.
- Produces: no new exports.

**Why the empty-key check lives here:** `fromPi` maps `key: credential.key ?? ""` (`src/auth/pi-auth.ts:34`). That is right for a *read* — an absent key means "not configured". On the login path it would store a credential that looks present and fails much later at call time, in a place with no visible connection to the login that caused it. The repo rule is explicit: never substitute `""`.

- [ ] **Step 1: Write the failing test**

Append to `test/auth/login.test.ts`:

```ts
describe("login failure paths", () => {
  it("rejects an empty api-key rather than storing it", async () => {
    // fromPi maps a missing key to "". Storing that yields a credential that
    // looks present and fails at call time, far from its cause.
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "" }) } });
    const credentials = createMemoryCredentialStore();

    await expect(login({ providerId: "acme", credentials, interaction: silent })).rejects.toThrow(LoginFailedError);
    expect(await credentials.read("acme")).toBeUndefined();
  });

  it("stores nothing when the flow throws", async () => {
    withTarget({
      apiKey: {
        label: "Acme",
        run: async () => {
          throw new Error("upstream said no");
        },
      },
    });
    const credentials = createMemoryCredentialStore();

    await expect(login({ providerId: "acme", credentials, interaction: silent })).rejects.toThrow("upstream said no");
    expect(await credentials.read("acme")).toBeUndefined();
  });

  it("reports a rejected prompt as cancellation, not failure", async () => {
    withTarget({
      apiKey: {
        label: "Acme",
        run: async (interaction) => {
          await interaction.prompt({ type: "secret", message: "API key" });
          return { kind: "api-key", key: "unreachable" };
        },
      },
    });
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    const interaction: LoginInteraction = {
      prompt: async () => {
        throw abort;
      },
      notify: () => {},
    };

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction }),
    ).rejects.toThrow(LoginCancelledError);
  });

  it("reports an aborted signal as cancellation", async () => {
    const controller = new AbortController();
    withTarget({
      apiKey: {
        label: "Acme",
        run: async () => {
          controller.abort();
          throw new Error("stream closed");
        },
      },
    });

    await expect(
      login({
        providerId: "acme",
        credentials: createMemoryCredentialStore(),
        interaction: silent,
        signal: controller.signal,
      }),
    ).rejects.toThrow(LoginCancelledError);
  });

  it("lets a policy refusal through as itself", async () => {
    // A prohibited flow must not be reported as a generic login failure: the
    // reason is the whole point of the error.
    withTarget({
      oauth: {
        label: "Acme OAuth",
        run: async () => {
          throw new OAuthFlowProhibitedError("acme", "not cleared");
        },
      },
    });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent }),
    ).rejects.toThrow(OAuthFlowProhibitedError);
  });
});
```

Add to the imports: `LoginCancelledError, LoginFailedError` from `../../src/auth/login-errors.ts` and `OAuthFlowProhibitedError` from `../../src/auth/oauth-policy.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/login.test.ts -t "login failure paths"`
Expected: FAIL — the empty key is stored, and the abort surfaces as the raw `AbortError` rather than `LoginCancelledError`.

- [ ] **Step 3: Write minimal implementation**

In `src/auth/login.ts`, add the imports and two helpers, then wrap the run:

```ts
import type { ProviderId } from "../types.ts";
import { AuthMethodUnavailableError, LoginCancelledError, LoginFailedError } from "./login-errors.ts";
import { OAuthFlowProhibitedError } from "./oauth-policy.ts";
```

(`StoredCredential` is already imported from `../types.ts` by Task 5 — add `ProviderId` to
that same `import type` line rather than writing a second one.)

```ts
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * A credential whose key is empty is not a credential. The store would accept
 * it and every later call would fail with an auth error pointing nowhere near
 * this login.
 */
function assertUsable(credential: StoredCredential, providerId: ProviderId): void {
  if (credential.kind === "api-key" && credential.key.length === 0) {
    throw new LoginFailedError(providerId, "the flow returned an empty API key");
  }
}
```

Replace the single `const credential = await chosen.runner.run(...)` line with:

```ts
  const abort = signal ?? new AbortController().signal;

  let credential: StoredCredential;
  try {
    credential = await chosen.runner.run(interaction, abort);
  } catch (error) {
    // A policy refusal keeps its own identity: its recorded reason is the
    // point, and a generic failure would discard it.
    if (error instanceof OAuthFlowProhibitedError) throw error;
    if (isCancellation(error, abort)) throw new LoginCancelledError(providerId);
    throw error;
  }

  assertUsable(credential, providerId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login.ts test/auth/login.test.ts
git commit -m "feat(auth): reject unusable credentials and report cancellation as itself"
```

---

### Task 8: Public exports and README

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/index.test.ts` (create if absent)

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: the package's public login surface.

- [ ] **Step 1: Write the failing test**

Create or append to `test/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as naxAi from "../src/index.ts";

describe("public surface", () => {
  it("exports login and its errors", () => {
    expect(typeof naxAi.login).toBe("function");
    expect(typeof naxAi.AuthMethodUnavailableError).toBe("function");
    expect(typeof naxAi.LoginCancelledError).toBe("function");
    expect(typeof naxAi.LoginFailedError).toBe("function");
  });

  it("does not export the test seams", () => {
    // A seam on the public surface becomes something consumers depend on.
    expect(naxAi).not.toHaveProperty("_loginDeps");
    expect(naxAi).not.toHaveProperty("_resolveTarget");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/index.test.ts`
Expected: FAIL — `naxAi.login` is undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/index.ts`, keeping the file's existing alphabetical-by-path ordering:

```ts
export { login } from "./auth/login.ts";
export { AuthMethodUnavailableError, LoginCancelledError, LoginFailedError } from "./auth/login-errors.ts";
export type {
  LoginEvent,
  LoginInteraction,
  LoginLink,
  LoginMethod,
  LoginOption,
  LoginOptions,
  LoginPrompt,
  LoginResult,
} from "./auth/login-types.ts";
```

Add a section to `README.md` after the credentials material:

````markdown
### Logging in

`login()` obtains a credential and writes it to the store you pass. It covers
both api-key entry and OAuth, choosing between them when a provider offers
both, and returns metadata rather than the credential — the store already has
it.

```ts
import { createFileCredentialStore, login } from "@nathapp/nax-ai";

const credentials = createFileCredentialStore({ path: `${homedir()}/.nax/credentials` });

const result = await login({
  providerId: "openrouter",
  credentials,
  interaction: {
    prompt: async (prompt) => ask(prompt.message),  // your UI
    notify: (event) => render(event),
  },
});
// result: { providerId: "openrouter", method: "oauth", kind: "oauth" }
```

Permitted OAuth flows are `openai-codex` and `openrouter`; see
`PERMITTED_OAUTH_FLOWS`. A provider outside that list keeps its api-key login.

There is no `logout`: removing a credential is `credentials.delete(providerId)`.
Note that nothing is revoked upstream — the provider-side token stays valid
until it expires, so a UI should say the credential was removed locally rather
than that the user was logged out.
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test && bun run typecheck && bun run lint && bun run build`
Expected: PASS, and the build emits declarations without error.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md test/index.test.ts
git commit -m "feat(auth): export login on the public surface"
```

---

### Task 9: Live verification against `openrouter`

**Files:**
- Modify: `ROADMAP.md` (record the result)

**Interfaces:**
- Consumes: the whole public surface from Task 8.
- Produces: evidence, and a recorded result. No source changes.

**Why manual:** the real flows open a browser and run a loopback HTTP callback server, so they are not fixture-recordable the way `test/protocols/` is. `openrouter` is the permitted flow that is not a consumer subscription, and the one whose OAuth the catalog projection hides — so it exercises the trap this design was built around. This mirrors how M2 recorded its `DEEPSEEK_API_KEY` probe.

- [ ] **Step 1: Write the probe script**

Create `scripts/probe-login.ts` (a throwaway, not committed — it is listed in step 5 as deleted):

```ts
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFileCredentialStore, login } from "../src/index.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const result = await login({
  providerId: process.argv[2] ?? "openrouter",
  credentials: createFileCredentialStore({ path: join(homedir(), ".nax-ai-probe-credentials") }),
  interaction: {
    prompt: async (prompt) => rl.question(`${prompt.message} `),
    notify: (event) => console.log("[event]", JSON.stringify(event)),
  },
});

console.log("result:", result);
rl.close();
```

- [ ] **Step 2: Run it against openrouter**

Run: `bun run scripts/probe-login.ts openrouter`
Expected: an `auth-url` event, a browser opens, and after authorising, `result: { providerId: "openrouter", method: "oauth", kind: "api-key" }` — OpenRouter's PKCE flow exchanges the code for a permanent API key rather than a token pair, so `method` and `kind` legitimately differ. **If `kind` is `oauth` instead, record what you actually saw** rather than adjusting the expectation.

- [ ] **Step 3: Verify the credential landed**

Run: `ls -l ~/.nax-ai-probe-credentials && head -c 40 ~/.nax-ai-probe-credentials`
Expected: file mode `0600`, and valid JSON. Do not paste the key into the commit, the ROADMAP, or any log.

- [ ] **Step 4: Verify the negative case**

Run: `bun run scripts/probe-login.ts github-copilot`
Expected: a prompt for an API key — **not** an OAuth browser flow. That is Task 1's allowlist removal working end to end.

- [ ] **Step 5: Record the result and clean up**

```bash
rm scripts/probe-login.ts ~/.nax-ai-probe-credentials
```

In `ROADMAP.md`, change the M5 heading from `📋` to `✅`, and add a line recording what was proven live, the date, and the `method`/`kind` pair actually observed. Then:

```bash
git add ROADMAP.md
git commit -m "docs: record the M5 live login verification"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: scope and the no-logout/no-listing rulings → Task 8's README; the dispatch trap → Task 3; the per-method gate → Tasks 1 and 3; the public surface → Tasks 2, 5, 6, 8; storage and the `fromPi` empty-key correction → Tasks 5 and 7; the error table → Tasks 2 and 7; module layout and gates → Tasks 3, 4, 8; testing → every task, with the live check in Task 9. The spec's three open questions need no task: (1) is a release decision, (2) is settled as "free function" and implemented that way, (3) is Task 9's `dist` concern, which belongs to the consumer's plan and is recorded there.

**Placeholder scan.** No TBDs; every code step carries real code; no "similar to Task N".

**Type consistency.** `LoginRunner.label` is used under that name in Tasks 3, 5 and 6. `resolveLoginTarget` returns `LoginTarget` with optional `apiKey`/`oauth` throughout. `LoginResult` is `{providerId, method, kind}` in Tasks 2, 5, 6 and 9. `AuthMethodUnavailableError(providerId, requested?)` is constructed with one argument in Tasks 3 and 5, two in Task 6, matching Task 2's signature. `_loginDeps.providers` (Task 3) and `_resolveTarget.resolve` (Task 5) are distinct seams at distinct layers, and Task 8 asserts neither is exported.

**One ordering note for the executor:** Task 3 introduces a deliberately throwing `toPiInteraction` stub that Task 4 replaces. Task 3's tests pass with the stub in place because none of them reach a runner's `run()`. Task 4's first test is the one that proves the stub is gone. Do not skip Task 4.

## Final review before handover

The plan's riskiest code was compiled against this repo's real `tsconfig.json`
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`) rather than reasoned about. Six corrections came out of it:

1. **`fromPiPrompt`'s `default:` branch returns a union-typed discriminant** (`type:
   prompt.type` is `"text" | "secret"`). Assigning that to a discriminated union is a
   common TS failure — **it compiles here.** Verified, not assumed; left as written.
2. **Task 6's test plucked `both.apiKey` back off a `LoginTarget`** and assigned it to an
   optional property — `LoginRunner | undefined` into `LoginRunner`, **TS2375** under
   `exactOptionalPropertyTypes`. Rewritten to standalone runner constants.
3. **Task 4's import instruction produced `import type { A, type B }`** — **TS2206** under
   `verbatimModuleSyntax`, because Task 3 makes that statement an `import type`. Both the
   source and test instructions now say bare names, with the error named.
4. **Task 3's stub returned `{ prompt: never; notify: never }`.** That compiles, but it is
   assignable rather than signature-compatible, so a wrong Task 4 replacement would still
   typecheck. The stub now carries Task 4's real return signature, which moves the two pi
   type imports into Task 3.
5. **Task 6's edit site said "the two lines around it".** Replaced with the exact three
   lines from Task 5 to delete, quoted.
6. **`assertUsable` took `providerId: string`** where the rest of the codebase uses
   `ProviderId`. Fixed, with a note to extend Task 5's existing `import type` rather than
   add a second.

Two things confirmed rather than changed: `createMemoryCredentialStore()` defaults its seed
to `{}`, so the no-argument calls in Tasks 5–7 work; and `available[0]` is correctly typed
`Choice | undefined` in Task 5 because `noUncheckedIndexedAccess` is on, so that
`=== undefined` guard is load-bearing rather than dead.
