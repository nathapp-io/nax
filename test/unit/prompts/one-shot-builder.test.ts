/**
 * Tests for OneShotPromptBuilder (Phase 6)
 *
 * Covers snapshot stability + structural contract for both roles:
 *   router       — routes a story to a model tier
 *   decomposer   — decomposes a spec into stories
 */

import { describe, expect, test } from "bun:test";
import { OneShotPromptBuilder } from "@/prompts";
import type { OneShotRole, RoutingCandidate, SchemaDescriptor } from "@/prompts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INSTRUCTIONS = "Classify the story into the correct model tier based on complexity.";
const CONSTITUTION = "You are a routing expert. Be accurate and concise.";

const CANDIDATES: RoutingCandidate[] = [
  { tier: "fast", description: "Simple tasks with no ambiguity", costPerMillion: 0.25 },
  { tier: "balanced", description: "Moderate complexity tasks", costPerMillion: 3.0 },
  { tier: "powerful", description: "Complex multi-step reasoning", costPerMillion: 15.0 },
];

const SCHEMA: SchemaDescriptor = {
  name: "RoutingDecision",
  description: "The selected model tier for the story",
  example: { tier: "fast" },
};

const STORY_INPUT = "Title: Add login page\nDescription: Implement a basic login form.";

// ─── Snapshot stability ───────────────────────────────────────────────────────

describe("OneShotPromptBuilder — snapshot stability", () => {
  const ROLES: OneShotRole[] = ["router", "decomposer"];

  for (const role of ROLES) {
    test(`minimal build — ${role}`, () => {
      const result = OneShotPromptBuilder.for(role).instructions(INSTRUCTIONS).build();
      expect(result).toMatchSnapshot();
    });
  }

  test("router — full build with candidates and schema", () => {
    const result = OneShotPromptBuilder.for("router")
      .instructions(INSTRUCTIONS)
      .inputData("Story", STORY_INPUT)
      .candidates(CANDIDATES)
      .jsonSchema(SCHEMA)
      .build();
    expect(result).toMatchSnapshot();
  });

  test("decomposer — full build with constitution", () => {
    const result = OneShotPromptBuilder.for("decomposer")
      .constitution(CONSTITUTION)
      .instructions("Break the spec into user stories.")
      .inputData("Feature Specification", "## Auth\n\nBuild login and registration.")
      .jsonSchema({ name: "Stories", description: "Array of user stories", example: { stories: [] } })
      .build();
    expect(result).toMatchSnapshot();
  });
});

// ─── Structural contract: fluent API ─────────────────────────────────────────

describe("OneShotPromptBuilder — fluent API", () => {
  test("for() returns a OneShotPromptBuilder; getRole() returns the role passed to for()", () => {
    const builder = OneShotPromptBuilder.for("router");
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
    expect(OneShotPromptBuilder.for("router").getRole()).toBe("router");
    expect(OneShotPromptBuilder.for("decomposer").getRole()).toBe("decomposer");
  });

  test("all builder methods are chainable (instructions, constitution, inputData, candidates, jsonSchema)", () => {
    expect(OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS)).toBeInstanceOf(OneShotPromptBuilder);
    expect(OneShotPromptBuilder.for("decomposer").constitution(CONSTITUTION)).toBeInstanceOf(OneShotPromptBuilder);
    expect(OneShotPromptBuilder.for("router").inputData("Story", STORY_INPUT)).toBeInstanceOf(OneShotPromptBuilder);
    expect(OneShotPromptBuilder.for("router").candidates(CANDIDATES)).toBeInstanceOf(OneShotPromptBuilder);
    expect(OneShotPromptBuilder.for("router").jsonSchema(SCHEMA)).toBeInstanceOf(OneShotPromptBuilder);
  });

  test("build() returns a string; empty builder produces empty string", () => {
    const result = OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS).build();
    expect(typeof result).toBe("string");
    expect(OneShotPromptBuilder.for("router").build()).toBe("");
  });
});

// ─── Structural contract: section content ────────────────────────────────────

describe("OneShotPromptBuilder — section content", () => {
  test("instructions section includes the instruction text", () => {
    const result = OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS).build();
    expect(result).toContain(INSTRUCTIONS);
  });

  test("constitution section includes text when set; absent when undefined", () => {
    const withConstitution = OneShotPromptBuilder.for("decomposer")
      .constitution(CONSTITUTION)
      .instructions(INSTRUCTIONS)
      .build();
    expect(withConstitution).toContain(CONSTITUTION);
    const withoutConstitution = OneShotPromptBuilder.for("decomposer")
      .constitution(undefined)
      .instructions(INSTRUCTIONS)
      .build();
    expect(withoutConstitution).not.toContain("CONSTITUTION");
  });

  test("inputData label is uppercased as heading; body appears verbatim", () => {
    const result = OneShotPromptBuilder.for("router").inputData("Story", STORY_INPUT).build();
    expect(result).toContain("# STORY");
    expect(result).toContain(STORY_INPUT);
  });

  test("multiple inputData calls each appear as separate sections", () => {
    const result = OneShotPromptBuilder.for("decomposer")
      .inputData("Request", "Write to disk")
      .inputData("Context", "Read-only environment")
      .build();
    expect(result).toContain("# REQUEST");
    expect(result).toContain("# CONTEXT");
    expect(result).toContain("Write to disk");
    expect(result).toContain("Read-only environment");
  });

  test("candidates section includes tier names", () => {
    const result = OneShotPromptBuilder.for("router")
      .instructions(INSTRUCTIONS)
      .candidates(CANDIDATES)
      .build();
    for (const c of CANDIDATES) {
      expect(result).toContain(c.tier);
    }
  });

  test("jsonSchema section includes schema name and example", () => {
    const result = OneShotPromptBuilder.for("router")
      .instructions(INSTRUCTIONS)
      .jsonSchema(SCHEMA)
      .build();
    expect(result).toContain(SCHEMA.name);
    expect(result).toContain(JSON.stringify(SCHEMA.example, null, 2));
  });
});

// ─── Structural contract: all roles produce distinct output ──────────────────

describe("OneShotPromptBuilder — role independence", () => {
  test("both roles produce distinct output for the same instructions", () => {
    const roles: OneShotRole[] = ["router", "decomposer"];
    const results = roles.map((role) =>
      OneShotPromptBuilder.for(role).instructions(`Instructions for ${role}`).build(),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(roles.length);
  });
});
