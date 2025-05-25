// Main Express server for SilverBullet MCP

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { PORT, validateConfiguration, logConfiguration, logStartupSuccess } from './config.js';
import { mcpAuthMiddleware } from './middleware.js';
import { configureMcpServerInstance } from './mcp-server.js';

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
// Map to store MCP server instances by session ID
const mcpServers: { [sessionId: string]: McpServer } = {};

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
    let mcpServer: McpServer;

    if (sessionId && transports[sessionId] && mcpServers[sessionId]) {
        transport = transports[sessionId];
        mcpServer = mcpServers[sessionId];
    } else {
        // Create new session
        const newSessionId = randomUUID();

        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (sId) => {
                transports[sId] = transport;
                mcpServers[sId] = mcpServer;
            },
        });

        mcpServer = new McpServer({
            name: 'SilverBullet MCP',
            version: '0.1.0',
        });
        configureMcpServerInstance(mcpServer);

        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
                delete mcpServers[transport.sessionId];
                mcpServer.close();
            }
        };

        await mcpServer.connect(transport);
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

    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const transport = transports[sessionId];
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
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID for DELETE');
        return;
    }

    const transport = transports[sessionId];
    const mcpServer = mcpServers[sessionId];

    try {
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error(`[DELETE /mcp] Error during DELETE handling:`, error);
        if (!res.headersSent) {
            res.status(500).send('Internal server error during session termination.');
        }
    } finally {
        if (mcpServer) {
            mcpServer.close();
        }
        if (transport) {
            transport.close();
        }
        if (sessionId) {
            delete transports[sessionId];
            delete mcpServers[sessionId];
        }
        if (!res.headersSent) {
            res.status(204).send();
        } else if (!res.writableEnded) {
            res.end();
        }
    }
});

// Validate configuration and start server
validateConfiguration();
logConfiguration();

app.listen(PORT, () => {
    logStartupSuccess();
});
