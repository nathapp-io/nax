import { describe, expect, test } from "bun:test";
import { parseRequoteResponse } from "@/review";

describe("parseRequoteResponse", () => {
  test("parses canonical quote object", () => {
    const parsed = parseRequoteResponse('{"file":"src/x.ts","line":1,"observed":"quote"}');
    expect(parsed).toEqual({ file: "src/x.ts", line: 1, observed: "quote" });
  });

  test("coerces digit-only string line", () => {
    const parsed = parseRequoteResponse('{"file":"src/x.ts","line":"1","observed":"quote"}');
    expect(parsed).toEqual({ file: "src/x.ts", line: 1, observed: "quote" });
  });

  test("accepts canonical object with extra keys", () => {
    const parsed = parseRequoteResponse('{"file":"src/x.ts","line":1,"observed":"quote","passed":true}');
    expect(parsed).toEqual({ file: "src/x.ts", line: 1, observed: "quote" });
  });

  test("parses single-finding fallback with nested verifiedBy", () => {
    const parsed = parseRequoteResponse(
      '{"passed":true,"findings":[{"verifiedBy":{"file":"src/x.ts","line":1,"observed":"quote"}}]}',
    );
    expect(parsed).toEqual({ file: "src/x.ts", line: 1, observed: "quote" });
  });

  test("parses single-finding fallback with top-level finding fields", () => {
    const parsed = parseRequoteResponse(
      '{"passed":false,"findings":[{"file":"src/x.ts","line":1,"observed":"quote"}]}',
    );
    expect(parsed).toEqual({ file: "src/x.ts", line: 1, observed: "quote" });
  });

  test("returns null for multi-finding fallback", () => {
    const parsed = parseRequoteResponse(
      '{"passed":false,"findings":[{"file":"a.ts","observed":"a"},{"file":"b.ts","observed":"b"}]}',
    );
    expect(parsed).toBeNull();
  });

  test("returns null for top-level array", () => {
    const parsed = parseRequoteResponse('[{"file":"src/x.ts","observed":"quote"}]');
    expect(parsed).toBeNull();
  });

  test("returns null when observed is missing", () => {
    const parsed = parseRequoteResponse('{"file":"src/x.ts","line":1}');
    expect(parsed).toBeNull();
  });

  test("returns null when observed is not a string", () => {
    const parsed = parseRequoteResponse('{"file":"src/x.ts","line":1,"observed":123}');
    expect(parsed).toBeNull();
  });
});
