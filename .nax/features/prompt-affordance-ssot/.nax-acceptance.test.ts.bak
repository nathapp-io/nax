import { describe, expect, test } from "bun:test";
import {
  CLOSING_MARKER,
  OPENING_MARKER,
  PROTOCOL_REGION_MARKER_PREFIX,
  applyDiffAccess,
  applyDiffAccessForAgentProtocol,
  applyProtocolRegions,
  unwrapProtocolRegions,
  wrapAffordance,
  wrapDiffAccess,
} from "../../../src/prompts/sections";
import { buildIsolationSection } from "../../../src/prompts/sections/isolation";
import { buildRoleTaskSection } from "../../../src/prompts/sections/role-task";
import { buildSelfVerificationSection } from "../../../src/prompts/sections/self-verification";

const body = "Run `git diff origin/main..HEAD` exactly\n";
const diff = { kind: "diff-access", requires: ["Git", "Read"], baselineRef: "origin/main" };
const render = (text: string, options: object) => applyProtocolRegions(text, options);
const wrapped = (text = body) => wrapAffordance("diff-access", diff, text);
const acp = (text: string) => render(text, { protocol: "acp" });
const native = (text: string, advertisedTools?: string[]) =>
  render(text, advertisedTools === undefined ? { protocol: "native" } : { protocol: "native", advertisedTools });
const commandSpec = (command: string, files?: string) => ({
  kind: "run-command",
  requires: ["RunCommand"],
  command,
  ...(files ? { values: { files } } : {}),
});

function region(command: string, shell: string, files?: string): string {
  return wrapAffordance("run-command", commandSpec(command, files), shell);
}

describe("prompt-affordance-ssot", () => {
  test("AC-1: barrel wrapper preserves the ACP body between markers", () => {
    const result = wrapped();
    expect(wrapAffordance).toBeTypeOf("function");
    expect(result.includes(body)).toBe(true);
    expect(result.startsWith(OPENING_MARKER)).toBe(true);
    expect(result.endsWith(CLOSING_MARKER)).toBe(true);
    expect(result.slice(result.indexOf(OPENING_MARKER) + OPENING_MARKER.length, result.lastIndexOf(CLOSING_MARKER))).toContain(body);
  });

  test("AC-2: ACP substitution is byte-for-byte body replacement", () => {
    const prompt = `prefix:${wrapped()}:suffix`;
    expect(acp(prompt)).toBe(`prefix:${body}:suffix`);
    expect(acp(prompt)).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("AC-3: native diff rendering uses structured affordance text", () => {
    const result = native(wrapped(), ["Git", "Read"]);
    expect(result).toContain("origin/main");
    expect(result).not.toContain(body);
    expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(result).not.toMatch(/git (diff|log|show)|\$\(|`/);
  });

  test("AC-4: missing required Git retains the exact ACP fallback", () => {
    const prompt = `a${wrapped()}z`;
    expect(native(prompt, ["Read"])).toBe(`a${body}z`);
  });

  test("AC-5: absent advertisedTools does not gate native rendering", () => {
    const result = native(wrapped());
    expect(result).toContain("origin/main");
    expect(result).not.toContain(body);
  });

  test("AC-6: malformed marker JSON falls back to its ACP body", () => {
    const valid = wrapped();
    const malformed = valid.replace(/\{[^\n]*\}/, "{not-valid-json");
    expect(native(malformed, ["Git", "Read"])).toBe(body);
  });

  test("AC-7: unknown affordance kind falls back without throwing", () => {
    const prompt = wrapAffordance("nonexistent-kind", { kind: "nonexistent-kind" }, body);
    expect(() => native(prompt, ["Git", "Read"])).not.toThrow();
    expect(native(prompt, ["Git", "Read"])).toBe(body);
  });

  test("AC-8: foreign nonce markers are inert for both protocols", () => {
    const prompt = wrapped().replace(OPENING_MARKER, OPENING_MARKER.replace(/[^: ]+(?= )/, "foreignnonce"));
    expect(acp(prompt)).toBe(prompt);
    expect(native(prompt, ["Git", "Read"])).toBe(prompt);
  });

  test("AC-9: an unterminated genuine region is unchanged", () => {
    const prompt = wrapped().slice(0, -CLOSING_MARKER.length);
    expect(acp(prompt)).toBe(prompt);
    expect(native(prompt, ["Git", "Read"])).toBe(prompt);
  });

  test("AC-10: one pass substitutes multiple registered kinds", () => {
    const prompt = `p${wrapped("A")}m${region("typecheck", "B")}s`;
    const result = acp(prompt);
    expect(result).toBe("pAmBs");
    expect(result.split(PROTOCOL_REGION_MARKER_PREFIX)).toHaveLength(1);
    expect(native(prompt, ["Git", "Read", "RunCommand"])).toContain("origin/main");
  });

  test("AC-11: forged content remains verbatim while genuine content is substituted", () => {
    const forged = `${PROTOCOL_REGION_MARKER_PREFIX}:foreign attacker payload`;
    const result = native(`${forged}\n${wrapped()}`, ["Git", "Read"]);
    expect(result).toContain(forged);
    expect(result).toContain("origin/main");
  });

  test("AC-12: unwrap replaces all regions with exact ACP bodies", () => {
    const prompt = `pre${wrapped()}mid${region("test", "npm test")}post`;
    expect(unwrapProtocolRegions(prompt)).toBe(`pre${body}midnpm testpost`);
    expect(unwrapProtocolRegions(prompt)).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("AC-13: protocol application is deterministic and idempotent", () => {
    const prompt = `x${wrapped()}y`;
    const r1 = native(prompt, ["Git", "Read"]);
    expect(native(r1, ["Git", "Read"])).toBe(r1);
    expect(native(prompt, ["Git", "Read"])).toBe(r1);
  });

  test("AC-14: legacy wrapDiffAccess two-argument API delegates to ACP substitution", () => {
    const legacy = wrapDiffAccess({ ref: "origin/main" }, body);
    const output = typeof legacy === "function" ? legacy("P", "acp") : applyDiffAccess(`P${legacy}`, "acp", body);
    expect(output).toBe(`P${body}`);
  });

  test("AC-15: legacy native diff application falls back whenever Git is absent", () => {
    const prompt = `P${wrapDiffAccess({ ref: "origin/main" }, body)}`;
    for (const tools of [["Read"], ["Read", "Glob", "Grep"], ["Grep"]]) {
      expect(applyDiffAccess(prompt, "native", tools)).toBe(applyDiffAccess(prompt, "acp", body));
    }
  });

  test("AC-16: agent-protocol adapter requires advertised tools and renders native diff", () => {
    const prompt = `P${wrapDiffAccess({ ref: "origin/main" }, body)}`;
    expect(applyDiffAccessForAgentProtocol("nativeAgentName", prompt, ["Git", "Read"])).not.toContain(body);
    expect(() => applyDiffAccessForAgentProtocol("nativeAgentName", prompt)).toThrow();
  });

  test("AC-17: empty advertised tools is a gated ACP fallback", () => {
    const prompt = `P${wrapDiffAccess({ ref: "origin/main" }, body)}`;
    expect(applyDiffAccessForAgentProtocol("nativeAgentName", prompt, [])).toBe(applyDiffAccess(prompt, "acp", body));
  });

  test("AC-18: native dispatch substitution renders granted diff affordance", () => {
    const result = native(wrapped(), ["Git", "Read"]);
    expect(result).toContain("origin/main"); expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-19: dispatch without Git delivers the shell fallback", () => {
    expect(native(wrapped(), ["Read", "Glob", "Grep"])).toBe(body);
  });
  test("AC-20: ACP dispatch exports no markers", () => {
    expect(acp(wrapped())).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-21: follow-up prompt substitution removes markers", () => {
    expect(acp(`follow-up ${wrapped()}`)).toBe(`follow-up ${body}`);
  });
  test("AC-22: callback-returned prompt is the substituted initial prompt", () => {
    expect(acp(`initial ${wrapped()}`)).toBe(`initial ${body}`);
  });
  test("AC-23: native session dispatch uses native diff rendering", () => {
    expect(native(wrapped(), ["Git", "Read"])).not.toBe(body);
  });
  test("AC-24: native session without Git sends ACP fallback", () => {
    const result = native(wrapped(), ["Glob"]); expect(result).toBe(body); expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("AC-25: configured self-verification removes conditional-tool wording", () => {
    const section = buildSelfVerificationSection("implementer", { packageDir: "/repo", typecheckCommand: "bun x tsc --noEmit" });
    expect(section).not.toContain("if that tool is available to you");
  });
  test("AC-26: ACP typecheck keeps configured shell command without RunCommand", () => {
    const section = buildSelfVerificationSection("implementer", { packageDir: "/repo", typecheckCommand: "bun x tsc --noEmit" });
    const result = acp(section); expect(result).toContain("bun x tsc --noEmit"); expect(result.match(/RunCommand/g) ?? []).toHaveLength(0);
  });
  test("AC-27: native RunCommand typecheck renders one structured command", () => {
    const result = native(region("typecheck", "bun x tsc --noEmit"), ["RunCommand"]);
    expect(result.match(/RunCommand/g) ?? []).toHaveLength(1); expect(result).toContain("typecheck"); expect(result).not.toContain("bun x tsc --noEmit");
  });
  test("AC-28: native without RunCommand keeps configured shell command", () => {
    const result = native(region("typecheck", "bun x tsc --noEmit"), []); expect(result).toBe("bun x tsc --noEmit");
  });
  test("AC-29: unconfigured verification has existing fallback and no regions", () => {
    const result = buildSelfVerificationSection("implementer", { packageDir: "/repo" }); expect(result).toContain("typecheck: unconfigured -> report `skip`"); expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-30: scoped acceptance key renders command and files values", () => {
    const result = native(region("acceptance", "npm test test/a.ts", "test/a.ts"), ["RunCommand"]); expect(result).toContain("acceptance"); expect(result).toContain("test/a.ts");
  });
  test("AC-31: unresolved acceptance key remains raw command on both protocols", () => {
    const raw = "npm test test/a.ts"; expect(acp(raw)).toBe(raw); expect(native(raw, ["RunCommand"])).toBe(raw); expect(raw).not.toContain("RunCommand");
  });
  test("AC-32: acceptance command wording has no conditional-tool phrase", () => {
    for (const value of ["npm test", "", "test"]) expect(region(value || "test", value || "npm test")).not.toContain("if that tool is available to you");
  });
  test("AC-33: ACP isolation preserves the shell-test golden text", () => {
    const golden = buildIsolationSection("implementer", "strict", "sh -c 'npm test'"); expect(acp(golden)).toBe(golden); expect(golden).toContain("NEVER run the full test suite");
  });
  test("AC-34: native isolation RunCommand has files and no shell", () => {
    const result = native(region("test", "sh -c 'npm test test/a.ts'", "test/a.ts"), ["RunCommand"]); expect(result).toContain("test/a.ts"); expect(result).not.toMatch(/sh -c/);
  });
  test("AC-35: unconfigured isolation retains scoped-run fallback with no regions", () => {
    const result = buildIsolationSection("implementer"); expect(result).toContain("scope each run to the files you changed"); expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-36: rectifier failing files render one command affordance each", () => {
    const result = native(region("test", "a", "a.ts") + region("test", "b", "b.ts"), ["RunCommand"]); expect(result.match(/RunCommand/g) ?? []).toHaveLength(2); expect(result).toContain("a.ts"); expect(result).toContain("b.ts");
  });
  test("AC-37: rectifier full suite renders one test command affordance", () => {
    expect(native(region("test", "npm test"), ["RunCommand"]).match(/RunCommand/g) ?? []).toHaveLength(1);
  });
  test("AC-38: ACP rectifier command is replayable verbatim", () => {
    const command = "npm test test/a.ts"; expect(acp(region("test", command))).toBe(command);
  });
  test("AC-39: rectifier without RunCommand preserves shell golden blocks", () => {
    const shells = `${region("test", "npm test a.ts", "a.ts")}${region("test", "npm test", undefined)}`; expect(native(shells, [])).toBe("npm test a.tsnpm test");
  });
  test("AC-40: ACP role-task commit instruction remains literal shell text", () => {
    const text = "git commit -m M"; expect(unwrapProtocolRegions(acp(wrapAffordance("acp", {}, text)))).toContain(text);
  });
  test("AC-41: GitCommit native affordance replaces the shell commit", () => {
    const result = native(wrapAffordance("git-commit", { kind: "git-commit", requires: ["GitCommit"], message: "M" }, "git commit -m M"), ["GitCommit"]); expect(result).toContain("GitCommit"); expect(result).not.toMatch(/git commit/);
  });
  test("AC-42: missing GitCommit retains literal commit shell instruction", () => {
    const prompt = wrapAffordance("git-commit", { kind: "git-commit", requires: ["GitCommit"], message: "M" }, "git commit -m M"); expect(native(prompt, [])).toBe("git commit -m M");
  });
  test("AC-43: all role-task ACP variants export no markers", () => {
    for (const role of ["implementer", "no-test", "batch", "single-session", "tdd-simple", "test-writer"] as const) expect(unwrapProtocolRegions(acp(buildRoleTaskSection(role)))).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-44: GitCommit native variants contain no git commit shell syntax", () => {
    for (let i = 0; i < 6; i++) { const result = native(wrapAffordance("git-commit", { kind: "git-commit", requires: ["GitCommit"], message: `M${i}` }, `git commit -m M${i}`), ["GitCommit"]); expect(unwrapProtocolRegions(result)).not.toMatch(/\bgit commit\b/); expect(result).toContain("GitCommit"); }
  });
  test("AC-45: persisted template content is already marker-free and inert", () => {
    const template = buildRoleTaskSection("implementer"); expect(acp(template)).toBe(template); expect(native(template, ["GitCommit"])).toBe(template); expect(template).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
  test("AC-46: persisted implementer role task stores plain ACP commit instruction", () => {
    const template = buildRoleTaskSection("implementer"); expect(unwrapProtocolRegions(template)).toContain("git commit -m"); expect(template).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
});