import { describe, expect, test } from "bun:test";
import { BUN_CHECK_SAMPLE } from "@test/fixtures/bun-check";
import { bunCheckStrategy } from "@/review/typecheck-parsing/strategies/bun-check";

const FIRST = '<error file="a.ts" line="1" column="2" code="TS2322">First';
const SECOND = '<error file="b.ts" line="3">Second';

describe("bunCheckStrategy", () => {
  test("AC-10 returns blocks in document order", () => {
    const result = bunCheckStrategy.parse(`${FIRST}\n</error>\n${SECOND}\n</error>`);
    expect(result?.diagnostics.map((d) => d.file)).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-11 accepts reordered attributes", () => {
    const result = bunCheckStrategy.parse('<error code="TS2322" column="2" line="1" file="a.ts">First\n</error>');
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0]).toMatchObject({ file: "a.ts", line: 1, column: 2, code: "2322" });
    expect(bunCheckStrategy.parse(`${FIRST}\n</error>`)?.diagnostics[0]).toMatchObject({
      file: "a.ts",
      line: 1,
      column: 2,
      code: "2322",
    });
  });

  test.each([
    ["AC-12 warning", '<warning file="a.ts" line="1">Warning\n</warning>'],
    ["AC-13 missing file", '<error line="1">Missing file\n</error>'],
    ["AC-14 missing line", '<error file="a.ts">Missing line\n</error>'],
    ["empty output", ""],
    ["unrelated output", "Checked all files"],
  ])("%s returns null", (_name, output) => {
    expect(bunCheckStrategy.parse(output)).toBeNull();
  });

  test("AC-15 accepts an unclosed sample", () => {
    const result = bunCheckStrategy.parse(BUN_CHECK_SAMPLE.replace("</error>\n", ""));
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0]?.message).toBe("No overload matches this call.");
  });

  test("AC-18 prioritizes inline message", () => {
    const message = "Type 'string' is not assignable to type 'number'.";
    expect(
      bunCheckStrategy.parse(`<error file="a.ts" line="1" code="TS2322">${message}\nOther\n</error>`)?.diagnostics[0]
        ?.message,
    ).toBe(message);
  });

  test("AC-19/20 separates unclosed blocks and raw boundaries", () => {
    const result = bunCheckStrategy.parse(`${FIRST}\n${SECOND}`);
    expect(result?.diagnostics).toHaveLength(2);
    expect(result?.diagnostics[0]?.raw).toBe(FIRST);
    expect(result?.diagnostics[1]?.raw).toBe(SECOND);
  });

  test("skips blank and tag lines when selecting a message", () => {
    const result = bunCheckStrategy.parse(
      '<error file="a.ts" line="1">\n\n<source>\n</source>\n<related file="b.ts" line="2">Other</related>\nMessage\n</error>',
    );
    expect(result?.diagnostics).toEqual([
      { file: "a.ts", line: 1, column: undefined, code: undefined, message: "Message", raw: expect.any(String) },
    ]);
  });

  test("keeps numeric codes and handles CRLF", () => {
    expect(
      bunCheckStrategy.parse('<error file="a.ts" line="1" code="2322">\r\nMessage\r\n</error>')?.diagnostics[0]?.code,
    ).toBe("2322");
  });
});
