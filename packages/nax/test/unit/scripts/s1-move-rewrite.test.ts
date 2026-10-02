import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_ENTRY,
  type InternalNeeds,
  PUBLIC_ENTRY,
  rewriteMovedFile,
  rewriteStayingFile,
} from "@scripts/lib/s1-move/rewrite";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content = "export const x = 1;\n"): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** nax paths -> nax-agent paths for the fixture below. */
const DEST = new Map([
  ["src/agents/native/client.ts", "src/native/client.ts"],
  ["src/agents/native/complete.ts", "src/native/complete.ts"],
  ["src/agents/native/models.ts", "src/native/models.ts"],
  ["src/agents/infra/index.ts", "src/infra/index.ts"],
  ["src/agents/session-types.ts", "src/session/session-types.ts"],
  ["src/permissions/approvals-link.ts", "src/permissions/approvals-link.ts"],
  ["src/tools/index.ts", "src/tools/index.ts"],
  ["src/tools/git.ts", "src/tools/git.ts"],
  ["src/utils/sort.ts", "src/internal/sort.ts"],
  ["test/helpers/temp.ts", "test/helpers/temp.ts"],
  ["test/helpers/index.ts", "test/helpers/index.ts"],
]);

function fixture(): void {
  root = makeTempDir("s1-move-rewrite-");
  for (const rel of DEST.keys()) write(rel);
  write("src/config/index.ts");
}

function needs(): InternalNeeds {
  return { modules: new Set(), namespaces: new Map() };
}

describe("rewriteMovedFile", () => {
  test("keeps a relative specifier whose relation survives, aliases the rest", () => {
    fixture();
    const src = [
      'import { m } from "./models";',
      'import { t } from "@/tools";',
      'import { s } from "../../utils/sort";',
      'import { g } from "@/tools/git";',
    ].join("\n");
    const { text, errors } = rewriteMovedFile(root, "src/agents/native/client.ts", src, DEST);
    expect(errors).toEqual([]);
    expect(text).toBe(
      [
        'import { m } from "./models";',
        'import { t } from "#src/tools/index";',
        'import { s } from "#src/internal/sort";',
        'import { g } from "#src/tools/git";',
      ].join("\n"),
    );
  });

  test("aliases a relative specifier whose relation the move breaks", () => {
    fixture();
    // Real pairs from the manifest (scripts/s1-move-manifest.json), not synthetic ones:
    // both files land in a different directory, so the old relative path no longer names
    // the target. `complete.ts` moves up a level (native/) and keeps reaching the session
    // contract, which moves sideways into session/; `approvals-link.ts` stays put and
    // reaches agents/infra/, which moves to infra/. 37 such sites exist on the real tree.
    //
    // The sibling test pins a depth change incidentally, inside an assertion that reads
    // as "this is how sort is reached". This one isolates a relocation — the shape most of
    // those 37 take — and names the reason: keep the old text here and it dangles.
    const broken: readonly [string, string, string][] = [
      ["src/agents/native/complete.ts", "../session-types", "#src/session/session-types"],
      ["src/permissions/approvals-link.ts", "../agents/infra", "#src/infra/index"],
    ];
    for (const [from, spec, alias] of broken) {
      const { text, errors } = rewriteMovedFile(root, from, `import { x } from "${spec}";\n`, DEST);
      expect(errors).toEqual([]);
      expect(text).toBe(`import { x } from "${alias}";\n`);
    }
  });

  test("points moved tests at nax-agent's helper barrel", () => {
    fixture();
    const src = 'import { makeTemp } from "@test/helpers";\nimport { t } from "../helpers/temp";\n';
    const { text } = rewriteMovedFile(root, "test/unit/x.test.ts", src, DEST);
    expect(text).toBe('import { makeTemp } from "#test/helpers/index";\nimport { t } from "../helpers/temp";\n');
  });

  test("reports an import of a file that stays in nax", () => {
    fixture();
    const { errors } = rewriteMovedFile(root, "src/tools/git.ts", 'import { c } from "@/config";\n', DEST);
    expect(errors).toEqual(['src/tools/git.ts: "@/config" reaches src/config/index.ts, which stays in nax']);
  });
});

describe("rewriteStayingFile", () => {
  test("routes a public module to the package entry and a deep module to /internal", () => {
    fixture();
    const n = needs();
    const src = 'import { getCodingTool } from "@/tools";\nimport { byCodePoint } from "./utils/sort";\n';
    const { text } = rewriteStayingFile(root, "src/stays.ts", src, DEST, n);
    expect(text).toBe(
      `import { getCodingTool } from "${PUBLIC_ENTRY}";\nimport { byCodePoint } from "${INTERNAL_ENTRY}";\n`,
    );
    expect([...n.modules]).toEqual(["src/internal/sort.ts"]);
  });

  test("routes a public-module import that names a _ seam to /internal", () => {
    fixture();
    const n = needs();
    const { text } = rewriteStayingFile(root, "src/stays.ts", 'import { _bashToolDeps, x } from "@/tools";\n', DEST, n);
    expect(text).toBe(`import { _bashToolDeps, x } from "${INTERNAL_ENTRY}";\n`);
    expect([...n.modules]).toEqual(["src/tools/index.ts"]);
  });

  test("turns a namespace import into the namespace /internal re-exports", () => {
    fixture();
    const n = needs();
    const { text } = rewriteStayingFile(root, "test/a.test.ts", 'import * as gitTool from "@/tools/git";\n', DEST, n);
    expect(text).toBe(`import { gitModule as gitTool } from "${INTERNAL_ENTRY}";\n`);
    expect([...n.namespaces]).toEqual([["src/tools/git.ts", "gitModule"]]);
  });

  test("refuses a wholesale re-export of a moved module", () => {
    fixture();
    const { errors } = rewriteStayingFile(root, "src/stays.ts", 'export * from "./tools/git";\n', DEST, needs());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("export *");
  });

  test("leaves imports of staying code and of the helpers barrel alone", () => {
    fixture();
    // The barrel, not a deep helper path: check-alias-internals flags `@test/<dir>/<file>` even inside a string.
    const src = 'import { c } from "@/config";\nimport { makeTemp } from "@test/helpers";\n';
    expect(rewriteStayingFile(root, "test/a.test.ts", src, DEST, needs()).text).toBe(src);
  });
});
