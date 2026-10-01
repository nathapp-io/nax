/**
 * A SandboxBackend double with every production failure mode (master plan 5:
 * a double that cannot fail the way production fails hides a critical).
 *
 * - enforce: runs the command, rewriting any `> <denied path>` redirect to
 *   `/dev/null` -- enough to model the probe and simple denied writes. Real
 *   enforcement is tested against real srt in the live suite (Task 12).
 * - leak: runs the command as-is (a sandbox that does not enforce).
 * - cannot-run: every command fails like bwrap in stock Docker (spec F4).
 * - throw: wrap rejects.
 * - unsupported: isSupportedPlatform() resolves false.
 */
import type { SandboxBackend, SandboxWrapRequest } from "@/sandbox";

export type FakeSandboxMode = "enforce" | "leak" | "cannot-run" | "throw" | "unsupported";

export function makeFakeSandboxBackend(
  mode: FakeSandboxMode = "enforce",
): SandboxBackend & { readonly calls: SandboxWrapRequest[]; finished: number } {
  const calls: SandboxWrapRequest[] = [];
  const fake = {
    name: "srt" as const,
    calls,
    finished: 0,
    async isSupportedPlatform() {
      return mode !== "unsupported";
    },
    async wrap(req: SandboxWrapRequest): Promise<readonly string[]> {
      calls.push(req);
      if (mode === "throw") throw new Error("fake wrap failure");
      if (mode === "cannot-run") {
        return ["/bin/sh", "-c", 'echo "bwrap: Can\'t mount proc on /proc: Operation not permitted" >&2; exit 1'];
      }
      if (mode === "enforce") {
        // Neutralise redirects into denied paths: the only shape the fake must
        // honour is `> <denied path>` / `> <relative path resolving to one>`.
        let command = req.command;
        for (const denied of req.policy.denyWrite) {
          const rel = denied.startsWith(`${req.cwd}/`) ? denied.slice(req.cwd.length + 1) : denied;
          command = command.replaceAll(`> ${denied}`, "> /dev/null").replaceAll(`> ${rel}`, "> /dev/null");
        }
        return [req.shell, "-c", command];
      }
      return [req.shell, "-c", req.command];
    },
    annotate() {
      return "";
    },
    commandFinished() {
      fake.finished += 1;
    },
    async reset() {},
  };
  return fake;
}
