/**
 * Tests for OneShotPromptBuilder (Phase 6)
 *
 * Covers snapshot stability + structural contract for all 3 roles:
 *   router       — routes a story to a model tier
 *   decomposer   — decomposes a spec into stories
 *   auto-approver — approves or rejects an agent interaction request
 */

import { describe, expect, test } from "bun:test";
import { OneShotPromptBuilder } from "../../../src/prompts";
import type { OneShotRole, RoutingCandidate, SchemaDescriptor } from "../../../src/prompts";

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
  const ROLES: OneShotRole[] = ["router", "decomposer", "auto-approver"];

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

  test("auto-approver — full build with multiple input sections", () => {
    const result = OneShotPromptBuilder.for("auto-approver")
      .constitution("You are a safety reviewer.")
      .instructions("Approve or reject the agent action.")
      .inputData("Agent Request", "Write to /etc/hosts")
      .inputData("Project Context", "Web application with restricted file access")
      .jsonSchema({ name: "Decision", description: "Approve or reject", example: { approve: false } })
      .build();
    expect(result).toMatchSnapshot();
  });
});

// ─── Structural contract: fluent API ─────────────────────────────────────────

describe("OneShotPromptBuilder — fluent API", () => {
  test("for() returns a OneShotPromptBuilder", () => {
    const builder = OneShotPromptBuilder.for("router");
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test("getRole() returns the role passed to for()", () => {
    expect(OneShotPromptBuilder.for("router").getRole()).toBe("router");
    expect(OneShotPromptBuilder.for("decomposer").getRole()).toBe("decomposer");
    expect(OneShotPromptBuilder.for("auto-approver").getRole()).toBe("auto-approver");
  });

  test(".instructions() is chainable", () => {
    const builder = OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS);
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test(".constitution() is chainable", () => {
    const builder = OneShotPromptBuilder.for("decomposer").constitution(CONSTITUTION);
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test(".inputData() is chainable", () => {
    const builder = OneShotPromptBuilder.for("router").inputData("Story", STORY_INPUT);
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test(".candidates() is chainable", () => {
    const builder = OneShotPromptBuilder.for("router").candidates(CANDIDATES);
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test(".jsonSchema() is chainable", () => {
    const builder = OneShotPromptBuilder.for("router").jsonSchema(SCHEMA);
    expect(builder).toBeInstanceOf(OneShotPromptBuilder);
  });

  test("build() returns a string (synchronous)", () => {
    const result = OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS).build();
    expect(typeof result).toBe("string");
  });
});

// ─── Structural contract: section content ────────────────────────────────────

describe("OneShotPromptBuilder — section content", () => {
  test("instructions section includes the instruction text", () => {
    const result = OneShotPromptBuilder.for("router").instructions(INSTRUCTIONS).build();
    expect(result).toContain(INSTRUCTIONS);
  });

  test("constitution section includes the constitution text", () => {
    const result = OneShotPromptBuilder.for("decomposer")
      .constitution(CONSTITUTION)
      .instructions(INSTRUCTIONS)
      .build();
    expect(result).toContain(CONSTITUTION);
  });

  test("undefined constitution produces no constitution section", () => {
    const result = OneShotPromptBuilder.for("decomposer")
      .constitution(undefined)
      .instructions(INSTRUCTIONS)
      .build();
    expect(result).not.toContain("CONSTITUTION");
  });

  test("inputData label is uppercased as a heading", () => {
    const result = OneShotPromptBuilder.for("router").inputData("Story", STORY_INPUT).build();
    expect(result).toContain("# STORY");
  });

  test("inputData body appears verbatim", () => {
    const result = OneShotPromptBuilder.for("router").inputData("Story", STORY_INPUT).build();
    expect(result).toContain(STORY_INPUT);
  });

  test("multiple inputData calls each appear as separate sections", () => {
    const result = OneShotPromptBuilder.for("auto-approver")
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

  test("jsonSchema section includes schema name", () => {
    const result = OneShotPromptBuilder.for("router")
      .instructions(INSTRUCTIONS)
      .jsonSchema(SCHEMA)
      .build();
    expect(result).toContain(SCHEMA.name);
  });

  test("jsonSchema section includes example", () => {
    const result = OneShotPromptBuilder.for("router")
      .instructions(INSTRUCTIONS)
      .jsonSchema(SCHEMA)
      .build();
    expect(result).toContain(JSON.stringify(SCHEMA.example, null, 2));
  });

  test("empty builder produces empty string", () => {
    const result = OneShotPromptBuilder.for("router").build();
    expect(result).toBe("");
  });
});

// ─── Structural contract: all roles produce distinct output ──────────────────

describe("OneShotPromptBuilder — role independence", () => {
  test("all 3 roles produce distinct output for the same instructions", () => {
    const roles: OneShotRole[] = ["router", "decomposer", "auto-approver"];
    const results = roles.map((role) =>
      OneShotPromptBuilder.for(role).instructions(`Instructions for ${role}`).build(),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(roles.length);
  });
});
