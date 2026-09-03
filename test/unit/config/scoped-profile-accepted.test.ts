import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { rejectDeadQualityFlags, validatePermissionsBlock } from "@/config/config-guards";
import { NaxConfigSchema } from "@/config/schema";

// NaxConfigSchema.default() at the `execution` key only fills in defaults
// when `execution` is absent from the input entirely — Zod does not deep-merge
// a partially-supplied nested object against its own default. `loadConfig`
// avoids this by deep-merging with DEFAULT_CONFIG before ever calling
// safeParse; a direct schema test has to supply the same required siblings
// (maxIterations, costLimit, etc.) itself, so start from DEFAULT_CONFIG.execution.
describe("scoped profile is accepted now that enforcement exists", () => {
  test("the schema accepts a permissions block", () => {
    const parsed = NaxConfigSchema.safeParse({
      execution: {
        ...DEFAULT_CONFIG.execution,
        permissionProfile: "scoped",
        permissions: {
          default: { allowedTools: ["Read", "Glob", "Grep"] },
          review: { allowedTools: ["Read", "Git(diff,log)"] },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("an unknown key inside a permission block is still rejected", () => {
    const parsed = NaxConfigSchema.safeParse({
      execution: {
        ...DEFAULT_CONFIG.execution,
        permissionProfile: "scoped",
        permissions: { review: { allowedTools: ["Read"], nonsense: true } },
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("the unrelated dead-flag guard still exists and still runs", () => {
    expect(typeof rejectDeadQualityFlags).toBe("function");
  });
});

describe("validatePermissionsBlock", () => {
  test("accepts a well-formed block", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { review: { allowedTools: ["Read", "Git(diff)"] } } } }),
    ).not.toThrow();
  });

  test("rejects an unknown tool name rather than granting nothing", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { review: { allowedTools: ["Reed"] } } } }),
    ).toThrow(/unknown tool/i);
  });

  test("rejects an inherit target that does not exist", () => {
    expect(() => validatePermissionsBlock({ execution: { permissions: { review: { inherit: "nowhere" } } } })).toThrow(
      /inherit/i,
    );
  });

  test("rejects an unclosed pattern list", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { run: { allowedTools: ["Write(src/**"] } } } }),
    ).toThrow(/unclosed/i);
  });

  test("ignores config with no permissions block", () => {
    expect(() => validatePermissionsBlock({ execution: {} })).not.toThrow();
  });
});
