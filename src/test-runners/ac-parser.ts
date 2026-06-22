/**
 * Acceptance Criteria Failure Parser
 *
 * Extracts AC-ID strings (e.g. "AC-1", "AC-HOOK") from test runner output.
 * Framework-aware: uses detectFramework() to apply only the relevant pattern
 * per runner, falling back to all patterns when the framework is unknown.
 *
 * This is distinct from parseTestOutput() which returns structured TestSummary
 * objects for regression/rectification consumers. This parser answers the
 * acceptance-domain question: "which acceptance criteria failed?"
 */

import { detectFramework } from "./detector";

/**
 * Strips ANSI SGR color codes so failure markers and AC tokens match on plain text.
 * Built via RegExp() so the ESC byte (0x1b) is not a control character in the source
 * regex literal (which Biome's noControlCharactersInRegex rightly forbids).
 */
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Parse test runner output to extract failed AC IDs.
 *
 * Supported frameworks and their failure markers:
 * - Bun:        "(fail) AC-N: description [duration]"
 * - Go:         "--- FAIL: TestAC-N_desc (0.00s)"
 * - pytest:     "FAILED tests/...::test_AC_N_desc"
 * - Jest/Vitest: "  ● AC-N: description", "× AC-N: description", or vitest's
 *   default-reporter block header " FAIL  <file> > <suite> > AC-N: description"
 *
 * ANSI color codes are stripped before matching (vitest/jest colorize the marker).
 *
 * Special sentinels:
 * - AC-HOOK: bun lifecycle hook timeout (beforeAll/afterAll timed out, no AC label)
 * - AC-ERROR: test process crashed with non-zero exit and no AC IDs parsed
 *   (emitted by the acceptance stage, not here)
 *
 * @returns Deduplicated array of AC IDs, e.g. ["AC-1", "AC-3", "AC-HOOK"]
 */
export function parseTestFailures(output: string): string[] {
  // Strip ANSI color codes first: vitest/jest colorize the "FAIL" marker and test
  // titles, which would otherwise sit between "AC" and the number and break matching.
  const clean = output.replace(ANSI_SGR_PATTERN, "");
  const framework = detectFramework(clean);
  const failedACs: string[] = [];
  const lines = clean.split("\n");

  for (const line of lines) {
    // Bun: "(fail) AC-N: description [duration]"
    if (framework === "bun" || framework === "unknown") {
      if (line.includes("(fail)")) {
        const acMatch = line.match(/(AC-\d+):/i);
        if (acMatch) {
          const acId = acMatch[1].toUpperCase();
          if (!failedACs.includes(acId)) failedACs.push(acId);
        }
      }
    }

    // Go: "--- FAIL: TestAC-1_desc (0.00s)" or "--- FAIL: TestAC1Desc"
    if (framework === "go" || framework === "unknown") {
      if (line.includes("--- FAIL:")) {
        const acMatch = line.match(/AC[-_]?(\d+)/i);
        if (acMatch) {
          const acId = `AC-${acMatch[1]}`;
          if (!failedACs.includes(acId)) failedACs.push(acId);
        }
      }
    }

    // pytest: "FAILED tests/...::test_AC_1_desc"
    if (framework === "pytest" || framework === "unknown") {
      if (/FAILED\s/.test(line)) {
        const acMatch = line.match(/AC[-_]?(\d+)/i);
        if (acMatch) {
          const acId = `AC-${acMatch[1]}`;
          if (!failedACs.includes(acId)) failedACs.push(acId);
        }
      }
    }

    // Jest / Vitest. Two output shapes carry the failing test name (and AC label):
    //  - bullet markers: "  ● AC-N: description" (jest summary) / "× AC-N: ..." (vitest verbose)
    //  - vitest default-reporter block headers: " FAIL  <file> > <suite> > AC-N: ..."
    // The default reporter never uses bullet glyphs, so the FAIL header is the only
    // place the AC id appears — without it these failures fell through to AC-ERROR.
    // `(?:^|\s)FAIL\s` matches the header but not pytest's "FAILED" (no whitespace after FAIL).
    if (framework === "jest" || framework === "vitest" || framework === "unknown") {
      if (/[●×✕]/.test(line) || /(?:^|\s)FAIL\s/.test(line)) {
        const acMatch = line.match(/AC[-_]?(\d+)/i);
        if (acMatch) {
          const acId = `AC-${acMatch[1]}`;
          if (!failedACs.includes(acId)) failedACs.push(acId);
        }
      }
    }
  }

  // Hook-timeout detection: bun reports lifecycle hook failures as "(unnamed)" with no
  // AC label. Detect via the "hook timed out" / "hook failed" marker emitted on the
  // following line. Emit "AC-HOOK" so callers can distinguish this from "AC-ERROR"
  // (parse failure) and skip the semantic-verdict fast-path in diagnosis.
  const hasUnnamedFail = lines.some((l) => l.includes("(fail)") && l.includes("(unnamed)"));
  const hasHookTimeout = lines.some((l) => /hook timed out|hook failed/i.test(l));
  if (hasUnnamedFail && hasHookTimeout && !failedACs.includes("AC-HOOK")) {
    failedACs.push("AC-HOOK");
  }

  return failedACs;
}
