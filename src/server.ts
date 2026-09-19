// Stateful Streamable HTTP endpoint. Each session owns its protocol and transport.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { PORT, validateConfiguration, logConfiguration, logStartupSuccess } from './config.js';
import { mcpAuthMiddleware } from './middleware.js';
import { configureMcpServerInstance } from './mcp-server.js';

const { version } = require('../package.json') as { version: string };
const app = express();
app.use(express.json());
interface Session { transport: StreamableHTTPServerTransport; server: McpServer }
const sessions = new Map<string, Session>();

app.get('/', (_req, res) => {
    res.json({ service: 'SilverBullet MCP Server', version, status: 'running',
        authentication: 'required for /mcp routes', timestamp: new Date().toISOString() });
});
app.use('/mcp', mcpAuthMiddleware);

function sessionError(req: express.Request, res: express.Response, status: number): void {
    res.status(status).json({ jsonrpc: '2.0', id: req.body?.id ?? null,
        error: { code: -32000, message: status === 404
            ? 'Session not found. Initialize a new session without a session ID.'
            : 'Missing session ID. Initialize a session first.' } });
}

function createSession(): Session {
    const server = new McpServer({ name: 'SilverBullet MCP', version });
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { sessions.set(id, { server, transport }); },
    });
    configureMcpServerInstance(server);
    // Protocol owns transport.onclose. Its public hook runs after protocol cleanup.
    server.server.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    return { server, transport };
}

app.all('/mcp', async (req, res) => {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'POST, GET, DELETE');
        res.status(405).end();
        return;
    }
    const sessionId = req.get('mcp-session-id');
    let session = sessionId ? sessions.get(sessionId) : undefined;
    let fresh = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
        if (sessionId && !session) {
            sessionError(req, res, 404);
            return;
        }
        if (!session) {
            if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
                sessionError(req, res, 400);
                return;
            }
            session = createSession();
            fresh = true;
            await session.server.connect(session.transport);
        }
        if (req.method === 'GET') {
            heartbeat = setInterval(() => {
                if (!res.writableEnded && res.getHeader('content-type')?.toString().includes('text/event-stream')) {
                    res.write(': heartbeat\n\n');
                }
            }, 30_000);
            heartbeat.unref();
            const clearHeartbeat = () => clearInterval(heartbeat);
            res.once('close', clearHeartbeat);
            res.once('error', clearHeartbeat);
        }
        await session.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
    } catch (error) {
        console.error(`[${req.method} /mcp] Request failed:`, error);
        if (fresh && session) await session.server.close().catch(closeError => console.error('Session cleanup failed:', closeError));
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null,
                error: { code: -32603, message: 'Internal server error.' } });
        } else if (!res.writableEnded) res.end();
    } finally {
        // Invalid initialize requests must not leave a half-connected protocol behind.
        if (fresh && session && (!session.transport.sessionId || res.statusCode >= 400)) {
            await session.server.close().catch(closeError => console.error('Session cleanup failed:', closeError));
        }
        if (res.writableEnded) clearInterval(heartbeat);
    }
});

validateConfiguration();
logConfiguration();
const listener = app.listen(PORT, logStartupSuccess);

async function shutdown(): Promise<void> {
    listener.close();
    await Promise.allSettled([...sessions.values()].map(session => session.server.close()));
    listener.closeAllConnections();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
