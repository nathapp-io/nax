import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "../../../test/helpers";
import { RulesFrontmatterError, parseFrontmatter } from "../../../src/context/rules/rules-frontmatter";
import { loadCanonicalRules } from "../../../src/context/rules/canonical-loader";
import { _rulesCLIDeps, rulesExportCommand, rulesMigrateCommand } from "../../../src/cli/rules";

// ═════════════════════════════════════════════════════════════════════════════
// US-001 — `description` frontmatter field: parsing + validation (AC-1..AC-9)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-001: description frontmatter parsing", () => {
  test("AC-1: parseFrontmatter returns description strictly equal to the declared value", () => {
    const raw = "---\ndescription: Use when editing controllers\n---\n\nrule body";
    const result = parseFrontmatter(raw, "rule.md");
    expect(result.description).toBe("Use when editing controllers");
  });

  test("AC-2: parseFrontmatter trims leading/trailing whitespace from description", () => {
    const raw = '---\ndescription: "  trimmed value  "\n---\n\nrule body';
    const result = parseFrontmatter(raw, "rule.md");
    expect(result.description).toBe("trimmed value");
  });

  test("AC-3: parseFrontmatter throws RulesFrontmatterError when description is not a string", () => {
    const raw = "---\ndescription: 42\n---\n\nrule body";
    expect(() => parseFrontmatter(raw, "rule.md")).toThrow(RulesFrontmatterError);
    try {
      parseFrontmatter(raw, "rule.md");
      throw new Error("expected parseFrontmatter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RulesFrontmatterError);
      expect((err as RulesFrontmatterError).message).toContain("frontmatter.description must be a string");
    }
  });

  test("AC-4: parseFrontmatter throws RulesFrontmatterError when description is empty or whitespace-only", () => {
    const emptyRaw = '---\ndescription: ""\n---\n\nrule body';
    const whitespaceRaw = '---\ndescription: "   "\n---\n\nrule body';

    for (const raw of [emptyRaw, whitespaceRaw]) {
      try {
        parseFrontmatter(raw, "rule.md");
        throw new Error("expected parseFrontmatter to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RulesFrontmatterError);
        expect((err as RulesFrontmatterError).message).toContain("frontmatter.description cannot be empty");
      }
    }
  });

  test("AC-5: parseFrontmatter throws RulesFrontmatterError when description spans multiple lines", () => {
    const raw = '---\ndescription: "line1\\nline2"\n---\n\nrule body';
    try {
      parseFrontmatter(raw, "rule.md");
      throw new Error("expected parseFrontmatter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RulesFrontmatterError);
      expect((err as RulesFrontmatterError).message).toContain("frontmatter.description must be a single line");
    }
  });

  test("AC-6: parseFrontmatter lists description as a recognised frontmatter key in its unknown-key error", () => {
    const raw = "---\nscope: read\n---\n\nrule body";
    try {
      parseFrontmatter(raw, "rule.md");
      throw new Error("expected parseFrontmatter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RulesFrontmatterError);
      expect((err as RulesFrontmatterError).message).toContain("description");
    }
  });

  test("AC-7: parseFrontmatter omits description from the result when not declared, and does not throw", () => {
    const raw = "---\npaths:\n  - '*.js'\n---\n\nrule body";
    const result = parseFrontmatter(raw, "rule.md");
    expect(result.description).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "description")).toBe(false);
  });

  test("AC-8: loadCanonicalRules surfaces description from a .nax/rules/*.md frontmatter file", async () => {
    await withTempDir(async (workdir) => {
      const rulesDir = join(workdir, ".nax", "rules");
      await mkdir(rulesDir, { recursive: true });
      await Bun.write(
        join(rulesDir, "test.md"),
        "---\ndescription: My rule description\n---\n\nRule content.",
      );

      const rules = await loadCanonicalRules(workdir);
      expect(rules[0]?.description).toBe("My rule description");
    });
  });

  test("AC-9: rulesMigrateCommand preserves description through .claude/rules -> .nax/rules migration", async () => {
    await withTempDir(async (workdir) => {
      const legacyDir = join(workdir, ".claude", "rules");
      await mkdir(legacyDir, { recursive: true });
      await Bun.write(
        join(legacyDir, "legacy.md"),
        "---\ndescription: Legacy desc\npaths:\n  - '*.js'\n---\n\nLegacy rule body.",
      );

      await rulesMigrateCommand({ dir: workdir });

      const rules = await loadCanonicalRules(workdir);
      expect(rules[0]?.description).toBe("Legacy desc");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-002 — `description` in the Claude rules export (AC-10..AC-16)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-002: description in rulesExportCommand (Claude) output", () => {
  const written: Record<string, string> = {};
  const warnings: Array<{ msg: string; data: unknown }> = [];

  let origWriteFile: typeof _rulesCLIDeps.writeFile;
  let origGlobInDir: typeof _rulesCLIDeps.globInDir;
  let origMkdir: typeof _rulesCLIDeps.mkdir;
  let origLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
  let origGetLogger: typeof _rulesCLIDeps.getLogger;

  beforeEach(() => {
    origWriteFile = _rulesCLIDeps.writeFile;
    origGlobInDir = _rulesCLIDeps.globInDir;
    origMkdir = _rulesCLIDeps.mkdir;
    origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;
    origGetLogger = _rulesCLIDeps.getLogger;

    for (const key of Object.keys(written)) delete written[key];
    warnings.length = 0;

    _rulesCLIDeps.writeFile = async (path: string, content: string): Promise<void> => {
      written[path] = content;
    };
    _rulesCLIDeps.globInDir = () => [];
    _rulesCLIDeps.mkdir = async () => {};
    _rulesCLIDeps.getLogger = () =>
      ({
        warn: (_stage: string, msg: string, data?: Record<string, unknown>) => warnings.push({ msg, data }),
        info: () => {},
        debug: () => {},
        error: () => {},
      }) as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;
  });

  afterEach(() => {
    _rulesCLIDeps.writeFile = origWriteFile;
    _rulesCLIDeps.globInDir = origGlobInDir;
    _rulesCLIDeps.mkdir = origMkdir;
    _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
    _rulesCLIDeps.getLogger = origGetLogger;
  });

  async function exportOne(rule: Record<string, unknown>): Promise<string> {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "r.md", content: "Body.", ...rule } as never,
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    return written["/project/.claude/rules/r.md"] ?? "";
  }

  test("AC-10: description appears before paths in the generated frontmatter", async () => {
    const content = await exportOne({
      description: "Use when editing OAuth controllers",
      appliesTo: ["src/**/*.ts"],
    });

    const descIdx = content.indexOf('description: "Use when editing OAuth controllers"');
    const pathsIdx = content.indexOf("paths:");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(pathsIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeLessThan(pathsIdx);
  });

  test("AC-11: description-only rule (no appliesTo, no packageScope) emits a frontmatter block without paths", async () => {
    const content = await exportOne({ description: "Admin-only rule" });

    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain('description: "Admin-only rule"');
    expect(content).not.toContain("paths:");
    expect(content.indexOf("---", 3)).toBeGreaterThan(0);
  });

  test("AC-12: description + packageScope (no appliesTo) emits description and a translated file glob under paths", async () => {
    const content = await exportOne({
      description: "API rules",
      paths: ["packages/api/**"],
    });

    expect(content).toContain('description: "API rules"');
    expect(content).toContain("paths:");
    expect(content).toContain("packages/api/**");
  });

  test("AC-13: rule with no description, no appliesTo, no packageScope emits no frontmatter block", async () => {
    const content = await exportOne({});
    expect(content.startsWith("---")).toBe(false);
  });

  test("AC-14: description with colon/hash/quote/backslash round-trips through YAML unescaped", async () => {
    const original = 'status: ok # note "quote"\\';
    const content = await exportOne({
      description: original,
      appliesTo: ["src/**/*.ts"],
    });

    const first = content.indexOf("---");
    const second = content.indexOf("---", first + 3);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);

    const block = content.slice(first + 3, second);
    const parsed = Bun.YAML.parse(block) as Record<string, unknown>;
    expect(parsed.description).toBe(original);
  });

  test("AC-15: both-scopes warning's structured data includes the rule's description", async () => {
    await exportOne({
      description: "Shared rule",
      appliesTo: ["src/**/*.ts"],
      paths: ["packages/shared/**"],
    });

    const warning = warnings.find(
      (w) =>
        typeof w.data === "object" &&
        w.data !== null &&
        "keptAppliesTo" in (w.data as Record<string, unknown>) &&
        "droppedPaths" in (w.data as Record<string, unknown>),
    );
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown>).description).toBe("Shared rule");
  });

  test("AC-16: appliesTo without description emits paths but no description key", async () => {
    const content = await exportOne({ appliesTo: ["src/**/*.ts"] });

    expect(content).toContain("paths:");
    expect(content).toContain("src/**/*.ts");
    expect(content).not.toContain("description:");
  });
});