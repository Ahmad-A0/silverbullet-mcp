/**
 * Utilities for safe string replacement operations.
 *
 * JavaScript's String.replace() interprets special $ sequences in replacement text:
 * - $& = matched substring
 * - $' = portion AFTER match (causes exponential growth!)
 * - $` = portion BEFORE match
 * - $1-$9 = capture groups
 * - $$ = literal $
 *
 * These utilities ensure replacement text is treated literally.
 */

/**
 * Escapes $ characters in replacement text to prevent special sequence interpretation.
 *
 * In JavaScript's String.replace(), $ has special meaning. To output a literal $,
 * you must use $$. This function escapes all $ as $$ so the replacement text
 * is treated literally.
 *
 * @param text - The replacement text to escape
 * @returns The escaped text safe for use with String.replace()
 *
 * @example
 * // Without escaping: "foo".replace(/foo/, "$& bar") => "foo bar"
 * // With escaping: "foo".replace(/foo/, escapeReplacementText("$& bar")) => "$& bar"
 */
export function escapeReplacementText(text: string): string {
  return text.replace(/\$/g, '$$$$');
}

/**
 * Performs a safe search and replace that treats replacement text literally.
 *
 * This is a wrapper around String.replace() that automatically escapes
 * special $ sequences in the replacement text.
 *
 * @param content - The content to search in
 * @param searchPattern - The pattern to search for (string or RegExp)
 * @param replaceText - The literal replacement text
 * @param options - Optional settings
 * @returns The content with replacements made
 */
export function safeReplace(
  content: string,
  searchPattern: string | RegExp,
  replaceText: string,
  options: {
    caseSensitive?: boolean;
    replaceAll?: boolean;
    useRegex?: boolean;
  } = {}
): string {
  const { caseSensitive = false, replaceAll = true, useRegex = false } = options;

  let regex: RegExp;

  if (searchPattern instanceof RegExp) {
    regex = searchPattern;
  } else if (useRegex) {
    const flags = (replaceAll ? 'g' : '') + (caseSensitive ? '' : 'i');
    regex = new RegExp(searchPattern, flags);
  } else {
    // Escape regex special characters for literal matching
    const escapedPattern = searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = (replaceAll ? 'g' : '') + (caseSensitive ? '' : 'i');
    regex = new RegExp(escapedPattern, flags);
  }

  // Escape $ in replacement text to prevent special sequence interpretation
  const safeReplaceText = escapeReplacementText(replaceText);

  return content.replace(regex, safeReplaceText);
}
