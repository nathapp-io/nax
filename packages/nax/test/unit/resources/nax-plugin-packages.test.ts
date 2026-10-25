import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import * as resources from "@/resources";

describe("naxPluginPackages", () => {
  test("AC-11 creates a nax-plugin package; AC-12 qualifies skill names", async () => {
    await withTempDir(async (root) => {
      await Bun.write(join(root, "skills/s/SKILL.md"), "---\ndescription: Skill s\n---\nSkill body");
      const packages = await resources.naxPluginPackages([{ plugin: "kit", skills: join(root, "skills") }]);
      expect(packages).toHaveLength(1);
      expect(packages[0]).toMatchObject({ id: "nax:kit", origin: { kind: "nax-plugin", plugin: "kit" }, root });
      expect(packages[0].skills).toHaveLength(1);
      expect(packages[0].skills[0]).toMatchObject({
        name: "s",
        qualifiedName: "kit:s",
        origin: { kind: "nax-plugin", plugin: "kit" },
      });
    });
  });
  test("AC-13 missing skills directory is quiet", async () => {
    await withTempDir(async (root) => {
      const packages = await resources.naxPluginPackages([{ plugin: "kit", skills: join(root, "missing") }]);
      expect(packages).toHaveLength(1);
      expect(packages[0].skills).toEqual([]);
      expect(packages[0].diagnostics).toEqual([]);
    });
  });
  test("scans declared commands and agents only, keeps order and diagnostics", async () => {
    await withTempDir(async (root) => {
      await Bun.write(join(root, "cmds/c.md"), "Command template");
      await Bun.write(join(root, "agents/a.md"), "---\nname: a\ndescription: Agent a\n---\nInstructions");
      await Bun.write(join(root, "agents/bad.md"), "Missing description");
      await Bun.write(join(root, "skills/ignored/SKILL.md"), "---\ndescription: Undeclared\n---\nIgnore");
      const packages = await resources.naxPluginPackages([
        { plugin: "kit", commands: join(root, "cmds"), agents: join(root, "agents") },
        { plugin: "empty" },
      ]);
      expect(packages.map((pkg) => pkg.id)).toEqual(["nax:kit", "nax:empty"]);
      expect(packages[0].commands.map((command) => command.qualifiedName)).toEqual(["kit:c"]);
      expect(packages[0].agents.map((agent) => agent.qualifiedName)).toEqual(["kit:a"]);
      expect(packages[0].skills).toEqual([]);
      expect(packages[0].diagnostics).toEqual([
        expect.objectContaining({ severity: "error", path: join(root, "agents/bad.md") }),
      ]);
      expect(packages[0].hooks).toEqual([]);
      expect(packages[0].mcpServers).toEqual([]);
      expect(packages[1].diagnostics).toEqual([]);
    });
  });
});
