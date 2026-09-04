import { describe, expect, test } from "bun:test";
import { applyDiffAccess, wrapDiffAccess } from "@/prompts/diff-access";

const SPEC = {
  ref: "abc123",
  fullExclude: [".", ":!.nax/", ":!**/.nax/"],
  productionExclude: [".", ":!*.test.ts", ":!.nax/"],
  testGlobs: ["**/*.test.ts"],
  testAudit: true,
};

const SHELL_BODY = "## Diff Access\n\nRun: `git diff --unified=3 abc123..HEAD -- . ':!.nax/'`\n";

function wrapped(): string {
  return `before\n${wrapDiffAccess(SPEC, SHELL_BODY)}after\n`;
}

/** Every `Git {...}` / `Read {...}` example in a rendered prompt, parsed. */
function toolCalls(prompt: string): { tool: string; input: Record<string, unknown> }[] {
  const out: { tool: string; input: Record<string, unknown> }[] = [];
  for (const match of prompt.matchAll(/\b(Git|Read) (\{.*\})/g)) {
    out.push({ tool: match[1] as string, input: JSON.parse(match[2] as string) });
  }
  return out;
}

describe("wrapDiffAccess", () => {
  test("keeps the shell body verbatim between the markers", () => {
    expect(wrapDiffAccess(SPEC, SHELL_BODY)).toContain(SHELL_BODY);
  });

  test("carries the spec in the opening marker", () => {
    expect(wrapDiffAccess(SPEC, SHELL_BODY)).toContain('"ref":"abc123"');
  });
});

describe("applyDiffAccess — acp", () => {
  // The acpx arm must be byte-identical to the pre-change prompt, so that any
  // later measurement of native's Git error rate is attributable to native.
  test("strips the markers and leaves the shell body untouched", () => {
    expect(applyDiffAccess(wrapped(), "acp")).toBe(`before\n${SHELL_BODY}after\n`);
  });

  test("leaves a prompt with no diff-access region alone", () => {
    expect(applyDiffAccess("plain prompt", "acp")).toBe("plain prompt");
    expect(applyDiffAccess("plain prompt", "native")).toBe("plain prompt");
  });
});

describe("applyDiffAccess — native", () => {
  const rendered = applyDiffAccess(wrapped(), "native");

  test("replaces the region, keeping the surrounding prompt", () => {
    expect(rendered.startsWith("before\n")).toBe(true);
    expect(rendered.endsWith("after\n")).toBe(true);
    expect(rendered).not.toContain("nax:diff-access");
  });

  test("emits no shell command and no shell-only tool", () => {
    expect(rendered).not.toContain("git diff");
    expect(rendered).not.toContain("git log");
    expect(rendered).not.toContain("cat path/to");
  });

  test("states the baseline ref", () => {
    expect(rendered).toContain("abc123");
  });

  // The defect this whole change exists for: 12 of 19 Git failures in the
  // tool-audit ledgers had a "-"-leading element in refs or paths, transliterated
  // out of the shell text these examples replace. If an example ever carries one,
  // the prompt is teaching the model the failure.
  test("no example puts a flag in refs or paths", () => {
    const calls = toolCalls(rendered);
    expect(calls.length).toBeGreaterThan(0);
    for (const { input } of calls) {
      const elements = [...((input.refs as string[]) ?? []), ...((input.paths as string[]) ?? [])];
      for (const element of elements) expect(element.startsWith("-")).toBe(false);
    }
  });

  test("every example is a well-formed call to a tool that exists", () => {
    for (const { tool, input } of toolCalls(rendered)) {
      if (tool === "Read") expect(typeof input.path).toBe("string");
      else expect(["diff", "log", "show", "status", "blame"]).toContain(String(input.subcommand));
    }
  });

  test("expresses the added-files audit through the typed flag fields", () => {
    const added = toolCalls(rendered).find((c) => c.input.diffFilter !== undefined);
    expect(added?.input.subcommand).toBe("diff");
    expect(added?.input.nameOnly).toBe(true);
    expect(added?.input.diffFilter).toBe("A");
  });

  test("carries the exclusion pathspecs into the paths array unquoted", () => {
    const full = toolCalls(rendered).find((c) => (c.input.paths as string[])?.includes(":!.nax/"));
    expect(full).toBeDefined();
    expect(full?.input.paths).not.toContain("':!.nax/'");
  });

  test("passes the test-file globs through for the test-gap check", () => {
    expect(rendered).toContain("**/*.test.ts");
  });

  test("omits the added-files call when the spec asks for no test audit", () => {
    const noAudit = applyDiffAccess(wrapDiffAccess({ ref: "r1", fullExclude: ["."] }, SHELL_BODY), "native");
    expect(toolCalls(noAudit).some((c) => c.input.diffFilter !== undefined)).toBe(false);
  });

  test("substitutes every region when a prompt carries more than one", () => {
    const two = `${wrapDiffAccess(SPEC, SHELL_BODY)}\n${wrapDiffAccess({ ...SPEC, ref: "def456" }, SHELL_BODY)}`;
    const out = applyDiffAccess(two, "native");
    expect(out).not.toContain("nax:diff-access");
    expect(out).toContain("def456");
  });
});

/**
 * The failure mode is the point of the delimiter shape: if substitution never
 * runs, or the marker is damaged, the prompt must degrade to the shell text
 * that shipped before this change — never to a marker with no body.
 */
describe("applyDiffAccess — degradation", () => {
  test("leaves an unterminated region untouched rather than truncating the prompt", () => {
    const damaged = `before\n<!--nax:diff-access {"ref":"abc123"}-->\n${SHELL_BODY}`;
    expect(applyDiffAccess(damaged, "native")).toBe(damaged);
  });

  test("keeps the shell body when the spec JSON cannot be parsed", () => {
    const damaged = `<!--nax:diff-access {not json}-->\n${SHELL_BODY}<!--/nax:diff-access-->`;
    expect(applyDiffAccess(damaged, "native")).toContain(SHELL_BODY);
  });
});
