import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { featureDir } from "@/config";
import { botRunDir } from "@/workflow";
import { workflowFeatureDir, workflowRunDir, workflowStoryDir } from "@/workflow/paths";

describe("workflow paths (nax#2479)", () => {
  test("the workflow tree sits inside the repo, under the feature dir", () => {
    expect(workflowFeatureDir("/repo", "auth")).toBe(join(featureDir("/repo", "auth"), "workflow"));
  });

  test("run and story dirs nest under the feature's workflow dir", () => {
    const runDir = workflowRunDir("/repo", "auth", "run-1");
    expect(runDir).toBe(join("/repo", ".nax", "features", "auth", "workflow", "run-1"));
    expect(workflowStoryDir(runDir, "US-001")).toBe(join(runDir, "US-001"));
  });

  test("every path stays under the project root, so agent file tools can reach it", () => {
    const story = workflowStoryDir(workflowRunDir("/repo", "auth", "run-1"), "US-001");
    expect(story.startsWith("/repo/")).toBe(true);
  });
});

describe("botRunDir", () => {
  test("AC-1: keeps durable bot state under outputDir", () => {
    expect(botRunDir("/o", 42, "r1")).toBe("/o/bot/pr-42/r1");
  });
});
