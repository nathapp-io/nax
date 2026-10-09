import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nameTools } from "#src/server/mcp/naming";

const FACADE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const hash8 = (server: string, tool: string) =>
  createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);

describe("nameTools", () => {
  test("server__tool, sanitised; a server part starting with a non-letter gets an m prefix", () => {
    const { named } = nameTools([
      { server: "git", tool: "status" },
      { server: "my server", tool: "read.file" },
      { server: "9lives", tool: "x" },
    ]);
    expect(named.map((n) => n.modelName)).toEqual(["git__status", "my_server__read_file", "m9lives__x"]);
  });

  test("names over 64 chars are cut to 55 plus _ and 8 hash chars", () => {
    const tool = "t".repeat(80);
    const { named } = nameTools([{ server: "srv", tool }]);
    const name = named[0]?.modelName ?? "";
    expect(name).toBe(`${`srv__${tool}`.slice(0, 55)}_${hash8("srv", tool)}`);
    expect(name).toHaveLength(64);
    expect(FACADE.test(name)).toBe(true);
  });

  test("sanitised collisions get hash suffixes on every colliding name", () => {
    // "a.b" and "a_b" both sanitise to "a_b"; "other" does not collide.
    const { named, dropped } = nameTools([
      { server: "a.b", tool: "t" },
      { server: "a_b", tool: "t" },
      { server: "other", tool: "x" },
    ]);
    expect(named.map((n) => n.modelName)).toEqual([
      `a_b__t_${hash8("a.b", "t")}`,
      `a_b__t_${hash8("a_b", "t")}`,
      "other__x",
    ]);
    expect(dropped).toEqual([]);
  });

  test("a pair repeated verbatim (a server listing a tool twice) drops the later one", () => {
    const { named, dropped } = nameTools([
      { server: "s", tool: "a" },
      { server: "s", tool: "a" },
    ]);
    expect(named).toHaveLength(1);
    expect(dropped).toEqual([{ server: "s", tool: "a" }]);
  });

  test("every produced name passes the facade rule and contains __", () => {
    const { named } = nameTools([
      { server: "", tool: "" },
      { server: "ü", tool: "ß" },
    ]);
    for (const n of named) {
      expect(FACADE.test(n.modelName)).toBe(true);
      expect(n.modelName).toContain("__");
    }
  });

  test("a hashed name from a very long server part drops __ but stays a valid, built-in-distinct name", () => {
    const server = "a".repeat(60);
    const tool = "x".repeat(10);
    const { named, dropped } = nameTools([{ server, tool }]);
    expect(named).toHaveLength(1);
    expect(dropped).toEqual([]);
    const name = named[0]?.modelName ?? "";
    expect(name).toBe(`${`${server}__${tool}`.slice(0, 55)}_${hash8(server, tool)}`);
    expect(FACADE.test(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
    // The 55-char cut can drop `__`; built-ins are short and `__`-free, so the name is still distinct.
    expect(["read", "write", "edit", "bash", "glob", "grep"]).not.toContain(name);
  });

  test("long-server pairs sharing a sanitised base stay distinct via the hash", () => {
    const { named, dropped } = nameTools([
      { server: `${"a".repeat(60)}.`, tool: "x".repeat(10) },
      { server: `${"a".repeat(60)}_`, tool: "x".repeat(10) },
    ]);
    expect(named).toHaveLength(2);
    expect(dropped).toEqual([]);
    const names = named.map((n) => n.modelName);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(FACADE.test(name)).toBe(true);
  });
});
