import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { AgentResource, CommandResource, ResourceOrigin, ResourcePackage, SkillResource } from "@/resources";
import * as resources from "@/resources";

function skill(name: string, origin: ResourceOrigin): SkillResource {
  const qualifiedName = "plugin" in origin ? `${origin.plugin}:${name}` : name;
  return {
    kind: "skill",
    name,
    qualifiedName,
    origin,
    description: name,
    body: name,
    baseDir: `/fixture/${qualifiedName}`,
    path: `/fixture/${qualifiedName}/SKILL.md`,
    modelInvocable: true,
  };
}
function command(name: string, origin: ResourceOrigin): CommandResource {
  return {
    kind: "command",
    name,
    qualifiedName: "plugin" in origin ? `${origin.plugin}:${name}` : name,
    origin,
    template: name,
    path: `/fixture/${name}.md`,
  };
}
function agent(name: string, origin: ResourceOrigin): AgentResource {
  return {
    kind: "agent",
    name,
    qualifiedName: "plugin" in origin ? `${origin.plugin}:${name}` : name,
    origin,
    description: name,
    prompt: name,
    path: `/fixture/agents/${name}.md`,
  };
}
function pkg(id: string, origin: ResourceOrigin, overrides: Partial<ResourcePackage> = {}): ResourcePackage {
  return {
    id,
    origin,
    root: `/fixture/${id}`,
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    hooks: [],
    diagnostics: [],
    ...overrides,
  };
}
const userOrigin = { kind: "claude-user" } as const;
const projectOrigin = { kind: "claude-project" } as const;
const pluginOrigin = { kind: "claude-plugin", plugin: "p", marketplace: "m" } as const;
const userSkill = skill("x", userOrigin);
const pluginSkill = skill("x", pluginOrigin);
const user = pkg("claude-user", userOrigin, { skills: [userSkill] });
const plugin = pkg("p@m", pluginOrigin, { skills: [pluginSkill] });
const collisionCatalog = () => resources.buildResourceCatalog([user, plugin]);
const projectCommand = command("c", projectOrigin);
const pluginCommand = command("c", pluginOrigin);
const commandCatalog = () =>
  resources.buildResourceCatalog([
    pkg("claude-project", projectOrigin, { commands: [projectCommand] }),
    pkg("p@m", pluginOrigin, { commands: [pluginCommand] }),
  ]);
const projectAgent = agent("a", projectOrigin);
const pluginAgent = agent("a", pluginOrigin);
const agentCatalog = () =>
  resources.buildResourceCatalog([
    pkg("claude-project", projectOrigin, { agents: [projectAgent] }),
    pkg("p@m", pluginOrigin, { agents: [pluginAgent] }),
  ]);

describe("buildResourceCatalog", () => {
  test("AC-1 exposes every skill in package order", () => {
    const project = pkg("claude-project", projectOrigin, {
      skills: [skill("a", projectOrigin), skill("b", projectOrigin)],
    });
    const catalog = resources.buildResourceCatalog([project, user]);
    expect(catalog.skills).toEqual([...project.skills, ...user.skills]);
    expect(catalog.packages).toEqual([project, user]);
  });
  test("AC-2 user short name wins over plugin", () => {
    expect(collisionCatalog().findSkill("x")).toBe(userSkill);
  });
  test("AC-3 shadowed plugin is reachable by qualified name", () => {
    expect(collisionCatalog().findSkill("p:x")).toBe(pluginSkill);
  });
  test("AC-4 warns with winner and qualified alternative", () => {
    expect(collisionCatalog().diagnostics).toContainEqual({
      severity: "warn",
      path: pluginSkill.path,
      origin: pluginOrigin,
      message: "skill x from p@m is shadowed by claude-user; use p:x",
    });
    expect(collisionCatalog().skills).toEqual([userSkill, pluginSkill]);
  });
  test("AC-5 first enabled Claude plugin wins", () => {
    const a = pkg("a@m", { ...pluginOrigin, plugin: "a" }, { skills: [skill("s", { ...pluginOrigin, plugin: "a" })] });
    const b = pkg("b@m", { ...pluginOrigin, plugin: "b" }, { skills: [skill("s", { ...pluginOrigin, plugin: "b" })] });
    expect(resources.buildResourceCatalog([a, b]).findSkill("s")).toBe(a.skills[0]);
  });
  test("AC-6 project command short name wins", () => {
    expect(commandCatalog().findCommand("c")).toBe(projectCommand);
  });
  test("AC-7 shadowed command stays qualified and warns", () => {
    const catalog = commandCatalog();
    expect(catalog.findCommand("p:c")).toBe(pluginCommand);
    expect(catalog.commands).toEqual([projectCommand, pluginCommand]);
    expect(catalog.diagnostics).toContainEqual({
      severity: "warn",
      path: pluginCommand.path,
      origin: pluginOrigin,
      message: "command c from p@m is shadowed by claude-project; use p:c",
    });
  });
  test("AC-8 unknown names return undefined", () => {
    expect(collisionCatalog().findSkill("missing")).toBeUndefined();
    expect(commandCatalog().findCommand("missing")).toBeUndefined();
  });
  test("AC-9 retains every package diagnostic", () => {
    const diagnostics = [
      { severity: "error", path: "/fixture/a", origin: projectOrigin, message: "bad skill" },
      { severity: "warn", path: "/fixture/b", origin: userOrigin, message: "skipped plugin" },
    ] as const;
    const catalog = resources.buildResourceCatalog([
      pkg("claude-project", projectOrigin, { diagnostics: [diagnostics[0]] }),
      pkg("claude-user", userOrigin, { diagnostics: [diagnostics[1]] }),
    ]);
    expect(catalog.diagnostics).toEqual(diagnostics);
  });
});

describe("buildResourceCatalog agents", () => {
  test("US-002 AC-3 exposes every agent in package order", () => {
    const a = agent("a", projectOrigin);
    const b = agent("b", projectOrigin);
    expect(resources.buildResourceCatalog([pkg("claude-project", projectOrigin, { agents: [a, b] })]).agents).toEqual([
      a,
      b,
    ]);
  });
  test("US-002 AC-4 project agent short name wins", () => {
    expect(agentCatalog().findAgent("a")).toBe(projectAgent);
  });
  test("US-002 AC-5 shadowed plugin agent is reachable by qualified name", () => {
    expect(agentCatalog().findAgent("p:a")).toBe(pluginAgent);
  });
  test("US-002 AC-6 shadowed agent warns with winner and qualified alternative", () => {
    expect(agentCatalog().diagnostics).toContainEqual({
      severity: "warn",
      path: pluginAgent.path,
      origin: pluginOrigin,
      message: "agent a from p@m is shadowed by claude-project; use p:a",
    });
  });
  test("US-002 AC-7 shadowed agents stay in agents", () => {
    expect(agentCatalog().agents).toHaveLength(2);
  });
  test("US-002 AC-8/9 an empty catalog has no agents", () => {
    const catalog = resources.buildResourceCatalog([]);
    expect(catalog.agents).toEqual([]);
    expect(catalog.findAgent("x")).toBeUndefined();
  });
});

describe("loadResourceCatalog", () => {
  let dir: string;
  let repoRoot: string;
  let claudeDir: string;
  beforeEach(async () => {
    dir = makeTempDir();
    repoRoot = join(dir, "repo");
    claudeDir = join(dir, "claude");
    await Bun.write(join(claudeDir, "skills/u/SKILL.md"), "---\ndescription: user fixture\n---\nBody");
    const installPath = join(dir, "plugin");
    await Bun.write(join(installPath, "skills/s/SKILL.md"), "---\ndescription: plugin fixture\n---\nBody");
    await Bun.write(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": true } }));
    await Bun.write(
      join(claudeDir, "plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "p@m": [{ scope: "user", installPath }] } }),
    );
  });
  afterEach(() => cleanupTempDir(dir));
  const naxOrigin = { kind: "nax-plugin", plugin: "native" } as const;
  const nax = pkg("nax:native", naxOrigin, { skills: [skill("n", naxOrigin)] });
  const load = (
    config: { resources?: { claudeCode: boolean; skillsInRun: boolean; mcpInRun: boolean } },
    naxPluginPackages: ResourcePackage[] = [],
  ) => resources.loadResourceCatalog({ repoRoot, config, env: { CLAUDE_CONFIG_DIR: claudeDir }, naxPluginPackages });
  test("AC-10 enabled Claude discovery loads the fixture user skill", async () => {
    expect(
      (await load({ resources: { claudeCode: true, skillsInRun: false, mcpInRun: false } })).findSkill("u"),
    ).toMatchObject({
      origin: userOrigin,
      path: join(claudeDir, "skills/u/SKILL.md"),
    });
  });
  test("US-002 AC-13 loads a .claude/agents fixture with its prompt body", async () => {
    await Bun.write(
      join(repoRoot, ".claude/agents/reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews tests\n---\nCheck tests.\n",
    );
    const catalog = await load({ resources: { claudeCode: true, skillsInRun: false, mcpInRun: false } });
    expect(catalog.findAgent("reviewer")?.prompt.startsWith("Check tests.")).toBe(true);
  });
  test("AC-11 disabled Claude discovery returns no skills or packages", async () => {
    const catalog = await load({ resources: { claudeCode: false, skillsInRun: false, mcpInRun: false } });
    expect(catalog.skills).toEqual([]);
    expect(catalog.packages).toEqual([]);
  });
  test("AC-12 absent resources defaults to Claude discovery", async () => {
    expect((await load({})).findSkill("u")).toMatchObject({ origin: userOrigin });
  });
  test("AC-13 includes nax plugin skills", async () => {
    expect((await load({}, [nax])).findSkill("n")).toBe(nax.skills[0]);
  });
  test("AC-14 appends nax plugins after all Claude packages", async () => {
    expect((await load({}, [nax])).packages.map((p) => p.id)).toEqual([
      "claude-project",
      "claude-user",
      "p@m",
      "nax:native",
    ]);
  });
});
