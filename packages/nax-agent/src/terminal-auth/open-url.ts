/**
 * Opening a URL in the user's browser (moved from the nax CLI, S5-4 M-28).
 *
 * Best-effort: the caller always prints the URL first, so a failure costs a
 * copy-paste, not the login. The URL is its own argv entry, never a shell
 * string. Node reports a missing opener asynchronously (an `error` event), so
 * the child gets an error listener; without it a container with no xdg-open
 * would crash the login (S5-4 Review Focus 2).
 */
import { type ChildProcess, spawn } from "node:child_process";

export function spawnDetached(command: readonly string[]): ChildProcess {
  const [file, ...args] = command;
  // nax-git-env-allow: not git: browser opener argv
  const child = spawn(file ?? "", args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {
    // The URL is already on screen; a missing opener is not news.
  });
  child.unref();
  return child;
}

/** Test seam. */
export const _openUrlDeps: {
  spawn: (command: readonly string[]) => void;
  platform: () => string;
} = {
  spawn: (command) => {
    spawnDetached(command);
  },
  platform: () => process.platform,
};

/** The opener for a platform. Windows needs the empty "" title argument. */
function openerFor(platform: string, url: string): readonly string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openUrl(url: string): void {
  try {
    // nax-git-env-allow: not git: browser opener argv
    _openUrlDeps.spawn(openerFor(_openUrlDeps.platform(), url));
  } catch {
    // Deliberately silent: the URL is already on screen.
  }
}
