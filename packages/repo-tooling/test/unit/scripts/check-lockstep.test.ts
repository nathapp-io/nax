import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectedVersion } from "#scripts/check-lockstep";
import {
  LOCKSTEP_PACKAGES,
  lockstepErrors,
  type Manifest,
  type Manifests,
  readManifests,
  withVersion,
} from "#scripts/lib/lockstep";

const ROOT = resolve(import.meta.dir, "../../../../..");

function manifests(overrides: Record<string, Manifest> = {}): Manifests {
  const base: Record<string, Manifest> = {
    "packages/nax-ai": { name: "@nathapp/nax-ai", version: "0.84.0" },
    "packages/nax-agent": {
      name: "@nathapp/nax-agent",
      version: "0.84.0",
      dependencies: { "@nathapp/nax-ai": "0.84.0", zod: "4.0.0" },
    },
    "packages/nax-agent-acp": {
      name: "@nathapp/nax-agent-acp",
      version: "0.84.0",
      peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
    },
    "packages/nax": { name: "@nathapp/nax", version: "0.84.0", dependencies: { "@nathapp/nax-ai": "0.84.0" } },
  };
  return new Map(Object.entries({ ...base, ...overrides }));
}

describe("lockstepErrors", () => {
  test("passes when every package shares one version and both consumers pin nax-ai to it", () => {
    expect(lockstepErrors(manifests())).toEqual([]);
  });

  test("names every package when the versions differ", () => {
    const errors = lockstepErrors(manifests({ "packages/nax-ai": { name: "@nathapp/nax-ai", version: "0.1.16" } }));
    expect(errors.join("\n")).toContain("packages/nax-ai@0.1.16");
    expect(errors.join("\n")).toContain("packages/nax@0.84.0");
  });

  test.each(["0.83.9", "^0.84.0", "workspace:*", undefined])("rejects a nax-agent nax-ai pin of %p", (pin) => {
    const dependencies: Record<string, string> = pin === undefined ? {} : { "@nathapp/nax-ai": pin };
    const errors = lockstepErrors(
      manifests({ "packages/nax-agent": { name: "@nathapp/nax-agent", version: "0.84.0", dependencies } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packages/nax-agent");
  });

  test("checks the expected version when one is given", () => {
    expect(lockstepErrors(manifests(), "0.84.0")).toEqual([]);
    expect(lockstepErrors(manifests(), "0.84.1")[0]).toContain("0.84.1");
  });

  test("accepts a canary shared version and rejects a malformed one", () => {
    expect(lockstepErrors(withVersion(manifests(), "0.84.1-canary.1"))).toEqual([]);
    expect(lockstepErrors(withVersion(manifests(), "bad")).join("\n")).toContain('invalid shared version "bad"');
  });
});

describe("withVersion", () => {
  test("moves every package and both nax-ai pins, and leaves everything else alone", () => {
    const before = manifests();
    const after = withVersion(before, "0.85.0");
    expect([...after.values()].map((m) => m.version)).toEqual(["0.85.0", "0.85.0", "0.85.0", "0.85.0"]);
    expect(after.get("packages/nax-agent")?.dependencies).toEqual({ "@nathapp/nax-ai": "0.85.0", zod: "4.0.0" });
    expect(after.get("packages/nax-agent-acp")?.peerDependencies).toEqual({ "@nathapp/nax-agent": "workspace:*" });
    expect(lockstepErrors(after)).toEqual([]);
    expect(before.get("packages/nax")?.version).toBe("0.84.0");
  });

  test("keeps key order, so a bump is a one-line diff per field", () => {
    expect(Object.keys(withVersion(manifests(), "0.85.0").get("packages/nax-agent") ?? {})).toEqual([
      "name",
      "version",
      "dependencies",
    ]);
  });
});

describe("the real workspace", () => {
  test("is in lockstep", () => {
    expect(lockstepErrors(readManifests(ROOT))).toEqual([]);
  });

  test("every manifest round-trips through the release writer byte for byte", () => {
    for (const { dir } of LOCKSTEP_PACKAGES) {
      const text = readFileSync(join(ROOT, dir, "package.json"), "utf8");
      expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
    }
  });
});

describe("check-lockstep CLI", () => {
  test("reads --expect", () => {
    expect(expectedVersion(["bun", "check-lockstep.ts", "--expect=0.84.0"])).toBe("0.84.0");
    expect(expectedVersion(["bun", "check-lockstep.ts"])).toBeUndefined();
  });

  test("fails when the expected version is not the shared one", () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "packages/repo-tooling/scripts/check-lockstep.ts"), "--expect=0.0.1"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.0.1");
  });
});
