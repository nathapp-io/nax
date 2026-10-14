# Reviewer Sandboxed Bash + ACP Claude Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reviewer ops get real `Bash` inside the sandbox with a post-turn revert of working-tree changes, and ACP Claude sessions that have Bash (`review`, `full`) run under the Claude Agent SDK sandbox mapped from nax's policy (nax#2500).

**Architecture:** A new session profile tier `review` (Bash, no file-write tools) is added end to end (nax-agent facade, nax-agent-acp client, nax profile map). nax's existing per-dispatch sandbox launcher exposes its policy; the policy rides the session-open request to the ACP backend, which maps it to `_meta.claudeCode.options.sandbox`. A reviewer tree guard snapshots the repository before a reviewer turn and restores changed paths, index and refs after the last concurrent reviewer turn ends.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, Biome; packages `nax`, `nax-agent`, `nax-agent-acp`; git CLI; Claude Agent SDK 0.3.286 via claude-agent-acp 0.85.1.

**Spec:** `docs/superpowers/specs/2026-10-13-reviewer-sandboxed-bash-design.md` (rev 2, `368bafed2`). Read it before any task.

## Global Constraints

- Lockstep packages: never bump versions in this branch.
- Source files <= 600 lines; test files <= 800 lines. Grandfathered: `packages/nax/src/session/manager.ts` = 650 (may not grow by a single line). Near limit: `packages/nax/src/runtime/index.ts` 581, `packages/nax/src/operations/adversarial-review.ts` 597, `semantic-review.ts` 577.
- Never bare `bun test` (no path); never `bun run nax`. Targeted: `bun test <file> --timeout=30000` from the package dir.
- No literal `"approve-all"`/`"approve-reads"` outside `src/config/permissions.ts` except consumers tagged `// nax-permission-mode-allow: <reason>`.
- Prompt text only in `packages/nax/src/prompts/builders/`.
- Logger calls in `src/review/`: `storyId` first key.
- Bun-native APIs in nax `src/` (`Bun.file`, `Bun.write`); `node:fs/promises` `rm`/`unlink` is used by existing nax code for deletes and is allowed (see `tree-snapshot/index.ts`).
- `_deps` injection for every spawn/fs call; no `mock.module()`.
- Command-safety guard (#2292) and #2490 rules: no change.
- Commit style: conventional commits, one concern per commit. Pre-push gate (Task 11): root `bun run check:all` + `bun run typecheck` + per-package tests + `bun run test:coverage` in each touched package.

## Review Focus

1. A reviewer edits a file while a sibling reviewer's snapshot is being taken (finish spec + branch review in parallel) — expected: the edit is reverted once, by the last reviewer out (Task 9 concurrency test).
2. A reviewer runs `git stash push` / `git checkout -b x` / `git commit` — expected: stash entry dropped, HEAD and branch ref restored, tree restored (Task 8 tests).
3. Claude under `full` edits a path outside the workdir via `Write` with a relative or `~` path — expected: denied (Task 5 tests).
4. ACP Claude opens `review`/`full` on a host where nax's sandbox probe failed — expected: open fails with a capability error, never runs unsandboxed (Task 4 test).
5. A monorepo story whose session workdir is a package dir — expected: guard keys on the git toplevel and restores repo-root-relative paths (Task 8 test).

---

## File Map

| File | Responsibility | Task |
|---|---|---|
| `packages/nax-agent/src/session/agent-session-types.ts` | `AgentSessionProfile` += `review` | 1 |
| `packages/nax-agent/src/session/agent-session-options.ts` | zod profile enum | 1 |
| `packages/nax-agent/src/session/session-tool-support.ts` | `declaredToolsFor`, `resolveSessionLauncher` | 1 |
| `packages/nax-agent/src/session/native-backend-options.ts` | `nativeProfileRules` | 1 |
| `packages/nax-agent/src/tools/tool-audit.ts` | `ToolSurfaceRecord.profile` widen | 1 |
| `packages/nax-agent/src/sandbox/types.ts` | `SessionSandbox`, `CommandLauncher.policyAt` | 2 |
| `packages/nax-agent/src/sandbox/launcher.ts` | implement `policyAt` | 2 |
| `packages/nax-agent/src/sandbox/session-sandbox.ts` (new) | `sessionSandboxFrom(launcher, root)` | 2 |
| `packages/nax-agent/src/session/session-types.ts` | `OpenSessionOpts.sandbox` | 2 |
| `packages/nax-agent/src/session/session-backend.ts` | `BackendOpenContext.sandbox` | 2 |
| `packages/nax-agent/src/coding-tools/coding-tool-support.ts` | `CodingToolSupport.acpSandbox` | 2 |
| `packages/nax-agent-acp/src/client/capabilities.ts` | `isReadOnlyProfile` += review | 3 |
| `packages/nax-agent-acp/src/client/permissions.ts` | `review` case, network rule, context fields | 3, 5 |
| `packages/nax-agent-acp/src/client/backend.ts` | permission context carries sandbox + cwd | 3 |
| `packages/nax-agent-acp/src/client/claude-sandbox.ts` (new) | policy -> Claude `sandbox` options | 4 |
| `packages/nax-agent-acp/src/client/pre-approval.ts` | `claudeSessionMeta` extras | 4 |
| `packages/nax-agent-acp/src/client/open.ts` | pass sandbox; refuse unavailable | 4 |
| `packages/nax-agent-acp/src/client/edit-targets.ts` (new) | R4 path extraction + check | 5 |
| `packages/nax/src/agents/acp/profile-map.ts` | `review` tier | 6 |
| `packages/nax/src/agents/tool-surface.ts` | profile type widen | 6 |
| `packages/nax/src/agents/acp/open-context.ts` | forward sandbox | 6 |
| `packages/nax/src/agents/coding-tool-support-resolve.ts` | attach `acpSandbox` | 6 |
| `packages/nax/src/session/types.ts`, `open-session-extras.ts` | `sandbox` on open request | 6 |
| `packages/nax/src/operations/build-hop-callback-hop.ts`, `runtime/session-run-hop.ts` | pass `sandbox` | 6 |
| `packages/nax/src/prompts/builders/reviewer-commands-section.ts` (new) | shared prompt section | 7 |
| 7 reviewer op files | `Bash` + `instructions` section | 7 |
| `packages/nax/src/utils/hardened-git.ts` (new) | `runHardenedGit` | 8 |
| `packages/nax/src/review/reviewer-guard/snapshot.ts` (new) | take / restore snapshot | 8 |
| `packages/nax/src/review/reviewer-guard/guard.ts` (new) | refcount, role filter, logging | 9 |
| `packages/nax/src/review/reviewer-guard/index.ts` (new) | barrel | 8 |
| `packages/nax/src/session/turn-hooks.ts`, `session/manager.ts` | `beginTurn` / before hook | 10 |
| `packages/nax/src/runtime/run-turn-hooks.ts` (new), `runtime/index.ts` | wire keeper + guard | 10 |

---

### Task 1: `review` profile in the nax-agent facade

**Files:**
- Modify: `packages/nax-agent/src/session/agent-session-types.ts:17`
- Modify: `packages/nax-agent/src/session/agent-session-options.ts:61`
- Modify: `packages/nax-agent/src/session/session-tool-support.ts` (`declaredToolsFor`, `resolveSessionLauncher`)
- Modify: `packages/nax-agent/src/session/native-backend-options.ts` (`nativeProfileRules`)
- Modify: `packages/nax-agent/src/tools/tool-audit.ts:263`
- Test: `packages/nax-agent/test/unit/session/session-tool-support.test.ts`, `native-backend-options.test.ts`, `agent-session-options.test.ts`

**Interfaces:**
- Produces: `type AgentSessionProfile = "none" | "read" | "review" | "ask" | "full"`; `ToolSurfaceRecord.profile?: "full" | "review" | "read"`.

- [ ] **Step 1: Write failing tests**

Append to `packages/nax-agent/test/unit/session/session-tool-support.test.ts` (reuse the file's existing protected-paths fixture name; if it has none, build one with `gitIgnorePatterns: []`):

```typescript
describe("profile review (nax#2500)", () => {
  test("declares the read tools plus Bash, no write tools", () => {
    const declared = declaredToolsFor("review", { ...PROTECTED, gitIgnorePatterns: [".nax/"] });
    expect(declared).toContain("Bash");
    expect(declared).toContain("Git");
    expect(declared).not.toContain("Write");
    expect(declared).not.toContain("Edit");
    expect(declared).not.toContain("Delete");
    expect(declared).not.toContain("GitCommit");
  });

  test("the sandbox floor applies to review", async () => {
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no srt" });
    await expect(
      resolveSessionLauncher({ profile: "review", root: "/tmp/r", protectedPaths: PROTECTED, bashApproval: "never", allowUnsandboxed: false }),
    ).rejects.toThrow('Profile "review" needs a usable sandbox');
  });
});
```

(Use whatever `bashApproval` non-gated literal the file already uses; restore `_sessionSandboxDeps.probe` in `afterEach` as the file does for other deps.)

Append to `native-backend-options.test.ts`:

```typescript
test("review accepts bashApproval and allowUnsandboxed like full (nax#2500)", () => {
  expect(nativeProfileRules("review", { bashApproval: "gated", allowUnsandboxed: true } as never)).toEqual({
    bashApproval: "gated",
    allowUnsandboxed: true,
  });
});
```

Append to `agent-session-options.test.ts` a case that parses an otherwise valid options object with `profile: "review"` and expects success (copy the file's existing valid-options builder).

- [ ] **Step 2: Run tests, verify they fail**

Run (from `packages/nax-agent`): `bun test test/unit/session/session-tool-support.test.ts test/unit/session/native-backend-options.test.ts test/unit/session/agent-session-options.test.ts --timeout=30000`
Expected: FAIL (type error / `review` rejected / Write present).

- [ ] **Step 3: Implement**

`agent-session-types.ts:17`:
```typescript
export type AgentSessionProfile = "none" | "read" | "review" | "ask" | "full";
```

`agent-session-options.ts:61`:
```typescript
  profile: z.enum(["none", "read", "review", "ask", "full"]),
```

`session-tool-support.ts` `declaredToolsFor` — insert after the `read` line:
```typescript
  if (profile === "review") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, "Bash"];
```
`resolveSessionLauncher` first line:
```typescript
  if (args.profile !== "full" && args.profile !== "ask" && args.profile !== "review") return undefined;
```
Update its doc comment to `"ask", "full" and "review" need a usable sandbox ...`.

`native-backend-options.ts` `nativeProfileRules`:
```typescript
  const tools = profile === "full" || profile === "ask" || profile === "review";
```
and change both error strings to `'... applies to profiles "ask", "full" and "review" only'` (update any existing test asserting the old string).

`tool-audit.ts:263`:
```typescript
  readonly profile?: "full" | "review" | "read";
```

Then run `bun run typecheck` in `packages/nax-agent` and fix every exhaustive switch the compiler reports on `AgentSessionProfile` by giving `review` the `read` behaviour for display/notice purposes and the `full` behaviour for tool/sandbox purposes (record each choice in the commit body).

- [ ] **Step 4: Run tests, verify pass**

Run the Step 2 command, then `bun run typecheck` in `packages/nax-agent`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): session profile review — read tools plus sandboxed Bash (#2500)"
```

---

### Task 2: Sandbox policy accessor and `SessionSandbox` plumbing types (nax-agent)

**Files:**
- Modify: `packages/nax-agent/src/sandbox/types.ts` (after `SandboxPolicy`; `CommandLauncher`)
- Modify: `packages/nax-agent/src/sandbox/launcher.ts` (`createCommandLauncher`)
- Create: `packages/nax-agent/src/sandbox/session-sandbox.ts`
- Modify: `packages/nax-agent/src/sandbox/index.ts`, `packages/nax-agent/src/index.ts` (exports)
- Modify: `packages/nax-agent/src/session/session-types.ts` (`OpenSessionOpts`, near `declaredTools`)
- Modify: `packages/nax-agent/src/session/session-backend.ts:50-68` (`BackendOpenContext`)
- Modify: `packages/nax-agent/src/coding-tools/coding-tool-support.ts:43-59` (`CodingToolSupport`)
- Test: `packages/nax-agent/test/unit/sandbox/session-sandbox.test.ts` (new)

**Interfaces:**
- Produces:
  - `type SessionSandbox = { readonly kind: "policy"; readonly policy: SandboxPolicy } | { readonly kind: "unavailable"; readonly reason: string }`
  - `CommandLauncher.policyAt?(root: string): Promise<SandboxPolicy>`
  - `sessionSandboxFrom(launcher: CommandLauncher | undefined, root: string): Promise<SessionSandbox | undefined>`
  - `OpenSessionOpts.sandbox?: SessionSandbox`; `BackendOpenContext.sandbox?: SessionSandbox`; `CodingToolSupport.acpSandbox?: SessionSandbox`
  - All exported from `@nathapp/nax-agent`.

- [ ] **Step 1: Write the failing test** `packages/nax-agent/test/unit/sandbox/session-sandbox.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createCommandLauncher, DISABLED_SANDBOX_STATE, type SandboxPolicy } from "#src/sandbox/index";
import { sessionSandboxFrom } from "#src/sandbox/session-sandbox";

const POLICY: SandboxPolicy = { writeRoots: ["/r"], denyWrite: ["/r/.git/hooks"], denyRead: ["/home/u/.nax/credentials"], network: {} };
const BACKEND = { name: "srt" as const, probe: async () => ({ available: true as const }), wrap: async () => ["true"] };

describe("sessionSandboxFrom (nax#2500)", () => {
  test("no launcher or a disabled one: no sandbox", async () => {
    expect(await sessionSandboxFrom(undefined, "/r")).toBeUndefined();
    expect(await sessionSandboxFrom(createCommandLauncher({ state: DISABLED_SANDBOX_STATE }), "/r")).toBeUndefined();
  });

  test("unavailable: the reason", async () => {
    const launcher = createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
    expect(await sessionSandboxFrom(launcher, "/r")).toEqual({ kind: "unavailable", reason: "no bwrap" });
  });

  test("available: the policy built for the root, without the session TMPDIR", async () => {
    const seen: [string, boolean][] = [];
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: BACKEND as never,
      policyFor: async (root, tmpDirInForce) => {
        seen.push([root, tmpDirInForce]);
        return POLICY;
      },
    });
    expect(await sessionSandboxFrom(launcher, "/r")).toEqual({ kind: "policy", policy: POLICY });
    expect(seen).toEqual([["/r", false]]);
  });
});
```

(If `SandboxBackend` has a different shape, copy the fake backend used in `packages/nax-agent/test/unit/sandbox/launcher*.test.ts`.)

- [ ] **Step 2: Run, verify fail**

Run (in `packages/nax-agent`): `bun test test/unit/sandbox/session-sandbox.test.ts --timeout=30000` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`sandbox/types.ts`, after `SandboxPolicy`:
```typescript
/**
 * nax#2500: the sandbox an embedder hands a backend that runs its own shell
 * (ACP Claude). Absent = sandbox disabled by config. `unavailable` = enabled but
 * unusable on this host; the backend must refuse rather than run unsandboxed.
 */
export type SessionSandbox =
  | { readonly kind: "policy"; readonly policy: SandboxPolicy }
  | { readonly kind: "unavailable"; readonly reason: string };
```
`CommandLauncher`:
```typescript
export interface CommandLauncher {
  readonly state: SandboxState;
  run(req: LaunchRequest): Promise<LaunchResult>;
  /** nax#2500: the policy this launcher would apply at `root`, without the session TMPDIR. Present when available. */
  policyAt?(root: string): Promise<SandboxPolicy>;
}
```
`launcher.ts` `createCommandLauncher` return object — add after `run`:
```typescript
    ...(opts.policyFor !== undefined
      ? { policyAt: (root: string) => (opts.policyFor as NonNullable<typeof opts.policyFor>)(root, false) }
      : {}),
```
(The `false` keeps `/tmp/claude` writable: Claude's own srt forces that TMPDIR, see the `confined` comment in `coding-tool-sandbox.ts`.)

Create `sandbox/session-sandbox.ts`:
```typescript
/** nax#2500: a launcher's sandbox as plain data for a backend that runs its own shell. */
import type { CommandLauncher, SessionSandbox } from "./types.ts";

export async function sessionSandboxFrom(
  launcher: CommandLauncher | undefined,
  root: string,
): Promise<SessionSandbox | undefined> {
  if (launcher === undefined || launcher.state.kind === "disabled") return undefined;
  if (launcher.state.kind === "unavailable") return { kind: "unavailable", reason: launcher.state.reason };
  if (launcher.policyAt === undefined) return { kind: "unavailable", reason: "the launcher exposes no policy" };
  return { kind: "policy", policy: await launcher.policyAt(root) };
}
```
Export `sessionSandboxFrom` and `type SessionSandbox` from `sandbox/index.ts` and from `src/index.ts` (next to `type SandboxPolicy`).

`session-types.ts` `OpenSessionOpts`, after `declaredTools`:
```typescript
  /** nax#2500: the dispatch sandbox for ACP backends that run their own shell (claude). Native ignores it. */
  sandbox?: import("#src/sandbox/types").SessionSandbox;
```
`session-backend.ts` `BackendOpenContext`, after `openSignal`:
```typescript
  /** nax#2500: present only for profiles review/full when the embedder supplied one. */
  readonly sandbox?: import("#src/sandbox/types").SessionSandbox;
```
`coding-tool-support.ts` `CodingToolSupport`, after `acpDelivery`:
```typescript
  /** nax#2500: the dispatch launcher's sandbox as data, attached by the nax resolver for ACP opens. */
  readonly acpSandbox?: import("#src/sandbox/types").SessionSandbox;
```

- [ ] **Step 4: Run, verify pass** — Step 2 command plus `bun run typecheck` (nax-agent). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): expose the launcher sandbox policy as SessionSandbox (#2500)"
```

---

### Task 3: `review` in the ACP client (read-only enforcement, Bash allowed, network rule)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/capabilities.ts:70` (`isReadOnlyProfile`)
- Modify: `packages/nax-agent-acp/src/client/permissions.ts` (`PermissionContext`, `decidePermission`)
- Modify: `packages/nax-agent-acp/src/client/backend.ts:116` (permission context base)
- Test: `packages/nax-agent-acp/test/unit/client/permissions.test.ts`, `capabilities.test.ts`, `pre-approval.test.ts`

**Interfaces:**
- Consumes: Task 1 `AgentSessionProfile` with `review`; Task 2 `SessionSandbox`, `SandboxPolicy` from `@nathapp/nax-agent`.
- Produces: `PermissionContext` gains `readonly sandbox?: SandboxPolicy; readonly cwd?: string`; exported constants `REVIEW_EXECUTE_REASON = 'profile "review" allows commands'`, `NETWORK_OPEN_REASON = "the sandbox network is open"`, `NETWORK_LISTED_REASON = "the sandbox network is an allow-list"`; exported `isNetworkRequest(toolCall: unknown): boolean`.

- [ ] **Step 1: Write failing tests** — append to `permissions.test.ts` (reuse its `request()` and `asks()` helpers):

```typescript
describe("profile review (nax#2500)", () => {
  const base = (sandbox?: SandboxPolicy) => ({ profile: "review" as const, secrets: [], signal: IDLE, ...(sandbox ? { sandbox } : {}) });
  const OPEN: SandboxPolicy = { writeRoots: ["/r"], denyWrite: [], denyRead: [], network: {} };
  const LISTED: SandboxPolicy = { ...OPEN, network: { allowedDomains: ["pypi.org"] } };

  test("allows an execute request", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "t", kind: "execute", title: "ruff format --check ." }),
      { ...base(OPEN), asks: port },
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "opt-allow_once" } });
    expect(seen.auto[0]?.decision).toBe("allow");
  });

  test("denies an edit request", async () => {
    const { port } = asks();
    const res = await decidePermission(request(["allow_once", "reject_once"]), { ...base(OPEN), asks: port });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "opt-reject_once" } });
  });

  test("network request: allowed when the sandbox network is open, denied under an allow-list", async () => {
    const net = { toolCallId: "n", kind: "other" as const, title: "SandboxNetworkAccess" };
    const { port } = asks();
    expect(await decidePermission(request(["allow_once", "reject_once"], net), { ...base(OPEN), asks: port })).toEqual({
      outcome: { outcome: "selected", optionId: "opt-allow_once" },
    });
    expect(await decidePermission(request(["allow_once", "reject_once"], net), { ...base(LISTED), asks: port })).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("full: network request follows the same rule", async () => {
    const net = { toolCallId: "n", kind: "other" as const, title: "SandboxNetworkAccess" };
    const { port } = asks();
    expect(
      await decidePermission(request(["allow_once", "reject_once"], net), { profile: "full", secrets: [], signal: IDLE, asks: port, sandbox: LISTED }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-reject_once" } });
  });
});
```
Add `import type { SandboxPolicy } from "@nathapp/nax-agent";`.

Append to `capabilities.test.ts`: `readOnlyFor("review", registryEntry("claude"))` equals the claude `readOnly`; `modeFor("review", claude)` equals `{ configId: "mode", value: "default" }`; `unmetRequirement` for codex with profile `review` returns capability `"profile"`.

Append to `pre-approval.test.ts` in the `#2366` describe: `review` gets `READ_ONLY_OPTIONS` exactly like `read` (loop `["none", "read", "review"]`).

- [ ] **Step 2: Run, verify fail** — in `packages/nax-agent-acp`: `bun test test/unit/client/permissions.test.ts test/unit/client/capabilities.test.ts test/unit/client/pre-approval.test.ts --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement**

`capabilities.ts:70`:
```typescript
/** none, read and review (nax#2500) run with the agent's own write tools removed. */
const isReadOnlyProfile = (profile: AgentSessionProfile): boolean =>
  profile === "none" || profile === "read" || profile === "review";
```

`permissions.ts` — add near the reason constants:
```typescript
export const REVIEW_EXECUTE_REASON = 'profile "review" allows commands';
export const NETWORK_OPEN_REASON = "the sandbox network is open";
export const NETWORK_LISTED_REASON = "the sandbox network is an allow-list";
/** claude-agent-acp 0.85.1 surfaces the SDK's sandbox network callback as a tool call titled with its tool name. */
const NETWORK_TOOL_TITLE = "SandboxNetworkAccess";

export function isNetworkRequest(toolCall: unknown): boolean {
  return isRecord(toolCall) && toolCall.title === NETWORK_TOOL_TITLE;
}
```
`PermissionContext` add:
```typescript
  /** nax#2500: the session sandbox policy (review/full on claude); drives the network and R4 path rules. */
  readonly sandbox?: SandboxPolicy;
  /** nax#2500: the session cwd, for resolving relative edit targets (R4). */
  readonly cwd?: string;
```
(import `type SandboxPolicy` from `@nathapp/nax-agent`.)

In `decidePermission`, before `switch (ctx.profile)`:
```typescript
  if ((ctx.profile === "review" || ctx.profile === "full") && ctx.sandbox !== undefined && isNetworkRequest(request.toolCall)) {
    return decideNetwork(ctx.sandbox, offered, auto);
  }
```
Add `case "review":`
```typescript
    case "review":
      if (display.tool !== "execute") {
        auto(readOnlyReason(ctx.profile), "deny");
        return rejectWith(offered);
      }
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      auto(REVIEW_EXECUTE_REASON, "allow");
      return selected(offered.allowOnce);
```
Helper:
```typescript
function decideNetwork(policy: SandboxPolicy, offered: OfferedOptions, auto: AutoDecide): RequestPermissionResponse {
  if (policy.network.allowedDomains !== undefined) {
    auto(NETWORK_LISTED_REASON, "deny");
    return rejectWith(offered);
  }
  if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
  auto(NETWORK_OPEN_REASON, "allow");
  return selected(offered.allowOnce);
}
```
Update the file header comment: review allows execute, rejects the rest; network requests follow the sandbox network.

`backend.ts:116`:
```typescript
  const base = {
    profile: ctx.profile,
    asks: ctx.asks,
    secrets,
    cwd: ctx.workdir,
    ...(ctx.sandbox?.kind === "policy" ? { sandbox: ctx.sandbox.policy } : {}),
  };
```

- [ ] **Step 4: Run, verify pass** — Step 2 command + `bun run typecheck` in `packages/nax-agent-acp`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): profile review — read-only claude, commands allowed; sandbox network rule (#2500)"
```

---

### Task 4: Claude `sandbox` options on open (review + full)

**Files:**
- Create: `packages/nax-agent-acp/src/client/claude-sandbox.ts`
- Modify: `packages/nax-agent-acp/src/client/pre-approval.ts` (`claudeSessionMeta`)
- Modify: `packages/nax-agent-acp/src/client/open.ts` (`sessionSetup`, `establish`)
- Test: `packages/nax-agent-acp/test/unit/client/claude-sandbox.test.ts` (new), `pre-approval.test.ts`, `open.test.ts`

**Interfaces:**
- Consumes: Task 2 `SessionSandbox`, `SandboxPolicy`; `BackendOpenContext.sandbox`.
- Produces: `claudeSandboxOptions(policy: SandboxPolicy): Readonly<Record<string, unknown>>`; `claudeSessionMeta(kind, toolNames, readOnly, extras?: ClaudeMetaExtras)` with `interface ClaudeMetaExtras { readonly sandbox?: SandboxPolicy; readonly lockSkipPermissions?: boolean }`.

- [ ] **Step 1: Write failing tests**

`claude-sandbox.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { claudeSandboxOptions } from "#src/client/claude-sandbox";

describe("claudeSandboxOptions (nax#2500)", () => {
  const base = { writeRoots: ["/r", "/tmp/nax/run"], denyWrite: ["/r/.git/hooks"], denyRead: ["/h/.nax/creds"] };

  test("open network: no network key, every lock set", () => {
    expect(claudeSandboxOptions({ ...base, network: {} })).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["/r", "/tmp/nax/run"], denyWrite: ["/r/.git/hooks"], denyRead: ["/h/.nax/creds"] },
    });
  });

  test("allow-list network: passed through", () => {
    expect(claudeSandboxOptions({ ...base, network: { allowedDomains: ["pypi.org"] } }).network).toEqual({
      allowedDomains: ["pypi.org"],
    });
  });

  test("an empty allow-list is kept (no network)", () => {
    expect(claudeSandboxOptions({ ...base, network: { allowedDomains: [] } }).network).toEqual({ allowedDomains: [] });
  });
});
```
`pre-approval.test.ts` — add:
```typescript
test("review and full carry the sandbox; full also locks skip-permissions (nax#2500)", () => {
  const claude = registryEntry("claude");
  const policy = { writeRoots: ["/r"], denyWrite: [], denyRead: [], network: {} };
  const review = claudeSessionMeta(claude?.preApproval, [], readOnlyFor("review", claude), { sandbox: policy });
  expect((review?.claudeCode as { options: Record<string, unknown> }).options.sandbox).toEqual(claudeSandboxOptions(policy));
  const full = claudeSessionMeta(claude?.preApproval, [], undefined, { sandbox: policy, lockSkipPermissions: true });
  expect(full).toEqual({
    claudeCode: { options: { sandbox: claudeSandboxOptions(policy), allowDangerouslySkipPermissions: false } },
  });
});
```
`open.test.ts` — following its existing fake-link pattern, add two cases:
1. ctx `profile: "full"`, `sandbox: { kind: "policy", policy }` → the `newSession` request `_meta.claudeCode.options.sandbox` equals `claudeSandboxOptions(policy)`.
2. ctx `profile: "review"`, `sandbox: { kind: "unavailable", reason: "no bwrap" }` → open rejects with an `AgentSessionError` whose code is `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and message contains `no bwrap`; `newSession` never called.
3. ctx `profile: "read"` with a policy → no `sandbox` key in `_meta`.

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/client/claude-sandbox.test.ts test/unit/client/pre-approval.test.ts test/unit/client/open.test.ts --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement**

`claude-sandbox.ts`:
```typescript
/**
 * nax#2500: nax's sandbox policy as the Claude Agent SDK `sandbox` session option
 * (SDK 0.3.286 SandboxSettings; claude-agent-acp 0.85.1 passes it through and
 * rebuilds the session when it changes). Same srt engine as nax's own launcher.
 * Network: nax's absent allow-list means open, so no `network` key is sent and the
 * permission layer answers Claude's network requests (permissions.ts).
 */
import type { SandboxPolicy } from "@nathapp/nax-agent";

export function claudeSandboxOptions(policy: SandboxPolicy): Readonly<Record<string, unknown>> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [...policy.writeRoots],
      denyWrite: [...policy.denyWrite],
      denyRead: [...policy.denyRead],
    },
    ...(policy.network.allowedDomains === undefined
      ? {}
      : { network: { allowedDomains: [...policy.network.allowedDomains] } }),
  };
}
```
`pre-approval.ts`:
```typescript
export interface ClaudeMetaExtras {
  /** nax#2500: the session sandbox (profiles review and full). */
  readonly sandbox?: SandboxPolicy;
  /** nax#2500: profile full pins allowDangerouslySkipPermissions false. */
  readonly lockSkipPermissions?: boolean;
}

export function claudeSessionMeta(
  kind: AgentRegistryEntry["preApproval"],
  toolNames: readonly string[],
  readOnly: ReadOnlyEnforcement | undefined,
  extras: ClaudeMetaExtras = {},
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  const options = {
    ...(toolNames.length === 0 ? {} : { allowedTools: toolNames.map(mcpToolRule) }),
    ...(readOnly === undefined ? {} : { disallowedTools: [...readOnly.disallowedTools], ...readOnly.sessionOptions }),
    ...(extras.sandbox === undefined ? {} : { sandbox: claudeSandboxOptions(extras.sandbox) }),
    ...(extras.lockSkipPermissions === true ? { allowDangerouslySkipPermissions: false } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : { claudeCode: { options } };
}
```
`open.ts` — in `establish`, right after the `unmetRequirement` check:
```typescript
  const sandbox = sandboxFor(o.ctx);
```
where (module-level):
```typescript
/** nax#2500: review/full sessions with an embedder sandbox; an unusable one refuses the open. */
function sandboxFor(ctx: BackendOpenContext): SandboxPolicy | undefined {
  if (ctx.profile !== "review" && ctx.profile !== "full") return undefined;
  if (ctx.sandbox === undefined) return undefined;
  if (ctx.sandbox.kind === "unavailable") {
    throw capabilityUnsupported("profile", `the sandbox is unavailable: ${ctx.sandbox.reason}`);
  }
  return ctx.sandbox.policy;
}
```
Pass it into `sessionSetup(o, sandbox)` and change `sessionSetup`'s `claudeSessionMeta` call to:
```typescript
  const meta = claudeSessionMeta(kind, o.ctx.tools.map((tool) => tool.name), readOnlyFor(o.ctx.profile, o.options.entry), {
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(o.ctx.profile === "full" ? { lockSkipPermissions: true } : {}),
  });
```
The resume path (`restoreSession` via `resume.ts`) reuses `setup`, so it carries the same `_meta`; confirm by reading `resume.ts` and add a resume case to `open.test.ts` asserting `_meta.claudeCode.options.sandbox` on `session/resume` or `session/load`.

Note: `sessionSetup` with no host and meta now non-undefined for `full` without tools is correct (the existing `meta === undefined` branch is unaffected). Update the existing pre-approval test "ask and full: only the tool rules, and nothing without tools" only if it calls with the new extras (it does not; leave it).

- [ ] **Step 4: Run, verify pass** — Step 2 command, then `bun run test` and `bun run typecheck` in `packages/nax-agent-acp`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): run claude review/full sessions under the SDK sandbox from nax's policy (#2500)"
```

---

### Task 5: R4 — path-check Claude edit requests under `full`

**Files:**
- Create: `packages/nax-agent-acp/src/client/edit-targets.ts`
- Modify: `packages/nax-agent-acp/src/client/permissions.ts` (`case "full"`)
- Modify: `packages/nax-agent-acp/src/client/tool-display.ts` header comment (D3-a override note)
- Test: `packages/nax-agent-acp/test/unit/client/edit-targets.test.ts` (new), `permissions.test.ts`

**Interfaces:**
- Consumes: Task 3 `PermissionContext.sandbox`, `.cwd`.
- Produces: `editTargets(toolCall: unknown): readonly string[]`; `firstOutsidePolicy(targets: readonly string[], policy: SandboxPolicy, cwd: string): Promise<string | undefined>`; `OUTSIDE_WRITE_ROOTS_REASON = "the edit target is outside the sandbox write roots"`.

- [ ] **Step 1: Write failing tests** `edit-targets.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { editTargets, firstOutsidePolicy } from "#src/client/edit-targets";

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nax-edit-root-"));
  outside = await mkdtemp(join(tmpdir(), "nax-edit-out-"));
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await symlink(outside, join(root, "escape"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
const policy = () => ({ writeRoots: [root], denyWrite: [join(root, ".git", "hooks")], denyRead: [], network: {} });

describe("editTargets", () => {
  test("locations, file_path and notebook_path, de-duplicated", () => {
    expect(
      editTargets({ locations: [{ path: "/a" }, { path: "/b" }], rawInput: { file_path: "/a", notebook_path: "/c" } }),
    ).toEqual(["/a", "/b", "/c"]);
  });
  test("nothing usable: empty", () => {
    expect(editTargets({ title: "Edit" })).toEqual([]);
  });
});

describe("firstOutsidePolicy", () => {
  test("inside the root: undefined", async () => {
    expect(await firstOutsidePolicy([join(root, "src", "new.ts")], policy(), root)).toBeUndefined();
  });
  test("relative path resolves against cwd", async () => {
    expect(await firstOutsidePolicy(["src/a.ts"], policy(), root)).toBeUndefined();
    expect(await firstOutsidePolicy(["../elsewhere.ts"], policy(), root)).toBe("../elsewhere.ts");
  });
  test("~ expands to home (outside the root)", async () => {
    expect(await firstOutsidePolicy(["~/x.txt"], policy(), root)).toBe("~/x.txt");
    expect(homedir().startsWith(root)).toBe(false);
  });
  test("under denyWrite: the path", async () => {
    expect(await firstOutsidePolicy([join(root, ".git", "hooks", "pre-commit")], policy(), root)).toBe(
      join(root, ".git", "hooks", "pre-commit"),
    );
  });
  test("symlink escape out of the root is caught", async () => {
    expect(await firstOutsidePolicy([join(root, "escape", "f.txt")], policy(), root)).toBe(join(root, "escape", "f.txt"));
  });
  test("one bad target among several: the bad one", async () => {
    expect(await firstOutsidePolicy([join(root, "ok.ts"), "/etc/passwd"], policy(), root)).toBe("/etc/passwd");
  });
});
```
`permissions.test.ts` — add under a `describe("full: R4 edit path check (nax#2500)")`:
- an `edit` request with `locations: [{ path: "/etc/x" }]`, ctx `{ profile: "full", sandbox: policy, cwd: root }` → reject_once, auto reason `OUTSIDE_WRITE_ROOTS_REASON`.
- an `edit` request inside root → allow_once.
- an `edit` request with no path → allow_once (today's behaviour).
- `full` with no `sandbox` in ctx → allow_once for `/etc/x` (unchanged without a policy).
- an `execute` request under `full` with a policy → allow_once (Bash is the sandbox's job).

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/client/edit-targets.test.ts test/unit/client/permissions.test.ts --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement** `edit-targets.ts`:

```typescript
/**
 * nax#2500 R4: Claude's Write/Edit/MultiEdit/NotebookEdit are not covered by the
 * Bash sandbox, so under profile full their permission requests are checked
 * against the same write roots. This reads the request's display fields
 * (locations, rawInput paths) to DECIDE, deliberately overriding the D3-a "display
 * only" rule in tool-display.ts: there is no other source for the target path.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SandboxPolicy } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";

export const OUTSIDE_WRITE_ROOTS_REASON = "the edit target is outside the sandbox write roots";
const RAW_PATH_KEYS = ["file_path", "notebook_path"] as const;

export function editTargets(toolCall: unknown): readonly string[] {
  if (!isRecord(toolCall)) return [];
  const fromLocations = Array.isArray(toolCall.locations)
    ? toolCall.locations.flatMap((l: unknown) => (isRecord(l) && typeof l.path === "string" && l.path !== "" ? [l.path] : []))
    : [];
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const fromRaw = RAW_PATH_KEYS.flatMap((k) => (typeof raw[k] === "string" && raw[k] !== "" ? [raw[k] as string] : []));
  return [...new Set([...fromLocations, ...fromRaw])];
}

function expand(path: string, cwd: string): string {
  if (path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Realpath of the deepest existing ancestor, with the missing tail re-appended. */
async function canonical(path: string): Promise<string> {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export async function firstOutsidePolicy(
  targets: readonly string[],
  policy: SandboxPolicy,
  cwd: string,
): Promise<string | undefined> {
  const roots = await Promise.all(policy.writeRoots.map(canonical));
  const denied = await Promise.all(policy.denyWrite.map(canonical));
  for (const target of targets) {
    const real = await canonical(expand(target, cwd));
    if (denied.some((d) => within(real, d)) || !roots.some((r) => within(real, r))) return target;
  }
  return undefined;
}
```
(Fix `tail.reverse()` mutation if Biome objects: build `tail` with `unshift` instead and join directly.)

`permissions.ts` `case "full":` becomes:
```typescript
    case "full": {
      if (offered.allowOnce === undefined) return denyNoAllowOnce(offered, auto);
      const outside =
        ctx.sandbox !== undefined && display.tool !== "execute"
          ? await firstOutsidePolicy(editTargets(request.toolCall), ctx.sandbox, ctx.cwd ?? process.cwd())
          : undefined;
      if (outside !== undefined) {
        auto(OUTSIDE_WRITE_ROOTS_REASON, "deny");
        return rejectWith(offered);
      }
      auto(FULL_REASON, "allow");
      return selected(offered.allowOnce);
    }
```
(`ctx.cwd` is always set by `backend.ts` from Task 3; the `process.cwd()` fallback exists only for type completeness — if the package forbids `process.cwd()`, use `ctx.cwd ?? "/"` and note it.)

`tool-display.ts` header: append one sentence: "Exception (nax#2500 R4): `edit-targets.ts` reads `locations`/`rawInput` paths to decide a full-profile edit, because no other source names the target."

- [ ] **Step 4: Run, verify pass** — Step 2 command + `bun run test` + `bun run typecheck` in `packages/nax-agent-acp`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): deny claude edits outside the sandbox write roots under full (#2500 R4)"
```

---

### Task 6: nax — `review` tier in the profile map and sandbox plumbing to the ACP open

**Files:**
- Modify: `packages/nax/src/agents/acp/profile-map.ts`
- Modify: `packages/nax/src/agents/tool-surface.ts:68`
- Modify: `packages/nax/src/agents/coding-tool-support-resolve.ts` (`resolveCodingToolSupport` tail)
- Modify: `packages/nax/src/session/types.ts:159` (OpenSessionRequest), `packages/nax/src/session/open-session-extras.ts`
- Modify: `packages/nax/src/operations/build-hop-callback-hop.ts:~420`, `packages/nax/src/runtime/session-run-hop.ts:~92`
- Modify: `packages/nax/src/agents/acp/open-context.ts` (`openContext`)
- Test: `packages/nax/test/unit/agents/acp/profile-map.test.ts`, `open-context.test.ts`, `packages/nax/test/unit/session/open-session-extras.test.ts`, a resolver test (find with `grep -rl "attachAcpDelivery\|acpDelivery" packages/nax/test`)

**Interfaces:**
- Consumes: Task 2 `sessionSandboxFrom`, `SessionSandbox`, `CodingToolSupport.acpSandbox`; Task 1 profile.
- Produces: `type AcpProfile = "full" | "review" | "read"`; `ACP_FILE_WRITE_TOOLS`, `ACP_COMMAND_TOOLS` (replacing `ACP_WRITE_CLASS_TOOLS`); `OpenSessionRequest.sandbox?: SessionSandbox`.

- [ ] **Step 1: Write failing tests**

Replace the test "git-write and command tools count as write-class" in `profile-map.test.ts` with:
```typescript
  test("file-write tools keep the mode's profile (nax#2500)", () => {
    expect(acpProfileFor("approve-all", ["Read", "GitCommit"])).toBe("full");
    expect(acpProfileFor("approve-all", ["Read", "Write", "Bash"])).toBe("full");
  });

  test("command tools without file-write tools open review (nax#2500)", () => {
    expect(acpProfileFor("approve-all", ["Read", "Glob", "Grep", "Git", "Bash"])).toBe("review");
    expect(acpProfileFor("approve-all", ["Read", "Exec", "RunCommand"])).toBe("review");
  });

  test("review is never wider than the mode", () => {
    expect(acpProfileFor("approve-reads", ["Read", "Bash"])).toBe("read");
    expect(acpProfileFor("default", ["Read", "Bash"])).toBe("read");
  });
```
`open-context.test.ts` — add: opts with `declaredTools: ["Read","Bash"]`, `resolvedPermissions.mode: "approve-all"`, `sandbox: { kind: "policy", policy }` → `openContext(...).profile === "review"` and `.sandbox` equals the input; same opts with `declaredTools: ["Read"]` → `.sandbox` undefined (read never carries it).
`open-session-extras.test.ts` — `sandbox` is forwarded when present, absent when absent.
Resolver test — with a stubbed launcher dep returning an available launcher whose `policyAt` resolves `POLICY`, `resolveCodingToolSupport` returns `acpSandbox: { kind: "policy", policy: POLICY }`; with the sandbox disabled, `acpSandbox` is absent.

- [ ] **Step 2: Run, verify fail** — in `packages/nax`: `bun test test/unit/agents/acp/profile-map.test.ts test/unit/agents/acp/open-context.test.ts test/unit/session/open-session-extras.test.ts <resolver test> --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement**

`profile-map.ts`:
```typescript
export type AcpProfile = "full" | "review" | "read";

/** Declared tools that write files or git state: their presence keeps the mode's profile. */
export const ACP_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete", "GitCommit"]);
/** Declared tools that run commands: without a file-write tool they open `review` (nax#2500). */
export const ACP_COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "Exec", "RunCommand"]);

export function acpProfileFor(mode: ResolvedPermissions["mode"], declaredTools?: readonly string[]): AcpProfile {
  const modeProfile = PROFILE_BY_MODE[mode];
  if (declaredTools === undefined || declaredTools.length === 0) return modeProfile;
  if (modeProfile === "read") return "read";
  if (declaredTools.some((tool) => ACP_FILE_WRITE_TOOLS.has(tool))) return modeProfile;
  return declaredTools.some((tool) => ACP_COMMAND_TOOLS.has(tool)) ? "review" : "read";
}
```
Update the header comment (three tiers; review = Bash without file writes, never wider than the mode). `grep -rn ACP_WRITE_CLASS_TOOLS packages/` and update every reference.

`tool-surface.ts:68`: `profile?: "full" | "review" | "read",` (or `AcpProfile` via a type import if no cycle).

`coding-tool-support-resolve.ts`, replace the last two lines of `resolveCodingToolSupport`:
```typescript
  if (support === undefined) return undefined;
  const acpSandbox = await sessionSandboxFrom(launcher, options.codingToolRoot ?? "");
  const withSandbox = acpSandbox === undefined ? support : { ...support, acpSandbox };
  return attachAcpDelivery(withSandbox, surface);
```
(import `sessionSandboxFrom` from `@nathapp/nax-agent`; `launcher` is undefined when no root, so the `?? ""` path never builds a policy. Confirm `attachAcpDelivery` spreads its input; if it rebuilds the object, attach `acpSandbox` after it instead.)

`session/types.ts` OpenSessionRequest, after `declaredTools`:
```typescript
  /** nax#2500: dispatch sandbox for ACP backends that run their own shell. */
  sandbox?: import("@nathapp/nax-agent").SessionSandbox;
```
`open-session-extras.ts`: add `| "sandbox"` to both `Pick` unions and `...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),` after `declaredTools`.

`build-hop-callback-hop.ts` `openSessionRequest`, after the `declaredTools` spread:
```typescript
    ...(codingSupport?.acpSandbox !== undefined ? { sandbox: codingSupport.acpSandbox } : {}),
```
`session-run-hop.ts` `openSession(...)` options, same spread (it has `codingSupport` in scope; add `...(codingSupport?.declaredTools !== undefined ? { declaredTools: codingSupport.declaredTools } : {})` too if that path lacks it — check first; if absent, leave declaredTools as is and add only sandbox, noting it in the commit).

`open-context.ts` `openContext` return, after `openSignal`:
```typescript
    ...((profile === "review" || profile === "full") && opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
```

- [ ] **Step 4: Run, verify pass** — Step 2 command, then `bun run typecheck` in `packages/nax`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax
git commit -m "feat(acp): review profile tier and dispatch sandbox on ACP opens (#2500)"
```

---

### Task 7: Reviewer ops declare `Bash`; shared verification prompt section

**Files:**
- Create: `packages/nax/src/prompts/builders/reviewer-commands-section.ts`; export from `packages/nax/src/prompts/index.ts`
- Modify: `packages/nax/src/operations/semantic-review.ts:331,~359`, `adversarial-review.ts:288,build`, `finish-spec-review.ts:36,~42`, `finish-branch-review.ts:37,~43`, `workflow-story-review.ts:18,~31`, `workflow-re-review.ts` build, `workflow-branch-review.ts` build
- Test: `packages/nax/test/unit/prompts/reviewer-commands-section.test.ts` (new), `packages/nax/test/unit/operations/reviewer-tools.test.ts` (new)

**Interfaces:**
- Produces: `REVIEWER_VERIFY_TOOLS = ["Read", "Glob", "Grep", "Git", "Bash"] as const` (in `workflow-story-review.ts`, replacing `WORKFLOW_REVIEW_TOOLS`'s value but keeping the name `WORKFLOW_REVIEW_TOOLS` as an alias export for existing imports); `reviewerCommandsSection(): PromptSection`.

- [ ] **Step 1: Write failing tests**

`reviewer-commands-section.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { reviewerCommandsSection } from "@/prompts";

describe("reviewerCommandsSection (nax#2500)", () => {
  test("is a fixed, non-overridable instructions section that says edits are reverted", () => {
    const s = reviewerCommandsSection();
    expect(s.id).toBe("reviewer-commands");
    expect(s.overridable).toBe(false);
    expect(s.content).toContain("check mode");
    expect(s.content).toContain("reverted");
  });
});
```
`reviewer-tools.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import {
  adversarialReviewOp,
  finishBranchReviewOp,
  finishSpecReviewOp,
  fixReviewOp,
  semanticReviewOp,
  workflowBranchReviewOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";

describe("reviewer ops declare Bash (nax#2500)", () => {
  test.each([
    ["semantic", semanticReviewOp],
    ["adversarial", adversarialReviewOp],
    ["finish-spec", finishSpecReviewOp],
    ["finish-branch", finishBranchReviewOp],
    ["wf-story", workflowStoryReviewOp],
    ["wf-re", workflowReReviewOp],
    ["wf-branch", workflowBranchReviewOp],
  ])("%s", (_name, op) => {
    expect(op.tools).toEqual(["Read", "Glob", "Grep", "Git", "Bash"]);
  });

  test("fix-review is unchanged", () => {
    expect(fixReviewOp.tools).toEqual(["Read", "Glob", "Grep"]);
  });
});
```
(Use the actual exported op names from `src/operations/index.ts`; adjust imports to match.)

Also add, in the existing build tests for each op if present (grep `build(` tests), or in `reviewer-tools.test.ts`: each op's `build(...)` result has `instructions.id === "reviewer-commands"` (construct minimal inputs by copying from the op's existing unit test).

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/prompts/reviewer-commands-section.test.ts test/unit/operations/reviewer-tools.test.ts --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement**

`reviewer-commands-section.ts`:
```typescript
/** nax#2500: reviewers may run commands to verify; the tree is restored after each turn. */
import type { PromptSection } from "../core";

const CONTENT = [
  "## Verifying with commands",
  "",
  "You may run shell commands to verify what you review: formatters and linters in check mode",
  "(for example `--check` or `--diff`), a linter on one file, a scoped test run, and read-only git",
  "(`git diff`, `git log`, `git show`, `git blame`). Commands run inside a sandbox.",
  "Do not edit files or git state. Any change you make to the working tree, the index, branches or",
  "the stash is reverted after your turn, and the revert is logged.",
].join("\n");

export function reviewerCommandsSection(): PromptSection {
  return { id: "reviewer-commands", content: CONTENT, overridable: false };
}
```
(Confirm the `PromptSection` import path used by sibling builders; copy it.) Export from `src/prompts/index.ts`.

Each of the 7 ops: set `tools: [...REVIEWER_VERIFY_TOOLS]` (or the literal array where the op does not import from `workflow-story-review.ts`; for semantic/adversarial use the literal to avoid a new import edge) and add `instructions: reviewerCommandsSection(),` to the object their `build` returns. For `adversarial-review.ts` (597 lines) the change must be net <= +2 lines; if it would exceed 600, move the `build` return into a one-line spread or shorten an adjacent comment, never exceed 600.

`workflow-story-review.ts`:
```typescript
export const REVIEWER_VERIFY_TOOLS = ["Read", "Glob", "Grep", "Git", "Bash"] as const;
/** @deprecated alias kept for existing imports; same value as REVIEWER_VERIFY_TOOLS. */
export const WORKFLOW_REVIEW_TOOLS = REVIEWER_VERIFY_TOOLS;
```

- [ ] **Step 4: Run the gates that Bash-declaring ops trigger**

Run in `packages/nax`:
```bash
bun run scripts/check-bash-dispatch-ask.ts
bun run scripts/check-op-tool-capability.ts
bun run check:file-sizes
```
Expected: PASS. If `check-bash-dispatch-ask` reports a bare site that now dispatches a reviewer op, wire it with `buildDispatchAskWiring` / `buildRunDispatchAskWiring` (see the script header) rather than allowlisting; if an `ALLOWED_BARE_SITES` entry now references a reviewer op, remove the entry and wire the site.

Then the Step 2 command again, and the existing op tests: `bun test test/unit/operations --timeout=60000`. Expected: PASS (update snapshot-style assertions of the old tool arrays).

- [ ] **Step 5: Commit**

```bash
git add packages/nax
git commit -m "feat(review): reviewers declare sandboxed Bash with a shared verification section (#2500)"
```

---

### Task 8: Reviewer tree snapshot and restore (git mechanics)

**Files:**
- Create: `packages/nax/src/utils/hardened-git.ts`
- Create: `packages/nax/src/review/reviewer-guard/snapshot.ts`
- Create: `packages/nax/src/review/reviewer-guard/index.ts` (barrel; Task 9 adds to it)
- Test: `packages/nax/test/unit/review/reviewer-guard/snapshot.test.ts` (new; real temp git repos)

**Interfaces:**
- Consumes: `snapshotWorkingTree`, `changedPathsBetween` from `@/review/fix-review/tree-snapshot`.
- Produces:
  - `runHardenedGit(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>` with `_hardenedGitDeps = { spawn: typedSpawn, timeoutMs: 30_000 }`
  - `interface RepoSnapshot { readonly toplevel: string; readonly tree: string; readonly indexTree: string; readonly head: string; readonly symbolicHead: string | undefined; readonly stashes: readonly string[] }`
  - `takeRepoSnapshot(workdir: string): Promise<RepoSnapshot>`
  - `interface RestoreReport { readonly paths: readonly string[]; readonly indexRestored: boolean; readonly headRestored: boolean; readonly stashesDropped: number }`
  - `restoreRepoSnapshot(snap: RepoSnapshot): Promise<RestoreReport>`
  - `isRunStatePath(path: string): boolean` (true for `.nax/...` and `.../.nax/...`)

- [ ] **Step 1: Write failing tests** `snapshot.test.ts` (each test builds a fresh repo with `git init`, one commit, a `.gitignore` with `ignored/`):

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunStatePath, restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nax-rguard-"));
  dirs.push(d);
  await git(d, "init", "-q", "-b", "main");
  await writeFile(join(d, ".gitignore"), "ignored/\n");
  await writeFile(join(d, "a.txt"), "a\n");
  await mkdir(join(d, "pkg"), { recursive: true });
  await writeFile(join(d, "pkg", "b.txt"), "b\n");
  await git(d, "add", "-A");
  await git(d, "commit", "-q", "-m", "seed");
  return d;
}

describe("reviewer tree snapshot (nax#2500)", () => {
  test("clean tree, nothing changed: no-op report", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    expect(await restoreRepoSnapshot(snap)).toEqual({ paths: [], indexRestored: false, headRestored: false, stashesDropped: 0 });
  });

  test("tracked edit is restored; staged-vs-unstaged split preserved", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "staged\n");
    await git(d, "add", "a.txt");
    await writeFile(join(d, "a.txt"), "staged+unstaged\n");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "reviewer edit\n");
    await git(d, "add", "a.txt");
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual(["a.txt"]);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("staged+unstaged\n");
    expect(await git(d, "show", ":a.txt")).toBe("staged");
  });

  test("new untracked file deleted; pre-existing untracked file restored; ignored path kept", async () => {
    const d = await repo();
    await writeFile(join(d, "pre.txt"), "pre\n");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "pre.txt"), "changed\n");
    await writeFile(join(d, "new.txt"), "new\n");
    await mkdir(join(d, "ignored"), { recursive: true });
    await writeFile(join(d, "ignored", "cache"), "x\n");
    const report = await restoreRepoSnapshot(snap);
    expect([...report.paths].sort()).toEqual(["new.txt", "pre.txt"]);
    expect(existsSync(join(d, "new.txt"))).toBe(false);
    expect(await readFile(join(d, "pre.txt"), "utf8")).toBe("pre\n");
    expect(existsSync(join(d, "ignored", "cache"))).toBe(true);
    expect(await git(d, "status", "--porcelain")).toBe("?? pre.txt");
  });

  test(".nax paths are left to the run-state keeper", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await mkdir(join(d, ".nax"), { recursive: true });
    await writeFile(join(d, ".nax", "x.json"), "{}\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual([]);
    expect(existsSync(join(d, ".nax", "x.json"))).toBe(true);
    expect(isRunStatePath(".nax/x.json")).toBe(true);
    expect(isRunStatePath("packages/p/.nax/y")).toBe(true);
    expect(isRunStatePath("src/nax.ts")).toBe(false);
  });

  test("a commit by the reviewer is undone (HEAD and branch ref restored)", async () => {
    const d = await repo();
    const before = await git(d, "rev-parse", "HEAD");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "x\n");
    await git(d, "commit", "-qam", "reviewer");
    const report = await restoreRepoSnapshot(snap);
    expect(report.headRestored).toBe(true);
    expect(await git(d, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("checkout -b by the reviewer: HEAD re-pointed at the original branch", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await git(d, "checkout", "-q", "-b", "side");
    await restoreRepoSnapshot(snap);
    expect(await git(d, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  test("stash push by the reviewer: entry dropped and tree restored", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "wip\n");
    const snap = await takeRepoSnapshot(d);
    await git(d, "stash", "push", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(report.stashesDropped).toBe(1);
    expect(await git(d, "stash", "list")).toBe("");
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("wip\n");
  });

  test("package workdir maps to the toplevel; paths are repo-root-relative", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(join(d, "pkg"));
    expect(snap.toplevel).toBe(await git(d, "rev-parse", "--show-toplevel"));
    await writeFile(join(d, "a.txt"), "edit from pkg session\n");
    expect((await restoreRepoSnapshot(snap)).paths).toEqual(["a.txt"]);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/review/reviewer-guard/snapshot.test.ts --timeout=60000`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`utils/hardened-git.ts` — copy the `runGit` body from `src/review/fix-review/tree-snapshot/index.ts:83-115` into:
```typescript
/** A hardened git call (hardenedGitArgv + gitSpawnEnv) with a SIGKILL timeout. Used by the reviewer guard (nax#2500). */
import { gitSpawnEnv, hardenedGitArgv } from "@nathapp/nax-agent/internal";
import { type SpawnOptions, type SpawnResult, typedSpawn } from "@/utils/bun-deps";

export const _hardenedGitDeps: {
  spawn: (cmd: string[], opts: SpawnOptions) => SpawnResult;
  timeoutMs: number;
} = { spawn: typedSpawn, timeoutMs: 30_000 };

export interface HardenedGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function runHardenedGit(args: readonly string[], cwd: string): Promise<HardenedGitResult> {
  // body: identical to tree-snapshot runGit with indexOverlay undefined and
  // timeoutMs = _hardenedGitDeps.timeoutMs, spawning via _hardenedGitDeps.spawn.
}
```
(Write the full body; do not leave the comment. `setTimeout` is permitted here per the forbidden-patterns exception; keep the existing call-site comment.)

`review/reviewer-guard/snapshot.ts`:
```typescript
/**
 * nax#2500: snapshot and restore a repository around reviewer turns. The working
 * tree (tracked + untracked, .gitignore honoured) is captured as a tree object
 * without touching the real index (snapshotWorkingTree); the index as its own tree;
 * HEAD, its symbolic ref and the stash list as ids. Restore touches only paths
 * that changed, never .nax run state (the #2497 keeper owns it) and never ignored paths.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { changedPathsBetween, snapshotWorkingTree } from "@/review/fix-review/tree-snapshot";
import { runHardenedGit } from "@/utils/hardened-git";

export interface RepoSnapshot {
  readonly toplevel: string;
  readonly tree: string;
  readonly indexTree: string;
  readonly head: string;
  readonly symbolicHead: string | undefined;
  readonly stashes: readonly string[];
}

export interface RestoreReport {
  readonly paths: readonly string[];
  readonly indexRestored: boolean;
  readonly headRestored: boolean;
  readonly stashesDropped: number;
}

export const _snapshotDeps = { rm, snapshotWorkingTree, changedPathsBetween, git: runHardenedGit };

const STAGE = "reviewer-guard";

async function git(args: readonly string[], cwd: string, allowFail = false): Promise<string> {
  const r = await _snapshotDeps.git(args, cwd);
  if (r.exitCode !== 0 && !allowFail) {
    throw new NaxError(`[${STAGE}] git ${args.join(" ")} failed: ${r.stderr.trim()}`, "REVIEWER_GUARD_GIT_FAILED", {
      stage: STAGE,
      cwd,
    });
  }
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

export function isRunStatePath(path: string): boolean {
  return path === ".nax" || path.startsWith(".nax/") || path.includes("/.nax/");
}

export async function takeRepoSnapshot(workdir: string): Promise<RepoSnapshot> {
  const toplevel = await git(["rev-parse", "--show-toplevel"], workdir);
  const [tree, indexTree, head, symbolic, stashList] = await Promise.all([
    _snapshotDeps.snapshotWorkingTree(toplevel),
    git(["write-tree"], toplevel),
    git(["rev-parse", "HEAD"], toplevel),
    git(["symbolic-ref", "-q", "HEAD"], toplevel, true),
    git(["stash", "list", "--format=%H"], toplevel),
  ]);
  return {
    toplevel,
    tree,
    indexTree,
    head,
    symbolicHead: symbolic === "" ? undefined : symbolic,
    stashes: stashList === "" ? [] : stashList.split("\n"),
  };
}

async function restoreRefs(snap: RepoSnapshot): Promise<boolean> {
  const head = await git(["rev-parse", "HEAD"], snap.toplevel);
  const symbolic = (await git(["symbolic-ref", "-q", "HEAD"], snap.toplevel, true)) || undefined;
  let changed = false;
  if (snap.symbolicHead !== undefined) {
    const branchSha = await git(["rev-parse", snap.symbolicHead], snap.toplevel);
    if (branchSha !== snap.head) {
      await git(["update-ref", snap.symbolicHead, snap.head], snap.toplevel);
      changed = true;
    }
    if (symbolic !== snap.symbolicHead) {
      await git(["symbolic-ref", "HEAD", snap.symbolicHead], snap.toplevel);
      changed = true;
    }
  } else if (head !== snap.head || symbolic !== undefined) {
    await git(["update-ref", "--no-deref", "HEAD", snap.head], snap.toplevel);
    changed = true;
  }
  return changed;
}

async function dropNewStashes(snap: RepoSnapshot): Promise<number> {
  const now = await git(["stash", "list", "--format=%H"], snap.toplevel);
  const added = (now === "" ? [] : now.split("\n")).filter((sha) => !snap.stashes.includes(sha));
  for (const sha of added) {
    const list = (await git(["stash", "list", "--format=%H"], snap.toplevel)).split("\n");
    const at = list.indexOf(sha);
    if (at >= 0) await git(["stash", "drop", "-q", `stash@{${at}}`], snap.toplevel);
  }
  return added.length;
}

export async function restoreRepoSnapshot(snap: RepoSnapshot): Promise<RestoreReport> {
  const headRestored = await restoreRefs(snap);
  const stashesDropped = await dropNewStashes(snap);
  const current = await _snapshotDeps.snapshotWorkingTree(snap.toplevel);
  const changed = (await _snapshotDeps.changedPathsBetween(snap.toplevel, snap.tree, current)).filter(
    (p) => !isRunStatePath(p),
  );
  const inSnapshot = await Promise.all(
    changed.map(async (p) => (await _snapshotDeps.git(["cat-file", "-e", `${snap.tree}:${p}`], snap.toplevel)).exitCode === 0),
  );
  const restore = changed.filter((_, i) => inSnapshot[i]);
  const remove = changed.filter((_, i) => !inSnapshot[i]);
  if (restore.length > 0) {
    await git(["checkout", snap.tree, "--", ...restore.map((p) => `:(top,literal)${p}`)], snap.toplevel);
  }
  for (const p of remove) await _snapshotDeps.rm(join(snap.toplevel, p), { force: true });
  const indexNow = await git(["write-tree"], snap.toplevel);
  const indexRestored = indexNow !== snap.indexTree;
  // `checkout <tree> -- paths` also writes index entries, so read-tree runs whenever paths were restored.
  if (indexRestored || restore.length > 0) await git(["read-tree", snap.indexTree], snap.toplevel);
  return { paths: changed, indexRestored, headRestored, stashesDropped };
}
```
Notes for the implementer:
- `changed.length === 0` skips the checkout (guarded by `restore.length > 0`); paths with special characters are passed after `--` with `:(top,literal)` magic to `checkout`, and verbatim to `cat-file -e <tree>:<path>`.
- `git checkout <tree> -- paths` writes index entries too; the final `read-tree` restores the exact snapshot index. `indexRestored` in the report reflects only a real index change by the reviewer.
- After `read-tree`, run `git update-index -q --refresh` (allowFail) so `git status` stats are fresh.
- Refs are restored first so the tree comparison is against the restored HEAD's world; `snapshotWorkingTree` seeds from HEAD, which is why HEAD must be back before the current tree is taken.

`review/reviewer-guard/index.ts`:
```typescript
export { isRunStatePath, type RepoSnapshot, type RestoreReport, restoreRepoSnapshot, takeRepoSnapshot } from "./snapshot";
```

- [ ] **Step 4: Run, verify pass** — Step 2 command, then `bun run check:import-cycles` and `bun run check:alias-internals` in `packages/nax`. Expected: PASS. If the stash test fails because `stash push` reset the tree before restore, confirm the order (refs, stash drop, then tree restore) and that the snapshot tree held `wip`.

- [ ] **Step 5: Commit**

```bash
git add packages/nax
git commit -m "feat(review): reviewer tree snapshot and path-only restore (#2500)"
```

---

### Task 9: Reviewer guard — role filter, shared snapshot per repository, logging

**Files:**
- Create: `packages/nax/src/review/reviewer-guard/guard.ts`
- Modify: `packages/nax/src/review/reviewer-guard/index.ts`
- Test: `packages/nax/test/unit/review/reviewer-guard/guard.test.ts` (new)

**Interfaces:**
- Consumes: Task 8 `takeRepoSnapshot`, `restoreRepoSnapshot`, `RepoSnapshot`, `RestoreReport`; `SessionDescriptor` from `@/session` (type-only).
- Produces:
  - `REVIEWER_SESSION_ROLES: ReadonlySet<string>` = `reviewer-semantic`, `reviewer-adversarial`, `finish-review-spec`, `finish-review-quality`, `wf-story-review`, `wf-rereview`, `wf-branch-review`
  - `class ReviewerTreeGuard { beforeTurn(desc: SessionDescriptor): Promise<void>; afterTurn(desc: SessionDescriptor): Promise<void> }`
  - `_reviewerGuardDeps = { take: takeRepoSnapshot, restore: restoreRepoSnapshot, toplevel: (workdir: string) => Promise<string> }`

- [ ] **Step 1: Write failing tests** `guard.test.ts` (inject fakes through `_reviewerGuardDeps`; restore in `afterEach`):

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionDescriptor } from "@/session";
import { _reviewerGuardDeps, REVIEWER_SESSION_ROLES, ReviewerTreeGuard } from "@/review/reviewer-guard";

const saved = { ..._reviewerGuardDeps };
afterEach(() => Object.assign(_reviewerGuardDeps, saved));

function desc(role: string, id = role, workdir = "/repo/pkg"): SessionDescriptor {
  return { id, role, state: "RUNNING", agent: "claude", workdir, storyId: "US-001", protocolIds: { recordId: null, sessionId: null }, completedStages: [], createdAt: "", lastActivityAt: "" } as SessionDescriptor;
}

function fakes() {
  const calls: string[] = [];
  _reviewerGuardDeps.toplevel = async () => "/repo";
  _reviewerGuardDeps.take = async () => {
    calls.push("take");
    return { toplevel: "/repo", tree: "t", indexTree: "i", head: "h", symbolicHead: "refs/heads/main", stashes: [] };
  };
  _reviewerGuardDeps.restore = async () => {
    calls.push("restore");
    return { paths: [], indexRestored: false, headRestored: false, stashesDropped: 0 };
  };
  return calls;
}

describe("ReviewerTreeGuard (nax#2500)", () => {
  test("the role set is the seven reviewer roles", () => {
    expect([...REVIEWER_SESSION_ROLES].sort()).toEqual(
      ["finish-review-quality", "finish-review-spec", "reviewer-adversarial", "reviewer-semantic", "wf-branch-review", "wf-rereview", "wf-story-review"],
    );
  });

  test("non-reviewer roles are untouched", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("implementer"));
    await g.afterTurn(desc("implementer"));
    expect(calls).toEqual([]);
  });

  test("one reviewer: take then restore", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-branch-review"));
    await g.afterTurn(desc("wf-branch-review"));
    expect(calls).toEqual(["take", "restore"]);
  });

  test("two concurrent reviewers on one repo: one snapshot, restored once by the last out", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("finish-review-spec", "a"));
    await g.beforeTurn(desc("finish-review-quality", "b", "/repo"));
    await g.afterTurn(desc("finish-review-spec", "a"));
    expect(calls).toEqual(["take"]);
    await g.afterTurn(desc("finish-review-quality", "b", "/repo"));
    expect(calls).toEqual(["take", "restore"]);
  });

  test("a failing snapshot or restore never throws", async () => {
    fakes();
    _reviewerGuardDeps.take = async () => {
      throw new Error("git gone");
    };
    const g = new ReviewerTreeGuard();
    await expect(g.beforeTurn(desc("wf-story-review"))).resolves.toBeUndefined();
    await expect(g.afterTurn(desc("wf-story-review"))).resolves.toBeUndefined();
  });

  test("afterTurn without a matching beforeTurn is a no-op", async () => {
    const calls = fakes();
    await new ReviewerTreeGuard().afterTurn(desc("wf-story-review"));
    expect(calls).toEqual([]);
  });
});
```
Also, in `snapshot.test.ts` style (real git), add one integration case to `guard.test.ts` using the real deps: two reviewers on one temp repo, an edit made between the first and second `beforeTurn`, both `afterTurn`s → the edit is reverted.

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/review/reviewer-guard/guard.test.ts --timeout=60000`. Expected: FAIL.

- [ ] **Step 3: Implement** `guard.ts`:

```typescript
/**
 * nax#2500: reviewer turns may run Bash; whatever they change in the repository is
 * restored after the turn. Reviewers can run concurrently in one checkout (finish
 * spec + branch review), so the snapshot is shared per git toplevel: the first
 * reviewer in takes it, the last one out restores it. Never throws.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { SessionDescriptor } from "@/session";
import { runHardenedGit } from "@/utils/hardened-git";
import { type RepoSnapshot, restoreRepoSnapshot, takeRepoSnapshot } from "./snapshot";

export const REVIEWER_SESSION_ROLES: ReadonlySet<string> = new Set([
  "reviewer-semantic",
  "reviewer-adversarial",
  "finish-review-spec",
  "finish-review-quality",
  "wf-story-review",
  "wf-rereview",
  "wf-branch-review",
]);

export const _reviewerGuardDeps = {
  take: takeRepoSnapshot,
  restore: restoreRepoSnapshot,
  toplevel: async (workdir: string): Promise<string> => {
    const r = await runHardenedGit(["rev-parse", "--show-toplevel"], workdir);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "not a git repository");
    return r.stdout.trim();
  },
};

interface Entry {
  readonly snapshot: Promise<RepoSnapshot | undefined>;
  count: number;
}

export class ReviewerTreeGuard {
  private readonly active = new Map<string, Entry>();
  private readonly keyBySession = new Map<string, string>();

  async beforeTurn(desc: SessionDescriptor): Promise<void> {
    if (!REVIEWER_SESSION_ROLES.has(desc.role)) return;
    try {
      const key = await _reviewerGuardDeps.toplevel(desc.workdir);
      this.keyBySession.set(desc.id, key);
      const entry = this.active.get(key);
      if (entry !== undefined) {
        entry.count += 1;
        return;
      }
      const snapshot = _reviewerGuardDeps.take(key).catch((err: unknown) => {
        this.warn(desc, "snapshot failed", err);
        return undefined;
      });
      this.active.set(key, { snapshot, count: 1 });
    } catch (err) {
      this.warn(desc, "snapshot failed", err);
    }
  }

  async afterTurn(desc: SessionDescriptor): Promise<void> {
    const key = this.keyBySession.get(desc.id);
    if (key === undefined) return;
    this.keyBySession.delete(desc.id);
    const entry = this.active.get(key);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.active.delete(key);
    try {
      const snap = await entry.snapshot;
      if (snap === undefined) return;
      const report = await _reviewerGuardDeps.restore(snap);
      const touched = report.paths.length > 0 || report.indexRestored || report.headRestored || report.stashesDropped > 0;
      if (touched) {
        getSafeLogger()?.warn("review", "reviewer-tree-reverted", {
          storyId: desc.storyId,
          role: desc.role,
          paths: report.paths,
          indexRestored: report.indexRestored,
          headRestored: report.headRestored,
          stashesDropped: report.stashesDropped,
        });
      }
    } catch (err) {
      this.warn(desc, "restore failed", err);
    }
  }

  private warn(desc: SessionDescriptor, what: string, err: unknown): void {
    getSafeLogger()?.warn("review", `[WARN] reviewer guard: ${what}`, {
      storyId: desc.storyId,
      role: desc.role,
      error: errorMessage(err),
    });
  }
}
```
Note: the per-session map key uses `desc.id`; if `beforeTurn` and `afterTurn` receive different descriptors for one turn (handle rename on swap), key by session name instead — Task 10 passes the same `terminalDesc` to both, so `desc.id` is stable.

Add to `index.ts`: `export { _reviewerGuardDeps, REVIEWER_SESSION_ROLES, ReviewerTreeGuard } from "./guard";`

Verify the finish review roles: `grep -rn "sessionOverride\|finish-review-spec\|finish-review-quality" packages/nax/src/finish` and confirm the descriptor's `role` for both finish reviews equals the op's `session.role` (spec 4.4). If a finish review opens under a different role string, add that string to `REVIEWER_SESSION_ROLES` and to the role-set test.

- [ ] **Step 4: Run, verify pass** — Step 2 command + `bun run check:import-cycles`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax
git commit -m "feat(review): reviewer tree guard — shared snapshot per repo, restore by last reviewer out (#2500)"
```

---

### Task 10: Turn hooks wiring (before + after), runtime registration

**Files:**
- Modify: `packages/nax/src/session/turn-hooks.ts`
- Modify: `packages/nax/src/session/manager.ts:119-121` and `:573` (zero net lines)
- Create: `packages/nax/src/runtime/run-turn-hooks.ts`
- Modify: `packages/nax/src/runtime/index.ts:417-425`
- Test: `packages/nax/test/unit/session/turn-hooks.test.ts`, `packages/nax/test/unit/session/manager-after-turn.test.ts`, `packages/nax/test/unit/runtime/run-turn-hooks.test.ts` (new)

**Interfaces:**
- Consumes: Task 9 `ReviewerTreeGuard`; existing `_runtimeRunStateDeps.repairRunState`.
- Produces:
  - `type BeforeTurnHook = (desc: SessionDescriptor) => Promise<void>`; `interface TurnHookPair { readonly before?: BeforeTurnHook; readonly after?: AfterTurnHook }`
  - `TurnHooks.setHooks(pair: TurnHookPair): void` (replaces `setAfterTurn`; keep `setAfterTurn` as a one-line wrapper only if other callers exist — grep first)
  - `TurnHooks.beginTurn(handle, descriptor, set): Promise<ReturnType<TurnHooks["loopHandlerOpts"]>>` — runs `before` (never throws) then returns `loopHandlerOpts(...)`
  - `SessionManager.configureRuntime({... turnHooks?: TurnHookPair })` replacing `afterTurn?: AfterTurnHook`
  - `createRunTurnHooks(deps: { repairRunState: typeof _runtimeRunStateDeps.repairRunState }): TurnHookPair`

- [ ] **Step 1: Write failing tests**

`turn-hooks.test.ts` — add:
```typescript
describe("TurnHooks.beginTurn (nax#2500)", () => {
  test("runs the before hook, then returns the loop-handler opts", async () => {
    const seen: string[] = [];
    const hooks = new TurnHooks();
    hooks.setHooks({ before: async (d) => void seen.push(d.id) });
    const opts = await hooks.beginTurn({ id: "sess-1" } as never, makeDesc("sess-1"), {} as never);
    expect(seen).toEqual(["sess-1"]);
    expect(opts).toEqual(hooks.loopHandlerOpts({ id: "sess-1" } as never, makeDesc("sess-1"), {} as never));
  });

  test("a throwing before hook is swallowed", async () => {
    const hooks = new TurnHooks();
    hooks.setHooks({ before: async () => { throw new Error("git gone"); } });
    await expect(hooks.beginTurn({ id: "s" } as never, makeDesc("s"), {} as never)).resolves.toBeDefined();
  });
});
```
Migrate the existing `setAfterTurn` tests to `setHooks({ after })`.

`run-turn-hooks.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { _reviewerGuardDeps } from "@/review/reviewer-guard";
import { createRunTurnHooks } from "@/runtime/run-turn-hooks";

describe("createRunTurnHooks (nax#2500, #2497)", () => {
  test("after: reviewer restore runs before the run-state repair; before: reviewer snapshot", async () => {
    const order: string[] = [];
    const saved = { ..._reviewerGuardDeps };
    _reviewerGuardDeps.toplevel = async () => "/repo";
    _reviewerGuardDeps.take = async () => {
      order.push("take");
      return { toplevel: "/repo", tree: "t", indexTree: "i", head: "h", symbolicHead: undefined, stashes: [] };
    };
    _reviewerGuardDeps.restore = async () => {
      order.push("restore");
      return { paths: [], indexRestored: false, headRestored: false, stashesDropped: 0 };
    };
    const hooks = createRunTurnHooks({ repairRunState: async () => void order.push("repair") });
    const d = { id: "s", role: "wf-branch-review", workdir: "/repo", storyId: "US-1" } as never;
    await hooks.before?.(d);
    await hooks.after?.(d, 1);
    expect(order).toEqual(["take", "restore", "repair"]);
    Object.assign(_reviewerGuardDeps, saved);
  });
});
```
`manager-after-turn.test.ts` — update its setup from `afterTurn:` to `turnHooks: { after: ... }`; add a case that `before` runs once per `sendPrompt` before the adapter's `sendTurn` (record order with the fake adapter the file already uses).

- [ ] **Step 2: Run, verify fail** — `bun test test/unit/session/turn-hooks.test.ts test/unit/session/manager-after-turn.test.ts test/unit/runtime/run-turn-hooks.test.ts --timeout=30000`. Expected: FAIL.

- [ ] **Step 3: Implement**

`turn-hooks.ts`:
```typescript
export type AfterTurnHook = (desc: SessionDescriptor, turn: number) => Promise<void>;
export type BeforeTurnHook = (desc: SessionDescriptor) => Promise<void>;
export interface TurnHookPair {
  readonly before?: BeforeTurnHook;
  readonly after?: AfterTurnHook;
}
```
Replace the `hook` field with `private pair: TurnHookPair = {};`, `setHooks(pair) { this.pair = pair; }`, make `afterTurn` read `this.pair.after`, and add:
```typescript
  /** Runs the before hook (never throws), then returns the loop-handler opts; one call site in sendPrompt (nax#2500). */
  async beginTurn(handle: SessionHandle, descriptor: SessionDescriptor | undefined, set: LoopHandlerSet) {
    const before = this.pair.before;
    if (before && descriptor) {
      try {
        await before(descriptor);
      } catch (err) {
        getLogger().warn("session", "beforeTurn hook failed", {
          storyId: descriptor.storyId,
          sessionName: handle.id,
          error: errorMessage(err),
        });
      }
    }
    return this.loopHandlerOpts(handle, descriptor, set);
  }
```
Update the file header: "plugin loop handlers, and the before/after turn hooks (#2497, nax#2500)".

`manager.ts` (net 0 lines; `bun run check:file-sizes` must stay at 650):
- line 119: `afterTurn?: AfterTurnHook;` -> `turnHooks?: TurnHookPair;`
- line 121: `if (opts.afterTurn) this._turnHooks.setAfterTurn(opts.afterTurn);` -> `if (opts.turnHooks) this._turnHooks.setHooks(opts.turnHooks);`
- line 573: `const loopHandlerOpts = this._turnHooks.loopHandlerOpts(handle, terminalDesc, this._loopHandlers);` -> `const loopHandlerOpts = await this._turnHooks.beginTurn(handle, terminalDesc, this._loopHandlers);`
- the import line: `AfterTurnHook` -> `TurnHookPair` (same line).
- line 87 comment: "Per-turn loop-handler delivery and the before/after turn hooks (#2497, #2500)."

Ordering note: `beginTurn` runs after the busy and terminal-state checks (lines 547-560) and before `_busySessions.add` (575), so a rejected turn never takes a snapshot; the matching `afterTurn` is in the `finally` at 611.

`runtime/run-turn-hooks.ts`:
```typescript
/** The run's turn hooks: reviewer tree guard (nax#2500) then run-state repair (#2497). */
import { ReviewerTreeGuard } from "@/review/reviewer-guard";
import type { TurnHookPair } from "@/session";
import type { RepairContext } from "@/runstate";

export function createRunTurnHooks(deps: {
  readonly repairRunState: (ctx: RepairContext) => Promise<unknown>;
}): TurnHookPair {
  const guard = new ReviewerTreeGuard();
  return {
    before: (desc) => guard.beforeTurn(desc),
    after: async (desc, turn) => {
      await guard.afterTurn(desc);
      await deps.repairRunState({
        trigger: "turn",
        storyId: desc.storyId,
        sessionName: desc.handle ?? desc.id,
        stage: desc.role,
        turn,
      });
    },
  };
}
```
(Export `TurnHookPair` from `src/session/index.ts`; use the real import paths for `RepairContext` — check `src/runstate/index.ts`.)

`runtime/index.ts` — replace the `afterTurn: async (desc, turn) => { ... },` block (lines ~417-425, with its `// #2497` comment) with:
```typescript
      // #2497 run-state repair + nax#2500 reviewer tree guard, native and ACP.
      turnHooks: createRunTurnHooks({ repairRunState: (ctx) => _runtimeRunStateDeps.repairRunState(ctx) }),
```
(net -7 lines; the file drops below 581.)

- [ ] **Step 4: Run, verify pass** — Step 2 command; then `bun test test/unit/session --timeout=60000` and `bun test test/unit/runtime --timeout=60000`; `bun run check:file-sizes`; `bun run check:import-cycles`. Expected: PASS, `manager.ts` still 650.

- [ ] **Step 5: Commit**

```bash
git add packages/nax
git commit -m "feat(session): before-turn hook; run turn hooks wire the reviewer tree guard (#2500)"
```

---

### Task 11: Integration tests, full gates, docs

**Files:**
- Test: `packages/nax/test/integration/review/reviewer-sandboxed-bash.test.ts` (new)
- Modify: `packages/nax/docs/` architecture note if `docs/architecture/agent-adapters.md` §14 lists ACP profiles — add `review` and the sandbox mapping (grep `"read" profile` there)

- [ ] **Step 1: Write the integration test**

Native reviewer session in a temp git repo, driven through the real `SessionManager` + `createRunTurnHooks` with a fake native adapter whose `sendTurn` writes `stray.txt` and edits a tracked file (simulating a Bash write). Assert after `sendPrompt`: `stray.txt` absent, tracked file restored, one `reviewer-tree-reverted` log record (capture via the test logger helper used in `test/integration`). Copy the session/adapter scaffolding from `packages/nax/test/unit/session/manager-after-turn.test.ts`.

ACP open with a fake agent: reuse the fake ACP link from `packages/nax-agent-acp/test/unit/client/open.test.ts` (Task 4 already asserts `_meta`); here assert the end-to-end nax path: `openContext` (Task 6) given `declaredTools: [...REVIEWER_VERIFY_TOOLS]`, approve-all, and a policy -> `profile: "review"` with `sandbox` set — and that `claudeSessionMeta` from that context yields `sandbox` + read-only options.

- [ ] **Step 2: Run** — `bun test test/integration/review/reviewer-sandboxed-bash.test.ts --timeout=60000`. Expected: PASS.

- [ ] **Step 3: Full gates (from repo root)**

```bash
bun run typecheck
bun run check:all
(cd packages/nax-agent && bun run test && bun run test:coverage)
(cd packages/nax-agent-acp && bun run test && bun run test:coverage)
(cd packages/nax && bun run test && bun run test:coverage)
```
Expected: all PASS. Known pre-existing coverage miss on main: `packages/nax/src/execution/feature-lock.ts` (72.73% < 76.62%) — report it, do not fix here. Any other coverage miss on a file this branch touched: add tests until it passes.

- [ ] **Step 4: Commit**

```bash
git add packages docs
git commit -m "test(review): integration for reviewer sandboxed Bash and ACP sandbox plumbing (#2500)"
```

- [ ] **Step 5: Live check — STOP, needs user approval (billed)**

Do not run without explicit approval at launch. Two checks on the local build (`repos/nax-run` after merge, or this branch via `bun "$NAX"`):
1. ACP Claude branch review on rs-stock: the tool audit (`~/.nax/<project>/tool-audit/<feature>/<session>.json`) shows `uv run ruff format --check .` executed, no `profile "read" rejects` and no `review` denials for `execute`.
2. ACP Claude implementer turn instructed to write `~/nax-2500-probe.txt` via Bash and via Write: Bash fails inside the sandbox; Write is denied with `the edit target is outside the sandbox write roots`.
Record results in the PR body.

---

## Self-review notes (plan author)

- Spec coverage: 4.1 -> T7; 4.2 table + consumers -> T1, T3, T6; 4.3 extraction/plumbing/mapping/network/R4 -> T2, T4, T3, T5, T6; 4.4 hooks/snapshot/restore/concurrency/reporting -> T8, T9, T10; 4.5 failures -> T4 (unavailable), T3 (other agents via existing `unmetRequirement`), T9 (revert never throws); 6 testing -> each task + T11; 7 rollout -> PR body.
- Deviation from spec 4.3 "extract buildSessionPolicy": implemented as `CommandLauncher.policyAt` over the existing `policyFor` closure — same single policy source, smaller change.
- `WORKFLOW_REVIEW_TOOLS` stays as an alias so existing imports keep compiling.
