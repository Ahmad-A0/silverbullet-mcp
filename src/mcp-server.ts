// MCP server configuration and tools

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listNotesAPI, readNoteAPI, writeNoteAPI } from './silverbullet-api.js';
import { getCachedNoteContent } from './cache.js';
import type { SearchResult, SearchMatch } from './types.js';

export function configureMcpServerInstance(server: McpServer): void {
    // Resource: list all notes
    server.resource('notes', 'sb-notes://all', async () => {
        try {
            const notesData = await listNotesAPI();
            const result = {
                contents: [
                    {
                        uri: 'sb-notes://all',
                        text: JSON.stringify(
                            notesData.map((n) => ({
                                name: n.name,
                                uri: `sb-note://${encodeURIComponent(n.name)}`,
                                permissions: n.perm,
                            })),
                            null,
                            2
                        ),
                    },
                ],
            };
            return result;
        } catch (error) {
            console.error(`[MCP Resource: notes] Error:`, error);
            throw error;
        }
    });

    // Resource: read a single note
    server.resource(
        'note',
        new ResourceTemplate('sb-note://{filename}', { list: undefined }),
        async (uri, { filename }) => {
            try {
                const fname = decodeURIComponent(filename as string);
                const text = await readNoteAPI(fname);
                const result = {
                    contents: [
                        {
                            uri: uri.href,
                            text,
                            mimeType: 'text/markdown',
                        },
                    ],
                };
                return result;
            } catch (error) {
                console.error(`[MCP Resource: note] Error reading note ${filename}:`, error);
                throw error;
            }
        }
    );

    // Tool: update a note
    server.tool(
        'update-note',
        {
            filename: z.string().describe('The filename of the note to update'),
            content: z.string().describe('The new content for the note'),
        },
        async ({ filename, content }) => {
            try {
                await writeNoteAPI(filename, content);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully updated note: ${filename}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: update-note] Error updating note ${filename}:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to update note: ${
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
    server.tool(
        'list-notes',
        {
            namePattern: z
                .string()
                .optional()
                .describe('Optional regex pattern to filter note names (e.g., "project.*" for notes starting with "project")'),
            permission: z
                .enum(['rw', 'ro'])
                .optional()
                .describe('Filter by permission: "rw" for read-write, "ro" for read-only'),
            contentSearch: z
                .string()
                .optional()
                .describe('Optional text to search for within note contents (case-insensitive)'),
        },
        async ({ namePattern, permission, contentSearch }) => {
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

                // Apply content search filter
                if (contentSearch) {
                    const contentFilteredNotes = [];
                    for (const note of notes) {
                        try {
                            const content = await getCachedNoteContent(note.name, true);
                            if (content.toLowerCase().includes(contentSearch.toLowerCase())) {
                                contentFilteredNotes.push(note);
                            }
                        } catch (error) {
                            console.error(`[MCP Tool: list-notes] Failed to read note ${note.name}:`, error);
                            // Continue with other notes even if one fails
                        }
                    }
                    notes = contentFilteredNotes;
                }

                const notesList = notes
                    .map((note) => `- ${note.name} (${note.perm === 'rw' ? 'read-write' : 'read-only'})`)
                    .join('\n');

                const filterSummary = [];
                if (namePattern) filterSummary.push(`name pattern: "${namePattern}"`);
                if (permission) filterSummary.push(`permission: ${permission}`);
                if (contentSearch) filterSummary.push(`content search: "${contentSearch}"`);

                const headerText =
                    filterSummary.length > 0
                        ? `Notes matching filters (${filterSummary.join(', ')}):`
                        : 'Available notes:';

                return {
                    content: [
                        {
                            type: 'text',
                            text: `${headerText}\n${
                                notesList || 'No notes found matching the specified criteria.'
                            }`,
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
    server.tool(
        'search-notes',
        {
            query: z.string().describe('Search query (supports javascript regex patterns)'),
            searchType: z
                .enum(['content', 'title', 'both'])
                .default('both')
                .describe('Where to search: content, title (filename), or both'),
            caseSensitive: z.boolean().default(false).describe('Whether search should be case-sensitive'),
            maxResults: z.number().default(10).describe('Maximum number of results to return per page'),
            page: z.number().default(1).describe('Page number for pagination (1-based)'),
            contextLines: z
                .number()
                .default(1)
                .describe('Number of lines of context to show around each match (reduced default for conciseness)'),
            concise: z.boolean().default(true).describe('Return concise output optimized for LLM consumption'),
            enableCaching: z
                .boolean()
                .default(true)
                .describe('Enable content caching with modification time validation'),
        },
        async ({
            query,
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
                let searchRegex;

                try {
                    searchRegex = new RegExp(query, flags);
                } catch (error) {
                    // If regex is invalid, escape special characters and treat as literal
                    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    searchRegex = new RegExp(escapedQuery, flags);
                }

                for (const note of notes) {
                    const noteResults: SearchResult = {
                        filename: note.name,
                        permission: note.perm,
                        matches: [],
                        score: 0,
                    };

                    // Search in title/filename
                    if (searchType === 'title' || searchType === 'both') {
                        const titleMatches = [...note.name.matchAll(searchRegex)];
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
                                const lineMatches = [...line.matchAll(searchRegex)];
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
                const paginatedResults = searchResults.slice(startIndex, endIndex);

                // Format results
                if (totalResults === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No matches found for "${query}" in ${
                                    searchType === 'both' ? 'titles or content' : searchType
                                }.`,
                            },
                        ],
                    };
                }

                const totalMatches = searchResults.reduce((sum, result) => sum + result.score, 0);

                let output = '';

                // Header with pagination info
                if (concise) {
                    output = `SEARCH: "${query}" | Results: ${totalResults} notes, ${totalMatches} matches | Page ${page}/${totalPages}\n\n`;
                } else {
                    output = `Found ${totalMatches} matches in ${totalResults} notes (showing page ${page} of ${totalPages}):\n\n`;
                }

                // Results
                paginatedResults.forEach((result, index) => {
                    const resultNum = startIndex + index + 1;
                    const totalNoteMatches = result.matches.reduce((sum, match) => sum + match.matchCount, 0);

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
    server.tool(
        'read-note',
        {
            filename: z.string().describe('The filename of the note to read'),
        },
        async ({ filename }) => {
            try {
                const content = await readNoteAPI(filename);
                return {
                    content: [
                        {
                            type: 'text',
                            text: content,
                        },
                    ],
                };
            } catch (error) {
                console.error(`[MCP Tool: read-note] Error reading note ${filename}:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Failed to read note: ${
                                error instanceof Error ? error.message : 'Unknown error'
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Tool: create a new note
    server.tool(
        'create-note',
        {
            filename: z.string().describe('The filename for the new note (should end with .md)'),
            content: z.string().describe('The content for the new note'),
        },
        async ({ filename, content }) => {
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
                await writeNoteAPI(filename, content);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully created note: ${filename}`,
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
}