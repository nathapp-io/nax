/**
 * Tests for context builder module
 */

import { describe, test, expect } from 'bun:test';
import {
  estimateTokens,
  createFileContext,
  createConfigContext,
  createErrorContext,
  createCustomContext,
  sortContextElements,
  buildContext,
  formatContextAsMarkdown,
} from '../src/context/builder';
import type {
  ContextElement,
  StoryContext,
  ContextBuilderConfig,
} from '../src/context/types';

describe('Context Builder', () => {
  describe('estimateTokens', () => {
    test('should estimate tokens correctly', () => {
      expect(estimateTokens('test')).toBe(2); // 4 chars = 2 tokens (1 token ≈ 3 chars)
      expect(estimateTokens('hello world')).toBe(4); // 11 chars = 4 tokens
      expect(estimateTokens('')).toBe(0);
    });
  });

  describe('createConfigContext', () => {
    test('should create config context element', () => {
      const config = '{"key": "value"}';
      const element = createConfigContext(config, 50);

      expect(element.type).toBe('config');
      expect(element.content).toBe(config);
      expect(element.priority).toBe(50);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('createErrorContext', () => {
    test('should create error context element', () => {
      const error = 'TypeError: Cannot read property';
      const element = createErrorContext(error, 100);

      expect(element.type).toBe('error');
      expect(element.content).toBe(error);
      expect(element.priority).toBe(100);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('createCustomContext', () => {
    test('should create custom context element', () => {
      const content = 'Custom context information';
      const element = createCustomContext(content, 30);

      expect(element.type).toBe('custom');
      expect(element.content).toBe(content);
      expect(element.priority).toBe(30);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe('sortContextElements', () => {
    test('should sort by priority descending', () => {
      const elements: ContextElement[] = [
        createCustomContext('low', 10),
        createCustomContext('high', 100),
        createCustomContext('medium', 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].priority).toBe(100);
      expect(sorted[1].priority).toBe(50);
      expect(sorted[2].priority).toBe(10);
    });

    test('should sort by tokens ascending for same priority', () => {
      const elements: ContextElement[] = [
        createCustomContext('this is a longer text', 50),
        createCustomContext('short', 50),
        createCustomContext('medium length', 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].tokens).toBeLessThan(sorted[1].tokens);
      expect(sorted[1].tokens).toBeLessThan(sorted[2].tokens);
    });

    test('should not mutate original array', () => {
      const elements: ContextElement[] = [
        createCustomContext('a', 10),
        createCustomContext('b', 20),
      ];

      const original = [...elements];
      sortContextElements(elements);

      expect(elements).toEqual(original);
    });
  });

  describe('buildContext', () => {
    test('should build context within budget', async () => {
      const story: StoryContext = {
        storyId: 'story-1',
        storyTitle: 'Test Story',
        relevantFiles: [],
        dependencies: [],
        customContext: ['Context 1', 'Context 2'],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 1000,
          reservedForInstructions: 200,
          availableForContext: 800,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100, // 100KB
      };

      const built = await buildContext(story, config);

      expect(built.elements.length).toBe(2);
      expect(built.totalTokens).toBeLessThanOrEqual(800);
      expect(built.summary).toContain('Context:');
    });

    test('should prioritize errors when enabled', async () => {
      const story: StoryContext = {
        storyId: 'story-1',
        storyTitle: 'Test Story',
        relevantFiles: [],
        dependencies: [],
        priorErrors: ['Error 1', 'Error 2'],
        customContext: ['Context 1'],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 1000,
          reservedForInstructions: 200,
          availableForContext: 800,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      const errorElements = built.elements.filter((e) => e.type === 'error');
      expect(errorElements.length).toBe(2);
      expect(built.summary).toContain('2 errors');
    });

    test('should truncate when exceeding budget', async () => {
      const longText = 'x'.repeat(1000); // ~334 tokens

      const story: StoryContext = {
        storyId: 'story-1',
        storyTitle: 'Test Story',
        relevantFiles: [],
        dependencies: [],
        customContext: [longText, longText, longText, longText], // ~1336 tokens total
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 500,
          reservedForInstructions: 100,
          availableForContext: 400, // Can only fit ~1-2 elements
        },
        prioritizeErrors: false,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.truncated).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(400);
      expect(built.summary).toContain('[TRUNCATED]');
    });

    test('should handle empty story context', async () => {
      const story: StoryContext = {
        storyId: 'story-1',
        storyTitle: 'Empty Story',
        relevantFiles: [],
        dependencies: [],
      };

      const config: ContextBuilderConfig = {
        budget: {
          maxTokens: 1000,
          reservedForInstructions: 200,
          availableForContext: 800,
        },
        prioritizeErrors: true,
        maxFileSize: 1024 * 100,
      };

      const built = await buildContext(story, config);

      expect(built.elements.length).toBe(0);
      expect(built.totalTokens).toBe(0);
      expect(built.truncated).toBe(false);
    });
  });

  describe('formatContextAsMarkdown', () => {
    test('should format context as markdown', () => {
      const built = {
        elements: [
          createErrorContext('Test error', 100),
          createCustomContext('Custom info', 30),
        ],
        totalTokens: 50,
        truncated: false,
        summary: 'Context: 1 errors, 1 custom (50 tokens)',
      };

      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('# Story Context');
      expect(markdown).toContain('## Prior Errors');
      expect(markdown).toContain('## Additional Context');
      expect(markdown).toContain('Test error');
      expect(markdown).toContain('Custom info');
    });

    test('should include truncation indicator in summary', () => {
      const built = {
        elements: [createCustomContext('Info', 30)],
        totalTokens: 100,
        truncated: true,
        summary: 'Context: 1 custom (100 tokens) [TRUNCATED]',
      };

      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('[TRUNCATED]');
    });

    test('should handle empty context', () => {
      const built = {
        elements: [],
        totalTokens: 0,
        truncated: false,
        summary: 'Context: (0 tokens)',
      };

      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain('# Story Context');
      expect(markdown).toContain('(0 tokens)');
    });
  });
});
