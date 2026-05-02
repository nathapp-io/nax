import type { Finding } from "../types";

function extractExcerpt(output: string, acId: string): string {
  const lines = output.split("\n");
  const idx = lines.findIndex((l) => l.toLowerCase().includes(acId.toLowerCase()));
  if (idx === -1) return `${acId} failed`;
  const end = Math.min(lines.length, idx + 5);
  return lines.slice(idx, end).join("\n").trim() || `${acId} failed`;
}

export function acFailureToFinding(acId: string, output: string): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "assertion-failure",
    rule: acId,
    message: extractExcerpt(output, acId),
    fixTarget: "source",
  };
}

export function acSentinelToFinding(sentinel: "AC-HOOK" | "AC-ERROR", _output: string): Finding {
  if (sentinel === "AC-HOOK") {
    return {
      source: "test-runner",
      severity: "error",
      category: "hook-failure",
      message: "beforeAll/afterAll hook timed out",
      fixTarget: "test",
    };
  }
  return {
    source: "test-runner",
    severity: "critical",
    category: "test-runner-error",
    message: "Test runner crashed before test bodies ran",
    fixTarget: "test",
  };
}
