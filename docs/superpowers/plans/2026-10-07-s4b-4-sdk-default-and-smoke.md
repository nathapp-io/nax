# S4b-4: billed Claude smoke on the sdk transport, then flip the default: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent.acp.transport: "sdk"` the default for `nax run`, proven first by a billed Claude `nax run` smoke with no `acpx` on PATH.

**Architecture:** One constant flips (`DEFAULT_ACP_TRANSPORT`), and every config-less and config-default path follows it (registry, `nax agents`, bakeoff preflight). Before the flip, the test preload gets a spawn sentinel for the sdk backend, so no test that used to reach the (mocked) acpx client silently spawns a real ACP agent afterwards. The billed smoke runs from a clone of this branch's head, with the key absent from config, so it proves the new default path rather than the development key.

**Tech Stack:** TypeScript, Bun 1.4.0, bun:test, `@nathapp/nax-agent-acp` 0.3.1 (`./client`), zod config schema.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§9 "Billed Claude smoke", §10 S4b-4 row, §11 behaviour changes, B2).

**Baseline:** main `bb070a6e7` (S4b-3 merged #2381). Branch `feat/s4b-4-sdk-default`.

## Global Constraints

- S4b-4 = "Billed Claude smoke on `sdk` (approval at launch); then flip the default to `sdk`. No release." (spec §10)
- Done when: "smoke passed; suite green with the new default." (spec §10)
- "No released nax version carries both transports." No release, no tag, no version bump in this slice (B2).
- Smoke setup: "the S1 recipe on a fixture copy, with `agent.default: claude`, `agent.acp.transport: "sdk"` and no `acpx` on PATH." (spec §9)
- Smoke passes when: the stories complete; cost ledger rows carry `estimatedCostUsd` and `exactCostUsd`; tool audit has ACP rows; no agent process is left after the run. Also record per-call `complete()` latency. (spec §9)
- The acpx transport stays selectable with `agent.acp.transport: "acpx"` until S4b-5 deletes it. Nothing under `agents/acp/` is deleted here.
- Gates every slice keeps green: `check:all`, `typecheck`, `check:test-satellites`, `check:nax-error`, `check:alias-internals`, `check:import-cycles`, `check:dispatch-field-forwarding`, the file-size gate, the complexity ratchet (spec §10).
- Never bare `bun test`, never `bun run nax`. Package commands run from `packages/nax`.
- The billed smoke needs maintainer approval at the launch moment. Push and PR need approval too.
- S4b replaces the transport, not the logic: no retry, swap, stale, cost-ledger or metrics policy changes (spec §1).

## Decisions

- **D4-a. The smoke runs on this branch's head with the key absent.** The spec orders "smoke, then flip"; running the smoke after the flip commit (but before push) is strictly stronger: it exercises the `sdk` path through the default, not through the development key, and a failed smoke blocks the PR exactly as it would block a flip. Proof that `sdk` ran, not acpx: `command -v acpx` fails before launch, and the tool-audit ledger has rows for the Claude sessions (acpx never wrote any, behaviour change 4).
- **D4-b. The smoke uses the locally installed Claude launcher, not the `npx` fallback.** Today `claude-agent-acp` is not on PATH, so the run would go through `npx @agentclientprotocol/claude-agent-acp@~0.85.1` (registry pin, `packages/nax-agent-acp/src/client/registry.ts:88`) and every `complete()` latency sample would include `npx` resolution. Installing the same pinned range globally before the smoke (`npm i -g @agentclientprotocol/claude-agent-acp@~0.85.1`) makes the latency number mean "spawn + initialize + one turn", which is what spec §13's warm-process decision needs. The `npx` path keeps its unit coverage (S4b-3 `launchNote` tests). The global install is a machine change: ask for it in the same approval as the smoke.
- **D4-c. The smoke config disables fallback.** The seed config maps `claude -> codex`. A Claude failure on the new transport must fail the smoke, not pass it on codex. `agent.fallback.enabled: false` in the smoke config only.
- **D4-d. A preload sentinel guards the sdk backend.** `test/preload.ts` already throws on an unmocked `_acpAdapterDeps.createClient` (acpx). After the flip, a test that reached the acpx client through the default registry would reach `_acpSdkDeps.acpBackend` instead, which spawns a real agent process. The sentinel makes that a loud failure. Every sdk test that opens a backend already replaces `_acpSdkDeps.acpBackend` (with `fakeAcpBackend` or a scripted backend), and `test/helpers/acp-fake-agent/index.ts` imports `acpBackend` from the package directly, so the sentinel does not touch them. The sentinel lands before the flip, in its own task, so its fallout on the acpx default is zero by construction and any later failure is attributable to the flip.
- **D4-e. Failure triage rule for the flip (Task 2).** A test that fails after the flip is fixed by one of two moves, chosen by what the test is about:
  1. It asserts **default** behaviour (the default value, the default adapter, the default listing): update the expectation to `sdk` / `AcpSdkAgentAdapter`, stubbing `_acpSdkDeps.launchCandidateKind` (never the real PATH) where installed-ness matters.
  2. It exercises **acpx plumbing** through the default (mocks `_acpAdapterDeps`, `which`, argv): pin `agent.acp.transport: "acpx"` in its config (or call `acpAdapterFor(name, "acpx")`), with the comment `// acpx transport pinned until S4b-5 deletes it.` S4b-5 deletes or re-points these.
  No production code changes to make a test pass, beyond the flip itself. Record every touched test in the PR body under these two headings.
- **D4-f. The registry's info log stays "non-default only".** `createAgentRegistry` logs `ACP transport: <t> (S4b development key)` when the configured transport differs from the default (`src/agents/registry.ts:122-125`). After the flip that line fires for an explicit `acpx`, which is the useful signal. No change.
- **D4-g. Docs.** Only the in-code descriptions change (`config-descriptions.ts`, the two doc comments). Install docs (`acpx` -> per-agent launcher) are S4b-5's, because the release is S4b-5's and main is unreleased until then.

## Review Focus

1. **Installed-ness depends on the machine.** After the flip, `isInstalled()` for ACP agents asks `launchCandidateKind`, which probes PATH and `npx`. A test that passes on the maintainer machine (launcher installed after D4-b) can fail in CI (no launcher), or the reverse. Every touched test that checks installed/unavailable must stub `_acpSdkDeps.launchCandidateKind`. Pinned in Task 2 Step 6 (suite run with the launcher present) and the CI check in Task 5.
2. **A test spawns a real agent after the flip.** Covered by the D4-d sentinel (Task 1) and its own test.
3. **Bakeoff contestants without a transport.** `validateContestants(..., baseTransport = DEFAULT_ACP_TRANSPORT)` and `coordinator.ts:85` now default to `sdk`; a contestant profile that sets `acpx` must still get acpx. Pinned in Task 2 Step 3.
4. **`nax config` display.** The resolved config must show `agent.acp.transport: "sdk"` with no key set, and the description text must not still say "'acpx' (default)". Pinned in Task 2 Step 3 and Task 3.
5. **Orphaned launcher processes after a real run.** Only the smoke can show this; the Task 4 process snapshot before and after pins it.

---

## File Structure

| File | Change |
|---|---|
| `packages/nax/test/preload.ts` | Add the `_acpSdkDeps.acpBackend` spawn sentinel (D4-d). |
| `packages/nax/test/unit/preload-sdk-sentinel.test.ts` | New: the sentinel throws with the `[test-preload]` message. |
| `packages/nax/src/config/agent-defaults.ts` | `DEFAULT_ACP_TRANSPORT = "sdk"`; doc comment. |
| `packages/nax/src/config/schemas-infra.ts` | Doc comment on `AgentAcpConfigSchema.transport` (lines 322-328). |
| `packages/nax/src/cli/config-descriptions.ts` | `"agent.acp.transport"` text (line 302-303). |
| `packages/nax/test/unit/config/agent-schema.test.ts` | Default is `sdk`; explicit `acpx` accepted. |
| `packages/nax/test/unit/agents/registry-native.test.ts` | Default routing is `AcpSdkAgentAdapter`; explicit `acpx` routes to `AcpAgentAdapter`. |
| `packages/nax/test/unit/bakeoff/preflight.test.ts` | Default base transport is `sdk`; a profile's `acpx` wins. |
| Other tests found by the Task 2 suite run | Per the D4-e rule only. |

---

### Task 1: Spawn sentinel for the sdk backend in the test preload

**Files:**
- Modify: `packages/nax/test/preload.ts` (after the acpx sentinel, ~line 104)
- Create: `packages/nax/test/unit/preload-sdk-sentinel.test.ts`

**Interfaces:**
- Consumes: `_acpSdkDeps` from `packages/nax/src/agents/acp-sdk/session.ts:53` (re-exported by `src/agents/acp-sdk/index.ts`), field `acpBackend: (options: AcpBackendOptions) => SessionBackend`.
- Produces: under bun:test, `_acpSdkDeps.acpBackend` throws unless a test replaces it. Tests that save and restore the field restore the sentinel, which is the intent.

- [ ] **Step 1: Write the failing test**

Create `packages/nax/test/unit/preload-sdk-sentinel.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { _acpSdkDeps } from "@/agents/acp-sdk";

describe("test preload: sdk backend spawn sentinel (S4b-4 D4-d)", () => {
  test("an unmocked acpBackend throws instead of spawning a real ACP agent", () => {
    expect(() => _acpSdkDeps.acpBackend({ agent: "claude" } as AcpBackendOptions)).toThrow(
      "[test-preload] _acpSdkDeps.acpBackend called without a mock",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `bun test test/unit/preload-sdk-sentinel.test.ts --timeout=30000`
Expected: FAIL. The real `acpBackend` returns a backend object without throwing, so `toThrow` fails.

- [ ] **Step 3: Add the sentinel**

In `packages/nax/test/preload.ts`, add the import next to the existing `_acpAdapterDeps` import:

```typescript
import { _acpSdkDeps } from "../src/agents/acp-sdk/session";
```

and, directly after the acpx sentinel block:

```typescript
// ─── ACP sdk spawn sentinel (S4b-4) ───────────────────────────────────────────
// The sdk transport is the default from S4b-4. A test that reaches
// _acpSdkDeps.acpBackend without replacing it would spawn a real ACP agent
// (the local launcher or npx). Fail fast instead. sdk tests replace this dep
// with fakeAcpBackend (test/helpers/acp-fake-agent) or a scripted backend.
_acpSdkDeps.acpBackend = () => {
  throw new Error(
    "[test-preload] _acpSdkDeps.acpBackend called without a mock — " +
      "this would spawn a real ACP agent process. " +
      "Replace it in your describe block:\n" +
      "  beforeEach(() => { _acpSdkDeps.acpBackend = (opts) => fakeAcpBackend(...); })\n" +
      "  afterEach(() => { _acpSdkDeps.acpBackend = <saved original>; })",
  );
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/preload-sdk-sentinel.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Run the full nax suite on the acpx default**

Run (from `packages/nax`): `bun run test`
Expected: green; pass count = main's count plus the new sentinel test. A failure here means a test already reached the real sdk backend while acpx was the default: fix that test by replacing `_acpSdkDeps.acpBackend` with `fakeAcpBackend` (it was a latent real spawn), and list it in the PR body.

- [ ] **Step 6: Gates and commit**

Run (from `packages/nax`): `bun run typecheck && bun run check:all`
Expected: both exit 0.

```bash
git add packages/nax/test/preload.ts packages/nax/test/unit/preload-sdk-sentinel.test.ts
git commit -m "test(nax): preload sentinel for the sdk backend spawn (S4b-4 D4-d)"
```

---

### Task 2: Flip the default to `sdk`

**Files:**
- Modify: `packages/nax/src/config/agent-defaults.ts:19-26`
- Modify: `packages/nax/src/config/schemas-infra.ts:322-328`
- Modify: `packages/nax/src/cli/config-descriptions.ts:302-303`
- Test: `packages/nax/test/unit/config/agent-schema.test.ts:102-105`
- Test: `packages/nax/test/unit/agents/registry-native.test.ts:81-90`
- Test: `packages/nax/test/unit/bakeoff/preflight.test.ts` (the "S4b-2 transport routing" describe, ~line 167)
- Test: any further test the Step 5 run surfaces, per D4-e

**Interfaces:**
- Consumes: Task 1's sentinel.
- Produces: `DEFAULT_ACP_TRANSPORT: AcpTransport = "sdk"`. Unchanged names: `AcpTransport`, `acpAdapterFor(name, transport)`, `createAgentRegistry(config)`, `validateContestants(names, projectRoot, deps, baseTransport)`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/config/agent-schema.test.ts`, replace the test at line 102:

```typescript
  test("agent.acp.transport defaults to sdk (S4b-4)", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp?.transport).toBe("sdk");
  });

  test("agent.acp.transport still accepts acpx until S4b-5", () => {
    const result = NaxConfigSchema.parse({ agent: { acp: { transport: "acpx" } } });
    expect(result.agent?.acp?.transport).toBe("acpx");
  });
```

In `test/unit/agents/registry-native.test.ts`, replace the last two tests of the "ACP transport routing" describe:

```typescript
  test("createAgentRegistry routes ACP agents by agent.acp.transport, native unchanged", () => {
    const acpx = createAgentRegistry(makeNaxConfig({ agent: { acp: { transport: "acpx" } } }));
    expect(acpx.getAgent("claude")).toBeInstanceOf(AcpAgentAdapter);
    expect(acpx.getAgent("native")).toBeInstanceOf(NativeAgentAdapter);
    expect(createAgentRegistry(makeNaxConfig({})).getAgent("claude")).toBeInstanceOf(AcpSdkAgentAdapter);
  });

  test("the config-less listings use the default transport, sdk since S4b-4 (D2-n)", () => {
    expect(getAllAgents().find((a) => a.name === "claude")).toBeInstanceOf(AcpSdkAgentAdapter);
  });
```

In `test/unit/bakeoff/preflight.test.ts`, inside the "S4b-2 transport routing" describe (it already writes the `cross-agent-pi` profile, `{ agent: { default: "pi" } }`, in `beforeAll`), add after "isInstalled is asked with the contestant's transport":

```typescript
    it("with no baseTransport, a contestant gets the sdk default (S4b-4)", async () => {
      const seen: string[] = [];
      await validateContestants(["cross-agent-pi"], projectRoot, {
        isInstalled: (agent, transport) => {
          seen.push(`${agent}:${transport}`);
          return true;
        },
      });
      expect(seen).toEqual(["pi:sdk"]);
    });

    it("a profile's agent.acp.transport acpx still wins over the sdk default", async () => {
      writeFileSync(
        join(profileDir, "cross-agent-pi-acpx.json"),
        JSON.stringify({ agent: { default: "pi", acp: { transport: "acpx" } } }),
        "utf8",
      );
      const seen: string[] = [];
      await validateContestants(["cross-agent-pi-acpx"], projectRoot, {
        isInstalled: (agent, transport) => {
          seen.push(`${agent}:${transport}`);
          return true;
        },
      });
      expect(seen).toEqual(["pi:acpx"]);
    });
```

The second test passes before the flip too (D2-o already lets the profile win); it pins that the flip does not override an explicit profile value.

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax`):
`bun test test/unit/config/agent-schema.test.ts test/unit/agents/registry-native.test.ts test/unit/bakeoff/preflight.test.ts --timeout=30000`
Expected: FAIL on the three default assertions (`"acpx"` received, `AcpAgentAdapter` received, `pi:acpx` for the transport-less contestant); the explicit-acpx tests pass.

- [ ] **Step 3: Flip the default and the descriptions**

`src/config/agent-defaults.ts`:

```typescript
/**
 * How `nax run` drives ACP agents (S4b spec §5.3): through
 * `@nathapp/nax-agent-acp` ("sdk", the default since S4b-4), or through the
 * `acpx` CLI. A development key while both transports exist: S4b-5 deletes
 * the key with acpx.
 */
export type AcpTransport = "acpx" | "sdk";

export const DEFAULT_ACP_TRANSPORT: AcpTransport = "sdk";
```

`src/config/schemas-infra.ts`, the comment on `transport`:

```typescript
  /**
   * S4b development key: "sdk" (default since S4b-4) drives ACP agents through
   * @nathapp/nax-agent-acp, "acpx" through the acpx CLI. S4b-5 deletes the
   * key with acpx.
   */
```

`src/cli/config-descriptions.ts`:

```typescript
  "agent.acp.transport":
    "How ACP agents are driven: 'sdk' (default) uses @nathapp/nax-agent-acp in-process; 'acpx' shells out to the acpx CLI (S4b development key; S4b-5 removes acpx and this key)",
```

Then grep for stale wording and fix any comment that still calls acpx the default:

```bash
RTK_DISABLED=1 grep -rn "acpx\" (default)\|'acpx' (default)\|default still acpx\|default \`acpx\`\|S4b-4 flips\|S4b-4 makes" packages/nax/src
```
Expected after edits: no output.

- [ ] **Step 4: Run the Step 1 tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Run the full nax suite and triage**

Run (from `packages/nax`): `bun run test`
Expected: some failures. Fix each by the D4-e rule, and only by that rule. Do not edit a test that still passes. Known failures (plan review, read from the code):
- `test/unit/agents/acp/registry.test.ts`:
  - `:37-40`, `:48-52`, `:90-95` assert `toBeInstanceOf(AcpAgentAdapter)` on a default or `protocol: "acp"` config. Rule 2: add `acp: { transport: "acpx" }` to the config's `agent` block.
  - `:146-169` ("installed true/false when binary is on PATH") and `:190-215` (`getInstalledAgents` / `checkAgentHealth` with `_acpAdapterDeps.which` mocked to null) depend on acpx's `which`; the sdk adapter asks `launchCandidateKind`, which finds the `npx` fallback. Rule 2 (pin acpx): these tests are about acpx's PATH probe.
- `test/unit/agents/manager-dispatch-emission.test.ts:269-290` ("completeAs emits exactly one complete event") and `test/unit/agents/manager.test.ts:236-330` ("middleware envelope") build `new AgentManager(DEFAULT_CONFIG)` and mock only `_acpAdapterDeps.createClient`; after the flip `runAs("claude")` / `completeAs("claude")` hit the Task 1 sentinel. Rule 2: build the manager from `{ ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, acp: { ...DEFAULT_CONFIG.agent?.acp, transport: "acpx" } } }`. Several calls there end in `.catch(() => {})`, so also check each pinned test asserts on the mocked client being called; a test that "passes" by swallowing the sentinel error is a fail.
- Expected to keep passing (do not touch): `test/unit/cli/agents-list.test.ts:55-87` (names only, no status), `test/integration/cli/cli-core-agents.test.ts` (accepts `installed|unavailable`), `test/unit/agents/phase4-registry-cleanup.test.ts:29-55`, `test/unit/agents/version-detection.test.ts` (own deps). The CLI listing tests become `npx`-dependent underneath without failing; note this in the PR body, no change.
- Any other failure: classify by D4-e and list it in the PR body.

To catch swallowed sentinel errors, after the suite is green run:
`RTK_DISABLED=1 bun run test 2>&1 | grep -c "_acpSdkDeps.acpBackend called without a mock"`
Expected: `0`. (Console output is silenced by preload, so a non-zero count only appears through failure messages; if it is non-zero, find and pin those tests.)

Re-run until green. Expected final: 0 fail; pass count = Task 1's count + the tests added in Step 1.

- [ ] **Step 6: Run the suite again with the launcher present (Review Focus 1)**

GATE: this step must be done before Task 4 Step 4 (the launch) and before Task 5. If the launcher is not installed yet, do it right after Task 4 Step 2's approval:

Run (from `packages/nax`): `command -v claude-agent-acp && bun run test`
Expected: green with the same counts as Step 5. A test whose result changes with the launcher on PATH is unstubbed: stub `_acpSdkDeps.launchCandidateKind` in it.

- [ ] **Step 7: Gates and commit**

Run (from `packages/nax`): `bun run typecheck && bun run check:all`
Then from the repo root: `bun run test`
Expected: all exit 0.

```bash
git add packages/nax/src/config/agent-defaults.ts packages/nax/src/config/schemas-infra.ts packages/nax/src/cli/config-descriptions.ts packages/nax/test
git commit -m "feat(nax): agent.acp.transport defaults to sdk (S4b-4)"
```

---

### Task 3: Dist smoke with the new default (unbilled)

**Files:** none changed.

**Interfaces:**
- Consumes: Task 2's flip.
- Produces: evidence lines for the PR body.

- [ ] **Step 1: Build**

Run (from `packages/nax`): `bun run build`
Expected: exit 0, `dist/nax.js` written.

- [ ] **Step 2: The bundled CLI lists agents through the sdk adapter**

Run from a scratch directory with no `.nax/config.json` setting the transport:

```bash
cd "$(mktemp -d)" && bun <repo>/packages/nax/dist/nax.js agents
```

Expected: the five ACP rows (`Claude Code (ACP)`, codex, opencode, gemini, pi) plus native; the Claude row's status reflects `claude-agent-acp`/`npx` availability, not `acpx` (acpx is not on PATH on the maintainer machine, so an acpx-routed row would say "unavailable" for every agent).

- [ ] **Step 3: `nax config` shows the default**

```bash
bun <repo>/packages/nax/dist/nax.js config | grep -n "transport"
bun <repo>/packages/nax/dist/nax.js config --explain | grep -n -A2 "agent.acp.transport"
```

Expected: the first shows `transport` resolving to `"sdk"`; the second shows the description containing `'sdk' (default)` (descriptions print only with `--explain`, `src/cli/config-display.ts:94`).

Record both outputs for the PR body. No commit.

---

### Task 4: Billed Claude `nax run` smoke on the branch head (maintainer approval at launch)

**Files:** none in the repo. Fixture under `/private/tmp`, artifacts under `~/.nax/nax-s4b-4-smoke/`.

**Interfaces:**
- Consumes: the branch head after Tasks 1-2 (committed, not pushed).
- Produces: the smoke result block for the PR body (cost, duration, ACs, ledger checks, `complete()` latencies, process check).

- [ ] **Step 1: Unbilled pre-flight (no approval needed)**

```bash
command -v acpx && echo "FAIL: acpx on PATH" || echo "ok: no acpx"
command -v claude-agent-acp || echo "launcher not installed (D4-b)"
ps -axo pid=,pgid=,command= | grep -E "claude-agent-acp|claude-code|@anthropic-ai/claude" | grep -v grep | awk '{print $1}' | sort > /private/tmp/s4b-4-pids-before.txt; wc -l < /private/tmp/s4b-4-pids-before.txt
git -C <repo> rev-parse HEAD
```

Expected: `ok: no acpx`; record the head SHA as `HEAD_SHA`.

- [ ] **Step 2: Ask for approval**

Ask the maintainer, in one message, for: (a) the global launcher install `npm i -g @agentclientprotocol/claude-agent-acp@~0.85.1` (D4-b), and (b) the billed smoke launch with `--max-cost 3`. Do not proceed without an explicit yes. If (a) is declined, run on `npx` and label every latency figure "npx".

After approval of (a): `npm i -g @agentclientprotocol/claude-agent-acp@~0.85.1 && command -v claude-agent-acp`. Then run Task 2 Step 6 if it has not run yet; a red suite stops the smoke.

- [ ] **Step 3: Build the fixture**

```bash
D=/private/tmp/nax-s4b-4-acceptance-$(date +%Y%m%d)
git clone -q <repo> "$D" && git -C "$D" checkout -q "$HEAD_SHA"
mkdir -p "$D/.nax/features/s1-smoke"
SEED=/private/tmp/nax-s4-6-acceptance-20261006
git -C "$SEED" show 9ceea8d39:.nax/features/s1-smoke/prd.json > "$D/.nax/features/s1-smoke/prd.json"
git -C "$SEED" show 9ceea8d39:.nax/features/s1-smoke/spec.md  > "$D/.nax/features/s1-smoke/spec.md"
python3 -c "import json;p=json.load(open('$D/.nax/features/s1-smoke/prd.json'));print([(s['id'],s['status'],len(s['acceptanceCriteria'])) for s in p['userStories']])"
```

Expected: `[('US-001', 'pending', 5)]`.

Install and build the clone (a fresh clone has no `node_modules`; the run's quality commands and the workspace packages need them):

```bash
cd "$D" && bun install --frozen-lockfile && bun run build
```

Expected: both exit 0 (`bun run build` builds every workspace package in dependency order, so `@nathapp/nax-agent-acp` resolves from source/dist the same way it does in the main checkout).

If the seed clone is gone, rebuild the PRD from the newest `~/.nax/nax-s4-6-smoke/prompt-audit/s1-smoke/*implementer-run-t01.txt` "# Story Context" (maintainer memory "S1 smoke fixture recovery").

Edit `$D/.nax/config.json` (the repo's own config, as the S4-5/S4-6 smokes did) with exactly these changes:
- `"name": "nax-s4b-4-smoke"`
- `"agent.default": "claude"`
- `"agent.fallback.enabled": false` (D4-c)
- no `agent.acp.transport` key (D4-a); if the file has one, remove it.

```bash
python3 - "$D/.nax/config.json" <<'EOF'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
c["name"] = "nax-s4b-4-smoke"
c.setdefault("agent", {})["default"] = "claude"
c["agent"].setdefault("fallback", {})["enabled"] = False
c["agent"].get("acp", {}).pop("transport", None)
json.dump(c, open(p, "w"), indent=2); open(p, "a").write("\n")
EOF
cd "$D" && bun packages/nax/bin/nax.ts trust add "$D" --yes
bun packages/nax/bin/nax.ts config | grep -n "transport\|\"default\""
```

Expected: transport `sdk`, default agent `claude`. Leave the seed uncommitted (the pre-run auto-commit commits it).

- [ ] **Step 4: Launch (approved in Step 2)**

```bash
cd "$D" && bun packages/nax/bin/nax.ts run -f s1-smoke -a claude --headless --max-cost 3 2>&1 | tee /private/tmp/nax-s4b-4-acceptance-run.log
```

nax exits 0 on failure: judge by the summary and artifacts, never the exit code.

- [ ] **Step 5: Checks**

```bash
RUN=$(ls -t ~/.nax/nax-s4b-4-smoke/cost/*.jsonl | head -1)
grep -m1 '"run.start"\|naxCommit' /private/tmp/nax-s4b-4-acceptance-run.log
python3 - "$RUN" <<'EOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
for r in rows:
    print(r.get("agentName"), r.get("stage"), r.get("sessionRole"), "turn" if "turnId" in r else "complete",
          r.get("durationMs"), r.get("estimatedCostUsd"), r.get("exactCostUsd"))
missing = [r for r in rows if r.get("agentName") == "claude" and (r.get("estimatedCostUsd") is None or r.get("exactCostUsd") is None)]
print("claude rows:", sum(r.get("agentName") == "claude" for r in rows), "missing cost fields:", len(missing))
print("complete() latencies ms:", [r.get("durationMs") for r in rows if r.get("agentName") == "claude" and "turnId" not in r])
EOF
ls ~/.nax/nax-s4b-4-smoke/tool-audit/s1-smoke/
python3 - <<'PY'
import json, glob, os
for f in sorted(glob.glob(os.path.expanduser("~/.nax/nax-s4b-4-smoke/tool-audit/s1-smoke/*.json"))):
    d = json.load(open(f))
    calls = d.get("calls", [])
    errs = [c for c in calls if c.get("outcome") != "ok"]
    print(d.get("sessionRole"), "calls:", len(calls), "non-ok:", [(c.get("tool"), c.get("outcome")) for c in errs])
PY
sleep 10
ps -axo pid=,pgid=,command= | grep -E "claude-agent-acp|claude-code|@anthropic-ai/claude" | grep -v grep | awk '{print $1}' | sort > /private/tmp/s4b-4-pids-after.txt
NEW=$(comm -13 /private/tmp/s4b-4-pids-before.txt /private/tmp/s4b-4-pids-after.txt)
[ -z "$NEW" ] && echo "ok: no leftover agent process" || ps -o pid,pgid,ppid,lstart,command -p $(echo $NEW | tr ' ' ',')
git -C "$D" log --stat --oneline "$HEAD_SHA"..HEAD
```

(Rows without `turnId` are one-shot `complete()` calls: the S4-6 ledger shows this shape for the acceptance one-shot, `sessionRole: "auto"`. Tool-audit files are `{ schemaVersion, runId, featureName, storyId, sessionRole, sessionName, calls: ToolCallRecord[] }`, as in `~/.nax/nax-s4-6-smoke/tool-audit/`.)

Pass when (spec §9 plus the S1 recipe):
- `naxCommit` on `run.start` equals `HEAD_SHA`.
- 1/1 story passed with its 5 ACs; summary "Completed: 1".
- Every `agentName: "claude"` cost row has both `estimatedCostUsd` and `exactCostUsd` (missing = 0).
- `tool-audit/s1-smoke/` has files for this run's Claude sessions and the implementer file has at least one entry in `calls` (ACP rows; acpx wrote none).
- No launcher or Claude CLI process started during the run remains (only PIDs absent from the before-snapshot count, so other sessions on the machine do not false-positive; check `lstart` of any hit falls inside the run window).
- The pre-run auto-commit's parent is `HEAD_SHA` and it changes only `.nax/config.json` and `.nax/features/s1-smoke/`.

If a Claude row lacks `exactCostUsd` (`src/agents/acp-sdk/complete.ts:63` omits it when the backend reports none): STOP and report to the maintainer with the row. Spec §9 requires both fields; do not relax the criterion or patch pricing without a ruling.

The `complete()` latency list is the rows without `turnId`; a one-shot that ran as a session (acceptance-gen carries a `turnId`) is a turn, not a `complete()`, and is not in that list.

Record: cost, duration, the `complete()` latency list, the cost-row table, the tool-audit counts and any tool errors with an explanation (the known S1 ones: stale-context ENOENT reads, the TDD red step, the `:!__tests__/` pathspec).

- [ ] **Step 6: If the smoke fails**

Stop. Do not push. Diagnose with the `nax-toolkit:nax-diagnose` skill against `~/.nax/nax-s4b-4-smoke/` and the run log. A transport defect is fixed on this branch with a regression test (TDD), then the smoke is re-run, which is a new billed launch and needs a new approval. At most two fix rounds; then report to the maintainer with the evidence.

---

### Task 5: Review, PR, merge

**Files:** none new.

- [ ] **Step 1: Code review**

Dispatch one code-review subagent (sonnet) over `git diff main...HEAD` with: spec §9-§11, this plan's Decisions and Review Focus, and the list of tests touched under D4-e. Fix CRITICAL and HIGH findings; at most two fix rounds.

- [ ] **Step 2: Push and open the PR (maintainer approval first)**

```bash
git push -u origin feat/s4b-4-sdk-default
gh pr create --base main --title "feat(nax): S4b-4 agent.acp.transport defaults to sdk (billed Claude smoke passed)" --body-file <body>
```

The body covers: the S4b-4 row and Done-when; D4-a..D4-g; the touched tests under the two D4-e headings; Task 3's dist outputs; the Task 4 smoke block (naxCommit, cost, duration, ACs, cost-row table, `complete()` latencies, tool-audit counts, process check, launcher kind); "No release; default flip only; acpx still selectable with `agent.acp.transport: \"acpx\"` until S4b-5."

- [ ] **Step 3: CI and merge**

Expected: CI green (it has no `claude-agent-acp` on PATH, which is the Review Focus 1 cross-check). Merge on the maintainer's call. After merge, update the S4b row in `projects/nax/nax-agent-master-plan.md` (maintainer workspace) and record the `complete()` latency against spec §13's warm-process item.

---

## Self-review notes

- Spec coverage: §10 S4b-4 smoke -> Task 4; flip -> Task 2; "suite green with the new default" -> Task 2 Steps 5-7, Task 5 Step 3; §9 smoke pass criteria and `complete()` latency -> Task 4 Step 5; "no acpx on PATH" -> Task 4 Step 1; no release -> Global Constraints, PR body.
- Review Focus lines map to Task 2 Step 6 (1), Task 1 (2), Task 2 Step 1 preflight test (3), Task 2 Step 3 + Task 3 Step 3 (4), Task 4 Step 5 (5).
- Out of scope here and left to S4b-5: deleting `agents/acp/`, the key, the `ACPX_` env prefix, install docs, the release.
