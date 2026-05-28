/**
 * Test helpers and mock factories for SilverBullet MCP tests
 */

import { vi } from 'vitest';

// Mock note content for testing
export const mockNotes = {
  simple: '# Hello World\n\nThis is a simple note.',
  withFrontmatter: `---
title: Test Note
tags: [test, example]
---

# Content

This is the body.`,
  multiline: `Line 1: Hello world
Line 2: This is a test
Line 3: More content here
Line 4: Final line`,
  withDollarSigns: `Price: $100
Variable: $variable
Template: ${'{placeholder}'}`,
  withLinks: `# Links Test

Check out [[Other Note]] and [[Another Page]].

Also see [external](https://example.com).`,
};

// Mock API responses
export const mockNoteInfo = (name: string, perm: 'rw' | 'ro' = 'rw') => ({
  name,
  perm,
});

export const mockNoteList = () => [
  mockNoteInfo('test.md'),
  mockNoteInfo('example.md'),
  mockNoteInfo('readonly.md', 'ro'),
];

// Captured write content for verification
export let capturedWriteContent: string | null = null;
export let capturedWriteFilename: string | null = null;

export const resetCaptures = () => {
  capturedWriteContent = null;
  capturedWriteFilename = null;
};

// Mock the silverbullet-api module
export const createApiMocks = (noteContent: string = mockNotes.simple) => {
  const mocks = {
    listNotesAPI: vi.fn().mockResolvedValue(mockNoteList()),
    readNoteAPI: vi.fn().mockResolvedValue(noteContent),
    writeNoteAPI: vi.fn().mockImplementation((filename: string, content: string) => {
      capturedWriteFilename = filename;
      capturedWriteContent = content;
      return Promise.resolve();
    }),
    deleteNoteAPI: vi.fn().mockResolvedValue(undefined),
  };
  return mocks;
};

// Helper to verify content wasn't corrupted
export const verifyNoCorruption = (
  original: string,
  modified: string,
  expectedPattern: RegExp
) => {
  // Check file didn't grow unexpectedly (sign of $' bug)
  const growthRatio = modified.length / original.length;
  if (growthRatio > 2) {
    throw new Error(
      `Suspicious file growth detected: ${original.length} -> ${modified.length} (${growthRatio.toFixed(1)}x)`
    );
  }
  
  // Check for expected modification
  if (!expectedPattern.test(modified)) {
    throw new Error(`Modified content doesn't match expected pattern`);
  }
  
  return true;
};

// Helper to check for dollar sign handling
export const containsLiteralDollarSign = (content: string, expectedSequence: string) => {
  return content.includes(expectedSequence);
};
