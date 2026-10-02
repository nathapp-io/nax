import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_CONFIG, SandboxConfigSchema } from "@nathapp/nax-agent/internal";
import { NaxConfigSchema } from "@/config/schemas";

describe("execution.sandbox", () => {
  test("defaults: on, srt, no extra roots, open network", () => {
    expect(SandboxConfigSchema.parse({})).toEqual({
      enabled: true,
      backend: "srt",
      filesystem: { allowWrite: [], denyRead: [], allowSharedTmp: false },
      network: {},
    });
  });

  test("nested defaults apply when only a parent key is given (zod 4 prefault, not default)", () => {
    expect(SandboxConfigSchema.parse({ filesystem: {} }).filesystem).toEqual({
      allowWrite: [],
      denyRead: [],
      allowSharedTmp: false,
    });
    expect(SandboxConfigSchema.parse({ network: {} }).network).toEqual({});
  });

  test("US-002 AC1: parsing {} defaults filesystem.allowSharedTmp to false", () => {
    expect(SandboxConfigSchema.parse({}).filesystem.allowSharedTmp).toBe(false);
  });

  test("US-002 AC1 boundary: an empty filesystem object defaults allowSharedTmp to false too", () => {
    // `.prefault({})` means the nested object is parsed, not short-circuited, so
    // the default applies to `{ filesystem: {} }` exactly as it does to `{}`.
    expect(SandboxConfigSchema.parse({ filesystem: {} }).filesystem.allowSharedTmp).toBe(false);
  });

  test("US-002 AC2: allowSharedTmp: true survives parsing and leaves allowWrite untouched", () => {
    const filesystem = SandboxConfigSchema.parse({ filesystem: { allowSharedTmp: true } }).filesystem;

    expect(filesystem.allowSharedTmp).toBe(true);
    expect(filesystem.allowWrite).toEqual([]);
  });

  test("US-002 AC2 boundary: an explicit allowSharedTmp: false stays false", () => {
    expect(SandboxConfigSchema.parse({ filesystem: { allowSharedTmp: false } }).filesystem.allowSharedTmp).toBe(false);
  });

  test("an allow-list and an empty no-network list both survive", () => {
    expect(
      SandboxConfigSchema.parse({ network: { allowedDomains: ["registry.npmjs.org"] } }).network.allowedDomains,
    ).toEqual(["registry.npmjs.org"]);
    expect(SandboxConfigSchema.parse({ network: { allowedDomains: [] } }).network.allowedDomains).toEqual([]);
  });

  test("rejects an unknown backend", () => {
    expect(SandboxConfigSchema.safeParse({ backend: "docker" }).success).toBe(false);
  });

  test("F1: rejects glob characters in allowWrite and denyRead (Linux silently drops glob entries)", () => {
    for (const glob of ["out-*", "~/secret?", "a[b]", "{x,y}"]) {
      expect(SandboxConfigSchema.safeParse({ filesystem: { allowWrite: [glob] } }).success).toBe(false);
      expect(SandboxConfigSchema.safeParse({ filesystem: { denyRead: [glob] } }).success).toBe(false);
    }
  });

  test("F1: literal paths, ~ and relative paths are still accepted", () => {
    const fs = SandboxConfigSchema.parse({
      filesystem: { allowWrite: ["~/.cache/custom", "build-out", "/abs/dir"], denyRead: ["~/secrets"] },
    }).filesystem;
    expect(fs).toEqual({
      allowWrite: ["~/.cache/custom", "build-out", "/abs/dir"],
      denyRead: ["~/secrets"],
      allowSharedTmp: false,
    });
  });

  test("BUG-20: the NaxConfig execution default carries the schema-derived sandbox default", () => {
    expect(NaxConfigSchema.parse({}).execution.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});
