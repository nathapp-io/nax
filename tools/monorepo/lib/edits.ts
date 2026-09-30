// tools/monorepo/lib/edits.ts
const ROOT_QUALITY_COMMANDS = {
  test: "bun run test",
  typecheck: "bun run typecheck",
  lint: "bun run check:all",
  build: "bun run build",
} as const;

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export function editNaxPackageJson(text: string): string {
  const pkg = JSON.parse(text) as { scripts?: Record<string, string>; repository?: Record<string, string> };
  if (pkg.scripts?.prepare !== undefined) throw new Error("editNaxPackageJson: prepare script still present");
  return json({ ...pkg, repository: { ...pkg.repository, directory: "packages/nax" } });
}

export function splitNaxConfig(text: string): { root: string; mono: string } {
  const cfg = JSON.parse(text) as { quality?: { commands?: Record<string, unknown> } & Record<string, unknown> };
  const commands = cfg.quality?.commands;
  if (!commands) throw new Error("splitNaxConfig: .nax/config.json has no quality.commands");
  return {
    root: json({ ...cfg, quality: { ...cfg.quality, commands: ROOT_QUALITY_COMMANDS } }),
    mono: json({ quality: { commands } }),
  };
}

export function editClaudeSettings(text: string): string {
  const OLD = "bun x biome lint --write src/ bin/";
  if (!text.includes(OLD)) throw new Error("editClaudeSettings: expected hook command not found");
  return text.replace(OLD, `cd packages/nax && ${OLD}`);
}

const PKG_NOTE =
  "> Package commands below run from `packages/nax/` (`cd packages/nax`). From the repo root, `bun run build|typecheck|lint|check:all|test` run every package in dependency order.\n";

export function editContributing(text: string): string {
  const withNote = text.includes(PKG_NOTE) ? text : text.replace("## Development Setup\n", `## Development Setup\n\n${PKG_NOTE}`);
  return withNote.replace("Ensure the full test suite passes: `bun test`", "Ensure the full test suite passes: `bun run test`");
}

export function markBiomeNested(text: string): string {
  const cfg = JSON.parse(text) as Record<string, unknown>;
  const { root: _drop, ...rest } = cfg;
  return json({ root: false, ...rest });
}
