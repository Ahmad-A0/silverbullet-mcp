import { describe, it, expect } from 'vitest';

describe('Test Infrastructure', () => {
  it('should run tests successfully', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have access to test helpers', async () => {
    const { mockNotes, mockNoteList } = await import('./helpers.js');
    expect(mockNotes.simple).toContain('Hello World');
    expect(mockNoteList()).toHaveLength(3);
  });
});
