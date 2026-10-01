/**
 * #1898: isStubTestContent must recognise the skeletons generateSkeletonTests
 * actually emits — Python, Go and Rust, not only the JS/TS assertion form.
 *
 * Both directions matter. A false negative leaves acceptance stub recovery
 * inert for those languages (the bug). A false positive is worse: the stub
 * guard responds by regenerating, so a real suite misread as a stub would be
 * thrown away. Each language is therefore asserted twice — skeleton detected,
 * real test not detected.
 */

import { describe, expect, test } from "bun:test";
import { generateSkeletonTests, isStubTestContent } from "@/acceptance";
import type { AcceptanceCriterion } from "@/acceptance/types";

const CRITERIA: AcceptanceCriterion[] = [
  { id: "AC-1", text: "the sweep fetches cold buckets", lineNumber: 1 },
  { id: "AC-2", text: "the sweep skips warm buckets", lineNumber: 2 },
];

describe("#1898: skeleton detection across generated languages", () => {
  for (const language of ["python", "go", "rust"] as const) {
    test(`detects the ${language} skeleton generateSkeletonTests emits`, () => {
      const skeleton = generateSkeletonTests("test-feature", CRITERIA, undefined, language);
      expect(isStubTestContent(skeleton)).toBe(true);
    });
  }

  test("still detects the JS/TS skeleton (no regression)", () => {
    const skeleton = generateSkeletonTests("test-feature", CRITERIA, undefined, undefined);
    expect(isStubTestContent(skeleton)).toBe(true);
  });
});

describe("#1898: real tests are not misread as stubs", () => {
  // Every case below was a confirmed false positive under the shape-based
  // detector that preceded the watermark. The stub guard answers a positive by
  // deleting the file, so these stay as regression guards.

  test("a real python test with assertions is not a stub", () => {
    const real = `import pytest

def test_cold_buckets_are_fetched():
    result = sweep(["a", "b"])
    assert result.fetched == 2
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a real python test is not a stub even when one branch calls pytest.fail", () => {
    const real = `import pytest

def test_cold_buckets_are_fetched():
    result = sweep(["a", "b"])
    if result is None:
        pytest.fail("not implemented")
    assert result.fetched == 2
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a python assertion is not hidden by a '#' inside a string literal", () => {
    const real = `import pytest

def test_tags_render():
    for tag in ["#a"]:
        assert render(tag) == tag
    pytest.fail("not implemented") if False else None
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a real python test using numpy assert helpers is not a stub", () => {
    const real = `import numpy as np
import pytest

def test_allclose():
    if compute() is None:
        pytest.fail("not implemented")
    np.testing.assert_allclose(compute(), 2.0)
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a real go test with assertions is not a stub", () => {
    const real = `package acceptance_test

import "testing"

func TestColdBucketsAreFetched(t *testing.T) {
\tgot := Sweep([]string{"a", "b"})
\tif got != 2 {
\t\tt.Errorf("got %d, want 2", got)
\t}
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a go assertion is not hidden by a '//' inside a URL literal", () => {
    const real = `package acceptance_test

import "testing"

func TestFetch(t *testing.T) {
\tif !ok {
\t\tt.Fatal("not implemented")
\t}
\tif got := fetch("http://api.example.com/x"); got != 200 {
\t\tt.Errorf("bad %d", got)
\t}
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a go test asserting via bare t.Fatal is not a stub", () => {
    const real = `package acceptance_test

import "testing"

func TestA(t *testing.T) {
\tif !ok {
\t\tt.Fatal("not implemented")
\t}
}

func TestB(t *testing.T) {
\tif got != want {
\t\tt.Fatal("wrong count")
\t}
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a go test asserting via cmp.Diff is not a stub", () => {
    const real = `package acceptance_test

import (
\t"testing"

\t"github.com/google/go-cmp/cmp"
)

func TestDiff(t *testing.T) {
\tif !ok {
\t\tt.Fatal("not implemented")
\t}
\tif diff := cmp.Diff(want, got); diff != "" {
\t\tt.Fatal(diff)
\t}
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a real rust test with assertions is not a stub", () => {
    const real = `#[cfg(test)]
mod tests {
    #[test]
    fn cold_buckets_are_fetched() {
        let got = sweep(vec!["a", "b"]);
        assert_eq!(got, 2);
    }
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a rust #[should_panic] test that genuinely panics is not a stub", () => {
    const real = `#[cfg(test)]
mod tests {
    #[test]
    #[should_panic(expected = "not implemented")]
    fn todo_path_panics() {
        panic!("not implemented");
    }
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a rust test asserting via assert_matches! is not a stub", () => {
    const real = `#[cfg(test)]
mod tests {
    #[test]
    fn parses() {
        let v = parse("x");
        assert_matches!(v, Ok(_));
    }
}
`;
    expect(isStubTestContent(real)).toBe(false);
  });

  test("a TS test is not condemned by another language's placeholder inside a fixture string", () => {
    const real = [
      `const fixture = 'func TestX(t *testing.T) { t.Fatal("not implemented") }';`,
      `test("renders go source", () => { expect(render(fixture)).toBe("ok") });`,
    ].join("\n");
    expect(isStubTestContent(real)).toBe(false);
  });

  test("an empty file is not a stub", () => {
    expect(isStubTestContent("")).toBe(false);
  });
});
