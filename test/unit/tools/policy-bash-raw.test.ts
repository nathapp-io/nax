import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { screenRawBashCommand } from "@/tools/policy-bash-raw";

const ROOT = "/tmp/raw-screen-root";

/**
 * Mirrors production's containment callback (`resolveWithin(root, ...)` via
 * policy.ts), which returns null for anything that escapes the root. A stub
 * that always resolves would make `cd ../outside` look MODELLABLE here while
 * production cannot model it at all, and the frame-tracking tests below turn
 * on exactly that distinction.
 */
function screen(command: unknown) {
  return screenRawBashCommand({
    tool: "Bash",
    command,
    initialPath: ROOT,
    root: ROOT,
    resolvePath: (candidate, cwd) => {
      const resolved = resolve(cwd, candidate);
      return resolved === ROOT || resolved.startsWith(`${ROOT}/`) ? resolved : null;
    },
  });
}

describe("screenRawBashCommand", () => {
  test("allows an ordinary command", () => {
    expect(screen("bun test src/foo.test.ts").kind).toBe("allow");
  });

  test("allows a pipeline the gated lexer would accept", () => {
    expect(screen("bun test 2>/dev/null | head -20").kind).toBe("allow");
  });

  test("ALLOWS a construct the lexer refuses — this is what makes raw raw", () => {
    expect(screen("echo $(whoami)").kind).toBe("allow");
    expect(screen("echo `date`").kind).toBe("allow");
    expect(screen("cat <<EOF\nhi\nEOF").kind).toBe("allow");
  });

  test("allows a write outside the root — raw enforces no containment", () => {
    expect(screen("echo hi > ../../outside.txt").kind).toBe("allow");
  });

  test("DENIES a parseable redirect into a feature PRD", () => {
    const result = screen("echo {} > .nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("prd.json");
      expect(result.escalatable).toBe(false);
    }
  });

  test("DENIES a parseable argument naming a feature PRD", () => {
    expect(screen("rm .nax/features/f/prd.json").kind).toBe("deny");
  });

  test("DENIES a parseable write to the root queue-control file", () => {
    expect(screen("echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("a non-string command is denied", () => {
    expect(screen(42).kind).toBe("deny");
  });

  test("an empty command is denied", () => {
    expect(screen("   ").kind).toBe("deny");
  });
});

describe("screenRawBashCommand tracks a parseable cd", () => {
  test("DENIES a `cd` that walks a redirect back into the root's queue file", () => {
    // The false negative this arc exists to fix: without cwd tracking the
    // redirect target was resolved against `initialPath` only, so this wrote
    // straight through to `<root>/.queue.txt` -- nax's own run-control file.
    const result = screen("cd child && echo ABORT > ../.queue.txt");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain("queue.txt");
  });

  test("DENIES a `cd` that walks a redirect back into a feature PRD", () => {
    const result = screen("cd child && echo x > ../.nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain("prd.json");
  });

  test("DENIES the un-cd'd root write, unchanged (regression pin)", () => {
    expect(screen("echo ABORT > .queue.txt").kind).toBe("deny");
  });

  // An unmodelled `cd` is never ITSELF a denial, but it does not end the
  // screen either -- the frame set holds its last known value and later
  // segments are still checked against it. An earlier revision returned
  // `allow` for the whole command here, which let `cd - ; echo ABORT >
  // .queue.txt` write the run-control file unscreened: strictly worse than
  // the initialPath-pinned code this tracking replaced.
  test("an option-shaped `cd` does not disable the screen for later segments", () => {
    expect(screen("cd -P child && echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("an opaque ($-expansion) `cd` does not disable the screen", () => {
    expect(screen("cd $TARGET && echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("a `cd` that leaves the root does not disable the screen", () => {
    expect(screen("cd ../outside && echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("a `cd` with no target does not disable the screen", () => {
    expect(screen("cd ; echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("`cd -` before a protected write is refused (the regression this pins)", () => {
    expect(screen("cd - ; echo ABORT > .queue.txt").kind).toBe("deny");
  });

  // The fail-open half of the asymmetry, still intact: an unmodellable `cd`
  // is not a denial on its own account, unlike gated mode, which refuses it.
  test("an unmodellable `cd` is not itself a denial", () => {
    expect(screen("cd -P child && bun test").kind).toBe("allow");
    expect(screen("cd $TARGET && bun test").kind).toBe("allow");
    expect(screen("cd ../outside && bun test").kind).toBe("allow");
    expect(screen("cd -").kind).toBe("allow");
  });

  test("a `;`-separated cd keeps both frames live: a hit from EITHER frame denies", () => {
    // Unlike `&&`, `;` runs the next segment regardless of whether `cd`
    // succeeded, so both `<root>` and `<root>/child` are candidate frames.
    // The redirect below only hits from the pre-cd frame.
    const result = screen("cd child ; echo ABORT > .queue.txt");
    expect(result.kind).toBe("deny");
  });

  test("a `&&`-separated cd replaces the frame: the pre-cd frame is no longer checked", () => {
    // The false positive this arc exists to fix, and proof the separator
    // semantics reached raw: after `&&`, only `<root>/child` is live, so
    // `.queue.txt` here means `child/.queue.txt` -- an ordinary file, not
    // the root's run-control file -- and must not be refused.
    expect(screen("cd child && echo hi > .queue.txt").kind).toBe("allow");
  });
});
