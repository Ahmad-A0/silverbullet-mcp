// src/server.ts
import { Hono } from 'hono';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { serve } from '@hono/node-server';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const SB_API_BASE_URL = process.env.SB_API_BASE_URL || 'http://silverbullet:3000';
const SB_AUTH_TOKEN = process.env.SB_AUTH_TOKEN;

// --- SilverBullet API Interaction Functions ---
interface SBFile {
  name: string;
  lastModified: number;
  contentType: string;
  size: number;
  perm: 'ro' | 'rw';
}

async function listNotesAPI(): Promise<Array<{ name: string, perm: 'ro' | 'rw' }>> {
  const headers: HeadersInit = {};
  if (SB_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }
  const response = await fetch(`${SB_API_BASE_URL}/index.json`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list notes from SilverBullet API: ${response.statusText}`);
  }
  const files: SBFile[] = await response.json();
  return files.filter(f => f.name.endsWith('.md')).map(f => ({ name: f.name, perm: f.perm }));
}

async function readNoteAPI(filename: string): Promise<string> {
  const headers: HeadersInit = {};
  if (SB_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }
  const response = await fetch(`${SB_API_BASE_URL}/${encodeURIComponent(filename)}`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to read note ${filename} from SilverBullet API: ${response.statusText}`);
  }
  return await response.text();
}

async function writeNoteAPI(filename: string, content: string): Promise<void> {
  const headers: HeadersInit = {
    'Content-Type': 'text/markdown',
  };
  if (SB_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }
  const response = await fetch(`${SB_API_BASE_URL}/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers,
    body: content,
  });
  if (!response.ok) {
    throw new Error(`Failed to write note ${filename} via SilverBullet API: ${response.statusText}`);
  }
}

// Create MCP server
const server = new McpServer({ name: 'SilverBullet MCP', version: '0.1.0' });

// Resource: list all notes
server.resource(
  'notes',
  new ResourceTemplate('sb-notes://all', { list: undefined }),
  async () => {
    const notesData = await listNotesAPI();
    return {
      contents: notesData.map(n => ({
        uri: `sb-note:///${encodeURIComponent(n.name)}`,
        text: `Permissions: ${n.perm}`, // Optionally include permission info
      })),
    };
  }
);

// Resource: read a single note
server.resource(
  'note',
  new ResourceTemplate('sb-note://{filename}', {
    list: async () => ({ resources: [] })
  }),
  async (_uri, { filename }) => {
    const fname = decodeURIComponent(filename as string); // Cast filename to string
    const text = await readNoteAPI(fname);
    return { contents: [{ uri: `sb-note:///${filename as string}`, text }] };
  }
);

// Tool: update a note
server.tool(
  'update-note',
  { filename: z.string(), content: z.string() },
  async ({ filename, content }) => {
    const fname = decodeURIComponent(filename);
    await writeNoteAPI(fname, content);
    return { content: [{ type: 'text', text: `Note ${fname} updated via API.` }] };
  }
);

// Set up Hono + MCP transport
const app = new Hono();

// (Optional) Simple API key check for MCP requests
app.use('/mcp', async (c, next) => {
  const authHeader = c.req.header('authorization');
  const expectedToken = process.env.MCP_TOKEN;
  
  // If MCP_TOKEN is not set, skip auth check (for development)
  if (!expectedToken) {
    await next();
    return;
  }
  
  if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

let transport: StreamableHTTPServerTransport;
let sessionActive = false;

app.post('/mcp', async (c) => {
  if (!sessionActive) {
    transport = new StreamableHTTPServerTransport({
      // baseUrl removed as it's not a valid option here
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    sessionActive = true;
  }

  const reqAdapter = {
    method: c.req.method,
    url: c.req.url,
    headers: c.req.header(),
    body: c.req.header('content-type')?.includes('application/json') ? await c.req.json() : await c.req.text(),
  };

  const resAdapter = {
    statusCode: 200,
    setHeader: (name: string, value: string | string[]) => c.header(name, Array.isArray(value) ? value.join(', ') : value),
    json: (body: any) => c.json(body, resAdapter.statusCode as any),
    send: (body: any) => c.text(body, resAdapter.statusCode as any),
    status: function(code: number) {
      this.statusCode = code;
      return this;
    },
    end: () => { /* Hono handles response ending */ }
  };

  // @ts-ignore - Transport handleRequest may not perfectly match our adapter types
  await transport.handleRequest(reqAdapter, resAdapter);
  
  // If no response was sent through the adapter methods, return a default response
  if (!c.res) {
    return new Response('', { status: resAdapter.statusCode });
  }
  
  return c.res;

});
console.log(`MCP server (API mode) listening on port ${PORT}`);
serve({
  fetch: app.fetch,
  port: PORT,
});