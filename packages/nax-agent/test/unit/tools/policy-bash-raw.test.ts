import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EMPTY_OWNED_PATHS_POLICY, type OwnedBashCandidate, type OwnedPathsPolicy } from "#src/tools/owned-paths";
import { resolveWithin } from "#src/tools/policy";
import { type RawScreenArgs, screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { naxOwnedBashRefusal, naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

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
    ownedPaths: naxOwnedPathsPolicy,
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

// US-001: lexical nax config file detection in the raw screen. Before this
// arc the screen consulted `args.resolvePath` first, which returned null for
// any path typed tools were refusing anyway (a `.nax/config.json` write is
// refused by the typed seam BEFORE bash is ever called, so resolveWithin
// never returned a path for it). The raw screen has no typed seam in front
// of it, so the redirect fell through to `isNaxOwnedWritePath`, which does
// not match `.nax/config.json` -- the whole class of nax-config writes was
// unscreened. The fix checks `isNaxConfigFile` LEXICALLY, before the
// resolver is consulted.
describe("screenRawBashCommand — US-001: lexical nax config file detection", () => {
  test("DENIES a parseable redirect into the root .nax/config.json", () => {
    const result = screen("echo x > .nax/config.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(".nax/config.json");
      expect(result.escalatable).toBe(false);
    }
  });

  test("DENIES a parseable redirect into a single-segment mono config", () => {
    const result = screen("echo x > .nax/mono/api/config.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(".nax/mono/api/config.json");
      expect(result.escalatable).toBe(false);
    }
  });

  test("DENIES a parseable redirect into a nested mono config (the real per-package override shape)", () => {
    const result = screen("echo x > .nax/mono/packages/app/config.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(".nax/mono/packages/app/config.json");
    }
  });

  test("DENIES a parseable ARGUMENT naming the root config (not only redirects)", () => {
    expect(screen("rm .nax/config.json").kind).toBe("deny");
    expect(screen("touch .nax/config.json").kind).toBe("deny");
  });

  test("DENIES a parseable redirect into a feature PRD (regression pin for the existing screen)", () => {
    const result = screen("echo x > .nax/features/f1/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain("prd.json");
  });

  test("does not deny a write outside the root -- raw enforces no containment", () => {
    // AC7: a redirect to ../outside.txt escapes the root and must NOT be
    // denied. `isNaxConfigFile` is lexical so it does not match a path
    // outside the root, and the existing containment-free semantics stay
    // intact.
    expect(screen("echo hi > ../outside.txt").kind).toBe("allow");
  });

  test("does not deny an ordinary file at the root", () => {
    // AC8: an ordinary write at the root is `ok` under raw.
    expect(screen("echo ok > notes.txt").kind).toBe("allow");
  });

  // AC10: the resolver returning null for every candidate must NOT silence
  // the nax config check. The lexical pass runs before the resolver, so the
  // screen still catches `echo x > .nax/config.json`. The reverse -- a
  // resolver that lets every path through -- does not reach this code path
  // either, so both extremes are pinned.
  test("AC10: a null-returning resolver still denies .nax/config.json (lexical pass runs first)", () => {
    const result = screenRawBashCommand({
      tool: "Bash",
      command: "echo x > .nax/config.json",
      initialPath: ROOT,
      root: ROOT,
      ownedPaths: naxOwnedPathsPolicy,
      resolvePath: () => null,
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(".nax/config.json");
      expect(result.escalatable).toBe(false);
    }
  });

  // The check is per-FRAME, mirroring the conservatism of gated mode's own
  // `resolveAll`: a `;`-joined `cd` keeps the pre-cd frame live, and the
  // redirect relative to that frame resolves to a nax config file. Either
  // frame is enough to deny, so this is denied from the pre-cd frame even
  // though the cd'd frame would not catch it.
  test("DENIES a `;`-shaped redirect into a nax config from the pre-cd frame", () => {
    // After `cd packages/app ;` both `<root>` and `<root>/packages/app` are
    // live. The redirect target relative to the pre-cd frame resolves to
    // `<root>/.nax/config.json` -- a nax config file. Either frame catches it.
    const result = screen("cd packages/app ; echo x > .nax/config.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain(".nax/config.json");
  });
});

// US-001: kind-specific refusal text. Before this story both the token branch
// and the redirect branch returned the SAME modification-only sentence for
// every kind of nax-owned file -- which is why an agent reading a PRD refusal
// retries a read it will never be allowed to run. The screen now reports which
// kind it matched, and the refusal text comes from `naxOwnedBashRefusal`.
// Every allow/deny DECISION is unchanged (AC7); only the reason changes.
describe("screenRawBashCommand — US-001: kind-specific refusal text", () => {
  test("AC3: `git diff` naming a feature PRD is denied with the PRD truth", () => {
    const result = screen("git diff .nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      const reason = result.reason;
      // Names the token the agent used.
      expect(reason).toContain(".nax/features/f/prd.json");
      // The file is the story's acceptance criteria ...
      expect(reason).toContain("acceptance criteria");
      // ... nax updates it itself during the run, so it shows as modified ...
      expect(reason).toContain("updates it itself during the run");
      expect(reason).toContain("shows as modified");
      // ... and every Bash command naming it is refused, reads included ...
      expect(reason).toContain("reads included");
      // ... but the `Read` tool can view it.
      expect(reason).toContain("`Read` tool");
      expect(result.escalatable).toBe(false);
    }
  });

  test("AC4: a redirect into a feature PRD says the command redirects into the file", () => {
    const result = screen("echo x > .nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("redirects into");
      expect(result.reason).toContain(".nax/features/f/prd.json");
      expect(result.reason).toContain("updates it itself during the run");
    }
  });

  test("AC5: `cat .queue.txt` is denied as the run-control queue, with no `Read` offer", () => {
    const result = screen("cat .queue.txt");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("run-control queue");
      expect(result.reason).toContain("reads included");
      expect(result.reason).toContain("queue command");
      // The queue file is NOT readable through any tool -- no `Read` escape hatch.
      expect(result.reason).not.toContain("Read tool");
      expect(result.reason).not.toContain("`Read`");
    }
  });

  test("AC6: `cat .nax/config.json` is denied as nax configuration, with no `Read` offer", () => {
    const result = screen("cat .nax/config.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("nax configuration");
      expect(result.reason).toContain("reads included");
      expect(result.reason).toContain("not changed from inside a run");
      expect(result.reason).not.toContain("Read tool");
      expect(result.reason).not.toContain("`Read`");
    }
  });
});

// AC7: the kind-specific reason must not have moved any allow/deny decision.
// Every command the existing suite screens is re-checked here so a change to
// the refusal text that accidentally also changed the verdict fails loudly.
describe("screenRawBashCommand — US-001 AC7: allow/deny decisions are unchanged", () => {
  const cases: Array<[string, "allow" | "deny"]> = [
    ["bun test src/foo.test.ts", "allow"],
    ["bun test 2>/dev/null | head -20", "allow"],
    ["echo $(whoami)", "allow"],
    ["echo hi > ../../outside.txt", "allow"],
    ["echo {} > .nax/features/f/prd.json", "deny"],
    ["rm .nax/features/f/prd.json", "deny"],
    ["echo ABORT > .queue.txt", "deny"],
    ["echo x > .nax/config.json", "deny"],
    ["cat .queue.txt", "deny"],
    ["cat .nax/config.json", "deny"],
    ["cd child && echo ABORT > ../.queue.txt", "deny"],
    ["cd child && echo hi > .queue.txt", "allow"],
  ];

  test.each(cases)("`%s` still screens as %s", (command, kind) => {
    expect(screen(command).kind).toBe(kind);
  });
});

/** `screen` with the US-002 `sandboxWrapped` flag spelled explicitly. */
function screenWith(command: unknown, sandboxWrapped?: boolean) {
  return screenRawBashCommand({
    tool: "Bash",
    command,
    initialPath: ROOT,
    root: ROOT,
    sandboxWrapped: sandboxWrapped ?? false,
    ownedPaths: naxOwnedPathsPolicy,
    resolvePath: (candidate, cwd) => {
      const resolved = resolve(cwd, candidate);
      return resolved === ROOT || resolved.startsWith(`${ROOT}/`) ? resolved : null;
    },
  });
}

// US-002: under `raw` there is neither containment nor a grant check, so
// nothing stopped `find / -name ...`: a second test-writer ran exactly that
// (and a `find /` variant) and hit the 300s Bash timeout. The screen now
// refuses a `find` whose START PATH is the whole filesystem. Start paths are
// the tokens after `find` -- and after a leading `-H`, `-L` or `-P` -- up to
// the first token that begins with `-`, `(` or `!`. The comparison uses the
// token TEXT, opaque tokens included (`$HOME` lexes as opaque and must still
// match), and it is an exact comparison, not a prefix one.
describe("screenRawBashCommand — US-002: whole-filesystem find cost guard", () => {
  test("AC1: `find /` is refused non-escalatably, naming the repository root and the timeout", () => {
    const result = screen("find / -name approvals.ts");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.escalatable).toBe(false);
      expect(result.reason).toContain("find /");
      expect(result.reason).toContain("searches the whole filesystem");
      expect(result.reason).toContain("300s Bash timeout");
      expect(result.reason).toContain(`Search within the repository root instead: ${ROOT}`);
    }
  });

  test("AC1 boundary: a `/` that is NOT a start path (it follows `-name`) is allowed", () => {
    // Start paths stop at the first option-shaped token, so the trailing `/`
    // is a `-name` pattern argument, not a search root.
    expect(screen("find -name x /").kind).toBe("allow");
  });

  test("AC2: `find ~` is refused", () => {
    const result = screen("find ~ -name x");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.escalatable).toBe(false);
  });

  test("AC2 boundary: `~user` is not `~` — the comparison is exact, not a prefix match", () => {
    expect(screen("find ~user -name x").kind).toBe("allow");
  });

  test("AC3: `find $HOME` is refused even though the lexer marks the token opaque", () => {
    const result = screen("find $HOME -name x");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.escalatable).toBe(false);
  });

  test("AC3 boundary: the brace form of $HOME is refused too", () => {
    const braceHome = "$" + "{HOME}";
    expect(screen(`find ${braceHome} -name x`).kind).toBe("deny");
  });

  test("AC4: `find -L /` is refused — the leading -L is skipped, not treated as the start path", () => {
    const result = screen("find -L / -name x");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.escalatable).toBe(false);
  });

  test("AC4 boundary: `find -L /usr/lib` is allowed — only the whole filesystem is a start path", () => {
    expect(screen("find -L /usr/lib -name x").kind).toBe("allow");
  });

  test("AC5: a compound command whose LATER segment is a whole-filesystem find is refused", () => {
    const result = screen("git status; find / -name x | head");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.escalatable).toBe(false);
  });

  test("AC5 boundary: a compound command whose find is scoped to the repository is allowed", () => {
    expect(screen("git status; find . -name x | head").kind).toBe("allow");
  });

  test("AC6: `find /usr/lib` is allowed", () => {
    expect(screen("find /usr/lib -name x").kind).toBe("allow");
  });

  test("AC7: `find .` is allowed", () => {
    expect(screen("find . -name x").kind).toBe("allow");
  });

  test("AC8: `find ~/proj` is allowed", () => {
    expect(screen("find ~/proj -name x").kind).toBe("allow");
  });

  test("AC19: a `$(...)` start path is allowed unscreened (raw's fail-open lexer, unchanged)", () => {
    // `find $(pwd)/.. -name x` uses a command substitution, so the lexer
    // refuses the command and raw allows it without screening -- the same
    // fail-open behaviour raw has always had. The new guard must not turn
    // that into a refusal.
    expect(screen("find $(pwd)/.. -name x").kind).toBe("allow");
  });

  test("AC19 boundary: the fail-open lexer still wins when sandboxWrapped is true", () => {
    expect(screenWith("find $(pwd)/.. -name x", true).kind).toBe("allow");
  });
});

// US-002: 17 of 22 PRD denials in the motivating run were sandbox-wrapped
// read-only commands. Once the sandbox wraps the command (an available
// launcher), a token that only NAMES a PRD is no longer refused -- the
// sandbox is the boundary there, so a read costs nothing and a write is
// still blocked. Config and queue are unchanged, and without the flag
// (`sandboxWrapped` absent or false) the PRD screen behaves exactly as
// before.
describe("screenRawBashCommand — US-002: sandbox-wrapped PRD reads", () => {
  test("AC9: `git diff` naming a feature PRD is allowed when the command is sandbox-wrapped", () => {
    expect(screenWith("git diff .nax/features/f/prd.json", true).kind).toBe("allow");
  });

  test("AC9 boundary: any read-only naming of the PRD is allowed when sandbox-wrapped", () => {
    expect(screenWith("cat .nax/features/f/prd.json", true).kind).toBe("allow");
  });

  test("AC10: a REDIRECT into the PRD is still refused when sandbox-wrapped, with the read/write truth", () => {
    const result = screenWith("echo x > .nax/features/f/prd.json", true);
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(".nax/features/f/prd.json");
      expect(result.reason).toContain("Reading it through Bash is allowed");
      expect(result.reason).not.toContain("reads included");
      expect(result.escalatable).toBe(false);
    }
  });

  test("AC11: `cat .nax/config.json` is still refused when sandbox-wrapped", () => {
    const result = screenWith("cat .nax/config.json", true);
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain("nax configuration");
  });

  test("AC11 boundary: a redirect into a nax config file is still refused when sandbox-wrapped", () => {
    expect(screenWith("echo x > .nax/config.json", true).kind).toBe("deny");
  });

  test("AC11 boundary: the queue run-control file is still refused when sandbox-wrapped", () => {
    expect(screenWith("cat .queue.txt", true).kind).toBe("deny");
  });

  test("AC12: without sandboxWrapped, naming a feature PRD is still refused as a read", () => {
    const result = screen("git diff .nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("reads included");
      expect(result.reason).not.toContain("Reading it through Bash is allowed");
    }
  });

  test("AC12 boundary: an explicit sandboxWrapped: false screens exactly like an absent flag", () => {
    expect(screenWith("git diff .nax/features/f/prd.json", false)).toEqual(screen("git diff .nax/features/f/prd.json"));
  });
});

// S3-2: the raw screen no longer knows nax's owned paths itself. It builds one
// candidate per live working-directory frame and hands the whole set to
// `args.ownedPaths.bashRefusal`, which decides refusals -- and applies the
// sandbox-wrapped PRD-read exemption. With the empty policy nothing is refused;
// with `naxOwnedPathsPolicy` every refusal text is today's, byte for byte.
describe("screenRawBashCommand reads owned paths from the port (S3-2)", () => {
  let rawRoot = "";
  beforeEach(() => {
    rawRoot = realpathSync(mkdtempSync(join(tmpdir(), "raw-screen-owned-")));
    mkdirSync(join(rawRoot, ".nax", "features", "f"), { recursive: true });
  });

  const args = (command: string, ownedPaths: OwnedPathsPolicy, sandboxWrapped = false): RawScreenArgs => ({
    tool: "Bash",
    command,
    initialPath: rawRoot,
    root: rawRoot,
    resolvePath: (candidate, cwd) => resolveWithin(rawRoot, resolve(cwd, candidate), ownedPaths),
    ownedPaths,
    sandboxWrapped,
  });

  test("with the empty policy a redirect into nax config is allowed", () => {
    expect(screenRawBashCommand(args("echo x > .nax/config.json", EMPTY_OWNED_PATHS_POLICY)).kind).toBe("allow");
  });

  test("with nax's policy the texts are today's", () => {
    const named = screenRawBashCommand(args("cat .queue.txt", naxOwnedPathsPolicy));
    expect(named).toMatchObject({ kind: "deny", reason: naxOwnedBashRefusal("Bash", "queue", ".queue.txt", "names") });
    const redirect = screenRawBashCommand(args("echo x > .nax/config.json", naxOwnedPathsPolicy));
    expect(redirect).toMatchObject({
      kind: "deny",
      reason: naxOwnedBashRefusal("Bash", "config", ".nax/config.json", "redirects into", { sandboxWrapped: false }),
    });
  });

  test("sandbox-wrapped: naming a PRD is allowed, redirecting into it is not", () => {
    expect(screenRawBashCommand(args("cat .nax/features/f/prd.json", naxOwnedPathsPolicy, true)).kind).toBe("allow");
    expect(screenRawBashCommand(args("echo x > .nax/features/f/prd.json", naxOwnedPathsPolicy, true)).kind).toBe(
      "deny",
    );
  });

  test("the port receives one candidate per live frame, in frame order", () => {
    // Every token is screened, the command word included, so record by token.
    const seen = new Map<string, readonly OwnedBashCandidate[]>();
    const spy: OwnedPathsPolicy = {
      ...EMPTY_OWNED_PATHS_POLICY,
      bashRefusal: (_tool, token, candidates) => {
        seen.set(token, candidates);
        return undefined;
      },
    };
    screenRawBashCommand(args("cat a.txt", spy));
    expect(seen.get("a.txt")).toEqual([{ lexical: join(rawRoot, "a.txt"), rel: "a.txt" }]);
  });
});
