import type { PRD, UserStory } from "../../src/prd/types";

export function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "A test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

export function makePendingStory(overrides: Partial<UserStory> = {}): UserStory {
  return makeStory({ status: "pending", ...overrides });
}

export function makeInProgressStory(overrides: Partial<UserStory> = {}): UserStory {
  return makeStory({ status: "in-progress", ...overrides });
}

export function makePRD(overrides: Partial<PRD> = {}): PRD {
  const stories = overrides.userStories ?? [makeStory()];
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "main",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    userStories: stories,
    ...overrides,
  };
}
