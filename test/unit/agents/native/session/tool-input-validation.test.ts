import { describe, expect, test } from "bun:test";
import { stripNullOptionals, validateToolInput } from "@/agents/native/session/tool-input-validation";
import { gitTool } from "@/tools/git";

const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["testScoped", "typecheck"] },
    values: { type: "object" },
  },
} as const;

// The shape of the real Git tool's schema (src/tools/git.ts) that nax#2200's
// verifier tripped on: `refs`/`paths` optional arrays, `diffFilter` an
// optional string enum, `subcommand` required.
const GIT_SCHEMA = {
  type: "object",
  properties: {
    subcommand: { type: "string", enum: ["diff", "log", "show", "status", "blame"] },
    refs: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    diffFilter: { type: "string", enum: ["A", "M", "D"] },
  },
  required: ["subcommand"],
} as const;

type Expectation = { property: string; expected: string; actual: string; message: string };
type Case = readonly [label: string, schema: unknown, input: unknown, result: Expectation | undefined];

const CASES: readonly Case[] = [
  [
    "the live defect (values is the empty string)",
    RUN_COMMAND_SCHEMA,
    { command: "testScoped", values: "" },
    { property: "values", expected: "object", actual: "a string", message: "`values` expected object, got a string" },
  ],
  [
    "the second defective shape (values is a single tab)",
    RUN_COMMAND_SCHEMA,
    { command: "testScoped", values: "\t" },
    { property: "values", expected: "object", actual: "a string", message: "`values` expected object, got a string" },
  ],
  [
    "a tab is just a string, not a placeholder key",
    RUN_COMMAND_SCHEMA,
    { values: "\t" },
    { property: "values", expected: "object", actual: "a string", message: "`values` expected object, got a string" },
  ],
  [
    "null on a required property is reported as null",
    { ...RUN_COMMAND_SCHEMA, required: ["values"] },
    { values: null },
    { property: "values", expected: "object", actual: "null", message: "`values` expected object, got null" },
  ],
  ["null on an optional property reads as absent (nax#2200)", RUN_COMMAND_SCHEMA, { values: null }, undefined],
  [
    "null on an optional enum property reads as absent (nax#2200)",
    RUN_COMMAND_SCHEMA,
    { command: null, values: { files: "a.test.ts" } },
    undefined,
  ],
  [
    "the #2200 verifier shape: Git log with refs:null passes",
    GIT_SCHEMA,
    { subcommand: "log", refs: null, diffFilter: null },
    undefined,
  ],
  [
    "an array is reported as an array",
    RUN_COMMAND_SCHEMA,
    { values: [] },
    { property: "values", expected: "object", actual: "an array", message: "`values` expected object, got an array" },
  ],
  ["a correct shape passes", RUN_COMMAND_SCHEMA, { command: "testScoped", values: { files: "a.test.ts" } }, undefined],
  ["an absent optional property passes", RUN_COMMAND_SCHEMA, { command: "typecheck" }, undefined],
  [
    "an enum violation names the declared members",
    RUN_COMMAND_SCHEMA,
    { command: "nope" },
    {
      property: "command",
      expected: "one of: testScoped, typecheck",
      actual: "a string",
      message: "`command` must be one of: testScoped, typecheck (got a string)",
    },
  ],
  [
    "a missing required property is named",
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    {},
    { property: "path", expected: "present", actual: "absent", message: "`path` is required" },
  ],
  [
    "fail-open: unknown keyword (anyOf) is allowed",
    { type: "object", properties: { x: { anyOf: [{ type: "number" }] } } },
    { x: 1 },
    undefined,
  ],
  ["fail-open: an empty schema is allowed", {}, { x: 1 }, undefined],
  ["fail-open: an undefined schema is allowed", undefined, { x: 1 }, undefined],
  ["fail-open: a non-object top-level type is allowed", { type: "string" }, { x: 1 }, undefined],
  [
    "an extra property is allowed when the schema does not forbid it",
    RUN_COMMAND_SCHEMA,
    { command: "typecheck", nope: 1 },
    undefined,
  ],
];

describe("validateToolInput", () => {
  test.each(CASES)("%s", (_label, schema, input, expected) => {
    expect(validateToolInput(schema, input)).toEqual(expected);
  });
});

type StripCase = readonly [label: string, schema: unknown, input: unknown, result: Record<string, unknown> | undefined];

const STRIP_CASES: readonly StripCase[] = [
  [
    "drops every null optional property and keeps the rest",
    GIT_SCHEMA,
    { subcommand: "log", refs: null, diffFilter: null, paths: ["src"] },
    { subcommand: "log", paths: ["src"] },
  ],
  ["nothing to drop returns undefined", GIT_SCHEMA, { subcommand: "log", refs: ["HEAD"] }, undefined],
  ["a required null is left for the validator to reject", GIT_SCHEMA, { subcommand: null }, undefined],
  [
    "a property whose schema is type null keeps its null",
    { type: "object", properties: { empty: { type: "null" } } },
    { empty: null },
    undefined,
  ],
  ["an undeclared null property is left alone", GIT_SCHEMA, { subcommand: "log", extra: null }, undefined],
  ["fail-open: a schema without properties returns undefined", { type: "object" }, { refs: null }, undefined],
  ["fail-open: a non-object input returns undefined", GIT_SCHEMA, "refs", undefined],
];

describe("stripNullOptionals (nax#2200)", () => {
  test.each(STRIP_CASES)("%s", (_label, schema, input, expected) => {
    expect(stripNullOptionals(schema, input)).toEqual(expected);
  });

  test("does not mutate the input", () => {
    const input = { subcommand: "log", refs: null };
    stripNullOptionals(GIT_SCHEMA, input);
    expect(input).toEqual({ subcommand: "log", refs: null });
  });

  test("against the real Git tool schema, the #2200 verifier call validates and loses only its nulls", () => {
    const input = { subcommand: "log", refs: null, paths: null, maxCount: 5 };
    expect(validateToolInput(gitTool.inputSchema, input)).toBeUndefined();
    expect(stripNullOptionals(gitTool.inputSchema, input)).toEqual({ subcommand: "log", maxCount: 5 });
  });

  test("the stripped input validates", () => {
    const stripped = stripNullOptionals(GIT_SCHEMA, { subcommand: "log", refs: null });
    expect(validateToolInput(GIT_SCHEMA, stripped)).toBeUndefined();
  });
});
