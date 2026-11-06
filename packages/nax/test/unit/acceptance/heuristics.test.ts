import { describe, expect, test } from "bun:test";
import { hasLikelyTestContent, isStubTestContent, SKELETON_WATERMARK } from "@/acceptance/heuristics";

// ─── hasLikelyTestContent ────────────────────────────────────────────────────

describe("hasLikelyTestContent()", () => {
  test.each([
    ["js describe block", 'describe("adds", () => {});'],
    ["js test/it call", 'it("adds", () => {});'],
    ["js bare test call", 'test("adds", () => {});'],
    ["js expect assertion", "expect(add(1, 2)).toBe(3);"],
    ["go test function", "func TestAdd(t *testing.T) {"],
    ["python test function", "def test_add():"],
    ["rust test attribute", "#[test]\nfn adds() {}"],
  ])("detects %s as test content", (_label, content) => {
    expect(hasLikelyTestContent(content)).toBe(true);
  });

  test.each([
    ["plain implementation", "export function add(a: number, b: number): number {\n  return a + b;\n}"],
    ["a word that merely ends in 'test'", "const latest = computeLatest(items);"],
    ["a python non-test function", "def add(a, b):\n    return a + b"],
    ["empty content", ""],
  ])("does not treat %s as test content", (_label, content) => {
    expect(hasLikelyTestContent(content)).toBe(false);
  });
});

// ─── isStubTestContent ───────────────────────────────────────────────────────

describe("isStubTestContent()", () => {
  test("SKELETON_WATERMARK is the marker generateSkeletonTests writes", () => {
    expect(SKELETON_WATERMARK).toBe("nax:skeleton-acceptance-test");
  });

  test("a watermarked file is a stub in any language's comment syntax", () => {
    expect(isStubTestContent(`// ${SKELETON_WATERMARK}\nfn test() {}`)).toBe(true);
    expect(isStubTestContent(`# ${SKELETON_WATERMARK}\ndef test_x():\n    pass`)).toBe(true);
    expect(isStubTestContent(`/* ${SKELETON_WATERMARK} */\npackage main`)).toBe(true);
  });

  test("the watermark wins even when the file also carries a real assertion", () => {
    expect(isStubTestContent(`// ${SKELETON_WATERMARK}\nexpect(add(1, 2)).toBe(3);`)).toBe(true);
  });

  test.each([
    ["placeholder passing toBe(true)", "expect(true).toBe(true);"],
    ["placeholder passing toBe(false)", "expect(true).toBe(false);"],
    ["placeholder with wide spacing", "expect( true ).toBe( false );"],
    // A second true/false pair is still a placeholder, not a real assertion.
    ["stacked true/false placeholders", "expect(true).toBe(true);\nexpect(false).toBe(true);"],
  ])("treats %s as a stub", (_label, content) => {
    expect(isStubTestContent(content)).toBe(true);
  });

  test("a placeholder alongside any real assertion is not a stub", () => {
    expect(isStubTestContent("expect(true).toBe(true);\nexpect(add(1, 2)).toBe(3);")).toBe(false);
  });

  test.each([
    ["real js assertions only", "expect(add(1, 2)).toBe(3);"],
    ["a bare-toBe(false) shape with no expect(true)", "expect(false).toBe(true);"],
    ["no assertion at all", "export const answer = 42;"],
    ["python placeholder shapes", "def test_x():\n    assert True"],
    ["go placeholder shapes", 'func TestX(t *testing.T) {\n\tt.Fatal("todo")\n}'],
    ["rust placeholder shapes", '#[test]\nfn x() {\n\tpanic!("todo")\n}'],
  ])("does not treat %s as a stub", (_label, content) => {
    expect(isStubTestContent(content)).toBe(false);
  });
});
