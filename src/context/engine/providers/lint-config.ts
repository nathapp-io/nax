/**
 * Context Engine v2 — LintConfigProvider (US-004)
 *
 * Reads package lint configuration from `request.packageDir` via the public
 * `detectProjectProfile()` detector, distils the settings most likely to cause
 * a retry loop, and surfaces them as a `lint-config` kind chunk at project
 * scope.
 *
 * Failure handling (per spec):
 * - Provider source file absent (no `biome.json` / `.eslintrc*` / etc.):
 *   `fetch()` returns a chunk naming the detected tool; never throws.
 * - Provider source file malformed (unparseable JSON):
 *   `fetch()` returns a chunk naming the detected tool; never throws.
 * - No lint tool detectable for the package:
 *   `fetch()` returns empty chunks; never throws.
 * - `detectProjectProfile` itself throws:
 *   `fetch()` returns empty chunks; never throws.
 *
 * Wire contract: pullTools is always empty (push-style provider).
 *
 * See: docs/superpowers/specs/2026-08-15-context-engine-v22-providers-design.md
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ProjectProfile } from "@/config";
import { getLogger } from "@/logger";
import { detectProjectProfile as _detectProjectProfile } from "@/project";
import { errorMessage } from "@/utils/errors";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on
 * the exported object to inject fakes without `mock.module()`.
 *
 * The detector must be the public one — the spec is explicit that lint-tool
 * detection goes through `detectProjectProfile()` rather than being
 * re-implemented here, so a rectifier retrying a lint failure receives the
 * same tool name the rest of nax uses.
 */
export const _lintConfigProviderDeps: {
  detectProjectProfile: (workdir: string, existing: Partial<ProjectProfile>) => Promise<ProjectProfile>;
  fileExists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
} = {
  detectProjectProfile: _detectProjectProfile,
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Lint config source-file candidates per detected tool.
 *
 * Order matters: the first existing file wins. Only biome ships a distiller
 * today; every other entry degrades to a chunk that names the detected tool
 * and nothing else, matching AC7.
 *
 * Reachability: every candidate here must be reachable through the public
 * detector. The detector only fires lintTool based on a small set of files
 * — `biome.json`, `.eslintrc{,.js,.json}` for Node/Bun projects, and
 * language-derived for Go/Rust/Python. Including candidates the detector
 * never returns (e.g. `biome.jsonc`, `.eslintrc.cjs`, `.eslintrc.yaml`)
 * would mislead readers: those candidates can never be reached because the
 * detector sets `lintTool: undefined` when only those files are present.
 *
 * For language-detected tools, the standalone files (`.ruff.toml`,
 * `ruff.toml`, `.golangci.*`, `Cargo.toml`) are reachable as fallbacks when
 * the primary marker (e.g. pyproject.toml for ruff) is present.
 */
const LINT_CONFIG_FILES: Record<string, string[]> = {
  biome: ["biome.json"],
  eslint: [".eslintrc.json", ".eslintrc.js", ".eslintrc"],
  // ruff: language-detected when pyproject.toml or requirements.txt is present;
  // standalone configs act as fallbacks.
  ruff: ["pyproject.toml", ".ruff.toml", "ruff.toml"],
  // golangci-lint: language-detected (go.mod). Configs are fallbacks.
  "golangci-lint": [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
  // clippy: language-detected (Cargo.toml). Cargo.toml also acts as the
  // config carrier ([lints.clippy] table), so the candidate almost always matches.
  clippy: ["Cargo.toml"],
};

/**
 * Distill the settings most likely to cause a retry loop.
 *
 * Returns an array of `key: value` lines, one per supported setting.
 * The returned lines are emitted under the chunk's "## Settings" heading.
 *
 * Only biome is supported today — see the spec: "diagnostic parsers beyond
 * `tsc` and `biome` are not implemented; other toolchains take the
 * raw-tail path." The lint config distiller mirrors that constraint:
 * biome gets a structured distil; everything else degrades to "no
 * distiller — chunk names the detected tool".
 */
function distillLintConfig(tool: string, raw: string): string[] {
  if (tool !== "biome") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — return no distilled settings. The caller still
    // emits a chunk naming the tool, per AC10.
    return [];
  }

  // AC10: never throw on malformed-but-valid JSON. JSON literals like
  // `null`, `42`, `"foo"`, `true`, or `[...]` parse cleanly but are not
  // objects — accessing `.formatter` on any of them would throw.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const parsedObj = parsed as Record<string, unknown>;

  const lines: string[] = [];

  // formatter.indentStyle / formatter.indentWidth
  const formatter = parsedObj.formatter;
  if (formatter && typeof formatter === "object") {
    const fmt = formatter as Record<string, unknown>;
    if (typeof fmt.indentStyle === "string") {
      lines.push(`indent style: ${fmt.indentStyle}`);
    }
    if (typeof fmt.indentWidth === "number") {
      lines.push(`indent width: ${fmt.indentWidth}`);
    }
    if (typeof fmt.lineWidth === "number") {
      lines.push(`line width: ${fmt.lineWidth}`);
    }
  }

  // Top-level indentWidth (legacy / common biome.json shape).
  if (typeof parsedObj.indentWidth === "number" && !lines.some((l) => l.startsWith("indent width"))) {
    lines.push(`indent width: ${parsedObj.indentWidth}`);
  }

  return lines;
}

/**
 * Build the chunk content. Always names the detected tool when one is
 * available. Distilled settings follow under a "Settings" heading.
 */
function buildChunkContent(tool: string, distilled: readonly string[]): string {
  const lines: string[] = [`# Lint tool: ${tool}`];
  if (distilled.length > 0) {
    lines.push("");
    lines.push("## Settings");
    for (const setting of distilled) lines.push(`- ${setting}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads `<request.packageDir>/biome.json` (or the equivalent config file for
 * the detected linter) and emits a single `lint-config` chunk at project
 * scope. Detects the lint tool via the public `detectProjectProfile()`
 * detector, so the tool name reported to the rectifier matches the rest of
 * nax.
 */
export class LintConfigProvider implements IContextProvider {
  readonly id = "lint-config" as const;
  readonly kind = "lint-config" as const;

  constructor(private readonly existing: Partial<ProjectProfile> = {}) {}

  async fetch(request: ContextRequest, _signal?: AbortSignal): Promise<ContextProviderResult> {
    const logger = getLogger();
    const packageDir = request.packageDir;

    // Detect the lint tool through the public detector. The spec is explicit:
    // "detect from request.packageDir through the public profile detector."
    let profile: ProjectProfile;
    try {
      profile = await _lintConfigProviderDeps.detectProjectProfile(packageDir, this.existing);
    } catch (err) {
      logger.warn("lint-config", "detectProjectProfile threw — returning empty chunks", {
        storyId: request.storyId,
        packageDir,
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }

    const tool = profile.lintTool;
    if (!tool) {
      // AC9: no lint tool detectable → empty chunks, never throws.
      return { chunks: [], pullTools: [] };
    }

    // Try to find a config file. AC8: when no lint configuration source file
    // exists, fetch returns empty chunks without throwing — even when a lint
    // tool is detected. A chunk only makes sense when there is content to
    // surface.
    const candidates = LINT_CONFIG_FILES[tool] ?? [];
    let rawConfig: string | null = null;
    let foundPath: string | null = null;
    for (const fileName of candidates) {
      const path = join(packageDir, fileName);
      let exists = false;
      try {
        exists = await _lintConfigProviderDeps.fileExists(path);
      } catch {
        // Probe failure — try next candidate.
        exists = false;
      }
      if (!exists) continue;
      try {
        rawConfig = await _lintConfigProviderDeps.readFile(path);
        foundPath = path;
        break;
      } catch {
        // Read failure — try next candidate.
        rawConfig = null;
      }
    }

    if (rawConfig === null) {
      // AC8: no lint configuration source file exists → empty chunks.
      // A chunk that only names the tool is noise — the detector already
      // produced the tool name; the chunk adds nothing actionable.
      logger.debug("lint-config", "No lint config source file found — returning empty chunks", {
        storyId: request.storyId,
        packageDir,
        tool,
      });
      return { chunks: [], pullTools: [] };
    }

    const distilled = rawConfig !== null ? distillLintConfig(tool, rawConfig) : [];
    const content = buildChunkContent(tool, distilled);
    const hash = contentHash8(content);
    const tokens = Math.ceil(content.length / 4);

    const chunk: RawChunk = {
      id: `lint-config:${hash}`,
      kind: "lint-config",
      scope: "project",
      role: ["implementer", "reviewer"],
      content,
      tokens,
      rawScore: 0.9,
    };

    logger.debug("lint-config", "Emitted lint-config chunk", {
      storyId: request.storyId,
      packageDir,
      tool,
      configPath: foundPath,
      distilledSettingCount: distilled.length,
    });

    return { chunks: [chunk], pullTools: [] };
  }
}
