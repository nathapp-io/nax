/** Pure policies for canonical, repo-relative Git paths (forward-slash separated). */
const CONTROL_DIRECTORIES = [".nax/", ".github/", ".gitlab/"];
const SENSITIVE_NAMES = new Set(["package.json", ".npmrc", "bunfig.toml"]);

function isControlPath(file: string): boolean {
  return file === ".gitlab-ci.yml" || CONTROL_DIRECTORIES.some((prefix) => file.startsWith(prefix));
}

function fileName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Files the review summary should flag, preserving input order and spelling. */
export function sensitivePaths(files: readonly string[]): string[] {
  return files.filter((file) => isControlPath(file) || SENSITIVE_NAMES.has(fileName(file)));
}

/** Files a fix must never change; manifests alone are deliberately not protected. */
export function fixProtectedPaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const name = fileName(file);
    return (
      isControlPath(file) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      name === ".npmrc" ||
      name.endsWith(".pem") ||
      name.endsWith(".key") ||
      name.startsWith("id_rsa")
    );
  });
}
