/**
 * Acceptance Fix Diagnosis
 *
 * Provides source-file loading utilities used by the acceptance diagnosis flow.
 */

const MAX_SOURCE_FILES = 5;
const MAX_FILE_LINES = 500;

function parseImportStatements(content: string): string[] {
  const importRegex = /import\s+(?:{[^}]+}|[^;]+)\s+from\s+["']([^"']+)["']/g;
  const imports: string[] = [];
  const regexMatch = content.matchAll(importRegex);
  for (const match of regexMatch) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveImportPaths(imports: string[], _workdir: string): string[] {
  const resolved: string[] = [];
  for (const imp of imports) {
    if (imp.startsWith(".")) {
      resolved.push(imp);
    }
  }
  return resolved.slice(0, MAX_SOURCE_FILES);
}

export async function loadSourceFilesForDiagnosis(
  testFileContent: string,
  workdir: string,
): Promise<Array<{ path: string; content: string }>> {
  const imports = parseImportStatements(testFileContent);
  const relativeImports = resolveImportPaths(imports, workdir);
  const results = await Promise.all(relativeImports.map((imp) => readSourceFileContent(imp, workdir)));
  return results.filter((f): f is { path: string; content: string } => f !== null);
}

async function readSourceFileContent(
  filePath: string,
  workdir: string,
): Promise<{ path: string; content: string } | null> {
  try {
    const fullPath = `${workdir}/${filePath}`;
    const file = await Bun.file(fullPath).text();
    const lines = file.split("\n").slice(0, MAX_FILE_LINES);
    return { path: filePath, content: lines.join("\n") };
  } catch {
    return null;
  }
}
