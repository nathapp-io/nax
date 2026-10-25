import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { CommandResource, ResourceOrigin, ResourcePackage, SkillResource } from "@/resources";
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
