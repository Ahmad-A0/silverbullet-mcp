// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const SB_API_BASE_URL = process.env.SB_API_BASE_URL || 'http://silverbullet:3000';
const SB_AUTH_TOKEN = process.env.SB_AUTH_TOKEN;
const MCP_TOKEN = process.env.MCP_TOKEN;

// --- SilverBullet API Interaction Functions ---
interface SBFile {
  name: string;
  lastModified: number;
  contentType: string;
  size: number;
  perm: 'ro' | 'rw';
}

// Search result types
interface SearchMatch {
  type: 'title' | 'content';
  line: number;
  content: string;
  matchCount: number;
  context?: string;
  startLine?: number;
  endLine?: number;
}

interface SearchResult {
  filename: string;
  permission: 'ro' | 'rw';
  matches: SearchMatch[];
  score: number;
}

async function listNotesAPI(): Promise<Array<{ name: string, perm: 'ro' | 'rw' }>> {
  const url = `${SB_API_BASE_URL}/index.json`;
  const fetchHeaders: HeadersInit = {
    'X-Sync-Mode': 'true'
  };
  if (SB_AUTH_TOKEN) {
    fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }

  console.log(`[listNotesAPI] Fetching notes from URL: ${url}`);
  console.log(`[listNotesAPI] With headers: ${JSON.stringify(fetchHeaders)}`);

  let response;
  try {
    response = await fetch(url, { headers: fetchHeaders });
  } catch (error) {
    console.error(`[listNotesAPI] Fetch failed:`, error);
    throw new Error(`Failed to connect to SilverBullet API at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[listNotesAPI] Response status: ${response.status}`);

  if (!response.ok) {
    const responseText = await response.text();
    console.error(`[listNotesAPI] Error response body (first 500 chars): ${responseText.substring(0, 500)}`);
    throw new Error(`Failed to list notes from SilverBullet API (${url}): ${response.status} ${response.statusText}`);
  }

  // Clone the response so we can read it as both JSON and text if needed
  const responseClone = response.clone();
  
  try {
    const files: SBFile[] = await response.json();
    console.log(`[listNotesAPI] Successfully parsed JSON response with ${files.length} files`);
    return files.filter(f => f.name.endsWith('.md')).map(f => ({ name: f.name, perm: f.perm }));
  } catch (error) {
    console.error(`[listNotesAPI] Failed to parse JSON response from ${url}:`, error);
    
    // Since we cloned the response, we can still read the body as text
    try {
      const responseText = await responseClone.text();
      console.error(`[listNotesAPI] Actual response body (first 1000 chars): ${responseText.substring(0, 1000)}`);
      console.error(`[listNotesAPI] Response Content-Type: ${response.headers.get('content-type')}`);
      console.error(`[listNotesAPI] Full response headers:`, Object.fromEntries(response.headers.entries()));
    } catch (textError) {
      console.error(`[listNotesAPI] Could not read response body as text:`, textError);
    }
    
    throw new Error(`Failed to parse JSON response from SilverBullet API (${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Get full file listing with metadata for cache invalidation
async function getFullFileListingAPI(): Promise<SBFile[]> {
  const url = `${SB_API_BASE_URL}/index.json`;
  const fetchHeaders: HeadersInit = {
    'X-Sync-Mode': 'true'
  };
  if (SB_AUTH_TOKEN) {
    fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }

  console.log(`[getFullFileListingAPI] Fetching full file listing from: ${url}`);

  const response = await fetch(url, { headers: fetchHeaders });
  
  if (!response.ok) {
    throw new Error(`Failed to get file listing: ${response.status} ${response.statusText}`);
  }

  const files: SBFile[] = await response.json();
  return files.filter(f => f.name.endsWith('.md'));
}

async function readNoteAPI(filename: string): Promise<string> {
  const url = `${SB_API_BASE_URL}/${encodeURIComponent(filename)}`;
  const fetchHeaders: HeadersInit = {
    'X-Sync-Mode': 'true'
  };
  if (SB_AUTH_TOKEN) {
    fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }

  console.log(`[readNoteAPI] Reading note: ${filename}`);
  console.log(`[readNoteAPI] Fetching from URL: ${url}`);
  console.log(`[readNoteAPI] With headers: ${JSON.stringify(fetchHeaders)}`);

  let response;
  try {
    response = await fetch(url, { headers: fetchHeaders });
  } catch (error) {
    console.error(`[readNoteAPI] Fetch failed for ${filename}:`, error);
    throw new Error(`Failed to connect to SilverBullet API at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[readNoteAPI] Response status for ${filename}: ${response.status}`);

  if (!response.ok) {
    const responseText = await response.text();
    console.error(`[readNoteAPI] Error response body for ${filename} (first 500 chars): ${responseText.substring(0, 500)}`);
    throw new Error(`Failed to read note ${filename} from SilverBullet API (${url}): ${response.status} ${response.statusText}`);
  }

  try {
    const content = await response.text();
    console.log(`[readNoteAPI] Successfully read note ${filename}, content length: ${content.length}`);
    return content;
  } catch (error) {
    console.error(`[readNoteAPI] Failed to read text content for ${filename}:`, error);
    throw new Error(`Failed to read text content for note ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeNoteAPI(filename: string, content: string): Promise<void> {
  const url = `${SB_API_BASE_URL}/${encodeURIComponent(filename)}`;
  const fetchHeaders: HeadersInit = {
    'Content-Type': 'text/markdown',
    'X-Sync-Mode': 'true'
  };
  if (SB_AUTH_TOKEN) {
    fetchHeaders['Authorization'] = `Bearer ${SB_AUTH_TOKEN}`;
  }

  console.log(`[writeNoteAPI] Writing note: ${filename}`);
  console.log(`[writeNoteAPI] Content length: ${content.length}`);
  console.log(`[writeNoteAPI] PUT to URL: ${url}`);
  console.log(`[writeNoteAPI] With headers: ${JSON.stringify(fetchHeaders)}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: fetchHeaders,
      body: content,
    });
  } catch (error) {
    console.error(`[writeNoteAPI] Fetch failed for ${filename}:`, error);
    throw new Error(`Failed to connect to SilverBullet API at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[writeNoteAPI] Response status for ${filename}: ${response.status}`);

  if (!response.ok) {
    const responseText = await response.text();
    console.error(`[writeNoteAPI] Error response body for ${filename} (first 500 chars): ${responseText.substring(0, 500)}`);
    throw new Error(`Failed to write note ${filename} via SilverBullet API (${url}): ${response.status} ${response.statusText}`);
  }

  console.log(`[writeNoteAPI] Successfully wrote note: ${filename}`);
}

// Function to create and configure MCP server instance
function configureMcpServerInstance(server: McpServer): void {
  console.log(`[configureMcpServerInstance] Configuring MCP server with SilverBullet resources and tools`);
  
  // Resource: list all notes
  server.resource(
    'notes',
    'sb-notes://all',
    async () => {
      console.log(`[MCP Resource: notes] Handling request for sb-notes://all`);
      try {
        const notesData = await listNotesAPI();
        console.log(`[MCP Resource: notes] Retrieved ${notesData.length} notes`);
        const result = {
          contents: [{
            uri: 'sb-notes://all',
            text: JSON.stringify(notesData.map(n => ({
              name: n.name,
              uri: `sb-note://${encodeURIComponent(n.name)}`,
              permissions: n.perm
            })), null, 2)
          }]
        };
        console.log(`[MCP Resource: notes] Returning resource data`);
        return result;
      } catch (error) {
        console.error(`[MCP Resource: notes] Error:`, error);
        throw error;
      }
    }
  );

  // Resource: read a single note
  server.resource(
    'note',
    new ResourceTemplate('sb-note://{filename}', { list: undefined }),
    async (uri, { filename }) => {
      console.log(`[MCP Resource: note] Handling request for URI: ${uri.href}`);
      console.log(`[MCP Resource: note] Filename parameter: ${filename}`);
      try {
        const fname = decodeURIComponent(filename as string);
        console.log(`[MCP Resource: note] Decoded filename: ${fname}`);
        const text = await readNoteAPI(fname);
        const result = {
          contents: [{
            uri: uri.href,
            text,
            mimeType: 'text/markdown'
          }]
        };
        console.log(`[MCP Resource: note] Successfully returning note content, length: ${text.length}`);
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
      content: z.string().describe('The new content for the note')
    },
    async ({ filename, content }) => {
      console.log(`[MCP Tool: update-note] Called with filename: ${filename}, content length: ${content.length}`);
      try {
        await writeNoteAPI(filename, content);
        console.log(`[MCP Tool: update-note] Successfully updated note: ${filename}`);
        return {
          content: [{
            type: 'text',
            text: `Successfully updated note: ${filename}`
          }]
        };
      } catch (error) {
        console.error(`[MCP Tool: update-note] Error updating note ${filename}:`, error);
        return {
          content: [{
            type: 'text',
            text: `Failed to update note: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: list all notes with optional filtering
  server.tool(
    'list-notes',
    {
      namePattern: z.string().optional().describe('Optional regex pattern to filter note names (e.g., "project.*" for notes starting with "project")'),
      permission: z.enum(['rw', 'ro']).optional().describe('Filter by permission: "rw" for read-write, "ro" for read-only'),
      contentSearch: z.string().optional().describe('Optional text to search for within note contents (case-insensitive)')
    },
    async ({ namePattern, permission, contentSearch }) => {
      console.log(`[MCP Tool: list-notes] Called with filters:`, { namePattern, permission, contentSearch });
      try {
        let notes = await listNotesAPI();
        console.log(`[MCP Tool: list-notes] Retrieved ${notes.length} total notes`);

        // Apply name pattern filter
        if (namePattern) {
          const regex = new RegExp(namePattern, 'i');
          notes = notes.filter(note => regex.test(note.name));
          console.log(`[MCP Tool: list-notes] After name pattern filter: ${notes.length} notes`);
        }

        // Apply permission filter
        if (permission) {
          notes = notes.filter(note => note.perm === permission);
          console.log(`[MCP Tool: list-notes] After permission filter: ${notes.length} notes`);
        }

        // Apply content search filter
        if (contentSearch) {
          console.log(`[MCP Tool: list-notes] Searching note contents for: "${contentSearch}"`);
          const contentFilteredNotes = [];
          for (const note of notes) {
            try {
              const content = await getCachedNoteContent(note.name, true);
              if (content.toLowerCase().includes(contentSearch.toLowerCase())) {
                contentFilteredNotes.push(note);
              }
            } catch (error) {
              console.error(`[MCP Tool: list-notes] Failed to read note ${note.name} for content search:`, error);
              // Continue with other notes even if one fails
            }
          }
          notes = contentFilteredNotes;
          console.log(`[MCP Tool: list-notes] After content search filter: ${notes.length} notes`);
        }

        const notesList = notes.map(note =>
          `- ${note.name} (${note.perm === 'rw' ? 'read-write' : 'read-only'})`
        ).join('\n');

        const filterSummary = [];
        if (namePattern) filterSummary.push(`name pattern: "${namePattern}"`);
        if (permission) filterSummary.push(`permission: ${permission}`);
        if (contentSearch) filterSummary.push(`content search: "${contentSearch}"`);

        const headerText = filterSummary.length > 0
          ? `Notes matching filters (${filterSummary.join(', ')}):`
          : 'Available notes:';

        console.log(`[MCP Tool: list-notes] Returning ${notes.length} filtered notes`);
        return {
          content: [{
            type: 'text',
            text: `${headerText}\n${notesList || 'No notes found matching the specified criteria.'}`
          }]
        };
      } catch (error) {
        console.error(`[MCP Tool: list-notes] Error:`, error);
        return {
          content: [{
            type: 'text',
            text: `Failed to list notes: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );
// Tool: full-text search across notes
server.tool(
  'search-notes',
  {
    query: z.string().describe('Search query (supports regex patterns)'),
    searchType: z.enum(['content', 'title', 'both']).default('both').describe('Where to search: content, title (filename), or both'),
    caseSensitive: z.boolean().default(false).describe('Whether search should be case-sensitive'),
    maxResults: z.number().default(10).describe('Maximum number of results to return'),
    contextLines: z.number().default(2).describe('Number of lines of context to show around each match'),
    enableCaching: z.boolean().default(true).describe('Enable content caching with modification time validation')
  },
  async ({ query, searchType, caseSensitive, maxResults, contextLines, enableCaching }) => {
    console.log(`[MCP Tool: search-notes] Called with query: "${query}", type: ${searchType}, caching: ${enableCaching}`);
    
    try {
      const notes = await listNotesAPI();
      console.log(`[MCP Tool: search-notes] Searching across ${notes.length} notes`);
      
      const searchResults = [];
      const flags = caseSensitive ? 'g' : 'gi';
      let searchRegex;
      
      try {
        searchRegex = new RegExp(query, flags);
      } catch (error) {
        // If regex is invalid, escape special characters and treat as literal
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        searchRegex = new RegExp(escapedQuery, flags);
        console.log(`[MCP Tool: search-notes] Invalid regex, using literal search: "${escapedQuery}"`);
      }
      
      for (const note of notes) {
        const noteResults: SearchResult = {
          filename: note.name,
          permission: note.perm,
          matches: [],
          score: 0
        };
        
        // Search in title/filename
        if (searchType === 'title' || searchType === 'both') {
          const titleMatches = [...note.name.matchAll(searchRegex)];
          if (titleMatches.length > 0) {
            noteResults.matches.push({
              type: 'title',
              line: 0,
              content: note.name,
              matchCount: titleMatches.length
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
                // Get context lines
                const startLine = Math.max(0, lineIndex - contextLines);
                const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
                const contextText = lines.slice(startLine, endLine + 1).join('\n');
                
                noteResults.matches.push({
                  type: 'content',
                  line: lineIndex + 1,
                  content: line,
                  context: contextText,
                  matchCount: lineMatches.length,
                  startLine: startLine + 1,
                  endLine: endLine + 1
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
          const totalMatches = noteResults.matches.reduce((sum, match) => sum + match.matchCount, 0);
          noteResults.score = totalMatches;
          searchResults.push(noteResults);
        }
      }
      
      // Sort by relevance (score) and limit results
      searchResults.sort((a, b) => b.score - a.score);
      const limitedResults = searchResults.slice(0, maxResults);
      
      console.log(`[MCP Tool: search-notes] Found ${searchResults.length} notes with matches, returning top ${limitedResults.length}`);
      
      // Format results
      if (limitedResults.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No matches found for "${query}" in ${searchType === 'both' ? 'titles or content' : searchType}.`
          }]
        };
      }
      
      const totalMatches = limitedResults.reduce((sum, result) => sum + result.score, 0);
      let output = `Found ${totalMatches} matches in ${limitedResults.length} notes:\n\n`;
      
      limitedResults.forEach(result => {
        const totalNoteMatches = result.matches.reduce((sum, match) => sum + match.matchCount, 0);
        output += `📄 **${result.filename}** (${totalNoteMatches} matches, ${result.permission})\n`;
        
        result.matches.forEach(match => {
          if (match.type === 'title') {
            output += `  📝 Title: "${match.content}"\n`;
          } else {
            output += `  Line ${match.line}: "${match.content}"\n`;
            if (contextLines > 0 && match.context) {
              const contextWithHighlight = match.context.split('\n').map((line: string, idx: number) => {
                const actualLineNum = (match.startLine || 0) + idx;
                const prefix = actualLineNum === match.line ? '→' : ' ';
                return `    ${prefix} ${actualLineNum}: ${line}`;
              }).join('\n');
              output += `${contextWithHighlight}\n`;
            }
          }
        });
        output += '\n';
      });
      
      return {
        content: [{
          type: 'text',
          text: output
        }]
      };
    } catch (error) {
      console.error(`[MCP Tool: search-notes] Error:`, error);
      return {
        content: [{
          type: 'text',
          text: `Failed to search notes: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      };
    }
  }
);

// Tool: read a note
server.tool(
  'read-note',
  {
    filename: z.string().describe('The filename of the note to read')
  },
  async ({ filename }) => {
    console.log(`[MCP Tool: read-note] Called with filename: ${filename}`);
    try {
      const content = await readNoteAPI(filename);
      console.log(`[MCP Tool: read-note] Successfully read note: ${filename}, content length: ${content.length}`);
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error) {
      console.error(`[MCP Tool: read-note] Error reading note ${filename}:`, error);
      return {
        content: [{
          type: 'text',
          text: `Failed to read note: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      }
    }}
  );

  // Tool: create a new note
  server.tool(
    'create-note',
    {
      filename: z.string().describe('The filename for the new note (should end with .md)'),
      content: z.string().describe('The content for the new note')
    },
    async ({ filename, content }) => {
      console.log(`[MCP Tool: create-note] Called with filename: ${filename}, content length: ${content.length}`);
      try {
        if (!filename.endsWith('.md')) {
          console.log(`[MCP Tool: create-note] Validation failed: filename must end with .md`);
          return {
            content: [{
              type: 'text',
              text: 'Filename must end with .md extension'
            }],
            isError: true
          };
        }
        await writeNoteAPI(filename, content);
        console.log(`[MCP Tool: create-note] Successfully created note: ${filename}`);
        return {
          content: [{
            type: 'text',
            text: `Successfully created note: ${filename}`
          }]
        };
      } catch (error) {
        console.error(`[MCP Tool: create-note] Error creating note ${filename}:`, error);
        return {
          content: [{
            type: 'text',
            text: `Failed to create note: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  console.log(`[configureMcpServerInstance] Finished configuring MCP server`);
}


const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
// Map to store MCP server instances by session ID
const mcpServers: { [sessionId: string]: McpServer } = {};

// Content cache with modification time tracking
interface CacheEntry {
  content: string;
  lastModified: number;
}
const contentCache: { [filename: string]: CacheEntry } = {};

// Function to get cached content or fetch if needed
async function getCachedNoteContent(filename: string, enableCaching: boolean = true): Promise<string> {
  if (!enableCaching) {
    return await readNoteAPI(filename);
  }

  // Proper invalidation based on SilverBullet metadata
  // Fetch full listing including lastModified timestamps
  const files = await getFullFileListingAPI();
  const noteInfo = files.find(f => f.name === filename);
  if (!noteInfo) {
    throw new Error(`Note ${filename} not found`);
  }

  const cached = contentCache[filename];
  // Compare actual lastModified timestamps
  if (cached && cached.lastModified >= noteInfo.lastModified) {
    console.log(`[getCachedNoteContent] Using cached content for ${filename}`);
    return cached.content;
  }

  // Fetch fresh content
  console.log(`[getCachedNoteContent] Fetching fresh content for ${filename}`);
  const content = await readNoteAPI(filename);

  // Update cache with actual lastModified timestamp
  contentCache[filename] = {
    content,
    lastModified: noteInfo.lastModified
  };

  return content;
}


// Mandatory API key check for MCP requests
const mcpAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  console.log(`[mcpAuthMiddleware] ${req.method} ${req.path} - Checking authentication`);
  
  if (!MCP_TOKEN) {
    console.error(`[mcpAuthMiddleware] CRITICAL: MCP_TOKEN not set - rejecting request`);
    return res.status(500).json({
      error: 'Server misconfiguration: Authentication token not configured'
    });
  }

  // Check for token in Authorization header (Bearer token)
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  
  // Check for token in query parameter
  const queryToken = req.query.token as string;
  
  // Check for token in request body
  const bodyToken = req.body?.token as string;
  
  console.log(`[mcpAuthMiddleware] Checking for token in header, query, or body`);
  console.log(`[mcpAuthMiddleware] Header token: ${headerToken ? 'present' : 'none'}`);
  console.log(`[mcpAuthMiddleware] Query token: ${queryToken ? 'present' : 'none'}`);
  console.log(`[mcpAuthMiddleware] Body token: ${bodyToken ? 'present' : 'none'}`);
  
  const providedToken = headerToken || queryToken || bodyToken;
  
  if (!providedToken || providedToken !== MCP_TOKEN) {
    console.log(`[mcpAuthMiddleware] Authentication failed - invalid or missing token`);
    console.log(`[mcpAuthMiddleware] Expected: ${MCP_TOKEN.substring(0, 4)}...`);
    console.log(`[mcpAuthMiddleware] Received: ${providedToken ? providedToken.substring(0, 4) + '...' : 'none'}`);
    return res.status(401).json({
      error: 'Unauthorized - Invalid or missing authentication token',
      hint: 'Provide token via Authorization header (Bearer <token>), query parameter (?token=<token>), or request body ({"token": "<token>"})'
    });
  }
  
  console.log(`[mcpAuthMiddleware] Authentication successful via ${headerToken ? 'header' : queryToken ? 'query' : 'body'}`);
  next();
};

// Default route - no authentication required
app.get('/', (req, res) => {
  console.log(`[GET /] Health check request from ${req.ip}`);
  console.log(`[GET /] Request details: ${JSON.stringify({
    method: req.method,
    url: req.url,
    headers: req.headers,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  }, null, 2)}`);
  
  res.json({
    service: 'SilverBullet MCP Server',
    version: '0.1.0',
    status: 'running',
    authentication: 'required for /mcp routes',
    timestamp: new Date().toISOString()
  });
});

// Apply auth middleware to all /mcp routes only
app.use('/mcp', mcpAuthMiddleware);

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  console.log(`[POST /mcp] Incoming request with session ID: ${sessionId || 'none'}`);
  console.log(`[POST /mcp] Request body method: ${req.body?.method || 'unknown'}`);
  // Log full request details with proper serialization for docker logs
  try {
    const requestDetails = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    };
    console.log(`[POST /mcp] Full request details:`);
    console.log(JSON.stringify(requestDetails, null, 2));
  } catch (error) {
    console.error(`[POST /mcp] Failed to serialize request details:`, error);
    console.log(`[POST /mcp] Basic request info: ${req.method} ${req.url} from ${req.ip}`);
  }
  
  let transport: StreamableHTTPServerTransport;
  let mcpServer: McpServer;

  if (sessionId && transports[sessionId] && mcpServers[sessionId]) {
    console.log(`[POST /mcp] Reusing existing session: ${sessionId}`);
    transport = transports[sessionId];
    mcpServer = mcpServers[sessionId]; // Reuse existing server instance for the session
  } else {
    // Create new session for:
    // 1. No session ID provided
    // 2. Invalid/expired session ID
    // 3. Any authenticated request that needs a session
    if (sessionId) {
      console.log(`[POST /mcp] Invalid session ID (${sessionId}), creating new session`);
    } else {
      console.log(`[POST /mcp] No session ID provided, creating new session`);
    }
    
    const newSessionId = randomUUID();
    console.log(`[POST /mcp] Generated new session ID: ${newSessionId}`);
    
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sId) => {
        console.log(`[POST /mcp] Session initialized: ${sId}`);
        transports[sId] = transport;
        mcpServers[sId] = mcpServer; // Store the server instance with the session
      }
    });

    console.log(`[POST /mcp] Creating new MCP server instance`);
    mcpServer = new McpServer({
      name: "SilverBullet MCP", // Updated name
      version: "0.1.0"         // Updated version
    });
    configureMcpServerInstance(mcpServer); // Configure with SilverBullet tools/resources

    transport.onclose = () => {
      if (transport.sessionId) {
        console.log(`[POST /mcp] Session closing: ${transport.sessionId}`);
        delete transports[transport.sessionId];
        delete mcpServers[transport.sessionId]; // Clean up server instance
        mcpServer.close(); // Close the MCP server instance
      }
    };
    
    console.log(`[POST /mcp] Connecting MCP server to transport`);
    await mcpServer.connect(transport);
  }

  console.log(`[POST /mcp] Handling request with session: ${transport.sessionId}`);
  try {
    await transport.handleRequest(req, res, req.body);
    console.log(`[POST /mcp] Successfully handled request for session: ${transport.sessionId}`);
  } catch (error) {
    console.error(`[POST /mcp] Error handling MCP request for session ${transport.sessionId}:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error during request handling.',
        },
        id: req.body?.id || null,
      });
    }
  }
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  console.log(`[handleSessionRequest] ${req.method} request with session ID: ${sessionId || 'none'}`);
  
  if (!sessionId || !transports[sessionId]) {
    console.log(`[handleSessionRequest] Invalid or missing session ID: ${sessionId}`);
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`[handleSessionRequest] Found transport for session: ${sessionId}`);
  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
    console.log(`[handleSessionRequest] Successfully handled ${req.method} request for session: ${sessionId}`);
  } catch (error) {
    console.error(`[handleSessionRequest] Error handling session event for session ${sessionId}:`, error);
    // Don't send a JSON error response for SSE/event stream errors if headers already sent
    if (!res.headersSent) {
        res.status(500).send('Internal server error during session event handling.');
    } else {
        // If headers are sent (SSE connection), just end the response.
        res.end();
    }
  }
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', (req, res) => {
  console.log(`[GET /mcp] SSE request received`);
  try {
    console.log(`[GET /mcp] Request details:`);
    console.log(JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    console.error(`[GET /mcp] Failed to serialize request details:`, error);
  }
  handleSessionRequest(req, res);
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.log(`[DELETE /mcp] Session termination request for session: ${sessionId || 'none'}`);
    
    // Log full request details
    try {
      console.log(`[DELETE /mcp] Request details:`);
      console.log(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        sessionId: sessionId,
        timestamp: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error(`[DELETE /mcp] Failed to serialize request details:`, error);
    }
    
    if (!sessionId || !transports[sessionId]) {
        console.log(`[DELETE /mcp] Invalid or missing session ID: ${sessionId}`);
        res.status(400).send('Invalid or missing session ID for DELETE');
        return;
    }
    
    const transport = transports[sessionId];
    const mcpServer = mcpServers[sessionId];
    console.log(`[DELETE /mcp] Found session resources for ${sessionId}`);

    try {
        console.log(`[DELETE /mcp] Calling transport.handleRequest for session: ${sessionId}`);
        await transport.handleRequest(req, res); // Let transport handle the DELETE
        console.log(`[DELETE /mcp] Transport handled DELETE successfully for session: ${sessionId}`);
    } catch (error) {
        console.error(`[DELETE /mcp] Error during DELETE handling for session ${sessionId}:`, error);
        if (!res.headersSent) {
            res.status(500).send('Internal server error during session termination.');
        }
    } finally {
        console.log(`[DELETE /mcp] Cleaning up resources for session: ${sessionId}`);
        // Ensure resources are cleaned up even if handleRequest errors
        if (mcpServer) {
            console.log(`[DELETE /mcp] Closing MCP server for session: ${sessionId}`);
            mcpServer.close();
        }
        if (transport) {
            console.log(`[DELETE /mcp] Closing transport for session: ${sessionId}`);
            transport.close(); // This should trigger onclose and cleanup from maps
        }
         // Explicitly delete from maps as a safeguard
        if (sessionId) {
            delete transports[sessionId];
            delete mcpServers[sessionId];
        }
        console.log(`[DELETE /mcp] Session ${sessionId} terminated and cleaned up.`);
        if (!res.headersSent) { // handleRequest might have already sent a response
            res.status(204).send(); // No Content for successful deletion
        } else if (!res.writableEnded) {
            res.end();
        }
    }
});

// Validate required configuration
if (!MCP_TOKEN) {
  console.error(`[STARTUP] ❌ CRITICAL ERROR: MCP_TOKEN environment variable is required for security`);
  console.error(`[STARTUP] ❌ This server handles confidential notes and requires authentication`);
  console.error(`[STARTUP] ❌ Please set MCP_TOKEN environment variable and restart`);
  process.exit(1);
}

// Log configuration on startup
console.log(`[STARTUP] ===============================================`);
console.log(`[STARTUP] SilverBullet MCP Server Starting...`);
console.log(`[STARTUP] ===============================================`);
console.log(`[STARTUP] Configuration:`);
console.log(`[STARTUP] - Port: ${PORT}`);
console.log(`[STARTUP] - SilverBullet API URL: ${SB_API_BASE_URL}`);
console.log(`[STARTUP] - MCP Auth: ENABLED (REQUIRED FOR SECURITY)`);
console.log(`[STARTUP] - SilverBullet Auth: ${SB_AUTH_TOKEN ? 'ENABLED' : 'DISABLED (no SB_AUTH_TOKEN)'}`);
console.log(`[STARTUP] - Node.js version: ${process.version}`);
console.log(`[STARTUP] ===============================================`);

app.listen(PORT, () => {
  console.log(`[STARTUP] ✅ SilverBullet MCP server (Express Stateful) listening on port ${PORT}`);
  console.log(`[STARTUP] 🔗 SilverBullet API base URL: ${SB_API_BASE_URL}`);
  console.log(`[STARTUP] 🔐 MCP Authentication: ENABLED (MANDATORY)`);
  console.log(`[STARTUP] 🔑 SilverBullet Authentication: ${SB_AUTH_TOKEN ? 'enabled' : 'disabled (SB_AUTH_TOKEN not set)'}`);
  console.log(`[STARTUP] 🛡️  Security: All requests require valid MCP_TOKEN`);
  console.log(`[STARTUP] � Server ready to accept authenticated connections!`);
  console.log(`[STARTUP] ===============================================`);
});