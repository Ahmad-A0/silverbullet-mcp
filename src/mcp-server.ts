// MCP server configuration and tools

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ListResourcesRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { listNotesAPI, readNoteAPI, readNoteSnapshotAPI, writeNoteAPI, deleteNoteAPI, SilverBulletAPIError } from './silverbullet-api.js';
import { getCachedNoteContent } from './cache.js';
import type { SearchResult, SearchMatch, NoteInfo } from './types.js';
import {
    NoteErrorHandler,
    NoteResolver,
    ContentManager,
    type MultiNoteRequest
} from './note-utils.js';
import { URL } from 'node:url';
import { registerEditNote } from './edit-note.js';
import { outputSchemas } from './tool-schemas.js';
import { toolResult } from './tool-results.js';

export function configureMcpServerInstance(server: McpServer): void {
    registerEditNote(server);
    // Resource: read a single note or list all notes
    server.registerResource(
        'note',
        new ResourceTemplate('sb-note://{filename}', {
            // Listing is handled below with MCP cursor pagination.
            list: undefined,
        }),
        {
            title: 'Note',
            description: 'Read a single note or list all notes',
        },
        async (params: URL, { uri }: any) => {
            const noteName = decodeURIComponent(params.hostname as string);
            try {         
                const text = await readNoteAPI(noteName);
                const result = {
                    contents: [
                        {
                            uri: params.href,
                            text,
                            mimeType: 'text/markdown',
                        },
                    ],
                };
                return result;
            } catch (error) {
                console.error(`[MCP Resource: note] Error reading note ${noteName}:`, error);
                throw error;
            }
        }
    );

    // Tool: read multiple notes with flexible input options
    server.registerTool(
        'read-multiple-notes',
        {
            title: 'Read Multiple Notes',
            description: 'Read multiple notes with flexible input options',
            annotations: {
                readOnlyHint: true,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.multiple,
            inputSchema: {
                filenames: z
                    .array(z.string().min(1)).min(1).max(100)
                    .optional()
                    .describe('Array of specific note filenames to read (e.g., ["note1.md", "note2.md"])'),
                namePattern: z
                    .string()
                    .optional()
                    .describe('Regex pattern to match note names (e.g., "project.*" for notes starting with "project")'),
                includeContent: z
                    .boolean()
                    .default(true)
                    .describe('Whether to include full note content in response'),
                includeMetadata: z
                    .boolean()
                    .default(true)
                    .describe('Whether to include file metadata (size, permissions, etc.)'),
                maxResults: z
                    .number().int().min(1).max(100)
                    .default(50)
                    .describe('Maximum number of notes to return (prevents overload)'),
                enableCaching: z
                    .boolean()
                    .default(true)
                    .describe('Whether to use content caching for better performance'),
                contentLimit: z.number().int().min(1).max(100_000).default(50_000).describe('Maximum characters per returned note'),
                format: z
                    .enum(['structured', 'concatenated', 'summary'])
                    .default('structured')
                    .describe('Output format: structured (detailed), concatenated (combined content), or summary (previews only)'),
            },
        },
        async ({ filenames, namePattern, includeContent, includeMetadata, maxResults, enableCaching, format, contentLimit }) => {
            try {
                // Validate input
                if (!filenames && !namePattern) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Either filenames array or namePattern must be provided',
                            },
                        ],
                        isError: true,
                    };
                }

                // Build request
                const request: MultiNoteRequest = {
                    filenames,
                    namePattern,
                    includeContent,
                    includeMetadata,
                    maxResults,
                    enableCaching,
                    format,
                    contentLimit,
                };

                // Get available notes for validation and metadata
                const availableNotes = await listNotesAPI();

                // Resolve note filenames
                const resolvedFilenames = await NoteResolver.resolveNotes(request);

                if (resolvedFilenames.length === 0) {
                    let message = 'No notes found';
                    if (namePattern) {
                        message += ` matching pattern "${namePattern}"`;
                    }
                    if (filenames && filenames.length > 0) {
                        message += ` from the specified list`;
                        
                        // Suggest similar notes for the first filename
                        const suggestions = await NoteErrorHandler.findSimilarNoteNames(
                            filenames[0],
                            availableNotes
                        );
                        if (suggestions.length > 0) {
                            message += `\n\nDid you mean one of these?\n${suggestions.map(s => `  • ${s}`).join('\n')}`;
                        }
                    }

                    return {
                        structuredContent: { summary: { totalNotes: 0, successCount: 0, errorCount: 0, permissions: { rw: 0, ro: 0 } }, notes: [] },
                        content: [
                            {
                                type: 'text',
                                text: message,
                            },
                        ],
                    };
                }

                // Read notes in batch
                const response = await ContentManager.batchReadNotes(
                    resolvedFilenames,
                    request,
                    availableNotes
                );

                // Format response
                const formattedOutput = ContentManager.formatResponse(response, format);

                return {
                    structuredContent: { ...response },
                    content: [
                        {
                            type: 'text',
                            text: formattedOutput,
                        },
                    ],
                };

            } catch (error) {
                console.error(`[MCP Tool: read-multiple-notes] Error:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to read multiple notes: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: search and replace in a note
    server.registerTool(
        'search-replace-note',
        {
            title: 'Search and Replace In Note',
            description: 'Legacy search/replace with case-insensitive, replace-all defaults. Invalid regex is an error. Prefer edit-note for exact matching, previews, and revision-checked writes.',
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.replace,
            inputSchema: {
                filename: z.string().min(1).describe('The filename of the note to modify'),
                searchPattern: z.string().min(1).describe('The text or regex pattern to search for'),
                replaceText: z.string().describe('The text to replace matches with'),
                useRegex: z.boolean().default(false).describe('Whether to treat searchPattern as a regex'),
                caseSensitive: z.boolean().default(false).describe('Whether search should be case-sensitive'),
                replaceAll: z.boolean().default(true).describe('Whether to replace all matches or just the first one'),
            },
        },
        async ({ filename, searchPattern, replaceText, useRegex, caseSensitive, replaceAll }) => {
            try {
                // Read the current content
                const content = await readNoteAPI(filename);
                
                const flags = (replaceAll ? 'g' : '') + (caseSensitive ? '' : 'i');
                const pattern = useRegex ? searchPattern : searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const searchRegex = new RegExp(pattern, flags);

                // Count matches before replacement
                const matches = content.match(searchRegex);
                const matchCount = matches ? (replaceAll ? matches.length : 1) : 0;

                if (matchCount === 0) {
                    return {
                        structuredContent: { filename, replacements: 0, changed: false },
                        content: [
                            {
                                type: 'text',
                                text: `No matches found for "${searchPattern}" in ${filename}`,
                            },
                        ],
                    };
                }

                // Perform replacement
                const newContent = content.replace(searchRegex, () => replaceText);
                
                // Write back the modified content
                if (newContent !== content) await writeNoteAPI(filename, newContent);

                let resultMessage = `Successfully replaced ${matchCount} occurrence${matchCount === 1 ? '' : 's'} of "${searchPattern}" in ${filename}`;
                
                return {
                    structuredContent: { filename, replacements: matchCount, changed: newContent !== content },
                    content: [
                        {
                            type: 'text',
                            text: resultMessage,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: search-replace-note] Error modifying note ${filename}:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to modify note: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: list all notes with optional filtering
    server.registerTool(
        'list-notes',
        {
            title: 'List Notes',
            description: 'List notes with optional filtering and cursor pagination (100 per page by default)',
            annotations: {
                readOnlyHint: true,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.list,
            inputSchema: {
                limit: z.number().int().min(1).max(500).default(100),
                cursor: z.string().optional().describe('nextCursor from the previous page; keep filters unchanged'),
                namePattern: z
                    .string()
                    .optional()
                    .describe('Optional javascript regex pattern to filter note names (e.g., "project.*" for notes starting with "project")'),
                permission: z
                    .enum(['rw', 'ro'])
                    .optional()
                    .describe('Filter by permission: "rw" for read-write, "ro" for read-only'),
            },
        },
        async ({ namePattern, permission, limit, cursor }) => {
            try {
                let notes = await listNotesAPI();
                // Apply name pattern filter
                if (namePattern) {
                    const regex = new RegExp(namePattern, 'i');
                    notes = notes.filter((note) => regex.test(note.name));
                }

                // Apply permission filter
                if (permission) {
                    notes = notes.filter((note) => note.perm === permission);
                }
                
                notes.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
                const total = notes.length;
                let after = '';
                if (cursor !== undefined) {
                    after = Buffer.from(cursor, 'base64url').toString('utf8');
                    if (!after || Buffer.from(after).toString('base64url') !== cursor) throw new Error('Invalid note cursor');
                }
                const remaining = notes.filter(note => note.name > after);
                notes = remaining.slice(0, limit);
                const nextCursor = remaining.length > notes.length ? Buffer.from(notes[notes.length - 1].name).toString('base64url') : null;
                const notesList = notes
                    .map((note) => `- ${note.name} (${note.perm === 'rw' ? 'read-write' : 'read-only'})`)
                    .join('\n');

                const filterSummary = [];
                if (namePattern) filterSummary.push(`name pattern: "${namePattern}"`);
                if (permission) filterSummary.push(`permission: ${permission}`);
                
                const headerText =
                    filterSummary.length > 0
                        ? `Notes matching filters (${filterSummary.join(', ')}):`
                        : 'Available notes:';

                return {
                    structuredContent: { notes, total, nextCursor },
                    content: [
                        {
                            type: 'text',
                            text: `${headerText}\n${
                                notesList || 'No notes found matching the specified criteria.'
                            }${nextCursor ? `\nNext cursor: ${nextCursor}` : ''}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: list-notes] Error:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to list notes: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: full-text search across notes with concise output and paging
    server.registerTool(
        'search-notes',
        {
            title: 'Search Notes',
            description: 'Full-text search across notes with concise output and paging',
            annotations: {
                readOnlyHint: true,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.search,
            inputSchema: {
                maxMatchesPerNote: z.number().int().min(1).max(100).default(20),
                useRegex: z.boolean().default(true).describe('Keep true for legacy regex queries; false treats query literally'),
                query: z.string().min(1).describe('Search query (supports javascript regex patterns)'),
                searchType: z
                    .enum(['content', 'title', 'both'])
                    .default('both')
                    .describe('Where to search: content, title (filename), or both'),
                caseSensitive: z.boolean().default(false).describe('Whether search should be case-sensitive'),
                maxResults: z.number().int().min(1).max(100).default(10).describe('Maximum number of results to return per page'),
                page: z.number().int().min(1).max(1_000_000).default(1).describe('Page number for pagination (1-based)'),
                contextLines: z
                    .number().int().min(0).max(20)
                    .default(1)
                    .describe('Number of lines of context to show around each match (reduced default for conciseness)'),
                concise: z.boolean().default(true).describe('Return concise output optimized for LLM consumption'),
                enableCaching: z
                    .boolean()
                    .default(true)
                    .describe('Enable content caching with modification time validation'),
            },
        },
        async ({
            query,
            useRegex,
            maxMatchesPerNote,
            searchType,
            caseSensitive,
            maxResults,
            page,
            contextLines,
            concise,
            enableCaching,
        }) => {
            try {
                const notes = await listNotesAPI();
                const searchResults = [];
                const flags = caseSensitive ? 'g' : 'gi';
                const searchRegex = new RegExp(useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
                const errors: { filename: string; message: string }[] = [];

                for (const note of notes) {
                    const noteResults: SearchResult = {
                        filename: note.name,
                        permission: note.perm,
                        matches: [],
                        score: 0,
                    };

                    // Search in title/filename
                    if (searchType === 'title' || searchType === 'both') {
                        const titleMatches = Array.from(note.name.matchAll(searchRegex));
                        if (titleMatches.length > 0) {
                            noteResults.matches.push({
                                type: 'title',
                                line: 0,
                                content: note.name,
                                matchCount: titleMatches.length,
                            });
                        }
                    }

                    // Search in content
                    if (searchType === 'content' || searchType === 'both') {
                        try {
                            const content = await getCachedNoteContent(note.name, enableCaching);
                            const lines = content.split('\n');

                            lines.forEach((line, lineIndex) => {
                                const lineMatches = Array.from(line.matchAll(searchRegex));
                                if (lineMatches.length > 0) {
                                    // Get context lines only if not in concise mode or if contextLines > 0
                                    let contextText = '';
                                    if (!concise && contextLines > 0) {
                                        const startLine = Math.max(0, lineIndex - contextLines);
                                        const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
                                        contextText = lines.slice(startLine, endLine + 1).join('\n');
                                    }

                                    noteResults.matches.push({
                                        type: 'content',
                                        line: lineIndex + 1,
                                        content: line.trim(), // Trim whitespace for conciseness
                                        context: contextText,
                                        matchCount: lineMatches.length,
                                        startLine:
                                            contextLines > 0
                                                ? Math.max(0, lineIndex - contextLines) + 1
                                                : undefined,
                                        endLine:
                                            contextLines > 0
                                                ? Math.min(lines.length - 1, lineIndex + contextLines) + 1
                                                : undefined,
                                    });
                                }
                            });
                        } catch (error) {
                            console.error(`[MCP Tool: search-notes] Failed to read note ${note.name}:`, error);
                            errors.push({ filename: note.name, message: error instanceof Error ? error.message : String(error) });
                            // Continue with other notes
                        }
                    }

                    if (noteResults.matches.length > 0) {
                        // Calculate total score for ranking
                        const totalMatches = noteResults.matches.reduce(
                            (sum, match) => sum + match.matchCount,
                            0
                        );
                        noteResults.score = totalMatches;
                        searchResults.push(noteResults);
                    }
                }

                // Sort by relevance (score)
                searchResults.sort((a, b) => b.score - a.score);

                // Calculate pagination
                const totalResults = searchResults.length;
                const totalPages = Math.ceil(totalResults / maxResults);
                const startIndex = (page - 1) * maxResults;
                const endIndex = Math.min(startIndex + maxResults, totalResults);
                const paginatedResults = searchResults.slice(startIndex, endIndex).map(result => ({
                    ...result, matchesTruncated: result.matches.length > maxMatchesPerNote,
                    matches: result.matches.slice(0, maxMatchesPerNote).map(match => ({ ...match,
                        content: match.content.slice(0, 2000), context: match.context?.slice(0, 4000) })),
                }));
                const totalMatches = searchResults.reduce((sum, result) => sum + result.score, 0);
                const structuredContent = { query, results: paginatedResults, totalResults, totalMatches,
                    page, totalPages, nextPage: page < totalPages ? page + 1 : null, errors };

                // Format results
                if (totalResults === 0) {
                    return {
                        structuredContent,
                        content: [
                            {
                                type: 'text',
                                text: `No matches found for "${query}" in ${
                                    searchType === 'both' ? 'titles or content' : searchType
                                }.${errors.length ? ` Warning: ${errors.length} note(s) could not be read; results are incomplete.` : ''}`,
                            },
                        ],
                    };
                }

                let output = '';
                const fallbackMessage = errors.length ? `Warning: ${errors.length} note(s) could not be read; results are incomplete.\n` : '';

                // Header with pagination info
                if (concise) {
                    output = `${fallbackMessage}SEARCH: "${query}" | Results: ${totalResults} notes, ${totalMatches} matches | Page ${page}/${totalPages}\n\n`;
                } else {
                    output = `${fallbackMessage}Found ${totalMatches} matches in ${totalResults} notes (showing page ${page} of ${totalPages}):\n\n`;
                }

                // Results
                paginatedResults.forEach((result, index) => {
                    const resultNum = startIndex + index + 1;
                    const totalNoteMatches = result.score;

                    if (concise) {
                        output += `${resultNum}. ${result.filename} (${totalNoteMatches}x)\n`;

                        // Show only first few matches in concise mode
                        const maxMatchesToShow = 3;
                        const matchesToShow = result.matches.slice(0, maxMatchesToShow);

                        matchesToShow.forEach((match) => {
                            if (match.type === 'title') {
                                output += `  • Title match\n`;
                            } else {
                                // Truncate long lines for conciseness
                                const truncatedContent =
                                    match.content.length > 100
                                        ? match.content.substring(0, 97) + '...'
                                        : match.content;
                                output += `  • L${match.line}: ${truncatedContent}\n`;
                            }
                        });

                        if (result.matches.length > maxMatchesToShow) {
                            output += `  • ... ${result.matches.length - maxMatchesToShow} more matches\n`;
                        }
                    } else {
                        output += `📄 **${result.filename}** (${totalNoteMatches} matches, ${result.permission})\n`;

                        result.matches.forEach((match) => {
                            if (match.type === 'title') {
                                output += `  📝 Title: "${match.content}"\n`;
                            } else {
                                output += `  Line ${match.line}: "${match.content}"\n`;
                                if (contextLines > 0 && match.context) {
                                    const contextWithHighlight = match.context
                                        .split('\n')
                                        .map((line: string, idx: number) => {
                                            const actualLineNum = (match.startLine || 0) + idx;
                                            const prefix = actualLineNum === match.line ? '→' : ' ';
                                            return `    ${prefix} ${actualLineNum}: ${line}`;
                                        })
                                        .join('\n');
                                    output += `${contextWithHighlight}\n`;
                                }
                            }
                        });
                    }
                    if (result.matchesTruncated) output += '  [Additional matching lines omitted]\n';
                    output += '\n';
                });

                // Pagination footer
                if (totalPages > 1) {
                    if (concise) {
                        output += `---\nPage ${page}/${totalPages}`;
                        if (page < totalPages) output += ` | Next: page=${page + 1}`;
                        if (page > 1) output += ` | Prev: page=${page - 1}`;
                    } else {
                        output += `Page ${page} of ${totalPages}`;
                        if (page < totalPages) output += ` | Use page=${page + 1} for next results`;
                        if (page > 1) output += ` | Use page=${page - 1} for previous results`;
                    }
                }

                return {
                    structuredContent,
                    content: [
                        {
                            type: 'text',
                            text: output,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: search-notes] Error:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to search notes: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: read a note
    server.registerTool(
        'read-note',
        {
            title: 'Read Note',
            description: 'Read note content with a revision token. Returns up to 50,000 characters by default; use nextOffset to continue.',
            annotations: {
                readOnlyHint: true,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.read,
            inputSchema: {
                offset: z.number().int().min(0).default(0).describe('Character offset (UTF-16 code units)'),
                limit: z.number().int().min(1).max(100_000).default(50_000).describe('Maximum characters to return'),
                filename: z.string().min(1).describe('The filename of the note to read'),
                suggestSimilar: z.boolean().default(true).describe('Whether to suggest similar note names if the note is not found'),
            },
        },
        async ({ filename, suggestSimilar, offset, limit }) => {
            try {
                const note = await readNoteSnapshotAPI(filename);
                const content = note.content.slice(offset, offset + limit);
                const nextOffset = offset + content.length < note.content.length ? offset + content.length : null;
                return toolResult({ filename, content, revision: note.revision, offset,
                    totalCharacters: note.content.length, nextOffset },
                    content + (nextOffset !== null ? `\n[Truncated; continue with offset=${nextOffset}]` : ''));
            } catch (error) {
                console.error(`[MCP Tool: read-note] Error reading note ${filename}:`, error);
                
                // If enabled, try to suggest similar note names for "not found" errors
                if (suggestSimilar && NoteErrorHandler.isNotFoundError(error)) {
                    try {
                        const availableNotes = await listNotesAPI();
                        const suggestions = await NoteErrorHandler.findSimilarNoteNames(filename, availableNotes);
                        
                        if (suggestions.length > 0) {
                            const suggestionText = suggestions.map(note => `  • ${note}`).join('\n');
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: `Note "${filename}" not found. Did you mean one of these?\n\n${suggestionText}`,
                                    },
                                ],
                                isError: true,
                            };
                        }
                    } catch (searchError) {
                        console.error(`[MCP Tool: read-note] Error during similarity search:`, searchError);
                        // Fall through to original error handling
                    }
                }
                
                // Original error handling for non-404 errors or when suggestions are disabled/failed
                return {
                    content: [
                        {
                            type: 'text',
                            text: NoteErrorHandler.formatError(error, 'Failed to read note'),
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: create a new note
    server.registerTool(
        'create-note',
        {
            title: 'Create Note',
            description: 'Create a new note',
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.create,
            inputSchema: {
                filename: z.string().min(1).describe('The filename for the new note (should end with .md)'),
                content: z.string().describe('The content for the new note'),
                overwrite: z.boolean().default(false).describe('Whether to overwrite existing note if it exists'),
            },
        },
        async ({ filename, content, overwrite }) => {
            try {
                if (!filename.endsWith('.md')) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Filename must end with .md extension',
                            },
                        ],
                        isError: true,
                    };
                }

                // Check if note exists if overwrite is false
                if (!overwrite) {
                    try {
                        await readNoteAPI(filename);
                        // If we get here, the note exists
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `Note ${filename} already exists. Use overwrite=true to replace it.`,
                                },
                            ],
                            isError: true,
                        };
                    } catch (error) {
                        if (!(error instanceof SilverBulletAPIError) || error.status !== 404) throw error;
                    }
                }

                const revision = await writeNoteAPI(filename, content, { createOnly: !overwrite });
                
                const action = overwrite ? 'created/updated' : 'created';
                return {
                    structuredContent: { filename, overwrite, revision },
                    content: [
                        {
                            type: 'text',
                            text: `Successfully ${action} note: ${filename}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: create-note] Error creating note ${filename}:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to create note: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: delete a note
    server.registerTool(
        'delete-note',
        {
            title: 'Delete Note',
            description: 'Delete a note',
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            outputSchema: outputSchemas.delete,
            inputSchema: {
                filename: z.string().min(1).describe('The filename of the note to delete (should end with .md)'),
            },
        },
        async ({ filename }) => {
            try {
                if (!filename.endsWith('.md')) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Filename must end with .md extension',
                            },
                        ],
                        isError: true,
                    };
                }
                await deleteNoteAPI(filename);
                return {
                    structuredContent: { filename, deleted: true },
                    content: [
                        {
                            type: 'text',
                            text: `Successfully deleted note: ${filename}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: delete-note] Error deleting note ${filename}:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to delete note: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
    server.server.setRequestHandler(ListResourcesRequestSchema, async request => {
        const cursor = request.params?.cursor;
        let after = '';
        if (cursor !== undefined) {
            after = Buffer.from(cursor, 'base64url').toString('utf8');
            if (!after || Buffer.from(after).toString('base64url') !== cursor) {
                throw new McpError(ErrorCode.InvalidParams, 'Invalid resource cursor');
            }
        }
        const notes = (await listNotesAPI()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const remaining = notes.filter(note => note.name > after);
        const page = remaining.slice(0, 100);
        return {
            resources: page.map(note => ({ uri: `sb-note://${encodeURIComponent(note.name)}`, name: note.name })),
            ...(remaining.length > page.length ? { nextCursor: Buffer.from(page[page.length - 1].name).toString('base64url') } : {}),
        };
    });

}