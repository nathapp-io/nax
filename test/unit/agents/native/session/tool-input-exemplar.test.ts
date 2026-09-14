import { describe, expect, test } from "bun:test";
import { exemplarFor } from "@/agents/native/session/tool-input-exemplar";
import { validateToolInput } from "@/agents/native/session/tool-input-validation";

const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["testScoped", "typecheck"] },
    values: { type: "object" },
  },
} as const;

const COMMAND_ENUM_SCHEMA = {
  type: "object",
  properties: {
    command: { enum: ["testScoped", "typecheck"] },
  },
} as const;

const ARGV_STRING_ARRAY_SCHEMA = {
  type: "object",
  properties: {
    argv: { type: "array", items: { type: "string" } },
  },
} as const;

type Case = readonly [
  label: string,
  schema: unknown,
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
];

const CASES: readonly Case[] = [
  [
    "RunCommand: values is empty string (live defect) — preserves command, falls back for undeclared values shape",
    RUN_COMMAND_SCHEMA,
    { command: "testScoped", values: "" },
    { command: "testScoped", values: { "<FILL IN>": "<FILL IN>" } },
  ],
  [
    "property has enum (no type): command is a number — uses first enum member",
    COMMAND_ENUM_SCHEMA,
    { command: 5 },
    { command: "testScoped" },
  ],
  [
    "property is array of string: argv is a string — uses array exemplar with property name",
    ARGV_STRING_ARRAY_SCHEMA,
    { argv: "bun test" },
    { argv: ["<FILL IN: argv>"] },
  ],
  [
    "nested object with no declared properties: values is empty string — fallback shape",
    RUN_COMMAND_SCHEMA,
    { values: "" },
    { values: { "<FILL IN>": "<FILL IN>" } },
  ],
];

function requireViolation(
  value: ReturnType<typeof validateToolInput>,
): Exclude<ReturnType<typeof validateToolInput>, undefined> {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("expected a violation");
  return value;
}

describe("exemplarFor", () => {
  test.each(CASES)("%s", (_label, schema, input, expected) => {
    const violation = requireViolation(validateToolInput(schema, input));

    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar).toEqual(expected);

    expect(validateToolInput(schema, exemplar)).toBeUndefined();
  });

  test("property preservation: every non-violated key survives verbatim", () => {
    const schema = RUN_COMMAND_SCHEMA;
    const input = { command: "testScoped", values: "" };
    const violation = requireViolation(validateToolInput(schema, input));
    expect(violation.property).toBe("values");

    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar.command).toBe("testScoped");
    expect(exemplar.values).toEqual({ "<FILL IN>": "<FILL IN>" });
  });

  test("does not mutate the input", () => {
    const schema = RUN_COMMAND_SCHEMA;
    const input: Record<string, unknown> = { command: "testScoped", values: "" };
    const snapshot = JSON.stringify(input);
    const violation = requireViolation(validateToolInput(schema, input));

    exemplarFor(schema, input, violation);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
