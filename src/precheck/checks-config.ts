/**
 * Configuration-related precheck implementations
 */

import { existsSync, statSync } from "node:fs";
import type { PRD } from "../prd/types";
import type { Check } from "./types";

/** Check if nax.lock is older than 2 hours. */
export async function checkStaleLock(workdir: string): Promise<Check> {
  const lockPath = `${workdir}/nax.lock`;
  const exists = existsSync(lockPath);

  if (!exists) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: true,
      message: "No lock file present",
    };
  }

  try {
    const file = Bun.file(lockPath);
    const content = await file.text();
    const lockData = JSON.parse(content);

    let lockTimeMs: number;
    if (lockData.timestamp) {
      lockTimeMs = lockData.timestamp;
    } else if (lockData.startedAt) {
      lockTimeMs = new Date(lockData.startedAt).getTime();
    } else {
      const stat = statSync(lockPath);
      lockTimeMs = stat.mtimeMs;
    }

    const ageMs = Date.now() - lockTimeMs;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const passed = ageMs < twoHoursMs;

    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed,
      message: passed ? "Lock file is fresh" : "stale lock detected (over 2 hours old)",
    };
  } catch {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: false,
      message: "Failed to read lock file",
    };
  }
}

/** Validate PRD structure and required fields. Auto-defaults: tags=[], status=pending, storyPoints=1 */
export async function checkPRDValid(prd: PRD): Promise<Check> {
  const errors: string[] = [];

  if (!prd.project || prd.project.trim() === "") {
    errors.push("Missing project field");
  }
  if (!prd.feature || prd.feature.trim() === "") {
    errors.push("Missing feature field");
  }
  if (!prd.branchName || prd.branchName.trim() === "") {
    errors.push("Missing branchName field");
  }
  if (!Array.isArray(prd.userStories)) {
    errors.push("userStories must be an array");
  }

  if (Array.isArray(prd.userStories)) {
    for (const story of prd.userStories) {
      story.tags = story.tags ?? [];
      story.status = story.status ?? "pending";
      story.storyPoints = story.storyPoints ?? 1;
      story.acceptanceCriteria = story.acceptanceCriteria ?? [];

      if (!story.id || story.id.trim() === "") {
        errors.push(`Story missing id: ${JSON.stringify(story).slice(0, 50)}`);
      }
      if (!story.title || story.title.trim() === "") {
        errors.push(`Story ${story.id} missing title`);
      }
      if (!story.description || story.description.trim() === "") {
        errors.push(`Story ${story.id} missing description`);
      }
    }
  }

  const passed = errors.length === 0;

  return {
    name: "prd-valid",
    tier: "blocker",
    passed,
    message: passed ? "PRD structure is valid" : errors.join("; "),
  };
}
