/**
 * The rule-policy translator (SPEC-cursor-pi-acp-read-only US-002): nax's
 * permission rules translated into opencode's injected permission config, and
 * the pre-spawn launch-env seam every profile goes through.
 */
import { describe, expect, test } from "bun:test";
import { launchEnvFor } from "#src/client/capabilities";
import { resolveAcpOptions } from "#src/client/options";
import {
  OPENCODE_NONE_CONFIG,
  OPENCODE_READ_CONFIG,
  OPENCODE_REVIEW_CONFIG,
  registryEntry,
} from "#src/client/registry";
import {
  type AcpPermissionRules,
  cursorCliConfig,
  NO_RULES,
  opencodePermissionConfig,
  piToolArgs,
  policyLaunchEnv,
} from "#src/client/rule-policy";

const READ = { tool: "Read", patterns: ["*"] } as const;
const GLOB = { tool: "Glob", patterns: ["*"] } as const;
const GREP = { tool: "Grep", patterns: ["*"] } as const;

const rules = (parts: Partial<AcpPermissionRules>): AcpPermissionRules => ({
  allow: parts.allow ?? [],
  deny: parts.deny ?? [],
  ask: parts.ask ?? [],
});

const permissionOf = (config: string): unknown => JSON.parse(config).permission;

describe("opencodePermissionConfig: no read-tool deny rule (SPEC US-002)", () => {
  test.each([
    ["none", OPENCODE_NONE_CONFIG],
    ["read", OPENCODE_READ_CONFIG],
    ["review", OPENCODE_REVIEW_CONFIG],
  ] as const)("%s with no rules is the registry's own config, byte for byte", (profile, expected) => {
    expect(opencodePermissionConfig(profile, NO_RULES)).toBe(expected);
  });

  test("none ignores the rules entirely: no profile can widen it", () => {
    expect(opencodePermissionConfig("none", rules({ allow: [READ], deny: [READ] }))).toBe(OPENCODE_NONE_CONFIG);
  });

  test("review: Bash and Write rules are not translated", () => {
    const bash = { tool: "Bash", patterns: ["*"] };
    const allowed = rules({
      allow: [bash, { tool: "Bash", patterns: ["git status*"] }, { tool: "Write", patterns: ["*"] }],
    });
    expect(opencodePermissionConfig("review", allowed)).toBe(OPENCODE_REVIEW_CONFIG);
    expect(opencodePermissionConfig("review", rules({ deny: [bash, { tool: "Write", patterns: ["*"] }] }))).toBe(
      OPENCODE_REVIEW_CONFIG,
    );
  });
});

describe("opencodePermissionConfig: an unconditional read-tool deny", () => {
  test("read: a Read deny drops read and list, keeping glob and grep", () => {
    expect(permissionOf(opencodePermissionConfig("read", rules({ deny: [READ] })))).toEqual({
      "*": "deny",
      glob: "allow",
      grep: "allow",
    });
  });

  test("read: a Read and Grep deny drops read, list and grep", () => {
    expect(permissionOf(opencodePermissionConfig("read", rules({ deny: [READ, GREP] })))).toEqual({
      "*": "deny",
      glob: "allow",
    });
  });

  test("review: a Glob deny keeps read, list, grep and the asking shell", () => {
    expect(permissionOf(opencodePermissionConfig("review", rules({ deny: [GLOB] })))).toEqual({
      "*": "deny",
      read: "allow",
      grep: "allow",
      list: "allow",
      bash: "ask",
    });
  });

  test("review: denying every read tool leaves only the catch-all deny", () => {
    expect(permissionOf(opencodePermissionConfig("review", rules({ deny: [READ, GLOB, GREP] })))).toEqual({
      "*": "deny",
      bash: "ask",
    });
  });

  test("a wildcard among other patterns still counts as unconditional", () => {
    expect(
      permissionOf(opencodePermissionConfig("read", rules({ deny: [{ tool: "Read", patterns: ["*", "src/**"] }] }))),
    ).toEqual({ "*": "deny", glob: "allow", grep: "allow" });
  });
});

describe("opencodePermissionConfig: rules the translation ignores", () => {
  test.each([
    ["a path-scoped Read deny", { tool: "Read", patterns: ["src/**"] }],
    ["a Read deny on another tool's name", { tool: "ReadFile", patterns: ["*"] }],
    ["an empty Read deny pattern list", { tool: "Read", patterns: [] }],
  ])("%s leaves read exactly as it is", (_label, rule) => {
    expect(opencodePermissionConfig("read", rules({ deny: [rule] }))).toBe(OPENCODE_READ_CONFIG);
  });

  test("an ask rule is not a deny: the agent still gets the tool", () => {
    expect(opencodePermissionConfig("read", rules({ ask: [READ] }))).toBe(OPENCODE_READ_CONFIG);
  });
});

describe("policyLaunchEnv: which profile and entry get a policy", () => {
  const denyRead = { deny: [READ] };

  test.each(["full", "ask"] as const)("%s adds nothing, even with a Read deny rule", async (profile) => {
    const options = resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true, rules: denyRead });
    expect(await policyLaunchEnv(profile, options)).toEqual({});
  });

  test.each(["codex", "claude", "gemini"] as const)(
    "%s: read changes nothing, because its entry names no policy",
    async (agent) => {
      const options = resolveAcpOptions({ agent, allowUnsandboxed: true, rules: denyRead });
      expect(await policyLaunchEnv("read", options)).toEqual(launchEnvFor("read", registryEntry(agent)));
    },
  );

  test("opencode: read with no rules keeps today's config", async () => {
    const options = resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true });
    expect(await policyLaunchEnv("read", options)).toEqual({ OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG });
  });

  test("opencode: read with a Read deny rule gets the translated config", async () => {
    const options = resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true, rules: denyRead });
    const translated = opencodePermissionConfig("read", rules({ deny: [READ] }));
    expect(await policyLaunchEnv("read", options)).toEqual({ OPENCODE_CONFIG_CONTENT: translated });
  });

  test("a custom agent has no policy and no launch env", async () => {
    const options = resolveAcpOptions({
      agent: { name: "my-agent", command: "my-agent-acp" },
      allowUnsandboxed: true,
      rules: denyRead,
    });
    expect(await policyLaunchEnv("read", options)).toEqual({});
  });

  test.each(["full", "ask"] as const)("%s: cursor and pi add no policy env", async (profile) => {
    for (const agent of ["cursor", "pi"] as const) {
      const options = resolveAcpOptions({ agent, allowUnsandboxed: true, rules: denyRead, stateDir: "/state" });
      expect(await policyLaunchEnv(profile, options)).toEqual({});
    }
  });
});

/** Cursor's deny list, in the order nax writes it: the write and web tools, then shell, then Read. */
const CURSOR_WRITE_DENIES = ["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)"];

describe("cursorCliConfig: Cursor's isolated permission config (SPEC US-004)", () => {
  test("AC-1: read allows Read, denies every write and web tool, and denies shell", () => {
    expect(JSON.parse(cursorCliConfig("read", NO_RULES))).toEqual({
      version: 1,
      permissions: { allow: ["Read(**)"], deny: [...CURSOR_WRITE_DENIES, "Shell(*)"] },
      approvalMode: "allowlist",
    });
  });

  test("AC-2: review leaves shell unlisted, so every command is asked of the client", () => {
    expect(JSON.parse(cursorCliConfig("review", NO_RULES)).permissions).toEqual({
      allow: ["Read(**)"],
      deny: [...CURSOR_WRITE_DENIES],
    });
  });

  test("AC-3: none allows nothing and denies Read on top of shell", () => {
    expect(JSON.parse(cursorCliConfig("none", NO_RULES)).permissions).toEqual({
      allow: [],
      deny: [...CURSOR_WRITE_DENIES, "Shell(*)", "Read(**)"],
    });
  });

  test("AC-4: an unconditional Read deny drops the allowance and joins the deny list", () => {
    expect(JSON.parse(cursorCliConfig("review", rules({ deny: [READ] }))).permissions).toEqual({
      allow: [],
      deny: [...CURSOR_WRITE_DENIES, "Read(**)"],
    });
  });

  test("AC-5: Bash and Write rules are not translated", () => {
    const allowed = rules({
      allow: [
        { tool: "Bash", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
      ],
    });
    expect(cursorCliConfig("review", allowed)).toBe(cursorCliConfig("review", NO_RULES));
  });

  test("none ignores the rules: a Read allow cannot widen it", () => {
    const allowed = rules({ allow: [READ], deny: [] });
    expect(cursorCliConfig("none", allowed)).toBe(cursorCliConfig("none", NO_RULES));
  });

  test.each([
    ["a path-scoped Read deny", { tool: "Read", patterns: ["src/**"] }],
    ["a Read ask rule", undefined],
  ])("%s leaves the allowance alone", (_label, rule) => {
    const input = rule === undefined ? rules({ ask: [READ] }) : rules({ deny: [rule] });
    expect(cursorCliConfig("read", input)).toBe(cursorCliConfig("read", NO_RULES));
  });
});

describe("piToolArgs: pi's tool allowlist and its shell gate (SPEC US-004)", () => {
  test("AC-6: read keeps pi's read tools", () => {
    expect(piToolArgs("read", NO_RULES, "/g.ts")).toEqual(["--tools", "read,grep,find,ls"]);
  });

  test("AC-7: none removes every tool", () => {
    expect(piToolArgs("none", NO_RULES, "/g.ts")).toEqual(["--no-tools"]);
  });

  test("AC-8: review drops both of Glob's tools and appends bash behind the gate", () => {
    const input = rules({ allow: [{ tool: "Bash", patterns: ["git *"] }], deny: [GLOB] });
    expect(piToolArgs("review", input, "/g.ts")).toEqual(["-e", "/g.ts", "--tools", "read,grep,bash"]);
  });

  test("AC-9: a Bash allow rule adds no shell under read", () => {
    const input = rules({ allow: [{ tool: "Bash", patterns: ["*"] }] });
    expect(piToolArgs("read", input, "/g.ts")).toEqual(["--tools", "read,grep,find,ls"]);
  });

  test("AC-10: review with every read tool denied and no Bash rule has no tool at all", () => {
    expect(piToolArgs("review", rules({ deny: [READ, GLOB, GREP] }), "/g.ts")).toEqual(["--no-tools"]);
  });

  test("AC-29: review with every read tool denied keeps bash alone, behind the gate", () => {
    const input = rules({ allow: [{ tool: "Bash", patterns: ["ls *"] }], deny: [READ, GLOB, GREP] });
    expect(piToolArgs("review", input, "/g.ts")).toEqual(["-e", "/g.ts", "--tools", "bash"]);
  });

  test("review: a Read deny drops read and keeps grep, find and ls", () => {
    expect(piToolArgs("review", rules({ deny: [READ] }), "/g.ts")).toEqual(["--tools", "grep,find,ls"]);
  });

  test("review: a Grep deny drops grep alone", () => {
    expect(piToolArgs("review", rules({ deny: [GREP] }), "/g.ts")).toEqual(["--tools", "read,find,ls"]);
  });
});
