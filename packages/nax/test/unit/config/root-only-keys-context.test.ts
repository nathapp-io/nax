/**
 * US-002 — `context.rules` and `context.projectContext` are root-only.
 *
 * The run-level rules override and project-context file describe what the
 * operator asked this *run* to load, so a per-package `.nax/mono/<pkg>/config.json`
 * must not change them. Both pinning forms are covered: the typed
 * `pinRootOnlyKeys` (used by the runtime's package registry on an already-parsed
 * config) and `pinRootOnlyKeysRaw` (used by `loadConfigForWorkdir` before
 * `safeParse`, which warns per ignored key).
 *
 * The two `context` sub-keys are pinned *individually*: every other `context.*`
 * key — `v2` above all — keeps the package's merged value, because the context
 * engine is genuinely per-package tunable.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { pinRootOnlyKeys, pinRootOnlyKeysRaw } from "@/config";

const ROOT_RULES = { delivery: "index" as const, overrideDir: "/abs/org-rules", overrideMode: "merge" as const };
const ROOT_PROJECT_CONTEXT = { file: "/abs/root-context.md", mode: "append" as const };

const root = makeNaxConfig({
  context: { rules: { ...ROOT_RULES }, projectContext: { ...ROOT_PROJECT_CONTEXT } },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `context` block of a raw (unparsed) result, or an empty stand-in. */
function rawContext(out: Record<string, unknown>): Record<string, unknown> {
  return isRecord(out.context) ? out.context : {};
}

describe("pinRootOnlyKeys — context.rules and context.projectContext (US-002)", () => {
  test("AC-15: a package rules block is replaced by root's", () => {
    const merged = makeNaxConfig({ context: { rules: { delivery: "push", overrideMode: "replace" } } });

    const out = pinRootOnlyKeys(merged, root);

    expect(out.context.rules.delivery).toBe("index");
  });

  test("the pinned rules block is root's whole block, not just the differing key", () => {
    const merged = makeNaxConfig({ context: { rules: { delivery: "push", overrideDir: "/elsewhere" } } });

    const out = pinRootOnlyKeys(merged, root);

    expect(out.context.rules).toEqual(root.context.rules);
  });

  test("a package projectContext block is replaced by root's", () => {
    const merged = makeNaxConfig({ context: { projectContext: { file: "/elsewhere.md", mode: "replace" } } });

    const out = pinRootOnlyKeys(merged, root);

    expect(out.context.projectContext).toEqual(root.context.projectContext);
  });

  test("AC-16: every other context.* key keeps the package's merged value (v2.minScore)", () => {
    const merged = makeNaxConfig({ context: { v2: { minScore: 0.5 }, rules: { delivery: "push" } } });

    const out = pinRootOnlyKeys(merged, root);

    expect(out.context.v2.minScore).toBe(0.5);
    expect(out.context.v2).toEqual(merged.context.v2);
    expect(out.context.rules.delivery).toBe("index");
  });
});

describe("pinRootOnlyKeysRaw — context.rules and context.projectContext (US-002)", () => {
  test("AC-17: warns once naming context.rules when a package sets a different delivery", () => {
    const warnings: string[] = [];

    const out = pinRootOnlyKeysRaw({ context: { rules: { delivery: "push" } } }, root, "packages/api", (m) =>
      warnings.push(m),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("context.rules");
    expect(warnings[0]).toContain('"packages/api"');
    expect(rawContext(out).rules).toEqual(root.context.rules);
  });

  test("AC-18: a raw context.v2 block is returned unchanged alongside the pinned rules", () => {
    const rawV2 = { minScore: 0.5, enabled: true };

    const out = pinRootOnlyKeysRaw(
      { context: { rules: { delivery: "push" }, v2: rawV2 } },
      root,
      "packages/api",
      () => {},
    );

    const context = rawContext(out);
    expect(context.v2).toEqual(rawV2);
    expect(context.v2).toBe(rawV2);
    expect(context.rules).toEqual(root.context.rules);
  });

  test("a differing projectContext block warns once naming context.projectContext and is replaced", () => {
    const warnings: string[] = [];

    const out = pinRootOnlyKeysRaw(
      { context: { projectContext: { file: "/elsewhere.md" } } },
      root,
      "packages/api",
      (m) => warnings.push(m),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("context.projectContext");
    expect(rawContext(out).projectContext).toEqual(root.context.projectContext);
  });

  test("no warning when the package's context block equals root's", () => {
    const warnings: string[] = [];

    const out = pinRootOnlyKeysRaw(
      { context: { rules: { ...root.context.rules }, projectContext: { ...root.context.projectContext } } },
      root,
      "packages/api",
      (m) => warnings.push(m),
    );

    expect(warnings).toHaveLength(0);
    expect(rawContext(out).rules).toEqual(root.context.rules);
  });

  test("a raw config with no context key is left without one", () => {
    const out = pinRootOnlyKeysRaw({ execution: {} }, root, "packages/api", () => {});

    expect(Object.hasOwn(out, "context")).toBe(false);
  });

  test("both sub-keys differ → one warning each (never a combined one)", () => {
    const warnings: string[] = [];

    pinRootOnlyKeysRaw(
      { context: { rules: { delivery: "push" }, projectContext: { file: "/x.md" } } },
      root,
      "packages/api",
      (m) => warnings.push(m),
    );

    expect(warnings).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("context.rules"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("context.projectContext"))).toHaveLength(1);
  });
});
