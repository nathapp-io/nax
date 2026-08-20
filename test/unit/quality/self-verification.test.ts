import { describe, expect, test } from "bun:test";
import { parseSelfVerificationMarker } from "@/quality/self-verification";

describe("parseSelfVerificationMarker", () => {
  test("parses explicit marker statuses", () => {
    const output = `
some output
SELF_VERIFICATION:
lint: pass
typecheck: pre_existing
PRE_EXISTING_FAILURES: [{"packageDir":"packages/api","file":"src/x.ts","tool":"typecheck","message":"existing error"}]
`;
    const parsed = parseSelfVerificationMarker(output, "packages/api");
    expect(parsed.missingMarker).toBe(false);
    expect(parsed.lint).toBe("pass");
    expect(parsed.typecheck).toBe("pre_existing");
    expect(parsed.preExistingFailures).toHaveLength(1);
    expect(parsed.preExistingFailures[0]?.tool).toBe("typecheck");
  });

  test("returns missing marker when block is absent", () => {
    const parsed = parseSelfVerificationMarker("plain output", "packages/web");
    expect(parsed.missingMarker).toBe(true);
    expect(parsed.lint).toBe("skip");
    expect(parsed.typecheck).toBe("skip");
    expect(parsed.preExistingFailures).toEqual([]);
  });

  test("keeps malformed PRE_EXISTING_FAILURES as raw fallback message", () => {
    const output = `
SELF_VERIFICATION:
lint: pre_existing
typecheck: skip
PRE_EXISTING_FAILURES: [broken
`;
    const parsed = parseSelfVerificationMarker(output, "packages/api");
    expect(parsed.preExistingFailures).toHaveLength(1);
    expect(parsed.preExistingFailures[0]?.message).toContain("[broken");
    expect(parsed.preExistingFailures[0]?.tool).toBe("lint");
  });

  test("infers typecheck fallback tool when typecheck is pre_existing", () => {
    const output = `
SELF_VERIFICATION:
lint: skip
typecheck: pre_existing
PRE_EXISTING_FAILURES: [broken
`;
    const parsed = parseSelfVerificationMarker(output, "packages/api");
    expect(parsed.preExistingFailures[0]?.tool).toBe("typecheck");
  });

  test("parses marker even when blank lines appear inside block", () => {
    const output = `
SELF_VERIFICATION:
lint: pass

typecheck: pass
PRE_EXISTING_FAILURES: []

next text
`;
    const parsed = parseSelfVerificationMarker(output, "packages/api");
    expect(parsed.lint).toBe("pass");
    expect(parsed.typecheck).toBe("pass");
  });
});
