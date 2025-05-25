// Express middleware functions

import { Request, Response, NextFunction } from 'express';
import { MCP_TOKEN } from './config.js';

// Mandatory API key check for MCP requests
export const mcpAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!MCP_TOKEN) {
        console.error(`[Auth] CRITICAL: MCP_TOKEN not set`);
        return res.status(500).json({
            error: 'Server misconfiguration: Authentication token not configured',
        });
    }

    // Check for token in Authorization header (Bearer token)
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader?.startsWith('Bearer ')
        ? authHeader.substring(7)
        : null;

    // Check for token in query parameter
    const queryToken = req.query.token as string;

    // Check for token in request body
    const bodyToken = req.body?.token as string;

    const providedToken = headerToken || queryToken || bodyToken;

    if (!providedToken || providedToken !== MCP_TOKEN) {
        console.log(`[Auth] Authentication failed for ${req.method} ${req.path}`);
        return res.status(401).json({
            error: 'Unauthorized - Invalid or missing authentication token',
            hint: 'Provide token via Authorization header (Bearer <token>), query parameter (?token=<token>), or request body ({"token": "<token>"})',
        });
    }

    next();
};

export const logRequestDetails = (req: Request, context: string) => {
    // Only log basic info for debugging when needed
    if (process.env.DEBUG_REQUESTS === 'true') {
        try {
            const requestDetails = {
                method: req.method,
                url: req.url,
                ip: req.ip,
                userAgent: req.get('User-Agent'),
                timestamp: new Date().toISOString(),
            };
            console.log(`[${context}] Request:`, JSON.stringify(requestDetails));
        } catch (error) {
            console.log(`[${context}] ${req.method} ${req.url} from ${req.ip}`);
        }
    }
};