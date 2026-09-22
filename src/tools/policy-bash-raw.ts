/**
 * The `raw` bash mode screen (ADR-030).
 *
 * `raw` is pass-through: no per-segment grant matching, no root containment,
 * and — unlike `checkBashCommand` — a command the lexer CANNOT read is ALLOWED
 * rather than refused. That inversion is the whole point of the mode.
 *
 * The one thing this screen still does is catch a naive mistake: if the lexer
 * CAN parse the command and a segment names or redirects into a path nax owns
 * (`.nax/config.json`, `.nax/mono/*\/config.json`, `.nax/features/**\/prd.json`,
 * the root queue-control files), the command is denied.
 *
 * ADVISORY BY CONSTRUCTION. A command using substitution is not parsed and
 * therefore is not screened at all: `sh -c "$(echo rm) .nax/features/f/prd.json"`
 * passes straight through. This is a mistake-catcher, not a boundary, and it
 * must never grow into a general gate — gating lives in policy, once
 * (`src/tools/bash.ts:14-19`).
 */
import { relative, sep } from "node:path";
import { lexBashCommand } from "@/permissions";
import { isNaxConfigFile, isNaxOwnedWritePath } from "./nax-owned-writes";
import type { BashCheck } from "./policy-bash";

export interface RawScreenArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The shell's initial working directory. */
  readonly initialPath: string;
  /** Resolves a candidate from an effective shell working directory. */
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  /** The permitted root, used to relativise a resolved path. */
  readonly root: string;
}

function deny(reason: string): BashCheck {
  // Never escalatable: a protected-path write is affirmatively out of bounds,
  // not a command the gate merely could not read.
  return { kind: "deny", reason, breach: false, escalatable: false };
}

/** A protected path, named for the refusal message, or undefined. */
function protectedHit(args: RawScreenArgs, candidate: string): string | undefined {
  const resolved = args.resolvePath(candidate, args.initialPath);
  if (resolved === null) return undefined;
  if (isNaxConfigFile(args.root, resolved)) return candidate;
  const rel = relative(args.root, resolved).split(sep).join("/");
  if (rel.startsWith("..")) return undefined;
  return isNaxOwnedWritePath(rel) ? candidate : undefined;
}

export function screenRawBashCommand(args: RawScreenArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  // The inversion: unreadable means unscreened, and unscreened means allowed.
  if (lexed.kind === "refused") return { kind: "allow" };

  for (const segment of lexed.segments) {
    for (const token of segment.tokens) {
      if (token.opaque) continue;
      const hit = protectedHit(args, token.text);
      if (hit !== undefined) {
        return deny(
          `${tool} command names "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
    }
    for (const redirect of segment.redirects) {
      if (redirect.opaque) continue;
      const hit = protectedHit(args, redirect.target);
      if (hit !== undefined) {
        return deny(
          `${tool} command redirects into "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
    }
  }

  return { kind: "allow" };
}
