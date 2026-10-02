#!/usr/bin/env node
// Stdio MCP entrypoint for local, single-client use. No HTTP listener or MCP auth:
// the spawning client is the only caller. Requires SB_AUTH_TOKEN for SilverBullet.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configureMcpServerInstance } from './mcp-server.js';

const { version } = require('../package.json') as { version: string };
const server = new McpServer({ name: 'SilverBullet MCP', version });
configureMcpServerInstance(server);

const transport = new StdioServerTransport();
server.connect(transport).catch(error => {
    console.error('[stdio] Failed to start:', error);
    process.exit(1);
});
