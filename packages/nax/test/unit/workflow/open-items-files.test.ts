/**
 * US-010 (branch-review-coverage): the reason item that names the files a branch review did not
 * read carries those paths, so a ruling on it can say which files it covered instead of relying on
 * free text. Every other item is unchanged.
 */
import { describe, expect, test } from "bun:test";
import { describeUnread } from "@/workflow/approval";
import { newFeatureRecord } from "@/workflow/feature-record";
import { buildOpenItems } from "@/workflow/open-items";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const rec = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  ...over,
});

const UNREAD = ["a.ts", "b.ts"];
const unreadRecord = (reasons: readonly string[] = [describeUnread(UNREAD)]) => rec({ reviewUnread: UNREAD, reasons });

describe("buildOpenItems: the unread-files reason carries its files (US-010)", () => {
  test("AC-1: the matching reason item carries reviewUnread", () => {
    expect(buildOpenItems(unreadRecord())).toContainEqual({
      id: "_run:reason1",
      kind: "reason",
      issue: describeUnread(UNREAD),
      files: ["a.ts", "b.ts"],
    });
  });

  test("AC-2: every other reason item has no files field", () => {
    const items = buildOpenItems(unreadRecord([describeUnread(UNREAD), "another reason"]));
    const other = items.filter((item) => item.issue === "another reason");
    expect(other).toEqual([{ id: "_run:reason2", kind: "reason", issue: "another reason" }]);
    expect(other.some((item) => "files" in item)).toBe(false);
  });

  test("AC-2: a reason item without a matching unread text has no files field", () => {
    const items = buildOpenItems(rec({ reasons: ["branch review did not run"] }));
    expect(items).toEqual([{ id: "_run:reason1", kind: "reason", issue: "branch review did not run" }]);
  });

  test("files carry every unread path, not only the five the reason lists", () => {
    const seven = ["p1.ts", "p2.ts", "p3.ts", "p4.ts", "p5.ts", "p6.ts", "p7.ts"];
    const [item] = buildOpenItems(rec({ reviewUnread: seven, reasons: [describeUnread(seven)] }));
    expect(item?.issue).toEndWith("+2 more");
    expect(item?.files).toEqual(seven);
  });
});
