import { describe, expect, test } from "bun:test";
import { type FlowSendInput, parseFlowSendInput } from "@/chat/flow";

const SEND_SPEC = ".nax/features/nax-flow-send/spec.md";
const DOCS_SPEC = ".nax/features/nax-flow-docs/spec.md";

/** The brief's own example: two features, one dependency, two role models, a $5 cap. */
function validInput(): Record<string, unknown> {
  return {
    features: [
      { feature: "nax-flow-send", specPath: SEND_SPEC },
      { feature: "nax-flow-docs", specPath: DOCS_SPEC, dependsOn: ["nax-flow-send"] },
    ],
    roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
    costCapUsd: 5,
  };
}

/** One feature named `name`, with its spec at the conventional path. */
function feature(name: string, dependsOn?: readonly string[]): Record<string, unknown> {
  const entry: Record<string, unknown> = { feature: name, specPath: `.nax/features/${name}/spec.md` };
  if (dependsOn !== undefined) entry.dependsOn = [...dependsOn];
  return entry;
}

/** The parsed input, or a failure naming what the parser refused — the mirror of `errorsOf`. */
function inputOf(raw: unknown): FlowSendInput {
  const result = parseFlowSendInput(raw);
  if ("errors" in result) throw new Error(`expected a parsed input, got errors: ${result.errors.join("; ")}`);
  return result;
}

/** The errors the parser returned; fails the test when it returned an input instead. */
function errorsOf(raw: unknown): string[] {
  const result = parseFlowSendInput(raw);
  if (!("errors" in result)) {
    throw new Error(`expected errors, got a parsed input: ${JSON.stringify(result)}`);
  }
  return result.errors;
}

/** The single error a one-cause input must yield, so a stray extra message fails the test. */
function singleError(raw: unknown): string {
  const errors = errorsOf(raw);
  expect(errors).toHaveLength(1);
  return errors[0] ?? "";
}

describe("parseFlowSendInput", () => {
  test("returns the parsed input with each missing dependsOn defaulted to an empty array", () => {
    const result = parseFlowSendInput(validInput());

    expect(result).toEqual({
      features: [
        { feature: "nax-flow-send", specPath: SEND_SPEC, dependsOn: [] },
        { feature: "nax-flow-docs", specPath: DOCS_SPEC, dependsOn: ["nax-flow-send"] },
      ],
      roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
      costCapUsd: 5,
    });
  });

  test("accepts the boundary values: one feature, twenty features, $1000 and four decimals", () => {
    for (const costCapUsd of [1000, 0.0001, 1.5]) {
      expect(inputOf({ ...validInput(), costCapUsd }).costCapUsd).toBe(costCapUsd);
    }
    for (const count of [1, 20]) {
      const features = Array.from({ length: count }, (_unused, index) => feature(`f${index}`));

      expect(inputOf({ ...validInput(), features }).features).toHaveLength(count);
    }
  });

  test("returns errors naming features when the list is empty", () => {
    expect(singleError({ ...validInput(), features: [] })).toContain("features");
  });

  test("returns errors naming features when it is not an array", () => {
    expect(singleError({ ...validInput(), features: "nax-flow-send" })).toContain("features");
  });

  test("returns errors naming features when the input is not an object", () => {
    for (const raw of [null, "features", 7, ["features"]]) {
      expect(errorsOf(raw)[0]).toContain("object");
    }
  });

  test("returns errors naming features when it is missing", () => {
    const rest = validInput();
    delete rest.features;

    expect(singleError(rest)).toContain("features");
  });

  test("returns errors naming the extra key when the input has a key other than features, roles and costCapUsd", () => {
    expect(singleError({ ...validInput(), repo: "nax" })).toContain("repo");
  });

  test("returns errors naming roles.supervisor when roles has no supervisor", () => {
    expect(singleError({ ...validInput(), roles: { reviewer: "acp:codex" } })).toContain("roles.supervisor");
  });

  test("returns errors naming roles when roles is not an object", () => {
    expect(singleError({ ...validInput(), roles: "acp:codex" })).toContain("roles");
  });

  test("returns errors naming features when the list has 21 entries", () => {
    const features = Array.from({ length: 21 }, (_unused, index) => feature(`f${index}`));

    expect(singleError({ ...validInput(), features })).toContain("features");
  });

  test("returns errors naming the feature when a feature starts with -", () => {
    const error = singleError({ ...validInput(), features: [feature("-nax-flow-send")] });

    expect(error).toContain("features[0].feature");
    expect(error).toContain("-nax-flow-send");
  });

  test("returns errors naming the feature when it is over 128 characters", () => {
    expect(singleError({ ...validInput(), features: [feature(`a${"b".repeat(128)}`)] })).toContain("feature");
  });

  test("returns errors naming the duplicate when two features share a name", () => {
    const error = singleError({ ...validInput(), features: [feature("nax-flow-send"), feature("nax-flow-send")] });

    expect(error).toContain("features[1].feature");
    expect(error).toContain("nax-flow-send");
  });

  test("returns errors naming the feature entry when it is not an object", () => {
    expect(singleError({ ...validInput(), features: ["nax-flow-send"] })).toContain("features[0]");
  });

  test("returns errors naming a key a feature entry does not have", () => {
    const entry = { ...feature("nax-flow-send"), specpath: SEND_SPEC };

    expect(singleError({ ...validInput(), features: [entry] })).toContain("specpath");
  });

  test("returns errors naming the specPath when it contains a .. segment", () => {
    const error = singleError({
      ...validInput(),
      features: [{ feature: "nax-flow-send", specPath: ".nax/features/../secret/spec.md" }],
    });

    expect(error).toContain("features[0].specPath");
    expect(error).toContain(".nax/features/../secret/spec.md");
  });

  test("returns errors naming the specPath when it does not end in .md", () => {
    const error = singleError({
      ...validInput(),
      features: [{ feature: "nax-flow-send", specPath: ".nax/features/nax-flow-send/spec.txt" }],
    });

    expect(error).toContain(".nax/features/nax-flow-send/spec.txt");
    expect(error).toContain(".md");
  });

  test("returns errors naming the specPath when it starts with /", () => {
    const error = singleError({
      ...validInput(),
      features: [{ feature: "nax-flow-send", specPath: "/.nax/features/nax-flow-send/spec.md" }],
    });

    expect(error).toContain("features[0].specPath");
    expect(error).toContain("/.nax/features/nax-flow-send/spec.md");
  });

  test("returns errors naming the specPath when it contains a NUL character", () => {
    const error = singleError({
      ...validInput(),
      features: [{ feature: "nax-flow-send", specPath: ".nax/features/nax-flow\u0000-send/spec.md" }],
    });

    expect(error).toContain("features[0].specPath");
    expect(error).toContain("NUL");
  });

  test("returns errors naming the specPath when it is empty or over 300 characters", () => {
    const long = `.nax/${"a".repeat(300)}.md`;
    for (const specPath of ["", long]) {
      expect(singleError({ ...validInput(), features: [{ feature: "nax-flow-send", specPath }] })).toContain(
        "features[0].specPath",
      );
    }
  });

  test("returns errors naming the specPath when it is not a string", () => {
    expect(singleError({ ...validInput(), features: [{ feature: "nax-flow-send", specPath: 7 }] })).toContain(
      "features[0].specPath",
    );
  });

  test("returns errors naming the dependency when dependsOn names a feature listed later", () => {
    const error = singleError({ ...validInput(), features: [feature("a", ["b"]), feature("b")] });

    expect(error).toContain("dependsOn");
    expect(error).toContain("b");
  });

  test("returns errors naming the dependency when dependsOn names the feature itself", () => {
    const error = singleError({ ...validInput(), features: [feature("a", ["a"])] });

    expect(error).toContain("dependsOn");
    expect(error).toContain("a");
  });

  test("returns errors naming dependsOn when it lists the same feature twice", () => {
    const error = singleError({ ...validInput(), features: [feature("a"), feature("b", ["a", "a"])] });

    expect(error).toContain("dependsOn");
    expect(error).toContain("a");
  });

  test("returns errors naming dependsOn when it is not an array of strings", () => {
    for (const dependsOn of ["a", [7]]) {
      const entry = { ...feature("a"), dependsOn };
      expect(singleError({ ...validInput(), features: [entry] })).toContain("dependsOn");
    }
  });

  test("returns errors naming the role when roles.reviewer contains a space", () => {
    expect(singleError({ ...validInput(), roles: { reviewer: "acp codex", supervisor: "acp:claude" } })).toContain(
      "roles.reviewer",
    );
  });

  test("returns errors naming the role when roles.supervisor is over 200 characters", () => {
    const error = singleError({
      ...validInput(),
      roles: { reviewer: "acp:codex", supervisor: "a".repeat(201) },
    });

    expect(error).toContain("roles.supervisor");
  });

  test("returns errors naming costCapUsd when it is 0", () => {
    expect(singleError({ ...validInput(), costCapUsd: 0 })).toContain("costCapUsd");
  });

  test("returns errors naming costCapUsd when it is 1000.01", () => {
    expect(singleError({ ...validInput(), costCapUsd: 1000.01 })).toContain("costCapUsd");
  });

  test("returns errors naming costCapUsd when it is 1.23456", () => {
    expect(singleError({ ...validInput(), costCapUsd: 1.23456 })).toContain("costCapUsd");
  });

  test("returns errors naming costCapUsd when it is the string 5", () => {
    expect(singleError({ ...validInput(), costCapUsd: "5" })).toContain("costCapUsd");
  });

  test("returns errors naming costCapUsd when it is missing", () => {
    const rest = validInput();
    delete rest.costCapUsd;

    expect(singleError(rest)).toContain("costCapUsd");
  });

  test("reports every violation, in the order the request lists them", () => {
    const errors = errorsOf({ ...validInput(), features: [feature("-a"), feature("b", ["c"])], costCapUsd: 0 });

    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("features[0].feature");
    expect(errors[1]).toContain("features[1].dependsOn");
    expect(errors[2]).toContain("costCapUsd");
  });
});
