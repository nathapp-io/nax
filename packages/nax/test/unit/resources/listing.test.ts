import { describe, expect, test } from "bun:test";
import * as resources from "@/resources";
import { buildResourceCatalog, type ResourceOrigin, type ResourcePackage, type SkillResource } from "@/resources";

const origins: ResourceOrigin[] = [
  { kind: "claude-project" },
  { kind: "claude-user" },
  { kind: "claude-plugin", plugin: "superpowers", marketplace: "m" },
  { kind: "nax-plugin", plugin: "kit" },
];
const skills: SkillResource[] = origins.map((origin, i) => ({
  kind: "skill",
  name: `s${i}`,
  qualifiedName: `qualified${i}`,
  description: "",
  body: "",
  baseDir: `/s${i}`,
  path: `/s${i}/SKILL.md`,
  modelInvocable: true,
  origin,
}));
const origin: ResourceOrigin = { kind: "claude-plugin", plugin: "sp", marketplace: "m" };
const pkg: ResourcePackage = {
  id: "sp@m",
  origin,
  root: "/sp",
  skills: skills.slice(0, 1),
  commands: [],
  agents: ["a", "b"].map((name) => ({
    kind: "agent",
    name,
    qualifiedName: name,
    description: "",
    path: `/sp/${name}.md`,
    origin,
  })),
  mcpServers: [{ kind: "mcp", name: "server", transport: "stdio", path: "/sp/.mcp.json", origin }],
  hooks: [{ kind: "hooks", events: ["Start", "Stop"], path: "/sp/hooks.json", origin }],
  diagnostics: [{ severity: "warn", path: "/sp/plugin.json", message: "plugin warning", origin }],
};

describe("formatSkillsListing", () => {
  test("US-015 AC-1/2 lists qualified names, all four origin labels and paths", () => {
    const catalog = buildResourceCatalog([{ ...pkg, skills, diagnostics: [] }]);
    expect(resources.formatSkillsListing(catalog)).toBe(
      [
        "qualified0  project  /s0/SKILL.md",
        "qualified1  user  /s1/SKILL.md",
        "qualified2  plugin superpowers  /s2/SKILL.md",
        "qualified3  nax-plugin kit  /s3/SKILL.md",
      ].join("\n"),
    );
  });
  test("US-015 AC-3 appends only SKILL.md diagnostics after skills", () => {
    const catalog = buildResourceCatalog([
      {
        ...pkg,
        diagnostics: [
          ...pkg.diagnostics,
          { severity: "error", path: "/bad/SKILL.md", message: "bad skill", origin },
          { severity: "warn", path: "/other/SKILL.md", message: "other skill", origin },
          { severity: "warn", path: "/NOTSKILL.md", message: "not a skill", origin },
        ],
      },
    ]);
    expect(resources.formatSkillsListing(catalog)).toBe(
      "qualified0  project  /s0/SKILL.md\nerror  /bad/SKILL.md  bad skill\nwarn  /other/SKILL.md  other skill",
    );
  });
});
describe("formatPluginsListing", () => {
  test("US-015 AC-4/5 lists package counts, deferred capabilities, diagnostics and nax extensions", () => {
    expect(
      resources.formatPluginsListing(buildResourceCatalog([pkg]), [
        { name: "kit", provides: ["resources", "loop-handlers"] },
      ]),
    ).toBe(
      "Claude Code plugins\nsp@m  skills 1, commands 0, agents 2 (not delivered yet), mcp 1 (not delivered yet), hooks 1 (not executed)\nwarn  /sp/plugin.json  plugin warning\n\nnax plugins\nkit  resources, loop-handlers",
    );
  });
  test("US-015 AC-6 non-Claude packages do not populate Claude section", () => {
    expect(
      resources.formatPluginsListing(
        buildResourceCatalog([{ ...pkg, origin: { kind: "nax-plugin", plugin: "kit" } }]),
        [],
      ),
    ).toBe("Claude Code plugins\n(none)\n\nnax plugins\n(none)");
  });
});
