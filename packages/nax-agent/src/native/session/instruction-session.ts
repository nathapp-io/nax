import type { OpenSessionOpts } from "#src/session/session-types";
import { RepositoryInstructions } from "./repository-instructions.ts";
import { transcriptModelIdentity } from "./transcript-identity.ts";
import type { TranscriptStore } from "./transcript-types.ts";

export async function openRepositoryInstructions(
  name: string,
  opts: OpenSessionOpts,
  store: TranscriptStore,
): Promise<RepositoryInstructions> {
  const instructions = new RepositoryInstructions(
    opts.workdir,
    opts.instructionProtectedPaths,
    opts.instructionDenyPaths,
    opts.instructionFileName,
  );
  for (const directory of [".", ...(opts.instructionDirectories ?? [])]) await instructions.discover(directory);
  if (opts.resume !== true) return instructions;
  // Open historically performs no history I/O that can fail the session. The
  // turn loop remains the authoritative load/error boundary; unavailable
  // provenance simply leaves the explicitly supplied scopes in place.
  const doc = await Promise.resolve()
    .then(() => store.load(name))
    .catch(() => null);
  if (doc === null || (doc.schemaVersion !== undefined && doc.schemaVersion !== 1) || !Array.isArray(doc.messages))
    return instructions;
  const ownerMatches = opts.transcriptOwner === undefined || doc?.owner === opts.transcriptOwner;
  const modelMatches =
    opts.carryHistoryAcrossModels === true ||
    doc?.model === undefined ||
    doc.model === transcriptModelIdentity(opts.modelDef?.model);
  if (ownerMatches && modelMatches) {
    const directories = doc?.instructionDirectories;
    if (Array.isArray(directories)) {
      for (const directory of directories.slice(0, 64)) {
        if (typeof directory === "string") await instructions.discover(directory);
      }
    }
  }
  return instructions;
}
