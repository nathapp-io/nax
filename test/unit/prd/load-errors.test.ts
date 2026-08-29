/**
 * Loader Failure Standardization (US-004 AC-1, AC-2)
 *
 * Verifies that `loadPRD` rejects both invalid-JSON and oversized-PRD failures
 * with coded `NaxError`s so callers can branch on the failure kind. The
 * `userStories`-missing case already throws `PRD_INVALID` (the existing sibling
 * to be modeled on); this test pins the two previously bare `Error` sites to
 * the same shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, makeTempDir } from "@test/helpers";
import { loadPRD, PRD_MAX_FILE_SIZE } from "@/prd";

describe("loadPRD — loader failure standardization (US-004)", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-prd-errors-");
    prdPath = join(testDir, "prd.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // AC-1: invalid JSON must reject with PRD_INVALID and carry the file path.
  test("AC-1: rejects with PRD_INVALID NaxError when the file contains invalid JSON", async () => {
    // Syntactically broken JSON — the parser throws on the trailing comma.
    await Bun.write(prdPath, "{ this is not json");

    const err = await loadPRD(prdPath).catch((e: unknown) => e);
    assertNaxError(err, "loadPRD rejection on invalid JSON");
    expect(err.code).toBe("PRD_INVALID");
    expect(err.context).toBeDefined();
    expect(err.context?.path).toBe(prdPath);
  });

  // AC-2: oversized PRD must reject with a coded NaxError that names the
  // observed size and the limit (so the user can size-budget the next split).
  test("AC-2: rejects with coded NaxError naming observed size and limit when PRD exceeds PRD_MAX_FILE_SIZE", async () => {
    // Build an oversized payload without relying on the loop here, so the test
    // doesn't share its size budget with the implementation.
    const padding = "x".repeat(PRD_MAX_FILE_SIZE);
    await Bun.write(prdPath, `{ "padding": "${padding}" }`);

    const err = await loadPRD(prdPath).catch((e: unknown) => e);
    assertNaxError(err, "loadPRD rejection on oversized file");
    expect(typeof err.code).toBe("string");
    expect(err.code.length).toBeGreaterThan(0);
    // Message must surface both the observed size and the limit. The two
    // numeric quantities appear in distinct units (bytes vs. MB) so a
    // substring search for each is unambiguous.
    expect(err.message).toContain(String(PRD_MAX_FILE_SIZE));
    expect(err.message).toMatch(/\d+(\.\d+)?\s*MB/);
  });

  // Boundary: a PRD at the size limit (no overage) must still parse, proving
  // the overage guard does not falsely reject the limit itself.
  test("accepts a PRD at the configured size limit (boundary)", async () => {
    // A valid PRD whose JSON size is exactly PRD_MAX_FILE_SIZE — confirms the
    // guard uses strict `>` and does not reject the limit itself.
    const header = `{"project":"p","feature":"f","branchName":"b","createdAt":"2025-01-01T00:00:00Z","updatedAt":"2025-01-01T00:00:00Z","userStories":[{"id":"US-001","title":"t","description":"d","acceptanceCriteria":[],"dependencies":[],"tags":[],"status":"pending","passes":false,"attempts":0,"escalations":[],"priorErrors":[],"priorFailures":[],"storyPoints":1}],"padding":"`;
    const footer = '"}';
    const overhead = header.length + footer.length;
    const padding = "x".repeat(PRD_MAX_FILE_SIZE - overhead);
    await Bun.write(prdPath, header + padding + footer);

    const prd = await loadPRD(prdPath);
    expect(prd.userStories).toHaveLength(1);
  });
});
