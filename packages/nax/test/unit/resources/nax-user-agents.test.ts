/**
 * nax user agents (chat-polish-and-branch-guard US-003).
 *
 * `~/.nax/agents/` is nax's own agent source, labelled `nax-user`, and it outranks
 * plugin agents but not the repo's. `~/.claude/agents/` is no longer scanned at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import * as resources from "@/resources";
import { _claudePathsDeps, naxAgentsDir } from "@/resources/claude-paths";
import { originLabel } from "@/resources/listing";

const HELPER = "---\nname: helper\ndescription: helps\n---\nHelp out.\n";
const REVIEWER = "---\nname: reviewer\ndescription: reviews\n---\nReview it.\n";
const MALFORMED = "---\nname: broken\n---\nNo description.\n";

let savedHomedir: typeof _claudePathsDeps.homedir;
let dir: string;
let repoRoot: string;
let claudeDir: string;
let claudeJson: string;
let naxGlobalDir: string;

const discover = () => resources.discoverClaudeCodePackages({ repoRoot, claudeDir, claudeJson });
const load = (claudeCode = true) =>
  resources.loadResourceCatalog({
    repoRoot,
    config: { resources: { claudeCode, skillsInRun: false, mcpInRun: false } },
    env: { CLAUDE_CONFIG_DIR: claudeDir, NAX_GLOBAL_CONFIG_DIR: naxGlobalDir },
    naxPluginPackages: [],
  });

beforeEach(() => {
  dir = makeTempDir();
  repoRoot = join(dir, "repo");
  claudeDir = join(dir, "claude");
  claudeJson = join(dir, "fixture-missing/.claude.json");
  naxGlobalDir = join(dir, "nax-global");
  // `agentsSkillsDir()` reads the real home directory; pin it so this file stays closed-world.
  savedHomedir = _claudePathsDeps.homedir;
  _claudePathsDeps.homedir = () => join(dir, "home");
});
afterEach(() => {
  _claudePathsDeps.homedir = savedHomedir;
  cleanupTempDir(dir);
});

describe("discoverClaudeCodePackages agent sources", () => {
  test("AC-1 <claudeDir>/agents/reviewer.md leaves the claude-user package with no agents", async () => {
    await Bun.write(join(claudeDir, "agents/reviewer.md"), REVIEWER);
    const user = (await discover()).find((pkg) => pkg.id === "claude-user");
    expect(user).toMatchObject({ agents: [] });
  });

  test("AC-2 <claudeDir>/skills/<name>/SKILL.md still loads on the claude-user package", async () => {
    await Bun.write(join(claudeDir, "skills/u/SKILL.md"), "---\ndescription: user fixture\n---\nBody");
    const user = (await discover()).find((pkg) => pkg.id === "claude-user");
    expect(user?.skills).toMatchObject([{ name: "u" }]);
  });

  test("AC-3 <repoRoot>/.claude/agents/reviewer.md is still a claude-project agent", async () => {
    await Bun.write(join(repoRoot, ".claude/agents/reviewer.md"), REVIEWER);
    const project = (await discover()).find((pkg) => pkg.id === "claude-project");
    expect(project?.agents).toMatchObject([{ name: "reviewer" }]);
  });
});

describe("naxAgentsDir", () => {
  test("AC-9 appends agents to the NAX_GLOBAL_CONFIG_DIR override", () => {
    expect(naxAgentsDir({ NAX_GLOBAL_CONFIG_DIR: "/g" })).toBe("/g/agents");
  });
});

describe("originLabel", () => {
  test("AC-8 labels the nax-user origin", () => {
    expect(originLabel({ kind: "nax-user" })).toBe("nax-user");
  });
});

describe("loadResourceCatalog nax user agents", () => {
  test("AC-4 an agent under <NAX_GLOBAL_CONFIG_DIR>/agents has the nax-user origin", async () => {
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), HELPER);
    expect((await load()).findAgent("helper")?.origin.kind).toBe("nax-user");
  });

  test("AC-5 the nax-user package loads with resources.claudeCode disabled", async () => {
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), HELPER);
    expect((await load(false)).findAgent("helper")?.name).toBe("helper");
  });

  test("AC-6 no agents directory under NAX_GLOBAL_CONFIG_DIR yields no nax-user package", async () => {
    const catalog = await load();
    expect(catalog.packages.map((pkg) => pkg.id)).not.toContain("nax-user");
  });

  test("AC-7 a repo agent wins a name clash with the nax-user agent", async () => {
    await Bun.write(join(repoRoot, ".claude/agents/helper.md"), HELPER);
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), HELPER);
    expect((await load()).findAgent("helper")?.origin.kind).toBe("claude-project");
  });

  test("AC-18 an absent agents directory adds no diagnostic for it", async () => {
    const catalog = await load();
    expect(catalog.diagnostics.filter((entry) => entry.path.includes("agents"))).toEqual([]);
  });

  test("AC-19 a malformed agent file keeps its diagnostic on the nax-user origin", async () => {
    await Bun.write(join(naxGlobalDir, "agents/broken.md"), MALFORMED);
    const catalog = await load();
    const path = join(naxGlobalDir, "agents/broken.md");
    expect(catalog.packages.find((pkg) => pkg.id === "nax-user")?.agents).toEqual([]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", path, origin: { kind: "nax-user" } }),
    );
  });

  test("packages order nax-user after claude-project and before claude-user", async () => {
    await Bun.write(join(naxGlobalDir, "agents/helper.md"), HELPER);
    await Bun.write(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": true } }));
    const installPath = join(dir, "plugin");
    await Bun.write(join(installPath, "skills/s/SKILL.md"), "---\ndescription: plugin fixture\n---\nBody");
    await Bun.write(
      join(claudeDir, "plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "p@m": [{ scope: "user", installPath }] } }),
    );
    expect((await load()).packages.map((pkg) => pkg.id)).toEqual(["claude-project", "nax-user", "claude-user", "p@m"]);
  });
});
