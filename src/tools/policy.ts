/**
 * Compile declarative grants into a policy, and answer one call at a time.
 *
 * nax-permission-mode-allow: applies grants resolved by resolvePermissions;
 * decides no permission of its own.
 *
 * Containment runs BEFORE pattern matching and is not expressible in config:
 * the root is a hard boundary no profile can widen. `unrestricted` means "any
 * tool, any path within the root", never "any path on the machine".
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { isInside, realOrRaw } from "@/utils/realpath";
import { validateArgv } from "./exec-guard";
import type { PolicyVerdict, ToolGrant, ToolPolicy, ToolScope } from "./types";

/**
 * Absolute, symlink-resolved form of `candidate` if it lies inside `root`.
 *
 * The single containment seam. Multi-root support (a future configurable
 * extension) changes this function and nothing else, which is why every tool
 * receives an already-resolved path rather than resolving one itself.
 */
export function resolveWithin(root: string, candidate: string): string | null {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (!isInside(root, absolute)) return null;
  return realOrRaw(absolute);
}

/**
 * Minimatch-style glob to RegExp: `**` spans separators, `*` does not.
 *
 * `**` followed by `/` is zero or more COMPLETE directory segments, which is
 * why it does not simply compile to `.*`. `.*` both spans separators and
 * matches the empty string, so emitting it and dropping the separator erased
 * the boundary: `src/**\/config.ts` became `^src\/.*config\.ts$`, and a grant
 * for files named `config.ts` also admitted `src/legacyconfig.ts`.
 *
 * That was never a root escape -- containment runs before any pattern matching
 * -- but it made a *scoped* grant wider than its author wrote, which is the one
 * thing a scoped profile exists to prevent.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          // Optional, so `x/**/y` still matches `x/y` -- minimatch's behaviour.
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A compiled glob, keeping its source so verb names can be told from paths. */
interface CompiledPattern {
  readonly source: string;
  readonly re: RegExp;
}

function matchesAny(patterns: readonly CompiledPattern[], value: string): boolean {
  return patterns.some((p) => p.re.test(value));
}

/**
 * Split a grant pattern into whitespace-separated tokens, each compiled
 * independently. Per-token compilation (rather than joining argv with
 * spaces and matching one regex against the joined string) is deliberate:
 * a joined string lets a value containing spaces or glob metacharacters
 * shift what a later token appears to match. `"bun add*"` must mean "argv[0]
 * is exactly bun, argv[1] starts with add", never "the space-joined argv
 * matches this glob".
 */
function compileArgvPattern(pattern: string): readonly CompiledPattern[] {
  return pattern
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => ({ source: token, re: globToRegExp(token) }));
}

/** A grant pattern's tokens are a PREFIX of argv — trailing argv tokens
 * (the package name, flags, ...) are the payload a prefix grant like
 * `bun add*` does not itself constrain. */
function matchesArgvPattern(tokens: readonly CompiledPattern[], argv: readonly string[]): boolean {
  if (tokens.length > argv.length) return false;
  return tokens.every((token, i) => token.re.test(argv[i] as string));
}

function matchesArgvGrant(argvPatterns: readonly (readonly CompiledPattern[])[], argv: readonly string[]): boolean {
  return argvPatterns.some((tokens) => matchesArgvPattern(tokens, argv));
}

/** Read a top-level or dot-addressed path-bearing input field. */
function pathFieldValue(input: Record<string, unknown>, field: string): unknown {
  let value: unknown = input;
  for (const part of field.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function compileToolPolicy(grants: readonly ToolGrant[], root: string): ToolPolicy {
  const resolvedRoot = realOrRaw(root);
  const compiled = new Map<
    string,
    {
      unconditional: boolean;
      matchers: CompiledPattern[];
      argvPatterns: readonly (readonly CompiledPattern[])[];
      raw: readonly string[];
    }
  >();

  for (const grant of grants) {
    const unconditional = grant.patterns.includes("*");
    const nonWildcard = grant.patterns.filter((p) => p !== "*");
    compiled.set(grant.tool, {
      unconditional,
      matchers: nonWildcard.map((source) => ({ source, re: globToRegExp(source) })),
      argvPatterns: nonWildcard.map((source) => compileArgvPattern(source)),
      raw: grant.patterns,
    });
  }

  /**
   * The path globs in a grant, which for a verb-gated tool means the patterns
   * that are not verb names.
   *
   * A grant list is overloaded -- verbs for Git, path globs for Write -- so
   * matching every pattern against a path denied everything for Git, and
   * matching none left its paths bounded by the root alone. `allowedVerbs` is a
   * closed set the tool declares, so the two kinds separate without guessing.
   */
  function pathMatchers(matchers: CompiledPattern[], scope: ToolScope): CompiledPattern[] {
    const verbs = scope.allowedVerbs;
    return verbs === undefined ? matchers : matchers.filter((m) => !verbs.includes(m.source));
  }

  function deny(reason: string, breach = false): PolicyVerdict {
    return { allowed: false, reason, breach };
  }

  return {
    root: resolvedRoot,

    grantedTools() {
      return [...compiled.keys()];
    },

    check(tool, scope, input) {
      const grant = compiled.get(tool);
      if (grant === undefined) return deny(`tool "${tool}" is not permitted for this stage`);

      // An argv-bearing call (RunCommand's `Exec` branch) is checked entirely
      // here, never falling through to the verbField/pathFields logic below:
      // there is no "command" field on this shape for verbField to read.
      // `validateArgv` runs FIRST — before this grant's patterns are even
      // consulted — so a malformed token can never be admitted by a `*`
      // grant that would otherwise wave anything through unchecked.
      if (scope.argvField !== undefined) {
        const rawArgv = input[scope.argvField];
        if (rawArgv !== undefined) {
          const invalid = validateArgv(rawArgv);
          if (invalid !== undefined) return deny(invalid);
          const argv = rawArgv as readonly string[];
          if (!grant.unconditional && !matchesArgvGrant(grant.argvPatterns, argv)) {
            return deny(`${tool} is not granted for argv "${argv.join(" ")}"`);
          }
          return { allowed: true, resolvedPaths: [] };
        }
      }

      // Verb gating: the tool's own allowedVerbs bound what config can grant,
      // so a "*" grant can never reach a mutating subcommand.
      if (scope.verbField !== undefined) {
        const verb = input[scope.verbField];
        if (typeof verb !== "string") return deny(`"${scope.verbField}" must be a string`);
        if (scope.allowedVerbs !== undefined && !scope.allowedVerbs.includes(verb)) {
          return deny(`"${verb}" is not a permitted ${tool} subcommand`);
        }
        if (!grant.unconditional && !grant.raw.includes(verb)) {
          return deny(`${tool} is not granted the "${verb}" subcommand for this stage`);
        }
      }

      const globs = pathMatchers(grant.matchers, scope);
      const relativeTo = (resolved: string) => relative(resolvedRoot, resolved).split(sep).join("/");
      // A verb-only grant declares no path globs. That leaves the root as the
      // only bound -- unchanged behaviour, but now an authoring choice rather
      // than something the grant syntax could not express.
      const restrictPaths = !grant.unconditional && globs.length > 0;

      const resolvedPaths: string[] = [];
      for (const field of scope.pathFields) {
        const value = pathFieldValue(input, field);
        if (value === undefined) continue;
        if (typeof value !== "string") return deny(`"${field}" must be a string path`);

        const resolved = resolveWithin(resolvedRoot, value);
        if (resolved === null) {
          return deny(`path "${value}" resolves outside the permitted root`, true);
        }

        if (!grant.unconditional && !matchesAny(globs, relativeTo(resolved))) {
          return deny(`${tool} is not granted "${relativeTo(resolved)}" for this stage`);
        }
        resolvedPaths.push(resolved);
      }

      for (const field of scope.arrayPathFields ?? []) {
        const values = input[field];
        if (values === undefined) continue;
        if (!Array.isArray(values)) return deny(`"${field}" must be an array of string paths`);

        for (const value of values) {
          if (typeof value !== "string") return deny(`"${field}" entries must be strings`);
          const resolved = resolveWithin(resolvedRoot, value);
          if (resolved === null) {
            return deny(`"${field}" entry "${value}" resolves outside the permitted root`, true);
          }
          if (restrictPaths && !matchesAny(globs, relativeTo(resolved))) {
            return deny(`${tool} is not granted "${relativeTo(resolved)}" for this stage`);
          }
          resolvedPaths.push(resolved);
        }
      }

      for (const field of scope.refPathFields ?? []) {
        const values = input[field];
        if (values === undefined) continue;
        if (!Array.isArray(values)) return deny(`"${field}" must be an array of string refs`);

        for (const value of values) {
          if (typeof value !== "string") return deny(`"${field}" entries must be strings`);
          const colonAt = value.indexOf(":");
          if (colonAt === -1) continue; // pure revision, no path to check
          const candidatePath = value.slice(colonAt + 1);
          if (candidatePath === "") continue; // e.g. "HEAD:" — no path to check

          const resolved = resolveWithin(resolvedRoot, candidatePath);
          if (resolved === null) {
            return deny(`"${field}" entry "${value}" resolves outside the permitted root`, true);
          }
          if (restrictPaths && !matchesAny(globs, relativeTo(resolved))) {
            return deny(`${tool} is not granted "${relativeTo(resolved)}" for this stage`);
          }
          resolvedPaths.push(resolved);
        }
      }

      return { allowed: true, resolvedPaths };
    },
  };
}
