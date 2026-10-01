#!/usr/bin/env bun
/**
 * S0a monorepo conversion (spec: docs/superpowers/specs/2026-10-01-s0-monorepo-conversion-design.md §8.1).
 * Re-runnable from a clean, unconverted tree on refactor/nax-monorepo. Leaves its output uncommitted.
 */
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPY_TO_PKG, PKG_DIR } from "./lib/constants";
import { editClaudeSettings, editContributing, editNaxPackageJson, markBiomeNested, splitNaxConfig } from "./lib/edits";
import { splitGitignore } from "./lib/gitignore-split";
import { diffExternalResolutions, externalResolutions } from "./lib/lock-resolutions";
import { planMoves } from "./lib/move-plan";
import { assertPreconditions } from "./lib/preconditions";
import { rewriteRuleFrontmatter } from "./lib/rule-frontmatter";
import { run } from "./lib/sh";

const BRANCH = "refactor/nax-monorepo";
const ROOT = run(["git", "rev-parse", "--show-toplevel"], process.cwd()).trim();
const TPL = join(ROOT, "tools", "monorepo", "templates");
const read = (p: string) => Bun.file(join(ROOT, p)).text();
const write = (p: string, s: string) => writeFileSync(join(ROOT, p), s);
const report: string[] = [];
const step = (name: string) => report.push(`\n## ${name}`);

async function main(): Promise<void> {
  step("preconditions");
  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  assertPreconditions(
    {
      branch: run(["git", "branch", "--show-current"], ROOT).trim(),
      dirty: run(["git", "status", "--porcelain"], ROOT).trim() !== "",
      hasPackagesDir: existsSync(join(ROOT, "packages")),
      hasPrepareScript: pkg.scripts?.prepare !== undefined,
    },
    BRANCH,
  );
  const lockBefore = externalResolutions(await read("bun.lock"));

  step("git mv");
  const topLevel = [...new Set(run(["git", "ls-files"], ROOT).split("\n").filter(Boolean).map((p) => p.split("/")[0] as string))];
  const { move, keep } = planMoves(topLevel);
  run(["mkdir", "-p", PKG_DIR], ROOT);
  for (const entry of move) run(["git", "mv", entry, `${PKG_DIR}/${entry}`], ROOT);
  for (const f of COPY_TO_PKG) {
    copyFileSync(join(ROOT, f), join(ROOT, PKG_DIR, f));
    run(["git", "add", `${PKG_DIR}/${f}`], ROOT);
  }
  report.push(`moved (${move.length}): ${move.join(", ")}`, `kept at root: ${keep.join(", ")}`);

  step("root files");
  // Template filenames need not match their targets: the biome template is
  // named biome.root.json so Biome cannot auto-discover it inside tools/
  // before the conversion runs (a discovered second root config is an error).
  for (const [tpl, target] of [
    ["package.json", "package.json"],
    ["bunfig.toml", "bunfig.toml"],
    ["biome.root.json", "biome.json"],
    ["README.md", "README.md"],
  ] as const) {
    copyFileSync(join(TPL, tpl), join(ROOT, target));
  }
  write(`${PKG_DIR}/package.json`, editNaxPackageJson(await read(`${PKG_DIR}/package.json`)));
  write(`${PKG_DIR}/biome.json`, markBiomeNested(await read(`${PKG_DIR}/biome.json`)));

  step("lockfile");
  run(["bun", "install"], ROOT);
  const drift = diffExternalResolutions(lockBefore, externalResolutions(await read("bun.lock")));
  if (drift.added.length > 0 || drift.removed.length > 0) {
    throw new Error(`lock drift: +${drift.added.join(",")} -${drift.removed.join(",")}`);
  }
  report.push(`external resolutions unchanged (${lockBefore.length})`);

  step("CI + release");
  copyFileSync(join(TPL, "ci.yml"), join(ROOT, ".github/workflows/ci.yml"));
  copyFileSync(join(TPL, "release.yml"), join(ROOT, ".github/workflows/release.yml"));

  step("editor + docs");
  write(".claude/settings.json", editClaudeSettings(await read(".claude/settings.json")));
  write("CONTRIBUTING.md", editContributing(await read("CONTRIBUTING.md")));

  step(".nax monorepo");
  const { root, mono } = splitNaxConfig(await read(".nax/config.json"));
  run(["mkdir", "-p", ".nax/mono/packages/nax"], ROOT);
  write(".nax/config.json", root);
  write(".nax/mono/packages/nax/config.json", mono);
  run(["git", "mv", ".nax/context.md", ".nax/mono/packages/nax/context.md"], ROOT);
  copyFileSync(join(TPL, "root-context.md"), join(ROOT, ".nax/context.md"));

  step("rules");
  for (const f of readdirSync(join(ROOT, ".nax/rules")).filter((n) => n.endsWith(".md"))) {
    write(`.nax/rules/${f}`, rewriteRuleFrontmatter(await read(`.nax/rules/${f}`), PKG_DIR));
    report.push(`rule rewritten: ${f}`);
  }
  const nax = ["bun", `${PKG_DIR}/bin/nax.ts`];
  run([...nax, "rules", "export", "--agent", "claude"], ROOT);

  step(".gitignore");
  const split = splitGitignore(await read(".gitignore"));
  write(".gitignore", split.root);
  write(`${PKG_DIR}/.gitignore`, split.pkg);
  report.push(`moved to ${PKG_DIR}/.gitignore: ${split.moved.join(", ")}`);

  step("nax generate");
  run([...nax, "generate"], ROOT);
  run([...nax, "generate", "--all-packages"], ROOT);

  run(["git", "add", "-A"], ROOT);
  console.log(`# convert-s0a report${report.join("\n")}\n\nOutput staged, NOT committed. Review, then commit.`);
}

main().catch((err) => {
  console.error(`convert-s0a FAILED at the last step printed above:\n${(err as Error).message}`);
  console.error(report.join("\n"));
  process.exit(1);
});
