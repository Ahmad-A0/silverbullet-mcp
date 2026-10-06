import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    getFullFileListingAPI,
    readNoteSnapshotAPI,
    writeNoteAPI,
    deleteNoteAPI,
    SilverBulletAPIError,
} from './silverbullet-api.js';
import { outputSchemas } from './tool-schemas.js';
import { toolResult } from './tool-results.js';

const TEXT_CONTENT_TYPES = new Set([
    'application/json',
    'application/javascript',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'image/svg+xml',
]);

function inferContentType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.excalidraw') || lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'application/javascript';
    if (lower.endsWith('.xml')) return 'application/xml';
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
    return 'text/plain';
}

function isTextFile(filename: string, contentType: string): boolean {
    const lower = filename.toLowerCase();
    return contentType.startsWith('text/')
        || TEXT_CONTENT_TYPES.has(contentType.toLowerCase())
        || lower.endsWith('.excalidraw')
        || lower.endsWith('.json')
        || lower.endsWith('.svg')
        || lower.endsWith('.xml')
        || lower.endsWith('.yaml')
        || lower.endsWith('.yml');
}

function decodeCursor(cursor: string | undefined): string {
    if (cursor === undefined) return '';
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded || Buffer.from(decoded).toString('base64url') !== cursor) {
        throw new Error('Invalid cursor');
    }
    return decoded;
}

export function registerFileTools(server: McpServer): void {
    server.registerTool(
        'list-files',
        {
            title: 'List Files',
            description: 'List files in the SilverBullet space, including non-Markdown files such as .excalidraw. Library files are excluded by default.',
            annotations: { readOnlyHint: true, openWorldHint: false },
            outputSchema: outputSchemas.fileList,
            inputSchema: {
                limit: z.number().int().min(1).max(500).default(100),
                cursor: z.string().optional().describe('nextCursor from the previous page; keep filters unchanged'),
                namePattern: z.string().optional().describe('Optional JavaScript regex pattern to filter file names'),
                extension: z.string().optional().describe('Optional extension filter, for example ".excalidraw" or "excalidraw"'),
                permission: z.enum(['rw', 'ro']).optional(),
                includeLibrary: z.boolean().default(false).describe('Include files under Library/'),
            },
        },
        async ({ limit, cursor, namePattern, extension, permission, includeLibrary }) => {
            try {
                let files = await getFullFileListingAPI();
                if (!includeLibrary) files = files.filter(file => !file.name.startsWith('Library'));
                if (namePattern) {
                    const regex = new RegExp(namePattern, 'i');
                    files = files.filter(file => regex.test(file.name));
                }
                if (extension) {
                    const normalized = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
                    files = files.filter(file => file.name.toLowerCase().endsWith(normalized));
                }
                if (permission) files = files.filter(file => file.perm === permission);

                files.sort((a, b) => a.name.localeCompare(b.name));
                const after = decodeCursor(cursor);
                const remaining = files.filter(file => file.name > after);
                const page = remaining.slice(0, limit);
                const nextCursor = remaining.length > page.length
                    ? Buffer.from(page[page.length - 1].name).toString('base64url')
                    : null;

                return toolResult(
                    {
                        files: page.map(({ name, perm, contentType, size, lastModified }) => ({
                            name, perm, contentType, size, lastModified,
                        })),
                        total: files.length,
                        nextCursor,
                    },
                    page.length
                        ? page.map(file => `${file.name} (${file.contentType}, ${file.size} bytes, ${file.perm})`).join('\n')
                        : 'No files found'
                );
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to list files: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        }
    );

    server.registerTool(
        'read-file',
        {
            title: 'Read Text File',
            description: 'Read an arbitrary UTF-8 text file from the SilverBullet space, including JSON-based .excalidraw files. Binary files are rejected.',
            annotations: { readOnlyHint: true, openWorldHint: false },
            outputSchema: outputSchemas.fileRead,
            inputSchema: {
                filename: z.string().min(1),
                offset: z.number().int().min(0).default(0),
                limit: z.number().int().min(1).max(100_000).default(50_000),
            },
        },
        async ({ filename, offset, limit }) => {
            try {
                const files = await getFullFileListingAPI();
                const metadata = files.find(file => file.name === filename);
                if (!metadata) throw new Error(`File ${filename} not found`);
                if (!isTextFile(filename, metadata.contentType)) {
                    throw new Error(`File ${filename} is not a supported UTF-8 text file (content type: ${metadata.contentType})`);
                }

                const file = await readNoteSnapshotAPI(filename);
                const content = file.content.slice(offset, offset + limit);
                const nextOffset = offset + content.length < file.content.length ? offset + content.length : null;
                return toolResult(
                    {
                        filename,
                        content,
                        contentType: metadata.contentType,
                        revision: file.revision,
                        offset,
                        totalCharacters: file.content.length,
                        nextOffset,
                    },
                    content + (nextOffset !== null ? `\n[Truncated; continue with offset=${nextOffset}]` : '')
                );
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        }
    );

    server.registerTool(
        'write-file',
        {
            title: 'Write Text File',
            description: 'Create or replace an arbitrary UTF-8 text file in the SilverBullet space. Suitable for JSON-based .excalidraw files. Use expectedRevision from read-file for revision-checked updates.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
            outputSchema: outputSchemas.fileWrite,
            inputSchema: {
                filename: z.string().min(1),
                content: z.string(),
                overwrite: z.boolean().default(false),
                expectedRevision: z.string().optional().describe('Revision returned by read-file; recommended when overwriting an existing file'),
                contentType: z.string().optional().describe('MIME type. Defaults from the filename; .excalidraw uses application/json.'),
            },
        },
        async ({ filename, content, overwrite, expectedRevision, contentType }) => {
            const resolvedContentType = contentType ?? inferContentType(filename);
            try {
                if (!isTextFile(filename, resolvedContentType)) {
                    throw new Error(`write-file only supports UTF-8 text files (content type: ${resolvedContentType})`);
                }
                if (expectedRevision && !overwrite) {
                    throw new Error('expectedRevision requires overwrite=true');
                }

                const revision = await writeNoteAPI(filename, content, {
                    createOnly: !overwrite,
                    expectedRevision,
                    contentType: resolvedContentType,
                });
                return toolResult(
                    { filename, overwrite, contentType: resolvedContentType, revision },
                    `Successfully ${overwrite ? 'wrote' : 'created'} file: ${filename}`
                );
            } catch (error) {
                const message = error instanceof SilverBulletAPIError && error.status === 412 && !overwrite
                    ? `File ${filename} already exists. Use overwrite=true to replace it.`
                    : error instanceof Error ? error.message : String(error);
                return { content: [{ type: 'text', text: `Failed to write file: ${message}` }], isError: true };
            }
        }
    );

    server.registerTool(
        'delete-file',
        {
            title: 'Delete File',
            description: 'Delete any file from the SilverBullet space by exact filename.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
            outputSchema: outputSchemas.fileDelete,
            inputSchema: { filename: z.string().min(1) },
        },
        async ({ filename }) => {
            try {
                await deleteNoteAPI(filename);
                return toolResult({ filename, deleted: true as const }, `Successfully deleted file: ${filename}`);
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to delete file: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        }
    );
}
