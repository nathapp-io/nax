import { describe, expect, test } from "bun:test";
import { errorMessage } from "../../../src/utils/errors";

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    const err = new Error("Test error message");
    expect(errorMessage(err)).toBe("Test error message");
  });

  test("handles TypeError", () => {
    const err = new TypeError("Type mismatch");
    expect(errorMessage(err)).toBe("Type mismatch");
  });

  test("handles custom Error subclass", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }
    const err = new CustomError("Custom error");
    expect(errorMessage(err)).toBe("Custom error");
  });

  test("converts string to itself", () => {
    expect(errorMessage("error string")).toBe("error string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts boolean to string", () => {
    expect(errorMessage(true)).toBe("true");
    expect(errorMessage(false)).toBe("false");
  });

  test("handles null", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("handles undefined", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("handles object", () => {
    const obj = { foo: "bar" };
    expect(errorMessage(obj)).toBe("[object Object]");
  });

  test("handles thrown non-Error values", () => {
    // Simulate catch block that receives a non-Error
    const thrown = "Raw string error";
    expect(errorMessage(thrown)).toBe("Raw string error");
  });
});
