import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ToolProvider, ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import type { ResourceCatalog, SkillResource } from "@/resources";
import * as resources from "@/resources";

const ctx: ToolRunContext = {
  root: "/unrelated-worktree",
  resolvedPaths: [],
  maxBytes: 300_000,
  maxFileBytes: 300_000,
};
const originalDeps = { ...resources._skillsProviderDeps };
let root: string;
let skill: SkillResource;
function catalog(skills: readonly SkillResource[] = [skill]): ResourceCatalog {
  return resources.buildResourceCatalog([
    {
      id: "superpowers@m",
      origin: skill.origin,
      root,
      skills,
      commands: [],
      agents: [],
      mcpServers: [],
      hooks: [],
      diagnostics: [],
    },
  ]);
}
function provider(skills: readonly SkillResource[] = [skill]): ToolProvider {
  return resources.createSkillsProvider(async () => catalog(skills));
}
async function run(input: Record<string, unknown>, skills: readonly SkillResource[] = [skill]) {
  const tool = (await provider(skills).tools(ctx.root))[0];
  assertDefined(tool);
  return tool.run(input, ctx);
}

beforeEach(async () => {
  root = makeTempDir("skills-provider-");
  const baseDir = join(root, "skill");
  await mkdir(join(baseDir, "references"), { recursive: true });
  await mkdir(join(root, "other"));
  await Bun.write(join(baseDir, "references/a.md"), "Reference text");
  await Bun.write(join(root, "other/SKILL.md"), "Outside secret");
  await symlink(join(root, "other/SKILL.md"), join(baseDir, "escape.md"));
  skill = {
    kind: "skill",
    name: "brainstorming",
    qualifiedName: "superpowers:brainstorming",
    description: "Explore ideas",
    body: "Skill body",
    baseDir,
    path: join(baseDir, "SKILL.md"),
    modelInvocable: true,
    origin: { kind: "claude-plugin", plugin: "superpowers", marketplace: "m" },
  };
});
afterEach(() => {
  Object.assign(resources._skillsProviderDeps, originalDeps);
  cleanupTempDir(root);
});

describe("createSkillsProvider", () => {
  test("AC-1 static provider identity", () => {
    expect(provider()).toMatchObject({ id: "nax-skills", kind: "static", stages: ["*"] });
  });
  test("AC-2 advertises load with required name schema", async () => {
    const tools = await provider().tools(ctx.root);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      localName: "load",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, file: { type: "string" } },
      },
    });
  });
  test("AC-3 empty catalog advertises nothing", async () => {
    expect(await provider([]).tools(ctx.root)).toEqual([]);
  });
  test("AC-4 user-only skills retain reference loader", async () => {
    expect(await provider([{ ...skill, modelInvocable: false }]).tools(ctx.root)).toMatchObject([
      { localName: "load" },
    ]);
  });
  test("AC-5 user-only skills have no instructions", async () => {
    expect(await provider([{ ...skill, modelInvocable: false }]).instructions?.(ctx.root)).toBeUndefined();
  });
  test("AC-6 user-only skill reference is readable", async () => {
    expect(await run({ name: skill.name, file: "references/a.md" }, [{ ...skill, modelInvocable: false }])).toEqual({
      content: "Reference text",
    });
  });
  test("AC-7 lazy catalog is shared across concurrent tools and instructions", async () => {
    const load = mock(async () => catalog());
    const p = resources.createSkillsProvider(load);
    expect(load).not.toHaveBeenCalled();
    await Promise.all([p.tools(ctx.root), p.tools(ctx.root), p.instructions?.(ctx.root)]);
    expect(load).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["AC-8", "brainstorming"],
    ["AC-9", "superpowers:brainstorming"],
  ])("%s returns body ToolResult via %s", async (_ac, name) => {
    expect(await run({ name })).toEqual({ content: `Base directory for this skill: ${skill.baseDir}\n\nSkill body` });
  });
  test("AC-10 unknown skill lists qualified names", async () => {
    expect(await run({ name: "nope" })).toEqual({
      isError: true,
      content: "unknown skill nope; available: superpowers:brainstorming",
    });
  });
  test("AC-11 refuses user-only body", async () => {
    expect(await run({ name: skill.name }, [{ ...skill, modelInvocable: false }])).toEqual({
      isError: true,
      content: "skill brainstorming can only be invoked by the user",
    });
  });
  test("AC-12 reads reference text", async () => {
    expect(await run({ name: skill.name, file: "references/a.md" })).toEqual({ content: "Reference text" });
  });
  test.each(["../other/SKILL.md", "/absolute.md", "bad\0.md", "escape.md"])(
    "AC-13 rejects outside path %j",
    async (file) => {
      expect(await run({ name: skill.name, file })).toEqual({
        isError: true,
        content: `file ${file} is outside skill brainstorming`,
      });
    },
  );
  test("AC-14 missing file is an error result", async () => {
    expect(await run({ name: skill.name, file: "missing.md" })).toEqual({
      isError: true,
      content: "skill brainstorming has no file missing.md",
    });
  });
  test("AC-15 directory is not a regular file", async () => {
    expect(await run({ name: skill.name, file: "references" })).toEqual({
      isError: true,
      content: "file references is not a regular file",
    });
  });
  test("AC-16 rejects oversized reference", async () => {
    await Bun.write(join(skill.baseDir, "large.md"), new Uint8Array(262_145));
    expect(await run({ name: skill.name, file: "large.md" })).toEqual({
      isError: true,
      content: "file large.md exceeds 262144 bytes",
    });
  });
  test("accepts exactly the byte ceiling and a symlinked base directory", async () => {
    const text = "x".repeat(262_144);
    await Bun.write(join(skill.baseDir, "limit.md"), text);
    const alias = join(root, "alias");
    await symlink(skill.baseDir, alias);
    expect(await run({ name: skill.name, file: "limit.md" }, [{ ...skill, baseDir: alias }])).toEqual({
      content: text,
    });
  });
  test("unknown names list at most twenty qualified skills", async () => {
    const skills = Array.from({ length: 21 }, (_, i) => ({ ...skill, name: `s${i}`, qualifiedName: `p:s${i}` }));
    const result = await run({ name: "nope" }, skills);
    expect(result.isError).toBe(true);
    expect(result.content.split("available: ")[1]?.split(", ")).toHaveLength(20);
    expect(result.content).not.toContain("p:s20");
  });
  test.each([{}, { name: 1 }, { name: "brainstorming", file: 1 }])("rejects malformed input %j", async (input) => {
    expect((await run(input)).isError).toBe(true);
  });
  test("reports filesystem failures without throwing", async () => {
    resources._skillsProviderDeps.readFile = async () => {
      throw new Error("read denied");
    };
    expect(await run({ name: skill.name, file: "references/a.md" })).toEqual({
      isError: true,
      content: "[resources] Cannot read file references/a.md for skill brainstorming: read denied",
    });
  });
  test("rejects a reference that grows beyond its stat size", async () => {
    resources._skillsProviderDeps.readFile = async () => new Uint8Array(262_145);
    expect(await run({ name: skill.name, file: "references/a.md" })).toEqual({
      isError: true,
      content: "file references/a.md exceeds 262144 bytes",
    });
  });
  test("AC-17 instructions use builder and omit user-only skills", async () => {
    const text = await provider([skill, { ...skill, qualifiedName: "hidden", modelInvocable: false }]).instructions?.(
      ctx.root,
    );
    expect(text).toContain("nax-skills__load");
    expect(text).toContain("- superpowers:brainstorming: Explore ideas");
    expect(text).not.toContain("hidden");
  });
});
