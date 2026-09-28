import { describe, expect, test } from "bun:test";
import { denialHintLine, LIKELY_SANDBOX_DENIAL, rawBashRefusalReason, sandboxSentence } from "@/sandbox";

describe("sandbox messages", () => {
  test("network phrasing for open, none and an allow-list", () => {
    expect(sandboxSentence("open")).toContain("network access is unrestricted");
    expect(sandboxSentence([])).toContain("network access is disabled");
    expect(sandboxSentence(["registry.npmjs.org"])).toContain("network access is limited to registry.npmjs.org");
  });

  test("#2260: the sentence says .nax/ is read-only except the scratchpad", () => {
    const s = sandboxSentence("open");
    expect(s).toContain("nothing under .nax/ except .nax/scratchpad/");
    expect(s).toContain("Edit tool");
  });

  // US-003: the pre-change sentence, pinned verbatim. A confined session must
  // NOT advertise the system temp directories as writable -- the sandbox now
  // denies them -- but a shared-temp session must read exactly as before.
  const LEGACY_OPEN =
    "inside an OS sandbox: writes are allowed only under the repository root, the system temp directories and " +
    "package-manager caches -- and nothing under .nax/ except .nax/scratchpad/, since .nax/ is nax's own state " +
    "(change a feature's acceptance test with the Edit tool); credential files (~/.ssh, ~/.aws, ~/.npmrc, nax credentials and similar) are unreadable; " +
    'network access is unrestricted. A write anywhere else fails with "Operation not permitted" or "Read-only file system" ' +
    "-- that is the sandbox, not a bug in your command.";

  test("US-003 AC1: a confined session names this run's temp directory in place of the shared roots", () => {
    const s = sandboxSentence("open", false);
    expect(s).toContain("this run's temp directory ($TMPDIR)");
    expect(s).not.toContain("the system temp directories");
  });

  test("US-003 AC2: sharedTmp=true returns the pre-change sentence", () => {
    expect(sandboxSentence("open", true)).toBe(LEGACY_OPEN);
  });

  test("US-003 AC3: the omitted sharedTmp argument returns the pre-change sentence", () => {
    expect(sandboxSentence("open")).toBe(LEGACY_OPEN);
  });

  test("the raw refusal names the fallback modes", () => {
    const r = rawBashRefusalReason("bwrap missing");
    expect(r).toStartWith("sandbox unavailable (bwrap missing): raw bash requires the sandbox");
    expect(r).toContain("gated or escalate");
  });

  // US-003: the hint now closes with the temp-folder sentence, so the old
  // toEndWith on the roots list can no longer hold. The roots must still be
  // named -- an agent that sees only "use $TMPDIR" has lost the list of the
  // places the sandbox does allow.
  test.each([{ roots: ["/repo"] }, { roots: ["/a", "/b"] }])(
    "US-003 AC4: the hint names the writable roots and ends at the temp folder ($roots)",
    ({ roots }) => {
      const hint = denialHintLine(roots);
      expect(hint).toContain(`writable roots: ${roots.join(", ")}.`);
      expect(hint).toEndWith("For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp.");
    },
  );

  // A shared-temp session (allowSharedTmp: true) can write /tmp, so its hint
  // must not tell the agent "not /tmp" -- that would contradict the policy the
  // command just ran under.
  test("a shared-temp session's denial hint omits the not-/tmp clause", () => {
    const hint = denialHintLine(["/repo", "/tmp"], true);
    expect(hint).toContain("writable roots: /repo, /tmp.");
    expect(hint).not.toContain("not /tmp");
    expect(hint).not.toContain("$TMPDIR");
  });

  test("denial detection matches both platforms' wording", () => {
    expect(LIKELY_SANDBOX_DENIAL.test("sh: /x: Operation not permitted")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("cannot create /x: Read-only file system")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("No such file or directory")).toBe(false);
  });
});
