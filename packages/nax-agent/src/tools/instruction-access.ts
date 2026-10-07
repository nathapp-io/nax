/** Transport-neutral scope hook, invoked only after coding-tool authorization. */

import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { NaxError } from "#src/infra/nax-error";
import { credentialReadRefusal } from "./credential-read-deny.ts";
import type { ProtectedPathsPolicy } from "./protected-paths.ts";
import type { ToolPolicy } from "./types.ts";

type InstructionAccess = (
  paths: readonly string[],
  canRead: (path: string) => boolean,
  protectedPaths?: ProtectedPathsPolicy,
) => Promise<string | undefined>;
export const _instructionAccessDeps = { stat };
const access = new AsyncLocalStorage<InstructionAccess>();
export function withInstructionAccess<T>(observer: InstructionAccess, run: () => Promise<T>): Promise<T> {
  return access.run(observer, run);
}
export async function discoverAuthorizedInstructions(
  name: string,
  paths: readonly string[],
  policy: ToolPolicy,
  protectedPaths?: ProtectedPathsPolicy,
): Promise<string | undefined> {
  if (!["Read", "Write", "Edit"].includes(name)) return;
  const observer = access.getStore();
  if (observer === undefined || paths.some((path) => credentialReadRefusal(protectedPaths, path) !== undefined)) return;
  const targets = name === "Write" ? paths.map((path) => dirname(path)) : paths;
  const present = await Promise.all(
    targets.map((path) =>
      _instructionAccessDeps.stat(path).then(
        (metadata) => (name === "Write" ? metadata.isDirectory() : metadata.isFile()),
        () => false,
      ),
    ),
  );
  if (present.some((found) => !found)) return;
  const guidance = await observer(
    paths,
    (path) => policy.check("Read", { pathFields: ["path"] }, { path }).allowed,
    protectedPaths,
  );
  return name === "Read" ? undefined : guidance || undefined;
}

/** A mutation must be proposed again after the model has received new guidance. */
export async function enforceInstructionAccess(
  name: string,
  paths: readonly string[],
  policy: ToolPolicy,
  protectedPaths?: ProtectedPathsPolicy,
): Promise<void> {
  const guidance = await discoverAuthorizedInstructions(name, paths, policy, protectedPaths);
  if (guidance !== undefined)
    throw new NaxError(guidance, "REPOSITORY_INSTRUCTIONS_DISCOVERED", { stage: "coding-tool" });
}
