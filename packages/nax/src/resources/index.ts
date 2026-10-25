export { buildResourceCatalog, loadResourceCatalog } from "./catalog";
export { _claudePathsDeps, claudeConfigDir } from "./claude-paths";
export { discoverClaudeCodePackages } from "./claude-sources";
export type { ResourceFrontmatterResult } from "./frontmatter";
export { readResourceFrontmatter } from "./frontmatter";
export { naxPluginPackages } from "./nax-plugin-packages";
export { parseAgentFile } from "./parse-agent";
export { parseCommandFile } from "./parse-command";
export type { HookParseResult } from "./parse-hooks";
export { hooksFromSettings, parseHooksJson } from "./parse-hooks";
export { parseMcpJson } from "./parse-mcp";
export { SKILL_NAME_RE } from "./parse-shared";
export { parseSkillFile } from "./parse-skill";
export type { ResourceScanResult } from "./scan-dirs";
export {
  _resourceFsDeps,
  MAX_RESOURCE_FILES_PER_DIR,
  scanAgentsDir,
  scanCommandsDir,
  scanSkillsDir,
} from "./scan-dirs";
export { _skillsProviderDeps, createSkillsProvider, MAX_SKILL_FILE_BYTES } from "./skills-provider";
export type {
  AgentResource,
  CommandResource,
  HookResource,
  McpServerResource,
  ResourceCatalog,
  ResourceDiagnostic,
  ResourceOrigin,
  ResourcePackage,
  SkillResource,
} from "./types";
