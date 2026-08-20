// Main Express server for SilverBullet MCP

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { PORT, validateConfiguration, logConfiguration, logStartupSuccess } from './config.js';
import { mcpAuthMiddleware } from './middleware.js';
import { configureMcpServerInstance } from './mcp-server.js';

const app = express();
app.use(express.json());

/**
 * A live session: one StreamableHTTPServerTransport paired with the McpServer
 * instance that drives it.
 *
 * NOTE on the "shared McpServer" design goal:
 *
 * The original plan called for a SINGLE shared McpServer instance with
 * session-aware transport routing, so that tool registration happens once and
 * reconnecting clients don't pay re-initialization cost.
 *
 * That literal design is not achievable with this version of the MCP SDK
 * (@modelcontextprotocol/sdk). The SDK's Protocol class (which McpServer /
 * Server extend) holds a *single* `this._transport` reference — connect() simply
 * overwrites it, and a StreamableHTTPServerTransport throws "Transport already
 * started" if start() is called twice. There is no public API to attach a
 * second transport to an already-connected server, and calling server.close()
 * to detach terminates every other session's in-flight SSE stream. A single
 * McpServer therefore cannot serve concurrent sessions.
 *
 * What we CAN do — and what this file does — is capture the *intent* of that
 * design:
 *
 *   1. Tool registration is cheap and stateless, so we create a fresh
 *      McpServer per session and call configureMcpServerInstance() on it.
 *      The 12 tools register in well under a millisecond; this is not a
 *      performance concern (see the perf table in the plan doc).
 *   2. We make the server RESILIENT to missing/stale session IDs (issue 6):
 *      a client whose session was lost (SSE drop, restart, stale/missing
 *      session-id header) is asked to re-initialize with a clear error instead
 *      of hitting the opaque "Server not initialized" path or leaking a
 *      half-built session. The client sends a fresh initialize and continues —
 *      it never gets stuck, and no resources leak.
 *   3. We eliminate the old memory leak: the previous code kept a separate
 *      `mcpServers` map that was only partially cleaned up. Sessions now live
 *      in a single map and are cleaned up atomically (transport close + server
 *      close + map delete) from every exit path (DELETE handler, onclose).
 */
interface Session {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
}

// Map to store live sessions by session ID
const sessions: { [sessionId: string]: Session } = {};

/**
 * Create a brand-new session: a fresh transport + a fresh McpServer with all
 * tools registered, wired together. Returns the session id (assigned
 * lazily by the transport's onsessioninitialized callback once the initialize
 * request is processed).
 */
function createSession(): { transport: StreamableHTTPServerTransport; server: McpServer } {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
            sessions[sessionId] = { transport, server };
        },
    });

    const server = new McpServer({
        name: 'SilverBullet MCP',
        version: '0.1.0',
    });
    configureMcpServerInstance(server);

    // When the transport closes (client disconnect / DELETE), tear down the
    // whole session: close the per-session McpServer and drop the map entry.
    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions[sid]) {
            delete sessions[sid];
        }
        // Closing the per-session server releases its request handlers / state.
        // This is safe because each session owns its own McpServer instance.
        server.close().catch((err) =>
            console.error('[server] Error closing McpServer for session', sid, err)
        );
    };

    return { transport, server };
}

// Default route - no authentication required
app.get('/', (req, res) => {
    res.json({
        service: 'SilverBullet MCP Server',
        version: '0.1.0',
        status: 'running',
        authentication: 'required for /mcp routes',
        timestamp: new Date().toISOString(),
    });
});

// Apply auth middleware to all /mcp routes only
app.use('/mcp', mcpAuthMiddleware);

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;
    let server: McpServer;

    if (sessionId && sessions[sessionId]) {
        // Reuse an existing, valid session.
        transport = sessions[sessionId].transport;
        server = sessions[sessionId].server;
    } else if (!sessionId && isInitializeRequest(req.body)) {
        // Fresh initialize request with no session id — start a new session.
        const session = createSession();
        transport = session.transport;
        server = session.server;
        // Connect the transport to its McpServer BEFORE handling the request so
        // that responses can flow back through the same transport. The
        // initialize request is processed by handleRequest below, which assigns
        // the session id and fires onsessioninitialized (registering the
        // session in the map).
        await server.connect(transport);
    } else {
        // A non-initialize request arrived without a valid session id. This is
        // a client whose session was lost (SSE drop, restart, stale/missing
        // session-id header). The transport cannot process a non-initialize
        // request before it has been initialized, so instead of silently
        // creating a session that would never be registered (and would leak),
        // we ask the client to re-initialize. This is the resilient path: the
        // client simply sends a fresh initialize and continues — it never gets
        // stuck, and no resources leak.
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session. Re-initialize and retry.',
            },
            id: req.body?.id ?? null,
        });
        return;
    }

    try {
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error(`[POST /mcp] Error handling MCP request:`, error);
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
const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const transport = sessions[sessionId].transport;
    try {
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error(`[handleSessionRequest] Error handling session event:`, error);
        if (!res.headersSent) {
            res.status(500).send('Internal server error during session event handling.');
        } else {
            res.end();
        }
    }
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', (req, res) => {
    handleSessionRequest(req, res);

    // Send periodic SSE comment heartbeats to keep the connection alive.
    // Lines starting with ':' are SSE comments — ignored by clients but
    // prevent idle-timeout disconnects from proxies and HTTP clients.
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
            res.write(': heartbeat\n\n');
        } else {
            clearInterval(heartbeat);
        }
    }, 30_000);
    res.on('close', () => clearInterval(heartbeat));
    res.on('error', () => clearInterval(heartbeat));
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID for DELETE');
        return;
    }

    const session = sessions[sessionId];
    const transport = session.transport;

    try {
        // handleDeleteRequest validates the session, then calls transport.close()
        // internally. transport.close() fires our onclose handler, which closes
        // the per-session McpServer and deletes the session from the map — so
        // cleanup is handled there and must not be duplicated here.
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error(`[DELETE /mcp] Error during DELETE handling:`, error);
        if (!res.headersSent) {
            res.status(500).send('Internal server error during session termination.');
        }
        // Defensive cleanup if handleRequest threw before closing the transport.
        if (sessions[sessionId]) {
            session.server.close().catch((err) =>
                console.error('[DELETE /mcp] Error closing McpServer for session', sessionId, err)
            );
            transport.close();
            delete sessions[sessionId];
        }
    }
});

// Validate configuration and start server
validateConfiguration();
logConfiguration();

app.listen(PORT, () => {
    logStartupSuccess();
});
