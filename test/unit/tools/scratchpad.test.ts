/**
 * US-002 — Implement scratchpad coding tools.
 *
 * The story pins three confined tools (ScratchpadWrite / ScratchpadRead /
 * ScratchpadList) into the existing coding-tool registry. Containment
 * (US-001) is the load-bearing seam; the tools here consume `ctx.resolvedPaths`
 * and never resolve a path themselves, so a refactor that re-introduces
 * per-tool resolution would silently widen the surface.
 *
 * Each AC below pins one observable behaviour. The barrel / registration /
 * reservation shape is asserted at the public surface (`@/tools`) so a future
 * re-export that drops a symbol fails the test, not the runtime. The tool
 * behaviour is asserted through `createCodingToolRuntime` for the happy paths
 * (policy + tool in concert) and through `scratchpadWriteTool.run` /
 * `scratchpadReadTool.run` / `scratchpadListTool.run` for the per-tool shape
 * that ACs 4, 6, 7, 11, 12 and 13 describe (a `content.length` ceiling, a
 * missing-file isError, a `resultBytesPreTruncation`).
 *
 * Boundary paths mirror the policy-confinement tests above: a temp dir is the
 * repo root, scratchpad lives under `<root>/.nax/scratchpad`, and every
 * filesystem assertion goes through the policy's realpathed `policy.root`
 * so a /tmp -> /private/tmp symlink never makes the test misread equality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import type { CodingTool, ToolRunContext } from "@/tools";
import {
  _resetBuiltinsForTest,
  _resetRegistryForTest,
  compileToolPolicy,
  createCodingToolRuntime,
  DEFAULT_TOOL_MAX_BYTES,
  DEFAULT_TOOL_MAX_FILE_BYTES,
  getCodingTool,
  RESERVED_TOOL_NAMES,
  registerBuiltinCodingTools,
  registerCodingTool,
  SCRATCHPAD_DIR,
  scratchpadListTool,
  scratchpadReadTool,
  scratchpadWriteTool,
} from "@/tools";

let root: string;

beforeEach(() => {
  _resetRegistryForTest();
  _resetBuiltinsForTest();
  root = makeTempDir("nax-scratchpad-");
});

afterEach(() => {
  _resetRegistryForTest();
  _resetBuiltinsForTest();
  cleanupTempDir(root);
});

/** Build the runtime the story's per-AC tests run through. */
function runtime(grants: { tool: string; patterns: string[] }[] = []) {
  const wildcard = ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"].map((tool) => ({
    tool,
    patterns: ["*"],
  }));
  return createCodingToolRuntime({
    policy: compileToolPolicy(grants.length > 0 ? grants : wildcard, root),
  });
}

/**
 * A `ToolRunContext` mirroring what `createCodingToolRuntime` builds in
 * production. The per-tool ACs (4, 6, 7, 11, 12, 13) call the tool's `run`
 * directly with a pre-resolved path -- a unit test exercises the unit, and
 * the policy-runtime path is covered separately in the runtime-level tests.
 */
function ctx(target: string, opts: { maxBytes?: number; maxFileBytes?: number } = {}): ToolRunContext {
  return {
    root,
    resolvedPaths: [target],
    maxBytes: opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES,
  };
}

/**
 * AC1: `SCRATCHPAD_DIR` is exported from the tools barrel and equals the
 * canonical `.nax/scratchpad` path the description pins. The barrel is the
 * only sanctioned import site, so the test reads from `@/tools` rather than
 * reaching into a leaf.
 */
describe("AC1: SCRATCHPAD_DIR is exported from the tools barrel and equals .nax/scratchpad", () => {
  test("the exported constant equals '.nax/scratchpad'", () => {
    expect(SCRATCHPAD_DIR).toBe(".nax/scratchpad");
  });
});

/**
 * AC2: every scratchpad tool declares `scope.confineTo === SCRATCHPAD_DIR`.
 * The intent of the feature is "no scratchpad tool may reach outside the
 * scratchpad directory" -- a tool without `confineTo` would route through
 * `resolveWithin` against the policy root instead and re-open the path the
 * AC is closing.
 */
describe("AC2: every scratchpad tool declares scope.confineTo === SCRATCHPAD_DIR", () => {
  const cases: Array<[string, CodingTool]> = [
    ["ScratchpadWrite", scratchpadWriteTool],
    ["ScratchpadRead", scratchpadReadTool],
    ["ScratchpadList", scratchpadListTool],
  ];
  test.each(cases)("%s.scope.confineTo === SCRATCHPAD_DIR", (_name, tool) => {
    expect(tool.scope.confineTo).toBe(SCRATCHPAD_DIR);
  });
});

/**
 * AC3: ScratchpadWrite and ScratchpadRead each declare `pathFields: ["path"]`.
 * A missing entry would leave the policy with nothing to gate on, so a model
 * could call ScratchpadWrite without any path field at all and the policy
 * would silently approve.
 */
describe("AC3: ScratchpadWrite and ScratchpadRead each declare pathFields containing 'path'", () => {
  const cases: Array<[string, CodingTool]> = [
    ["ScratchpadWrite", scratchpadWriteTool],
    ["ScratchpadRead", scratchpadReadTool],
  ];
  test.each(cases)("%s.scope.pathFields contains 'path'", (_name, tool) => {
    expect(tool.scope.pathFields).toContain("path");
  });
});

/**
 * AC4: runtime callTool("ScratchpadWrite", ...) writes `hello` to the
 * scratchpad and returns a non-error outcome. The boundary companion
 * exercises an empty content string -- the tool must still succeed (an
 * empty file IS a file), and the on-disk content must match exactly.
 */
describe("AC4: ScratchpadWrite writes content to <root>/.nax/scratchpad/<path>", () => {
  test("callTool('ScratchpadWrite', {path:'notes.md', content:'hello'}) writes 'hello' to .nax/scratchpad/notes.md", async () => {
    const out = await runtime().callTool("ScratchpadWrite", { path: "notes.md", content: "hello" });
    expect(out.kind).toBe("ok");
    const scratchpadRoot = join(root, ".nax", "scratchpad");
    expect(readFileSync(join(scratchpadRoot, "notes.md"), "utf8")).toBe("hello");
  });

  // Discriminating boundary: the tool must accept an empty string as a
  // legal payload (ScratchpadWrite is for notes, and a placeholder note IS
  // a note). A regression that rejected empty content on the grounds of
  // "nothing to write" would produce a non-error outcome AND an absent
  // file -- the test pins both shapes so the regression is unambiguous.
  test("an empty content string still creates an empty file and returns ok", async () => {
    const out = await runtime().callTool("ScratchpadWrite", { path: "blank.md", content: "" });
    expect(out.kind).toBe("ok");
    const scratchpadRoot = join(root, ".nax", "scratchpad");
    expect(existsSync(join(scratchpadRoot, "blank.md"))).toBe(true);
    expect(readFileSync(join(scratchpadRoot, "blank.md"), "utf8")).toBe("");
  });
});

/**
 * AC5: writing `a/b/notes.md` creates the intermediate directories.
 * A regression that called `writeFile(target)` without `mkdir -p` first
 * would surface here -- the call would either error or produce a file
 * only at the leaf of an existing parent.
 */
describe("AC5: ScratchpadWrite creates intermediate directories", () => {
  test("writing a/b/notes.md creates both a/ and a/b/ under the scratchpad", async () => {
    const out = await runtime().callTool("ScratchpadWrite", { path: "a/b/notes.md", content: "deep" });
    expect(out.kind).toBe("ok");
    const scratchpadRoot = join(root, ".nax", "scratchpad");
    expect(existsSync(join(scratchpadRoot, "a", "b", "notes.md"))).toBe(true);
    expect(readFileSync(join(scratchpadRoot, "a", "b", "notes.md"), "utf8")).toBe("deep");
  });

  // Deeper boundary: three levels of intermediate directories. A tool that
  // walked only one level would fail this.
  test("writing x/y/z/notes.md creates the full intermediate chain", async () => {
    const out = await runtime().callTool("ScratchpadWrite", { path: "x/y/z/notes.md", content: "x" });
    expect(out.kind).toBe("ok");
    const scratchpadRoot = join(root, ".nax", "scratchpad");
    expect(existsSync(join(scratchpadRoot, "x", "y", "z", "notes.md"))).toBe(true);
  });
});

/**
 * AC6: ScratchpadRead returns the same content ScratchpadWrite wrote.
 * Boundary: a Unicode payload, which the byte-vs-char distinction in
 * `Buffer.byteLength` could trip if the implementer reaches for `length`
 * rather than `Buffer.byteLength`.
 */
describe("AC6: ScratchpadRead returns the content previously written", () => {
  // US-003 changed the shape of the read: it is prefixed with a `[N lines]`
  // header (AC12), so a round trip is the header plus the payload byte-exact
  // underneath it rather than the payload alone.
  test("after a write, ScratchpadRead returns the same content", async () => {
    const rt = runtime();
    await rt.callTool("ScratchpadWrite", { path: "round.md", content: "roundtrip" });
    const out = await rt.callTool("ScratchpadRead", { path: "round.md" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toBe("[1 lines]\nroundtrip");
  });

  // The boundary shape that ACs 12 / 13 pin on top of: a payload large
  // enough that a UTF-8-vs-JS-string-length bug would corrupt it.
  test("a multi-byte Unicode payload round-trips byte-exact", async () => {
    const rt = runtime();
    const payload = "héllo 🌍 — naïve façade";
    await rt.callTool("ScratchpadWrite", { path: "u.md", content: payload });
    const out = await rt.callTool("ScratchpadRead", { path: "u.md" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toBe(`[1 lines]\n${payload}`);
  });
});

/**
 * AC7: ScratchpadRead on a missing path returns `isError: true` and the
 * content names the requested path. The boundary pins that this is a
 * graceful tool error -- the runtime must NOT throw out of the call.
 */
describe("AC7: ScratchpadRead on a missing path returns isError naming the path", () => {
  test("calling ScratchpadRead on 'missing.md' returns isError naming 'missing.md'", async () => {
    const rt = runtime();
    const out = await rt.callTool("ScratchpadRead", { path: "missing.md" });
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.content).toContain("missing.md");
    }
  });

  // Discriminating boundary: the read runs through the per-tool `run` here
  // rather than the runtime's full call path, so a regression in the
  // runtime's catch branch (which surfaces as `kind: "error"` already)
  // cannot mask a missing-file handling defect at the tool layer.
  test("scratchpadReadTool.run on a missing path returns isError naming the path without throwing", async () => {
    const target = join(root, ".nax", "scratchpad", "absent.md");
    let promise!: ReturnType<NonNullable<typeof scratchpadReadTool>["run"]>;
    expect(() => {
      promise = scratchpadReadTool.run({ path: "absent.md" }, ctx(target));
    }).not.toThrow();
    const settled = await promise;
    expect(settled.isError).toBe(true);
    expect(settled.content).toContain("absent.md");
  });
});

/**
 * AC8: ScratchpadWrite with `../../src/index.ts` returns a refused outcome
 * AND creates no file at any location the path resolves to. The boundary
 * is a sibling directory the model could plausibly try to create; the
 * precondition for that file's absence is the assertion's whole point.
 */
describe("AC8: ScratchpadWrite with a '..' escape is refused and writes nothing outside the scratchpad", () => {
  test("callTool('ScratchpadWrite', {path:'../../src/index.ts', ...}) is denied and creates no file at the escape target", async () => {
    // Pre-create the parent directory the `..` resolves into, so a
    // regression that wrote outside the scratchpad would create a real
    // `index.ts` here. A regression that wrote nowhere would also pass
    // this assertion; the discriminating companion below adds depth.
    const escapeTarget = join(root, "src", "index.ts");
    mkdirSync(join(root, "src"), { recursive: true });

    const out = await runtime().callTool("ScratchpadWrite", {
      path: "../../src/index.ts",
      content: "escape",
    });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
    expect(existsSync(escapeTarget)).toBe(false);
  });

  // Discriminating boundary: an escape that lands at a path inside the
  // repository root but outside the scratchpad. The first test only proves
  // a file was not created -- it does not distinguish "did not write" from
  // "wrote to a different wrong path". Pinning the exact non-existence of
  // the resolved target catches the second shape too.
  test("a '..' escape that resolves inside the repo root but outside the scratchpad is also denied and creates no file", async () => {
    // From `.nax/scratchpad/`, `../package.json` resolves to `<root>/package.json`
    // -- inside the policy root, outside the confined directory. This is the
    // discriminating case: it is NOT an absolute escape, just a relative
    // traversal out of `.nax/scratchpad/`, which is the whole seam.
    const escapeTarget = join(root, "package.json");

    const out = await runtime().callTool("ScratchpadWrite", {
      path: "../package.json",
      content: "x",
    });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
    expect(existsSync(escapeTarget)).toBe(false);
  });
});

/**
 * AC9: ScratchpadList names both written paths. The boundary pins a write
 * at depth -- a regression in the listing's depth scan would miss it.
 */
describe("AC9: ScratchpadList names every written path", () => {
  test("after two ScratchpadWrite calls, ScratchpadList content names both paths", async () => {
    const rt = runtime();
    await rt.callTool("ScratchpadWrite", { path: "alpha.md", content: "a" });
    await rt.callTool("ScratchpadWrite", { path: "beta.md", content: "b" });
    const out = await rt.callTool("ScratchpadList", {});
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.content).toContain("alpha.md");
      expect(out.content).toContain("beta.md");
    }
  });

  // Discriminating boundary: a Write at depth must still appear, not be
  // filtered by the listing's depth scan. A two-level path guards against
  // a `Bun.Glob("*.md")` regression that misses nested entries.
  test("a write at depth appears in the list", async () => {
    const rt = runtime();
    await rt.callTool("ScratchpadWrite", { path: "deep/nested/notes.md", content: "x" });
    const out = await rt.callTool("ScratchpadList", {});
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain("notes.md");
  });
});

/**
 * AC10: ScratchpadList on a missing scratchpad directory is a non-error
 * outcome reporting no entries. The tool's contract is "successful empty
 * output", not a thrown ENOENT -- a model that never wrote anything
 * should see a clean "nothing here" rather than a crash to recover from.
 */
describe("AC10: ScratchpadList on a missing directory returns non-error with no entries", () => {
  test("calling ScratchpadList on a fresh repo returns ok with no error", async () => {
    const out = await runtime().callTool("ScratchpadList", {});
    expect(out.kind).toBe("ok");
  });

  // Per-tool boundary: drive `scratchpadListTool.run` directly. The runtime
  // path is covered above; this pins that the tool itself is the source of
  // the empty-listing contract, not a runtime adapter.
  test("scratchpadListTool.run on a missing scratchpad directory returns a non-error empty result", async () => {
    const result = await scratchpadListTool.run({}, ctx(join(root, ".nax", "scratchpad")));
    expect(result.isError).toBeFalsy();
  });
});

/**
 * AC11: ScratchpadWrite content larger than `ctx.maxFileBytes` returns
 * `isError: true` naming the limit AND writes no file. The boundary pins
 * the file's absence -- a regression that wrote first and checked the
 * ceiling after would create a file the policy would later have to
 * explain the existence of.
 */
describe("AC11: ScratchpadWrite over maxFileBytes returns isError naming the limit and writes nothing", () => {
  test("scratchpadWriteTool.run rejects a content that exceeds maxFileBytes and does not write the file", async () => {
    const target = join(root, ".nax", "scratchpad", "huge.md");
    // Pick a content size one byte over the ceiling so a regression that
    // checks `>=` instead of `>` would still trip on this case.
    const maxFileBytes = 64;
    const oversized = "x".repeat(maxFileBytes + 1);
    const result = await scratchpadWriteTool.run(
      { path: "huge.md", content: oversized },
      ctx(target, { maxFileBytes }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`${maxFileBytes}`);
    expect(existsSync(target)).toBe(false);
  });

  // Discriminating boundary: a content size exactly AT the limit must
  // succeed. An off-by-one regression in either direction breaks here --
  // this is the only AC that fixes the boundary at the ceiling.
  test("content exactly at maxFileBytes is allowed (the ceiling is inclusive)", async () => {
    const target = join(root, ".nax", "scratchpad", "edge.md");
    const maxFileBytes = 64;
    const atLimit = "y".repeat(maxFileBytes);
    const result = await scratchpadWriteTool.run({ path: "edge.md", content: atLimit }, ctx(target, { maxFileBytes }));
    expect(result.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(atLimit);
  });
});

/**
 * US-003 AC12: ScratchpadRead on a file larger than `ctx.readCeiling` is
 * bounded at `readCeiling` by the tool itself; the model-facing cap at
 * `ctx.maxBytes` is now the `after_tool` policy's job, NOT the tool's.
 * ScratchpadRead's schema gains `offset`/`limit`, and the read begins
 * with a `[N lines]` header.
 */
describe("US-003 AC12: ScratchpadRead is bounded at readCeiling by the tool; maxBytes is the policy's job", () => {
  test("scratchpadReadTool.run returns the FULL file content when readCeiling > file size", async () => {
    // The tool no longer caps at ctx.maxBytes. The full file is returned
    // to the runtime's after_tool handler, which shapes it to MODEL_MAX_BYTES
    // and writes the spill file.
    const fileBytes = "z".repeat(256);
    const target = join(root, ".nax", "scratchpad", "big.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(target, fileBytes);

    // `ctx.maxBytes = 32` would have truncated at the tool layer before;
    // now the tool is bounded at `readCeiling` only. We deliberately use
    // a small maxBytes to make this discrimination explicit: the tool's
    // output is bigger than maxBytes.
    const result = await scratchpadReadTool.run({ path: "big.md" }, ctx(target, { maxBytes: 32 }));
    expect(result.isError).toBeFalsy();
    // The full file body is present in the tool's output (above the cap).
    expect(result.content.length).toBeGreaterThan(32);
  });

  test("a file under maxBytes is returned whole under a [N lines] header (US-003 schema shape)", async () => {
    const fileBytes = "small file\n";
    const target = join(root, ".nax", "scratchpad", "small.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(target, fileBytes);

    const result = await scratchpadReadTool.run({ path: "small.md" }, ctx(target, { maxBytes: 4096 }));
    expect(result.isError).toBeFalsy();
    // The header comes first, then the body — `[1 lines]\nsmall file\n`.
    expect(result.content.startsWith("[1 lines]")).toBe(true);
    expect(result.content).toContain("small file");
  });

  test("the schema advertises offset and limit matching readTool's spelling", () => {
    const schema = scratchpadReadTool.inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    // Reflective helper that avoids `as <CapitalisedType>` casts (which
    // would trip the looseCast ratchet) by using object-shape narrowing
    // and inline annotations.
    const lookup = (key: string): { type?: string; minimum?: number } => {
      const raw: unknown = (schema as { properties?: unknown }).properties;
      if (typeof raw !== "object" || raw === null) {
        throw new Error("expected schema.properties to be an object");
      }
      const value: unknown = (raw as { [k: string]: unknown })[key];
      if (typeof value !== "object" || value === null) {
        throw new Error(`expected schema.properties.${key} to be an object`);
      }
      return value as { type?: string; minimum?: number };
    };
    expect(lookup("path").type).toBe("string");
    expect(lookup("offset").type).toBe("integer");
    expect(lookup("offset").minimum).toBe(1);
    expect(lookup("limit").type).toBe("integer");
    expect(lookup("limit").minimum).toBe(1);
  });

  // Discriminating boundary: the model-facing cap now lives at the runtime
  // level (after_tool). A regression that re-introduced per-tool truncation
  // would surface here: the runtime sees the un-truncated body and the
  // policy shapes it.
  test("runtime.callTool('ScratchpadRead', ...) returns content byte-length <= maxBytes when the file is larger", async () => {
    const maxBytes = 32;
    const fileBytes = "z".repeat(maxBytes * 4);
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(join(root, ".nax", "scratchpad", "big.md"), fileBytes);

    const rt = createCodingToolRuntime({
      policy: compileToolPolicy(
        ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"].map((tool) => ({ tool, patterns: ["*"] })),
        root,
      ),
      maxBytes,
    });

    const outcome = await rt.callTool("ScratchpadRead", { path: "big.md" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(maxBytes);
    }
  });
});

/**
 * AC13: ScratchpadRead reports `resultBytesPreTruncation` equal to the
 * file's full byte length. The boundary is `maxBytes` >= the file size --
 * pre-truncation must STILL equal the full size even when no truncation
 * happened, since "truncated by zero" is still "we knew the size".
 */
describe("AC13: ScratchpadRead reports resultBytesPreTruncation === full file byte length", () => {
  test("scratchpadReadTool.run sets resultBytesPreTruncation to the full file size when truncated", async () => {
    const maxBytes = 32;
    const fileBytes = "z".repeat(maxBytes * 4);
    const target = join(root, ".nax", "scratchpad", "t.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(target, fileBytes);

    const result = await scratchpadReadTool.run({ path: "t.md" }, ctx(target, { maxBytes }));
    expect(result.isError).toBeFalsy();
    expect(result.resultBytesPreTruncation).toBe(Buffer.byteLength(fileBytes, "utf8"));
  });

  // Discriminating boundary: a file at or below maxBytes still has its
  // pre-truncation size set to the FULL file size -- not zero, not the
  // truncated length. The audit log uses this number to compute "how much
  // did we discard", and a zero reading would silently mis-answer that
  // question for an untruncated file.
  test("scratchpadReadTool.run sets resultBytesPreTruncation to the full file size even when no truncation happened", async () => {
    const maxBytes = 4096;
    const fileBytes = "tiny\n";
    const target = join(root, ".nax", "scratchpad", "tiny.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(target, fileBytes);

    const result = await scratchpadReadTool.run({ path: "tiny.md" }, ctx(target, { maxBytes }));
    expect(result.isError).toBeFalsy();
    expect(result.resultBytesPreTruncation).toBe(Buffer.byteLength(fileBytes, "utf8"));
  });
});

/**
 * AC14: after `registerBuiltinCodingTools()`, the registry holds all three
 * scratchpad tools. A regression that registered only one, or that made the
 * idempotence guard short-circuit the registration entirely, would surface
 * here.
 */
describe("AC14: registerBuiltinCodingTools() registers ScratchpadWrite / ScratchpadRead / ScratchpadList", () => {
  test("after registration, getCodingTool returns each of the three scratchpad tools", () => {
    registerBuiltinCodingTools();
    expect(getCodingTool("ScratchpadWrite")?.name).toBe("ScratchpadWrite");
    expect(getCodingTool("ScratchpadRead")?.name).toBe("ScratchpadRead");
    expect(getCodingTool("ScratchpadList")?.name).toBe("ScratchpadList");
  });

  // Discriminating boundary: a second call to `registerBuiltinCodingTools()`
  // must be a no-op (the existing `builtinsRegistered` flag). Without this
  // guarantee the test's afterEach reset would not get back to the right
  // starting state, but more importantly a registration that ran twice
  // could double-register with side effects in a future schema-bearing tool.
  test("calling registerBuiltinCodingTools() twice is idempotent and still returns the three scratchpad tools", () => {
    registerBuiltinCodingTools();
    registerBuiltinCodingTools();
    expect(getCodingTool("ScratchpadWrite")?.name).toBe("ScratchpadWrite");
    expect(getCodingTool("ScratchpadRead")?.name).toBe("ScratchpadRead");
    expect(getCodingTool("ScratchpadList")?.name).toBe("ScratchpadList");
  });
});

/**
 * AC15: third-party `registerCodingTool({name: "ScratchpadWrite"})` throws
 * `TOOL_NAME_RESERVED`. The boundary is the `RESERVED_TOOL_NAMES` list
 * itself: the reserved list MUST include the three new names so this code
 * path can even run -- a regression that registered the tools but did not
 * reserve the names would let a third party shadow them.
 */
describe("AC15: a third-party registerCodingTool using a scratchpad name throws TOOL_NAME_RESERVED", () => {
  test.each(["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"] as const)(
    "registerCodingTool({name: '%s'}) throws a NaxError with code TOOL_NAME_RESERVED",
    (name) => {
      try {
        // `CodingTool.name` is typed as plain `string`, so the new tool
        // names do not need a type-lie to construct a shadow attempt.
        registerCodingTool({
          name,
          description: "shadow attempt",
          inputSchema: { type: "object", properties: {} },
          scope: { pathFields: [] },
          async run() {
            return { content: "" };
          },
        });
        throw new Error("expected registerCodingTool to throw");
      } catch (err) {
        assertNaxError(err, "registerCodingTool rejection");
        expect(err.code).toBe("TOOL_NAME_RESERVED");
      }
    },
  );

  // Discriminating boundary: the names themselves must appear in
  // `RESERVED_TOOL_NAMES` -- the reservation is the seam that lets the
  // throw fire at all. If a future refactor moves the reservation off the
  // barrel's exported list, this test fails before the throw can.
  test("RESERVED_TOOL_NAMES includes each of the three scratchpad names", () => {
    expect(RESERVED_TOOL_NAMES as readonly string[]).toContain("ScratchpadWrite");
    expect(RESERVED_TOOL_NAMES as readonly string[]).toContain("ScratchpadRead");
    expect(RESERVED_TOOL_NAMES as readonly string[]).toContain("ScratchpadList");
  });
});
