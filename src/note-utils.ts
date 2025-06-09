// Shared utilities for note operations and error handling

import { listNotesAPI, readNoteAPI } from './silverbullet-api.js';
import { getCachedNoteContent } from './cache.js';
import type { NoteInfo } from './types.js';

// Types for multi-note operations
export interface MultiNoteRequest {
    filenames?: string[];
    namePattern?: string;
    includeContent?: boolean;
    includeMetadata?: boolean;
    maxResults?: number;
    enableCaching?: boolean;
    format?: 'structured' | 'concatenated' | 'summary';
}

export interface NoteResult {
    filename: string;
    permission: 'ro' | 'rw';
    size?: number;
    lastModified?: number;
    content?: string;
    contentPreview?: string;
    error?: string;
}

export interface MultiNoteResponse {
    summary: {
        totalNotes: number;
        successCount: number;
        errorCount: number;
        permissions: { rw: number; ro: number };
    };
    notes: NoteResult[];
    errors?: string[];
}

// Utility function to calculate Levenshtein distance
function levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) {
        matrix[0][i] = i;
    }
    
    for (let j = 0; j <= str2.length; j++) {
        matrix[j][0] = j;
    }
    
    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1, // deletion
                matrix[j - 1][i] + 1, // insertion
                matrix[j - 1][i - 1] + indicator // substitution
            );
        }
    }
    
    return matrix[str2.length][str1.length];
}

// Error Handler Class
export class NoteErrorHandler {
    static isNotFoundError(error: unknown): boolean {
        if (error instanceof Error) {
            const message = error.message.toLowerCase();
            return message.includes('404') || message.includes('not found');
        }
        return false;
    }

    static async findSimilarNoteNames(
        targetName: string, 
        availableNotes: NoteInfo[], 
        maxResults: number = 5
    ): Promise<string[]> {
        const normalizeForComparison = (name: string): string => {
            return name.replace(/\.md$/i, '').toLowerCase().replace(/[-_]/g, ' ');
        };
        
        const normalizedTarget = normalizeForComparison(targetName);
        
        const similarities = availableNotes.map(note => {
            const normalizedNote = normalizeForComparison(note.name);
            const distance = levenshteinDistance(normalizedTarget, normalizedNote);
            const maxLength = Math.max(normalizedTarget.length, normalizedNote.length);
            const similarity = maxLength > 0 ? (maxLength - distance) / maxLength : 0;
            
            // Boost score for substring matches
            if (normalizedNote.includes(normalizedTarget) || normalizedTarget.includes(normalizedNote)) {
                return { note: note.name, similarity: similarity + 0.3 };
            }
            
            return { note: note.name, similarity };
        });
        
        return similarities
            .filter(item => item.similarity >= 0.4)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, maxResults)
            .map(item => item.note);
    }

    static formatError(error: unknown, context: string): string {
        if (error instanceof Error) {
            return `${context}: ${error.message}`;
        }
        return `${context}: Unknown error`;
    }
}

// Note Resolver Class
export class NoteResolver {
    static async resolveNotes(request: MultiNoteRequest): Promise<string[]> {
        const allNotes = await listNotesAPI();
        const resolvedFilenames = new Set<string>();

        // Add specific filenames
        if (request.filenames) {
            for (const filename of request.filenames) {
                // Normalize filename (add .md if missing)
                const normalizedName = filename.endsWith('.md') ? filename : `${filename}.md`;
                resolvedFilenames.add(normalizedName);
            }
        }

        // Add pattern-matched filenames
        if (request.namePattern) {
            try {
                const regex = new RegExp(request.namePattern, 'i');
                const matchedNotes = allNotes.filter(note => regex.test(note.name));
                for (const note of matchedNotes) {
                    resolvedFilenames.add(note.name);
                }
            } catch (error) {
                console.warn(`[NoteResolver] Invalid regex pattern: ${request.namePattern}`, error);
                // Treat as literal string search if regex fails
                const matchedNotes = allNotes.filter(note => 
                    note.name.toLowerCase().includes(request.namePattern!.toLowerCase())
                );
                for (const note of matchedNotes) {
                    resolvedFilenames.add(note.name);
                }
            }
        }

        // Apply max results limit
        const resultArray = Array.from(resolvedFilenames);
        return request.maxResults ? resultArray.slice(0, request.maxResults) : resultArray;
    }

    static validateFilenames(filenames: string[]): { valid: string[]; invalid: string[] } {
        const valid: string[] = [];
        const invalid: string[] = [];

        for (const filename of filenames) {
            if (typeof filename === 'string' && filename.trim().length > 0) {
                valid.push(filename.trim());
            } else {
                invalid.push(String(filename));
            }
        }

        return { valid, invalid };
    }
}

// Content Manager Class
export class ContentManager {
    static async batchReadNotes(
        filenames: string[], 
        request: MultiNoteRequest,
        availableNotes: NoteInfo[]
    ): Promise<MultiNoteResponse> {
        const results: NoteResult[] = [];
        const errors: string[] = [];
        let successCount = 0;
        let permissionCounts = { rw: 0, ro: 0 };

        for (const filename of filenames) {
            try {
                const noteInfo = availableNotes.find(n => n.name === filename);
                const result: NoteResult = {
                    filename,
                    permission: noteInfo?.perm as 'ro' | 'rw' || 'ro'
                };

                // Count permissions
                if (result.permission === 'rw') permissionCounts.rw++;
                else permissionCounts.ro++;

                // Read content if requested
                if (request.includeContent !== false) {
                    const content = await (request.enableCaching !== false 
                        ? getCachedNoteContent(filename, true)
                        : readNoteAPI(filename)
                    );
                    
                    if (request.format === 'summary') {
                        result.contentPreview = content.length > 200 
                            ? content.substring(0, 197) + '...'
                            : content;
                    } else {
                        result.content = content;
                    }

                    // Add metadata if requested
                    if (request.includeMetadata !== false) {
                        result.size = content.length;
                        // lastModified would need to be fetched from file listing
                    }
                }

                results.push(result);
                successCount++;

            } catch (error) {
                const errorMsg = NoteErrorHandler.formatError(error, `Failed to read ${filename}`);
                errors.push(errorMsg);
                
                // Add failed note to results with error
                results.push({
                    filename,
                    permission: 'ro',
                    error: errorMsg
                });
            }
        }

        return {
            summary: {
                totalNotes: filenames.length,
                successCount,
                errorCount: filenames.length - successCount,
                permissions: permissionCounts
            },
            notes: results,
            errors: errors.length > 0 ? errors : undefined
        };
    }

    static formatResponse(response: MultiNoteResponse, format: string = 'structured'): string {
        switch (format) {
            case 'concatenated':
                return this.formatConcatenated(response);
            case 'summary':
                return this.formatSummary(response);
            case 'structured':
            default:
                return this.formatStructured(response);
        }
    }

    private static formatStructured(response: MultiNoteResponse): string {
        let output = `📊 **Summary**: ${response.summary.successCount}/${response.summary.totalNotes} notes read successfully\n`;
        output += `📋 **Permissions**: ${response.summary.permissions.rw} read-write, ${response.summary.permissions.ro} read-only\n\n`;

        response.notes.forEach((note, index) => {
            output += `## ${index + 1}. ${note.filename}\n`;
            output += `**Permission**: ${note.permission}\n`;
            
            if (note.size) {
                output += `**Size**: ${note.size} characters\n`;
            }
            
            if (note.error) {
                output += `**Error**: ${note.error}\n`;
            } else if (note.content) {
                output += `**Content**:\n\`\`\`markdown\n${note.content}\n\`\`\`\n`;
            } else if (note.contentPreview) {
                output += `**Preview**: ${note.contentPreview}\n`;
            }
            
            output += '\n---\n\n';
        });

        if (response.errors && response.errors.length > 0) {
            output += `## Errors\n${response.errors.map(e => `- ${e}`).join('\n')}\n`;
        }

        return output;
    }

    private static formatConcatenated(response: MultiNoteResponse): string {
        let output = `# Combined Notes (${response.summary.successCount} notes)\n\n`;
        
        response.notes
            .filter(note => note.content && !note.error)
            .forEach(note => {
                output += `# ${note.filename}\n\n${note.content}\n\n---\n\n`;
            });

        return output;
    }

    private static formatSummary(response: MultiNoteResponse): string {
        let output = `📊 **Multi-Note Summary** (${response.summary.totalNotes} notes)\n\n`;
        
        response.notes.forEach((note, index) => {
            const status = note.error ? '❌' : '✅';
            output += `${status} **${note.filename}** (${note.permission})`;
            
            if (note.contentPreview) {
                output += `\n   📝 ${note.contentPreview}`;
            }
            
            if (note.error) {
                output += `\n   ⚠️ ${note.error}`;
            }
            
            output += '\n\n';
        });

        return output;
    }
}