import { describe, expect, test } from "bun:test";
import {
  buildResourceCatalog,
  type CommandResource,
  type ResourceCatalog,
  type ResourcePackage,
  type SkillResource,
} from "@/resources";
import { COMMAND_DESCRIPTIONS, COMMANDS } from "@/tui/chat/slash-commands";
import { filterSlashMenu, type SlashMenuItem, slashMenuItems } from "@/tui/chat/slash-menu";

const ORIGIN = { kind: "claude-project" } as const;

function makeCommand(name: string, description: string): CommandResource {
  return {
    kind: "command",
    name,
    qualifiedName: name,
    description,
    template: `${name} $ARGUMENTS`,
    path: `/kit/${name}.md`,
    origin: ORIGIN,
  };
}

function makeSkill(name: string, description: string): SkillResource {
  return {
    kind: "skill",
    name,
    qualifiedName: name,
    description,
    body: "",
    baseDir: `/kit/${name}`,
    path: `/kit/${name}/SKILL.md`,
    modelInvocable: true,
    origin: ORIGIN,
  };
}

function makeCatalog(
  commands: readonly CommandResource[] = [],
  skills: readonly SkillResource[] = [],
): ResourceCatalog {
  const pkg: ResourcePackage = {
    id: "claude-project",
    origin: ORIGIN,
    root: "/kit",
    commands,
    skills,
    agents: [],
    mcpServers: [],
    hooks: [],
    diagnostics: [],
  };
  return buildResourceCatalog([pkg]);
}

const BUILTIN_COUNT = COMMANDS.length;

function names(items: readonly SlashMenuItem[]): readonly string[] {
  return items.map((item) => item.name);
}

describe("COMMAND_DESCRIPTIONS", () => {
  test("AC-1 describes every built-in command", () => {
    for (const name of COMMANDS) {
      expect(COMMAND_DESCRIPTIONS[name].trim()).not.toBe("");
    }
  });
});

describe("slashMenuItems", () => {
  const host = { catalog: makeCatalog([makeCommand("deploy", "Ship it")], [makeSkill("review", "Review code")]) };

  test("AC-2 lists the built-ins first, in COMMANDS order", () => {
    const items = slashMenuItems(host);
    expect(names(items).slice(0, BUILTIN_COUNT)).toEqual([...COMMANDS]);
    for (const item of items.slice(0, BUILTIN_COUNT)) expect(item.description.trim()).not.toBe("");
  });

  test("AC-3 describes a catalog command after the built-ins", () => {
    expect(slashMenuItems(host).at(BUILTIN_COUNT)).toEqual({ name: "deploy", description: "(command) Ship it" });
  });

  test("AC-4 describes a skill last", () => {
    expect(slashMenuItems(host).at(-1)).toEqual({ name: "review", description: "(skill) Review code" });
  });

  test("AC-5 a host without a catalog offers exactly the built-ins", () => {
    expect(names(slashMenuItems({}))).toEqual([...COMMANDS]);
  });

  test("sanitises catalog text and keeps each item on one row", () => {
    const esc = String.fromCharCode(27);
    const items = slashMenuItems({
      catalog: makeCatalog([makeCommand(`bad${esc}[31m`, `Ship${esc}[?1049lit\nnow`)], []),
    });
    expect(items.at(BUILTIN_COUNT)).toEqual({ name: "bad", description: "(command) Shipit now" });
  });
});

describe("filterSlashMenu", () => {
  const items = slashMenuItems({
    catalog: makeCatalog([makeCommand("deploy", "Ship it")], [makeSkill("review", "Review code")]),
  });

  test("AC-6 lists the names starting with the query first, in item order", () => {
    expect(names(filterSlashMenu(items, "/re") ?? []).slice(0, 2)).toEqual(["resume", "review"]);
  });

  test("AC-7 then lists the names containing the query elsewhere, in item order", () => {
    expect(names(filterSlashMenu(items, "/re") ?? []).slice(2)).toEqual(["feature"]);
  });

  test("AC-8 matches case-insensitively", () => {
    expect(filterSlashMenu(items, "/RE")).toHaveLength(3);
    expect(filterSlashMenu(items, "/RE")).toEqual(filterSlashMenu(items, "/re"));
  });

  test("AC-9 a bare slash keeps every item in item order", () => {
    expect(names(filterSlashMenu(items, "/") ?? [])).toEqual(names(items));
  });

  test("AC-10 an input with whitespace is not a menu query", () => {
    expect(filterSlashMenu(items, "/mode full")).toBeNull();
  });

  test("AC-11 an input that does not start with a slash is not a menu query", () => {
    expect(filterSlashMenu(items, "hello")).toBeNull();
  });

  test("AC-12 a query that matches nothing keeps no item", () => {
    expect(filterSlashMenu(items, "/zzz")).toEqual([]);
  });

  test("AC-13 an exact skill name outranks the built-in it prefixes", () => {
    const withSkill = slashMenuItems({ catalog: makeCatalog([], [makeSkill("skill", "Review code")]) });
    expect(names(filterSlashMenu(withSkill, "/skill") ?? []).slice(0, 2)).toEqual(["skill", "skills"]);
  });
});
