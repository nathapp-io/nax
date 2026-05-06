import type { NaxConfig } from "../config";
import { detectLanguage } from "../project";

export type SelfVerificationTool = "lint" | "typecheck";
export type SelfVerificationStatus = "pass" | "skip" | "pre_existing" | "fail";

export interface PreExistingFailure {
  packageDir: string;
  file?: string;
  tool: SelfVerificationTool;
  message: string;
}

export interface SelfVerificationResult {
  lint: SelfVerificationStatus;
  typecheck: SelfVerificationStatus;
  preExistingFailures: PreExistingFailure[];
  rawMarker?: string;
  missingMarker?: boolean;
}

export interface SelfVerificationPromptInput {
  packageDir: string;
  language?: string;
  lintCommand?: string;
  typecheckCommand?: string;
}

interface MarkerParseState {
  lint?: SelfVerificationStatus;
  typecheck?: SelfVerificationStatus;
  preExistingRaw?: string;
  rawMarker: string;
}

const STATUS_SET = new Set<SelfVerificationStatus>(["pass", "skip", "pre_existing", "fail"]);

function parseStatus(value: string | undefined): SelfVerificationStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as SelfVerificationStatus;
  return STATUS_SET.has(normalized) ? normalized : undefined;
}

function parseMarkerBlock(output: string): MarkerParseState | undefined {
  const idx = output.lastIndexOf("SELF_VERIFICATION:");
  if (idx < 0) return undefined;
  const lines = output.slice(idx).split("\n");
  const consumed: string[] = [];
  const state: MarkerParseState = { rawMarker: "" };
  let started = false;
  let fieldsSeen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed !== "SELF_VERIFICATION:") continue;
      started = true;
      consumed.push(line);
      continue;
    }
    if (trimmed.startsWith("# ") || trimmed.startsWith("## ")) break;
    if (trimmed.startsWith("```")) break;
    if (trimmed.length === 0 && fieldsSeen > 0) {
      consumed.push(line);
      continue;
    }
    consumed.push(line);
    if (trimmed.toLowerCase().startsWith("lint:")) {
      state.lint = parseStatus(trimmed.slice("lint:".length));
      fieldsSeen++;
      continue;
    }
    if (trimmed.toLowerCase().startsWith("typecheck:")) {
      state.typecheck = parseStatus(trimmed.slice("typecheck:".length));
      fieldsSeen++;
      continue;
    }
    if (trimmed.toLowerCase().startsWith("pre_existing_failures:")) {
      state.preExistingRaw = trimmed.slice("pre_existing_failures:".length).trim();
      fieldsSeen++;
    }
  }
  state.rawMarker = consumed.join("\n").trim();
  return state;
}

function parsePreExisting(
  raw: string | undefined,
  packageDir: string,
  lint: SelfVerificationStatus,
  typecheck: SelfVerificationStatus,
): PreExistingFailure[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PreExistingFailure[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const normalizedTool: SelfVerificationTool | undefined =
        row.tool === "lint" || row.tool === "typecheck" ? (row.tool as SelfVerificationTool) : undefined;
      const message = typeof row.message === "string" ? row.message : "";
      if (!normalizedTool || !message) continue;
      out.push({
        packageDir: typeof row.packageDir === "string" ? row.packageDir : packageDir,
        file: typeof row.file === "string" ? row.file : undefined,
        tool: normalizedTool,
        message,
      });
    }
    return out;
  } catch {
    const fallbackTool: SelfVerificationTool =
      typecheck === "pre_existing" && lint !== "pre_existing" ? "typecheck" : "lint";
    return [
      {
        packageDir,
        tool: fallbackTool,
        message: raw,
      },
    ];
  }
}

export function parseSelfVerificationMarker(output: string, packageDir = "."): SelfVerificationResult {
  const parsed = parseMarkerBlock(output);
  if (!parsed) {
    return {
      lint: "skip",
      typecheck: "skip",
      preExistingFailures: [],
      missingMarker: true,
    };
  }
  return {
    lint: parsed.lint ?? "skip",
    typecheck: parsed.typecheck ?? "skip",
    preExistingFailures: parsePreExisting(
      parsed.preExistingRaw,
      packageDir,
      parsed.lint ?? "skip",
      parsed.typecheck ?? "skip",
    ),
    rawMarker: parsed.rawMarker,
    missingMarker: false,
  };
}

export async function resolveSelfVerificationPromptInput(
  config: Pick<NaxConfig, "quality">,
  packageDir: string,
): Promise<SelfVerificationPromptInput> {
  return {
    packageDir,
    language: await detectLanguage(packageDir),
    lintCommand: config.quality?.commands?.lint,
    typecheckCommand: config.quality?.commands?.typecheck,
  };
}
