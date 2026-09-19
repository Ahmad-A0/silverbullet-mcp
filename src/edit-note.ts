import { createPatch } from 'diff';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readNoteSnapshotAPI, writeNoteAPI } from './silverbullet-api.js';
import { toolResult, toolError } from './tool-results.js';

export const editInput = {
    filename: z.string().min(1).describe('Exact note filename including .md'),
    edits: z.array(z.object({
        oldText: z.string().min(1).max(100_000).describe('Exact, case-sensitive text in the original note'),
        newText: z.string().max(100_000).describe('Literal replacement, including any dollar signs'),
        expectedMatches: z.number().int().min(1).max(10_000).default(1),
    }).strict()).min(1).max(100).describe('Non-overlapping edits, all matched against the original content'),
    expectedRevision: z.string().min(1).optional().describe('Revision returned by read-note or a previous dry run; rejects stale edits'),
    dryRun: z.boolean().default(false).describe('Return a diff without writing'),
};

export function prepareEdits(content: string, edits: { oldText: string; newText: string; expectedMatches: number }[]) {
    const ranges: { start: number; end: number; text: string; edit: number }[] = [];
    const counts: number[] = [];
    edits.forEach((edit, index) => {
        const positions: number[] = [];
        for (let start = content.indexOf(edit.oldText); start !== -1; start = content.indexOf(edit.oldText, start + 1)) {
            positions.push(start);
            if (positions.length > edit.expectedMatches) break;
        }
        if (positions.length !== edit.expectedMatches) {
            throw new Error(`Edit ${index + 1}: expected ${edit.expectedMatches} exact match(es), found ${positions.length > edit.expectedMatches ? 'more than expected' : positions.length}. Nothing was written.`);
        }
        counts.push(positions.length);
        positions.forEach(start => ranges.push({ start, end: start + edit.oldText.length, text: edit.newText, edit: index + 1 }));
    });
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].start < ranges[i - 1].end) {
            throw new Error(`Edits ${ranges[i - 1].edit} and ${ranges[i].edit} overlap. Nothing was written.`);
        }
    }
    let result = '', offset = 0;
    for (const range of ranges) {
        result += content.slice(offset, range.start) + range.text;
        offset = range.end;
    }
    return { content: result + content.slice(offset), counts };
}

export function registerEditNote(server: McpServer): void {
    server.registerTool('edit-note', {
        title: 'Edit Note',
        description: 'Apply exact, case-sensitive edits as one conditional write. All edits match the original note; ambiguous or overlapping matches fail without writing. Use dryRun to preview. Requires a SilverBullet server with ETag/If-Match support (verified on 2.11).',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: z.object(editInput).strict(),
        outputSchema: {
            filename: z.string(), dryRun: z.boolean(), changed: z.boolean(), applied: z.boolean(),
            replacements: z.array(z.number().int()), previousRevision: z.string().nullable(),
            revision: z.string().nullable(), diff: z.string(), diffTruncated: z.boolean(),
        },
    }, async ({ filename, edits, expectedRevision, dryRun }) => {
        try {
            const original = await readNoteSnapshotAPI(filename);
            if (expectedRevision !== undefined && expectedRevision !== original.revision) {
                throw new Error('Revision conflict: the note has changed. Read it again before editing. Nothing was written.');
            }
            const prepared = prepareEdits(original.content, edits);
            const changed = prepared.content !== original.content;
            const patch = createPatch(filename, original.content, prepared.content, '', '', { context: 3, timeout: 1000 });
            if (patch === undefined) throw new Error('Diff computation timed out. Use a smaller edit. Nothing was written.');
            let revision = original.revision;
            if (!dryRun && changed) {
                if (!original.revision || original.revision.startsWith('W/')) {
                    throw new Error('This server did not return a strong ETag. Conditional editing is unavailable; nothing was written.');
                }
                revision = await writeNoteAPI(filename, prepared.content, { expectedRevision: original.revision });
            }
            const result = { filename, dryRun, changed, applied: !dryRun && changed,
                replacements: prepared.counts, previousRevision: original.revision, revision,
                diff: patch.slice(0, 50_000), diffTruncated: patch.length > 50_000 };
            return toolResult(result, `${dryRun ? 'Preview' : changed ? 'Edited' : 'Unchanged'}: ${filename}\n${result.diff}${result.diffTruncated ? '\n[Diff truncated]' : ''}`);
        } catch (error) { return toolError(error); }
    });
}
