import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { validatePermissionsBlock } from "@/config/config-guards";
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

/**
 * A cycle in `inherit` resolves to FEWER grants, not more — the resolver walks
 * with a seen-set and falls through to `default`. So this is not a security
 * hole, and it was correctly deferred once.
 *
 * It is still worth refusing at load. A stage that silently receives the
 * default block's grants instead of the ones its author wrote fails in the
 * direction that looks like the tool being broken: the model is denied
 * something the config appears to permit, mid-run, with nothing pointing at
 * the config. The alternative to a loud error is not "it works" but "someone
 * debugs a permission denial that the config itself explains".
 */
describe("validatePermissionsBlock — inherit cycles", () => {
  function check(permissions: Record<string, unknown>) {
    return () => validatePermissionsBlock({ execution: { permissions } });
  }

  test("rejects a block that inherits from itself", () => {
    expect(check({ review: { inherit: "review" } })).toThrow(/cycle/i);
  });

  test("rejects a two-block cycle", () => {
    expect(check({ plan: { inherit: "run" }, run: { inherit: "plan" } })).toThrow(/cycle/i);
  });

  test("rejects a longer cycle", () => {
    expect(check({ a: { inherit: "b" }, b: { inherit: "c" }, c: { inherit: "a" } })).toThrow(/cycle/i);
  });

  test("names the cycle, so the config author can see which links to cut", () => {
    expect(check({ plan: { inherit: "run" }, run: { inherit: "plan" } })).toThrow(/plan.*run.*plan/s);
  });

  test("accepts a chain that merely converges on one block", () => {
    // Not a cycle: two stages inheriting the same target, and a chain that
    // ends. A seen-set kept across stages rather than per-walk would call this
    // a cycle and reject a legitimate config.
    expect(
      check({
        default: { allowedTools: ["Read"] },
        plan: { inherit: "default" },
        run: { inherit: "default" },
        review: { inherit: "run" },
      }),
    ).not.toThrow();
  });

  test("accepts a long acyclic chain", () => {
    expect(check({ a: { inherit: "b" }, b: { inherit: "c" }, c: { allowedTools: ["Read"] } })).not.toThrow();
  });
});

const conf = (block: Record<string, unknown>) => ({ execution: { permissions: { run: block } } });

describe("validatePermissionsBlock — allow/deny/ask lists", () => {
  test("accepts allow, deny and ask lists of known tools", () => {
    expect(() =>
      validatePermissionsBlock(conf({ allow: ["Read", "Write(src/**)"], deny: ["Delete"], ask: ["GitCommit"] })),
    ).not.toThrow();
  });

  test("rejects a block carrying both allowedTools and allow", () => {
    expect(() => validatePermissionsBlock(conf({ allowedTools: ["Read"], allow: ["Read"] }))).toThrow(
      /CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT|both "allowedTools" and "allow"/,
    );
  });

  test.each(["allow", "deny", "ask"] as const)("rejects an unknown tool in %s", (key) => {
    expect(() => validatePermissionsBlock(conf({ [key]: ["Ncat(payload)"] }))).toThrow(/unknown tool "Ncat"/);
  });

  test.each(["allow", "deny", "ask"] as const)("rejects an unclosed pattern list in %s", (key) => {
    expect(() => validatePermissionsBlock(conf({ [key]: ["Write(src/**"] }))).toThrow(/unclosed pattern list/);
  });

  test("still validates the legacy allowedTools list", () => {
    expect(() => validatePermissionsBlock(conf({ allowedTools: ["Nope"] }))).toThrow(/unknown tool "Nope"/);
  });
});
