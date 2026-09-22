import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { screenRawBashCommand } from "@/tools/policy-bash-raw";

const ROOT = "/tmp/raw-screen-root";

function screen(command: unknown) {
  return screenRawBashCommand({
    tool: "Bash",
    command,
    initialPath: ROOT,
    root: ROOT,
    resolvePath: (candidate, cwd) => resolve(cwd, candidate),
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
