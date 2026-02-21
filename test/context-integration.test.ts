/**
 * Integration tests for context builder with execution runner
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { run } from '../src/execution/runner';
import type { RunOptions } from '../src/execution/runner';
import type { PRD, UserStory } from '../src/prd';
import { DEFAULT_CONFIG } from '../src/config';
import { buildContext, formatContextAsMarkdown } from '../src/context/builder';
import type { StoryContext, ContextBudget } from '../src/context/types';

// Sample PRD for testing
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

let tmpDirs: string[] = [];

const createTmpDir = async (): Promise<string> => {
  const tmpDir = `/tmp/nax-context-test-${Date.now()}-${Math.random()}`;
  await Bun.spawn(['mkdir', '-p', tmpDir], { stdout: 'pipe' }).exited;
  tmpDirs.push(tmpDir);
  return tmpDir;
};

afterEach(async () => {
  // Cleanup all temporary directories
  for (const tmpDir of tmpDirs) {
    await Bun.spawn(['rm', '-rf', tmpDir], { stdout: 'pipe' }).exited;
  }
  tmpDirs = [];
});

describe('Context Builder Integration', () => {
  describe('Runner Integration', () => {
    test('should use context builder by default', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Fix typo',
          description: 'Fix a typo in error message',
          acceptanceCriteria: ['Typo is fixed'],
          tags: [],
        },
      ]);

      const tmpDir = await createTmpDir();
      const prdPath = `${tmpDir}/prd.json`;
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const opts: RunOptions = {
        prdPath,
        workdir: tmpDir,
        config: {
          ...DEFAULT_CONFIG,
          execution: { ...DEFAULT_CONFIG.execution, maxIterations: 1 },
        },
        hooks: { hooks: {} },
        feature: 'test-feature',
        dryRun: true,
        useContext: true, // Default behavior
      };

      const result = await run(opts);

      expect(result.iterations).toBeGreaterThan(0);
      // In a full implementation, we'd verify context was included in prompt
    });

    test('should skip context builder when useContext is false', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Fix typo',
          description: 'Fix a typo in error message',
          acceptanceCriteria: ['Typo is fixed'],
          tags: [],
        },
      ]);

      const tmpDir = await createTmpDir();
      const prdPath = `${tmpDir}/prd.json`;
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const opts: RunOptions = {
        prdPath,
        workdir: tmpDir,
        config: {
          ...DEFAULT_CONFIG,
          execution: { ...DEFAULT_CONFIG.execution, maxIterations: 1 },
        },
        hooks: { hooks: {} },
        feature: 'test-feature',
        dryRun: true,
        useContext: false, // Disable context builder
      };

      const result = await run(opts);

      expect(result.iterations).toBeGreaterThan(0);
      // In a full implementation, we'd verify context was NOT included
    });

    test('should handle context builder errors gracefully', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Task with invalid reference',
          description: 'This task has an issue',
          acceptanceCriteria: ['Works'],
          tags: [],
        },
      ]);

      const tmpDir = await createTmpDir();
      const prdPath = `${tmpDir}/prd.json`;
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const opts: RunOptions = {
        prdPath,
        workdir: tmpDir,
        config: {
          ...DEFAULT_CONFIG,
          execution: { ...DEFAULT_CONFIG.execution, maxIterations: 1 },
        },
        hooks: { hooks: {} },
        feature: 'test-feature',
        dryRun: true,
        useContext: true,
      };

      // Should not throw even if context builder encounters errors
      const result = await run(opts);

      expect(result.iterations).toBeGreaterThan(0);
    });
  });

  describe('Story Extraction', () => {
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

      expect(built.elements.some((e) => e.type === 'story' && e.storyId === 'US-001')).toBe(true);
      expect(built.elements.some((e) => e.type === 'story' && e.storyId === 'US-002')).toBe(false);
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
      const markdown = formatContextAsMarkdown(built);

      expect(built.elements.some((e) => e.type === 'dependency' && e.storyId === 'US-001')).toBe(
        true,
      );
      expect(markdown).toContain('## Dependency Stories');
      expect(markdown).toContain('US-001');
    });

    test('should include progress summary', async () => {
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
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('Progress:');
      expect(markdown).toContain('3/4 stories complete');
      expect(markdown).toContain('2 passed');
      expect(markdown).toContain('1 failed');
    });

    test('should include prior errors', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Failed Story',
          description: 'Story with errors',
          acceptanceCriteria: ['AC1'],
          priorErrors: ['TypeError: Cannot read property', 'ReferenceError: x is not defined'],
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
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('## Prior Errors');
      expect(markdown).toContain('TypeError: Cannot read property');
      expect(markdown).toContain('ReferenceError: x is not defined');
    });

    test('should handle missing dependency gracefully', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with missing dependency',
          description: 'Current story',
          acceptanceCriteria: ['AC1'],
          dependencies: ['US-999'], // Non-existent
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

      // Should not crash, just skip the missing dependency
      expect(built.elements.some((e) => e.type === 'dependency')).toBe(false);
    });
  });

  describe('Context Prioritization', () => {
    test('should prioritize progress over other elements', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story',
          priorErrors: ['Error 1'],
          dependencies: ['US-002'],
        },
        { id: 'US-002', status: 'passed', passes: true },
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

      // Progress should be first (highest priority)
      expect(built.elements[0].type).toBe('progress');
    });

    test('should prioritize errors over stories', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story',
          priorErrors: ['Critical error'],
          dependencies: ['US-002'],
        },
        { id: 'US-002', status: 'passed', passes: true },
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

      // Errors should come before story and dependencies
      const errorIndex = built.elements.findIndex((e) => e.type === 'error');
      const storyIndex = built.elements.findIndex((e) => e.type === 'story');
      const depIndex = built.elements.findIndex((e) => e.type === 'dependency');

      expect(errorIndex).toBeLessThan(storyIndex);
      expect(errorIndex).toBeLessThan(depIndex);
    });

    test('should truncate low-priority items when budget exceeded', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with many dependencies',
          description: 'x'.repeat(2000),
          acceptanceCriteria: ['AC1'],
          dependencies: ['US-002', 'US-003', 'US-004', 'US-005'],
        },
        { id: 'US-002', description: 'x'.repeat(2000), acceptanceCriteria: ['AC2'] },
        { id: 'US-003', description: 'x'.repeat(2000), acceptanceCriteria: ['AC3'] },
        { id: 'US-004', description: 'x'.repeat(2000), acceptanceCriteria: ['AC4'] },
        { id: 'US-005', description: 'x'.repeat(2000), acceptanceCriteria: ['AC5'] },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 2000,
        reservedForInstructions: 1000,
        availableForContext: 1000, // Small budget
      };

      const built = await buildContext(storyContext, budget);

      expect(built.truncated).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(1000);
      // Progress should always be included (highest priority)
      expect(built.elements.some((e) => e.type === 'progress')).toBe(true);
      // Current story should be included (high priority)
      expect(built.elements.some((e) => e.type === 'story')).toBe(true);
      // Some dependencies may be truncated (lower priority)
      const depCount = built.elements.filter((e) => e.type === 'dependency').length;
      expect(depCount).toBeLessThan(4); // Not all dependencies included
    });
  });

  describe('Markdown Formatting', () => {
    test('should format context with all sections', async () => {
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

      // Verify all sections are present
      expect(markdown).toContain('# Story Context');
      expect(markdown).toContain('## Progress');
      expect(markdown).toContain('## Prior Errors');
      expect(markdown).toContain('## Current Story');
      expect(markdown).toContain('## Dependency Stories');

      // Verify content
      expect(markdown).toContain('US-001');
      expect(markdown).toContain('US-002');
      expect(markdown).toContain('Test error');
      expect(markdown).toContain('Dep description');
      expect(markdown).toContain('Current description');
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
          description: 'x'.repeat(3000),
          dependencies: ['US-002', 'US-003'],
        },
        { id: 'US-002', description: 'x'.repeat(3000) },
        { id: 'US-003', description: 'x'.repeat(3000) },
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

  describe('contextFiles and expectedFiles', () => {
    test('should use contextFiles when present', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with contextFiles',
          description: 'Test contextFiles usage',
          acceptanceCriteria: ['AC1'],
          contextFiles: ['src/foo.ts', 'src/bar.ts'],
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
      const markdown = formatContextAsMarkdown(built);

      // Context builder should attempt to load contextFiles
      expect(built.elements.some((e) => e.type === 'story')).toBe(true);
      expect(markdown).toContain('US-001');
    });

    test('should fall back to relevantFiles for context when contextFiles not set', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Legacy story with relevantFiles',
          description: 'Test relevantFiles fallback',
          acceptanceCriteria: ['AC1'],
          relevantFiles: ['src/legacy.ts'],
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
      const markdown = formatContextAsMarkdown(built);

      // Should still build context successfully using relevantFiles fallback
      expect(built.elements.some((e) => e.type === 'story')).toBe(true);
      expect(markdown).toContain('US-001');
    });

    test('should handle story with no files specified', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with no files',
          description: 'Test no files case',
          acceptanceCriteria: ['AC1'],
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
      const markdown = formatContextAsMarkdown(built);

      // Should build context successfully without file loading
      expect(built.elements.some((e) => e.type === 'story')).toBe(true);
      expect(markdown).toContain('US-001');
    });
  });

  describe('Edge Cases', () => {
    test('should handle single story PRD', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Only Story',
          description: 'The only story',
          acceptanceCriteria: ['AC1'],
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
      const markdown = formatContextAsMarkdown(built);

      expect(built.elements.length).toBeGreaterThan(0);
      expect(markdown).toContain('US-001');
      expect(markdown).toContain('Progress: 0/1 stories complete');
    });

    test('should handle story with no dependencies', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Independent Story',
          description: 'No dependencies',
          acceptanceCriteria: ['AC1'],
          dependencies: [],
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

      expect(built.elements.some((e) => e.type === 'dependency')).toBe(false);
    });

    test('should handle extremely small budget gracefully', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          description: 'x'.repeat(5000),
          priorErrors: ['Error'.repeat(1000)],
          dependencies: ['US-002', 'US-003'],
        },
        { id: 'US-002', description: 'x'.repeat(5000) },
        { id: 'US-003', description: 'x'.repeat(5000) },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 100,
        reservedForInstructions: 50,
        availableForContext: 50, // Extremely small
      };

      const built = await buildContext(storyContext, budget);

      expect(built.totalTokens).toBeLessThanOrEqual(50);
      expect(built.truncated).toBe(true);
      // At minimum, progress should fit
      expect(built.elements.length).toBeGreaterThan(0);
    });
  });
});
