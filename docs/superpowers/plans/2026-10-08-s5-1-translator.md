# S5-1 Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** map S3 session events, turn ends and stored transcripts to ACP `session/update`s and prompt outcomes. This is the pure core S5-2 and S5-3 build on.

**Architecture:** a set of small modules under `packages/nax-agent-acp/src/server/translate/`. Each is pure apart from one injected file reader (the old-text read for Write diffs). A small stateful `createEventTranslator` remembers tool calls and approvals within one turn, so results and denials can reference them. Nothing here touches a connection.

**Tech Stack:** TypeScript ESM, `bun:test`, `@agentclientprotocol/sdk` 1.7.0 types (`SessionUpdate`, `ToolCallContent`, `ToolCallUpdate`, `ToolKind`, `ToolCallLocation`, `PromptResponse`, `Usage`, `RequestError`), `@nathapp/nax-agent` types (`SessionEvent`, `TokenUsage`, `TranscriptDoc`).

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` §4.1, §4.2, §4.4, §5.4. **Master plan:** `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md` (Global Constraints, decisions M-4, M-7).

## Global Constraints

Everything in the master plan's Global Constraints applies:
- Run commands from the package directory.
- Source files <= 600 lines, test files <= 800 lines.
- Per-file coverage >= 80%.
- No `throw new Error(` in `src/`.
- No Bun APIs in `src/`.
- Use `#src/` and `#test/` imports.
- Reach nax-agent through `@nathapp/nax-agent` only.

This slice is independent of S5-0 and can run on its own branch off main. It does not touch `src/server/index.ts`. The translator stays internal until S5-2 consumes it.

Task 0 changes `packages/nax-agent` (two new public exports). Run its gates from `packages/nax-agent`. The rest runs from `packages/nax-agent-acp`.

Exact values from the spec and master plan:
- Tool kinds per spec §4.2.
- Write-diff old text cap: 1 MiB (`1024 * 1024` bytes). Above it, `oldText: null` and `_meta.naxAgent.oldTextOmitted: "too-large"`.
- `usage_update.used` = input + output + cache-read + cache-write tokens (M-4). There is no `usage_update` when the context window is unknown.
- `turn_end` mapping:
  - `completed` -> `end_turn`
  - `cancelled` -> `cancelled`
  - `timed_out` -> `max_turn_requests` plus a warning notice
  - `errored` -> `RequestError.internalError` with `{ code, message }`
  - `interrupted` -> `internalError`, `AGENT_TURN_INTERRUPTED`
- Replay: Write gets no diff. A call without a recorded result is `failed` with the text `No result was recorded for this call.`

## Review Focus

- **Live and replayed output must mask secrets the same way.** A replayed tool result must not reveal a secret that the live preview masked. Task 0 exports nax-agent's own live masking functions, and Task 5 tests that a secret-shaped value in a stored result and input is masked on replay.
- **A tool input missing the expected fields** (Edit without `old_string`, Write without `content`, a non-object input). The translator must emit the tool call without a diff, never throw. Task 2 and Task 3 test this.
- **A tool result whose call was never seen**, for example a result that arrives after a reconnect. It must still yield a valid `tool_call_update` with no diff. Task 3 tests it.
- **`unpriced` cost rows:** these carry `costUsd: 0` and must not be shown as a real `$0`. Task 3 tests that `cost` is null for them.
- **A long or multi-line command or path in a title.** Titles stay one line, at most 60 characters of detail, with control characters stripped. Task 1 tests it.

## Decisions taken while planning

| # | Decision |
|---|---|
| M-7 | nax-agent's private `cappedInput` and `previewOf` (`src/native/session/turn-event-emitter.ts`) become public exports, `displayToolInput` and `toolResultPreview`. Live events already go through them. Replay (Task 5) uses them so stored inputs and results are masked and capped exactly like live ones. No behaviour change in nax-agent. |

## File Structure

| File | Responsibility |
|---|---|
| `packages/nax-agent/src/native/session/turn-event-emitter.ts`, `packages/nax-agent/src/index.ts` | Export `displayToolInput` and `toolResultPreview` (Task 0). |
| `src/server/translate/notice.ts` | `notice(severity, title, description?)`. |
| `src/server/translate/tool-kind.ts` | `toolKind`, `toolTitle`, `toolLocations`, `resolveToolPath`, `inputString`. |
| `src/server/translate/diff.ts` | `editDiff`, `toolDiff`, `fsReadOldText`, `OldText`, `ReadOldText`, `WRITE_DIFF_OLD_MAX_BYTES`. |
| `src/server/translate/events.ts` | `createEventTranslator`, `usageUpdate`. |
| `src/server/translate/stop.ts` | `promptOutcome`, `toAcpUsage`. |
| `src/server/translate/replay.ts` | `replayTranscript`. |

Tests mirror the files under `test/unit/server/translate/`.

---

### Task 0: Export nax-agent's live tool-display masking

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-event-emitter.ts`. Rename `cappedInput` to exported `displayToolInput`, and `previewOf` to exported `toolResultPreview`. Update the callers inside the same file.
- Modify: `packages/nax-agent/src/index.ts:163`
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (via the package's API update script)
- Test: `packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts`

**Interfaces:**
- Produces, from `@nathapp/nax-agent`:
  - `function displayToolInput(input: unknown): unknown`. This is the same masking and 8 KiB cap the live `tool_call.input` gets.
  - `function toolResultPreview(content: string): string`. This is the same masking and 4096-byte cap the live `tool_result.preview` gets.

- [ ] **Step 1: Write the failing test**

Append to `packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts`. Add the import of `displayToolInput`, `toolResultPreview`, `TOOL_CALL_INPUT_BYTES` and `TOOL_RESULT_PREVIEW_BYTES` from `#src/native/session/turn-event-emitter` to the file's existing import list:

```ts
describe("displayToolInput / toolResultPreview (public, S5-1 M-7)", () => {
  test("mask a secret-shaped value the way live events do", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    expect(JSON.stringify(displayToolInput({ path: ".env", content: `KEY=${secret}` }))).not.toContain(secret);
    expect(toolResultPreview(`token: ${secret}`)).not.toContain(secret);
  });

  test("cap to the live limits", () => {
    expect(Buffer.byteLength(toolResultPreview("x".repeat(TOOL_RESULT_PREVIEW_BYTES * 3)), "utf8")).toBeLessThanOrEqual(
      TOOL_RESULT_PREVIEW_BYTES,
    );
    expect(displayToolInput({ content: "y".repeat(TOOL_CALL_INPUT_BYTES * 2) })).toMatchObject({ truncated: true });
  });

  test("pass ordinary input through unchanged", () => {
    expect(displayToolInput({ path: "src/a.ts", old_string: "a", new_string: "b" })).toEqual({
      path: "src/a.ts",
      old_string: "a",
      new_string: "b",
    });
  });
});
```

If the secret shape above is not one nax-agent's redactor recognises, the first test fails at Step 4 rather than Step 2. In that case copy a known-redacted value from the existing redaction tests (`packages/nax-agent/test/unit/internal/redact*.test.ts`). Do not loosen the assertion.

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent`): `bun test ./test/unit/native/session/turn-event-emitter.test.ts`
Expected: FAIL. `displayToolInput` is not exported.

- [ ] **Step 3: Implement**

In `turn-event-emitter.ts`:
- Rename `function cappedInput(input: unknown): unknown` to `export function displayToolInput(input: unknown): unknown`.
- Rename `function previewOf(content: string): string` to `export function toolResultPreview(content: string): string`.
- Replace every call of the old names in that file.

Give each a one-line doc comment: "The masking and cap live `tool_call.input` gets; exported for ACP replay (S5-1)." Use "...`tool_result.preview` gets..." for the second.

In `src/index.ts`, change line 163 to:

```ts
export {
  displayToolInput,
  TOOL_CALL_INPUT_BYTES,
  TOOL_RESULT_PREVIEW_BYTES,
  toolResultPreview,
} from "#src/native/session/turn-event-emitter";
```

- [ ] **Step 4: Run tests, update the API snapshot**

Run (from `packages/nax-agent`):

```bash
bun test ./test/unit/native/session/ --timeout=60000
bun run api:update
bun run typecheck && bun run lint:fix && bun run check:all
```

Expected: all PASS. The API snapshot gains the `displayToolInput` and `toolResultPreview` lines. If the package names the script differently, run `jq .scripts package.json` and use its API-snapshot update script.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/session/turn-event-emitter.ts packages/nax-agent/src/index.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts
git commit -m "feat(nax-agent): export live tool-display masking for ACP replay (S5-1)"
```

---

### Task 1: Notices, tool kinds, titles and locations

**Files:**
- Create: `packages/nax-agent-acp/src/server/translate/notice.ts`
- Create: `packages/nax-agent-acp/src/server/translate/tool-kind.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/notice.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/tool-kind.test.ts`

**Interfaces:**
- Produces:
  - `type NoticeSeverity = "info" | "warning" | "error"`
  - `function notice(severity: NoticeSeverity, title: string, description?: string): SessionUpdate`
  - `function toolKind(name: string): ToolKind`
  - `function inputString(input: unknown, key: string): string | undefined`
  - `function toolTitle(name: string, input: unknown): string`
  - `function resolveToolPath(cwd: string, path: string): string`
  - `function toolLocations(name: string, input: unknown, cwd: string): ToolCallLocation[] | undefined`
  - `const TITLE_DETAIL_MAX = 60`

- [ ] **Step 1: Write the failing tests**

`test/unit/server/translate/notice.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { notice } from "#src/server/translate/notice";

describe("notice", () => {
  test("builds a notice update, with the description only when given", () => {
    expect(notice("info", "Response restarted")).toEqual({
      sessionUpdate: "notice",
      severity: "info",
      title: "Response restarted",
    });
    expect(notice("warning", "Turn timed out", "limit 60s")).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Turn timed out",
      description: "limit 60s",
    });
  });
});
```

`test/unit/server/translate/tool-kind.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TITLE_DETAIL_MAX, toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

describe("toolKind (spec §4.2)", () => {
  test.each([
    ["Read", "read"],
    ["ScratchpadRead", "read"],
    ["ScratchpadList", "read"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["ScratchpadWrite", "edit"],
    ["Delete", "delete"],
    ["Bash", "execute"],
    ["RunCommand", "execute"],
    ["Git", "execute"],
    ["GitCommit", "execute"],
    ["RequestCapability", "other"],
    ["my_embedder_tool", "other"],
    ["constructor", "other"],
  ])("%s -> %s", (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });
});

describe("toolTitle", () => {
  test("names the path, pattern, command, subcommand or commit subject", () => {
    expect(toolTitle("Edit", { path: "src/a.ts" })).toBe("Edit src/a.ts");
    expect(toolTitle("ScratchpadWrite", { path: "notes.md", content: "x" })).toBe("ScratchpadWrite notes.md");
    expect(toolTitle("Grep", { pattern: "TODO" })).toBe("Grep TODO");
    expect(toolTitle("Bash", { command: "bun test ./test/unit/" })).toBe("Bash: bun test ./test/unit/");
    expect(toolTitle("Git", { subcommand: "status" })).toBe("Git status");
    expect(toolTitle("GitCommit", { message: "fix: a\n\nbody", paths: ["a"] })).toBe("GitCommit: fix: a");
  });

  test("falls back to the tool name for unknown or malformed input", () => {
    expect(toolTitle("RequestCapability", { anything: 1 })).toBe("RequestCapability");
    expect(toolTitle("Edit", "not an object")).toBe("Edit");
    expect(toolTitle("Bash", { command: 42 })).toBe("Bash");
  });

  test("keeps the detail to one line of at most 60 characters, without control characters", () => {
    const title = toolTitle("Bash", { command: `echo a\n\techo b\u001b[31m ${"x".repeat(100)}` });
    const detail = title.slice("Bash: ".length);
    expect(detail.length).toBeLessThanOrEqual(TITLE_DETAIL_MAX);
    expect(detail).not.toMatch(/[\n\t\u001b]/);
    expect(detail.startsWith("echo a echo b[31m")).toBe(true);
    expect(detail.endsWith("...")).toBe(true);
  });
});

describe("toolLocations", () => {
  test("resolves the path of Read, Write, Edit and Delete against the session cwd", () => {
    expect(toolLocations("Read", { path: "src/a.ts" }, "/repo")).toEqual([{ path: "/repo/src/a.ts" }]);
    expect(toolLocations("Delete", { path: "/abs/b.ts" }, "/repo")).toEqual([{ path: "/abs/b.ts" }]);
  });

  test("none for other tools or a missing path", () => {
    expect(toolLocations("ScratchpadWrite", { path: "n.md" }, "/repo")).toBeUndefined();
    expect(toolLocations("Bash", { command: "ls" }, "/repo")).toBeUndefined();
    expect(toolLocations("Edit", {}, "/repo")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/translate/notice.test.ts ./test/unit/server/translate/tool-kind.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement**

`src/server/translate/notice.ts`:

```ts
/** A `notice` session update (S5 spec §4.1, §4.3, §4.4). */
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type NoticeSeverity = "info" | "warning" | "error";

export function notice(severity: NoticeSeverity, title: string, description?: string): SessionUpdate {
  return { sessionUpdate: "notice", severity, title, ...(description !== undefined ? { description } : {}) };
}
```

`src/server/translate/tool-kind.ts`:

```ts
/**
 * How a native tool call is shown to an ACP client (S5 spec §4.2): its kind, a
 * one-line title and the file it touches. Inputs are model-written, so every
 * field is checked before use and titles are stripped of control characters.
 */
import { resolve } from "node:path";
import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { isRecord, stripControl } from "#src/client/text";

export const TITLE_DETAIL_MAX = 60;

const KIND_BY_TOOL: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["Read", "read"],
  ["ScratchpadRead", "read"],
  ["ScratchpadList", "read"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["ScratchpadWrite", "edit"],
  ["Delete", "delete"],
  ["Bash", "execute"],
  ["RunCommand", "execute"],
  ["Git", "execute"],
  ["GitCommit", "execute"],
]);

/** Tools whose `path` is a repository file (scratchpad paths are not). */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Delete"]);

export function toolKind(name: string): ToolKind {
  return KIND_BY_TOOL.get(name) ?? "other";
}

export function inputString(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function oneLine(text: string): string {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  return flat.length > TITLE_DETAIL_MAX ? `${flat.slice(0, TITLE_DETAIL_MAX - 3)}...` : flat;
}

export function toolTitle(name: string, input: unknown): string {
  const kind = toolKind(name);
  const path = inputString(input, "path");
  if (path !== undefined && (FILE_TOOLS.has(name) || name.startsWith("Scratchpad"))) return `${name} ${oneLine(path)}`;
  const pattern = inputString(input, "pattern");
  if (pattern !== undefined && kind === "search") return `${name} ${oneLine(pattern)}`;
  const command = inputString(input, "command");
  if (command !== undefined && kind === "execute") return `${name}: ${oneLine(command)}`;
  const subcommand = inputString(input, "subcommand");
  if (name === "Git" && subcommand !== undefined) return `Git ${oneLine(subcommand)}`;
  const message = inputString(input, "message");
  if (name === "GitCommit" && message !== undefined) return `GitCommit: ${oneLine(message.split("\n")[0] ?? "")}`;
  return name;
}

export function resolveToolPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function toolLocations(name: string, input: unknown, cwd: string): ToolCallLocation[] | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  const path = inputString(input, "path");
  return path === undefined ? undefined : [{ path: resolveToolPath(cwd, path) }];
}
```

`stripControl` keeps `\n` and `\t`. The `\s+` collapse then turns them into single spaces. That's why the title test expects `echo a echo b[31m`: the ESC byte is dropped and the `[31m` text stays.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test ./test/unit/server/translate/notice.test.ts ./test/unit/server/translate/tool-kind.test.ts`
Expected: PASS, 22 tests (1 notice test, 16 kind cases, 3 title tests, 2 location tests).

- [ ] **Step 5: Lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/translate/notice.ts src/server/translate/tool-kind.ts test/unit/server/translate/notice.test.ts test/unit/server/translate/tool-kind.test.ts
git commit -m "feat(acp-server): tool kinds, titles, locations and notices (S5-1)"
```

---

### Task 2: Diffs for Edit and Write

**Files:**
- Create: `packages/nax-agent-acp/src/server/translate/diff.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/diff.test.ts`

**Interfaces:**
- Consumes: `inputString`, `resolveToolPath` (Task 1).
- Produces:
  - `type DiffContent = Extract<ToolCallContent, { type: "diff" }>`
  - `const WRITE_DIFF_OLD_MAX_BYTES = 1048576`
  - `type OldText = { readonly kind: "text"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "too-large" } | { readonly kind: "unreadable" }`
  - `type ReadOldText = (absolutePath: string) => Promise<OldText>`
  - `interface OldTextFs { stat(path: string): Promise<{ readonly size: number; isFile(): boolean }>; readFile(path: string, encoding: "utf8"): Promise<string> }`
  - `function fsReadOldText(fs?: OldTextFs): ReadOldText`
  - `function editDiff(input: unknown, cwd: string): DiffContent | undefined`
  - `function toolDiff(name: string, input: unknown, cwd: string, readOld: ReadOldText): Promise<DiffContent | undefined>`

- [ ] **Step 1: Write the failing tests**

`test/unit/server/translate/diff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  editDiff,
  fsReadOldText,
  type OldText,
  type ReadOldText,
  toolDiff,
  WRITE_DIFF_OLD_MAX_BYTES,
} from "#src/server/translate/diff";

const fixed =
  (old: OldText): ReadOldText =>
  async () =>
    old;

describe("editDiff", () => {
  test("old_string and new_string as the diff, path resolved against cwd", () => {
    expect(editDiff({ path: "src/a.ts", old_string: "a", new_string: "b" }, "/repo")).toEqual({
      type: "diff",
      path: "/repo/src/a.ts",
      oldText: "a",
      newText: "b",
    });
  });

  test("no diff when a field is missing or the input is not an object", () => {
    expect(editDiff({ path: "a", old_string: "a" }, "/repo")).toBeUndefined();
    expect(editDiff("Edit a", "/repo")).toBeUndefined();
  });
});

describe("toolDiff", () => {
  test("Edit ignores the reader", async () => {
    const never: ReadOldText = async () => {
      throw new Error("must not read");
    };
    expect(await toolDiff("Edit", { path: "a", old_string: "x", new_string: "y" }, "/r", never)).toMatchObject({
      oldText: "x",
      newText: "y",
    });
  });

  test("Write over an existing file carries the current content as old text", async () => {
    expect(
      await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind: "text", text: "old" })),
    ).toEqual({ type: "diff", path: "/r/a.ts", oldText: "old", newText: "new" });
  });

  test("Write of a new file has null old text", async () => {
    expect(await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind: "missing" }))).toEqual({
      type: "diff",
      path: "/r/a.ts",
      oldText: null,
      newText: "new",
    });
  });

  test.each(["too-large", "unreadable"] as const)("Write with %s old text marks the omission", async (kind) => {
    expect(await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind }))).toEqual({
      type: "diff",
      path: "/r/a.ts",
      oldText: null,
      newText: "new",
      _meta: { naxAgent: { oldTextOmitted: kind } },
    });
  });

  test("no diff for other tools or a Write without content", async () => {
    const reader = fixed({ kind: "missing" });
    expect(await toolDiff("Read", { path: "a" }, "/r", reader)).toBeUndefined();
    expect(await toolDiff("Write", { path: "a" }, "/r", reader)).toBeUndefined();
  });
});

describe("fsReadOldText", () => {
  test("text, missing, unreadable (a directory) and too-large on a real filesystem", async () => {
    const dir = makeTempDir("acp-diff-");
    try {
      writeFileSync(join(dir, "small.txt"), "hello");
      writeFileSync(join(dir, "big.txt"), "x".repeat(WRITE_DIFF_OLD_MAX_BYTES + 1));
      mkdirSync(join(dir, "sub"));
      const read = fsReadOldText();
      expect(await read(join(dir, "small.txt"))).toEqual({ kind: "text", text: "hello" });
      expect(await read(join(dir, "absent.txt"))).toEqual({ kind: "missing" });
      expect(await read(join(dir, "sub"))).toEqual({ kind: "unreadable" });
      expect(await read(join(dir, "big.txt"))).toEqual({ kind: "too-large" });
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("an error other than ENOENT is unreadable", async () => {
    const read = fsReadOldText({
      stat: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      readFile: async () => "",
    });
    expect(await read("/x")).toEqual({ kind: "unreadable" });
  });
});
```

`throw new Error(` inside a test file is allowed; the gate scans `src/` only.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/translate/diff.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/server/translate/diff.ts`**

```ts
/**
 * Diffs for Edit and Write tool calls (S5 spec §4.2), built from the tool input
 * so the editor can show them at permission time, before the tool runs. Write's
 * old text is read from disk through an injected reader (the server runs locally).
 */
import { readFile, stat } from "node:fs/promises";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { inputString, resolveToolPath } from "#src/server/translate/tool-kind";

export type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

export const WRITE_DIFF_OLD_MAX_BYTES = 1024 * 1024;

export type OldText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" };

export type ReadOldText = (absolutePath: string) => Promise<OldText>;

export interface OldTextFs {
  stat(path: string): Promise<{ readonly size: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const NODE_FS: OldTextFs = { stat, readFile: (path, encoding) => readFile(path, encoding) };

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function fsReadOldText(fs: OldTextFs = NODE_FS): ReadOldText {
  return async (path) => {
    try {
      const info = await fs.stat(path);
      if (!info.isFile()) return { kind: "unreadable" };
      if (info.size > WRITE_DIFF_OLD_MAX_BYTES) return { kind: "too-large" };
      return { kind: "text", text: await fs.readFile(path, "utf8") };
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "unreadable" };
    }
  };
}

export function editDiff(input: unknown, cwd: string): DiffContent | undefined {
  const path = inputString(input, "path");
  const oldText = inputString(input, "old_string");
  const newText = inputString(input, "new_string");
  if (path === undefined || oldText === undefined || newText === undefined) return undefined;
  return { type: "diff", path: resolveToolPath(cwd, path), oldText, newText };
}

async function writeDiff(input: unknown, cwd: string, readOld: ReadOldText): Promise<DiffContent | undefined> {
  const path = inputString(input, "path");
  const newText = inputString(input, "content");
  if (path === undefined || newText === undefined) return undefined;
  const absolute = resolveToolPath(cwd, path);
  const old = await readOld(absolute);
  switch (old.kind) {
    case "text":
      return { type: "diff", path: absolute, oldText: old.text, newText };
    case "missing":
      return { type: "diff", path: absolute, oldText: null, newText };
    case "too-large":
    case "unreadable":
      return { type: "diff", path: absolute, oldText: null, newText, _meta: { naxAgent: { oldTextOmitted: old.kind } } };
  }
}

export async function toolDiff(
  name: string,
  input: unknown,
  cwd: string,
  readOld: ReadOldText,
): Promise<DiffContent | undefined> {
  if (name === "Edit") return editDiff(input, cwd);
  if (name === "Write") return writeDiff(input, cwd, readOld);
  return undefined;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test ./test/unit/server/translate/diff.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/translate/diff.ts test/unit/server/translate/diff.test.ts
git commit -m "feat(acp-server): Edit and Write diffs for tool calls (S5-1)"
```

---

### Task 3: The event translator

**Files:**
- Create: `packages/nax-agent-acp/src/server/translate/events.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/events.test.ts`

**Interfaces:**
- Consumes: `notice` (Task 1), `toolKind`, `toolTitle`, `toolLocations` (Task 1), `toolDiff`, `DiffContent`, `ReadOldText` (Task 2).
- Produces:
  - `interface EventTranslatorDeps { readonly cwd: string; readonly contextWindow?: number; readonly readOldText: ReadOldText }`
  - `interface EventTranslator { translate(event: SessionEvent): Promise<readonly SessionUpdate[]>; toolCallFor(callId: string): ToolCallUpdate | undefined }`
  - `function createEventTranslator(deps: EventTranslatorDeps): EventTranslator`
  - `function usageUpdate(event: UsageEvent, contextWindow: number | undefined): SessionUpdate[]`, where `UsageEvent = Extract<SessionEvent, { type: "usage" }>`
  - `function textContent(text: string): Extract<ToolCallContent, { type: "content" }>`

`translate` returns `[]` for `turn_start`, `question` and `turn_end`. S5-2's session handles those. `approval_requested` is recorded and returns `[]`. `toolCallFor(callId)` is what S5-2 puts in a permission request: the remembered call with `status: "pending"`.

- [ ] **Step 1: Write the failing tests**

`test/unit/server/translate/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import type { ReadOldText } from "#src/server/translate/diff";
import { createEventTranslator } from "#src/server/translate/events";

const BASE = { sessionId: "s1", turnId: "t1", at: "2026-10-08T00:00:00.000Z", metadata: {} };
const ev = (body: Record<string, unknown>): SessionEvent => ({ ...BASE, ...body }) as SessionEvent;
const noOld: ReadOldText = async () => ({ kind: "missing" });

function translator(contextWindow?: number) {
  return createEventTranslator({
    cwd: "/repo",
    readOldText: noOld,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
}

describe("streamed text", () => {
  test("text and thinking deltas become message and thought chunks", async () => {
    const t = translator();
    expect(await t.translate(ev({ type: "text_delta", round: 1, text: "hi" }))).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(await t.translate(ev({ type: "thinking_delta", round: 1, text: "hmm" }))).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
  });

  test("stream_reset is an info notice naming the attempt", async () => {
    expect(await translator().translate(ev({ type: "stream_reset", round: 1, attempt: 2 }))).toEqual([
      {
        sessionUpdate: "notice",
        severity: "info",
        title: "Response restarted",
        description: "The model stream was retried (attempt 2); text above may repeat.",
      },
    ]);
  });
});

describe("tool calls", () => {
  test("a call is in_progress with kind, title, locations, raw input and its diff", async () => {
    const input = { path: "src/a.ts", old_string: "a", new_string: "b" };
    expect(await translator().translate(ev({ type: "tool_call", callId: "c1", name: "Edit", input }))).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit src/a.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: input,
        locations: [{ path: "/repo/src/a.ts" }],
        content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
      },
    ]);
  });

  test("the result completes or fails the call and repeats the diff", async () => {
    const t = translator();
    await t.translate(ev({ type: "tool_call", callId: "c1", name: "Write", input: { path: "n.ts", content: "x" } }));
    expect(await t.translate(ev({ type: "tool_result", callId: "c1", isError: false, preview: "wrote" }))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "wrote" } },
          { type: "diff", path: "/repo/n.ts", oldText: null, newText: "x" },
        ],
      },
    ]);
    await t.translate(ev({ type: "tool_call", callId: "c2", name: "Bash", input: { command: "false" } }));
    expect(await t.translate(ev({ type: "tool_result", callId: "c2", isError: true, preview: "exit 1" }))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c2",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
      },
    ]);
  });

  test("a result for a call never seen still yields a valid update", async () => {
    expect(
      await translator().translate(ev({ type: "tool_result", callId: "zz", isError: false, preview: "ok" })),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "zz",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      },
    ]);
  });

  test("malformed input: no diff, no locations, title is the name", async () => {
    const [update] = await translator().translate(ev({ type: "tool_call", callId: "c", name: "Edit", input: "?" }));
    expect(update).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "c",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: "?",
    });
  });

  test("toolCallFor returns the remembered call as pending, or undefined", async () => {
    const t = translator();
    await t.translate(ev({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "rm -rf build" } }));
    expect(t.toolCallFor("c1")).toEqual({
      toolCallId: "c1",
      title: "Bash: rm -rf build",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf build" },
    });
    expect(t.toolCallFor("nope")).toBeUndefined();
  });
});

describe("approvals", () => {
  test("a profile deny fails the call with the reason; other resolutions emit nothing", async () => {
    const t = translator();
    const requested = (requestId: string) =>
      ev({
        type: "approval_requested",
        requestId,
        callId: "c1",
        tool: "Write",
        summary: "Write a.ts",
        reason: "read-only mode",
        expiresAt: BASE.at,
      });
    expect(await t.translate(requested("r1"))).toEqual([]);
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r1", decision: "deny", decidedBy: "profile" })),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Denied by the session mode: read-only mode" } }],
      },
    ]);
    await t.translate(requested("r2"));
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r2", decision: "allow", decidedBy: "profile" })),
    ).toEqual([]);
    await t.translate(requested("r3"));
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r3", decision: "deny", decidedBy: "human" })),
    ).toEqual([]);
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "unknown", decision: "deny", decidedBy: "profile" })),
    ).toEqual([]);
  });
});

describe("usage and compaction", () => {
  const usage = (extra: Record<string, unknown> = {}) =>
    ev({ type: "usage", round: 1, inputTokens: 100, outputTokens: 20, cacheRead: 30, cacheWrite: 5, costUsd: 0.01, ...extra });

  test("usage_update counts every token kind against the context window (M-4)", async () => {
    expect(await translator(1000).translate(usage({ costSource: "computed" }))).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 155,
        size: 1000,
        cost: { amount: 0.01, currency: "USD" },
        _meta: { naxAgent: { costSource: "computed" } },
      },
    ]);
  });

  test("unpriced rows carry no cost; an unknown window sends nothing", async () => {
    const [update] = await translator(1000).translate(usage({ costUsd: 0, costSource: "unpriced" }));
    expect(update).toMatchObject({ sessionUpdate: "usage_update", cost: null });
    expect(await translator().translate(usage())).toEqual([]);
  });

  test("each compaction gets its own id", async () => {
    const t = translator();
    const first = await t.translate(ev({ type: "compaction", reason: "proactive" }));
    const second = await t.translate(ev({ type: "compaction", reason: "overflow" }));
    expect(first).toEqual([
      { sessionUpdate: "compaction_update", compactionId: "t1-1", status: "completed", _meta: { naxAgent: { reason: "proactive" } } },
    ]);
    expect(second[0]).toMatchObject({ compactionId: "t1-2" });
  });
});

describe("events the session handles", () => {
  test.each([
    { type: "turn_start" },
    { type: "question", requestId: "q", text: "?", expiresAt: BASE.at },
    { type: "turn_end", status: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 },
  ])("$type translates to nothing", async (body) => {
    expect(await translator().translate(ev(body))).toEqual([]);
  });
});
```

The `ev` helper's `as SessionEvent` is a single-step assertion on a constructed literal, not `as unknown as`, so it passes `check-test-as-unknown-as`. If biome flags it, replace `ev` with typed literals per test.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/translate/events.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/server/translate/events.ts`**

```ts
/**
 * S3 session events -> ACP session updates (S5 spec §4.1-§4.3). One translator
 * per turn: it remembers tool calls (for result diffs and permission requests)
 * and approval requests (to fail a call the session mode denied). Permission
 * requests, questions and the turn end are the session's job (S5-2).
 */
import type { SessionUpdate, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@nathapp/nax-agent";
import { type DiffContent, type ReadOldText, toolDiff } from "#src/server/translate/diff";
import { notice } from "#src/server/translate/notice";
import { toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

export interface EventTranslatorDeps {
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly readOldText: ReadOldText;
}

export interface EventTranslator {
  translate(event: SessionEvent): Promise<readonly SessionUpdate[]>;
  toolCallFor(callId: string): ToolCallUpdate | undefined;
}

export type UsageEvent = Extract<SessionEvent, { type: "usage" }>;

interface KnownCall {
  readonly name: string;
  readonly input: unknown;
  readonly diff?: DiffContent;
}

interface KnownApproval {
  readonly callId: string;
  readonly reason: string;
}

export function textContent(text: string): Extract<ToolCallContent, { type: "content" }> {
  return { type: "content", content: { type: "text", text } };
}

export function usageUpdate(event: UsageEvent, contextWindow: number | undefined): SessionUpdate[] {
  if (contextWindow === undefined) return [];
  const used = event.inputTokens + event.outputTokens + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0);
  return [
    {
      sessionUpdate: "usage_update",
      used,
      size: contextWindow,
      cost: event.costSource === "unpriced" ? null : { amount: event.costUsd, currency: "USD" },
      ...(event.costSource !== undefined ? { _meta: { naxAgent: { costSource: event.costSource } } } : {}),
    },
  ];
}

export function createEventTranslator(deps: EventTranslatorDeps): EventTranslator {
  const calls = new Map<string, KnownCall>();
  const approvals = new Map<string, KnownApproval>();
  let compactions = 0;

  const describeCall = (toolCallId: string, call: KnownCall) => {
    const locations = toolLocations(call.name, call.input, deps.cwd);
    return {
      toolCallId,
      title: toolTitle(call.name, call.input),
      kind: toolKind(call.name),
      rawInput: call.input,
      ...(locations !== undefined ? { locations } : {}),
      ...(call.diff !== undefined ? { content: [call.diff] } : {}),
    };
  };

  async function translate(event: SessionEvent): Promise<readonly SessionUpdate[]> {
    switch (event.type) {
      case "text_delta":
        return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } }];
      case "thinking_delta":
        return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } }];
      case "stream_reset":
        return [
          notice(
            "info",
            "Response restarted",
            `The model stream was retried (attempt ${event.attempt}); text above may repeat.`,
          ),
        ];
      case "tool_call": {
        const diff = await toolDiff(event.name, event.input, deps.cwd, deps.readOldText);
        const call: KnownCall = { name: event.name, input: event.input, ...(diff !== undefined ? { diff } : {}) };
        calls.set(event.callId, call);
        return [{ sessionUpdate: "tool_call", ...describeCall(event.callId, call), status: "in_progress" }];
      }
      case "tool_result": {
        const diff = calls.get(event.callId)?.diff;
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: event.isError ? "failed" : "completed",
            content: [textContent(event.preview), ...(diff !== undefined ? [diff] : [])],
          },
        ];
      }
      case "usage":
        return usageUpdate(event, deps.contextWindow);
      case "compaction":
        compactions += 1;
        return [
          {
            sessionUpdate: "compaction_update",
            compactionId: `${event.turnId}-${compactions}`,
            status: "completed",
            _meta: { naxAgent: { reason: event.reason } },
          },
        ];
      case "approval_requested":
        if (event.callId !== undefined) approvals.set(event.requestId, { callId: event.callId, reason: event.reason });
        return [];
      case "approval_resolved": {
        const approval = approvals.get(event.requestId);
        approvals.delete(event.requestId);
        if (approval === undefined || event.decidedBy !== "profile" || event.decision !== "deny") return [];
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: approval.callId,
            status: "failed",
            content: [textContent(`Denied by the session mode: ${approval.reason}`)],
          },
        ];
      }
      case "turn_start":
      case "question":
      case "turn_end":
        return [];
    }
  }

  return {
    translate,
    toolCallFor(callId) {
      const call = calls.get(callId);
      return call === undefined ? undefined : { ...describeCall(callId, call), status: "pending" };
    },
  };
}
```

The `switch` covers every `SessionEvent` type, so TypeScript proves the function returns on all paths. If nax-agent adds an event type later, `typecheck` fails here. That is intended.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test ./test/unit/server/translate/events.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/translate/events.ts test/unit/server/translate/events.test.ts
git commit -m "feat(acp-server): S3 session events to ACP session updates (S5-1)"
```

---

### Task 4: Turn end -> prompt outcome

**Files:**
- Create: `packages/nax-agent-acp/src/server/translate/stop.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/stop.test.ts`

**Interfaces:**
- Consumes: `notice` (Task 1).
- Produces:
  - `type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>`
  - `type PromptOutcome = { readonly kind: "response"; readonly response: PromptResponse; readonly notices: readonly SessionUpdate[] } | { readonly kind: "error"; readonly error: RequestError }`
  - `function toAcpUsage(usage: TokenUsage): Usage`
  - `function promptOutcome(end: TurnEndEvent, turnTimeoutSeconds: number): PromptOutcome`

S5-2 sends `notices` as session updates before it resolves the prompt with `response`, or rejects it with `error`.

- [ ] **Step 1: Write the failing tests**

`test/unit/server/translate/stop.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnEndStatus } from "@nathapp/nax-agent";
import { promptOutcome, type TurnEndEvent, toAcpUsage } from "#src/server/translate/stop";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 };

function end(status: TurnEndStatus, error?: { code: string; message: string }): TurnEndEvent {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-08T00:00:00.000Z",
    metadata: {},
    type: "turn_end",
    status,
    output: "",
    usage: USAGE,
    costUsd: 0.02,
    ...(error !== undefined ? { error } : {}),
  };
}

describe("toAcpUsage", () => {
  test("maps every count and totals them", () => {
    expect(toAcpUsage(USAGE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
      totalTokens: 20,
    });
  });

  test("omits absent cache counts", () => {
    expect(toAcpUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });
});

describe("promptOutcome (spec §4.4)", () => {
  test("completed -> end_turn, cancelled -> cancelled, no notices", () => {
    expect(promptOutcome(end("completed"), 60)).toEqual({
      kind: "response",
      response: { stopReason: "end_turn", usage: toAcpUsage(USAGE) },
      notices: [],
    });
    expect(promptOutcome(end("cancelled"), 60)).toMatchObject({ kind: "response", response: { stopReason: "cancelled" } });
  });

  test("timed_out -> max_turn_requests with a warning naming the limit", () => {
    expect(promptOutcome(end("timed_out"), 3600)).toEqual({
      kind: "response",
      response: { stopReason: "max_turn_requests", usage: toAcpUsage(USAGE) },
      notices: [
        {
          sessionUpdate: "notice",
          severity: "warning",
          title: "Turn timed out",
          description: "The turn reached its 3600s time limit and was stopped.",
        },
      ],
    });
  });

  test("errored -> internal error carrying the turn's code and message", () => {
    const outcome = promptOutcome(end("errored", { code: "PROVIDER_FAILED", message: "upstream 500" }), 60);
    expect(outcome.kind).toBe("error");
    const error = outcome.kind === "error" ? outcome.error : undefined;
    expect(error).toBeInstanceOf(RequestError);
    expect(error?.code).toBe(-32603);
    expect(error?.data).toEqual({ code: "PROVIDER_FAILED", message: "upstream 500" });
  });

  test("errored without detail and interrupted still produce an internal error", () => {
    const noDetail = promptOutcome(end("errored"), 60);
    expect(noDetail.kind === "error" ? noDetail.error.data : undefined).toEqual({
      code: "AGENT_TURN_ERRORED",
      message: "The turn failed",
    });
    const interrupted = promptOutcome(end("interrupted"), 60);
    expect(interrupted.kind === "error" ? interrupted.error.data : undefined).toEqual({
      code: "AGENT_TURN_INTERRUPTED",
      message: "The turn was interrupted",
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/translate/stop.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/server/translate/stop.ts`**

```ts
/**
 * A turn's end as the answer to `session/prompt` (S5 spec §4.4). `errored` is a
 * JSON-RPC error so editors show a failure, not a normal stop; `interrupted` only
 * occurs after a resume and is reported the same way if it ever reaches here.
 */
import { type PromptResponse, RequestError, type SessionUpdate, type Usage } from "@agentclientprotocol/sdk";
import type { SessionEvent, TokenUsage } from "@nathapp/nax-agent";
import { notice } from "#src/server/translate/notice";

export type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;

export type PromptOutcome =
  | { readonly kind: "response"; readonly response: PromptResponse; readonly notices: readonly SessionUpdate[] }
  | { readonly kind: "error"; readonly error: RequestError };

export function toAcpUsage(usage: TokenUsage): Usage {
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheRead !== undefined ? { cachedReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cachedWriteTokens: cacheWrite } : {}),
    totalTokens: usage.inputTokens + usage.outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function failure(code: string, message: string): PromptOutcome {
  return { kind: "error", error: RequestError.internalError({ code, message }, message) };
}

export function promptOutcome(end: TurnEndEvent, turnTimeoutSeconds: number): PromptOutcome {
  const usage = toAcpUsage(end.usage);
  switch (end.status) {
    case "completed":
      return { kind: "response", response: { stopReason: "end_turn", usage }, notices: [] };
    case "cancelled":
      return { kind: "response", response: { stopReason: "cancelled", usage }, notices: [] };
    case "timed_out":
      return {
        kind: "response",
        response: { stopReason: "max_turn_requests", usage },
        notices: [
          notice("warning", "Turn timed out", `The turn reached its ${turnTimeoutSeconds}s time limit and was stopped.`),
        ],
      };
    case "errored":
      return failure(end.error?.code ?? "AGENT_TURN_ERRORED", end.error?.message ?? "The turn failed");
    case "interrupted":
      return failure("AGENT_TURN_INTERRUPTED", "The turn was interrupted");
  }
}
```

`TokenUsage` from `@nathapp/nax-agent` is nax-ai's type re-exported (`cost/standard-types.ts`): `inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheWriteTokens?`.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test ./test/unit/server/translate/stop.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/translate/stop.ts test/unit/server/translate/stop.test.ts
git commit -m "feat(acp-server): turn end to prompt outcome and usage (S5-1)"
```

---

### Task 5: Transcript replay

**Files:**
- Create: `packages/nax-agent-acp/src/server/translate/replay.ts`
- Test: `packages/nax-agent-acp/test/unit/server/translate/replay.test.ts`

**Interfaces:**
- Consumes:
  - `editDiff` (Task 2);
  - `textContent` (Task 3);
  - `toolKind`, `toolTitle`, `toolLocations` (Task 1);
  - `displayToolInput`, `toolResultPreview` and `type TranscriptDoc` from `@nathapp/nax-agent` (Task 0).
- Produces:
  - `type TranscriptMessage = TranscriptDoc["messages"][number]`
  - `const NO_RESULT_TEXT = "No result was recorded for this call."`
  - `function replayTranscript(messages: readonly TranscriptMessage[], cwd: string): readonly SessionUpdate[]`

- [ ] **Step 1: Write the failing tests**

`test/unit/server/translate/replay.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TOOL_RESULT_PREVIEW_BYTES } from "@nathapp/nax-agent";
import { NO_RESULT_TEXT, replayTranscript, type TranscriptMessage } from "#src/server/translate/replay";

const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

describe("replayTranscript (spec §5.4)", () => {
  test("user, thinking, assistant text and a completed Edit with its diff, in order", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "rename a to b" },
      {
        role: "assistant",
        content: "Done.",
        thinking: [{ text: "Edit needed" }],
        toolCalls: [{ id: "c1", name: "Edit", input: { path: "src/x.ts", old_string: "a", new_string: "b" } }],
      },
      { role: "tool-result", toolCallId: "c1", content: "edited" },
    ];
    expect(replayTranscript(messages, "/repo")).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "rename a to b" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Edit needed" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit src/x.ts",
        kind: "edit",
        status: "completed",
        rawInput: { path: "src/x.ts", old_string: "a", new_string: "b" },
        locations: [{ path: "/repo/src/x.ts" }],
        content: [text("edited"), { type: "diff", path: "/repo/src/x.ts", oldText: "a", newText: "b" }],
      },
    ]);
  });

  test("Write replays without a diff; a failed result is failed; a missing result is failed with a note", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "w", name: "Write", input: { path: "n.ts", content: "x" } },
          { id: "b", name: "Bash", input: { command: "false" } },
          { id: "lost", name: "Read", input: { path: "r.ts" } },
        ],
      },
      { role: "tool-result", toolCallId: "w", content: "wrote" },
      { role: "tool-result", toolCallId: "b", content: "exit 1", isError: true },
    ];
    const updates = replayTranscript(messages, "/repo");
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({ toolCallId: "w", status: "completed", content: [text("wrote")] });
    expect(updates[1]).toMatchObject({ toolCallId: "b", status: "failed", content: [text("exit 1")] });
    expect(updates[2]).toMatchObject({ toolCallId: "lost", status: "failed", content: [text(NO_RESULT_TEXT)] });
  });

  test("empty user and assistant text are skipped", () => {
    expect(replayTranscript([{ role: "user", content: "" }, { role: "assistant", content: "" }], "/r")).toEqual([]);
  });

  test("results are capped to the live preview size", () => {
    const messages: TranscriptMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "Read", input: { path: "big" } }] },
      { role: "tool-result", toolCallId: "c", content: "z".repeat(TOOL_RESULT_PREVIEW_BYTES * 4) },
    ];
    const [update] = replayTranscript(messages, "/r");
    const shown = update?.sessionUpdate === "tool_call" ? update.content?.[0] : undefined;
    const shownText = shown?.type === "content" && shown.content.type === "text" ? shown.content.text : "";
    expect(Buffer.byteLength(shownText, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
  });

  test("secrets in stored inputs and results are masked as live events mask them (M-7)", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const messages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c", name: "Write", input: { path: ".env", content: `KEY=${secret}` } }],
      },
      { role: "tool-result", toolCallId: "c", content: `wrote KEY=${secret}` },
    ];
    expect(JSON.stringify(replayTranscript(messages, "/r"))).not.toContain(secret);
  });
});
```

Use the same secret value Task 0's test settled on. If Task 0 had to switch to a value from the redaction tests, use that value here too.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test ./test/unit/server/translate/replay.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/server/translate/replay.ts`**

```ts
/**
 * A stored transcript as session updates for `session/load` (S5 spec §5.4).
 * Inputs and results go through nax-agent's live masking and caps (M-7), so a
 * replay never shows more than the live turn did. Write gets no diff: the file's
 * old content at that time is gone.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { displayToolInput, type TranscriptDoc, toolResultPreview } from "@nathapp/nax-agent";
import { editDiff } from "#src/server/translate/diff";
import { textContent } from "#src/server/translate/events";
import { toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

export type TranscriptMessage = TranscriptDoc["messages"][number];

export const NO_RESULT_TEXT = "No result was recorded for this call.";

interface StoredResult {
  readonly content: string;
  readonly isError: boolean;
}

type AssistantMessage = Extract<TranscriptMessage, { role: "assistant" }>;
type StoredCall = NonNullable<AssistantMessage["toolCalls"]>[number];

function replayCall(call: StoredCall, result: StoredResult | undefined, cwd: string): SessionUpdate {
  const input = displayToolInput(call.input);
  const diff = call.name === "Edit" ? editDiff(input, cwd) : undefined;
  const locations = toolLocations(call.name, input, cwd);
  const shown = result === undefined ? NO_RESULT_TEXT : toolResultPreview(result.content);
  return {
    sessionUpdate: "tool_call",
    toolCallId: call.id,
    title: toolTitle(call.name, input),
    kind: toolKind(call.name),
    status: result === undefined || result.isError ? "failed" : "completed",
    rawInput: input,
    ...(locations !== undefined ? { locations } : {}),
    content: [textContent(shown), ...(diff !== undefined ? [diff] : [])],
  };
}

function replayMessage(
  message: TranscriptMessage,
  results: ReadonlyMap<string, StoredResult>,
  cwd: string,
): SessionUpdate[] {
  switch (message.role) {
    case "user":
      return message.content === ""
        ? []
        : [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } }];
    case "tool-result":
      return [];
    case "assistant": {
      const thoughts = (message.thinking ?? [])
        .filter((block) => block.text !== "")
        .map(
          (block): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.text } }),
        );
      const said: SessionUpdate[] =
        message.content === ""
          ? []
          : [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } }];
      const calls = (message.toolCalls ?? []).map((call) => replayCall(call, results.get(call.id), cwd));
      return [...thoughts, ...said, ...calls];
    }
  }
}

export function replayTranscript(messages: readonly TranscriptMessage[], cwd: string): readonly SessionUpdate[] {
  const results = new Map<string, StoredResult>();
  for (const message of messages) {
    if (message.role === "tool-result") {
      results.set(message.toolCallId, { content: message.content, isError: message.isError === true });
    }
  }
  return messages.flatMap((message) => replayMessage(message, results, cwd));
}
```

A replayed Edit diff is built from the masked input. In the rare case a secret sits in an edited line, the diff shows the mask, exactly as live (spec §4.2, known limitation).

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test ./test/unit/server/translate/replay.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full gates and commit**

```bash
bun run typecheck && bun run lint:fix && bun run check:all && bun test ./test/unit/ --timeout=60000 && bun run test:coverage
```

Expected: all green, with every `src/server/translate/*.ts` file at or above 80% line coverage. If one is below, add the missing branch test to its test file. Never update the baseline to pass.

```bash
git add src/server/translate/replay.ts test/unit/server/translate/replay.test.ts
git commit -m "feat(acp-server): transcript replay as session updates (S5-1)"
```

---

## Done when

- From `packages/nax-agent`: `bun run typecheck`, `bun run check:all` and the unit suite are green. The API snapshot lists `displayToolInput` and `toolResultPreview`.
- From `packages/nax-agent-acp`: `bun run typecheck`, `bun run check:all`, `bun test ./test/unit/ --timeout=60000` and `bun run test:coverage` are green.
- PR title: `feat(acp-server): S5-1 event translator`. No release. The `./server` API snapshot is unchanged by this slice.
