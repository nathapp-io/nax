/**
 * Injectable dependencies for framework-config parsers.
 *
 * Kept in a dedicated module so Python and JS parser files can both import
 * the same singleton without creating a circular dependency with
 * framework-configs.ts (which imports from both parser files).
 */
export const _frameworkConfigDeps = {
  readText: async (path: string): Promise<string | null> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return f.text();
  },
  parseToml: (text: string): unknown => Bun.TOML.parse(text),
  parseYaml: (text: string): unknown => Bun.YAML.parse(text),
};
