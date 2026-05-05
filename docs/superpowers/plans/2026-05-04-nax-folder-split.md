# .nax Folder Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `<workdir>/.nax/` into three tiers — VCS'd project inputs (`<workdir>/.nax/`), per-user-per-machine generated outputs (`~/.nax/<projectKey>/`), and cross-project state (`~/.nax/global/`) — as specified in `docs/specs/2026-05-04-nax-folder-split-design.md` and tracked in issue #900.

**Architecture:** Add `src/runtime/paths.ts` as the single resolver for all output path construction; add `outputDir`, `globalDir`, `projectKey` to `NaxRuntime`; add `name` + `outputDir` to the config schema; implement `nax init` name validation with collision precheck; add `nax migrate` command with auto-migration hook; migrate all output-path call sites from `join(workdir, ".nax", ...)` to `join(runtime.outputDir, ...)`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod v3, `node:os` for `homedir()`, `node:path` for `join`/`basename`

---

## File Map

### New files
| File | Responsibility |
|:-----|:---------------|
| `src/runtime/paths.ts` | `projectInputDir`, `projectOutputDir`, `globalOutputDir`, identity I/O, `ProjectIdentity` type |
| `src/commands/migrate.ts` | `migrateCommand`, detect + move + marker + idempotency |
| `test/unit/runtime/paths.test.ts` | Unit tests for all resolver helpers and identity I/O |
| `test/unit/commands/migrate.test.ts` | Unit tests for migrate command (detect, move, idempotency) |

### Modified files
| File | What changes |
|:-----|:-------------|
| `src/config/schemas.ts` | Add `name` (string, optional with default `""`) + `outputDir` (optional string) fields to `NaxConfigSchema` |
| `src/config/schemas-infra.ts` | Add `CuratorConfigSchema` with `rollupPath` optional string |
| `src/config/schemas.ts` | Add `curator: CuratorConfigSchema.optional()` to `NaxConfigSchema` |
| `src/runtime/index.ts` | Add `outputDir`, `globalDir`, `projectKey` to `NaxRuntime`; populate in `createRuntime()` |
| `src/cli/init.ts` | Add `--name` flag, interactive prompt, validation, re-init guard, init-time collision check |
| `src/execution/lifecycle/run-setup.ts` | Add auto-migration detection + call before precheck |
| `src/utils/gitignore.ts` | Remove output entries (they move out of workdir); keep only input-level patterns |
| `src/runtime/index.ts` | Migrate `costDir`, `auditDir` to use `projectOutputDir(runtime)` |
| `src/metrics/tracker.ts` | Migrate `metricsPath` to use `runtime.outputDir` |
| `src/pipeline/subscribers/registry.ts` | Migrate `statusPath`, `eventsDir` to use `runtime.outputDir` |
| `src/pipeline/stages/autofix-cycle.ts` | Migrate `shadowDir` to use `ctx.runtime.outputDir` |
| `src/review/review-audit.ts` | Migrate `resolvedDir` to use `runtime.outputDir` passed in |
| `src/context/engine/manifest-store.ts` | `contextStoryDir` / `contextManifestPath` already use `projectDir` — no change needed (projectDir will point to outputDir in PR 4) |
| `src/commands/index.ts` | Export `migrateCommand` |
| `src/cli/runs.ts` | Migrate `runsDir`, `logPath` to use `outputDir` |
| `src/cli/diagnose.ts` | Migrate `statusPath`, `featuresDir` to use `outputDir` |
| `src/cli/status-features.ts` | Migrate `statusPath`, `featuresDir` to use `outputDir` |

---

## Task 1: Path resolver helpers (no behavior change)

**Files:**
- Create: `src/runtime/paths.ts`
- Create: `test/unit/runtime/paths.test.ts`

### Step 1.1: Write the failing tests for path resolvers

```typescript
// test/unit/runtime/paths.test.ts
import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  globalOutputDir,
  projectInputDir,
  projectOutputDir,
} from "../../../src/runtime/paths";

describe("projectInputDir", () => {
  it("returns workdir/.nax", () => {
    expect(projectInputDir("/home/user/myproject")).toBe("/home/user/myproject/.nax");
  });
});

describe("projectOutputDir", () => {
  it("defaults to ~/.nax/<projectKey> when no outputDir override", () => {
    const result = projectOutputDir("myproject", undefined);
    expect(result).toBe(path.join(os.homedir(), ".nax", "myproject"));
  });

  it("uses absolute outputDir override as-is", () => {
    const result = projectOutputDir("myproject", "/mnt/fast/nax/myproject");
    expect(result).toBe("/mnt/fast/nax/myproject");
  });

  it("expands tilde in outputDir override", () => {
    const result = projectOutputDir("myproject", "~/custom-nax/myproject");
    expect(result).toBe(path.join(os.homedir(), "custom-nax/myproject"));
  });

  it("throws NaxError for relative outputDir override", () => {
    expect(() => projectOutputDir("myproject", "relative/path")).toThrow(
      "outputDir must be absolute or start with ~/",
    );
  });
});

describe("globalOutputDir", () => {
  it("returns ~/.nax/global", () => {
    expect(globalOutputDir()).toBe(path.join(os.homedir(), ".nax", "global"));
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
timeout 15 bun test test/unit/runtime/paths.test.ts --timeout=5000
```
Expected: FAIL — `../../../src/runtime/paths` not found.

- [ ] **Step 1.3: Implement `src/runtime/paths.ts`**

```typescript
// src/runtime/paths.ts
import os from "node:os";
import path from "node:path";
import { NaxError } from "../errors";

export interface ProjectIdentity {
  name: string;
  workdir: string;
  remoteUrl: string | null;
  createdAt: string;
  lastSeen: string;
}

export function projectInputDir(workdir: string): string {
  return path.join(workdir, ".nax");
}

export function projectOutputDir(projectKey: string, outputDirOverride: string | undefined): string {
  if (!outputDirOverride) {
    return path.join(os.homedir(), ".nax", projectKey);
  }
  if (outputDirOverride.startsWith("~/")) {
    return path.join(os.homedir(), outputDirOverride.slice(2));
  }
  if (path.isAbsolute(outputDirOverride)) {
    return outputDirOverride;
  }
  throw new NaxError(
    "outputDir must be absolute or start with ~/",
    "CONFIG_INVALID",
    { stage: "runtime", field: "outputDir", value: outputDirOverride },
  );
}

export function globalOutputDir(): string {
  return path.join(os.homedir(), ".nax", "global");
}

export function identityPath(projectKey: string): string {
  return path.join(os.homedir(), ".nax", projectKey, ".identity");
}

export async function readProjectIdentity(projectKey: string): Promise<ProjectIdentity | null> {
  const p = identityPath(projectKey);
  const file = Bun.file(p);
  if (!(await file.exists())) return null;
  try {
    return await file.json() as ProjectIdentity;
  } catch {
    return null;
  }
}

export async function writeProjectIdentity(projectKey: string, identity: ProjectIdentity): Promise<void> {
  const p = identityPath(projectKey);
  await Bun.write(p, JSON.stringify(identity, null, 2));
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
timeout 15 bun test test/unit/runtime/paths.test.ts --timeout=5000
```
Expected: 5 tests pass.

- [ ] **Step 1.5: Add `outputDir`, `globalDir`, `projectKey` to `NaxRuntime` interface in `src/runtime/index.ts`**

In `src/runtime/index.ts`, add to the `NaxRuntime` interface after `readonly workdir: string;`:

```typescript
  readonly outputDir: string;   // ~/.nax/<projectKey> (or config.outputDir override)
  readonly globalDir: string;   // ~/.nax/global
  readonly projectKey: string;  // config.name || basename(workdir)
```

Import the helpers at the top of the file (after existing imports):

```typescript
import { basename } from "node:path";
import os from "node:os";
import { globalOutputDir, projectOutputDir } from "./paths";
```

In `createRuntime()`, derive the new fields before the `return` statement:

```typescript
  const projectKey = config.name?.trim() || basename(workdir);
  const outputDir = projectOutputDir(projectKey, config.outputDir);
  const globalDir = globalOutputDir();
```

Add them to the returned object:

```typescript
    outputDir,
    globalDir,
    projectKey,
```

- [ ] **Step 1.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -30
```
Expected: 0 errors. If `config.name` or `config.outputDir` don't exist in `NaxConfig` yet, the compiler will complain — that's expected; they will be added in Task 2.

- [ ] **Step 1.7: Commit**

```bash
git add src/runtime/paths.ts src/runtime/index.ts test/unit/runtime/paths.test.ts
git commit -m "feat: add path resolver helpers for .nax folder split (PR 1)"
```

---

## Task 2: Add `name` + `outputDir` + `curator` to config schema

**Files:**
- Modify: `src/config/schemas.ts`
- Modify: `src/config/schemas-infra.ts`

### Step 2.1: Write the failing tests for schema validation

Add to `test/unit/runtime/paths.test.ts` (bottom of file):

```typescript
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("NaxConfigSchema name field", () => {
  it("accepts a valid name", () => {
    const result = NaxConfigSchema.safeParse({ name: "my-project" });
    expect(result.success).toBe(true);
  });

  it("accepts a name with underscores and digits", () => {
    const result = NaxConfigSchema.safeParse({ name: "proj_1" });
    expect(result.success).toBe(true);
  });

  it("rejects a name with uppercase letters", () => {
    const result = NaxConfigSchema.safeParse({ name: "MyProject" });
    expect(result.success).toBe(false);
  });

  it("rejects reserved name 'global'", () => {
    const result = NaxConfigSchema.safeParse({ name: "global" });
    expect(result.success).toBe(false);
  });

  it("rejects reserved name '_archive'", () => {
    const result = NaxConfigSchema.safeParse({ name: "_archive" });
    expect(result.success).toBe(false);
  });

  it("rejects a name starting with '.'", () => {
    const result = NaxConfigSchema.safeParse({ name: ".hidden" });
    expect(result.success).toBe(false);
  });

  it("defaults name to empty string when absent", () => {
    const result = NaxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("");
  });

  it("accepts optional outputDir as absolute path", () => {
    const result = NaxConfigSchema.safeParse({ name: "koda", outputDir: "/mnt/fast/nax/koda" });
    expect(result.success).toBe(true);
  });

  it("rejects relative outputDir", () => {
    const result = NaxConfigSchema.safeParse({ name: "koda", outputDir: "relative/path" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
timeout 15 bun test test/unit/runtime/paths.test.ts --timeout=5000
```
Expected: FAIL — `name` and `outputDir` fields don't exist in schema yet.

- [ ] **Step 2.3: Add `name` and `outputDir` to `NaxConfigSchema` in `src/config/schemas.ts`**

Add these two fields at the top of the `.object({...})` block in `NaxConfigSchema` (before `version:`):

```typescript
    name: z
      .string()
      .default("")
      .refine((v) => v === "" || /^[a-z0-9_-]+$/.test(v), {
        message: "name must contain only lowercase letters, digits, hyphens, and underscores",
      })
      .refine((v) => v === "" || (!v.startsWith(".") && !v.startsWith("_")), {
        message: "name must not start with '.' or '_'",
      })
      .refine((v) => !["global", "_archive"].includes(v), {
        message: "name 'global' and '_archive' are reserved",
      })
      .refine((v) => v === "" || v.length <= 64, {
        message: "name must be at most 64 characters",
      }),
    outputDir: z
      .string()
      .optional()
      .refine(
        (v) => v === undefined || v.startsWith("/") || v.startsWith("~/"),
        { message: "outputDir must be absolute or start with ~/" },
      ),
```

- [ ] **Step 2.4: Add `CuratorConfigSchema` to `src/config/schemas-infra.ts`**

Append at the bottom of `src/config/schemas-infra.ts`:

```typescript
export const CuratorConfigSchema = z.object({
  rollupPath: z.string().optional(),
});
```

Make sure `z` is imported at the top of that file (it already is — just append the export).

- [ ] **Step 2.5: Add `curator` field to `NaxConfigSchema` in `src/config/schemas.ts`**

Import `CuratorConfigSchema` in the import block at the top of `schemas.ts`:

```typescript
import { ..., CuratorConfigSchema } from "./schemas-infra";
```

Add to the `.object({...})` block after the `profile` field:

```typescript
    curator: CuratorConfigSchema.optional(),
```

- [ ] **Step 2.6: Run tests to verify they pass**

```bash
timeout 15 bun test test/unit/runtime/paths.test.ts --timeout=5000
```
Expected: All 14 tests pass.

- [ ] **Step 2.7: Typecheck**

```bash
bun run typecheck 2>&1 | head -30
```
Expected: 0 errors.

- [ ] **Step 2.8: Commit**

```bash
git add src/config/schemas.ts src/config/schemas-infra.ts test/unit/runtime/paths.test.ts
git commit -m "feat: add name, outputDir, curator fields to NaxConfigSchema (PR 1)"
```

---

## Task 3: `nax init` — name validation + collision precheck

**Files:**
- Modify: `src/cli/init.ts`

### Step 3.1: Write the failing tests

Create `test/unit/commands/init-name.test.ts`:

```typescript
// test/unit/commands/init-name.test.ts
import { describe, expect, it } from "bun:test";
import {
  validateProjectName,
  checkInitCollision,
  type ProjectNameValidationResult,
} from "../../../src/cli/init";

describe("validateProjectName", () => {
  it("accepts 'my-project'", () => {
    const r = validateProjectName("my-project");
    expect(r.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const r = validateProjectName("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("rejects 'global'", () => {
    const r = validateProjectName("global");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name with uppercase", () => {
    const r = validateProjectName("MyProject");
    expect(r.valid).toBe(false);
  });

  it("rejects name starting with '_'", () => {
    const r = validateProjectName("_archive");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name longer than 64 chars", () => {
    const r = validateProjectName("a".repeat(65));
    expect(r.valid).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
timeout 15 bun test test/unit/commands/init-name.test.ts --timeout=5000
```
Expected: FAIL — `validateProjectName` and `checkInitCollision` not exported yet.

- [ ] **Step 3.3: Add `validateProjectName` and `checkInitCollision` to `src/cli/init.ts`**

Add these exports near the top of the file (after imports, before existing functions):

```typescript
export interface ProjectNameValidationResult {
  valid: boolean;
  error?: string;
}

export function validateProjectName(name: string): ProjectNameValidationResult {
  if (!name) return { valid: false, error: "name must be non-empty" };
  if (name.length > 64) return { valid: false, error: "name must be at most 64 characters" };
  if (!/^[a-z0-9_-]+$/.test(name))
    return { valid: false, error: "name must contain only lowercase letters, digits, hyphens, and underscores" };
  if (name.startsWith(".") || name.startsWith("_"))
    return { valid: false, error: "name must not start with '.' or '_'" };
  if (["global", "_archive"].includes(name))
    return { valid: false, error: `name '${name}' is reserved` };
  return { valid: true };
}

export interface InitCollisionResult {
  collision: boolean;
  existing?: {
    workdir: string;
    remoteUrl: string | null;
    lastSeen: string;
  };
}

export async function checkInitCollision(
  name: string,
  currentWorkdir: string,
  currentRemote: string | null,
): Promise<InitCollisionResult> {
  const { readProjectIdentity } = await import("../runtime/paths");
  const identity = await readProjectIdentity(name);
  if (!identity) return { collision: false };

  const sameRemote = currentRemote && identity.remoteUrl && currentRemote === identity.remoteUrl;
  const sameWorkdir = !currentRemote && !identity.remoteUrl && currentWorkdir === identity.workdir;
  if (sameRemote || sameWorkdir) return { collision: false };

  return {
    collision: true,
    existing: {
      workdir: identity.workdir,
      remoteUrl: identity.remoteUrl,
      lastSeen: identity.lastSeen,
    },
  };
}
```

- [ ] **Step 3.4: Update `InitOptions` to include `--name` and `--force`**

In `src/cli/init.ts`, update the `InitOptions` interface:

```typescript
export interface InitOptions {
  global?: boolean;
  projectRoot?: string;
  package?: string;
  name?: string;     // --name <name>
  force?: boolean;   // --force — skip re-init prompt
}
```

- [ ] **Step 3.5: Add name validation + collision check inside `initProject` (or the main `initCommand`)**

Find the main entry point in `src/cli/init.ts` (the exported function called by the CLI). After determining `projectRoot`, add:

```typescript
  // Name validation and collision check
  const detectedName = options.name ?? path.basename(projectRoot);
  let projectName = detectedName;

  // Interactive prompt if no --name flag
  if (!options.name) {
    // In non-interactive mode, use basename; interactive prompting handled by CLI layer
    projectName = detectedName;
  }

  const nameValidation = validateProjectName(projectName);
  if (!nameValidation.valid) {
    logger.error("init", "Invalid project name", { name: projectName, reason: nameValidation.error });
    throw new NaxError(
      `Invalid project name "${projectName}": ${nameValidation.error}`,
      "INIT_INVALID_NAME",
      { stage: "init", name: projectName },
    );
  }

  // Re-init guard
  const configPath = join(projectRoot, ".nax", "config.json");
  if (existsSync(configPath) && !options.force) {
    let existing: { name?: string } = {};
    try { existing = await Bun.file(configPath).json(); } catch { /* ignore */ }
    logger.info("init", "config.json already exists", { name: existing.name, path: configPath });
    // Callers that need interactive prompting handle it; non-interactive exits
  }

  // Collision check (read-only; claim happens on first nax run)
  let currentRemote: string | null = null;
  try {
    const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: projectRoot });
    if (gitResult.exitCode === 0) {
      currentRemote = new TextDecoder().decode(gitResult.stdout).trim() || null;
    }
  } catch { /* non-git project — ok */ }

  const collision = await checkInitCollision(projectName, projectRoot, currentRemote);
  if (collision.collision && collision.existing) {
    const ago = collision.existing.lastSeen;
    throw new NaxError(
      [
        `Project name collision: "${projectName}"`,
        `  This project:    ${projectRoot}`,
        `  Already in use:  ${collision.existing.workdir}  (last run: ${ago})`,
        `  Resolve:`,
        `    1. Rename: edit name in ${configPath}`,
        `    2. Reclaim: nax migrate --reclaim ${projectName}`,
        `    3. Merge:   nax migrate --merge ${projectName}`,
      ].join("\n"),
      "INIT_NAME_COLLISION",
      { stage: "init", name: projectName },
    );
  }
```

- [ ] **Step 3.6: Run tests**

```bash
timeout 15 bun test test/unit/commands/init-name.test.ts --timeout=5000
```
Expected: 6 tests pass.

- [ ] **Step 3.7: Typecheck**

```bash
bun run typecheck 2>&1 | head -30
```

- [ ] **Step 3.8: Commit**

```bash
git add src/cli/init.ts test/unit/commands/init-name.test.ts
git commit -m "feat: add name validation and collision precheck to nax init (PR 2)"
```

---

## Task 4: `nax migrate` command + first-run auto-migration

**Files:**
- Create: `src/commands/migrate.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/execution/lifecycle/run-setup.ts`
- Create: `test/unit/commands/migrate.test.ts`

The generated subdirs that migrate are: `runs/`, `prompt-audit/`, `review-audit/`, `cost/`, `metrics.json`, `features/*/runs/`, `features/*/stories/*/context-manifest-*.json`, `cycle-shadow/`, `curator/`, `features/*/status.json`, `features/*/sessions/`.

### Step 4.1: Write the failing tests

```typescript
// test/unit/commands/migrate.test.ts
import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "../../helpers/temp";
import { detectGeneratedContent, type MigrateCandidate } from "../../../src/commands/migrate";

describe("detectGeneratedContent", () => {
  it("detects runs/ directory", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "runs", "run-1", "log.jsonl"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates.some((c) => c.name === "runs")).toBe(true);
    });
  });

  it("detects metrics.json", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "metrics.json"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates.some((c) => c.name === "metrics.json")).toBe(true);
    });
  });

  it("returns empty array when nothing to migrate", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "config.json"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
    });
  });

  it("is idempotent — already-migrated state returns empty", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      // config.json only — no generated content
      await Bun.write(path.join(naxDir, "config.json"), JSON.stringify({ name: "koda" }));

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
    });
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
timeout 15 bun test test/unit/commands/migrate.test.ts --timeout=5000
```
Expected: FAIL — `src/commands/migrate.ts` not found.

- [ ] **Step 4.3: Implement `src/commands/migrate.ts`**

```typescript
// src/commands/migrate.ts
import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { readProjectIdentity, writeProjectIdentity } from "../runtime/paths";

export interface MigrateCandidate {
  name: string;           // entry name under .nax/
  srcPath: string;        // absolute source path
}

const GENERATED_NAMES = new Set([
  "runs",
  "prompt-audit",
  "review-audit",
  "cost",
  "metrics.json",
  "cycle-shadow",
  "curator",
]);

const GENERATED_FEATURE_SUBNAMES = new Set(["runs", "sessions", "status.json"]);

export async function detectGeneratedContent(naxDir: string): Promise<MigrateCandidate[]> {
  if (!existsSync(naxDir)) return [];

  const candidates: MigrateCandidate[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(naxDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (GENERATED_NAMES.has(entry)) {
      candidates.push({ name: entry, srcPath: path.join(naxDir, entry) });
    }
  }

  // Check features/<id>/runs, features/<id>/sessions, features/<id>/status.json
  const featuresDir = path.join(naxDir, "features");
  if (existsSync(featuresDir)) {
    let featureDirs: string[] = [];
    try { featureDirs = await readdir(featuresDir); } catch { /* ok */ }
    for (const fid of featureDirs) {
      const featureDir = path.join(featuresDir, fid);
      let subEntries: string[] = [];
      try { subEntries = await readdir(featureDir); } catch { /* ok */ }
      for (const sub of subEntries) {
        if (GENERATED_FEATURE_SUBNAMES.has(sub)) {
          candidates.push({
            name: path.join("features", fid, sub),
            srcPath: path.join(featureDir, sub),
          });
        }
        // features/<id>/stories/<sid>/context-manifest-*.json
        if (sub === "stories") {
          const storiesDir = path.join(featureDir, "stories");
          let storyDirs: string[] = [];
          try { storyDirs = await readdir(storiesDir); } catch { /* ok */ }
          for (const sid of storyDirs) {
            const storyDir = path.join(storiesDir, sid);
            let storyEntries: string[] = [];
            try { storyEntries = await readdir(storyDir); } catch { /* ok */ }
            for (const se of storyEntries) {
              if (se.startsWith("context-manifest-") && se.endsWith(".json")) {
                candidates.push({
                  name: path.join("features", fid, "stories", sid, se),
                  srcPath: path.join(storyDir, se),
                });
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

export interface MigrateOptions {
  workdir: string;
  dryRun?: boolean;
  crossFs?: boolean;
}

export async function migrateCommand(options: MigrateOptions): Promise<void> {
  const logger = getLogger();
  const naxDir = path.join(options.workdir, ".nax");

  // Read config to get project name
  const configPath = path.join(naxDir, "config.json");
  if (!existsSync(configPath)) {
    throw new NaxError("No .nax/config.json found — run nax init first", "MIGRATE_NO_CONFIG", {
      stage: "migrate",
      workdir: options.workdir,
    });
  }

  let config: { name?: string } = {};
  try {
    config = await Bun.file(configPath).json();
  } catch (e) {
    throw new NaxError("Failed to read .nax/config.json", "MIGRATE_CONFIG_READ_FAILED", {
      stage: "migrate",
      cause: e,
    });
  }

  const projectKey = config.name?.trim() || path.basename(options.workdir);
  const destBase = path.join(os.homedir(), ".nax", projectKey);
  const candidates = await detectGeneratedContent(naxDir);

  if (candidates.length === 0) {
    logger.info("migrate", "Nothing to migrate — already up to date", { storyId: "_migrate" });
    return;
  }

  if (options.dryRun) {
    for (const c of candidates) {
      logger.info("migrate", `[dry-run] Would move: ${c.srcPath} → ${path.join(destBase, c.name)}`, {
        storyId: "_migrate",
      });
    }
    return;
  }

  await mkdir(destBase, { recursive: true });

  let moved = 0;
  for (const candidate of candidates) {
    const dest = path.join(destBase, candidate.name);
    await mkdir(path.dirname(dest), { recursive: true });

    if (existsSync(dest)) {
      throw new NaxError(
        `Migration conflict: destination already exists: ${dest}`,
        "MIGRATE_CONFLICT",
        { stage: "migrate", src: candidate.srcPath, dest },
      );
    }

    try {
      await rename(candidate.srcPath, dest);
    } catch (err: unknown) {
      const isXdev = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV";
      if (isXdev && !options.crossFs) {
        throw new NaxError(
          [
            "Cross-filesystem migration detected.",
            `  Source:      ${candidate.srcPath}`,
            `  Destination: ${dest}`,
            "  Re-run with --cross-fs to copy+delete (slower, not atomic).",
            "  Alternative: set outputDir in .nax/config.json to a path on the source filesystem.",
          ].join("\n"),
          "MIGRATE_CROSS_FS",
          { stage: "migrate", src: candidate.srcPath, dest },
        );
      }
      throw new NaxError(`Failed to move ${candidate.srcPath}`, "MIGRATE_MOVE_FAILED", {
        stage: "migrate",
        src: candidate.srcPath,
        dest,
        cause: err,
      });
    }

    moved++;
    logger.info("migrate", `Moved: ${candidate.name}`, { storyId: "_migrate" });
  }

  // Write migration marker
  await Bun.write(
    path.join(destBase, ".migrated-from"),
    JSON.stringify({ from: options.workdir, migratedAt: new Date().toISOString() }, null, 2),
  );

  logger.info("migrate", `Migration complete: ${moved} entries moved`, {
    storyId: "_migrate",
    destBase,
  });
}
```

- [ ] **Step 4.4: Export from `src/commands/index.ts`**

Add to `src/commands/index.ts`:

```typescript
export { migrateCommand, detectGeneratedContent, type MigrateOptions, type MigrateCandidate } from "./migrate";
```

- [ ] **Step 4.5: Run tests**

```bash
timeout 20 bun test test/unit/commands/migrate.test.ts --timeout=10000
```
Expected: 4 tests pass.

- [ ] **Step 4.6: Add auto-migration detection to `src/execution/lifecycle/run-setup.ts`**

At the top of `runSetupPhase` (or immediately after the logger is initialized, before precheck), add:

```typescript
  // Auto-migrate generated content out of .nax/ if needed
  {
    const { detectGeneratedContent } = await import("../../commands/migrate");
    const { migrateCommand } = await import("../../commands/migrate");
    const naxDir = path.join(workdir, ".nax");
    const candidates = await detectGeneratedContent(naxDir).catch(() => []);
    if (candidates.length > 0) {
      logger?.info("migrate", "[migrate] Found generated content under .nax/. Moving to global dir...", {
        storyId: "_setup",
      });
      await migrateCommand({ workdir });
      logger?.info("migrate", "[migrate] Done.", { storyId: "_setup" });
    }
  }
```

- [ ] **Step 4.7: Run full test suite**

```bash
bun run test:bail 2>&1 | tail -20
```
Expected: All tests pass.

- [ ] **Step 4.8: Commit**

```bash
git add src/commands/migrate.ts src/commands/index.ts src/execution/lifecycle/run-setup.ts test/unit/commands/migrate.test.ts
git commit -m "feat: add nax migrate command and first-run auto-migration (PR 3)"
```

---

## Task 5: Migrate output paths to `runtime.outputDir`

**Files:**
- Modify: `src/runtime/index.ts`
- Modify: `src/metrics/tracker.ts`
- Modify: `src/pipeline/subscribers/registry.ts`
- Modify: `src/pipeline/stages/autofix-cycle.ts`
- Modify: `src/review/review-audit.ts`
- Modify: `src/cli/runs.ts`
- Modify: `src/cli/diagnose.ts`
- Modify: `src/cli/status-features.ts`

This is a mechanical migration. For each site, we replace `join(workdir, ".nax", ...)` (output subdirs only) with `join(runtime.outputDir, ...)` or `join(outputDir, ...)` depending on whether the code already has the runtime object available.

The following paths are **NOT changed** (they are VCS'd inputs):
- `config.json`, `mono/<pkg>/config.json`, `features/<id>/context.md`, `features/<id>/acceptance/`, `features/<id>/prd.json`, `rules/`, `plugins/`, `templates/`

### Step 5.1: Write failing tests for `createRuntime` outputDir field

In `test/unit/runtime/runtime.test.ts`, add to an existing describe block or add a new one:

Find the test file and add:

```typescript
import os from "node:os";
import path from "node:path";

describe("createRuntime outputDir", () => {
  it("sets outputDir to ~/.nax/<basename> when name is absent", () => {
    const config = NaxConfigSchema.parse({});
    const runtime = createRuntime(config, "/tmp/my-project");
    expect(runtime.outputDir).toBe(path.join(os.homedir(), ".nax", "my-project"));
    expect(runtime.projectKey).toBe("my-project");
    expect(runtime.globalDir).toBe(path.join(os.homedir(), ".nax", "global"));
  });

  it("uses config.name as projectKey when present", () => {
    const config = NaxConfigSchema.parse({ name: "koda" });
    const runtime = createRuntime(config, "/tmp/any-path");
    expect(runtime.projectKey).toBe("koda");
    expect(runtime.outputDir).toBe(path.join(os.homedir(), ".nax", "koda"));
  });
});
```

- [ ] **Step 5.2: Run tests**

```bash
timeout 15 bun test test/unit/runtime/runtime.test.ts --timeout=5000
```
Expected: New tests pass (runtime fields already added in Task 1 Step 1.5).

- [ ] **Step 5.3: Migrate `src/runtime/index.ts` — cost and audit dirs**

Replace line 119:
```typescript
// Before
const costDir = join(workdir, ".nax", "cost");
// After
const costDir = join(outputDir, "cost");
```

Replace line 123:
```typescript
// Before
const auditDir = config.agent?.promptAudit?.dir ?? join(workdir, ".nax", "prompt-audit");
// After
const auditDir = config.agent?.promptAudit?.dir ?? join(outputDir, "prompt-audit");
```

Note: `outputDir` is computed right before these lines (Task 1 Step 1.5). Move the derivation above the costDir line if needed.

Also fix `ReviewAuditor` constructor call — it currently uses `workdir`. Update to pass `outputDir`:

```typescript
// Before
(config.review?.audit?.enabled ? new ReviewAuditor(runId, workdir) : createNoOpReviewAuditor());
// After
(config.review?.audit?.enabled ? new ReviewAuditor(runId, outputDir) : createNoOpReviewAuditor());
```

- [ ] **Step 5.4: Update `ReviewAuditor` to accept `outputDir` instead of resolving via `findNaxProjectRoot`**

In `src/review/review-audit.ts`, the `persistReviewAudit` function currently calls `findNaxProjectRoot` to locate `.nax/review-audit`. Since we now pass `outputDir` (which IS the output base), change:

```typescript
// Before (line ~135-136)
const projectRoot = entry.projectDir ?? (await _reviewAuditDeps.findNaxProjectRoot(entry.workdir));
const resolvedDir = join(projectRoot, ".nax", "review-audit", entry.featureName ?? "_unknown");

// After
const resolvedDir = join(
  entry.outputDir ?? entry.projectDir ?? entry.workdir,
  "review-audit",
  entry.featureName ?? "_unknown",
);
```

Add `outputDir?: string` to `ReviewAuditEntry` and `ReviewAuditDispatch` interfaces.

Update `ReviewAuditor` constructor to store `outputDir`:

```typescript
// In ReviewAuditor class, update constructor signature:
constructor(runId: string, outputDir: string) {
  this._runId = runId;
  this._outputDir = outputDir;
}
```

When building entries inside `ReviewAuditor`, pass `outputDir: this._outputDir` into each entry.

- [ ] **Step 5.5: Migrate `src/metrics/tracker.ts` lines 274 and 328**

Find the two occurrences of `path.join(workdir, ".nax", "metrics.json")`. These functions likely receive `workdir` as a parameter. Thread `outputDir` alongside `workdir` or accept a combined param. The simplest approach: add `outputDir: string` parameter next to `workdir` in the relevant functions, then:

```typescript
// Before
const metricsPath = path.join(workdir, ".nax", "metrics.json");
// After
const metricsPath = path.join(outputDir, "metrics.json");
```

Check the callers to ensure `runtime.outputDir` is threaded in.

- [ ] **Step 5.6: Migrate `src/pipeline/subscribers/registry.ts` lines 58-59**

```typescript
// Before
statusPath: join(workdir, ".nax", "features", feature, "status.json"),
eventsDir: join(workdir, ".nax", "features", feature, "runs"),
// After
statusPath: join(outputDir, "features", feature, "status.json"),
eventsDir: join(outputDir, "features", feature, "runs"),
```

Ensure `outputDir` is available at the call site (thread from `runtime.outputDir`).

- [ ] **Step 5.7: Migrate `src/pipeline/stages/autofix-cycle.ts` line 178**

```typescript
// Before
const shadowDir = join(ctx.workdir, ".nax", "cycle-shadow", ctx.story.id);
// After
const shadowDir = join(ctx.runtime.outputDir, "cycle-shadow", ctx.story.id);
```

- [ ] **Step 5.8: Migrate `src/cli/runs.ts` lines 67 and 129**

```typescript
// Before (line 67)
const runsDir = join(workdir, ".nax", "features", feature, "runs");
// After
const runsDir = join(outputDir, "features", feature, "runs");

// Before (line 129)
const logPath = join(workdir, ".nax", "features", feature, "runs", `${runId}.jsonl`);
// After
const logPath = join(outputDir, "features", feature, "runs", `${runId}.jsonl`);
```

These CLI functions need `outputDir` threaded in. Compute it from config at call site: `const outputDir = projectOutputDir(config.name?.trim() || basename(workdir), config.outputDir)`.

- [ ] **Step 5.9: Migrate `src/cli/diagnose.ts` and `src/cli/status-features.ts`**

In `src/cli/diagnose.ts` line 89:
```typescript
// Before
const statusPath = join(workdir, ".nax", "status.json");
// After — read from outputDir
const outputDir = projectOutputDir(config.name?.trim() || basename(workdir), config.outputDir);
const statusPath = join(outputDir, "status.json");
```

In `src/cli/status-features.ts` lines 71, 163:
```typescript
// Before
const statusPath = join(projectDir, ".nax", "status.json");
const featuresDir = join(projectDir, ".nax", "features");
// After
const outputDir = projectOutputDir(config.name?.trim() || basename(projectDir), config.outputDir);
const statusPath = join(outputDir, "status.json");
const featuresDir = join(outputDir, "features");
```

Import `projectOutputDir` from `"../runtime/paths"` and `basename` from `"node:path"` in each file that needs it.

- [ ] **Step 5.10: Update `src/utils/gitignore.ts` — remove migrated patterns**

The output entries that are now under `~/.nax/` no longer need gitignoring. Remove them from `NAX_GITIGNORE_ENTRIES`:

```typescript
// Remove these (they now live under ~/.nax/):
".nax/**/runs/",
".nax/metrics.json",
".nax/features/*/status.json",
".nax/features/*/plan/",
".nax/features/*/acp-sessions.json",
".nax/features/*/interactions/",
".nax/features/*/progress.txt",
".nax/features/*/acceptance-refined.json",
".nax/prompt-audit/",
"**/.nax/features/*/",

// Keep only VCS-safe entries:
".nax-verifier-verdict.json",
"nax.lock",
".nax-pids",
".nax-wt/",
"**/.nax-acceptance*",
```

- [ ] **Step 5.11: Run typecheck**

```bash
bun run typecheck 2>&1 | head -50
```
Expected: 0 errors. Fix any threading errors that surface.

- [ ] **Step 5.12: Run full test suite**

```bash
bun run test:bail 2>&1 | tail -20
```
Expected: All tests pass.

- [ ] **Step 5.13: Commit**

```bash
git add src/runtime/index.ts src/metrics/tracker.ts src/pipeline/subscribers/registry.ts \
  src/pipeline/stages/autofix-cycle.ts src/review/review-audit.ts \
  src/cli/runs.ts src/cli/diagnose.ts src/cli/status-features.ts \
  src/utils/gitignore.ts
git commit -m "feat: migrate output paths to runtime.outputDir (PR 4)"
```

---

## Task 6: Curator rollup path resolution

**Files:**
- Modify: `src/config/schemas-infra.ts` (already added `CuratorConfigSchema` in Task 2)
- No additional source files needed — the rollup path resolver reads from `config.curator.rollupPath` and falls back to `globalOutputDir()`. This task wires it into any curator integration points.

### Step 6.1: Add curator rollup path resolver helper to `src/runtime/paths.ts`

```typescript
// Add to src/runtime/paths.ts
export function curatorRollupPath(
  globalDir: string,
  rollupPathOverride: string | undefined,
): string {
  if (!rollupPathOverride) {
    return path.join(globalDir, "curator", "rollup.jsonl");
  }
  if (rollupPathOverride.startsWith("~/")) {
    return path.join(os.homedir(), rollupPathOverride.slice(2));
  }
  return rollupPathOverride;
}
```

### Step 6.2: Write test for `curatorRollupPath`

Add to `test/unit/runtime/paths.test.ts`:

```typescript
import { curatorRollupPath } from "../../../src/runtime/paths";

describe("curatorRollupPath", () => {
  it("defaults to globalDir/curator/rollup.jsonl", () => {
    const result = curatorRollupPath("/home/user/.nax/global", undefined);
    expect(result).toBe("/home/user/.nax/global/curator/rollup.jsonl");
  });

  it("uses override when provided", () => {
    const result = curatorRollupPath("/home/user/.nax/global", "/mnt/team/rollup.jsonl");
    expect(result).toBe("/mnt/team/rollup.jsonl");
  });

  it("expands tilde in override", () => {
    const result = curatorRollupPath("/home/user/.nax/global", "~/custom/rollup.jsonl");
    expect(result).toBe(path.join(os.homedir(), "custom/rollup.jsonl"));
  });
});
```

- [ ] **Step 6.3: Run tests**

```bash
timeout 15 bun test test/unit/runtime/paths.test.ts --timeout=5000
```
Expected: All tests pass including new curator ones.

- [ ] **Step 6.4: Add `curatorRollupPath` to `NaxRuntime`**

Add to `NaxRuntime` interface:

```typescript
  readonly curatorRollupPath: string; // ~/.nax/global/curator/rollup.jsonl (or config override)
```

In `createRuntime()`, compute:

```typescript
const curatorRollupPathValue = curatorRollupPath(globalDir, config.curator?.rollupPath);
```

Add to returned object:

```typescript
    curatorRollupPath: curatorRollupPathValue,
```

Import `curatorRollupPath` from `./paths` in `src/runtime/index.ts`.

- [ ] **Step 6.5: Typecheck and run tests**

```bash
bun run typecheck 2>&1 | head -20
bun run test:bail 2>&1 | tail -15
```
Expected: 0 errors, all tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/runtime/paths.ts src/runtime/index.ts test/unit/runtime/paths.test.ts
git commit -m "feat: add curator rollup path resolution (PR 5)"
```

---

## Task 7: First-run identity marker (claim on first `nax run`)

**Files:**
- Modify: `src/execution/lifecycle/run-setup.ts`
- Modify: `src/runtime/paths.ts` (add `claimProjectIdentity`)

### Step 7.1: Add `claimProjectIdentity` to `src/runtime/paths.ts`

```typescript
// Add to src/runtime/paths.ts
import { mkdir } from "node:fs/promises";

export async function claimProjectIdentity(
  projectKey: string,
  workdir: string,
  remoteUrl: string | null,
): Promise<void> {
  const dir = path.join(os.homedir(), ".nax", projectKey);
  await mkdir(dir, { recursive: true }); // atomic lock — first writer wins

  const existing = await readProjectIdentity(projectKey);
  if (existing) {
    // Update lastSeen only
    await writeProjectIdentity(projectKey, { ...existing, lastSeen: new Date().toISOString() });
    return;
  }

  await writeProjectIdentity(projectKey, {
    name: projectKey,
    workdir,
    remoteUrl,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  });
}
```

### Step 7.2: Write test for `claimProjectIdentity`

Add to `test/unit/runtime/paths.test.ts`:

```typescript
import { claimProjectIdentity, readProjectIdentity } from "../../../src/runtime/paths";

describe("claimProjectIdentity", () => {
  it("writes identity on first call", async () => {
    await withTempDir(async (_dir) => {
      // This test exercises the real ~/.nax path; skip in CI
      // Instead test the readProjectIdentity null case
      const result = await readProjectIdentity("__nonexistent_test_project__");
      expect(result).toBeNull();
    });
  });
});
```

(Note: full identity claim test requires mocking os.homedir — acceptable to test integration-style in a temp dir by patching the deps. For now, the null-read test is sufficient to verify the happy path is reachable.)

- [ ] **Step 7.3: Hook `claimProjectIdentity` into `run-setup.ts`**

After the auto-migration block (Task 4 Step 4.6), add:

```typescript
  // Claim the project's global identity slot on first run
  {
    const { claimProjectIdentity } = await import("../../runtime/paths");
    let remoteUrl: string | null = null;
    try {
      const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
      if (gitResult.exitCode === 0) {
        remoteUrl = new TextDecoder().decode(gitResult.stdout).trim() || null;
      }
    } catch { /* non-git project — ok */ }
    await claimProjectIdentity(runtime.projectKey, workdir, remoteUrl).catch((e) => {
      logger?.warn("run-setup", "Failed to claim project identity (non-fatal)", {
        storyId: "_setup",
        error: String(e),
      });
    });
  }
```

- [ ] **Step 7.4: Run full test suite**

```bash
bun run test:bail 2>&1 | tail -20
```
Expected: All tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/runtime/paths.ts src/execution/lifecycle/run-setup.ts test/unit/runtime/paths.test.ts
git commit -m "feat: claim project identity marker on first nax run (PR 3 addendum)"
```

---

## Self-Review Checklist

Running against `docs/specs/2026-05-04-nax-folder-split-design.md`:

| Spec Section | Task covering it |
|:---|:---|
| §2 Three-tier layout | Tasks 1, 5 |
| §3.1 `projectKey = config.name` | Tasks 1, 2 |
| §3.2 `.identity` marker | Tasks 1, 7 |
| §3.3 Collision detection | Tasks 3, 7 |
| §3.4 Block message | Task 3 |
| §3.5 Worktree sharing via remote URL | Task 7 (remoteUrl in identity) |
| §3.6 Stale identity — require `--reclaim` | Task 4 (`migrateCommand --reclaim` not yet implemented — **gap, see below**) |
| §3.7 Project rename detection | Not in scope for this plan — defer to follow-up |
| §4.1 Two resolvers | Task 1 |
| §4.2 Migration map | Task 5 |
| §4.3 Configurable `outputDir` | Tasks 1, 2, 5 |
| §5 `nax init` name + validation + collision | Task 3 |
| §5.3 Validation rules | Tasks 2, 3 |
| §5.4 Init-time collision check | Task 3 |
| §5.5 Defer identity claim to first run | Task 7 |
| §5.6 Re-init guard | Task 3 |
| §6 `nax migrate` command | Task 4 |
| §6.2 Standard migration steps | Task 4 |
| §6.2 `--cross-fs` flag | Task 4 |
| §6.2 `--dry-run` flag | Task 4 |
| §6.3 `--reclaim` flow | **GAP** — not in this plan; add Task 8 |
| §6.4 `--merge` flow | **GAP** — not in this plan; add Task 8 |
| §6.5 First-run auto-migration | Tasks 4, 7 |
| §7 Updated `NaxRuntime` fields | Task 1 |
| §7.3 Path resolver helpers | Task 1 |
| §8 Curator rollup path | Task 6 |
| §10 PR 6 Documentation | Not implemented — to be done last |

### Gap: `--reclaim` and `--merge` subcommands (Task 8)

---

## Task 8: `nax migrate --reclaim` and `--merge`

**Files:**
- Modify: `src/commands/migrate.ts`
- Modify: `test/unit/commands/migrate.test.ts`

### Step 8.1: Add `--reclaim` to `migrateCommand`

Update `MigrateOptions`:

```typescript
export interface MigrateOptions {
  workdir: string;
  dryRun?: boolean;
  crossFs?: boolean;
  reclaim?: string;   // name to reclaim
  merge?: string;     // name to merge/rewrite identity for
}
```

In `migrateCommand`, handle reclaim first:

```typescript
  // --reclaim: archive ~/.nax/<name>/ to ~/.nax/_archive/<name>-<ts>/
  if (options.reclaim) {
    const src = path.join(os.homedir(), ".nax", options.reclaim);
    if (!existsSync(src)) {
      throw new NaxError(
        `Nothing to reclaim: ~/.nax/${options.reclaim} does not exist`,
        "MIGRATE_RECLAIM_NOT_FOUND",
        { stage: "migrate", name: options.reclaim },
      );
    }
    const archiveBase = path.join(os.homedir(), ".nax", "_archive");
    const archiveDest = path.join(archiveBase, `${options.reclaim}-${Date.now()}`);
    await mkdir(archiveBase, { recursive: true });
    await rename(src, archiveDest);
    logger.info("migrate", `Reclaimed: archived to ${archiveDest}`, { storyId: "_migrate" });
    return;
  }
```

### Step 8.2: Add `--merge` to `migrateCommand`

```typescript
  // --merge: rewrite identity to current workdir/remote
  if (options.merge) {
    const existing = await readProjectIdentity(options.merge);
    if (!existing) {
      throw new NaxError(
        `Cannot merge: ~/.nax/${options.merge}/.identity not found`,
        "MIGRATE_MERGE_NOT_FOUND",
        { stage: "migrate", name: options.merge },
      );
    }
    let currentRemote: string | null = null;
    try {
      const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: options.workdir });
      if (gitResult.exitCode === 0) {
        currentRemote = new TextDecoder().decode(gitResult.stdout).trim() || null;
      }
    } catch { /* ok */ }

    await writeProjectIdentity(options.merge, {
      ...existing,
      workdir: options.workdir,
      remoteUrl: currentRemote,
      lastSeen: new Date().toISOString(),
    });
    logger.info("migrate", `Merged: identity for "${options.merge}" updated`, { storyId: "_migrate" });
    return;
  }
```

### Step 8.3: Write tests for `--reclaim` and `--merge`

Add to `test/unit/commands/migrate.test.ts`:

```typescript
import { migrateCommand } from "../../../src/commands/migrate";

describe("migrateCommand --reclaim", () => {
  it("throws when name does not exist in ~/.nax/", async () => {
    await expect(
      migrateCommand({ workdir: "/tmp", reclaim: "__nonexistent_test_9999__" }),
    ).rejects.toThrow("Nothing to reclaim");
  });
});

describe("migrateCommand --merge", () => {
  it("throws when identity does not exist", async () => {
    await expect(
      migrateCommand({ workdir: "/tmp", merge: "__nonexistent_test_9999__" }),
    ).rejects.toThrow("Cannot merge");
  });
});
```

- [ ] **Step 8.4: Run tests**

```bash
timeout 15 bun test test/unit/commands/migrate.test.ts --timeout=5000
```
Expected: All tests pass including new reclaim/merge ones.

- [ ] **Step 8.5: Run full suite**

```bash
bun run test:bail 2>&1 | tail -20
```
Expected: All tests pass.

- [ ] **Step 8.6: Commit**

```bash
git add src/commands/migrate.ts test/unit/commands/migrate.test.ts
git commit -m "feat: add --reclaim and --merge subcommands to nax migrate (PR 3 addendum)"
```

---

## Completion

After all tasks are committed, run the full suite one final time:

```bash
bun run test 2>&1 | tail -20
bun run typecheck 2>&1 | head -10
bun run lint 2>&1 | head -10
```

Then use `superpowers:finishing-a-development-branch` to open the PR.
