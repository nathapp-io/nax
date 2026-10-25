import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import * as resources from "@/resources";
import { _resourceFsDeps } from "@/resources/scan-dirs";

const skill = "---\ndescription: fixture skill\n---\nBody";
const originalDeps = { ..._resourceFsDeps };
let dir: string;
let repoRoot: string;
let claudeDir: string;
const discover = () => resources.discoverClaudeCodePackages({ repoRoot, claudeDir });
const put = (path: string, data: unknown) => Bun.write(path, typeof data === "string" ? data : JSON.stringify(data));
const enable = (entries: Record<string, boolean>) => put(join(claudeDir, "settings.json"), { enabledPlugins: entries });
const registry = (plugins: Record<string, unknown>, version = 2) =>
  put(join(claudeDir, "plugins/installed_plugins.json"), { version, plugins });
async function install(key = "sp@m", options: { scope?: string; projectPath?: string; manifest?: boolean } = {}) {
  const installPath = join(dir, key);
  await put(join(installPath, "skills/brainstorming/SKILL.md"), skill);
  if (options.manifest !== false) await put(join(installPath, ".claude-plugin/plugin.json"), { name: "superpowers" });
  return { scope: options.scope ?? "user", projectPath: options.projectPath, installPath };
}
beforeEach(() => {
  dir = makeTempDir();
  repoRoot = join(dir, "repo");
  claudeDir = join(dir, "claude");
});
afterEach(() => {
  Object.assign(_resourceFsDeps, originalDeps);
  cleanupTempDir(dir);
});

describe("discoverClaudeCodePackages", () => {
  test.each([
    ["missing install", '{"version":2,"plugins":{}}', "plugin missing@m is enabled but not installed"],
    ["malformed registry", "not JSON", "installed_plugins.json"],
    ["missing registry", undefined, "Missing installed_plugins.json"],
  ])("listings expose discovery diagnostics for %s", async (_name, contents, message) => {
    await enable({ "missing@m": true });
    if (contents !== undefined) await put(join(claudeDir, "plugins/installed_plugins.json"), contents);
    const catalog = resources.buildResourceCatalog(await discover());
    expect(catalog.packages).toHaveLength(2);
    expect(resources.formatPluginsListing(catalog, [])).toContain(message);
    expect(resources.formatSkillsListing(catalog)).toContain(message);
  });
  test("listings expose inaccessible installs and do not duplicate loaded-plugin diagnostics", async () => {
    await enable({ "missing@m": true, "sp@m": true });
    const record = await install();
    await put(join(record.installPath, ".claude-plugin/plugin.json"), "invalid JSON");
    await registry({ "missing@m": [{ scope: "user", installPath: join(dir, "absent") }], "sp@m": [record] });
    const catalog = resources.buildResourceCatalog(await discover());
    for (const listing of [resources.formatPluginsListing(catalog, []), resources.formatSkillsListing(catalog)]) {
      expect(listing).toContain("Cannot access plugin missing@m installPath");
    }
    const warning = catalog.packages[2]?.diagnostics[0]?.message;
    expect(warning).toBeDefined();
    expect(resources.formatPluginsListing(catalog, []).split(warning ?? "unexpected")).toHaveLength(2);
  });
  test("loads project hooks and agents and plugin agents, MCP and hooks", async () => {
    await put(join(repoRoot, ".claude/settings.json"), { hooks: { PreToolUse: [] } });
    await put(join(repoRoot, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\n");
    await enable({ "sp@m": true });
    const record = await install();
    await put(join(record.installPath, "agents/checker.md"), "---\nname: checker\ndescription: checks\n---\n");
    await put(join(record.installPath, ".mcp.json"), { mcpServers: { remote: { type: "http", url: "https://h" } } });
    await put(join(record.installPath, "hooks/hooks.json"), { hooks: { Stop: [] } });
    await registry({ "sp@m": [record] });
    const packages = await discover();
    expect(packages[0]).toMatchObject({ agents: [{ name: "reviewer" }], hooks: [{ events: ["PreToolUse"] }] });
    expect(packages[2]).toMatchObject({
      agents: [{ qualifiedName: "superpowers:checker" }],
      mcpServers: [{ name: "remote", transport: "http", scope: "plugin" }],
      hooks: [{ events: ["Stop"] }],
      diagnostics: [],
    });
  });
  test("first user install wins even after matching project records", async () => {
    await enable({ "sp@m": true });
    const project = await install("project", { scope: "project", projectPath: repoRoot });
    const first = await install("first");
    await registry({ "sp@m": [project, first, await install("second")] });
    expect((await discover())[2]?.root).toBe(first.installPath);
  });
  test("invalid project settings does not suppress user plugins or project resources", async () => {
    await enable({ "sp@m": true });
    await put(join(repoRoot, ".claude/settings.json"), "not JSON");
    await put(join(repoRoot, ".claude/skills/p/SKILL.md"), skill);
    await registry({ "sp@m": [await install()] });
    const packages = await discover();
    expect(packages.map((p) => p.id)).toEqual(["claude-project", "claude-user", "sp@m"]);
    expect(packages[0]).toMatchObject({
      skills: [{ name: "p" }],
      hooks: [],
      diagnostics: [{ severity: "error", origin: { kind: "claude-project" } }],
    });
  });
  test.each(["not JSON", "[]", '{"name":42}'])(
    "malformed manifest %s falls back without dropping plugin",
    async (manifest) => {
      await enable({ "sp@m": true });
      const record = await install();
      await put(join(record.installPath, ".claude-plugin/plugin.json"), manifest);
      await registry({ "sp@m": [record] });
      const pkg = (await discover())[2];
      expect(pkg?.skills[0]?.qualifiedName).toBe("sp:brainstorming");
      expect(pkg?.diagnostics).toHaveLength(manifest === '{"name":42}' ? 0 : 1);
    },
  );
  test("read failures are diagnosed through the seam without losing resources", async () => {
    await put(join(claudeDir, "skills/u/SKILL.md"), skill);
    _resourceFsDeps.readFile = async (path) => {
      if (path === join(claudeDir, "settings.json")) throw new Error("read denied");
      return originalDeps.readFile(path);
    };
    const pkg = (await discover())[1];
    expect(pkg?.skills[0]?.name).toBe("u");
    expect(pkg?.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("read denied") }),
    ]);
  });
  test("a file installPath warns and is skipped", async () => {
    await enable({ "sp@m": true });
    const installPath = join(dir, "file");
    await put(installPath, "not a directory");
    await registry({ "sp@m": [{ scope: "user", installPath }] });
    const packages = await discover();
    expect(packages).toHaveLength(2);
    expect(packages[1]?.diagnostics).toEqual([expect.objectContaining({ severity: "warn", path: installPath })]);
  });
  test("AC-1 project skills are in the first package", async () => {
    await put(join(repoRoot, ".claude/skills/p/SKILL.md"), skill);
    const packages = await discover();
    expect(packages.map((p) => p.id)).toEqual(["claude-project", "claude-user"]);
    expect(packages[0]).toMatchObject({ root: repoRoot, skills: [{ name: "p" }] });
  });
  test("AC-2 user skills load through the filesystem seam", async () => {
    await put(join(claudeDir, "skills/u/SKILL.md"), skill);
    const reads: string[] = [];
    _resourceFsDeps.readFile = async (path) => {
      reads.push(path);
      return originalDeps.readFile(path);
    };
    expect((await discover())[1]).toMatchObject({ root: claudeDir, skills: [{ name: "u" }] });
    expect(reads).toContain(join(claudeDir, "skills/u/SKILL.md"));
  });
  test("AC-3 user commands load", async () => {
    await put(join(claudeDir, "commands/c.md"), "Command body");
    expect((await discover())[1]?.commands).toMatchObject([{ name: "c", template: "Command body" }]);
  });
  test("AC-4 project MCP servers load", async () => {
    await put(join(repoRoot, ".mcp.json"), { mcpServers: { ctx: { command: "npx" } } });
    expect((await discover())[0]?.mcpServers).toMatchObject([{ name: "ctx", transport: "stdio", scope: "project" }]);
  });
  test("AC-5 user hooks load", async () => {
    await put(join(claudeDir, "settings.json"), { hooks: { Stop: [] } });
    expect((await discover())[1]?.hooks).toMatchObject([{ events: ["Stop"] }]);
  });
  test("AC-6 plugin manifest names qualify skills", async () => {
    await enable({ "sp@m": true });
    const record = await install();
    await registry({ "sp@m": [record] });
    expect((await discover())[2]).toMatchObject({
      id: "sp@m",
      root: record.installPath,
      origin: { kind: "claude-plugin", plugin: "superpowers", marketplace: "m" },
      skills: [{ qualifiedName: "superpowers:brainstorming" }],
    });
  });
  test("AC-7 manifestless plugins qualify commands with the key name", async () => {
    await enable({ "commit-commands@m": true });
    const record = await install("commit-commands@m", { manifest: false });
    await put(join(record.installPath, "commands/commit.md"), "Commit");
    await registry({ "commit-commands@m": [record] });
    expect((await discover())[2]?.commands).toMatchObject([{ qualifiedName: "commit-commands:commit" }]);
  });
  test("AC-8 project false disables user true", async () => {
    await enable({ "sp@m": true });
    await put(join(repoRoot, ".claude/settings.json"), { enabledPlugins: { "sp@m": false } });
    await registry({ "sp@m": [await install()] });
    expect((await discover()).map((p) => p.id)).toEqual(["claude-project", "claude-user"]);
  });
  test("AC-9 project enabled entries follow user entries", async () => {
    await enable({ "sp@m": true });
    await put(join(repoRoot, ".claude/settings.json"), { enabledPlugins: { "pp@m": true } });
    await registry({ "pp@m": [await install("pp@m")], "sp@m": [await install()] });
    expect((await discover()).map((p) => p.id)).toEqual(["claude-project", "claude-user", "sp@m", "pp@m"]);
  });
  test("AC-10 matching project install is the fallback", async () => {
    await enable({ "sp@m": true });
    const record = await install("sp@m", { scope: "project", projectPath: repoRoot });
    await registry({ "sp@m": [record] });
    expect((await discover())[2]?.root).toBe(record.installPath);
  });
  test.each([
    ["AC-11 wrong project install is ignored", "wrong-project"],
    ["AC-12 absent record warns", "absent"],
    ["AC-15 nonexistent install path warns", "missing-path"],
  ])("%s", async (_title, mode) => {
    await enable({ "sp@m": true });
    const record =
      mode === "missing-path"
        ? { scope: "user", installPath: join(dir, "missing") }
        : await install("sp@m", { scope: "project", projectPath: "/another/repo" });
    await registry(mode === "absent" ? {} : { "sp@m": [record] });
    const packages = await discover();
    expect(packages).toHaveLength(2);
    expect(packages.flatMap((p) => p.diagnostics)).toEqual([
      expect.objectContaining({
        severity: "warn",
        origin: { kind: "claude-plugin", plugin: "sp", marketplace: "m" },
        message: expect.stringContaining(mode === "missing-path" ? "installPath" : "is enabled but not installed"),
      }),
    ]);
  });
  test.each([
    ["AC-13 old registry version errors", JSON.stringify({ version: 1, plugins: {} })],
    ["AC-14 invalid registry JSON errors", "not JSON"],
    ["AC-17 missing registry warns", undefined],
  ])("%s", async (_title, text) => {
    await enable({ "sp@m": true });
    const path = join(claudeDir, "plugins/installed_plugins.json");
    if (text !== undefined) await put(path, text);
    const packages = await discover();
    expect(packages).toHaveLength(2);
    expect(packages.flatMap((p) => p.diagnostics)).toEqual([
      expect.objectContaining({
        path,
        origin: { kind: "claude-user" },
        severity: text === undefined ? "warn" : "error",
      }),
    ]);
  });
  test("AC-16 invalid user settings preserves skills but not hooks or enabled entries", async () => {
    await put(join(claudeDir, "settings.json"), '{"hooks": {"Stop": []}, "enabledPlugins": {"sp@m": true},');
    await put(join(claudeDir, "skills/u/SKILL.md"), skill);
    await registry({ "sp@m": [await install()] });
    const packages = await discover();
    expect(packages).toHaveLength(2);
    expect(packages[1]).toMatchObject({
      skills: [{ name: "u" }],
      hooks: [],
      diagnostics: [
        {
          severity: "error",
          origin: { kind: "claude-user" },
          path: join(claudeDir, "settings.json"),
          message: expect.any(String),
        },
      ],
    });
  });
});
