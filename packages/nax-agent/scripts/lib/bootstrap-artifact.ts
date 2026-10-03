import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function payloadFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((relative) => {
      const stat = lstatSync(join(dir, relative));
      if (stat.isSymbolicLink()) throw new Error(`bootstrap: symlink in artifact: ${relative}`);
      if (stat.isDirectory()) return false;
      if (!stat.isFile()) throw new Error(`bootstrap: unsupported file: ${relative}`);
      return true;
    })
    .sort();
}

function manifestWithoutProvenance(path: string): unknown {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.publishConfig?.provenance !== "boolean") {
    throw new Error("bootstrap: invalid package.json provenance metadata");
  }
  delete manifest.publishConfig.provenance;
  return manifest;
}

/** Only the maintainer's deliberately disabled bootstrap provenance may differ. */
export function assertBootstrapArtifact(stagedDir: string, unpackedDir: string): void {
  const staged = payloadFiles(stagedDir);
  const packed = payloadFiles(unpackedDir);
  if (!isDeepStrictEqual(staged, packed)) throw new Error("bootstrap: package file inventory differs");
  for (const file of staged) {
    const left = join(stagedDir, file);
    const right = join(unpackedDir, file);
    const equal =
      file === "package.json"
        ? isDeepStrictEqual(manifestWithoutProvenance(left), manifestWithoutProvenance(right))
        : readFileSync(left).equals(readFileSync(right));
    if (!equal) throw new Error(`bootstrap: registry artifact differs: ${file}`);
  }
}
