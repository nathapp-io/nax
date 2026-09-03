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
import type { PolicyVerdict, ToolGrant, ToolPolicy } from "./types";

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

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((re) => re.test(value));
}

export function compileToolPolicy(grants: readonly ToolGrant[], root: string): ToolPolicy {
  const resolvedRoot = realOrRaw(root);
  const compiled = new Map<string, { unconditional: boolean; matchers: RegExp[]; raw: readonly string[] }>();

  for (const grant of grants) {
    const unconditional = grant.patterns.includes("*");
    compiled.set(grant.tool, {
      unconditional,
      matchers: grant.patterns.filter((p) => p !== "*").map(globToRegExp),
      raw: grant.patterns,
    });
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

      const resolvedPaths: string[] = [];
      for (const field of scope.pathFields) {
        const value = input[field];
        if (value === undefined) continue;
        if (typeof value !== "string") return deny(`"${field}" must be a string path`);

        const resolved = resolveWithin(resolvedRoot, value);
        if (resolved === null) {
          return deny(`path "${value}" resolves outside the permitted root`, true);
        }

        if (!grant.unconditional) {
          const rel = relative(resolvedRoot, resolved).split(sep).join("/");
          if (!matchesAny(grant.matchers, rel)) {
            return deny(`${tool} is not granted "${rel}" for this stage`);
          }
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
          resolvedPaths.push(resolved);
        }
      }

      return { allowed: true, resolvedPaths };
    },
  };
}
