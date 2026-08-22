/**
 * rules-frontmatter.ts — unit tests
 *
 * Covers parseFrontmatter and RulesFrontmatterError from the split.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _canonicalLoaderDeps, loadCanonicalRules } from "@/context/rules/canonical-loader";
import {
  FRONTMATTER_PRIORITY_DEFAULT,
  KNOWN_FRONTMATTER_KEYS,
  RulesFrontmatterError,
  parseFrontmatter,
} from "@/context/rules/rules-frontmatter";
import { makeLogger } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// AC1: parseFrontmatter() returns priority 100 when content has no frontmatter block
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC1", () => {
  test("[AC1] returns priority 100 when supplied content has no frontmatter block", () => {
    const result = parseFrontmatter("## Coding Style\n\nUse async/await.", "/project/.nax/rules/style.md");
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.priority).toBe(100);
  });

  test("[AC1] returns the raw content unchanged when no frontmatter", () => {
    const content = "## Coding Style\n\nUse async/await.";
    const result = parseFrontmatter(content, "/project/.nax/rules/style.md");
    expect(result.content).toBe(content);
  });

  test("[AC1] priority 100 is the FRONTMATTER_PRIORITY_DEFAULT constant", () => {
    expect(FRONTMATTER_PRIORITY_DEFAULT).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: parseFrontmatter() throws RulesFrontmatterError when file opens with --- and has no closing ---
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC4", () => {
  test("[AC4] throws RulesFrontmatterError when a rule file opens with --- and has no closing ---", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npriority: 50\n", "/project/.nax/rules/bad.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("missing closing '---'");
    expect((threw as RulesFrontmatterError).context?.filePath).toBe("/project/.nax/rules/bad.md");
  });

  // BUG-03: the compact empty frontmatter block ("---\n---\n", no blank line between
  // the delimiters) previously failed to match the closing-delimiter regex (which
  // requires a line break both after the opening '---' and before the closing '---')
  // and was rejected as "missing closing '---'". It is now treated as an empty
  // frontmatter document — no error, default priority, empty body.
  test("[AC4/BUG-03] a compact empty frontmatter block ('---\\n---\\n') parses as no-op frontmatter, not an error", () => {
    const result = parseFrontmatter("---\n---\n", "/project/.nax/rules/empty.md");
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.content).toBe("");
  });

  // Review follow-up: the compact-empty-block probe must require a real line end
  // after the closing '---', or a document whose second line is a longer dash rule
  // ("---\n----") gets silently truncated instead of parsed.
  test("[AC4/BUG-03] a longer dash rule on line 2 is not mistaken for an empty frontmatter block", () => {
    // The compact-empty-block probe must require a real line end after the
    // closing '---'. Without that, "---\n------\n..." matches the probe's first
    // six characters and the body is silently truncated to "-\n...". Falling
    // through to the normal "missing closing '---'" error is the correct
    // outcome (loadCanonicalRules catches it per-file and skips) — silent
    // content corruption is not.
    expect(() => parseFrontmatter("---\n------\nRule body text.", "/project/.nax/rules/rule.md")).toThrow(
      /missing closing/,
    );
  });

  test("[AC4/BUG-03] a body still follows a compact empty frontmatter block", () => {
    const result = parseFrontmatter("---\n---\nRule body text.", "/project/.nax/rules/empty-body.md");
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.content).toBe("Rule body text.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_FRONTMATTER_KEYS
// ─────────────────────────────────────────────────────────────────────────────

describe("KNOWN_FRONTMATTER_KEYS", () => {
  test("contains priority, paths, and appliesTo", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("priority")).toBe(true);
    expect(KNOWN_FRONTMATTER_KEYS.has("paths")).toBe(true);
    expect(KNOWN_FRONTMATTER_KEYS.has("appliesTo")).toBe(true);
  });

  test("does not contain unknown keys", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("scope")).toBe(false);
    expect(KNOWN_FRONTMATTER_KEYS.has("roles")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFrontmatter — general behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses priority from frontmatter", () => {
    const result = parseFrontmatter("---\npriority: 35\n---\nRule content.", "/project/.nax/rules/test.md");
    expect(result.priority).toBe(35);
  });

  test("parses paths as array from frontmatter", () => {
    const result = parseFrontmatter('---\npaths:\n  - "apps/api"\n---\nRule content.', "/project/.nax/rules/test.md");
    expect(result.paths).toEqual(["apps/api"]);
  });

  test("parses paths as string from frontmatter", () => {
    const result = parseFrontmatter('---\npaths: "apps/api"\n---\nRule content.', "/project/.nax/rules/test.md");
    expect(result.paths).toEqual(["apps/api"]);
  });

  test("throws RulesFrontmatterError for unknown frontmatter keys", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npriority: 50\nunknownKey: value\n---\nRule content.", "/project/.nax/rules/test.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("unknown key(s)");
  });

  test("handles CRLF line endings", () => {
    const result = parseFrontmatter("---\r\npriority: 50\r\n---\r\nRule content.\r\n", "/project/.nax/rules/test.md");
    expect(result.priority).toBe(50);
  });

  test("strips frontmatter and returns body content", () => {
    const result = parseFrontmatter("---\npriority: 50\n---\nRule body.", "/project/.nax/rules/test.md");
    expect(result.content).toBe("Rule body.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RulesFrontmatterError
// ─────────────────────────────────────────────────────────────────────────────

describe("RulesFrontmatterError", () => {
  test("has correct error code", () => {
    const error = new RulesFrontmatterError("test error", "/path/to/file.md");
    expect(error.code).toBe("RULES_FRONTMATTER_INVALID");
  });

  test("includes filePath in context", () => {
    const error = new RulesFrontmatterError("test error", "/path/to/file.md");
    expect(error.context?.filePath).toBe("/path/to/file.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: parseFrontmatter() returns stages ["execution", "review"] for YAML list
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC1 stages list parsing", () => {
  test("[AC1] returns stages ['execution', 'review'] from a YAML list", () => {
    const content = ["---", "stages:", '  - "execution"', '  - "review"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/multi.md");
    expect(result.stages).toEqual(["execution", "review"]);
  });

  test("[AC1] returns stages as a string[] (not e.g. object/Set)", () => {
    const content = ["---", "stages:", '  - "plan"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/plan.md");
    expect(Array.isArray(result.stages)).toBe(true);
    expect(result.stages?.[0]).toBe("plan");
  });

  test("[AC1] a single-element stages list round-trips", () => {
    const content = ["---", "stages:", '  - "execution"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/exec.md");
    expect(result.stages).toEqual(["execution"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: stages undefined when stages key absent
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC2 stages absent", () => {
  test("[AC2] returns stages undefined when the stages key is absent", () => {
    const content = ["---", "priority: 50", "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/no-stages.md");
    expect(result.stages).toBeUndefined();
  });

  test("[AC2] returns stages undefined when there is no frontmatter at all", () => {
    const result = parseFrontmatter("Just body content, no frontmatter.", "/project/.nax/rules/plain.md");
    expect(result.stages).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: stages undefined when stages is empty list
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC3 stages empty list", () => {
  test("[AC3] returns stages undefined when stages is an empty YAML list", () => {
    const content = ["---", "stages: []", "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/empty-stages.md");
    expect(result.stages).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: throws RulesFrontmatterError when stages contains a non-string entry
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC4 stages type validation", () => {
  test("[AC4] throws RulesFrontmatterError when stages contains a non-string entry", () => {
    const content = ["---", "stages:", '  - "execution"', "  - 7", "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/bad-stages.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("stages");
    expect((threw as RulesFrontmatterError).context?.filePath).toBe("/project/.nax/rules/bad-stages.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: does not throw unknown-key error when stages is the only frontmatter key
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC5 stages is a known key", () => {
  test("[AC5] does not throw unknown-key RulesFrontmatterError when stages is the only key", () => {
    const content = ["---", "stages:", '  - "execution"', "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/stages-only.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });

  test("[AC5] KNOWN_FRONTMATTER_KEYS includes 'stages'", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("stages")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: throws RulesFrontmatterError naming the offending key
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC6 unknown key", () => {
  test("[AC6] throws RulesFrontmatterError naming the offending key when a rule declares a key other than priority/paths/appliesTo/stages", () => {
    const content = ["---", "stages:", '  - "execution"', "scope: everywhere", "---", "", "Body."].join("\n");
    let threw: unknown;
    try {
      parseFrontmatter(content, "/project/.nax/rules/bad-key.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("scope");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: parseFrontmatter warns on unknown stage names; stages retained
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC8 unknown stage warning", () => {
  test("[AC8] returns a warning naming 'not-a-real-stage' and retains stages ['not-a-real-stage']", () => {
    const content = ["---", "stages:", '  - "not-a-real-stage"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/unknown-stage.md");
    expect(result.stages).toEqual(["not-a-real-stage"]);
    expect(result.warnings.some((w) => w.includes("not-a-real-stage"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: empty warnings list for known stage
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC9 known stage no warning", () => {
  test("[AC9] returns an empty warnings list for stages: ['acceptance-setup']", () => {
    const content = ["---", "stages:", '  - "acceptance-setup"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/known-stage.md");
    expect(result.warnings).toEqual([]);
  });

  test("[AC9] returns an empty warnings list for stages: ['decompose'], a real pipeline stage (decomposeOp.name)", () => {
    const content = ["---", "stages:", '  - "decompose"', "---", "", "Body."].join("\n");
    const result = parseFrontmatter(content, "/project/.nax/rules/decompose-stage.md");
    expect(result.warnings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: BOM + --- emits displaced-frontmatter warning
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC10 BOM displaced frontmatter", () => {
  test("[AC10] returns a displaced-frontmatter warning when content begins with a UTF-8 BOM followed by ---", () => {
    const content = "\uFEFF---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, "/project/.nax/rules/bom.md");
    expect(result.warnings.some((w) => /displaced|BOM|first line/i.test(w))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: blank line + --- emits displaced-frontmatter warning
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC11 leading blank line displaced frontmatter", () => {
  test("[AC11] returns a displaced-frontmatter warning when content begins with a blank line followed by ---", () => {
    const content = "\n---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, "/project/.nax/rules/leading-blank.md");
    expect(result.warnings.some((w) => /displaced|blank|first line/i.test(w))).toBe(true);
  });

  test("[AC11] returns a displaced-frontmatter warning when content begins with a CRLF blank line followed by ---", () => {
    const content = "\r\n---\r\npriority: 100\r\n---\r\nBody.";
    const result = parseFrontmatter(content, "/project/.nax/rules/leading-blank-crlf.md");
    expect(result.warnings.some((w) => /displaced|blank|first line/i.test(w))).toBe(true);
    expect(result.priority).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: displaced frontmatter still parses priority and paths
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC12 displaced frontmatter still parses", () => {
  test("[AC12] returns priority 100 and paths undefined when a frontmatter block is preceded by a blank line", () => {
    const content = "\n---\n---\nBody.";
    const result = parseFrontmatter(content, "/project/.nax/rules/blank-no-prio.md");
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.priority).toBe(100);
    expect(result.paths).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: loadCanonicalRules propagates stages ["plan"] from disk rule
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — AC7 stages propagation", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
    _canonicalLoaderDeps.getLogger = () =>
      ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }) as unknown as ReturnType<
        typeof _canonicalLoaderDeps.getLogger
      >;
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  test("[AC7] returns a CanonicalRule with stages ['plan'] when its disk rule declares that value", async () => {
    const filePath = "/project/.nax/rules/plan-rule.md";
    _canonicalLoaderDeps.globInDir = () => [filePath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === filePath) {
        return ["---", "stages:", '  - "plan"', "---", "", "Plan-stage body."].join("\n");
      }
      throw new Error(`unexpected file: ${p}`);
    };

    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.stages).toEqual(["plan"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13: loadCanonicalRules rule.warnings carries parser displaced-frontmatter entry
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — AC13 displaced-frontmatter warning propagation", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
    _canonicalLoaderDeps.getLogger = () =>
      ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }) as unknown as ReturnType<
        typeof _canonicalLoaderDeps.getLogger
      >;
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  test("[AC13] returns a CanonicalRule whose warnings include the parser displaced-frontmatter entry for a disk rule beginning with a blank line followed by ---", async () => {
    const filePath = "/project/.nax/rules/displaced.md";
    _canonicalLoaderDeps.globInDir = () => [filePath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === filePath) {
        return "\n---\n---\nBody.";
      }
      throw new Error(`unexpected file: ${p}`);
    };

    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.warnings).toBeDefined();
    expect(rules[0]?.warnings?.some((w) => /displaced|blank|first line/i.test(w))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14: loadCanonicalRules logger.warn fires for displaced-frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — AC14 displaced-frontmatter logger warning", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  test("[AC14] emits a warning through _canonicalLoaderDeps.getLogger() when a rule file has a displaced frontmatter block", async () => {
    const logger = makeLogger();
    _canonicalLoaderDeps.getLogger = () => logger;

    const filePath = "/project/.nax/rules/displaced.md";
    _canonicalLoaderDeps.globInDir = () => [filePath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === filePath) {
        return "\n---\n---\nBody.";
      }
      throw new Error(`unexpected file: ${p}`);
    };

    await loadCanonicalRules("/project");

    const hasDisplacedWarning = logger.calls.some((c) => {
      const file = c.data?.file;
      return typeof file === "string" && file === filePath;
    });
    expect(hasDisplacedWarning).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: HTML comment + --- emits displaced-frontmatter warning including filePath
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — HTML-comment displaced frontmatter", () => {
  const filePath = "/project/.nax/rules/comment-displaced.md";

  test("[AC1] returns a displaced-frontmatter warning naming the file when a single-line HTML comment precedes ---", () => {
    const content = "<!-- review notice -->\n---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(filePath);
    expect(result.warnings[0]).toMatch(/displaced|comment/i);
  });

  test("[AC2] returns priority FRONTMATTER_PRIORITY_DEFAULT when an HTML comment precedes a block declaring priority: 90", () => {
    const content = "<!-- review notice -->\n---\npriority: 90\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
  });

  test("[AC3] returns paths undefined when an HTML comment precedes a block declaring paths", () => {
    const content = '<!-- review notice -->\n---\npaths:\n  - "apps/api"\n---\nBody.';
    const result = parseFrontmatter(content, filePath);
    expect(result.paths).toBeUndefined();
  });

  test("[AC4] returns appliesTo undefined when an HTML comment precedes a block declaring appliesTo", () => {
    const content = '<!-- review notice -->\n---\nappliesTo:\n  - "src/**"\n---\nBody.';
    const result = parseFrontmatter(content, filePath);
    expect(result.appliesTo).toBeUndefined();
  });

  test("[AC5] returns a displaced-frontmatter warning for a multi-line leading HTML comment followed by ---", () => {
    const content = "<!--\n  review notice spanning\n  multiple lines\n-->\n---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(filePath);
    expect(result.warnings[0]).toMatch(/displaced|comment/i);
  });

  test("[AC6] returns an empty warnings array for a leading HTML comment with no --- block anywhere in the content", () => {
    const content = "<!-- review notice -->\nJust a regular markdown file, no frontmatter here.";
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("[AC7] returns an empty warnings array for a leading HTML comment, ordinary prose, and a later Markdown --- horizontal rule", () => {
    const content = [
      "<!-- review notice -->",
      "",
      "Some prose before a horizontal rule.",
      "",
      "---",
      "",
      "More prose.",
    ].join("\n");
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("[AC8] returns exactly one warning for blank line + leading HTML comment + --- block", () => {
    const content = "\n<!-- review notice -->\n---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toHaveLength(1);
  });

  test("[AC9] returns an empty warnings array when a --- frontmatter block begins at byte 0", () => {
    const content = "---\npriority: 100\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("[AC10] returns priority 90 and exactly one displaced-frontmatter warning for a leading blank line directly followed by --- with priority: 90", () => {
    const content = "\n---\npriority: 90\n---\nBody.";
    const result = parseFrontmatter(content, filePath);
    expect(result.priority).toBe(90);
    expect(result.warnings).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: loadCanonicalRules propagates HTML-comment displaced-frontmatter warning
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — HTML-comment displaced-frontmatter warning propagation", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
    _canonicalLoaderDeps.getLogger = () =>
      ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }) as unknown as ReturnType<
        typeof _canonicalLoaderDeps.getLogger
      >;
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  test("[AC11] returns a CanonicalRule whose warnings include a displaced-frontmatter entry when its disk rule is preceded by an HTML comment", async () => {
    const filePath = "/project/.nax/rules/comment-displaced.md";
    _canonicalLoaderDeps.globInDir = () => [filePath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === filePath) {
        return "<!-- review notice -->\n---\npriority: 100\n---\nBody.";
      }
      throw new Error(`unexpected file: ${p}`);
    };

    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.warnings).toBeDefined();
    expect(rules[0]?.warnings?.some((w) => /displaced|comment/i.test(w))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006: stage scoping for canonical rules in the real .nax/rules store.
// The four test-authoring rules (test-writing.md, test-architecture.md,
// test-helpers.md, testing-commands.md) declare a `stages:` list that excludes
// plan, acceptance, and route. Rules that genuinely apply everywhere
// (forbidden-patterns-source.md, forbidden-patterns-tests.md,
// project-conventions.md) declare no `stages:` key.
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — US-006 real .nax/rules store stage scoping", () => {
  test("[US-006 AC 1] returns test-writing.md with stages that exclude plan", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => r.path === "test-writing.md" || r.fileName === "test-writing.md");
    expect(rule).toBeDefined();
    expect(rule?.stages).toBeDefined();
    expect(rule?.stages).not.toContain("plan");
  });

  test("[US-006 AC 1] returns test-architecture.md with stages that exclude plan", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => r.path === "test-architecture.md" || r.fileName === "test-architecture.md");
    expect(rule).toBeDefined();
    expect(rule?.stages).toBeDefined();
    expect(rule?.stages).not.toContain("plan");
  });

  test("[US-006 AC 1] returns test-helpers.md with stages that exclude plan", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => r.path === "test-helpers.md" || r.fileName === "test-helpers.md");
    expect(rule).toBeDefined();
    expect(rule?.stages).toBeDefined();
    expect(rule?.stages).not.toContain("plan");
  });

  test("[US-006 AC 1] returns testing-commands.md with stages that exclude plan", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => r.path === "testing-commands.md" || r.fileName === "testing-commands.md");
    expect(rule).toBeDefined();
    expect(rule?.stages).toBeDefined();
    expect(rule?.stages).not.toContain("plan");
  });

  // forbidden-patterns.md was split into -source/-tests by SPEC-bounded-rules-floor
  // US-005. Both halves, and project-conventions.md, originally declared no
  // `stages:` key and so loaded at every stage. #1612 gave each an explicit stage
  // list to keep them out of plan/route/verify/debate, where they were 6749
  // tokens of freight per prompt. They must still be declared, still exclude
  // plan, and still cover execution — an empty list would exclude plan while
  // reaching no agent at all.
  for (const fileName of ["forbidden-patterns-source.md", "forbidden-patterns-tests.md", "project-conventions.md"]) {
    test(`[US-006 AC 2] returns ${fileName} with stages that exclude plan`, async () => {
      const rules = await loadCanonicalRules(process.cwd());
      const rule = rules.find((r) => r.path === fileName || r.fileName === fileName);
      expect(rule).toBeDefined();
      expect(rule?.stages).toBeDefined();
      expect(rule?.stages).not.toContain("plan");
      expect(rule?.stages).toContain("execution");
    });
  }

  test("[US-006 AC 6] every CanonicalRule has an empty warnings list under the real .nax/rules store", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.warnings ?? []).toEqual([]);
    }
  });
});
