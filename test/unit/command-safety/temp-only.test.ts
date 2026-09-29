import { describe, expect, test } from "bun:test";
import { isTempOnly } from "@/command-safety";

/** Every case is judged against this project directory. */
const CWD = "/repo/proj";

/**
 * The `$` + `{` opener of sh's brace form, assembled here so that no plain
 * string literal in this file contains a bare `${` placeholder.
 */
const BRACE_OPEN = "${";

describe("isTempOnly", () => {
  // AC1 — the barrel export, and a temp destination reached from a cwd source.
  test("US-002 AC1: a temp destination reached from a cwd-relative source is temp-only", () => {
    expect(isTempOnly("cp src/a.ts /tmp/a.bak", CWD)).toBe(true);
  });

  test("US-002 AC1 boundary: the temp path may be the source and the cwd path the destination", () => {
    expect(isTempOnly("cp /tmp/a.bak src/a.ts", CWD)).toBe(true);
  });

  test("US-002 AC1 boundary: two cwd-relative operands and no temp path are not temp-only", () => {
    expect(isTempOnly("cp src/a.ts src/b.ts", CWD)).toBe(false);
  });

  // AC2 — a temp read counts.
  test("US-002 AC2: a temp read alone satisfies the temp-path requirement", () => {
    expect(isTempOnly("cat /tmp/out.txt", CWD)).toBe(true);
  });

  test("US-002 AC2 boundary: a temp read in a later segment still counts", () => {
    expect(isTempOnly("cat a.txt && cat /tmp/out.txt", CWD)).toBe(true);
  });

  test("US-002 AC2 boundary: a word with no path separator is not a temp path", () => {
    expect(isTempOnly("cat out.txt", CWD)).toBe(false);
  });

  // AC3 — $TMPDIR redirects.
  test("US-002 AC3: an $TMPDIR redirect target with a ..-free remainder is a temp path", () => {
    expect(isTempOnly("echo x > $TMPDIR/a.txt", CWD)).toBe(true);
  });

  test(`US-002 AC3 boundary: the ${BRACE_OPEN}TMPDIR} brace form is accepted too`, () => {
    expect(isTempOnly(`echo x > ${BRACE_OPEN}TMPDIR}/a.txt`, CWD)).toBe(true);
  });

  test("US-002 AC3 boundary: an appending redirect into $TMPDIR is a temp path", () => {
    expect(isTempOnly("echo x >> $TMPDIR/a.txt", CWD)).toBe(true);
  });

  // AC4 — cd into a temp root, and the frame it leaves behind.
  test("US-002 AC4: a cd into a temp root is itself the required temp path", () => {
    expect(isTempOnly("cd /tmp/work && git init", CWD)).toBe(true);
  });

  test("US-002 AC4 boundary: a bare cd into a temp root is temp-only", () => {
    expect(isTempOnly("cd /tmp/work", CWD)).toBe(true);
  });

  test("US-002 AC4 boundary: a relative path is judged against the directory the cd moved to", () => {
    // frame becomes /repo/proj/sub, so ../../tmp/x is /repo/tmp/x — outside cwd.
    expect(isTempOnly("cd sub && cat ../../tmp/x", CWD)).toBe(false);
  });

  test("US-002 AC4 boundary: a cd outside temp and cwd cannot be judged", () => {
    expect(isTempOnly("cd /etc && ls", CWD)).toBe(false);
  });

  // AC5 — /private/tmp is a temp root.
  test("US-002 AC5: a read under /private/tmp is a temp path", () => {
    expect(isTempOnly("cat /private/tmp/x.log", CWD)).toBe(true);
  });

  test("US-002 AC5 boundary: /private/tmpx is a sibling directory, not the temp root", () => {
    expect(isTempOnly("cat /private/tmpx/x.log", CWD)).toBe(false);
  });

  // AC6 — a --flag=value token is judged by its value.
  test("US-002 AC6: a --flag=value token is judged by its value", () => {
    expect(isTempOnly("bun build --outdir=/tmp/b src/a.ts", CWD)).toBe(true);
  });

  test("US-002 AC6 boundary: a --flag=value whose value leaves temp and cwd is refused", () => {
    expect(isTempOnly("bun build --outdir=/etc/b src/a.ts", CWD)).toBe(false);
  });

  test("US-002 AC6 boundary: a command with no flag carries no judged value", () => {
    expect(isTempOnly("bun build src/a.ts", CWD)).toBe(false);
  });

  // AC7 — a path under cwd is allowed.
  test("US-002 AC7: an absolute path under cwd is allowed alongside a temp redirect", () => {
    expect(isTempOnly("cat /repo/proj/src/a.ts > /tmp/x", CWD)).toBe(true);
  });

  test("US-002 AC7 boundary: a cwd-relative path is allowed alongside a temp path", () => {
    expect(isTempOnly("cat src/a.ts > /tmp/x", CWD)).toBe(true);
  });

  test("US-002 AC7 boundary: a cwd path with no temp path anywhere is not temp-only", () => {
    expect(isTempOnly("cat /repo/proj/src/a.ts", CWD)).toBe(false);
  });

  // AC8 — the /dev allowlist.
  test("US-002 AC8: /dev/null is allowed and a later temp write satisfies the requirement", () => {
    expect(isTempOnly("echo x > /dev/null; cp a.txt /tmp/b", CWD)).toBe(true);
  });

  test("US-002 AC8 boundary: /dev/null alone is allowed but is not a temp path", () => {
    expect(isTempOnly("echo x > /dev/null", CWD)).toBe(false);
  });

  test.each(["/dev/stdout", "/dev/stderr"])(
    "US-002 AC8 boundary: %s is in the /dev allowlist alongside a temp path",
    (target) => {
      expect(isTempOnly(`echo x > ${target}; cp a.txt /tmp/b`, CWD)).toBe(true);
    },
  );

  test("US-002 AC8 boundary: a /dev path outside the three-entry allowlist is refused", () => {
    expect(isTempOnly("echo x > /dev/sda; cp a.txt /tmp/b", CWD)).toBe(false);
  });

  // AC9 — no temp path appears at all.
  test("US-002 AC9: a bare-word operand with no temp path anywhere is not temp-only", () => {
    expect(isTempOnly("ls src", CWD)).toBe(false);
  });

  test.each(["", "   "])(
    "US-002 AC9 boundary: the lexer refuses the empty command %j, so it is not temp-only",
    (command) => {
      expect(isTempOnly(command, CWD)).toBe(false);
    },
  );

  // AC10 — a ~ path cannot be judged.
  test("US-002 AC10: a ~ path cannot be judged, even with a temp source", () => {
    expect(isTempOnly("cp /tmp/a ~/b", CWD)).toBe(false);
  });

  test("US-002 AC10 boundary: a ~ path with no temp path anywhere is not temp-only", () => {
    expect(isTempOnly("ls ~/projects", CWD)).toBe(false);
  });

  // AC11 — a relative path that climbs out of cwd.
  test("US-002 AC11: a relative path resolving outside cwd is not temp-only", () => {
    expect(isTempOnly("cat /tmp/a ../other/b", CWD)).toBe(false);
  });

  test("US-002 AC11 boundary: a relative path staying inside cwd is allowed", () => {
    expect(isTempOnly("cat /tmp/a ./sub/b", CWD)).toBe(true);
  });

  test("US-002 AC11 boundary: a token equal to .. climbs out of cwd", () => {
    expect(isTempOnly("cat /tmp/a ..", CWD)).toBe(false);
  });

  // AC12 — an absolute path outside temp and cwd.
  test("US-002 AC12: an absolute path outside temp and cwd is not temp-only", () => {
    expect(isTempOnly("cat /etc/hosts > /tmp/x", CWD)).toBe(false);
  });

  test("US-002 AC12 boundary: a shared string prefix of cwd is not inside cwd", () => {
    expect(isTempOnly("cat /repo/projx/a > /tmp/y", CWD)).toBe(false);
  });

  test("US-002 AC12 boundary: a .. climb out of a temp root lands outside every temp root", () => {
    expect(isTempOnly("cat /tmp/../etc/hosts > /tmp/x", CWD)).toBe(false);
  });

  // AC13 — an opaque word other than $TMPDIR.
  test("US-002 AC13: an opaque path word other than $TMPDIR cannot be judged", () => {
    expect(isTempOnly("cp a.txt $OUT/x", CWD)).toBe(false);
  });

  test("US-002 AC13 boundary: the brace form of another variable is judged the same way", () => {
    expect(isTempOnly(`cp a.txt ${BRACE_OPEN}OUT}/x`, CWD)).toBe(false);
  });

  test("US-002 AC13 boundary: an opaque redirect target that is not $TMPDIR cannot be judged", () => {
    expect(isTempOnly("echo x > $OUT/log", CWD)).toBe(false);
  });

  // AC14 — a refused lex returns false.
  test("US-002 AC14: the lexer refuses the heredoc, so the command is not temp-only", () => {
    expect(isTempOnly("cat > /tmp/a.txt << 'EOF'\nx\nEOF", CWD)).toBe(false);
  });

  test("US-002 AC14 boundary: a refused lex is not scanned as a prefix when a temp path precedes it", () => {
    expect(isTempOnly("cd /tmp && cat > x <<'EOF'\ny\nEOF", CWD)).toBe(false);
  });

  test.each(["(cat /tmp/a)", "cat /tmp/a 'x", "ls /tmp && cat /tmp/a 2>&1"])(
    "US-002 AC14 boundary: the unmodelled construct refuses the lex, so %j is not temp-only",
    (command) => {
      expect(isTempOnly(command, CWD)).toBe(false);
    },
  );

  // AC15 — an undefined cwd.
  test("US-002 AC15: an undefined cwd returns false", () => {
    expect(isTempOnly("cp a.txt /tmp/b", undefined)).toBe(false);
  });

  test("US-002 AC15 boundary: an undefined cwd returns false even for an all-absolute temp command", () => {
    expect(isTempOnly("cat /tmp/a.txt", undefined)).toBe(false);
  });

  test("US-002 AC15 boundary: the same command is judged once a cwd is supplied", () => {
    expect(isTempOnly("cat /tmp/a.txt", CWD)).toBe(true);
  });

  // AC16 — an attached short-option value cannot be judged.
  test("US-002 AC16: an attached short-option value containing / cannot be judged", () => {
    expect(isTempOnly("tar -C/etc -xf /tmp/a.tar", CWD)).toBe(false);
  });

  test("US-002 AC16 boundary: a --flag=value token is the judged form, not the attached one", () => {
    expect(isTempOnly("tar --directory=/tmp/d -xf /tmp/a.tar", CWD)).toBe(true);
  });

  test("US-002 AC16 boundary: a short flag with no / is not path-like", () => {
    expect(isTempOnly("tar -xf /tmp/a.tar", CWD)).toBe(true);
  });

  // AC17 — a URL token cannot be judged.
  test("US-002 AC17: a URL token cannot be judged", () => {
    expect(isTempOnly("curl https://example.com/x -o /tmp/x", CWD)).toBe(false);
  });

  test("US-002 AC17 boundary: a URL fails the command even when it follows a temp path", () => {
    expect(isTempOnly("curl -o /tmp/x https://example.com/x", CWD)).toBe(false);
  });

  test("US-002 AC17 boundary: any scheme containing :// counts, not just https", () => {
    expect(isTempOnly("git clone ssh://host/repo /tmp/x", CWD)).toBe(false);
  });

  // AC18 — a $TMPDIR remainder containing a .. segment.
  test.each(["cat $TMPDIR/../../etc/x", "cat $TMPDIR/../x"])(
    "US-002 AC18: a $TMPDIR remainder with a .. segment is not a temp path: %s",
    (command) => {
      expect(isTempOnly(command, CWD)).toBe(false);
    },
  );

  test("US-002 AC18 boundary: a ..-free $TMPDIR subpath is a temp path", () => {
    expect(isTempOnly("cat $TMPDIR/a/b.txt", CWD)).toBe(true);
  });

  // AC19 — a look-alike variable name.
  test("US-002 AC19: a variable whose name merely starts with TMPDIR is not $TMPDIR", () => {
    expect(isTempOnly("cat $TMPDIRX/a", CWD)).toBe(false);
  });

  test("US-002 AC19 boundary: the brace form of a look-alike variable is not $TMPDIR either", () => {
    expect(isTempOnly(`cat ${BRACE_OPEN}TMPDIRX}/a`, CWD)).toBe(false);
  });

  // AC20 — after an unresolvable cd the frame is unknown.
  test("US-002 AC20: after an unresolvable cd a relative path cannot be judged", () => {
    expect(isTempOnly("cd $D && cp a/b /tmp/x", CWD)).toBe(false);
  });

  test("US-002 AC20 boundary: an absolute path after an unresolvable cd is still judged", () => {
    expect(isTempOnly("cd $D && cat /tmp/a", CWD)).toBe(true);
  });

  test("US-002 AC20 boundary: an unresolvable cd followed by no path-like token still passes", () => {
    expect(isTempOnly("cd $D && echo x > /tmp/y", CWD)).toBe(true);
  });

  test("US-002 AC20 boundary: a . token is path-like, so an unknown frame refuses it", () => {
    expect(isTempOnly("cd $D && cp /tmp/x .", CWD)).toBe(false);
  });

  test("cd - makes a later relative path unjudgeable", () => {
    expect(isTempOnly("cd - && cat ./file > /tmp/out", CWD)).toBe(false);
  });
});
