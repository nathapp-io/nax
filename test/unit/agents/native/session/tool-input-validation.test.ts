import { describe, expect, test } from "bun:test";
import { validateToolInput } from "@/agents/native/session/tool-input-validation";

const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["testScoped", "typecheck"] },
    values: { type: "object" },
  },
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
    "null is reported as null",
    RUN_COMMAND_SCHEMA,
    { values: null },
    { property: "values", expected: "object", actual: "null", message: "`values` expected object, got null" },
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
