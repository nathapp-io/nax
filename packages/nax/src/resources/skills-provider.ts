/** Catalog-scoped delivery: references are confined to each skill, not the hop's workdir. */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { buildSkillsInstructions } from "@/prompts/builders/skills-builder";
import type { ResourceCatalog, SkillResource } from "./types";

export const MAX_SKILL_FILE_BYTES = 262_144;
const MAX_AVAILABLE_SKILLS = 20;

export const _skillsProviderDeps = {
  realpath,
  // Bun.file has no regular-file metadata API.
  stat,
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(
      await Bun.file(path)
        .slice(0, MAX_SKILL_FILE_BYTES + 1)
        .arrayBuffer(),
    );
  },
};

function failure(content: string): ToolResult {
  return { content, isError: true };
}

function outside(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function readReference(skill: SkillResource, name: string, file: string): Promise<ToolResult> {
  const denied = () => failure(`file ${file} is outside skill ${name}`);
  if (isAbsolute(file) || file.includes("\0")) return denied();
  try {
    const base = await _skillsProviderDeps.realpath(skill.baseDir);
    const target = await _skillsProviderDeps.realpath(join(base, file));
    if (outside(base, target)) return denied();
    const info = await _skillsProviderDeps.stat(target);
    if (!info.isFile()) return failure(`file ${file} is not a regular file`);
    if (info.size > MAX_SKILL_FILE_BYTES) return failure(`file ${file} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    const bytes = await _skillsProviderDeps.readFile(target);
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) return failure(`file ${file} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    return { content: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return failure(`skill ${name} has no file ${file}`);
    }
    return failure(`[resources] Cannot read file ${file} for skill ${name}: ${errorMessage(error)}`);
  }
}

async function loadSkill(catalog: ResourceCatalog, input: Record<string, unknown>): Promise<ToolResult> {
  const { name, file } = input;
  if (typeof name !== "string" || (file !== undefined && typeof file !== "string")) {
    return failure("[resources] load requires name: string and optional file: string");
  }
  const skill = catalog.findSkill(name);
  if (!skill) {
    const available = catalog.skills
      .slice(0, MAX_AVAILABLE_SKILLS)
      .map((entry) => entry.qualifiedName)
      .join(", ");
    return failure(`unknown skill ${name}; available: ${available}`);
  }
  if (file !== undefined) return readReference(skill, name, file);
  if (!skill.modelInvocable) return failure(`skill ${name} can only be invoked by the user`);
  return { content: `Base directory for this skill: ${skill.baseDir}\n\n${skill.body}` };
}

/** Lazily share even an in-flight catalog load for this provider's lifetime. */
export function createSkillsProvider(load: () => Promise<ResourceCatalog>): ToolProvider {
  let pending: Promise<ResourceCatalog> | undefined;
  const catalog = () => (pending ??= Promise.resolve().then(load));
  const tool: ProviderTool = {
    localName: "load",
    description: "Load a catalog skill body or a reference file relative to that skill's base directory.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, file: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async run(input) {
      try {
        return await loadSkill(await catalog(), input);
      } catch (error) {
        return failure(`[resources] Cannot load skill: ${errorMessage(error)}`);
      }
    },
  };
  return {
    id: "nax-skills",
    kind: "static",
    stages: ["*"],
    tools: async () => ((await catalog()).skills.length ? [tool] : []),
    async instructions() {
      const skills = (await catalog()).skills.filter((skill) => skill.modelInvocable);
      return skills.length ? buildSkillsInstructions(skills) : undefined;
    },
  };
}
