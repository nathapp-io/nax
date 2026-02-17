/**
 * Tests for context builder module
 */

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  estimateTokens,
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  createFileContext,
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
    relevantFiles: s.relevantFiles,
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

  describe('defensive checks', () => {
    test('should handle story with null acceptanceCriteria', async () => {
      // Create PRD directly to bypass helper defaults
      const prd: PRD = {
        project: 'test-project',
        feature: 'test-feature',
        branchName: 'test-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          {
            id: 'US-001',
            title: 'Malformed Story',
            description: 'Test',
            acceptanceCriteria: null as any, // Simulate malformed data
            dependencies: [],
            tags: [],
            status: 'pending',
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      };

      const context: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.length).toBeGreaterThan(0);
      const storyElement = built.elements.find((e) => e.type === 'story');
      expect(storyElement?.content).toContain('(No acceptance criteria defined)');
    });

    test('should handle story with undefined acceptanceCriteria', async () => {
      // Create PRD directly to bypass helper defaults
      const prd: PRD = {
        project: 'test-project',
        feature: 'test-feature',
        branchName: 'test-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          {
            id: 'US-001',
            title: 'Malformed Story',
            description: 'Test',
            acceptanceCriteria: undefined as any, // Simulate malformed data
            dependencies: [],
            tags: [],
            status: 'pending',
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      };

      const context: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.length).toBeGreaterThan(0);
      const storyElement = built.elements.find((e) => e.type === 'story');
      expect(storyElement?.content).toContain('(No acceptance criteria defined)');
    });

    test('should log warning for missing dependency story', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with Missing Dependency',
          description: 'Test',
          acceptanceCriteria: ['AC1'],
          dependencies: ['US-999'], // Non-existent dependency
        },
      ]);

      const context: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      // Capture console.warn
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: string) => warnings.push(msg);

      const built = await buildContext(context, budget);

      console.warn = originalWarn;

      expect(warnings.some((w) => w.includes('Dependency story US-999 not found'))).toBe(true);
      expect(built.elements.find((e) => e.type === 'dependency')).toBeUndefined();
    });

    test('should handle story with non-array priorErrors', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with Malformed Errors',
          description: 'Test',
          acceptanceCriteria: ['AC1'],
          priorErrors: 'not an array' as any, // Malformed data
        },
      ]);

      const context: StoryContext = {
        prd,
        currentStoryId: 'US-001',
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.find((e) => e.type === 'error')).toBeUndefined();
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

  describe('createFileContext', () => {
    test('should create file context element', () => {
      const filePath = 'src/utils/helper.ts';
      const content = 'export function helper() { return "test"; }';
      const element = createFileContext(filePath, content, 60);

      expect(element.type).toBe('file');
      expect(element.filePath).toBe(filePath);
      expect(element.content).toBe(content);
      expect(element.priority).toBe(60);
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

    test('should load relevant source files', async () => {
      // Create temp directory and files
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));
      const testFile1 = path.join(tempDir, 'helper.ts');
      const testFile2 = path.join(tempDir, 'utils.ts');

      await fs.writeFile(testFile1, 'export function helper() { return "test"; }');
      await fs.writeFile(testFile2, 'export function utils() { return "util"; }');

      try {
        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story with Files',
            description: 'Test',
            acceptanceCriteria: ['AC1'],
            relevantFiles: ['helper.ts', 'utils.ts'],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === 'file');
        expect(fileElements.length).toBe(2);
        expect(fileElements[0].filePath).toBe('helper.ts');
        expect(fileElements[1].filePath).toBe('utils.ts');
        expect(fileElements[0].content).toContain('helper()');
        expect(fileElements[1].content).toContain('utils()');
        expect(built.summary).toContain('2 files');
      } finally {
        // Cleanup
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('should respect max 5 files limit', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));

      try {
        // Create 10 test files
        const files: string[] = [];
        for (let i = 0; i < 10; i++) {
          const filename = `file${i}.ts`;
          files.push(filename);
          await fs.writeFile(path.join(tempDir, filename), `export const file${i} = ${i};`);
        }

        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story with Many Files',
            description: 'Test',
            acceptanceCriteria: ['AC1'],
            relevantFiles: files,
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === 'file');
        expect(fileElements.length).toBe(5); // Max 5 files
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('should skip files larger than 10KB', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));

      try {
        const smallFile = path.join(tempDir, 'small.ts');
        const largeFile = path.join(tempDir, 'large.ts');

        await fs.writeFile(smallFile, 'export const small = "ok";');
        await fs.writeFile(largeFile, 'x'.repeat(11 * 1024)); // 11KB

        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story with Large File',
            description: 'Test',
            acceptanceCriteria: ['AC1'],
            relevantFiles: ['small.ts', 'large.ts'],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 20000,
          reservedForInstructions: 1000,
          availableForContext: 19000,
        };

        // Capture warnings
        const originalWarn = console.warn;
        const warnings: string[] = [];
        console.warn = (msg: string) => warnings.push(msg);

        const built = await buildContext(storyContext, budget);

        console.warn = originalWarn;

        const fileElements = built.elements.filter((e) => e.type === 'file');
        expect(fileElements.length).toBe(1); // Only small file loaded
        expect(fileElements[0].filePath).toBe('small.ts');
        expect(warnings.some((w) => w.includes('File too large') && w.includes('large.ts'))).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('should warn on missing files', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));

      try {
        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story with Missing File',
            description: 'Test',
            acceptanceCriteria: ['AC1'],
            relevantFiles: ['nonexistent.ts'],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        // Capture warnings
        const originalWarn = console.warn;
        const warnings: string[] = [];
        console.warn = (msg: string) => warnings.push(msg);

        const built = await buildContext(storyContext, budget);

        console.warn = originalWarn;

        const fileElements = built.elements.filter((e) => e.type === 'file');
        expect(fileElements.length).toBe(0);
        expect(warnings.some((w) => w.includes('Relevant file not found') && w.includes('nonexistent.ts'))).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('should handle empty relevantFiles array', async () => {
      const prd = createTestPRD([
        {
          id: 'US-001',
          title: 'Story with Empty Files',
          description: 'Test',
          acceptanceCriteria: ['AC1'],
          relevantFiles: [],
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

      const fileElements = built.elements.filter((e) => e.type === 'file');
      expect(fileElements.length).toBe(0);
    });

    test('should respect token budget when loading files', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));

      try {
        // Create files with substantial content
        await fs.writeFile(path.join(tempDir, 'file1.ts'), 'x'.repeat(5000));
        await fs.writeFile(path.join(tempDir, 'file2.ts'), 'x'.repeat(5000));

        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story',
            description: 'x'.repeat(1000),
            acceptanceCriteria: ['AC1'],
            relevantFiles: ['file1.ts', 'file2.ts'],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 2000,
          reservedForInstructions: 500,
          availableForContext: 1500, // Small budget
        };

        const built = await buildContext(storyContext, budget);

        expect(built.totalTokens).toBeLessThanOrEqual(1500);
        // Files have lower priority (60) than story (80), so story should be included
        expect(built.elements.some((e) => e.type === 'story')).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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

    test('should format context with file elements', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngent-test-'));

      try {
        await fs.writeFile(path.join(tempDir, 'helper.ts'), 'export function helper() {}');

        const prd = createTestPRD([
          {
            id: 'US-001',
            title: 'Story with File',
            description: 'Test',
            acceptanceCriteria: ['AC1'],
            relevantFiles: ['helper.ts'],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: 'US-001',
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);
        const markdown = formatContextAsMarkdown(built);

        expect(markdown).toContain('# Story Context');
        expect(markdown).toContain('## Relevant Source Files');
        expect(markdown).toContain('helper.ts');
        expect(markdown).toContain('helper()');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
