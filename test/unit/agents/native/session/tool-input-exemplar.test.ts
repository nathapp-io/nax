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

const DIFF_FILTER_SCHEMA = {
  type: "object",
  properties: {
    subcommand: { type: "string", enum: ["diff", "log"] },
    diffFilter: { type: "string", enum: ["A", "M", "D", "R"] },
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
    "string property with enum (nax#2200): command is off-enum — uses first enum member, not a <FILL IN> string",
    RUN_COMMAND_SCHEMA,
    { command: "nope", values: { a: 1 } },
    { command: "testScoped", values: { a: 1 } },
  ],
  [
    "string property with enum (nax#2200): Git diffFilter is a number — uses first enum member",
    DIFF_FILTER_SCHEMA,
    { subcommand: "diff", diffFilter: 7 },
    { subcommand: "diff", diffFilter: "A" },
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

  test('property preservation: violation.property === "" returns the input verbatim', () => {
    const schema = RUN_COMMAND_SCHEMA;
    const input: Record<string, unknown> = { command: "testScoped", values: { a: 1 } };
    const exemplar = exemplarFor(schema, input, {
      property: "",
      expected: "object",
      actual: "a string",
      message: "synthetic top-level violation",
    });
    expect(exemplar).toEqual({ command: "testScoped", values: { a: 1 } });
  });

  test("non-object property schema returns a placeholder FILL IN", () => {
    const schema = {
      type: "object",
      properties: {
        // non-object property entry: the validator would skip this in
        // practice, but exemplarFor defends against a schema where the
        // schema entry is not a plain object.
        values: true,
      },
    };
    const input: Record<string, unknown> = { values: "anything" };
    const exemplar = exemplarFor(schema, input, {
      property: "values",
      expected: "object",
      actual: "a string",
      message: "synthetic",
    });
    expect(exemplar.values).toBe("<FILL IN>");
  });

  test("number/integer property: exemplar uses 0", () => {
    const schema = { type: "object", properties: { count: { type: "integer" } } };
    const input: Record<string, unknown> = { count: "five" };
    const violation = requireViolation(validateToolInput(schema, input));
    expect(violation.property).toBe("count");
    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar.count).toBe(0);
  });

  test("boolean property: exemplar uses false", () => {
    const schema = { type: "object", properties: { enabled: { type: "boolean" } } };
    const input: Record<string, unknown> = { enabled: "yes" };
    const violation = requireViolation(validateToolInput(schema, input));
    expect(violation.property).toBe("enabled");
    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar.enabled).toBe(false);
  });

  test("null property: exemplar uses null", () => {
    const schema = { type: "object", properties: { empty: { type: "null" } } };
    const input: Record<string, unknown> = { empty: "x" };
    const violation = requireViolation(validateToolInput(schema, input));
    expect(violation.property).toBe("empty");
    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar.empty).toBeNull();
  });

  test("object property with declared sub-properties: exemplar fills each with <FILL IN>", () => {
    const schema = {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "number" } },
        },
      },
    };
    const input: Record<string, unknown> = { payload: "nope" };
    const violation = requireViolation(validateToolInput(schema, input));
    expect(violation.property).toBe("payload");
    const exemplar = exemplarFor(schema, input, violation);
    expect(exemplar.payload).toEqual({ name: "<FILL IN>", age: "<FILL IN>" });
  });

  test("property with neither type nor enum falls back to <FILL IN>", () => {
    const schema = {
      type: "object",
      properties: {
        // declared property with neither `type` nor `enum` — the validator
        // returns undefined for this and skips it, so call exemplarFor with
        // a synthetic violation to exercise the fallback branch.
        anything: {},
      },
    };
    const input: Record<string, unknown> = { anything: 1 };
    const exemplar = exemplarFor(schema, input, {
      property: "anything",
      expected: "anything",
      actual: "a number",
      message: "synthetic",
    });
    expect(exemplar.anything).toBe("<FILL IN>");
  });
});
