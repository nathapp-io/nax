/**
 * rules-frontmatter.ts — US-001 description field unit tests
 *
 * Covers the optional single-line `description` metadata carried by canonical
 * rules. Split from rules-frontmatter.test.ts to keep that file under the
 * 800-line file-size limit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _canonicalLoaderDeps, loadCanonicalRules } from "@/context/rules/canonical-loader";
import { KNOWN_FRONTMATTER_KEYS, RulesFrontmatterError, parseFrontmatter } from "@/context/rules/rules-frontmatter";
import { makeLogger } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// US-001: Canonical rules accept and carry an optional single-line description.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — US-001 description accepted", () => {
  test("[AC1] returns description equal to the declared value when frontmatter declares description: Use when editing controllers and a body", () => {
    const content = ["---", "description: Use when editing controllers", "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/ctrl.md");
    expect(result.description).toBe("Use when editing controllers");
  });

  test("[AC2] trims surrounding whitespace from the declared description value", () => {
    const content = ["---", "description:   Trimmed value   ", "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/trim.md");
    expect(result.description).toBe("Trimmed value");
  });

  test("[AC7] omits description from the result when frontmatter has no description key and does not throw", () => {
    const content = ["---", "priority: 50", "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/no-desc.md");
    expect(result.description).toBeUndefined();
    expect(() => result).not.toThrow();
  });
});

describe("parseFrontmatter — US-001 description validation", () => {
  test("[AC3] throws RulesFrontmatterError containing 'frontmatter.description must be a string' when description is numeric", () => {
    const content = ["---", "description: 42", "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/num-desc.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("frontmatter.description must be a string");
  });

  test("[AC4] throws RulesFrontmatterError containing 'frontmatter.description cannot be empty' when description is empty", () => {
    const content = ["---", 'description: ""', "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/empty-desc.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("frontmatter.description cannot be empty");
  });

  test("[AC4] throws RulesFrontmatterError containing 'frontmatter.description cannot be empty' when description is whitespace-only", () => {
    const content = ["---", 'description: "   "', "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/ws-desc.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("frontmatter.description cannot be empty");
  });

  test("[AC5] throws RulesFrontmatterError containing 'frontmatter.description must be a single line' when description contains a newline", () => {
    // YAML double-quoted strings parse `\n` as a literal newline in the value,
    // so this exercises the single-line rule against an actually-newline-bearing
    // string rather than tripping the YAML parser on the literal newline.
    const content = ["---", 'description: "line one\\nline two"', "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/multi-desc.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("frontmatter.description must be a single line");
  });
});

describe("parseFrontmatter — US-001 description recognised in unknown-key diagnostics", () => {
  test("[AC6] throws RulesFrontmatterError naming description among the recognised keys when an unrecognised scope key is present", () => {
    const content = ["---", "scope: everywhere", "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/bad-scope.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("description");
  });

  test("[AC6] KNOWN_FRONTMATTER_KEYS includes 'description'", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("description")).toBe(true);
  });
});

describe("loadCanonicalRules — US-001 description propagation", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
    _canonicalLoaderDeps.getLogger = () => makeLogger();
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  test("[AC8] returns a CanonicalRule whose description equals the declared value when its disk rule declares description", async () => {
    const filePath = "/project/.nax/rules/ctrl.md";
    _canonicalLoaderDeps.globInDir = () => [filePath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === filePath) {
        return ["---", "description: Use when editing controllers", "---", "", "Body."].join("\n");
      }
      throw new Error(`unexpected file: ${p}`);
    };

    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.description).toBe("Use when editing controllers");
  });
});
