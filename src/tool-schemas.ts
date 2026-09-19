import { z } from 'zod';

const note = z.object({
    filename: z.string(), permission: z.enum(['ro', 'rw']), size: z.number().optional(),
    lastModified: z.number().optional(), content: z.string().optional(), contentPreview: z.string().optional(),
    truncated: z.boolean().optional(), totalCharacters: z.number().optional(), error: z.string().optional(),
});
const match = z.object({
    type: z.enum(['title', 'content']), line: z.number(), content: z.string(), matchCount: z.number(),
    context: z.string().optional(), startLine: z.number().optional(), endLine: z.number().optional(),
});
export const outputSchemas = {
    read: { filename: z.string(), content: z.string(), revision: z.string().nullable(),
        offset: z.number().int(), totalCharacters: z.number().int(), nextOffset: z.number().int().nullable() },
    list: { notes: z.array(z.object({ name: z.string(), perm: z.enum(['ro', 'rw']) })),
        total: z.number().int(), nextCursor: z.string().nullable() },
    search: { query: z.string(), results: z.array(z.object({ filename: z.string(), permission: z.enum(['ro', 'rw']),
        score: z.number(), matches: z.array(match), matchesTruncated: z.boolean() })), totalResults: z.number().int(),
        totalMatches: z.number().int(), page: z.number().int(), totalPages: z.number().int(),
        nextPage: z.number().int().nullable(), errors: z.array(z.object({ filename: z.string(), message: z.string() })) },
    multiple: { summary: z.object({ totalNotes: z.number(), successCount: z.number(), errorCount: z.number(),
        permissions: z.object({ rw: z.number(), ro: z.number() }) }), notes: z.array(note), errors: z.array(z.string()).optional() },
    replace: { filename: z.string(), replacements: z.number().int(), changed: z.boolean() },
    create: { filename: z.string(), overwrite: z.boolean(), revision: z.string().nullable() },
    delete: { filename: z.string(), deleted: z.literal(true) },
};
