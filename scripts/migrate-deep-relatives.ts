#!/usr/bin/env bun
/**
 * One-shot migration tool: rewrite deep relative imports to path aliases.
 *
 * Companion to `check-deep-relatives.ts`. Delete both once the baseline
 * reaches 0 (see .claude/rules/project-conventions.md).
 *
 * Every rewrite is specifier-only or provably equivalent — it changes how a
 * module is named, never which module is loaded. `../../foo/bar` and
 * `@/foo/bar` resolve to the same file, so these rewrites cannot alter the
 * runtime module graph and cannot create an import cycle.
 *
 * Classes:
 *   test           deep relative in test/ pointing at a src module. Tests may
 *                  alias at internals (#1647), so a pure specifier rename.
 *   test-barrel    deep relative in test/ pointing at a test/ internal whose
 *                  barrel already exports every name asked for. Re-pointed at
 *                  the barrel. `@test/<dir>/<internal>` is NOT exempt from the
 *                  barrel rule, so this cannot be folded into `test`.
 *   src-specifier  deep relative in src/, bin/ or scripts/ whose target is
 *                  itself a barrel, has no barrel beside it, or is type-only.
 *   barrel-routing would have to load a DIFFERENT module to satisfy the barrel
 *                  rule. NEVER rewritten — needs a human, and the conversion
 *                  must be gated by `check:import-cycles`.
 *   unresolved     no alias covers the target.
 *
 * Do NOT run `biome check --fix` over rewritten test/ files. `bun run lint`
 * formats `src/` and `bin/` only; reformatting test/ re-wraps unrelated casts
 * and detaches their `// test-ratchet-allow` markers, tripping
 * `check:test-as-unknown-as`.
 *
 * Runbook: docs/specs/2026-08-20-deep-relatives-migration-runbook.md
 *
 * Usage:
 *   bun scripts/migrate-deep-relatives.ts --dry-run
 *   bun scripts/migrate-deep-relatives.ts --scope test [--dir test/unit/config]
 *   bun scripts/migrate-deep-relatives.ts --scope test-barrel
 *   bun scripts/migrate-deep-relatives.ts --scope src
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LIST_RE = /^(\S+?):(\d+)\s+"([^"]+)"\s+→\s+"([^"]+)"/;

type Klass = "test" | "test-barrel" | "src-specifier" | "barrel-routing" | "unresolved";

interface Hit {
  file: string;
  line: number;
  spec: string;
  alias: string;
  klass: Klass;
}

/** True when the target's path bypasses any ancestor barrel — i.e. the alias would skip a directory barrel between the anchor (src/ or test/) and the target. Walks every parent up to the anchor so nested barrels like src/context/engine/index.ts are detected, not only the immediate parent. */
function targetDirHasBarrel(fromFile: string, spec: string): boolean {
  const abs = resolve(dirname(resolve(ROOT, fromFile)), spec);
  if (existsSync(abs) && statSync(abs).isDirectory()) return false; // target IS the barrel
  let dir = dirname(relative(ROOT, abs));
  while (dir && dir !== "." && dir !== "/") {
    if (existsSync(join(ROOT, dir, "index.ts"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * True when the target directory's barrel already exports every named binding
 * this import asks for, so re-pointing at the barrel changes nothing visible.
 */
function barrelExportsAll(fromFile: string, line: number, spec: string): boolean {
  const abs = resolve(dirname(resolve(ROOT, fromFile)), spec);
  const barrelPath = join(ROOT, dirname(relative(ROOT, abs)), "index.ts");
  if (!existsSync(barrelPath)) return false;

  const source = readFileSync(join(ROOT, fromFile), "utf8").split("\n")[line - 1] ?? "";
  const named = source.match(/import\s*(?:type\s*)?\{([^}]*)\}/)?.[1];
  if (!named) return false; // default or namespace import — not mechanical

  const names = named
    .split(",")
    .map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim(),
    )
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return false;

  const barrel = readFileSync(barrelPath, "utf8");
  return names.every((n) => new RegExp(`\\b${n}\\b`).test(barrel));
}

function classify(file: string, line: number, spec: string, alias: string): Klass {
  if (!alias.startsWith("@/") && !alias.startsWith("@test/")) return "unresolved";

  if (file.startsWith("test/")) {
    if (alias.startsWith("@/")) return "test";
    if (!targetDirHasBarrel(file, spec)) return "test";
    return barrelExportsAll(file, line, spec) ? "test-barrel" : "barrel-routing";
  }

  const source = readFileSync(join(ROOT, file), "utf8").split("\n")[line - 1] ?? "";
  if (/^\s*(?:import|export)\s+type\b/.test(source)) return "src-specifier";

  return targetDirHasBarrel(file, spec) ? "barrel-routing" : "src-specifier";
}

function collect(): Hit[] {
  const proc = Bun.spawnSync(["bun", join(ROOT, "scripts", "check-deep-relatives.ts"), "--list"], {
    cwd: ROOT,
  });
  const hits: Hit[] = [];
  for (const raw of proc.stdout.toString().split("\n")) {
    const m = raw.match(LIST_RE);
    if (!m) continue;
    const [, file, lineStr, spec, alias] = m;
    const line = Number(lineStr);
    hits.push({
      file: file!,
      line,
      spec: spec!,
      alias: alias!,
      klass: classify(file!, line, spec!, alias!),
    });
  }
  return hits;
}

function apply(hits: readonly Hit[]): number {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  let n = 0;
  for (const [file, fileHits] of byFile) {
    const path = join(ROOT, file);
    const lines = readFileSync(path, "utf8").split("\n");
    for (const h of fileHits) {
      const idx = h.line - 1;
      const before = lines[idx] ?? "";
      // A test-barrel hit must land on the barrel itself, not the internal.
      const target = h.klass === "test-barrel" ? h.alias.slice(0, h.alias.lastIndexOf("/")) : h.alias;
      const after = before.replace(`"${h.spec}"`, `"${target}"`).replace(`'${h.spec}'`, `'${target}'`);
      if (after !== before) {
        lines[idx] = after;
        n++;
      }
    }
    writeFileSync(path, lines.join("\n"));
  }
  return n;
}

const SCOPES: Record<string, Klass[]> = {
  test: ["test"],
  "test-barrel": ["test-barrel"],
  src: ["src-specifier"],
};

function main(): void {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const all = collect();

  if (args.includes("--dry-run") || !args.includes("--scope")) {
    const counts: Record<string, number> = {};
    for (const h of all) counts[h.klass] = (counts[h.klass] ?? 0) + 1;
    for (const k of Object.keys(counts).sort()) console.log(`${String(counts[k]).padStart(5)}  ${k}`);
    console.log(`${String(all.length).padStart(5)}  TOTAL`);
    console.log("\nbarrel-routing and unresolved are never rewritten — handle by hand.");
    return;
  }

  const scope = arg("--scope") ?? "";
  const wanted = SCOPES[scope];
  if (!wanted) {
    console.error(`[FAIL] --scope must be one of: ${Object.keys(SCOPES).join(", ")}`);
    process.exit(1);
  }

  const dir = arg("--dir");
  let batch = all.filter((h) => wanted.includes(h.klass));
  if (dir) batch = batch.filter((h) => h.file.startsWith(dir));

  const changed = apply(batch);
  const files = new Set(batch.map((h) => h.file)).size;
  console.log(`[OK] rewrote ${changed} specifier(s) across ${files} file(s).`);
  console.log("Next: verify with `bun run lint`, `bun run typecheck`, `bun run test`.");
  console.log("Do NOT run biome over test/ files — see the header comment.");
}

if (import.meta.main) main();
