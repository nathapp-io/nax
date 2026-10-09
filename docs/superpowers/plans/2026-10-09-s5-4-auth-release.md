# S5-4 Auth, README and 0.4.0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** finish S5 v1:
- `nax-agent login <provider>` on the terminal;
- terminal `authMethods` for editors;
- `authenticate`, a credential check before any billed call, and `auth_required` for missing or rejected credentials;
- a README for Zed and acpx;
- the live checks;
- the 0.4.0 release of `@nathapp/nax-agent` and `@nathapp/nax-agent-acp`, with nax-ai 0.1.17 before them.

**Architecture:**
- **Shared terminal login UI.** The terminal login UI moves from the nax CLI into `@nathapp/nax-agent` as `createTerminalAuthInteraction` (user ruling 2026-10-09). `nax auth login` and `nax-agent login` then share one implementation of hidden secret entry, the arrow-key picker and the browser handoff.
- **Server auth module.** The ACP server gets one auth module (`src/server/auth.ts`). It advertises one terminal login method per configured provider and answers `authenticate`. It also checks the session model's provider before every open, so `session/new` fails `auth_required` before a billed call.
- **Turn failures.** A turn that fails on credentials maps to `auth_required` (`src/server/errors.ts`).
- **Release.** After the PR merges, the release runs in order: nax-ai, the live checks, then both agent packages.

**Tech Stack:** TypeScript ESM, `bun:test`, `@agentclientprotocol/sdk` 1.7.0 (`AuthMethod` terminal type, `authenticate`, `RequestError.authRequired`), `@nathapp/nax-agent` auth API (`runLogin`, `providersWithoutCredentials`), `node:child_process` (browser opener), Node >= 22.19 for the published bin.

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` §6.1, §6.3, §7, §8 (live checks), §9 (S5-4 row and version). Task 6 amends §6.1 and §6.3. **Master plan:** `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md`. **Builds on:** S5-3, merged #2409 (`02d5d3b52`).

## Handover (for the executing session)

- **Branch:** `feat/s5-4-auth-release`, off main `02d5d3b52`. This plan is the first commit on it.
- **Order:**
  - Tasks 1-2 are nax-agent then nax (the UI move). Task 2 depends on Task 1's exports.
  - Tasks 3-6 are nax-agent-acp.
  - Tasks 1-6 make one PR. Code review before push.
  - Tasks 7-9 run after that PR merges, on main. Each needs maintainer approval **at launch**.
- **Working agreements:**
  - Never launch `nax run` or `nax plan`.
  - At most two fix rounds per review.
  - Never release nax itself (Task 7 only bumps its nax-ai pin).
  - Billed runs and every tag push need approval at the moment of launch.

## Global Constraints

- Package commands run from the package directory. Never run bare `bun test` with no path. Scope it: `timeout 120 bun test <path> --timeout=60000`.
  - nax-agent and nax-agent-acp: `bun run typecheck`, `bun run check:all`, `bun test ./test/unit/ --timeout=60000`, `bun run test:coverage`.
  - nax: `bun run typecheck`, `bun run lint`, `timeout 600 bun test test/unit/cli/ --timeout=60000`.
- Source files <= 600 lines, test files <= 800 lines. Per-file unit coverage >= 80% in nax-agent and nax-agent-acp (`--require-all-files`).
- Cognitive complexity <= 20 per function in nax-agent (`check-complexity`, ratchet; new files have no baseline). The moved prompt code is restructured in Task 1 for this; never add a baseline entry.
- No `throw new Error(` in `src/`. Use `NaxError`, or SDK `RequestError` at the protocol edge.
- No Bun APIs in nax-agent or nax-agent-acp `src/` (`check:no-bun-apis`). The browser opener uses `node:child_process`.
- A spawn in nax-agent `src/` carries the marker comment `// nax-git-env-allow: not git: browser opener argv` on the line above it (`check-git-spawn-env`).
- No `as unknown as`, no `@ts-` suppressions and no fixed sleeps in tests. Wait with `waitForCondition` from `@nathapp/nax-test-kit/bun/timeout`.
- nax-agent-acp reaches nax-agent only through `@nathapp/nax-agent`; nax may also use `@nathapp/nax-agent/internal` in tests. Inside a package, import with `#src/` and `#test/` (nax: `@/` and `@test/`).
- Test files are named after their module.
- `bun run lint:fix` (nax: `bun x biome check --write <files>`) before each commit.
- API snapshots: `bun run api:update` in nax-agent and nax-agent-acp whenever an export changes; commit the `.api.txt` diff.

Exact values from the spec and the SDK:
- **Terminal auth method:** `{ id: "login-<provider>", name: "Log in to <provider>", type: "terminal", args: ["login", "<provider>"] }`. Advertised only when `initialize` carries `clientCapabilities.auth.terminal === true`.
- **SDK 1.7.0 rule:** a client runs a terminal method by re-running the configured agent command with `args` appended, so `nax-agent acp --model x` becomes `nax-agent acp --model x login anthropic`. Exit 0 means success. The client MUST NOT pass a terminal method to `authenticate`.
- **`auth_required`:** JSON-RPC code `-32000`, through `RequestError.authRequired(data, message)`.
- **Binary:** `nax-agent login <provider>` runs an interactive login and writes to the `~/.nax` credential store (same store as `nax auth login`).
- **Version:** both agent packages go 0.3.1 -> 0.4.0, nax-agent first. nax-ai goes 0.1.16 -> 0.1.17 before them (S5-3 M-20).

## Review Focus

- **The editor appends `login <provider>` to its configured command.** Zed's command may be `nax-agent acp --model x`. The login must still run and must not be refused as an unknown command, and server-only flags are ignored. Task 3 tests `["acp", "--model", "x", "login", "anthropic"]`.
- **No browser opener on the machine** (Linux over SSH, a container). Node's `spawn` reports a missing `xdg-open` as an asynchronous `error` event. Unhandled, it kills the login after the URL is already on screen. Task 1 tests a real spawn of a missing command.
- **A credential supplied only by an environment variable** (`ANTHROPIC_API_KEY`, nothing stored). It must pass the open check and `authenticate`, because a turn would work with it. Task 4 tests a provider that `providersWithoutCredentials` reports as present.
- **A catalog-override provider** (a custom endpoint whose key is in its headers). It is never blocked by the open check and never offered as a login method. Task 4 tests both.
- **Ctrl+C, or a non-interactive stdin, during `nax-agent login`.** Cancel exits 130 with nothing on stderr. A non-TTY stdin exits 1 at once with a message, and never waits for input. Task 3 tests both.

## Decisions taken while planning

| # | Decision | Why |
|---|---|---|
| M-28 | The terminal login UI moves from `packages/nax/src/cli/{auth-prompt,open-url}.ts` and `terminalInteraction()` into `@nathapp/nax-agent` (`src/terminal-auth/`). It is exported as `createTerminalAuthInteraction({ log, style?, openUrl? })` plus `PromptCancelledError`, `TerminalStyle` and `PLAIN_STYLE`; the prompt seams are exported from `/internal`. nax passes chalk styles; behaviour is unchanged. | User ruling 2026-10-09: one implementation of the raw-mode, no-echo and Ctrl+D handling. nax-agent-acp cannot depend on nax (spec R5). |
| M-29 | `authenticate` and the open check count a provider as authenticated when a credential is stored OR ambient (`providersWithoutCredentials`), not stored only (spec §6.3 said `listStoredProviders`). | A turn uses an environment key. Refusing it would block a working setup. |
| M-30 | Every open (new, load, resume, and the reopen behind a mode or model switch) first checks the session model's provider. It is skipped for catalog-override providers and for ids without a `provider/` prefix. A missing credential gives `auth_required` naming `nax-agent login <provider>`. | Editors (Zed) offer the advertised login when `session/new` fails `auth_required`, and nothing is billed. |
| M-31 | `authenticate` is served even though SDK 1.7.0 says clients must not send terminal methods to it. It is lenient: a known id is checked as M-29; an unknown id gives `invalid_params` listing the advertised ids. | Older clients send it, and the cost is one function. |
| M-32 | Codes treated as credential failures: `fail-auth` (nax-agent's adapter outcome for HTTP 401/403 and for credential-store faults) and the `NaxError` codes `CREDENTIAL_HELPER_FAILED`, `CREDENTIAL_HELPER_INVALID`, `CREDENTIAL_CHANGED`, `CREDENTIAL_FILE_UNREADABLE`, `CREDENTIALS_NOT_CONFIGURED`. An `errored` turn with one of them answers `session/prompt` with `auth_required` instead of `internal_error`. | `turn_end.error.code` is the adapter outcome (`errorOf` in `agent-session-turn.ts`); `toAdapterFailure` folds credential-store faults into `fail-auth`. |
| M-33 | Login methods come from: the tier models, plus the default model, minus catalog-override providers. They are intersected with the new nax-agent export `loginProviderIds()` (nax-ai's default catalog), deduplicated in order of appearance, and computed once at startup. A failure to list gives no methods plus one warning. | Only providers that `runLogin` can serve are offered. |
| M-34 | `login` accepts `--method api-key\|oauth` (forwarded, as with `nax auth login --method`) and `--config-dir`. Other server flags are accepted and ignored with `login`; a leading `acp` is accepted. `--method` without `login` is a usage error. | The editor reuses the server invocation (Review Focus 1). |
| M-35 | Release order: nax-ai 0.1.17, with the nax and nax-agent pins bumped in the same PR (`check:nax-ai-pin`), then the live acpx smoke on packed tarballs, then the Zed walkthrough, then nax-agent and nax-agent-acp 0.4.0. nax is not released. | nax-agent 0.4.0 needs nax-ai's `origin` field (S5-3). The pin gate requires that one PR moves version and pins together. |

## File Structure

```
packages/nax-agent/
  src/terminal-auth/prompt.ts        NEW  raw-mode prompts (moved from nax, restructured, chalk -> TerminalStyle)
  src/terminal-auth/open-url.ts      NEW  browser opener (moved from nax, Bun.spawn -> node spawn)
  src/terminal-auth/interaction.ts   NEW  createTerminalAuthInteraction (moved from nax terminalInteraction)
  src/terminal-auth/index.ts         NEW  barrel
  src/native/auth.ts                 + loginProviderIds
  src/native/index.ts, src/index.ts, src/internal.ts   exports
  test/unit/terminal-auth/{prompt,open-url,interaction}.test.ts   NEW (prompt/open-url moved from nax)
  test/unit/native/auth-login.test.ts  + loginProviderIds
packages/nax/
  src/cli/auth.ts                    uses createTerminalAuthInteraction
  src/cli/auth-prompt.ts, src/cli/open-url.ts                DELETED
  src/cli/index.ts                   drops the auth-prompt re-export
  scripts/baselines/complexity-baseline.json                 drops src/cli/auth-prompt.ts
  test/unit/cli/auth-prompt.test.ts, open-url.test.ts        DELETED (moved)
  test/unit/cli/auth.test.ts         seams from @nathapp/nax-agent/internal
packages/nax-agent-acp/
  src/server/cli.ts                  + login command
  src/server/login.ts                NEW  runLoginCommand
  src/server/auth.ts                 NEW  AuthPorts, terminal methods, authenticate, open check
  src/server/errors.ts               + isAuthFailureCode, loginHint, authRequired; toRequestError maps credential codes
  src/server/translate/stop.ts       errored credential turn -> auth_required
  src/server/client-port.ts          + terminalAuth feature
  src/server/capabilities.ts         initializeResponse(version, authMethods)
  src/server/connection.ts           authMethods on initialize, authenticate handler
  src/server/open-session.ts         + ensureCredentials
  src/server/main.ts, process-entry.ts   login dispatch, auth wiring, isTTY
  README.md                          ACP server section
```

---

### Task 1: nax-agent terminal login UI and `loginProviderIds`

**Files:**
- Create: `packages/nax-agent/src/terminal-auth/prompt.ts`, `open-url.ts`, `interaction.ts`, `index.ts`
- Move (git mv, then rewrite as below): `packages/nax/test/unit/cli/auth-prompt.test.ts` -> `packages/nax-agent/test/unit/terminal-auth/prompt.test.ts`, `packages/nax/test/unit/cli/open-url.test.ts` -> `packages/nax-agent/test/unit/terminal-auth/open-url.test.ts`
- Create: `packages/nax-agent/test/unit/terminal-auth/interaction.test.ts`
- Modify: `packages/nax-agent/src/native/auth.ts`, `src/native/index.ts`, `src/index.ts`, `src/internal.ts`, `test/unit/native/auth-login.test.ts`, `api/nax-agent.api.txt`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `AuthInteraction`, `AuthPrompt`, `AuthEvent` from `#src/native/auth-types`.
- Produces (public `@nathapp/nax-agent`):
  - `createTerminalAuthInteraction(options: TerminalAuthOptions): AuthInteraction`
  - `interface TerminalAuthOptions { readonly log: (text: string) => void; readonly style?: TerminalStyle; readonly openUrl?: (url: string) => void }`
  - `interface TerminalStyle { accent(text: string): string; dim(text: string): string; bold(text: string): string }`, `PLAIN_STYLE: TerminalStyle`
  - `class PromptCancelledError extends Error` (name `"PromptCancelledError"`)
  - `loginProviderIds(): Promise<string[]>`
- Produces (`@nathapp/nax-agent/internal`): `_terminalPromptDeps: { stdin: PromptStdin; write(text: string): boolean }`, `PromptStdin`, `promptForSecret`, `promptForLine`, `promptForSelect`, `_openUrlDeps: { spawn(command: readonly string[]): void; platform(): string }`, `openUrl`, `spawnDetached`.

- [ ] **Step 1: Move the two test files and rewrite their imports**

```bash
cd packages
mkdir -p nax-agent/test/unit/terminal-auth
git mv nax/test/unit/cli/auth-prompt.test.ts nax-agent/test/unit/terminal-auth/prompt.test.ts
git mv nax/test/unit/cli/open-url.test.ts nax-agent/test/unit/terminal-auth/open-url.test.ts
```

In `prompt.test.ts`:
- Replace the import block with:

```ts
import {
  _terminalPromptDeps,
  PromptCancelledError,
  type PromptStdin,
  promptForLine,
  promptForSecret,
  promptForSelect,
} from "#src/terminal-auth/prompt";
```

- Rename every `_authPromptDeps` to `_terminalPromptDeps`.
- Every `promptForLine(message, hook)` call keeps that shape: the signature below keeps `onEmptySubmit` as the second parameter.

Then append:

```ts
describe("style", () => {
  test("the accent wraps the question mark and the active row", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const style = { accent: (t: string) => `<${t}>`, dim: (t: string) => t, bold: (t: string) => t };
    const pending = promptForSelect("Pick:", [{ id: "a", label: "A" }], style);
    h.emit("data", CR);
    expect(await pending).toBe("a");
    expect(written.join("")).toContain("<?> Pick:");
    expect(written.join("")).toContain("<>> <A>");
  });

  test("without a style nothing is decorated", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const pending = promptForSecret("Key:");
    h.emit("data", `k${CR}`);
    expect(await pending).toBe("k");
    expect(written.join("")).toContain("? Key: ");
  });
});
```

In `open-url.test.ts`:
- Change the import to `import { _openUrlDeps, openUrl, spawnDetached } from "#src/terminal-auth/open-url";`.
- Add `import { once } from "node:events";`.
- Append:

```ts
describe("spawnDetached", () => {
  test("a missing opener reports asynchronously and never throws (Review Focus 2)", async () => {
    const child = spawnDetached(["nax-agent-no-such-opener-7f3a", "https://example.test/a"]);
    const [error] = await once(child, "error");
    expect(error).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Write the failing interaction test**

`packages/nax-agent/test/unit/terminal-auth/interaction.test.ts`. The harness copies `makeStdin` from `prompt.test.ts`, which is the same fake stdin the nax tests use:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTerminalAuthInteraction } from "#src/terminal-auth/interaction";
import { _terminalPromptDeps, type PromptStdin } from "#src/terminal-auth/prompt";

const CR = "\r";

function makeStdin() {
  const listeners = new Map<string, ((chunk: string) => void)[]>();
  const stdin: PromptStdin = {
    isTTY: true,
    setRawMode: () => undefined,
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
    emit: (event: string, chunk = "") => {
      for (const l of [...(listeners.get(event) ?? [])]) l(chunk);
    },
  };
}

let written: string[];
let logged: string[];
const realStdin = _terminalPromptDeps.stdin;
const realWrite = _terminalPromptDeps.write;

beforeEach(() => {
  written = [];
  logged = [];
  _terminalPromptDeps.write = (text: string) => {
    written.push(text);
    return true;
  };
});

afterEach(() => {
  _terminalPromptDeps.stdin = realStdin;
  _terminalPromptDeps.write = realWrite;
});

function interaction(opened: string[] = []) {
  return createTerminalAuthInteraction({ log: (t) => logged.push(t), openUrl: (u) => opened.push(u) });
}

describe("createTerminalAuthInteraction", () => {
  test("a secret prompt never echoes", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const pending = interaction().prompt({ type: "secret", message: "API key:" });
    h.emit("data", `sk-9${CR}`);
    expect(await pending).toBe("sk-9");
    expect(written.join("")).not.toContain("sk-9");
  });

  test("text echoes; select returns the option id", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const text = interaction().prompt({ type: "text", message: "Name:" });
    h.emit("data", `work${CR}`);
    expect(await text).toBe("work");
    expect(written.join("")).toContain("work");
    const select = interaction().prompt({
      type: "select",
      message: "Method:",
      options: [
        { id: "oauth", label: "OAuth" },
        { id: "api-key", label: "API key" },
      ],
    });
    h.emit("data", "\u001b[B");
    h.emit("data", CR);
    expect(await select).toBe("api-key");
  });

  test("Enter on an empty manual-code prompt opens the parked auth url once", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const opened: string[] = [];
    const io = interaction(opened);
    io.notify({ type: "auth-url", url: "https://example.test/authorize" });
    const first = io.prompt({ type: "manual-code", message: "Paste the code:" });
    h.emit("data", CR);
    h.emit("data", `A${CR}`);
    expect(await first).toBe("A");
    const second = io.prompt({ type: "manual-code", message: "Paste the code:" });
    h.emit("data", `B${CR}`);
    expect(await second).toBe("B");
    expect(opened).toEqual(["https://example.test/authorize"]);
    expect(logged.join("\n")).toContain("Press Enter to open it in your browser.");
  });

  test("renders device-code, info links and progress events", () => {
    const io = interaction();
    io.notify({ type: "device-code", userCode: "WDJB", verificationUri: "https://example.test/device" });
    io.notify({ type: "info", message: "Docs:", links: [{ label: "Docs", url: "https://example.test/docs" }] });
    io.notify({ type: "info", message: "Plain." });
    io.notify({ type: "progress", message: "Exchanging tokens" });
    const text = logged.join("\n");
    expect(text).toContain("Go to https://example.test/device and enter code WDJB");
    expect(text).toContain("  Docs: https://example.test/docs");
    expect(text).toContain("Plain.");
    expect(text).toContain("Exchanging tokens");
  });

  test("applies the given style", () => {
    const io = createTerminalAuthInteraction({
      log: (t) => logged.push(t),
      style: { accent: (t) => t, dim: (t) => `~${t}~`, bold: (t) => `*${t}*` },
      openUrl: () => undefined,
    });
    io.notify({ type: "progress", message: "Working" });
    io.notify({ type: "device-code", userCode: "C0DE", verificationUri: "https://example.test/d" });
    expect(logged).toContain("~Working~");
    expect(logged.join("\n")).toContain("*C0DE*");
  });
});
```

An off-union prompt type cannot be built without a cast the test gates forbid, so the "unknown type is a secret" rule is held by the code shape in Step 6 (`secret` is the fallthrough branch), not by a test.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/nax-agent && timeout 120 bun test test/unit/terminal-auth/ --timeout=60000`
Expected: FAIL, cannot resolve `#src/terminal-auth/prompt`.

- [ ] **Step 4: Write `src/terminal-auth/prompt.ts`**

This is the nax `auth-prompt.ts` with three changes:
- chalk is replaced by `TerminalStyle`;
- the seam is renamed `_terminalPromptDeps`;
- `read`'s per-character handler is split into `keyAction`, because the original arrow scored 32 against the limit of 20.

```ts
/**
 * Terminal prompts for credential entry (moved from the nax CLI, S5-4 M-28).
 *
 * Nothing typed into a secret prompt is echoed, and the terminal is restored on
 * every exit path: submit, cancel, stream end and stream error. Ctrl+D cancels;
 * it never submits (it once fell through to "submit" in nax's confirm prompt).
 */

/** Ctrl+C. */
const ETX = "\u0003";
/** Ctrl+D. Conventionally cancel, never submit. */
const EOT = "\u0004";
const CR = "\r";
const LF = "\n";
const BACKSPACE = "\u007F";
const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";

/** Colours for the prompts; the caller supplies them (nax passes chalk). */
export interface TerminalStyle {
  accent(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const identity = (text: string): string => text;

export const PLAIN_STYLE: TerminalStyle = { accent: identity, dim: identity, bold: identity };

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

export const _terminalPromptDeps: {
  stdin: PromptStdin;
  write: (text: string) => boolean;
} = {
  stdin: process.stdin as unknown as PromptStdin,
  write: (text: string) => process.stdout.write(text),
};

type KeyAction =
  | { readonly kind: "cancel" }
  | { readonly kind: "submit" }
  | { readonly kind: "empty-submit" }
  | { readonly kind: "erase" }
  | { readonly kind: "append" };

/** What one typed character does to a line prompt. */
function keyAction(char: string, bufferEmpty: boolean, hasEmptyHook: boolean): KeyAction {
  if (char === ETX || char === EOT) return { kind: "cancel" };
  if (char === CR || char === LF) {
    return bufferEmpty && hasEmptyHook ? { kind: "empty-submit" } : { kind: "submit" };
  }
  if (char === BACKSPACE) return { kind: "erase" };
  return { kind: "append" };
}

/**
 * `onEmptySubmit` turns Enter-on-an-empty-buffer into an action rather than a
 * submission. An empty answer is meaningless for the prompts that use it (a
 * pasted auth code), and spending the keystroke here keeps the whole login on a
 * single stdin reader.
 */
function read(message: string, echo: boolean, onEmptySubmit: (() => void) | undefined, style: TerminalStyle) {
  const { stdin } = _terminalPromptDeps;
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  _terminalPromptDeps.write(`${style.accent("?")} ${message} `);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      _terminalPromptDeps.write("\n");
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        const action = keyAction(char, buffer.length === 0, onEmptySubmit !== undefined);
        if (action.kind === "cancel") {
          onEnd();
          return;
        }
        if (action.kind === "submit") {
          cleanup();
          resolve(buffer);
          return;
        }
        if (action.kind === "empty-submit") onEmptySubmit?.();
        else if (action.kind === "erase") {
          buffer = buffer.slice(0, -1);
          if (echo) _terminalPromptDeps.write("\b \b");
        } else {
          buffer += char;
          if (echo) _terminalPromptDeps.write(char);
        }
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
export function promptForSecret(message: string, style: TerminalStyle = PLAIN_STYLE): Promise<string> {
  return read(message, false, undefined, style);
}

/** Reads a visible line, for non-secret answers such as a pasted auth code. */
export function promptForLine(
  message: string,
  onEmptySubmit?: () => void,
  style: TerminalStyle = PLAIN_STYLE,
): Promise<string> {
  return read(message, true, onEmptySubmit, style);
}

export interface SelectChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * Reads a choice with the arrow keys and returns the chosen option's id. The
 * option block is redrawn in place. Enter commits the highlighted row, so a
 * value that is not an option can never be returned.
 */
export function promptForSelect(
  message: string,
  choices: readonly SelectChoice[],
  style: TerminalStyle = PLAIN_STYLE,
): Promise<string> {
  const { stdin } = _terminalPromptDeps;
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  // Never silently pick for the user: an empty list is a caller bug.
  if (choices.length === 0) return Promise.reject(new PromptCancelledError());

  _terminalPromptDeps.write(`${style.accent("?")} ${message}\n`);

  return new Promise<string>((resolve, reject) => {
    let index = 0;
    let settled = false;
    let drawn = false;

    const render = (): void => {
      if (drawn) _terminalPromptDeps.write(`\u001b[${choices.length}A`);
      drawn = true;
      for (const [i, choice] of choices.entries()) {
        const active = i === index;
        const marker = active ? style.accent(">") : " ";
        const label = active ? style.accent(choice.label) : choice.label;
        _terminalPromptDeps.write(`\r\u001b[2K${marker} ${label}\n`);
      }
    };

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      // Whole-chunk matching: an arrow key is a three-byte escape sequence.
      if (chunk.includes(ETX) || chunk.includes(EOT)) {
        onEnd();
        return;
      }
      if (chunk.includes(ARROW_UP)) {
        index = (index - 1 + choices.length) % choices.length;
        render();
        return;
      }
      if (chunk.includes(ARROW_DOWN)) {
        index = (index + 1) % choices.length;
        render();
        return;
      }
      if (chunk.includes(CR) || chunk.includes(LF)) {
        const chosen = choices[index];
        cleanup();
        // biome-ignore lint/style/noNonNullAssertion: index is held in range by the modulo above.
        resolve(chosen!.id);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
    render();
  });
}
```

The style test in Step 1 expects `"<>> <A>"`: the accented marker `<>>` followed by the accented label `<A>`.

- [ ] **Step 5: Write `src/terminal-auth/open-url.ts`**

```ts
/**
 * Opening a URL in the user's browser (moved from the nax CLI, S5-4 M-28).
 *
 * Best-effort: the caller always prints the URL first, so a failure costs a
 * copy-paste, not the login. The URL is its own argv entry, never a shell
 * string. Node reports a missing opener asynchronously (an `error` event), so
 * the child gets an error listener; without it a container with no xdg-open
 * would crash the login (S5-4 Review Focus 2).
 */
import { type ChildProcess, spawn } from "node:child_process";

export function spawnDetached(command: readonly string[]): ChildProcess {
  const [file, ...args] = command;
  // nax-git-env-allow: not git: browser opener argv
  const child = spawn(file ?? "", args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // The URL is already on screen; a missing opener is not news.
  });
  child.unref();
  return child;
}

/** Test seam. */
export const _openUrlDeps: {
  spawn: (command: readonly string[]) => void;
  platform: () => string;
} = {
  spawn: (command) => {
    spawnDetached(command);
  },
  platform: () => process.platform,
};

/** The opener for a platform. Windows needs the empty "" title argument. */
function openerFor(platform: string, url: string): readonly string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openUrl(url: string): void {
  try {
    _openUrlDeps.spawn(openerFor(_openUrlDeps.platform(), url));
  } catch {
    // Deliberately silent: the URL is already on screen.
  }
}
```

- [ ] **Step 6: Write `src/terminal-auth/interaction.ts` and the barrel**

```ts
/**
 * The terminal's side of a login (moved from nax's `terminalInteraction`, S5-4
 * M-28). Shared by `nax auth login` and `nax-agent login`. Secrets go through
 * the non-echoing prompt; any prompt type this mirror does not recognise is
 * treated as a secret.
 */
import type { AuthEvent, AuthInteraction, AuthPrompt } from "#src/native/auth-types";
import { openUrl as defaultOpenUrl } from "#src/terminal-auth/open-url";
import {
  PLAIN_STYLE,
  promptForLine,
  promptForSecret,
  promptForSelect,
  type TerminalStyle,
} from "#src/terminal-auth/prompt";

export interface TerminalAuthOptions {
  /** One line of output (no trailing newline). */
  readonly log: (text: string) => void;
  readonly style?: TerminalStyle;
  readonly openUrl?: (url: string) => void;
}

export function createTerminalAuthInteraction(options: TerminalAuthOptions): AuthInteraction {
  const style = options.style ?? PLAIN_STYLE;
  const open = options.openUrl ?? defaultOpenUrl;
  // notify() is synchronous and the flow fires auth-url right before racing a
  // manual-code prompt against its callback server, so the URL is parked and
  // spent by the next prompt's Enter-on-empty.
  let pendingUrl: string | undefined;

  const manualCode = (message: string): Promise<string> => {
    const url = pendingUrl;
    if (url === undefined) return promptForLine(message, undefined, style);
    pendingUrl = undefined;
    options.log(style.dim("Press Enter to open it in your browser."));
    return promptForLine(
      message,
      () => {
        options.log(style.dim("Opening your browser..."));
        open(url);
      },
      style,
    );
  };

  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "manual-code") return manualCode(prompt.message);
      if (prompt.type === "text") return promptForLine(prompt.message, undefined, style);
      if (prompt.type === "select") {
        return promptForSelect(
          prompt.message,
          prompt.options.map((option) => ({ id: option.id, label: option.label })),
          style,
        );
      }
      return promptForSecret(prompt.message, style);
    },
    notify: (event: AuthEvent): void => {
      switch (event.type) {
        case "auth-url":
          // The flow's own instructions are dropped: nothing has opened a browser yet.
          options.log(`\n${style.bold("Open this URL to continue:")}\n  ${event.url}`);
          pendingUrl = event.url;
          return;
        case "device-code":
          options.log(`\nGo to ${event.verificationUri} and enter code ${style.bold(event.userCode)}`);
          return;
        case "info":
          options.log(event.message);
          for (const link of event.links ?? []) options.log(`  ${link.label ?? "Link"}: ${link.url}`);
          return;
        case "progress":
          options.log(style.dim(event.message));
          return;
        default:
        // An event type this mirror does not recognise: say nothing.
      }
    },
  };
}
```

The "applies the given style" test checks `"*C0DE*"` inside the device-code line, which works with the line above.

`src/terminal-auth/index.ts`:

```ts
/** Terminal login UI shared by `nax auth login` and `nax-agent login` (S5-4 M-28). */
export { createTerminalAuthInteraction, type TerminalAuthOptions } from "./interaction.ts";
export { _openUrlDeps, openUrl, spawnDetached } from "./open-url.ts";
export {
  _terminalPromptDeps,
  PLAIN_STYLE,
  PromptCancelledError,
  type PromptStdin,
  promptForLine,
  promptForSecret,
  promptForSelect,
  type SelectChoice,
  type TerminalStyle,
} from "./prompt.ts";
```

- [ ] **Step 7: Add `loginProviderIds` with a failing test first**

Append to `test/unit/native/auth-login.test.ts`. Extend its import to `import { _authDeps, AuthCancelledError, loginProviderIds, runLogin } from "#src/native/auth";`, add `const realProviderIds = _authDeps.providerIds;` beside `realLogin`, and add `_authDeps.providerIds = realProviderIds;` to its `afterEach`. Then:

```ts
describe("loginProviderIds", () => {
  test("lists the providers runLogin can serve, as nax-ai's default catalog names them", async () => {
    _authDeps.providerIds = async () => ["anthropic", "openrouter"];
    expect(await loginProviderIds()).toEqual(["anthropic", "openrouter"]);
  });
});
```

Run: `timeout 120 bun test test/unit/native/auth-login.test.ts --timeout=60000`. Expected: FAIL (`loginProviderIds` is not exported).

In `src/native/auth.ts`, after `listStoredProviders`:

```ts
/** The providers `runLogin` can log in to: nax-ai's default catalog (S5-4 M-33). */
export async function loginProviderIds(): Promise<string[]> {
  return _authDeps.providerIds();
}
```

Add `loginProviderIds,` to the `./auth.ts` export list in `src/native/index.ts` and to the `#src/native/index` block in `src/index.ts`.

- [ ] **Step 8: Export the terminal UI**

In `src/index.ts`, after the `export { NaxError } ...` line:

```ts
export {
  createTerminalAuthInteraction,
  PLAIN_STYLE,
  PromptCancelledError,
  type TerminalAuthOptions,
  type TerminalStyle,
} from "#src/terminal-auth/index";
```

In `src/internal.ts`, beside the other `export *` lines (alphabetical position, after the `#src/sandbox` group):

```ts
export * from "#src/terminal-auth/index";
```

- [ ] **Step 9: Run the task's tests and gates**

```bash
cd packages/nax-agent
timeout 120 bun test test/unit/terminal-auth/ test/unit/native/auth-login.test.ts --timeout=60000
bun run typecheck && bun run lint:fix && bun run check:all
bun run api:update
timeout 900 bun test ./test/unit/ --timeout=60000
bun run test:coverage
```

Expected: all PASS. If `check-complexity` names `read`'s `onData`, move the `append`/`erase` branch into a helper `applyKey(action, char)` returning the new buffer; never baseline it.

- [ ] **Step 10: Changelog**

Add to the top of `packages/nax-agent/CHANGELOG.md`, under the intro paragraph. This also catches up on S5-1..S5-3, which shipped without entries:

```md
## [Unreleased]

### Added

- `createTerminalAuthInteraction({ log, style?, openUrl? })`, `PromptCancelledError`, `TerminalStyle` and `PLAIN_STYLE`: the terminal login UI (hidden secret entry, arrow-key picker, browser handoff for OAuth), moved from the nax CLI so `nax-agent login` shares it (S5-4).
- `loginProviderIds()`: the providers `runLogin` can log in to (S5-4).
- `displayToolInput` and `toolResultPreview`: the live tool-display masking, for replaying stored transcripts (S5-1).
- `answerable?: false` on the `approval_requested` and `question` session events, set for profile auto-decisions and noted questions (S5-2).
- `carryHistoryAcrossModels` (native backend option): keep a session's history across a model change; each assistant message records its origin model (S5-3).
```

- [ ] **Step 11: Commit**

```bash
git add packages/nax-agent packages/nax/test/unit/cli
git commit -m "feat(nax-agent): shared terminal login UI and loginProviderIds"
```

nax's own `src/cli/auth-prompt.ts` and `open-url.ts` stay until Task 2; only their tests moved, so nax's suite stays green between the two commits.

---

### Task 2: nax `auth login` uses the shared UI

**Files:**
- Modify: `packages/nax/src/cli/auth.ts`, `packages/nax/src/cli/index.ts:24`, `packages/nax/scripts/baselines/complexity-baseline.json:25`, `packages/nax/test/unit/cli/auth.test.ts`
- Delete: `packages/nax/src/cli/auth-prompt.ts`, `packages/nax/src/cli/open-url.ts`

**Interfaces:**
- Consumes: `createTerminalAuthInteraction`, `PromptCancelledError`, `TerminalStyle` (public); `_terminalPromptDeps`, `_openUrlDeps`, `PromptStdin` (`@nathapp/nax-agent/internal`, tests only).
- Produces: nothing new. `authLoginCommand` behaves exactly as before.

- [ ] **Step 1: Point the existing tests at the moved seams (RED)**

In `test/unit/cli/auth.test.ts`, replace lines 7-8:

```ts
import { _openUrlDeps, _terminalPromptDeps as _authPromptDeps, type PromptStdin } from "@nathapp/nax-agent/internal";
```

Leave the rest of the file unchanged: the alias keeps every `_authPromptDeps` reference valid.

Run: `cd packages/nax && timeout 300 bun test test/unit/cli/auth.test.ts --timeout=60000`
Expected: FAIL. The browser-handoff and "routes prompts" tests time out or record nothing, because `auth.ts` still drives nax's own prompt module.

- [ ] **Step 2: Switch `auth.ts` to the shared interaction**

In `src/cli/auth.ts`:
- Delete the `terminalInteraction()` function (lines 40-105).
- Delete the imports of `./auth-prompt` and `./open-url`.
- Change the nax-agent imports to include `createTerminalAuthInteraction`, `PromptCancelledError` and `type TerminalStyle`.
- Add, after `_cliAuthDeps`:

```ts
const CHALK_STYLE: TerminalStyle = { accent: chalk.cyan, dim: chalk.dim, bold: chalk.bold };

/** The terminal's side of a login, from nax-agent (S5-4 M-28); log stays a seam. */
function terminalInteraction(): AuthInteraction {
  return createTerminalAuthInteraction({ log: (text) => _cliAuthDeps.log(text), style: CHALK_STYLE });
}
```

The `AuthInteraction` type import stays. Drop `AuthEvent` and `AuthPrompt` from the type import if they are now unused.

- [ ] **Step 3: Delete the moved sources, the re-export and the baseline entry**

```bash
cd packages/nax
git rm src/cli/auth-prompt.ts src/cli/open-url.ts
```

- Remove line 24 of `src/cli/index.ts` (`export { _authPromptDeps, PromptCancelledError, ... } from "./auth-prompt";`).
- Remove the `"src/cli/auth-prompt.ts": { "=>": 32 },` line from `scripts/baselines/complexity-baseline.json`. Keep the JSON valid: watch the trailing comma.
- Check that nothing else references the moved files: `rg -n "auth-prompt|open-url|_authPromptDeps" packages/nax/src packages/nax/bin`. Expected: no output.

- [ ] **Step 4: Run nax's checks**

```bash
cd packages/nax
bun x biome check --write src/cli/auth.ts src/cli/index.ts test/unit/cli/auth.test.ts
bun run typecheck
timeout 300 bun test test/unit/cli/ --timeout=60000
bun run lint
```

Expected: all PASS, including the browser-handoff tests (`opened` equals the URL) and `check:complexity` (no stale entry).

- [ ] **Step 5: Commit**

```bash
git add -A packages/nax
git commit -m "refactor(nax): auth login uses nax-agent's terminal login UI"
```

---

### Task 3: `nax-agent login <provider>`

**Files:**
- Modify: `packages/nax-agent-acp/src/server/cli.ts`, `src/server/main.ts`, `src/server/process-entry.ts`
- Create: `packages/nax-agent-acp/src/server/login.ts`, `src/server/auth.ts` (the `AuthPorts` part only; Task 4 adds the rest)
- Test: `test/unit/server/cli.test.ts`, `test/unit/server/login.test.ts` (new), `test/unit/server/main.test.ts`, `test/unit/server/process-entry.test.ts`, `test/unit/server/auth.test.ts` (new)

**Interfaces:**
- Consumes: `runLogin`, `createTerminalAuthInteraction`, `AuthCancelledError`, `PromptCancelledError`, `loginProviderIds`, `providersWithoutCredentials`, `redactSecrets` and the types `AuthInteraction`, `AuthMethod`, `AuthResult` from `@nathapp/nax-agent`.
- Produces:
  - `CliCommand` gains `{ kind: "login"; provider: string; method?: AuthMethod; flags: CliFlags }`.
  - `src/server/auth.ts`: `interface AuthPorts { loginProviderIds(): Promise<readonly string[]>; providersWithoutCredentials(ids: readonly string[]): Promise<readonly string[]>; runLogin(providerId: string, interaction: AuthInteraction, method?: AuthMethod): Promise<AuthResult>; interaction(log: (line: string) => void): AuthInteraction }`, `NAX_AGENT_AUTH: AuthPorts`.
  - `src/server/login.ts`: `runLoginCommand(input: { provider: string; method?: AuthMethod }, deps: LoginDeps): Promise<number>` with `interface LoginDeps { isTTY: boolean; out(line: string): void; err(line: string): void; auth: Pick<AuthPorts, "runLogin" | "interaction"> }`.
  - `MainDeps` gains `readonly isTTY: boolean` and `readonly auth?: AuthPorts`.

- [ ] **Step 1: Failing CLI tests**

Append to `test/unit/server/cli.test.ts`:

```ts
describe("login (S5-4)", () => {
  test("login <provider>", () => {
    expect(parseCli(["login", "anthropic"])).toEqual({ kind: "login", provider: "anthropic", flags: {} });
  });

  test("the editor appends login to its server invocation (Review Focus 1, M-34)", () => {
    expect(parseCli(["acp", "--model", "x/y", "login", "anthropic"])).toEqual({
      kind: "login",
      provider: "anthropic",
      flags: { model: "x/y" },
    });
  });

  test("--method is forwarded when valid", () => {
    expect(parseCli(["login", "openrouter", "--method", "oauth"])).toMatchObject({ method: "oauth" });
    expect(parseCli(["login", "openrouter", "--method", "sso"])).toEqual({
      kind: "usage-error",
      message: 'invalid --method "sso"; expected api-key or oauth',
    });
  });

  test("login needs exactly one provider", () => {
    expect(parseCli(["login"]).kind).toBe("usage-error");
    expect(parseCli(["login", "a", "b"]).kind).toBe("usage-error");
  });

  test("--method without login is a usage error", () => {
    expect(parseCli(["--method", "oauth"])).toEqual({ kind: "usage-error", message: "--method is only valid with login" });
  });

  test("unknown words still report the whole command", () => {
    expect(parseCli(["serve"])).toEqual({ kind: "usage-error", message: "unknown command: serve" });
  });
});
```

Run: `cd packages/nax-agent-acp && timeout 120 bun test test/unit/server/cli.test.ts --timeout=60000`. Expected: FAIL.

- [ ] **Step 2: Implement the CLI**

In `src/server/cli.ts`:
- Update the header comment ("S5-4 adds `login <provider>`" becomes "`login <provider>` (S5-4)").
- Add `import type { AuthMethod } from "@nathapp/nax-agent";`.
- Add the variant to `CliCommand`:

```ts
  | {
      readonly kind: "login";
      readonly provider: string;
      readonly method?: AuthMethod;
      readonly flags: CliFlags;
    }
```

Replace `USAGE` with:

```ts
export const USAGE = [
  "Usage: nax-agent [acp] [options]",
  "       nax-agent login <provider> [--method api-key|oauth] [--config-dir <dir>]",
  "",
  "Runs the nax-agent ACP server on stdio, or logs in to a model provider",
  "(the credential is stored in <config-dir>, shared with `nax auth login`).",
  "",
  "Options:",
  "  --config-dir <dir>                    nax config directory (default ~/.nax)",
  "  --sessions-dir <dir>                  session storage (default <config-dir>/.agent-server/sessions)",
  "  --model <provider/model[effort]>      default model for new sessions",
  "  --mode <none|read|ask|full>           default mode for new sessions (default ask)",
  "  --bash-approval <gated|escalate|raw>  default bash approval (default gated)",
  "  --method <api-key|oauth>              login method (login only; default: ask)",
  "  --version                             print the version",
  "  --help                                print this help",
  "",
  "Each option can also be set as NAX_AGENT_<OPTION>, for example NAX_AGENT_MODEL.",
].join("\n");
```

Add `method: { type: "string" },` to `OPTIONS`.

Replace the body of `parseCli` after the `version` check:

```ts
const LOGIN_METHODS: readonly AuthMethod[] = ["api-key", "oauth"];

function flagsOf(values: ReturnType<typeof parse>["values"]): CliFlags {
  return {
    ...flag("configDir", values["config-dir"]),
    ...flag("sessionsDir", values["sessions-dir"]),
    ...flag("model", values.model),
    ...flag("mode", values.mode),
    ...flag("bashApproval", values["bash-approval"]),
  };
}

function loginCommand(words: readonly string[], method: string | undefined, flags: CliFlags): CliCommand {
  const [, provider, ...extra] = words;
  if (provider === undefined || extra.length > 0) {
    return { kind: "usage-error", message: "login takes one provider: nax-agent login <provider>" };
  }
  if (method === undefined) return { kind: "login", provider, flags };
  const known = LOGIN_METHODS.find((m) => m === method);
  if (known === undefined) {
    return { kind: "usage-error", message: `invalid --method "${method}"; expected api-key or oauth` };
  }
  return { kind: "login", provider, method: known, flags };
}
```

and in `parseCli`:

```ts
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };
  const flags = flagsOf(values);
  // An editor's terminal login appends `login <provider>` to the server invocation (M-34).
  const words = positionals[0] === "acp" ? positionals.slice(1) : positionals;
  if (words[0] === "login") return loginCommand(words, values.method, flags);
  if (words.length > 0) return { kind: "usage-error", message: `unknown command: ${positionals.join(" ")}` };
  if (values.method !== undefined) return { kind: "usage-error", message: "--method is only valid with login" };
  return { kind: "acp", flags };
```

Run the CLI tests. Expected: PASS, along with the existing ones.

- [ ] **Step 3: Failing `AuthPorts` and `runLoginCommand` tests**

`test/unit/server/auth.test.ts` (Task 4 extends it):

```ts
import { describe, expect, test } from "bun:test";
import { NAX_AGENT_AUTH } from "#src/server/auth";

describe("NAX_AGENT_AUTH", () => {
  test("builds a terminal interaction around the given log", () => {
    const interaction = NAX_AGENT_AUTH.interaction(() => undefined);
    expect(typeof interaction.prompt).toBe("function");
    expect(typeof interaction.notify).toBe("function");
  });
});
```

`test/unit/server/login.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AuthCancelledError, type AuthInteraction, type AuthMethod, NaxError } from "@nathapp/nax-agent";
import { type LoginDeps, runLoginCommand } from "#src/server/login";

const silent: AuthInteraction = { prompt: async () => "", notify: () => undefined };

function deps(overrides: Partial<LoginDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { provider: string; method?: AuthMethod }[] = [];
  const base: LoginDeps = {
    isTTY: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    auth: {
      interaction: () => silent,
      runLogin: async (provider, _interaction, method) => {
        calls.push({ provider, ...(method !== undefined ? { method } : {}) });
        return { providerId: provider, method: method ?? "api-key", kind: "api-key" };
      },
    },
    ...overrides,
  };
  return { deps: base, out, err, calls };
}

describe("runLoginCommand", () => {
  test("logs in, reports the result as returned, exits 0", async () => {
    const h = deps();
    expect(await runLoginCommand({ provider: "anthropic", method: "api-key" }, h.deps)).toBe(0);
    expect(h.calls).toEqual([{ provider: "anthropic", method: "api-key" }]);
    expect(h.out).toEqual(["Signed in to anthropic (method: api-key, credential: api-key)"]);
    expect(h.err).toEqual([]);
  });

  test("refuses at once without a TTY, never prompting (Review Focus 5)", async () => {
    const h = deps({ isTTY: false });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join("\n")).toContain("needs an interactive terminal");
    expect(h.err.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  test("a cancel exits 130 with nothing on stderr (Review Focus 5)", async () => {
    const h = deps({
      auth: {
        interaction: () => silent,
        runLogin: async () => Promise.reject(new AuthCancelledError("anthropic")),
      },
    });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(130);
    expect(h.err).toEqual([]);
    expect(h.out).toEqual([]);
  });

  test("a failure exits 1 with the message, secrets redacted", async () => {
    const h = deps({
      auth: {
        interaction: () => silent,
        runLogin: async () =>
          Promise.reject(new NaxError("Login failed: key sk-ant-api03-abcdefghijklmnopqrstuvwxyz rejected", "AUTH_LOGIN_FAILED")),
      },
    });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("nax-agent: Login failed");
    expect(h.err.join("\n")).not.toContain("abcdefghijklmnop");
  });
});
```

Run both files. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `AuthPorts` and `runLoginCommand`**

`src/server/auth.ts`:

```ts
/**
 * Credentials for the ACP server (S5 spec §6.3, S5-4): the nax-agent auth API
 * behind one port, so the server and `login` are testable without a store.
 */
import {
  type AuthInteraction,
  type AuthMethod,
  type AuthResult,
  createTerminalAuthInteraction,
  loginProviderIds,
  providersWithoutCredentials,
  runLogin,
} from "@nathapp/nax-agent";

export interface AuthPorts {
  /** Providers `runLogin` can serve (M-33). */
  loginProviderIds(): Promise<readonly string[]>;
  /** Of these providers, those with neither a stored nor an ambient credential (M-29). */
  providersWithoutCredentials(providerIds: readonly string[]): Promise<readonly string[]>;
  runLogin(providerId: string, interaction: AuthInteraction, method?: AuthMethod): Promise<AuthResult>;
  /** The terminal login UI, writing its lines through `log`. */
  interaction(log: (line: string) => void): AuthInteraction;
}

export const NAX_AGENT_AUTH: AuthPorts = {
  loginProviderIds,
  providersWithoutCredentials,
  runLogin,
  interaction: (log) => createTerminalAuthInteraction({ log }),
};
```

`src/server/login.ts`:

```ts
/**
 * `nax-agent login <provider>` (S5 spec §6.1, S5-4): an interactive login on
 * the terminal, writing to the same credential store as `nax auth login`. An
 * editor's terminal auth runs this; exit 0 tells it the login succeeded.
 * Exit codes: 0 signed in, 1 failure or no terminal, 130 cancelled.
 */
import {
  AuthCancelledError,
  type AuthMethod,
  PromptCancelledError,
  redactSecrets,
} from "@nathapp/nax-agent";
import type { AuthPorts } from "#src/server/auth";
import { messageOf } from "#src/server/errors";

export interface LoginDeps {
  readonly isTTY: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly auth: Pick<AuthPorts, "runLogin" | "interaction">;
}

function envName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export async function runLoginCommand(
  input: { readonly provider: string; readonly method?: AuthMethod },
  deps: LoginDeps,
): Promise<number> {
  if (!deps.isTTY) {
    deps.err(
      `nax-agent login needs an interactive terminal. Without one, set the provider's environment variable ` +
        `(for example ${envName(input.provider)}); nax-agent reads it when nothing is stored.`,
    );
    return 1;
  }
  try {
    const result = await deps.auth.runLogin(input.provider, deps.auth.interaction(deps.out), input.method);
    deps.out(`Signed in to ${result.providerId} (method: ${result.method}, credential: ${result.kind})`);
    return 0;
  } catch (error) {
    if (error instanceof AuthCancelledError || error instanceof PromptCancelledError) return 130;
    deps.err(`nax-agent: ${redactSecrets(messageOf(error))}`);
    return 1;
  }
}
```

Run both test files. Expected: PASS.

- [ ] **Step 5: Failing `main` dispatch test**

In `test/unit/server/main.test.ts`:
- Add `isTTY: true,` to the `deps` literal in `harness`.
- Add a fake auth: `auth: fakeAuth(),`, with this helper above `harness`:

```ts
import type { AuthPorts } from "#src/server/auth";

function fakeAuth(overrides: Partial<AuthPorts> = {}): AuthPorts {
  return {
    loginProviderIds: async () => ["anthropic"],
    providersWithoutCredentials: async () => [],
    runLogin: async (providerId, _interaction, method) => ({ providerId, method: method ?? "api-key", kind: "api-key" }),
    interaction: () => ({ prompt: async () => "", notify: () => undefined }),
    ...overrides,
  };
}
```

Then add:

```ts
describe("main login (S5-4)", () => {
  test("login runs the login, prints the result on stdout and exits 0", async () => {
    const seen: string[] = [];
    const h = harness(["login", "anthropic"], {
      auth: fakeAuth({
        runLogin: async (providerId) => {
          seen.push(providerId);
          return { providerId, method: "oauth", kind: "oauth" };
        },
      }),
    });
    expect(await main(h.deps)).toBe(0);
    expect(seen).toEqual(["anthropic"]);
    expect(h.out()).toBe("Signed in to anthropic (method: oauth, credential: oauth)\n");
  });

  test("login without a TTY exits 1 and writes only to stderr", async () => {
    const h = harness(["login", "anthropic"], { isTTY: false });
    expect(await main(h.deps)).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("needs an interactive terminal");
  });
});
```

Run: `timeout 120 bun test test/unit/server/main.test.ts --timeout=60000`. Expected: FAIL. `MainDeps` has no `isTTY`/`auth`, so typecheck fails, and `login` is not dispatched.

- [ ] **Step 6: Wire `main` and `process-entry`**

In `src/server/main.ts`:
- Add to `MainDeps`:

```ts
  /** stdin is an interactive terminal (login needs one). */
  readonly isTTY: boolean;
  /** nax-agent's auth API; tests inject a fake. Defaults to the real one. */
  readonly auth?: AuthPorts;
```

- Import `NAX_AGENT_AUTH, type AuthPorts` from `#src/server/auth` and `runLoginCommand` from `#src/server/login`.
- Add a `case "login": return login(command, deps);` before `case "acp"`.
- Add:

```ts
async function login(command: Extract<CliCommand, { kind: "login" }>, deps: MainDeps): Promise<number> {
  setAgentLogger(stderrLogger(deps.env.NAX_AGENT_LOG === "debug" ? "debug" : "info", deps.writeErr));
  const configDir = resolveConfigDir(command.flags, deps.env, deps.homedir);
  configureCredentials(credentialsFor(configDir, deps.readFile));
  return runLoginCommand(
    { provider: command.provider, ...(command.method !== undefined ? { method: command.method } : {}) },
    {
      isTTY: deps.isTTY,
      out: (line) => deps.stdout.write(`${line}\n`),
      err: (line) => deps.writeErr(`${line}\n`),
      auth: deps.auth ?? NAX_AGENT_AUTH,
    },
  );
}
```

  Change the `cli` import to `import { type CliCommand, type CliFlags, parseCli, USAGE } from "#src/server/cli";`.

- In `src/server/process-entry.ts`:
  - Add `isTTY?: boolean` to `ProcessLike.stdin`'s type: change `readonly stdin: Readable;` to `readonly stdin: Readable & { readonly isTTY?: boolean };`.
  - In `mainDepsFrom`, add `isTTY: proc.stdin.isTTY === true,`.
  - In `test/unit/server/process-entry.test.ts`, add an assertion that `mainDepsFrom(fake).isTTY` is `false` for a fake process whose stdin has no `isTTY`, and `true` when the fake's stdin sets `isTTY: true`. Extend `test/helpers/fake-process.ts` if needed with an optional `isTTY` parameter.

- [ ] **Step 7: Run and commit**

```bash
cd packages/nax-agent-acp
timeout 120 bun test test/unit/server/ --timeout=60000
bun run typecheck && bun run lint:fix && bun run check:all
git add packages/nax-agent-acp
git commit -m "feat(acp-server): nax-agent login <provider>"
```

Expected: PASS. `main.test.ts`'s existing tests pass with the added `isTTY`/`auth` fields.

---

### Task 4: Server auth: login methods, `authenticate`, open check, credential error mapping

**Files:**
- Modify: `packages/nax-agent-acp/src/server/auth.ts`, `src/server/errors.ts`, `src/server/translate/stop.ts`
- Test: `test/unit/server/auth.test.ts`, `test/unit/server/errors.test.ts`, `test/unit/server/translate/stop.test.ts` (or wherever `promptOutcome` is tested: `rg -l promptOutcome test`)

**Interfaces:**
- Consumes: `AuthPorts` (Task 3); `ServerOptions` from `#src/server/options`; `NativeCatalogOverrides`, `NaxError`, `AgentLogger` from `@nathapp/nax-agent`; `AuthMethod as AcpAuthMethod`, `AuthenticateResponse`, `RequestError` from the SDK.
- Produces:
  - `errors.ts`: `CREDENTIAL_FAILURE_CODES: ReadonlySet<string>`, `isAuthFailureCode(code: string): boolean`, `loginHint(provider?: string): string`, `authRequired(message: string, data: Readonly<Record<string, unknown>>): RequestError`. `toRequestError` maps a `NaxError` with a credential code to `authRequired`.
  - `auth.ts`: `providerOf(model: string): string | undefined`, `terminalAuthMethods(input: { models: readonly string[]; overridden: ReadonlySet<string>; loginProviders: readonly string[] }): AcpAuthMethod[]`, `interface ServerAuth { readonly methods: readonly AcpAuthMethod[]; authenticate(methodId: string): Promise<AuthenticateResponse>; ensureCredentials(model: string): Promise<void> }`, `createServerAuth(deps: { methods: readonly AcpAuthMethod[]; overridden: ReadonlySet<string>; missing: AuthPorts["providersWithoutCredentials"] }): ServerAuth`, `NO_SERVER_AUTH: ServerAuth`, `loadServerAuth(input: { options: ServerOptions; overrides: NativeCatalogOverrides; ports: AuthPorts; logger: AgentLogger }): Promise<ServerAuth>`.

- [ ] **Step 1: Failing error-mapping tests**

Append to `test/unit/server/errors.test.ts` (merge the imports):

```ts
import { NaxError } from "@nathapp/nax-agent";
import { authRequired, isAuthFailureCode, loginHint } from "#src/server/errors";

describe("credential failures (S5-4 M-32)", () => {
  test("fail-auth and the credential-store codes are auth failures; others are not", () => {
    for (const code of [
      "fail-auth",
      "CREDENTIAL_HELPER_FAILED",
      "CREDENTIAL_HELPER_INVALID",
      "CREDENTIAL_CHANGED",
      "CREDENTIAL_FILE_UNREADABLE",
      "CREDENTIALS_NOT_CONFIGURED",
    ]) {
      expect(isAuthFailureCode(code)).toBe(true);
    }
    expect(isAuthFailureCode("fail-rate-limit")).toBe(false);
    expect(isAuthFailureCode("AGENT_SESSION_TURN_FAILED")).toBe(false);
  });

  test("authRequired is -32000 with the login hint and the data", () => {
    const error = authRequired("no credentials for provider \"anthropic\"", { provider: "anthropic" });
    expect(error.code).toBe(-32000);
    expect(error.message).toContain('no credentials for provider "anthropic"');
    expect(error.message).toContain(loginHint("anthropic"));
    expect(error.data).toEqual({ provider: "anthropic" });
  });

  test("loginHint names both commands", () => {
    expect(loginHint("anthropic")).toBe(
      "Log in with `nax-agent login anthropic` (or `nax auth login anthropic`), then retry.",
    );
    expect(loginHint()).toBe("Log in with `nax-agent login <provider>` (or `nax auth login <provider>`), then retry.");
  });

  test("toRequestError maps a credential NaxError to auth_required, redacted", () => {
    const { logger } = recordingLogger();
    const mapped = toRequestError(
      new NaxError("helper printed sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "CREDENTIAL_HELPER_FAILED"),
      logger,
    );
    expect(mapped.code).toBe(-32000);
    expect(mapped.message).not.toContain("abcdefghijklmnop");
    expect(mapped.data).toEqual({ code: "CREDENTIAL_HELPER_FAILED" });
  });
});
```

(`toRequestError` and `recordingLogger` are already imported in that file; if `recordingLogger` is not, import it from `#test/helpers/recording-logger`.)

Run: `timeout 120 bun test test/unit/server/errors.test.ts --timeout=60000`. Expected: FAIL.

- [ ] **Step 2: Implement the mapping in `errors.ts`**

Change the nax-agent import to `import { type AgentLogger, AgentSessionError, NaxError, redactSecrets } from "@nathapp/nax-agent";` and add:

```ts
/** Turn and open failures that mean "log in again" (S5-4 M-32). */
export const CREDENTIAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "fail-auth",
  "CREDENTIAL_HELPER_FAILED",
  "CREDENTIAL_HELPER_INVALID",
  "CREDENTIAL_CHANGED",
  "CREDENTIAL_FILE_UNREADABLE",
  "CREDENTIALS_NOT_CONFIGURED",
]);

export function isAuthFailureCode(code: string): boolean {
  return CREDENTIAL_FAILURE_CODES.has(code);
}

export function loginHint(provider?: string): string {
  const name = provider ?? "<provider>";
  return `Log in with \`nax-agent login ${name}\` (or \`nax auth login ${name}\`), then retry.`;
}

/** `auth_required` (-32000): editors offer the advertised login methods on it (spec §6.3). */
export function authRequired(message: string, data: Readonly<Record<string, unknown>>): RequestError {
  const provider = typeof data.provider === "string" ? data.provider : undefined;
  return RequestError.authRequired(data, `${message}. ${loginHint(provider)}`);
}
```

In `toRequestError`, after the `AgentSessionError` block:

```ts
  if (error instanceof NaxError && isAuthFailureCode(error.code)) {
    return authRequired(redactSecrets(error.message), { code: error.code });
  }
```

Run the errors tests. Expected: PASS.

- [ ] **Step 3: Failing turn-end mapping test**

Find the `promptOutcome` test file (`rg -l "promptOutcome" packages/nax-agent-acp/test`) and append:

```ts
describe("errored on credentials (S5-4 M-32)", () => {
  test("fail-auth answers auth_required with the code and message", () => {
    const outcome = promptOutcome(
      {
        type: "turn_end",
        status: "errored",
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        error: { code: "fail-auth", message: "401 invalid x-api-key" },
      },
      3600,
      true,
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.error.code).toBe(-32000);
    expect(outcome.error.data).toEqual({ code: "fail-auth", message: "401 invalid x-api-key" });
    expect(outcome.error.message).toContain("nax-agent login <provider>");
  });

  test("any other errored code stays internal_error", () => {
    const outcome = promptOutcome(
      {
        type: "turn_end",
        status: "errored",
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        error: { code: "fail-service-down", message: "503" },
      },
      3600,
      true,
    );
    expect(outcome.kind === "error" ? outcome.error.code : 0).toBe(-32603);
  });
});
```

If the file builds `turn_end` events through a helper (for example `#test/helpers/session-events`), use that helper instead of the literal: the `turn_end` type may carry more required fields. Run it. Expected: FAIL on the first test (code is -32603).

- [ ] **Step 4: Implement in `stop.ts`**

Import `authRequired, isAuthFailureCode` from `#src/server/errors` and change `failure`:

```ts
function failure(code: string, message: string): PromptOutcome {
  if (isAuthFailureCode(code)) return { kind: "error", error: authRequired(message, { code, message }) };
  return { kind: "error", error: RequestError.internalError({ code, message }, message) };
}
```

Update the header comment: "`errored` is a JSON-RPC error ...; a credential failure is `auth_required` (S5-4 M-32)". Run the test. Expected: PASS.

- [ ] **Step 5: Failing server-auth tests**

Append to `test/unit/server/auth.test.ts` (merge the imports):

```ts
import { NaxError } from "@nathapp/nax-agent";
import type { AuthPorts } from "#src/server/auth";
import { createServerAuth, loadServerAuth, NO_SERVER_AUTH, providerOf, terminalAuthMethods } from "#src/server/auth";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS = {
  configDir: "/cfg",
  sessionsDir: "/cfg/s",
  defaultMode: "ask" as const,
  bashApproval: "gated" as const,
  tiers: [
    { tier: "fast" as const, model: "openrouter/m-fast" },
    { tier: "balanced" as const, model: "anthropic/claude-sonnet-5-5" },
    { tier: "powerful" as const, model: "anthropic/claude-opus-5-5" },
  ],
  catalogOverrides: [],
};

function ports(overrides: Partial<AuthPorts> = {}): AuthPorts {
  return {
    loginProviderIds: async () => ["anthropic", "openrouter"],
    providersWithoutCredentials: async () => [],
    runLogin: async () => Promise.reject(new Error("unused")),
    interaction: () => ({ prompt: async () => "", notify: () => undefined }),
    ...overrides,
  };
}

describe("providerOf", () => {
  test("the prefix before the first slash; undefined without one", () => {
    expect(providerOf("anthropic/claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOf("openrouter/meta/llama")).toBe("openrouter");
    expect(providerOf("bare-model")).toBeUndefined();
    expect(providerOf("/x")).toBeUndefined();
  });
});

describe("terminalAuthMethods (M-33)", () => {
  test("one method per loginable provider, deduped, in order of appearance", () => {
    expect(
      terminalAuthMethods({
        models: ["openrouter/a", "anthropic/b", "anthropic/c", "minimax/d", "bare"],
        overridden: new Set(),
        loginProviders: ["anthropic", "openrouter"],
      }),
    ).toEqual([
      { id: "login-openrouter", name: "Log in to openrouter", type: "terminal", args: ["login", "openrouter"] },
      { id: "login-anthropic", name: "Log in to anthropic", type: "terminal", args: ["login", "anthropic"] },
    ]);
  });

  test("a catalog-override provider is never offered (Review Focus 4)", () => {
    expect(
      terminalAuthMethods({
        models: ["anthropic/b"],
        overridden: new Set(["anthropic"]),
        loginProviders: ["anthropic"],
      }),
    ).toEqual([]);
  });
});

describe("createServerAuth", () => {
  const methods = terminalAuthMethods({
    models: ["anthropic/b"],
    overridden: new Set(["minimax"]),
    loginProviders: ["anthropic"],
  });

  test("authenticate: present credential (stored or ambient) succeeds (M-29, Review Focus 3)", async () => {
    const seen: (readonly string[])[] = [];
    const auth = createServerAuth({
      methods,
      overridden: new Set(),
      missing: async (ids) => {
        seen.push(ids);
        return [];
      },
    });
    expect(await auth.authenticate("login-anthropic")).toEqual({});
    expect(seen).toEqual([["anthropic"]]);
  });

  test("authenticate: missing credential is auth_required", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });
    const error = await auth.authenticate("login-anthropic").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic" } });
  });

  test("authenticate: unknown method is invalid_params listing the advertised ids (M-31)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => [] });
    const error = await auth.authenticate("login-nope").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32602 });
    expect(error instanceof Error ? error.message : "").toContain("login-anthropic");
  });

  test("ensureCredentials: missing -> auth_required naming the provider (M-30)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });
    const error = await auth.ensureCredentials("anthropic/claude-sonnet-5-5").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic" } });
    expect(error instanceof Error ? error.message : "").toContain("nax-agent login anthropic");
  });

  test("ensureCredentials: ambient-only credential passes (Review Focus 3)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => [] });
    await auth.ensureCredentials("anthropic/claude-sonnet-5-5");
  });

  test("ensureCredentials: skipped for an override provider and a bare id (Review Focus 4)", async () => {
    const asked: (readonly string[])[] = [];
    const auth = createServerAuth({
      methods,
      overridden: new Set(["minimax"]),
      missing: async (ids) => {
        asked.push(ids);
        return [...ids];
      },
    });
    await auth.ensureCredentials("minimax/m2");
    await auth.ensureCredentials("bare-model");
    expect(asked).toEqual([]);
  });

  test("ensureCredentials: a credential-helper failure is auth_required, redacted", async () => {
    const auth = createServerAuth({
      methods,
      overridden: new Set(),
      missing: async () =>
        Promise.reject(new NaxError("helper said sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "CREDENTIAL_HELPER_FAILED")),
    });
    const error = await auth.ensureCredentials("anthropic/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic", code: "CREDENTIAL_HELPER_FAILED" } });
    expect(error instanceof Error ? error.message : "").not.toContain("abcdefghijklmnop");
  });

  test("ensureCredentials: any other failure propagates unchanged", async () => {
    const boom = new Error("disk on fire");
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => Promise.reject(boom) });
    expect(await auth.ensureCredentials("anthropic/x").catch((e: unknown) => e)).toBe(boom);
  });
});

describe("NO_SERVER_AUTH", () => {
  test("advertises nothing, refuses authenticate, checks nothing", async () => {
    expect(NO_SERVER_AUTH.methods).toEqual([]);
    expect(await NO_SERVER_AUTH.authenticate("login-x").catch((e: unknown) => e)).toMatchObject({ code: -32602 });
    await NO_SERVER_AUTH.ensureCredentials("anthropic/x");
  });
});

describe("loadServerAuth (M-33)", () => {
  test("methods from tiers plus the default model, minus overrides", async () => {
    const { logger } = recordingLogger();
    const auth = await loadServerAuth({
      options: { ...OPTIONS, defaultModel: "openai/gpt-x" },
      overrides: [{ provider: "openrouter", models: [] }],
      ports: ports({ loginProviderIds: async () => ["anthropic", "openrouter", "openai"] }),
      logger,
    });
    expect(auth.methods.map((m) => m.id)).toEqual(["login-anthropic", "login-openai"]);
  });

  test("a failing provider listing gives no methods and one warning", async () => {
    const { logger, lines } = recordingLogger();
    const auth = await loadServerAuth({
      options: OPTIONS,
      overrides: [],
      ports: ports({ loginProviderIds: async () => Promise.reject(new Error("catalog")) }),
      logger,
    });
    expect(auth.methods).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn" });
  });
});
```

If `{ provider: "openrouter", models: [] }` does not satisfy `NativeCatalogOverrides[number]`, build it through `catalogOverridesFrom([{ provider: "openrouter", models: [] }], logger)` from `#src/server/open-session`.

Run: `timeout 120 bun test test/unit/server/auth.test.ts --timeout=60000`. Expected: FAIL.

- [ ] **Step 6: Implement the rest of `auth.ts`**

Append to `src/server/auth.ts`. Merge the imports at the top: SDK types `AuthMethod as AcpAuthMethod` and `AuthenticateResponse`; `type AgentLogger`, `NaxError`, `type NativeCatalogOverrides` and `redactSecrets` from nax-agent; `authRequired`, `invalidParams`, `isAuthFailureCode` and `messageOf` from `#src/server/errors`; `type ServerOptions` from `#src/server/options`.

```ts
const METHOD_PREFIX = "login-";

/** The provider prefix of a native model id, or undefined when it has none (never guessed). */
export function providerOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/** Terminal login methods (spec §6.3, M-33): loginable, non-override providers, in order. */
export function terminalAuthMethods(input: {
  readonly models: readonly string[];
  readonly overridden: ReadonlySet<string>;
  readonly loginProviders: readonly string[];
}): AcpAuthMethod[] {
  const loginable = new Set(input.loginProviders);
  const providers = [
    ...new Set(input.models.map(providerOf).filter((p): p is string => p !== undefined)),
  ].filter((p) => loginable.has(p) && !input.overridden.has(p));
  return providers.map((p) => ({ id: `${METHOD_PREFIX}${p}`, name: `Log in to ${p}`, type: "terminal", args: ["login", p] }));
}

export interface ServerAuth {
  readonly methods: readonly AcpAuthMethod[];
  /** Spec §6.3, M-29/M-31. */
  authenticate(methodId: string): Promise<AuthenticateResponse>;
  /** M-30: throws auth_required when the model's provider has no credential. */
  ensureCredentials(model: string): Promise<void>;
}

export function createServerAuth(deps: {
  readonly methods: readonly AcpAuthMethod[];
  readonly overridden: ReadonlySet<string>;
  readonly missing: AuthPorts["providersWithoutCredentials"];
}): ServerAuth {
  const check = async (provider: string): Promise<void> => {
    let missing: readonly string[];
    try {
      missing = await deps.missing([provider]);
    } catch (error) {
      if (error instanceof NaxError && isAuthFailureCode(error.code)) {
        throw authRequired(redactSecrets(error.message), { provider, code: error.code });
      }
      throw error;
    }
    if (missing.includes(provider)) throw authRequired(`no credentials for provider "${provider}"`, { provider });
  };
  return {
    methods: deps.methods,
    async authenticate(methodId) {
      const method = deps.methods.find((m) => m.id === methodId);
      if (method === undefined) {
        const ids = deps.methods.map((m) => m.id).join(", ");
        throw invalidParams(`unknown auth method "${methodId}"; expected one of: ${ids === "" ? "(none)" : ids}`);
      }
      await check(methodId.slice(METHOD_PREFIX.length));
      return {};
    },
    async ensureCredentials(model) {
      const provider = providerOf(model);
      if (provider === undefined || deps.overridden.has(provider)) return;
      await check(provider);
    },
  };
}

/** No login methods and no checks: the default for an app built without auth. */
export const NO_SERVER_AUTH: ServerAuth = createServerAuth({
  methods: [],
  overridden: new Set(),
  missing: async () => [],
});

export async function loadServerAuth(input: {
  readonly options: ServerOptions;
  readonly overrides: NativeCatalogOverrides;
  readonly ports: AuthPorts;
  readonly logger: AgentLogger;
}): Promise<ServerAuth> {
  const { options, ports, logger } = input;
  const overridden = new Set(input.overrides.map((o) => o.provider));
  let loginProviders: readonly string[] = [];
  try {
    loginProviders = await ports.loginProviderIds();
  } catch (error) {
    logger.warn("auth", "could not list login providers; no login methods advertised", {
      error: redactSecrets(messageOf(error)),
    });
  }
  const models = [...options.tiers.map((t) => t.model), ...(options.defaultModel !== undefined ? [options.defaultModel] : [])];
  return createServerAuth({
    methods: terminalAuthMethods({ models, overridden, loginProviders }),
    overridden,
    missing: (ids) => ports.providersWithoutCredentials(ids),
  });
}
```

`NO_SERVER_AUTH.ensureCredentials("anthropic/x")` does call its `missing`, which always answers `[]`, so it never refuses; the NO_SERVER_AUTH test covers that.

Run: `timeout 120 bun test test/unit/server/auth.test.ts test/unit/server/errors.test.ts --timeout=60000`. Expected: PASS. Then `bun run typecheck && bun run lint:fix && bun run check:all`.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(acp-server): login methods, authenticate, credential check and auth_required"
```

---

### Task 5: Wire auth into initialize, authenticate, opens and main

**Files:**
- Modify: `packages/nax-agent-acp/src/server/client-port.ts`, `src/server/capabilities.ts`, `src/server/connection.ts`, `src/server/open-session.ts`, `src/server/main.ts`
- Modify tests: `test/helpers/fake-client-port.ts`, `test/unit/server/client-port.test.ts`, `test/unit/server/questions.test.ts:127`, `test/unit/server/connection.test.ts`, `test/unit/server/open-session.test.ts`, `test/unit/server/main.test.ts`

**Interfaces:**
- Consumes: `ServerAuth`, `NO_SERVER_AUTH`, `loadServerAuth`, `NAX_AGENT_AUTH` (Tasks 3-4).
- Produces:
  - `ClientFeatures.terminalAuth: boolean`.
  - `initializeResponse(version: string, authMethods: readonly AcpAuthMethod[] = []): InitializeResponse`.
  - `AppDeps.auth?: ServerAuth`.
  - `NativeOpenDeps.ensureCredentials?: (model: string) => Promise<void>`.

- [ ] **Step 1: Failing tests**

`client-port.test.ts`: add `terminalAuth: true` to the expected object in the second test, and pass `auth: { terminal: true }` in the caps. Add:

```ts
  test("terminal auth only when declared true", () => {
    expect(clientFeatures({ auth: { terminal: true } }).terminalAuth).toBe(true);
    expect(clientFeatures({ auth: { terminal: false } }).terminalAuth).toBe(false);
    expect(clientFeatures({}).terminalAuth).toBe(false);
  });
```

Add `terminalAuth: false` to `ALL_FEATURES` in `test/helpers/fake-client-port.ts` and to the literal at `questions.test.ts:127`.

`connection.test.ts`:
- Change the existing `initializeResponse("1.2.3")` expectation to stay `authMethods: []` (default argument).
- Import `createServerAuth` from `#src/server/auth` and add:

```ts
describe("auth on the wire (S5-4)", () => {
  const methods = [
    { id: "login-anthropic", name: "Log in to anthropic", type: "terminal" as const, args: ["login", "anthropic"] },
  ];
  const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });

  test("terminal methods only for a client that declared auth.terminal", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp({ ...appDeps(), auth }), async (agent) => {
      const plain = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const terminal = await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
      return { plain, terminal };
    });
    expect(result.plain.authMethods).toEqual([]);
    expect(result.terminal.authMethods).toEqual(methods);
  });

  test("authenticate answers auth_required while the credential is missing", async () => {
    const failure = await client({ name: "test" }).connectWith(buildAgentApp({ ...appDeps(), auth }), async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      return agent.request("authenticate", { methodId: "login-anthropic" }).catch((e: unknown) => e);
    });
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure instanceof RequestError ? failure.code : 0).toBe(-32000);
  });

  test("session/new fails auth_required when the open check refuses (M-30)", async () => {
    const deps = appDeps();
    const failure = await client({ name: "test" }).connectWith(
      buildAgentApp({
        ...deps,
        registry: createSessionRegistry({
          ...registryDeps(),
          openSession: async () => {
            await auth.ensureCredentials("anthropic/claude-sonnet-5-5");
            throw new Error("unreachable");
          },
        }),
        auth,
      }),
      async (agent) => {
        await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
        return agent.request("session/new", { cwd: dir, mcpServers: [] }).catch((e: unknown) => e);
      },
    );
    expect(failure instanceof RequestError ? failure.code : 0).toBe(-32000);
  });
});
```

For the last test, refactor `appDeps()` so its `createSessionRegistry` argument comes from a `registryDeps()` function in the same file, and `appDeps()` calls `createSessionRegistry(registryDeps())`. The registry must have a default model, so add `defaultModel: "anthropic/claude-sonnet-5-5"` to its `options`.

`open-session.test.ts`:

```ts
describe("credential check before opening (M-30)", () => {
  test("ensureCredentials runs with the request's model before create", async () => {
    const r = recorder();
    const checked: string[] = [];
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      create: r.create,
      resume: r.resume,
      backend: r.backend,
      ensureCredentials: async (model) => {
        checked.push(model);
      },
    });
    await open(REQUEST);
    expect(checked).toEqual([REQUEST.model]);
    expect(r.created).toHaveLength(1);
  });

  test("a refused check opens nothing", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      create: r.create,
      resume: r.resume,
      backend: r.backend,
      ensureCredentials: async () => Promise.reject(new Error("auth")),
    });
    expect(await open(REQUEST).catch((e: unknown) => (e instanceof Error ? e.message : ""))).toBe("auth");
    expect(r.created).toEqual([]);
    expect(r.backendCalls).toEqual([]);
  });
});
```

`main.test.ts`: the existing "serves initialize" test sends an `initialize` frame. Add a sibling that sends `clientCapabilities: { auth: { terminal: true } }` with the harness's `readFile` returning a config `{"models":{"native":{"balanced":"anthropic/claude-sonnet-5-5"}}}` for `<homedir>/.nax/config.json`, and `fakeAuth()` (logins: `["anthropic"]`). Assert that the `initialize` result frame's `authMethods` is `[{ id: "login-anthropic", name: "Log in to anthropic", type: "terminal", args: ["login", "anthropic"] }]`. Copy the frame-reading code from the existing "serves initialize" test in that file.

Run: `timeout 300 bun test test/unit/server/ --timeout=60000`. Expected: FAIL (typecheck and assertions).

- [ ] **Step 2: Implement**

`client-port.ts`:

```ts
export interface ClientFeatures {
  readonly updates: ClientUpdates;
  /** The client declared form elicitation (`clientCapabilities.elicitation.form`). */
  readonly elicitation: boolean;
  /** The client runs terminal auth methods (`clientCapabilities.auth.terminal: true`, S5-4). */
  readonly terminalAuth: boolean;
}

export const NO_CLIENT_FEATURES: ClientFeatures = {
  updates: { notices: false, compaction: false },
  elicitation: false,
  terminalAuth: false,
};
```

and add `terminalAuth: caps?.auth?.terminal === true,` in `clientFeatures`.

`capabilities.ts`: import `type AuthMethod` from the SDK, change the signature to `initializeResponse(version: string, authMethods: readonly AuthMethod[] = [])`, and set `authMethods: [...authMethods]`. Update the comment: "S5-4 advertises terminal login methods to clients that declared `auth.terminal`".

`connection.ts`:
- Add `readonly auth?: ServerAuth;` to `AppDeps`.
- In `buildAgentApp`, add `const auth = deps.auth ?? NO_SERVER_AUTH;`.
- Change initialize to:

```ts
    .onRequest("initialize", (ctx) => {
      features = clientFeatures(ctx.params.clientCapabilities);
      return initializeResponse(deps.version, features.terminalAuth ? auth.methods : []);
    })
    .onRequest("authenticate", (ctx) => guard(deps.logger, () => auth.authenticate(ctx.params.methodId)))
```

`open-session.ts`: add to `NativeOpenDeps`:

```ts
  /** S5-4 M-30: refuses (auth_required) when the model's provider has no credential. */
  readonly ensureCredentials?: (model: string) => Promise<void>;
```

and make it the first line of the returned function: `await deps.ensureCredentials?.(request.model);`.

`main.ts` `serveAcp`, replacing the inline `catalogOverridesFrom(...)`:

```ts
  const overrides = catalogOverridesFrom(resolved.options.catalogOverrides, logger);
  const auth = await loadServerAuth({ options: resolved.options, overrides, ports: deps.auth ?? NAX_AGENT_AUTH, logger });
```

Pass `catalogOverrides: overrides` and `ensureCredentials: (model) => auth.ensureCredentials(model)` to `nativeOpenSession`, and `auth` to `buildAgentApp({ version: packageVersion(), registry, logger, auth })`. Import `loadServerAuth` from `#src/server/auth`.

- [ ] **Step 3: Run the package gates**

```bash
cd packages/nax-agent-acp
bun run typecheck && bun run lint:fix && bun run check:all
timeout 900 bun test ./test/unit/ --timeout=60000
bun run test:coverage
bun run test:node
bun run api:update
```

Expected: all PASS. The API snapshot diff shows `MainDeps.isTTY` and `MainDeps.auth` (`AuthPorts`).

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(acp-server): advertise terminal login, serve authenticate, check credentials on open"
```

---

### Task 6: README, changelog, spec and master-plan amendments

**Files:**
- Modify: `packages/nax-agent-acp/README.md`, `packages/nax-agent-acp/CHANGELOG.md`, `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md`, `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md`

- [ ] **Step 1: README**

- Replace the `**Status: ...**` paragraph (lines 7-10) with:

```md
**Status: 0.4.0.** `./client`: `acpBackend()` drives external ACP agents (Claude Code and others) as
nax-agent sessions. `./server` and the `nax-agent` binary: nax-agent's own native coding agent as an
ACP server for editors (Zed) and headless clients (acpx). See "The nax-agent ACP server" below.
```

- Append this section at the end of the file:

````md
## The nax-agent ACP server

`nax-agent` is an ACP server on stdio. It runs nax-agent's native coding agent: tools run locally
under nax-agent's profiles and sandbox, and edits reach the editor as diffs.

```sh
npm install -g @nathapp/nax-agent @nathapp/nax-agent-acp
nax-agent --version
```

It reads `~/.nax/config.json`, the same file nax uses:
- `models.native.balanced` is the default model. `fast`, `balanced` and `powerful` are the models offered in the editor.
- `auth` controls where credentials come from.
- An optional `agentServer` block sets `defaultMode`, `bashApproval` and `sessionsDir`.

Flags (`--model`, `--mode`, `--bash-approval`, `--config-dir`, `--sessions-dir`) and `NAX_AGENT_<OPTION>`
environment variables override the file. Sessions are stored under `~/.nax/.agent-server/sessions/`.

### Credentials

Log in once on a terminal. The credential lands in `~/.nax`, shared with `nax auth login`:

```sh
nax-agent login anthropic            # asks for a method; --method api-key|oauth to choose
```

A provider's environment variable (for example `ANTHROPIC_API_KEY`) also works when nothing is stored.

Before opening a session, the server checks for a credential for the session model's provider. A missing
one fails the request with `auth_required` before anything is billed, and so does a rejected one during a
turn. Editors that support terminal auth then offer "Log in to <provider>", which runs
`nax-agent login <provider>` in a terminal.

### Zed

In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "nax-agent": {
      "type": "custom",
      "command": "nax-agent",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Open the agent panel and start a "nax-agent" thread.
- **Modes:** `ask` (default) asks before each edit or command, `full` runs without asking, `read` is read-only, and `none` has no tools.
- **Model:** switch it from the thread's model picker; the conversation is kept.
- **Persistence:** threads are saved and can be reopened after a restart.

### acpx (headless)

Add an agent to `~/.acpx/config.json`:

```json
{ "agents": { "nax-agent": { "argv": ["nax-agent", "acp"] } } }
```

```sh
acpx --approve-all nax-agent "add a test for parseCli"   # persistent session for this directory
acpx nax-agent "now run it"                             # continues the same session
acpx nax-agent sessions                                 # list sessions
```

Questions from the agent need a client with form elicitation. A client without it (acpx) gets a notice,
and the agent is told to proceed on its best judgement.

### Not supported yet

- MCP servers sent by the client are ignored, with a notice.
- No image or audio prompts.
- No logout or provider management over ACP. Use `nax auth list` / `nax auth rm`.
````

- [ ] **Step 2: Changelog**

In `packages/nax-agent-acp/CHANGELOG.md`, replace the `## [Unreleased]` `### Added` bullet with:

```md
- `nax-agent` binary and the `./server` entry (`main`, `runCli`): an ACP server on stdio over nax-agent's native agent. It reads `~/.nax` (models, auth, optional `agentServer` block) and logs to stderr only (S5-0).
- Streamed text, thinking, tool calls with diffs, usage and compaction updates; transcript replay (S5-1).
- `session/new`, `session/prompt`, `session/cancel`; permission requests with per-session always-allow (keyed on command and subcommand); questions via form elicitation, or a canned answer for clients without it (S5-2).
- File-backed sessions: `session/load` (with replay), `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option` (model, bash approval). A model switch keeps the conversation (S5-3).
- `nax-agent login <provider>`, terminal `authMethods` for clients that declare `auth.terminal`, `authenticate`, and `auth_required` for missing or rejected credentials, checked before a session opens (S5-4).
```

- [ ] **Step 3: Amend the spec**

In `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md`:
- §6.1, `login` row: change the behaviour cell to "Interactive login on the terminal via `runLogin(provider, createTerminalAuthInteraction(...))`. Writes to the `~/.nax` credential store. `--method api-key|oauth` is forwarded. A leading `acp` and the server flags are accepted and ignored, because an editor's terminal auth appends `login <provider>` to the server invocation (amended 2026-10-09, S5-4 M-34). Exit 0 signed in, 1 failure or no TTY, 130 cancelled."
- §6.3: replace the three bullets after "Terminal auth methods" with:

```md
- **`authenticate(methodId)`** checks the provider of an advertised method. It succeeds when a credential is stored or ambient (`providersWithoutCredentials`), and otherwise gives `auth_required`. An unknown id gives `invalid_params`. SDK 1.7.0 tells clients not to send terminal methods to `authenticate`; it is served for clients that do (amended 2026-10-09, S5-4 M-29, M-31).
- **Credential check on open.** `session/new`, `load`, `resume` and the reopen behind a mode or model change first check the session model's provider (skipped for catalog-override providers and ids without a provider prefix). A missing credential gives `auth_required` before any billed call, naming `nax-agent login <provider>` (S5-4 M-30).
- **No agent-type auth in v1** (driving OAuth or key entry over elicitation; editor support is uneven).
- A turn that fails with `fail-auth` (HTTP 401/403 or a credential-store fault) or a `CREDENTIAL_*` code maps to `auth_required`, so editors start their login flow. The message names `nax-agent login <provider>` and `nax auth login` for clients without terminal auth (S5-4 M-32).
- The terminal login UI is nax-agent's `createTerminalAuthInteraction`, shared with `nax auth login` (S5-4 M-28).
```

- [ ] **Step 4: Master plan**

In `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md`:
- In the Slices table, set the S5-4 Plan cell to `2026-10-09-s5-4-auth-release.md`.
- Add this row to the decisions table:

```md
| M-28..M-35 | S5-4 decisions (terminal UI moved to nax-agent, stored-or-ambient credentials, open check, lenient `authenticate`, credential failure codes, login provider set, login CLI shape, release order): see `2026-10-09-s5-4-auth-release.md`. | Recorded with the slice plan. |
```

- [ ] **Step 5: Commit, review, push, PR**

```bash
git add packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md docs/superpowers
git commit -m "docs(acp-server): S5-4 README, changelog, spec and master plan"
```

Run the full gates for all three packages one more time:
- nax-agent and nax-agent-acp: `typecheck`, `check:all`, unit, `test:coverage`, and `test:node` for acp.
- nax: `typecheck`, `lint`, and `test/unit/cli/`.

Then run a whole-branch code review (one reviewer, read-only) before the push. After fixes (at most two rounds), push and open the PR. Title: `feat(acp-server): S5-4 nax-agent login, terminal auth methods and auth_required`. In the body, list M-28..M-35 and point out that `nax auth login` now runs nax-agent's UI (manual check: `nax auth login openrouter`, then Ctrl+C → exit 130).

---

### Task 7: Release nax-ai 0.1.17 (APPROVAL AT LAUNCH)

Runs after the Task 1-6 PR is merged, on clean, up-to-date main. Every push of a tag needs the maintainer's explicit go-ahead at that moment.

- [ ] **Step 1: Ask for approval** to cut nax-ai 0.1.17. It contains the pi-ai 1.1.0 upgrade (#2405), the review bundle E error classification (#2398) and the assistant `origin` field (#2409).

- [ ] **Step 2: Bump with pins in one PR (M-35)**

```bash
cd packages/nax-ai
bun run release --dry-run patch
bun run release patch
```

The script opens a PR from its release branch that bumps only `packages/nax-ai/package.json`. On that branch:

```bash
git switch <release branch printed by the script>
# set "@nathapp/nax-ai": "0.1.17" in packages/nax/package.json and packages/nax-agent/package.json
bun install
(cd packages/nax && bun run check:nax-ai-pin)
git add packages/nax/package.json packages/nax-agent/package.json bun.lock
git commit -m "chore: pin @nathapp/nax-ai 0.1.17 in nax and nax-agent"
git push
```

Expected: `check:nax-ai-pin` passes and the PR's CI is green. The maintainer merges it.

- [ ] **Step 3: Tag (approval again, at launch)**

```bash
git switch main && git pull --ff-only
cd packages/nax-ai && bun run release tag
npm view @nathapp/nax-ai@0.1.17 version
```

Expected: `0.1.17` once the release workflow finishes.

---

### Task 8: Live checks (APPROVAL AT LAUNCH; billed)

- [ ] **Step 1: Ask for approval** for the billed acpx smoke. It is about 3 short prompts on the configured `balanced` model.

- [ ] **Step 2: Build and install the packed tarballs**

On main after Task 7, follow `packages/nax-agent-acp/RELEASING.md` "pack both at one version". In short, from the repo root:

```bash
SMOKE=$(mktemp -d /tmp/nax-agent-smoke-XXXX)
(cd packages/nax-agent && bun run build && bun run stage-publish && npm pack ./.publish --pack-destination "$SMOKE")
(cd packages/nax-agent-acp && bun run build && bun run stage-publish && npm pack ./.publish --pack-destination "$SMOKE")
(cd "$SMOKE" && npm init -y >/dev/null && npm install ./nathapp-nax-agent-*.tgz ./nathapp-nax-agent-acp-*.tgz)
"$SMOKE/node_modules/.bin/nax-agent" --version
```

Expected: `0.3.1`, because the versions are still pre-bump. nax-ai 0.1.17 is installed from npm (`npm ls @nathapp/nax-ai` in `$SMOKE`).

- [ ] **Step 3: acpx smoke**

```bash
WORK=$(mktemp -d /tmp/nax-agent-work-XXXX) && git -C "$WORK" init -q && echo "# smoke" > "$WORK/README.md"
export NAX_AGENT_SESSIONS_DIR="$SMOKE/sessions"
ACPX="npx -y acpx@0.19.4 --cwd $WORK"
BIN="$SMOKE/node_modules/.bin/nax-agent"
$ACPX --approve-all --agent "$BIN acp" "Create hello.txt containing exactly: hi"
cat "$WORK/hello.txt"
$ACPX --agent "$BIN acp" "What does hello.txt contain? Answer in one word."
ls "$NAX_AGENT_SESSIONS_DIR"
```

Expected:
- `hello.txt` holds `hi`.
- The second answer says `hi`, so the session was continued.
- `$NAX_AGENT_SESSIONS_DIR` holds one `*.session.json` and one `*.transcript.json`, with no `.lock` left behind.

If acpx with `--agent` does not keep a session between calls, add a temporary `"nax-agent-smoke": { "argv": ["<BIN>", "acp"] }` entry to `~/.acpx/config.json`. Ask before editing that file, rerun with `acpx nax-agent-smoke ...`, and remove the entry afterwards.

- [ ] **Step 4: auth_required smoke (free, no model call)**

```bash
EMPTY=$(mktemp -d /tmp/nax-agent-noauth-XXXX)
env -u ANTHROPIC_API_KEY NAX_AGENT_CONFIG_DIR="$EMPTY" \
  npx -y acpx@0.19.4 --cwd "$WORK" --agent "$BIN acp --model anthropic/claude-sonnet-5-5" "hi" ; echo "exit=$?"
```

Expected: acpx reports an authentication-required error mentioning `nax-agent login anthropic`, and no tokens are spent. Unset any other variable that serves anthropic in this shell first: `env | grep -i anthropic`.

- [ ] **Step 5: Zed walkthrough (maintainer-driven)**

Configure Zed with the README snippet, with `"command"` set to `$BIN`. The maintainer checks:
1. stream and thinking;
2. an edit shows a diff and a permission prompt, and applying it writes the file;
3. cancel mid-turn;
4. switch mode to `full` and the model to `powerful`; the next turn remembers the conversation;
5. quit Zed, reopen the thread, and the history is replayed;
6. with `NAX_AGENT_CONFIG_DIR` pointed at an empty dir, a new thread offers "Log in to <provider>", the login runs in Zed's terminal, and the retry works.

Fix README wording (Zed config key names) from what is observed, in a small docs PR before Task 9.

- [ ] **Step 6: Record** the commit, model, total cost (from `$NAX_AGENT_SESSIONS_DIR` usage or provider dashboard) and the six Zed checks in the S5 row of `nax-agent-master-plan.md` (maintainer workspace).

---

### Task 9: Release nax-agent and nax-agent-acp 0.4.0 (APPROVAL AT LAUNCH)

- [ ] **Step 1: Ask for approval** to cut 0.4.0 (a minor bump, spec §9: a new binary).

- [ ] **Step 2: Release PR**

```bash
cd packages/nax-agent
bun run release --dry-run minor
bun run release minor
```

Expected: one PR bumping both packages to 0.4.0 and dating both changelogs. The maintainer merges it.

- [ ] **Step 3: Tag nax-agent, then nax-agent-acp (separate approvals at launch)**

```bash
git switch main && git pull --ff-only
cd packages/nax-agent
bun run release tag
npm view @nathapp/nax-agent@0.4.0 version
bun run release --dry-run tag-acp
bun run release tag-acp
npm view @nathapp/nax-agent-acp@0.4.0 version
```

- [ ] **Step 4: Post-release check**

```bash
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null && npm install @nathapp/nax-agent@0.4.0 @nathapp/nax-agent-acp@0.4.0
./node_modules/.bin/nax-agent --version
```

Expected: `0.4.0`. Update the S5 row in `nax-agent-master-plan.md`: S5-4 done, 0.4.0 released, next S5-5 (design addendum first).
