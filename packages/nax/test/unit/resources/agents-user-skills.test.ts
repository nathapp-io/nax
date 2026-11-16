/**
 * User skills from `~/.agents/skills` (background-agents-and-forge-kind US-002).
 *
 * Other coding agents install skills under `<home>/.agents/skills`; the catalog loads them
 * as the `agents-user` package, after the repo package and `nax-user` and before the Claude
 * Code user and plugin packages.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import * as resources from "@/resources";
import { _claudePathsDeps } from "@/resources/claude-paths";
import { originLabel } from "@/resources/listing";

const helperAgent = "---\nname: helper\ndescription: helps\n---\nHelp out.\n";
const malformedSkill = "---\ndescription: never closed\n";
let savedHomedir: typeof _claudePathsDeps.homedir;
let dir: string;
let home: string;
let repoRoot: string;
let claudeDir: string;
let naxGlobalDir: string;

const load = (claudeCode = true) =>
  resources.loadResourceCatalog({
    repoRoot,
    config: { resources: { claudeCode, skillsInRun: false, mcpInRun: false } },
    env: { CLAUDE_CONFIG_DIR: claudeDir, NAX_GLOBAL_CONFIG_DIR: naxGlobalDir },
    naxPluginPackages: [],
  });

/** One enabled Claude plugin, so the user/plugin packages appear in the order assertion. */
async function enablePlugin(): Promise<void> {
  const installPath = join(dir, "plugin");
  await Bun.write(join(installPath, "skills/s/SKILL.md"), "---\ndescription: plugin fixture\n---\nBody");
  await Bun.write(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": true } }));
  await Bun.write(
    join(claudeDir, "plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "p@m": [{ scope: "user", installPath }] } }),
  );
}

beforeEach(() => {
  dir = makeTempDir();
  home = join(dir, "home");
  repoRoot = join(dir, "repo");
  claudeDir = join(dir, "claude");
  naxGlobalDir = join(dir, "nax-global");
  // `agentsSkillsDir()` reads the real home directory, so discovery is pinned to a temp one.
  savedHomedir = _claudePathsDeps.homedir;
  _claudePathsDeps.homedir = () => home;
});
afterEach(() => {
  _claudePathsDeps.homedir = savedHomedir;
  cleanupTempDir(dir);
});

describe("agentsSkillsDir", () => {
  test("AC-1 resolves to <home>/.agents/skills from the injected homedir", () => {
    _claudePathsDeps.homedir = () => "/home/u";
    expect(resources.agentsSkillsDir()).toBe("/home/u/.agents/skills");
  });
});

describe("originLabel", () => {
  test("AC-2 labels the agents-user origin", () => {
    expect(originLabel({ kind: "agents-user" })).toBe("agents-user");
  });
});

describe("loadResourceCatalog agents-user skills", () => {
  test("AC-3 a skill under <home>/.agents/skills has the agents-user origin", async () => {
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    expect((await load()).findSkill("foo")).toMatchObject({
      name: "foo",
      origin: { kind: "agents-user" },
      path: join(home, ".agents/skills/foo/SKILL.md"),
    });
  });

  test("AC-4 the agents-user package loads with resources.claudeCode disabled", async () => {
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    expect((await load(false)).findSkill("foo")?.origin.kind).toBe("agents-user");
  });

  test("AC-5 no .agents/skills directory yields no agents-user package", async () => {
    // Control: the same fixture under a home that has the directory does create the package.
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    expect((await load()).packages.map((pkg) => pkg.id)).toContain("agents-user");
    const emptyHome = join(dir, "empty-home");
    _claudePathsDeps.homedir = () => emptyHome;
    expect((await load()).packages.map((pkg) => pkg.id)).not.toContain("agents-user");
  });

  test("AC-6 an absent .agents directory adds no diagnostic for it", async () => {
    // Control: a malformed skill there does add a diagnostic under the temp home's .agents.
    await Bun.write(join(home, ".agents/skills/broken/SKILL.md"), malformedSkill);
    const under = (root: string) => (entry: { path: string }) => entry.path.startsWith(join(root, ".agents"));
    expect((await load()).diagnostics.some(under(home))).toBe(true);
    const emptyHome = join(dir, "empty-home");
    _claudePathsDeps.homedir = () => emptyHome;
    expect((await load()).diagnostics.filter(under(emptyHome))).toEqual([]);
  });

  test("AC-7 a repo skill wins a name clash with the agents-user skill", async () => {
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    // Control: with no repo skill, the agents-user skill owns the name.
    expect((await load()).findSkill("foo")?.origin.kind).toBe("agents-user");
    await Bun.write(join(repoRoot, ".claude/skills/foo/SKILL.md"), "---\ndescription: repo skill\n---\nBody");
    expect((await load()).findSkill("foo")?.origin.kind).toBe("claude-project");
  });

  test("AC-8 an agents-user skill wins a name clash with a Claude user skill", async () => {
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    await Bun.write(join(claudeDir, "skills/foo/SKILL.md"), "---\ndescription: claude user skill\n---\nBody");
    expect((await load()).findSkill("foo")?.origin.kind).toBe("agents-user");
  });

  test("AC-9 package order is claude-project, nax-user, agents-user, claude-user, plugin", async () => {
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), helperAgent);
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    await enablePlugin();
    expect((await load()).packages.map((pkg) => pkg.id)).toEqual([
      "claude-project",
      "nax-user",
      "agents-user",
      "claude-user",
      "p@m",
    ]);
  });

  test("AC-10 with no repo package nax-user and agents-user come first", async () => {
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), helperAgent);
    await Bun.write(join(home, ".agents/skills/foo/SKILL.md"), "---\ndescription: user skill\n---\nBody");
    expect((await load(false)).packages.map((pkg) => pkg.id).slice(0, 2)).toEqual(["nax-user", "agents-user"]);
  });

  test("AC-11 malformed frontmatter yields no skill and an error diagnostic on the agents-user origin", async () => {
    const path = join(home, ".agents/skills/broken/SKILL.md");
    await Bun.write(path, malformedSkill);
    const catalog = await load();
    expect(catalog.findSkill("broken")).toBeUndefined();
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", path, origin: { kind: "agents-user" } }),
    );
  });

  test("AC-12 a nested skill directory is not loaded", async () => {
    await Bun.write(join(home, ".agents/skills/a/b/SKILL.md"), "---\ndescription: nested\n---\nBody");
    // Control: the one-level directory beside it is loaded.
    await Bun.write(join(home, ".agents/skills/a/SKILL.md"), "---\ndescription: top level\n---\nBody");
    const catalog = await load();
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["a"]);
    expect(catalog.findSkill("b")).toBeUndefined();
  });
});
