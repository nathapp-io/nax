/**
 * Tests for context builder module
 */

import { describe, test, expect } from 'bun:test';
import {
  estimateTokens,
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  sortContextElements,
  buildContext,
  formatContextAsMarkdown,
} from '../src/context/builder';
import type { ContextElement, StoryContext, ContextBudget } from '../src/context/types';
import type { PRD, UserStory } from '../src/prd';

// Helper to create test PRD
const createTestPRD = (stories: Partial<UserStory>[]): PRD => ({
  project: 'test-project',
  feature: 'test-feature',
  branchName: 'test-branch',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.map((s, i) => ({
    id: s.id || `US-${String(i + 1).padStart(3, '0')}`,
    title: s.title || 'Test Story',
    description: s.description || 'Test description',
    acceptanceCriteria: s.acceptanceCriteria || ['AC1'],
    dependencies: s.dependencies || [],
    tags: s.tags || [],
    status: s.status || 'pending',
    passes: s.passes ?? false,
    escalations: s.escalations || [],
    attempts: s.attempts || 0,
    routing: s.routing,
    priorErrors: s.priorErrors,
  })),
});

describe('Context Builder', () => {
  describe('estimateTokens', () => {
    test('should estimate tokens correctly', () => {
      expect(estimateTokens('test')).toBe(2); // 4 chars = 2 tokens (1 token ≈ 3 chars)
      expect(estimateTokens('hello world')).toBe(4); // 11 chars = 4 tokens
      expect(estimateTokens('')).toBe(0);
    });
  });

  describe('createStoryContext', () => {
    test('should create story context element', () => {
      const story: UserStory = {
        id: 'US-001',
        title: 'Test Story',
        description: 'Test description',
        acceptanceCriteria: ['AC1', 'AC2'],
        dependencies: [],
        tags: ['feature'],
        status: 'pending',
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const element = createStoryContext(story, 80);

      expect(element.type).toBe('story');
      expect(element.storyId).toBe('US-001');
      expect(element.priority).toBe(80);
      expect(element.content).toContain('US-001: Test Story');
      expect(element.content).toContain('Test description');
      expect(element.content).toContain('AC1');
      expect(element.content).toContain('AC2');
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('createDependencyContext', () => {
    test('should create dependency context element', () => {
      const story: UserStory = {
        id: 'US-002',
        title: 'Dependency Story',
        description: 'Dependency description',
        acceptanceCriteria: ['AC1'],
        dependencies: [],
        tags: [],
        status: 'passed',
        passes: true,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.type).toBe('dependency');
      expect(element.storyId).toBe('US-002');
      expect(element.priority).toBe(50);
      expect(element.content).toContain('US-002: Dependency Story');
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('createErrorContext', () => {
    test('should create error context element', () => {
      const error = 'TypeError: Cannot read property';
      const element = createErrorContext(error, 90);

      expect(element.type).toBe('error');
      expect(element.content).toBe(error);
      expect(element.priority).toBe(90);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('createProgressContext', () => {
    test('should create progress context element', () => {
      const progress = 'Progress: 5/12 stories complete (4 passed, 1 failed)';
      const element = createProgressContext(progress, 100);

      expect(element.type).toBe('progress');
      expect(element.content).toBe(progress);
      expect(element.priority).toBe(100);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('sortContextElements', () => {
    test('should sort by priority descending', () => {
      const elements: ContextElement[] = [
        createErrorContext('error', 10),
        createProgressContext('progress', 100),
        createErrorContext('error2', 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].priority).toBe(100);
      expect(sorted[1].priority).toBe(50);
      expect(sorted[2].priority).toBe(10);
    });

    test('should sort by tokens ascending for same priority', () => {
      const elements: ContextElement[] = [
        createErrorContext('this is a much longer error message with lots of text', 50),
        createErrorContext('short', 50),
        createErrorContext('medium length message', 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].tokens).toBeLessThan(sorted[1].tokens);
      expect(sorted[1].tokens).toBeLessThan(sorted[2].tokens);
    });

    test('should not mutate original array', () => {
      const elements: ContextElement[] = [
        createErrorContext('a', 10),
        createErrorContext('b', 20),
      ];

      const original = [...elements];
      sortContextElements(elements);

      expect(elements).toEqual(original);
    });
  });

  describe('buildContext', () => {
    test('should extract current story from PRD', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'First Story',
          description: 'First description',
          acceptanceCriteria: ['AC1'],
        },
        {
          id: 'US-002',
          title: 'Second Story',
          description: 'Second description',
          acceptanceCriteria: ['AC2'],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);

      // Should have progress + current story
      expect(built.elements.length).toBe(2);
      expect(built.elements.some((e) => e.type === 'progress')).toBe(true);
      expect(built.elements.some((e) => e.type === 'story' && e.storyId === 'US-001')).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(9000);
    });

    test('should include dependency stories', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Dependency Story',
          description: 'Dependency description',
          acceptanceCriteria: ['AC1'],
          status: 'passed',
          passes: true,
        },
        {
          id: 'US-002',
          title: 'Current Story',
          description: 'Current description',
          acceptanceCriteria: ['AC2'],
          dependencies: ['US-001'],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-002',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);

      // Should have progress + current story + dependency
      expect(built.elements.length).toBe(3);
      expect(built.elements.some((e) => e.type === 'progress')).toBe(true);
      expect(built.elements.some((e) => e.type === 'story' && e.storyId === 'US-002')).toBe(true);
      expect(built.elements.some((e) => e.type === 'dependency' && e.storyId === 'US-001')).toBe(
        true,
      );
    });

    test('should include prior errors', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Failed Story',
          description: 'Story with errors',
          acceptanceCriteria: ['AC1'],
          priorErrors: ['Error 1', 'Error 2'],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);

      const errorElements = built.elements.filter((e) => e.type === 'error');
      expect(errorElements.length).toBe(2);
      expect(built.summary).toContain('2 errors');
    });

    test('should generate progress summary', async () => {
      const prd = createTestPRD([
        { id: 'US-001', status: 'passed', passes: true },
        { id: 'US-002', status: 'passed', passes: true },
        { id: 'US-003', status: 'failed', passes: false },
        { id: 'US-004', status: 'pending', passes: false },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-004',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);

      const progressElement = built.elements.find((e) => e.type === 'progress');
      expect(progressElement).toBeDefined();
      expect(progressElement!.content).toContain('3/4 stories complete');
      expect(progressElement!.content).toContain('2 passed');
      expect(progressElement!.content).toContain('1 failed');
    });

    test('should truncate when exceeding budget', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with many dependencies',
          description: 'x'.repeat(1000),
          acceptanceCriteria: ['AC1'],
          dependencies: ['US-002', 'US-003', 'US-004', 'US-005'],
        },
        { id: 'US-002', description: 'x'.repeat(1000), acceptanceCriteria: ['AC2'] },
        { id: 'US-003', description: 'x'.repeat(1000), acceptanceCriteria: ['AC3'] },
        { id: 'US-004', description: 'x'.repeat(1000), acceptanceCriteria: ['AC4'] },
        { id: 'US-005', description: 'x'.repeat(1000), acceptanceCriteria: ['AC5'] },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 1000,
        reservedForInstructions: 500,
        availableForContext: 500, // Small budget
      };

      const built = await buildContext(storyContext, budget);

      expect(built.truncated).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(500);
      expect(built.summary).toContain('[TRUNCATED]');
      // Progress should always be included (highest priority)
      expect(built.elements.some((e) => e.type === 'progress')).toBe(true);
    });

    test('should throw error for non-existent story', async () => {
      const prd = createTestPRD([{ id: 'US-001', title: 'Story' }]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-999', // Non-existent
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      await expect(buildContext(storyContext, budget)).rejects.toThrow(
        'Story US-999 not found in PRD',
      );
    });
  });

  describe('formatContextAsMarkdown', () => {
    test('should format context with all element types', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Dependency',
          description: 'Dep description',
          acceptanceCriteria: ['AC1'],
          status: 'passed',
          passes: true,
        },
        {
          id: 'US-002',
          title: 'Current',
          description: 'Current description',
          acceptanceCriteria: ['AC2'],
          dependencies: ['US-001'],
          priorErrors: ['Test error'],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-002',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('# Story Context');
      expect(markdown).toContain('## Progress');
      expect(markdown).toContain('## Prior Errors');
      expect(markdown).toContain('## Current Story');
      expect(markdown).toContain('## Dependency Stories');
      expect(markdown).toContain('US-001');
      expect(markdown).toContain('US-002');
      expect(markdown).toContain('Test error');
    });

    test('should include summary with token count', async () => {
      const prd = createTestPRD([{ id: 'US-001', title: 'Story' }]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('Context:');
      expect(markdown).toContain('tokens');
      expect(markdown).toContain(built.totalTokens.toString());
    });

    test('should show truncation indicator', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          description: 'x'.repeat(2000),
          dependencies: ['US-002', 'US-003'],
        },
        { id: 'US-002', description: 'x'.repeat(2000) },
        { id: 'US-003', description: 'x'.repeat(2000) },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 500,
        reservedForInstructions: 250,
        availableForContext: 250,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('[TRUNCATED]');
    });
  });
});
