// test/unit/config/legacy-agent-keys.test.ts
//
// Regression guard for ADR-012 Phase 6: loading a pre-migration config with
// legacy agent keys (autoMode.defaultAgent / autoMode.fallbackOrder /
// context.v2.fallback) must throw with a clear migration message.
//
// Without this guard, Zod's default .strip() mode silently drops the unknown
// keys and the run continues with agent.default="claude" — re-introducing
// the exact silent-no-op failure mode the ADR was designed to prevent.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxError } from "../../../src/errors";
import { _clearRootConfigCache, loadConfig } from "../../../src/config/loader";

function writeProjectConfig(contents: object): string {
  const root = mkdtempSync(join(tmpdir(), "nax-legacy-cfg-"));
  const naxDir = join(root, ".nax");
  require("node:fs").mkdirSync(naxDir, { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

describe("ADR-012 Phase 6 — legacy config key guard", () => {
  beforeEach(() => {
    _clearRootConfigCache();
  });

  test("rejects autoMode.defaultAgent with migration pointer", async () => {
    const root = writeProjectConfig({
      autoMode: { defaultAgent: "codex" },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_AGENT_KEYS");
      expect(e.message).toContain("autoMode.defaultAgent");
      expect(e.message).toContain("agent.default");
      expect(e.message).toContain("ADR-012");
    }
  });

  test("rejects autoMode.fallbackOrder with migration pointer", async () => {
    const root = writeProjectConfig({
      autoMode: { fallbackOrder: ["claude", "codex"] },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_AGENT_KEYS");
      expect(e.message).toContain("autoMode.fallbackOrder");
      expect(e.message).toContain("agent.fallback.map");
      expect(e.message).toContain("ADR-012");
    }
  });

  test("rejects context.v2.fallback with migration pointer", async () => {
    const root = writeProjectConfig({
      context: { v2: { fallback: { enabled: true } } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_AGENT_KEYS");
      expect(e.message).toContain("context.v2.fallback");
      expect(e.message).toContain("agent.fallback");
      expect(e.message).toContain("ADR-012");
    }
  });

  test("reports all legacy keys at once", async () => {
    const root = writeProjectConfig({
      autoMode: { defaultAgent: "codex", fallbackOrder: ["codex"] },
      context: { v2: { fallback: { enabled: true } } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.message).toContain("autoMode.defaultAgent");
      expect(e.message).toContain("autoMode.fallbackOrder");
      expect(e.message).toContain("context.v2.fallback");
      const ctx = e.context as { legacyKeys?: string[] } | undefined;
      expect(ctx?.legacyKeys).toEqual([
        "autoMode.defaultAgent",
        "autoMode.fallbackOrder",
        "context.v2.fallback",
      ]);
    }
  });

  test("accepts canonical config — agent.default + agent.fallback.map", async () => {
    const root = writeProjectConfig({
      agent: {
        default: "claude",
        fallback: { enabled: true, map: { claude: ["codex"] } },
      },
    });
    const config = await loadConfig(root);
    expect(config.agent?.default).toBe("claude");
    expect(config.agent?.fallback?.enabled).toBe(true);
    expect(config.agent?.fallback?.map).toEqual({ claude: ["codex"] });
  });

  test("accepts config with no agent section (uses defaults)", async () => {
    const root = writeProjectConfig({});
    const config = await loadConfig(root);
    expect(config.agent?.default).toBe("claude");
    expect(config.agent?.fallback?.enabled).toBe(false);
  });
});
