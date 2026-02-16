/**
 * Integration tests for context builder with execution runner
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { run } from '../src/execution/runner';
import type { RunOptions } from '../src/execution/runner';
import type { PRD, UserStory } from '../src/prd';
import { DEFAULT_CONFIG } from '../src/config';
import { buildContext, formatContextAsMarkdown } from '../src/context/builder';
import type { StoryContext, ContextBuilderConfig } from '../src/context/types';

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
  })),
});

let tmpDirs: string[] = [];

const createTmpDir = async (): Promise<string> => {
  const tmpDir = `/tmp/ngent-context-test-${Date.now()}-${Math.random()}`;
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
          title: 'Task with invalid file reference',
          description: 'This task references a non-existent file',
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

  describe('Context Building with Real Files', () => {
    test('should include file content in context', async () => {
      const tmpDir = await createTmpDir();

      // Create a test file
      const testFilePath = `${tmpDir}/test.ts`;
      const testFileContent = 'export function hello() { return "world"; }';
      await Bun.write(testFilePath, testFileContent);

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: [testFilePath],
        dependencies: [],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.elements.length).toBe(1);
      expect(built.elements[0].type).toBe('file');
      expect(built.elements[0].content).toBe(testFileContent);
      expect(built.elements[0].path).toBe(testFilePath);
    });

    test('should respect file size limits', async () => {
      const tmpDir = await createTmpDir();

      // Create a large file
      const largeFilePath = `${tmpDir}/large.ts`;
      const largeContent = 'x'.repeat(200000); // 200KB
      await Bun.write(largeFilePath, largeContent);

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: [largeFilePath],
        dependencies: [],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 100000, // 100KB max
      };

      const built = await buildContext(story, config);

      expect(built.elements.length).toBe(1);
      expect(built.elements[0].content).toContain('[File too large');
    });

    test('should handle non-existent files gracefully', async () => {
      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: ['/non/existent/file.ts'],
        dependencies: [],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      // Non-existent files should be skipped
      expect(built.elements.length).toBe(0);
    });
  });

  describe('Context Prioritization', () => {
    test('should prioritize errors over files', async () => {
      const tmpDir = await createTmpDir();

      const testFilePath = `${tmpDir}/test.ts`;
      await Bun.write(testFilePath, 'export const x = 1;');

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: [testFilePath],
        dependencies: [],
        priorErrors: ['TypeError: Cannot read property', 'ReferenceError: x is not defined'],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      // Errors should come first
      expect(built.elements[0].type).toBe('error');
      expect(built.elements[1].type).toBe('error');
      expect(built.elements[2].type).toBe('file');
    });

    test('should truncate low-priority items when budget exceeded', async () => {
      const tmpDir = await createTmpDir();

      // Create multiple files with substantial content
      const files = [];
      for (let i = 0; i < 10; i++) {
        const filePath = `${tmpDir}/file${i}.ts`;
        const content = `export const data${i} = '${'x'.repeat(1000)}';`;
        await Bun.write(filePath, content);
        files.push(filePath);
      }

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: files,
        dependencies: [],
        priorErrors: ['Critical error'], // High priority
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 2000,
          reservedForInstructions: 500,
          availableForContext: 1500, // Small budget
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.truncated).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(1500);
      // Error should be included
      expect(built.elements.some((e) => e.type === 'error')).toBe(true);
      // Not all files should be included
      expect(built.elements.length).toBeLessThan(11); // 1 error + 10 files
    });
  });

  describe('Markdown Formatting', () => {
    test('should format context with multiple element types', async () => {
      const tmpDir = await createTmpDir();

      const testFilePath = `${tmpDir}/test.ts`;
      const testFileContent = 'export const test = true;';
      await Bun.write(testFilePath, testFileContent);

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Complex Story',
        relevantFiles: [testFilePath],
        dependencies: [],
        priorErrors: ['Error: Test failed'],
        customContext: ['Additional context information'],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);
      const markdown = formatContextAsMarkdown(built);

      // Verify markdown structure
      expect(markdown).toContain('# Story Context');
      expect(markdown).toContain('## Prior Errors');
      expect(markdown).toContain('## Relevant Files');
      expect(markdown).toContain('## Additional Context');
      expect(markdown).toContain('Error: Test failed');
      expect(markdown).toContain(testFileContent);
      expect(markdown).toContain('Additional context information');
    });

    test('should include summary with token count', async () => {
      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: [],
        dependencies: [],
        customContext: ['Test context'],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: false,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('Context:');
      expect(markdown).toContain('tokens');
      expect(markdown).toContain(built.totalTokens.toString());
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty story gracefully', async () => {
      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Empty Story',
        relevantFiles: [],
        dependencies: [],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);
      const markdown = formatContextAsMarkdown(built);

      expect(built.elements.length).toBe(0);
      expect(built.totalTokens).toBe(0);
      expect(built.truncated).toBe(false);
      expect(markdown).toContain('# Story Context');
    });

    test('should handle extremely small budget', async () => {
      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Test Story',
        relevantFiles: [],
        dependencies: [],
        customContext: [
          'This is a longer context that will exceed the budget',
          'Another longer context that definitely exceeds budget',
          'Yet another context to ensure truncation',
        ],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 100,
          reservedForInstructions: 90,
          availableForContext: 10, // Extremely small
        },
        prioritizeErrors: false,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.totalTokens).toBeLessThanOrEqual(10);
      expect(built.truncated).toBe(true);
    });

    test('should handle multiple errors with truncation', async () => {
      const errors = Array.from({ length: 20 }, (_, i) => `Error ${i}: ${'x'.repeat(100)}`);

      const story: StoryContext = {
        storyId: 'US-001',
        storyTitle: 'Error-Heavy Story',
        relevantFiles: [],
        dependencies: [],
        priorErrors: errors,
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 5000,
          reservedForInstructions: 1000,
          availableForContext: 4000,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.elements.every((e) => e.type === 'error')).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(4000);
      expect(built.summary).toContain('errors');
    });
  });
});
