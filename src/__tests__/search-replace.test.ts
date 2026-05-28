/**
 * Tests for search-replace-note tool
 * 
 * Focus: $ escaping bug that causes file corruption
 * 
 * Bug: JavaScript's String.replace() interprets $ sequences:
 * - $& → matched text
 * - $' → everything AFTER match (causes exponential growth)
 * - $` → everything BEFORE match
 * - $1-$9 → capture groups
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockNotes, resetCaptures, capturedWriteContent } from './helpers.js';
import { escapeReplacementText, safeReplace } from '../replacement-utils.js';

// We need to mock the silverbullet-api module before importing mcp-server
vi.mock('../silverbullet-api.js', () => ({
  listNotesAPI: vi.fn(),
  readNoteAPI: vi.fn(),
  writeNoteAPI: vi.fn(),
  deleteNoteAPI: vi.fn(),
}));

// Import the mocked module to set up return values
import * as api from '../silverbullet-api.js';

// Import the function we're testing
// Note: We can't easily test the MCP tool directly, so we'll test the core logic
// For now, we'll extract and test the replacement logic

/**
 * Simulates the current (buggy) search-replace behavior
 */
function buggySearchReplace(content: string, searchPattern: string, replaceText: string): string {
  const escapedPattern = searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const searchRegex = new RegExp(escapedPattern, 'gi');
  return content.replace(searchRegex, replaceText);
}

/**
 * Uses the actual safeReplace utility from replacement-utils.ts
 */
function fixedSearchReplace(content: string, searchPattern: string, replaceText: string): string {
  return safeReplace(content, searchPattern, replaceText, { caseSensitive: false, replaceAll: true });
}

describe('search-replace-note: $ escaping bug', () => {
  beforeEach(() => {
    resetCaptures();
    vi.clearAllMocks();
  });

  describe('Demonstrating the bug with buggySearchReplace', () => {
    it('$& causes matched text duplication', () => {
      const content = 'hello world';
      const result = buggySearchReplace(content, 'hello', 'hello $&');
      
      // BUG: $& gets interpreted as the matched text "hello"
      // So "hello $&" becomes "hello hello"
      expect(result).toBe('hello hello world'); // This is the buggy behavior
      expect(result).not.toBe('hello $& world'); // This is what we actually want
    });

    it('$\' causes exponential file growth (the critical bug)', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const result = buggySearchReplace(content, 'Line 1', 'Line 1 $\'');
      
      // BUG: $' inserts everything AFTER the match
      // So "Line 1 $'" becomes "Line 1 \nLine 2\nLine 3"
      // This causes the file to nearly double in size!
      expect(result.length).toBeGreaterThan(content.length * 1.5);
      expect(result).toContain('Line 2\nLine 3\nLine 2'); // Duplicated content
    });

    it('$` causes content before match to be inserted', () => {
      const content = 'prefix hello suffix';
      const result = buggySearchReplace(content, 'hello', 'hello $`');
      
      // BUG: $` inserts everything BEFORE the match
      expect(result).toContain('prefix '); // Prefix gets duplicated
      expect(result).not.toBe('prefix hello $` suffix');
    });

    it('$1 without capture group becomes literal (but inconsistent with $& behavior)', () => {
      const content = 'hello world';
      const result = buggySearchReplace(content, 'hello', 'hello $1');
      
      // Note: $1 without a capture group happens to be literal in JS
      // But $&, $', $` are still interpreted, making behavior inconsistent
      // Our fix makes ALL $ sequences literal for consistency
      expect(result).toBe('hello $1 world');
    });
  });

  describe('Fixed behavior with fixedSearchReplace', () => {
    it('should treat $& as literal text', () => {
      const content = 'hello world';
      const result = fixedSearchReplace(content, 'hello', 'hello $&');
      
      // FIXED: $& should be literal
      expect(result).toBe('hello $& world');
    });

    it('should treat $\' as literal text (no exponential growth)', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const result = fixedSearchReplace(content, 'Line 1', 'Line 1 $\'');
      
      // FIXED: $' should be literal, no content duplication
      expect(result).toBe('Line 1 $\'\nLine 2\nLine 3');
      expect(result.length).toBeLessThan(content.length * 1.5); // No exponential growth
    });

    it('should treat $` as literal text', () => {
      const content = 'prefix hello suffix';
      const result = fixedSearchReplace(content, 'hello', 'hello $`');
      
      // FIXED: $` should be literal
      expect(result).toBe('prefix hello $` suffix');
    });

    it('should treat $1 as literal text', () => {
      const content = 'hello world';
      const result = fixedSearchReplace(content, 'hello', 'hello $1');
      
      // FIXED: $1 should be literal
      expect(result).toBe('hello $1 world');
    });

    it('should handle $$ as literal $$', () => {
      const content = 'price is X';
      const result = fixedSearchReplace(content, 'X', '$$100');
      
      // In literal mode, $$ should stay as $$ (user wrote $$, they get $$)
      // This is different from regex mode where $$ means single $
      expect(result).toBe('price is $$100');
    });

    it('should handle multiple $ sequences', () => {
      const content = 'hello world';
      const result = fixedSearchReplace(content, 'hello', '$& $\' $` $1');
      
      // All should be literal
      expect(result).toBe('$& $\' $` $1 world');
    });

    it('should handle real-world code with $ variables', () => {
      const content = 'console.log(message);';
      const result = fixedSearchReplace(content, 'message', '$message');
      
      // Common in code - $ prefixed variables
      expect(result).toBe('console.log($message);');
    });

    it('should handle price strings', () => {
      const content = 'The item costs PRICE';
      const result = fixedSearchReplace(content, 'PRICE', '$19.99');
      
      expect(result).toBe('The item costs $19.99');
    });

    it('should handle template literals syntax', () => {
      const content = 'Use TEMPLATE here';
      const result = fixedSearchReplace(content, 'TEMPLATE', '${variable}');
      
      expect(result).toBe('Use ${variable} here');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty replacement text', () => {
      const content = 'hello world';
      const result = fixedSearchReplace(content, 'hello ', '');
      
      expect(result).toBe('world');
    });

    it('should handle replacement text that is just $', () => {
      const content = 'price X';
      const result = fixedSearchReplace(content, 'X', '$');
      
      expect(result).toBe('price $');
    });

    it('should handle consecutive $ characters', () => {
      const content = 'test X test';
      const result = fixedSearchReplace(content, 'X', '$$$');
      
      // $$$ with escaping should produce literal $$$
      // Input $$$ -> escaped to $$$$$$ -> output $$$
      expect(result).toBe('test $$$ test');
    });

    it('should allow user to get single $ by writing $', () => {
      const content = 'price is X';
      const result = fixedSearchReplace(content, 'X', '$100');
      
      // User writes $100, they get $100
      expect(result).toBe('price is $100');
    });

    it('should handle unicode content with $', () => {
      const content = '价格 X 元';
      const result = fixedSearchReplace(content, 'X', '$100');
      
      expect(result).toBe('价格 $100 元');
    });

    it('should handle very long replacement with multiple $', () => {
      const content = 'Replace X here';
      const replacement = '$var1 + $var2 + $var3 = $total';
      const result = fixedSearchReplace(content, 'X', replacement);
      
      expect(result).toBe('Replace $var1 + $var2 + $var3 = $total here');
    });
  });
});

describe('safeReplace advanced options', () => {
  describe('RegExp input', () => {
    it('should accept RegExp directly and still escape $ in replacement', () => {
      const content = 'hello world';
      const result = safeReplace(content, /hello/, '$& test');
      expect(result).toBe('$& test world');
    });

    it('should work with RegExp containing capture groups', () => {
      const content = 'hello world';
      const result = safeReplace(content, /(hello)/, '$1 test');
      expect(result).toBe('$1 test world');
    });
  });

  describe('useRegex option', () => {
    it('should treat pattern as regex when useRegex is true', () => {
      const content = 'cat bat rat';
      const result = safeReplace(content, '[cbr]at', 'dog', { useRegex: true });
      expect(result).toBe('dog dog dog');
    });

    it('should escape $ in replacement even with useRegex', () => {
      const content = 'cat bat';
      const result = safeReplace(content, 'cat', '$& dog', { useRegex: true });
      expect(result).toBe('$& dog bat');
    });

    it('should respect caseSensitive with useRegex', () => {
      const content = 'Cat CAT cat';
      const result = safeReplace(content, 'cat', 'dog', { useRegex: true, caseSensitive: true });
      expect(result).toBe('Cat CAT dog');
    });

    it('should respect replaceAll: false with useRegex', () => {
      const content = 'cat cat cat';
      const result = safeReplace(content, 'cat', 'dog', { useRegex: true, replaceAll: false });
      expect(result).toBe('dog cat cat');
    });
  });

  describe('caseSensitive option', () => {
    it('should be case-insensitive by default', () => {
      const content = 'Hello HELLO hello';
      const result = safeReplace(content, 'hello', 'hi');
      expect(result).toBe('hi hi hi');
    });

    it('should respect case when caseSensitive is true', () => {
      const content = 'Hello HELLO hello';
      const result = safeReplace(content, 'hello', 'hi', { caseSensitive: true });
      expect(result).toBe('Hello HELLO hi');
    });
  });

  describe('replaceAll option', () => {
    it('should replace all by default', () => {
      const content = 'a a a';
      const result = safeReplace(content, 'a', 'b');
      expect(result).toBe('b b b');
    });

    it('should replace only first when replaceAll is false', () => {
      const content = 'a a a';
      const result = safeReplace(content, 'a', 'b', { replaceAll: false });
      expect(result).toBe('b a a');
    });
  });
});

describe('escapeReplacementText utility', () => {
  // Tests for the actual utility function from replacement-utils.ts

  it('should escape single $', () => {
    expect(escapeReplacementText('$')).toBe('$$');
  });

  it('should escape multiple $', () => {
    expect(escapeReplacementText('$a $b $c')).toBe('$$a $$b $$c');
  });

  it('should leave non-$ text unchanged', () => {
    expect(escapeReplacementText('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(escapeReplacementText('')).toBe('');
  });

  it('should handle $$ (already escaped)', () => {
    // Input $$ should become $$$$ to preserve the literal $$
    expect(escapeReplacementText('$$')).toBe('$$$$');
  });
});
