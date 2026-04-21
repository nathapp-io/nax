/**
 * Integration test — ADR-013 Phase 5 + Phase 6 adapter boundary enforcement
 *
 * Phase 5: no source file outside src/agents/ calls adapter methods directly.
 * Phase 6: new AgentManager() is confined to src/agents/factory.ts only.
 *
 * Both are grep-based meta-tests that scan the entire src/ tree.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";

const SRC_DIR = join(process.cwd(), "src");

// Files that are allowed to call adapter methods directly — the adapter wiring layer.
// These translate IAgentManager method calls into direct adapter calls. All other
// source files must go through IAgentManager. Keep in sync with .claude/rules/adapter-wiring.md §"Phase 5 Constraint".
const ALLOWED_FILES = new Set([
  "agents/manager.ts", // IAgentManager implementation
  "agents/utils.ts",   // wrapAdapterAsManager() — wraps bare adapter as IAgentManager
]);

// Patterns that indicate direct adapter method calls
// (?!\))  — negative lookahead: do NOT match if ( is immediately followed by )
// This skips decorative mentions in log messages like "adapter.complete() failed"
// while matching actual calls like adapter.complete(prompt) or adapter.complete ()
const FORBIDDEN_PATTERNS = [
  /\badapter\.(run|complete|plan|decompose)\s*\((?!\))/,
  /\bagent\.(run|complete|plan|decompose)\s*\((?!\))/,
];

// Patterns that are allowed (IAgentManager methods via the manager)
const ALLOWED_PATTERNS = [
  /agentManager\.(runAs|completeAs|planAs|decomposeAs)\s*\(/,
  /manager\.(runAs|completeAs|planAs|decomposeAs)\s*\(/,
];

interface Violation {
  file: string;
  line: number;
  code: string;
  pattern: string;
}

// Files allowed to call `new AgentManager(` — the class definition and the single factory.
// All other source files must obtain an IAgentManager via createAgentManager() or parameter threading.
// Enforced here per SPEC-agent-manager-lifetime.md §2.4 and ADR-013 Phase 6.
const NEW_AGENT_MANAGER_ALLOWED = new Set([
  "agents/manager.ts",  // class AgentManager definition
  "agents/factory.ts",  // createAgentManager() — the sole construction point
]);

describe("ADR-013 Phase 6 — new AgentManager() confinement", () => {
  let violations: { file: string; line: number; code: string }[] = [];

  beforeAll(async () => {
    const glob = new Bun.Glob("**/*.ts");
    violations = [];

    for await (const file of glob.scan({ cwd: SRC_DIR, absolute: true })) {
      if (file.endsWith(".d.ts")) continue;
      if (file.includes("/test/")) continue;
      if (file.includes("/types/")) continue;

      const relativePath = file.replace(SRC_DIR + "/", "");
      if (NEW_AGENT_MANAGER_ALLOWED.has(relativePath)) continue;

      const content = await Bun.file(file).text();
      const lines = content.split("\n");

      lines.forEach((line: string, i: number) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (!trimmed) return;

        if (/\bnew AgentManager\s*\(/.test(line)) {
          violations.push({ file: relativePath, line: i + 1, code: line.trim() });
        }
      });
    }
  });

  test("new AgentManager() only in agents/factory.ts", () => {
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}: ${v.code}`).join("\n");
      throw new Error(
        `Found ${violations.length} unexpected new AgentManager() call(s):\n${msg}\n\nUse createAgentManager() from src/agents or receive IAgentManager as a parameter.`,
      );
    }
    expect(violations).toEqual([]);
  });
});

describe("ADR-013 Phase 5 — adapter boundary enforcement", () => {
  let violations: Violation[] = [];

  beforeAll(async () => {
    const glob = new Bun.Glob("**/*.ts");
    violations = [];

    for await (const file of glob.scan({ cwd: SRC_DIR, absolute: true })) {
      // Skip declaration files, test helpers, generated files
      if (file.endsWith(".d.ts")) continue;
      if (file.includes("/test/")) continue;
      if (file.includes("/types/")) continue;

      const relativePath = file.replace(SRC_DIR + "/", "");
      if (ALLOWED_FILES.has(relativePath)) continue;

      const content = await Bun.file(file).text();
      const lines = content.split("\n");

      lines.forEach((line: string, i: number) => {
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

        // Skip empty lines
        if (!trimmed) return;

        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            // Check if this line matches an allowed pattern
            let isAllowed = false;
            for (const allowed of ALLOWED_PATTERNS) {
              if (allowed.test(line)) {
                isAllowed = true;
                break;
              }
            }
            if (!isAllowed) {
              violations.push({
                file: relativePath,
                line: i + 1,
                code: line.trim(),
                pattern: pattern.source,
              });
            }
          }
        }
      });
    }
  });

  test("no direct adapter.run/complete/plan/decompose calls outside agents/manager.ts", () => {
    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.code}`)
        .join("\n");
      throw new Error(`Found ${violations.length} direct adapter call(s):\n${msg}`);
    }
    expect(violations).toEqual([]);
  });

  test("IAgentManager methods are the only allowed adapter call path", () => {
    // This test documents the expected pattern
    // If the first test passes, this is a documentation test
    expect(violations.length).toBe(0);
  });
});
