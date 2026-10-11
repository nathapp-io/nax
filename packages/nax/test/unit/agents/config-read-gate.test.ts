/**
 * US-003 — the config read gate.
 *
 * `isNaxConfigFile` refuses nax's own config files to EVERY tool, reads
 * included, through `resolveWithin`. The concern behind that refusal is a
 * WRITE concern (`quality.commands` / `acceptance.command` run through a shell
 * without passing the permission gate), so a clean scan may open the reads
 * while every write refusal stays exactly as it is.
 *
 * `createConfigReadGatePolicy(base, configReadable)` wraps
 * `naxOwnedPathsPolicy` rather than editing it: `src/agents/nax-owned-writes.ts`
 * carries a verbatim copy in `packages/nax-agent/test/helpers/nax-owned-paths.ts`
 * pinned by `test/unit/agents/nax-owned-writes-copy.test.ts`, and it must stay
 * byte-identical.
 *
 * The implementation the ACs below pin lives in
 * `packages/nax/src/agents/config-read-gate.ts`, exporting
 * `createConfigReadGatePolicy`, `NAX_CONFIG_READ_TOOLS`,
 * `NAX_CONFIG_WRITE_REFUSAL` and `NAX_CONFIG_READ_DISABLED_SUFFIX`. It is
 * loaded lazily so each AC fails on its own, and so the module's own absence
 * does not take out the whole file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnedBashCandidate } from "@nathapp/nax-agent";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_CONFIG_REFUSAL, naxOwnedPathsPolicy } from "@/agents/nax-owned-writes";

type GateModule = typeof import("@/agents/config-read-gate");

/**
 * Loads the module under test.
 *
 * The module is the deliverable, so its absence must surface as a FAILED
 * ASSERTION rather than a module-resolution crash: a crash proves only that a
 * file is missing, never which AC the code fails, and the two are different
 * signals for whoever implements this.
 */
async function gateModule(): Promise<GateModule> {
  const mod = await import("@/agents/config-read-gate").catch(() => undefined);
  expect(mod).toBeDefined();
  if (mod === undefined) throw new Error("[test] @/agents/config-read-gate is missing");
  return mod;
}

let root: string;

beforeEach(() => {
  // Canonical, symlink-resolved paths are the PORT CONTRACT: `OwnedBashCandidate.lexical`
  // is documented as "resolved lexically against one working directory, symlinks resolved
  // (`realOrRaw`)" and `policy-bash-raw` builds every candidate as
  // `realOrRaw(resolve(directory, candidate))`. A temp dir on macOS is `/tmp/...`, whose
  // realpath is `/private/tmp/...`, so a fixture that hands the policy an unresolved root
  // would assert behaviour the port never promises -- and would force the policy to
  // canonicalize paths it was already given resolved.
  root = realOrRaw(makeTempDir("nax-config-read-gate-"));
  mkdirSync(join(root, ".nax"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
});

afterEach(() => {
  cleanupTempDir(root);
});

const NO_OPT_INS = { optIns: new Set<string>() };

async function gate(readable: boolean) {
  const { createConfigReadGatePolicy } = await gateModule();
  return createConfigReadGatePolicy(naxOwnedPathsPolicy, readable);
}

function configCandidate(dir: string): OwnedBashCandidate {
  return { lexical: join(dir, ".nax", "config.json"), rel: ".nax/config.json" };
}

function queueCandidate(dir: string): OwnedBashCandidate {
  return { lexical: join(dir, ".queue.txt"), rel: ".queue.txt" };
}

describe("US-003 createConfigReadGatePolicy — configRefusal", () => {
  test("US-003 AC1: an open gate admits the root config file", async () => {
    const policy = await gate(true);
    expect(policy.configRefusal(root, join(root, ".nax", "config.json"))).toBeUndefined();
  });

  test("US-003 AC1 (boundary): an open gate admits a nested mono package config too", async () => {
    const policy = await gate(true);
    expect(policy.configRefusal(root, join(root, ".nax", "mono", "apps", "api", "config.json"))).toBeUndefined();
  });

  test("US-003 AC2: a closed gate defaults to a dispatch-neutral read-disabled reason", async () => {
    const { NAX_CONFIG_READ_DISABLED_SUFFIX, NAX_CONFIG_SECRET_READ_DISABLED_REASON, createConfigReadGatePolicy } =
      await gateModule();
    const policy = await gate(false);
    const refusal = policy.configRefusal(root, join(root, ".nax", "config.json"));
    expect(refusal).toBe(`${NAX_CONFIG_REFUSAL}${NAX_CONFIG_READ_DISABLED_SUFFIX}`);
    expect(refusal).not.toContain("secret");
    expect(refusal).not.toContain("nax doctor");
    const secretPolicy = createConfigReadGatePolicy(
      naxOwnedPathsPolicy,
      false,
      NAX_CONFIG_SECRET_READ_DISABLED_REASON,
    );
    expect(secretPolicy.configRefusal(root, join(root, ".nax", "config.json"))).toContain("nax doctor");
  });

  test("US-003 AC3: a closed gate leaves an ordinary source path alone", async () => {
    const policy = await gate(false);
    expect(policy.configRefusal(root, join(root, "src", "a.ts"))).toBeUndefined();
  });

  test("US-003 AC3 (boundary): a closed gate still refuses the root config", async () => {
    const policy = await gate(false);
    expect(policy.configRefusal(root, join(root, ".nax", "config.json"))).not.toBeUndefined();
  });
});

describe("US-003 createConfigReadGatePolicy — writeRefusal", () => {
  const MONO = ".nax/mono/apps/api/config.json";

  test.each([
    { name: "Write" },
    { name: "Edit" },
    { name: "Delete" },
    { name: "GitCommit" },
    { name: "Git" },
    { name: "ScratchpadWrite" },
  ])("US-003 AC4: an open gate refuses $name a mono package config write", async ({ name }) => {
    const { NAX_CONFIG_WRITE_REFUSAL } = await gateModule();
    const policy = await gate(true);
    expect(policy.writeRefusal(name, MONO, NO_OPT_INS)).toBe(`"${MONO}" ${NAX_CONFIG_WRITE_REFUSAL}`);
  });

  test("US-003 AC5: an open gate does not refuse a config write to the read-only tools", async () => {
    const { NAX_CONFIG_READ_TOOLS } = await gateModule();
    const policy = await gate(true);
    const tools = [...NAX_CONFIG_READ_TOOLS];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(policy.writeRefusal(tool, ".nax/config.json", NO_OPT_INS)).toBeUndefined();
    }
  });

  test("US-003 AC5 (boundary): NAX_CONFIG_READ_TOOLS is exactly the read-only tool set", async () => {
    const { NAX_CONFIG_READ_TOOLS } = await gateModule();
    expect([...NAX_CONFIG_READ_TOOLS]).toEqual(["Read", "Grep", "Glob", "ScratchpadRead", "ScratchpadList"]);
  });

  test("US-003 AC6: a non-config PRD write refusal is byte-identical to the base policy's", async () => {
    const policy = await gate(true);
    const rel = ".nax/features/f/prd.json";
    expect(policy.writeRefusal("Write", rel, NO_OPT_INS)).toBe(
      naxOwnedPathsPolicy.writeRefusal("Write", rel, NO_OPT_INS),
    );
  });

  test("US-003 AC6 (boundary): a closed gate delegates every write refusal to the base policy", async () => {
    const policy = await gate(false);
    // The config write refusal is a READ-GATE concern: with the gate closed the
    // wrapper adds nothing and the base policy answers unchanged (writes are
    // still blocked by `configRefusal` at the containment seam).
    expect(policy.writeRefusal("Write", ".nax/config.json", NO_OPT_INS)).toBe(
      naxOwnedPathsPolicy.writeRefusal("Write", ".nax/config.json", NO_OPT_INS),
    );
    const prd = ".nax/features/f/prd.json";
    expect(policy.writeRefusal("Write", prd, NO_OPT_INS)).toBe(
      naxOwnedPathsPolicy.writeRefusal("Write", prd, NO_OPT_INS),
    );
  });
});

describe("US-003 createConfigReadGatePolicy — bashRefusal", () => {
  const REL = ".nax/config.json";

  test("US-003 AC7: sandbox-wrapped raw Bash that only NAMES the config may read it when the gate is open", async () => {
    const policy = await gate(true);
    expect(
      policy.bashRefusal("Bash", REL, [configCandidate(root)], { root, verb: "names", sandboxWrapped: true }),
    ).toBeUndefined();
  });

  test("US-003 AC8: without the sandbox wrapper the base refusal stands", async () => {
    const policy = await gate(true);
    const candidates = [configCandidate(root)];
    const ctx = { root, verb: "names" as const, sandboxWrapped: false };
    expect(policy.bashRefusal("Bash", REL, candidates, ctx)).toBe(
      naxOwnedPathsPolicy.bashRefusal("Bash", REL, candidates, ctx),
    );
  });

  test("US-003 AC9: a redirect INTO the config is refused exactly as the base policy refuses it", async () => {
    const policy = await gate(true);
    const candidates = [configCandidate(root)];
    const ctx = { root, verb: "redirects into" as const, sandboxWrapped: true };
    const expected = naxOwnedPathsPolicy.bashRefusal("Bash", REL, candidates, ctx);
    expect(expected).not.toBeUndefined();
    expect(policy.bashRefusal("Bash", REL, candidates, ctx)).toBe(expected);
  });

  test("US-003 AC10: a candidate list carrying PRD/queue as well as config is refused as the base policy refuses it", async () => {
    const policy = await gate(true);
    const candidates = [configCandidate(root), queueCandidate(root)];
    const ctx = { root, verb: "names" as const, sandboxWrapped: true };
    const expected = naxOwnedPathsPolicy.bashRefusal("Bash", "x", candidates, ctx);
    expect(expected).not.toBeUndefined();
    expect(policy.bashRefusal("Bash", "x", candidates, ctx)).toBe(expected);
  });

  test("US-003 AC7 (boundary): a closed gate refuses a sandbox-wrapped raw Bash that names the config", async () => {
    const policy = await gate(false);
    const candidates = [configCandidate(root)];
    const ctx = { root, verb: "names" as const, sandboxWrapped: true };
    expect(policy.bashRefusal("Bash", REL, candidates, ctx)).toBe(
      naxOwnedPathsPolicy.bashRefusal("Bash", REL, candidates, ctx),
    );
  });
});

describe("US-003 createConfigReadGatePolicy — unchanged base fields", () => {
  test("US-003 AC11: deniedEntries is the base policy's own array, by reference", async () => {
    const policy = await gate(true);
    expect(policy.deniedEntries).toBe(naxOwnedPathsPolicy.deniedEntries);
  });

  test("US-003 AC11 (boundary): the remaining base fields answer exactly as the base policy's do", async () => {
    const policy = await gate(true);
    expect(policy.rootWriteDenies).toEqual(naxOwnedPathsPolicy.rootWriteDenies);
    expect(policy.scratchpadEntry).toBe(naxOwnedPathsPolicy.scratchpadEntry);
    expect(policy.writeOptIns(root, [])).toEqual(naxOwnedPathsPolicy.writeOptIns(root, []));
  });
});
