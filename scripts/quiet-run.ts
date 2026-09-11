#!/usr/bin/env bun
/**
 * Runs the given command as-is. When AGENT=1, output is captured and only
 * printed if the command fails — a green (exit 0) command stays silent
 * beyond a one-line "OK" marker.
 *
 * Usage: bun scripts/quiet-run.ts <command> [args...]
 */

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("Usage: bun scripts/quiet-run.ts <command> [args...]");
    process.exit(1);
  }

  const quiet = process.env.AGENT === "1";
  const label = [cmd, ...args].join(" ");

  const proc = Bun.spawn([cmd, ...args], {
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });

  const status = await proc.exited;

  if (quiet) {
    if (status === 0) {
      console.log(`OK: ${label}`);
    } else {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  }

  process.exit(status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
