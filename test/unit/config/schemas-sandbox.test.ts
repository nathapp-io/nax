import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";
import { DEFAULT_SANDBOX_CONFIG, SandboxConfigSchema } from "@/config/schemas-sandbox";

describe("execution.sandbox", () => {
  test("defaults: on, srt, no extra roots, open network", () => {
    expect(SandboxConfigSchema.parse({})).toEqual({
      enabled: true,
      backend: "srt",
      filesystem: { allowWrite: [], denyRead: [] },
      network: {},
    });
  });

  test("nested defaults apply when only a parent key is given (zod 4 prefault, not default)", () => {
    expect(SandboxConfigSchema.parse({ filesystem: {} }).filesystem).toEqual({ allowWrite: [], denyRead: [] });
    expect(SandboxConfigSchema.parse({ network: {} }).network).toEqual({});
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
    expect(fs).toEqual({ allowWrite: ["~/.cache/custom", "build-out", "/abs/dir"], denyRead: ["~/secrets"] });
  });

  test("BUG-20: the NaxConfig execution default carries the schema-derived sandbox default", () => {
    expect(NaxConfigSchema.parse({}).execution.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});
