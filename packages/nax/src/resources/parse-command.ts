import { basename } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { readResourceFrontmatter } from "./frontmatter";
import { qualifyResourceName, resourceError, SKILL_NAME_RE } from "./parse-shared";
import type { CommandResource, ResourceDiagnostic, ResourceOrigin } from "./types";

/** YAML treats [msg] as a sequence; command hints use that spelling as literal text. */
function argumentHint(text: string, value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const block = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(text)?.[1];
  return block?.match(/^argument-hint:[ \t]*(\[[^\r\n]*\])[ \t]*(?:#.*)?$/m)?.[1];
}

export function parseCommandFile(
  path: string,
  text: string,
  origin: ResourceOrigin,
): { resource: CommandResource } | { diagnostic: ResourceDiagnostic } {
  try {
    const parsed = readResourceFrontmatter(text);
    if ("error" in parsed) return resourceError(path, origin, parsed.error);
    const name = basename(path, ".md");
    if (!SKILL_NAME_RE.test(name)) return resourceError(path, origin, `Invalid command name in ${path}`);
    const description = typeof parsed.data.description === "string" ? parsed.data.description : undefined;
    const hint = argumentHint(text, parsed.data["argument-hint"]);
    return {
      resource: {
        kind: "command",
        name,
        qualifiedName: qualifyResourceName(name, origin),
        template: parsed.body,
        path,
        origin,
        ...(description === undefined ? {} : { description }),
        ...(hint === undefined ? {} : { argumentHint: hint }),
      },
    };
  } catch (error) {
    return resourceError(path, origin, `Cannot parse ${path}: ${errorMessage(error)}`);
  }
}
