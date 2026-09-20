/**
 * US-001 AC14, AC15: tool name → truncation direction.
 *
 * Pin the direction table so a future regression that extends the wrong
 * list (say, adding `Grep` to tail-with-first-line) fails fast at unit
 * level rather than at integration.
 *
 * Boundary case for AC15: an unrecognised name MUST default to `head`. The
 * implementer is free to use a closed-set lookup, an inclusion test, or a
 * `Set.has` check — this test pins the OBSERVABLE behaviour only.
 */

import { describe, expect, test } from "bun:test";
import { type TruncationDirection, truncationDirectionFor } from "@/tools";

const TAIL_NAMES = ["Bash", "RunCommand", "Exec"] as const;
const HEAD_NAMES = ["Read", "Grep", "Git", "ScratchpadRead"] as const;

describe("AC14: truncationDirectionFor returns tail-with-first-line for Bash/RunCommand/Exec", () => {
  test.each(TAIL_NAMES.map((n) => [n]))("%s", (name) => {
    expect(truncationDirectionFor(name)).toBe("tail-with-first-line");
  });
});

describe("AC15: truncationDirectionFor returns head for Read/Grep/Git/ScratchpadRead and unrecognised names", () => {
  test.each(HEAD_NAMES.map((n) => [n]))("%s", (name) => {
    expect(truncationDirectionFor(name)).toBe("head");
  });

  test("an unrecognised name defaults to head", () => {
    const unknown = "NotARealTool";
    const dir: TruncationDirection = truncationDirectionFor(unknown);
    expect(dir).toBe("head");
  });

  test("the empty string defaults to head", () => {
    expect(truncationDirectionFor("")).toBe("head");
  });
});
