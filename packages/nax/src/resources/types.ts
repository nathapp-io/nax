export type ResourceOrigin =
  | { readonly kind: "claude-project" }
  | { readonly kind: "claude-user" }
  | { readonly kind: "claude-plugin"; readonly plugin: string; readonly marketplace: string }
  | { readonly kind: "nax-plugin"; readonly plugin: string };

export interface SkillResource {
  readonly kind: "skill";
  /** Frontmatter name, otherwise the directory name. */
  readonly name: string;
  /** Plugin resources use <plugin>:<name>; other resources use name. */
  readonly qualifiedName: string;
  readonly description: string;
  /** SKILL.md without its frontmatter. */
  readonly body: string;
  /** Absolute directory holding SKILL.md. */
  readonly baseDir: string;
  readonly path: string;
  /** False when disable-model-invocation is true. */
  readonly modelInvocable: boolean;
  readonly origin: ResourceOrigin;
}

export interface CommandResource {
  readonly kind: "command";
  /** File name without .md. */
  readonly name: string;
  readonly qualifiedName: string;
  readonly description?: string;
  readonly argumentHint?: string;
  /** Body without frontmatter. */
  readonly template: string;
  readonly path: string;
  readonly origin: ResourceOrigin;
}

/** Parsed and listed only; delivery is deferred to F5. */
export interface AgentResource {
  readonly kind: "agent";
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly path: string;
  readonly origin: ResourceOrigin;
}

/** Parsed and listed only; delivery is deferred to F5. */
export interface McpServerResource {
  readonly kind: "mcp";
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly path: string;
  readonly origin: ResourceOrigin;
}

/** Parsed and listed only, never executed. */
export interface HookResource {
  readonly kind: "hooks";
  readonly events: readonly string[];
  readonly path: string;
  readonly origin: ResourceOrigin;
}

export interface ResourceDiagnostic {
  readonly severity: "warn" | "error";
  readonly path: string;
  readonly message: string;
  readonly origin: ResourceOrigin;
}

export interface ResourceCatalog {
  readonly packages: readonly ResourcePackage[];
  /** Every loaded skill in package order, including shadowed resources. */
  readonly skills: readonly SkillResource[];
  readonly commands: readonly CommandResource[];
  /** Package diagnostics plus name collisions. */
  readonly diagnostics: readonly ResourceDiagnostic[];
  findSkill(name: string): SkillResource | undefined;
  findCommand(name: string): CommandResource | undefined;
}

export interface ResourcePackage {
  /** claude-project | claude-user | <name>@<marketplace> | nax:<name> */
  readonly id: string;
  readonly origin: ResourceOrigin;
  readonly root: string;
  readonly skills: readonly SkillResource[];
  readonly commands: readonly CommandResource[];
  readonly agents: readonly AgentResource[];
  readonly mcpServers: readonly McpServerResource[];
  readonly hooks: readonly HookResource[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}
