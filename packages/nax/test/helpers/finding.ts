/**
 * `Finding` fixtures.
 *
 * Four required fields (`source`, `severity`, `category`, `message`), of which
 * tests typically set only a subset. Sites wrote `ruleId` — a field `Finding`
 * does not have — and the excess-property error masked the fact that required
 * `source`/`category` were missing. Complete defaults here mean the compiler
 * checks whichever field the test is actually asserting on
 * (#1514 dead-fixture-keys).
 */
import type { Finding } from "@/findings/types";

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "lint",
    severity: "warning",
    category: "",
    message: "",
    ...overrides,
  };
}
