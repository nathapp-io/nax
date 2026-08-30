#!/usr/bin/env bun
/**
 * Prevent source from open-coding an ACP permission mode.
 *
 * Every permission decision belongs to `resolvePermissions()` in
 * `src/config/permissions.ts` — the project's mandatory SSOT rule. Nothing
 * enforced it, so a bare `"approve-reads"` sat in `adapter-close-physical.ts`
 * and was re-found and re-filed by three consecutive whole-repo reviews
 * (SEC-12): each one correctly read the rule, correctly saw the violation, and
 * had no way to tell a ruled exemption from an unfixed defect. A gate plus an
 * at-the-site marker answers that question once instead of every review.
 *
 * Resolve via `resolvePermissions(config, stage)`, or — where no config is in
 * scope by design — import a named constant from `src/config/permissions.ts`
 * with its rationale recorded at the definition.
 *
 * Comments are skipped outright. A site that *consumes* an already-resolved
 * mode rather than deciding one (translating it into a CLI flag, say) carries an
 * explicit `nax-permission-mode-allow: <reason>` marker, so the exemption is
 * visible to the next reviewer reading that line.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_ROOTS = ["src"] as const;

/** The resolver's own definitions, and the gate's own test fixtures. */
const ALLOWED_FILES = new Set(["src/config/permissions.ts", "test/unit/scripts/check-permission-mode-ssot.test.ts"]);

/**
 * The ACP permission-mode tokens. `"default"` — the third member of the mode
 * union — is deliberately not listed: it is an ordinary English word that
 * appears in unrelated string literals throughout `src/`, so gating it would
 * cost more in false positives than the one real site it could ever catch.
 */
const PERMISSION_MODES = ["approve-all", "approve-reads"] as const;

/** Opt-out marker for a site that consumes a resolved mode rather than deciding one. */
const ALLOW_MARKER = "nax-permission-mode-allow";

/** Lines that are pure prose — comments and their continuations. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Drop a trailing `//` comment so prose after real code is not matched. Naive on
 * purpose: a `//` inside a string literal truncates the line early, which can
 * only ever hide a violation (false negative), never invent one.
 */
function stripTrailingComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

export interface PermissionModeViolation {
  file: string;
  line: number;
  mode: string;
  snippet: string;
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(fullPath);
    }
  }

  return out;
}

/** Matches the mode only as a complete string literal, single- or double-quoted. */
function literalPattern(mode: string): RegExp {
  return new RegExp(`["']${mode}["']`);
}

export function findPermissionModeViolations(repoRoot: string): PermissionModeViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => collectTypeScriptFiles(join(repoRoot, root)));
  const violations: PermissionModeViolation[] = [];

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    if (ALLOWED_FILES.has(relPath)) continue;

    const lines = readFileSync(file, "utf8").split("\n");

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (isCommentLine(line) || line.includes(ALLOW_MARKER)) continue;
      const code = stripTrailingComment(line);
      const mode = PERMISSION_MODES.find((candidate) => literalPattern(candidate).test(code));
      if (!mode) continue;
      violations.push({ file: relPath, line: index + 1, mode, snippet: line.trim() });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatPermissionModeViolationReport(violations: readonly PermissionModeViolation[]): string {
  if (violations.length === 0) {
    return "[OK] No open-coded permission modes outside src/config/permissions.ts";
  }

  const lines = [
    "[FAIL] Hardcoded ACP permission mode found",
    "",
    "Permission decisions belong to resolvePermissions(config, stage) in src/config/permissions.ts.",
    "Where no config is in scope by design, import a named constant from that file and record",
    "the rationale at its definition (see SESSION_CLOSE_PERMISSION_MODE).",
    `If the line only consumes an already-resolved mode, append "// ${ALLOW_MARKER}: <reason>".`,
    "",
  ];

  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line}`);
    lines.push(`  ${violation.snippet}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const violations = findPermissionModeViolations(process.cwd());
  const report = formatPermissionModeViolationReport(violations);
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
