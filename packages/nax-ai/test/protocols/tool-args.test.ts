import { describe, expect, it } from "vitest";
import { createToolArgAccumulator, parseToolArgs } from "../../src/protocols/tool-args.ts";

describe("createToolArgAccumulator", () => {
  it("returns the running total after each fragment", () => {
    const acc = createToolArgAccumulator();
    expect(acc.append("t1", "read", '{"path"')).toBe('{"path"');
    expect(acc.append("t1", "read", ':"a.ts"}')).toBe('{"path":"a.ts"}');
  });

  it("keeps concurrent tool calls apart", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", '{"a":1');
    acc.append("t2", "write", '{"b":2');
    expect(acc.append("t1", "read", "}")).toBe('{"a":1}');
    expect(acc.append("t2", "write", "}")).toBe('{"b":2}');
  });

  it("take removes the entry so a repeated id starts fresh", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", '{"a":1}');
    expect(acc.take("t1")).toEqual({ name: "read", raw: '{"a":1}' });
    expect(acc.take("t1")).toBeUndefined();
  });

  it("keeps the name from the first fragment", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", "{");
    acc.append("t1", "", "}");
    expect(acc.take("t1")?.name).toBe("read");
  });
});

describe("parseToolArgs", () => {
  it("treats an empty accumulation as an empty object", () => {
    expect(parseToolArgs("")).toEqual({});
  });

  it("parses accumulated JSON", () => {
    expect(parseToolArgs('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseToolArgs('{"path"')).toThrow();
  });
});
