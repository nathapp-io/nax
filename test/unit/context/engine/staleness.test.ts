/**
 * Amendment A AC-46/AC-47: Staleness detection
 *
 * Unit tests for staleness.ts pure helpers:
 *   - tokenize (term extraction, stopwords, length filter)
 *   - parseFeatureContextEntries (section grouping)
 *   - detectContradictions (AC-47: negation + shared terms)
 *   - selectStaleByAge (AC-46: age-based staleness)
 *   - applyStaleness (scoreMultiplier application)
 */

import { describe, expect, test } from "bun:test";
import {
  applyStaleness,
  detectContradictions,
  parseFeatureContextEntries,
  selectStaleByAge,
  tokenize,
} from "../../../../src/context/engine/staleness";

// ─────────────────────────────────────────────────────────────────────────────
// tokenize
// ─────────────────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  test("lowercases and splits on whitespace", () => {
    const tokens = tokenize("Auth Token Validation");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("token");
    expect(tokens).toContain("validation");
  });

  test("filters stopwords (the, and, use, for)", () => {
    const tokens = tokenize("use the auth token for validation");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("use");
    expect(tokens).not.toContain("for");
  });

  test("filters short tokens (len < 4)", () => {
    const tokens = tokenize("add the db row to log");
    expect(tokens).not.toContain("db");
    expect(tokens).not.toContain("to");
    expect(tokens).not.toContain("row");
  });

  test("splits on identifier separators (_, -, .)", () => {
    const tokens = tokenize("auth-token_validation.helper");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("token");
    expect(tokens).toContain("validation");
    expect(tokens).toContain("helper");
  });

  test("deduplicates tokens", () => {
    const tokens = tokenize("authentication authentication auth");
    const count = tokens.filter((t) => t === "authentication").length;
    expect(count).toBe(1);
  });

  test("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFeatureContextEntries
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFeatureContextEntries", () => {
  const CONTEXT_MD = `## Authentication

_Established in: US-001_
Use JWT tokens for authentication. Store in secure httpOnly cookies.

## Authorization

_Established in: US-002_
Role-based access control. Admin role has full access.

_Established in: US-003_
Regular users cannot access /admin routes.
`;

  test("returns one entry per paragraph-level block", () => {
    const entries = parseFeatureContextEntries(CONTEXT_MD);
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  test("assigns correct section to each entry", () => {
    const entries = parseFeatureContextEntries(CONTEXT_MD);
    const authEntries = entries.filter((e) => e.section === "Authentication");
    expect(authEntries.length).toBeGreaterThanOrEqual(1);
    const authzEntries = entries.filter((e) => e.section === "Authorization");
    expect(authzEntries.length).toBeGreaterThanOrEqual(2);
  });

  test("extracts establishing story from _Established in: US-XXX_", () => {
    const entries = parseFeatureContextEntries(CONTEXT_MD);
    const us001 = entries.find((e) => e.establishedIn === "US-001");
    expect(us001).toBeDefined();
  });

  test("assigns sequential index", () => {
    const entries = parseFeatureContextEntries(CONTEXT_MD);
    entries.forEach((e, i) => expect(e.index).toBe(i));
  });

  test("returns empty array for empty markdown", () => {
    expect(parseFeatureContextEntries("")).toEqual([]);
  });

  test("handles markdown with no ## sections", () => {
    const md = "Some text without sections\nMore text";
    const entries = parseFeatureContextEntries(md);
    // May return 0 entries (sections-only parser) or 1 entry in "default" section
    expect(Array.isArray(entries)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectContradictions (AC-47)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectContradictions", () => {
  test("flags older entry when newer uses negation and shares >=3 significant terms", () => {
    const entries = [
      {
        section: "Authentication",
        index: 0,
        text: "Use JWT authentication tokens stored in secure httpOnly cookies for session management",
        establishedIn: "US-001",
        terms: new Set(["jwt", "authentication", "tokens", "secure", "httpo", "cookies", "session", "management"]),
      },
      {
        section: "Authentication",
        index: 1,
        text: "Authentication tokens are no longer stored in cookies. Instead use Bearer headers for JWT authentication session",
        establishedIn: "US-005",
        terms: new Set(["authentication", "tokens", "longer", "cookies", "instead", "bearer", "headers", "jwt", "session"]),
      },
    ];
    const stale = detectContradictions(entries);
    expect(stale.has(0)).toBe(true);
    expect(stale.has(1)).toBe(false);
  });

  test("does not flag when shared terms < 3", () => {
    const entries = [
      {
        section: "Auth",
        index: 0,
        text: "Use argon2 for password hashing",
        establishedIn: "US-001",
        terms: new Set(["argon2", "password", "hashing"]),
      },
      {
        section: "Auth",
        index: 1,
        text: "Database schema removed and deprecated entirely",
        establishedIn: "US-002",
        terms: new Set(["database", "schema", "removed", "deprecated", "entirely"]),
      },
    ];
    const stale = detectContradictions(entries);
    expect(stale.size).toBe(0);
  });

  test("does not flag when newer entry lacks negation language", () => {
    const entries = [
      {
        section: "Auth",
        index: 0,
        text: "Use JWT authentication tokens stored in secure cookies for session management",
        establishedIn: "US-001",
        terms: new Set(["jwt", "authentication", "tokens", "secure", "cookies", "session", "management"]),
      },
      {
        section: "Auth",
        index: 1,
        text: "JWT authentication tokens rotate every 24 hours for improved security management",
        establishedIn: "US-003",
        terms: new Set(["jwt", "authentication", "tokens", "rotate", "hours", "security", "management"]),
      },
    ];
    const stale = detectContradictions(entries);
    expect(stale.size).toBe(0);
  });

  test("only flags entries within the same section", () => {
    const entries = [
      {
        section: "Authentication",
        index: 0,
        text: "Use JWT tokens for authentication session management cookies",
        establishedIn: "US-001",
        terms: new Set(["jwt", "tokens", "authentication", "session", "management", "cookies"]),
      },
      {
        section: "Authorization",
        index: 1,
        text: "JWT tokens are no longer valid for authentication session management cookies",
        establishedIn: "US-003",
        terms: new Set(["jwt", "tokens", "longer", "authentication", "session", "management", "cookies"]),
      },
    ];
    // Different sections — should NOT flag
    const stale = detectContradictions(entries);
    expect(stale.size).toBe(0);
  });

  test("returns empty set for single entry", () => {
    const entries = [
      {
        section: "Auth",
        index: 0,
        text: "Some auth text with tokens",
        establishedIn: "US-001",
        terms: new Set(["auth", "text", "tokens"]),
      },
    ];
    expect(detectContradictions(entries).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectStaleByAge (AC-46)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectStaleByAge", () => {
  const makeEntries = (ids: string[]) =>
    ids.map((id, i) => ({
      section: "Auth",
      index: i,
      text: `Entry from ${id}`,
      establishedIn: id,
      terms: new Set<string>(["auth", "entry"]),
    }));

  test("flags entries more than maxStoryAge positions behind latest", () => {
    // 15 entries, maxStoryAge=10 → entries 0–4 are stale (at positions < 15-10=5)
    const entries = makeEntries(["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007", "US-008", "US-009", "US-010", "US-011", "US-012", "US-013", "US-014", "US-015"]);
    const stale = selectStaleByAge(entries, 10);
    // 15 entries total. age = (14 - index). Stale when age > 10.
    // index 0 → age 14 (stale), index 3 → age 11 (stale), index 4 → age 10 (NOT stale)
    expect(stale.has(0)).toBe(true);
    expect(stale.has(3)).toBe(true);
    expect(stale.has(4)).toBe(false);
    expect(stale.has(14)).toBe(false);
  });

  test("no entries stale when count <= maxStoryAge", () => {
    const entries = makeEntries(["US-001", "US-002", "US-003"]);
    const stale = selectStaleByAge(entries, 10);
    expect(stale.size).toBe(0);
  });

  test("entries without establishedIn are not flagged", () => {
    const entries = [
      { section: "Auth", index: 0, text: "Entry without established marker", establishedIn: undefined, terms: new Set<string>(["auth"]) },
    ];
    const stale = selectStaleByAge(entries, 0);
    expect(stale.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyStaleness
// ─────────────────────────────────────────────────────────────────────────────

describe("applyStaleness", () => {
  const baseChunk = {
    id: "feature-context:abc123",
    providerId: "feature-context",
    kind: "feature" as const,
    scope: "feature" as const,
    role: ["implementer" as const],
    content: "Some feature context content",
    tokens: 10,
    rawScore: 1.0,
  };

  test("sets staleCandidate and scoreMultiplier when staleness detected", () => {
    const result = applyStaleness(baseChunk, { isStale: true, scoreMultiplier: 0.4 });
    expect(result.staleCandidate).toBe(true);
    expect(result.scoreMultiplier).toBe(0.4);
  });

  test("does not set staleCandidate when not stale", () => {
    const result = applyStaleness(baseChunk, { isStale: false, scoreMultiplier: 0.4 });
    expect(result.staleCandidate).toBeUndefined();
    expect(result.scoreMultiplier).toBeUndefined();
  });

  test("does not mutate the original chunk", () => {
    applyStaleness(baseChunk, { isStale: true, scoreMultiplier: 0.4 });
    expect((baseChunk as Record<string, unknown>).staleCandidate).toBeUndefined();
  });
});
