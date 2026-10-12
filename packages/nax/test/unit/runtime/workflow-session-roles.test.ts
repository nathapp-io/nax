import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime/session-role";

describe("workflow session roles", () => {
  test.each(["wf-implementer", "wf-story-review", "wf-rereview", "wf-branch-review", "wf-branch-fix"])(
    "%s is a known role",
    (role) => {
      expect(KNOWN_SESSION_ROLES).toContain(role as (typeof KNOWN_SESSION_ROLES)[number]);
      expect(isSessionRole(role)).toBe(true);
    },
  );
});
