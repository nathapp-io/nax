/**
 * Phase 4 invariants — ADR-013 AgentRegistry ownership cleanup
 *
 * Acceptance criteria:
 *   - AgentManager.getAgent() works without an explicit registry (lazy creation)
 *   - src/agents barrel does NOT export getAgent (removed)
 *   - src/agents barrel DOES export KNOWN_AGENT_NAMES
 *   - createAgentRegistry is only used inside src/agents/manager.ts
 *   - No src/ file outside src/agents/manager.ts imports from agents/registry
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

const ROOT = join(import.meta.dir, "../../../");

async function readSrc(rel: string): Promise<string> {
  return Bun.file(join(ROOT, rel)).text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: AgentManager lazy registry
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentManager — lazy registry creation (Phase 4)", () => {
  test("getAgent returns an adapter without an explicit registry", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    const adapter = manager.getAgent("claude");
    expect(adapter).not.toBeUndefined();
  });

  test("getAgent returns undefined for unknown agent names", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    const adapter = manager.getAgent("unknown-agent-xyz");
    expect(adapter).toBeUndefined();
  });

  test("getAgent returns the same adapter on repeated calls (cache)", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    const first = manager.getAgent("claude");
    const second = manager.getAgent("claude");
    expect(first).toBe(second);
  });

  test("_registry is undefined before first getAgent() call and defined after", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    // Access private field via type cast to verify laziness
    const before = (manager as unknown as Record<string, unknown>)["_registry"];
    expect(before).toBeUndefined();
    manager.getAgent("claude");
    const after = (manager as unknown as Record<string, unknown>)["_registry"];
    expect(after).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Barrel invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("src/agents barrel — Phase 4 exports", () => {
  test("barrel does NOT export getAgent", async () => {
    const code = await readSrc("src/agents/index.ts");
    // getAgent (the stub) must not be in the barrel export
    expect(code).not.toMatch(/export\s+\{[^}]*\bgetAgent\b[^}]*\}\s+from/);
  });

  test("barrel DOES export KNOWN_AGENT_NAMES", async () => {
    const code = await readSrc("src/agents/index.ts");
    expect(code).toContain("KNOWN_AGENT_NAMES");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-wide invariants: no createAgentRegistry outside agents/manager.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentRegistry confinement (Phase 4)", () => {
  test("no src/ file outside src/agents/manager.ts imports createAgentRegistry", async () => {
    const files: string[] = [];
    for await (const f of new Bun.Glob("**/*.ts").scan({ cwd: join(ROOT, "src"), absolute: true })) {
      files.push(f);
    }
    const violations: string[] = [];
    for (const file of files) {
      // Allow in agents/manager.ts (the one permitted import site) and
      // agents/registry.ts (the definition site).
      if (file.endsWith("agents/manager.ts") || file.endsWith("agents/registry.ts")) continue;
      const content = await Bun.file(file).text();
      if (content.includes("createAgentRegistry")) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(violations).toEqual([]);
  });

  test("no src/ file outside src/agents/manager.ts imports from agents/registry", async () => {
    const files: string[] = [];
    for await (const f of new Bun.Glob("**/*.ts").scan({ cwd: join(ROOT, "src"), absolute: true })) {
      files.push(f);
    }
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith("agents/manager.ts") || file.endsWith("agents/registry.ts")) continue;
      const content = await Bun.file(file).text();
      // Match value imports from agents/registry — type-only imports are fine
      if (/import\s+(?!type\s*\{)[^;]+from\s+["'][^"']*agents\/registry["']/.test(content)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(violations).toEqual([]);
  });
});
