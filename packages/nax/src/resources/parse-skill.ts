import { basename, dirname } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { readResourceFrontmatter } from "./frontmatter";
import { qualifyResourceName, resourceError, SKILL_NAME_RE } from "./parse-shared";
import type { ResourceDiagnostic, ResourceOrigin, SkillResource } from "./types";

export function parseSkillFile(
  path: string,
  text: string,
  origin: ResourceOrigin,
): { resource: SkillResource } | { diagnostic: ResourceDiagnostic } {
  try {
    const parsed = readResourceFrontmatter(text);
    if ("error" in parsed) return resourceError(path, origin, parsed.error);
    const baseDir = dirname(path);
    const name = parsed.data.name ?? basename(baseDir);
    if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
      return resourceError(path, origin, `Invalid skill name in ${path}`);
    }
    const description = parsed.data.description;
    if (typeof description !== "string" || !description.trim()) {
      return resourceError(path, origin, `Skill description is required in ${path}`);
    }
    return {
      resource: {
        kind: "skill",
        name,
        qualifiedName: qualifyResourceName(name, origin),
        description,
        body: parsed.body,
        baseDir,
        path,
        origin,
        modelInvocable: parsed.data["disable-model-invocation"] !== true,
      },
    };
  } catch (error) {
    return resourceError(path, origin, `Cannot parse ${path}: ${errorMessage(error)}`);
  }
}
