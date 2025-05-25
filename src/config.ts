// Configuration constants

export const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
export const SB_API_BASE_URL = process.env.SB_API_BASE_URL || 'http://silverbullet:3000';
export const SB_AUTH_TOKEN = process.env.SB_AUTH_TOKEN;
export const MCP_TOKEN = process.env.MCP_TOKEN;

export const validateConfiguration = (): void => {
    if (!MCP_TOKEN) {
        console.error(`[STARTUP] ❌ CRITICAL ERROR: MCP_TOKEN environment variable is required for security`);
        console.error(`[STARTUP] ❌ Please set MCP_TOKEN environment variable and restart`);
        process.exit(1);
    }
};

export const logConfiguration = (): void => {
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
};

export const logStartupSuccess = (): void => {
    console.log(`[STARTUP] ilverBullet MCP server (Express Stateful) listening on port ${PORT}`);
    console.log(`[STARTUP] SilverBullet API base URL: ${SB_API_BASE_URL}`);
    console.log(`[STARTUP] MCP Authentication: ENABLED (MANDATORY)`);
    console.log(`[STARTUP] SilverBullet Authentication: ${SB_AUTH_TOKEN ? 'enabled' : 'disabled (SB_AUTH_TOKEN not set)'}`);
    console.log(`[STARTUP] Security: All requests require valid MCP_TOKEN`);
    console.log(`[STARTUP] Server ready to accept authenticated connections!`);
    console.log(`[STARTUP] ===============================================`);
};