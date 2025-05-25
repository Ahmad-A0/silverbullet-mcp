# SilverBullet MCP Server

This project provides a Model Context Protocol (MCP) server that acts as a bridge to your [SilverBullet](https://silverbullet.md) instance. It enables Large Language Models (LLMs) and other MCP-compatible clients to interact with your SilverBullet notes and data by exposing them through standardized MCP `tools` and `resources`.

The server is designed to be run via Docker Compose alongside your existing SilverBullet Docker container. It handles authentication and provides a secure way for external applications to access and manipulate your SilverBullet space.

## Project Structure

```
.
├── .env.example             # Example environment variables
├── .gitignore               # Files and directories to ignore in git
├── docker-compose.yml       # Docker Compose configuration for running the services
├── Dockerfile               # Dockerfile for building the MCP server image
├── package-lock.json        # Exact versions of dependencies
├── package.json             # Project metadata and dependencies
├── tsconfig.json            # TypeScript compiler options
├── src/                     # Source code directory
│   ├── cache.ts             # Caching mechanisms (if any)
│   ├── config.ts            # Configuration loading
│   ├── mcp-server.ts        # MCP server logic implementation
│   ├── middleware.ts        # Express middleware
│   ├── server.ts            # Express server setup and main application entry point
│   ├── silverbullet-api.ts  # Client for interacting with SilverBullet API
│   └── types.ts             # TypeScript type definitions
└── README.md                # This file
```

## Prerequisites

*   Docker
*   Docker Compose

## Getting Started

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <repository-name>
    ```

2.  **Create an environment file:**
    Copy the contents of `.env.example` to a new file named `.env`.
    ```bash
    cp .env.example .env
    ```
    Update the `.env` file with your specific values:
    *   `SB_AUTH_TOKEN`: A secure token for SilverBullet to authenticate with this MCP server and for this MCP server to authenticate with SilverBullet.
    *   `MCP_TOKEN`: A secure token for clients (e.g., your AI model) to authenticate with this MCP server.
    *   `SB_API_BASE_URL`: (Optional if running via docker-compose as defined) The base URL for the SilverBullet API. Defaults to `http://silverbullet:3000` in the `docker-compose.yml`.
    *   `PORT`: (Optional if running via docker-compose as defined) The port the MCP server will listen on. Defaults to `4000`.

3.  **Build and run the services using Docker Compose:**
    ```bash
    docker-compose up --build
    ```
    This command will:
    *   Build the Docker image for the `silverbullet-mcp-server` if it doesn't exist or if `Dockerfile` or related files have changed.
    *   Pull the latest `silverbulletmd/silverbullet` image.
    *   Start both the SilverBullet instance and the MCP server.

    The SilverBullet instance will be accessible at `http://localhost:3000`.
    The MCP server will be accessible at `http://localhost:4000`.

## Connecting to the MCP Server

This MCP server runs as part of a Docker Compose setup and will be accessible at `http://localhost:4000` by default.

You can connect to this server using an MCP client. The method of connection and authentication depends on the client's capabilities.

### Using `mcp-remote` (for stdio-only clients)

If your MCP client only supports `stdio` connections (e.g., older versions of Claude Desktop, Cursor, Windsurf), you can use `mcp-remote` to bridge the connection to this HTTP-based MCP server.

`mcp-remote` acts as a local stdio MCP server that proxies requests to a remote HTTP MCP server, handling authentication in the process.

**Client Configuration with Authentication:**

This MCP server requires token-based authentication. Configure your MCP client (e.g., in `claude_desktop_config.json`, `~/.cursor/mcp.json`, or `~/.codeium/windsurf/mcp_config.json`) to use `mcp-remote` and pass the `MCP_TOKEN` via a custom header:

```jsonc
{
  "mcpServers": {
    "silverbullet-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:4000/mcp", // URL of this MCP server
        "--header",
        "Authorization:Bearer ${MCP_SERVER_TOKEN}" // Note: no spaces around ':' for some clients
      ],
      "env": {
        "MCP_SERVER_TOKEN": "your_actual_mcp_token_from_dotenv" // The MCP_TOKEN set in your .env file
      }
    }
  }
}
```
**Important:**
* Replace `"your_actual_mcp_token_from_dotenv"` with the actual value of `MCP_TOKEN` you have set in your `.env` file for the `silverbullet-mcp-server`.
* Some clients (like Cursor and Claude Desktop on Windows) have issues with spaces in `args`. The example above (`Authorization:Bearer ${MCP_SERVER_TOKEN}`) avoids this.
* Ensure `npx` can find `mcp-remote`. You might need to add `-y` as the first argument to `args` (e.g., `["-y", "mcp-remote", ...]`) or install `mcp-remote` globally (`npm install -g mcp-remote`).

Refer to the [`mcp-remote` documentation](https://github.com/modelcontextprotocol/mcp-remote) for more advanced configurations, including OAuth support (not used by this server's default auth), different transport strategies, and troubleshooting.

### Direct Connection (for Streamable HTTP clients)

If your MCP client supports Streamable HTTP transport and can send custom headers, you can connect to it directly.

The server supports two methods for token-based authentication:

1.  **Authorization Header (Recommended)**:
    *   Header Name: `Authorization`
    *   Header Value: `Bearer YOUR_MCP_TOKEN`

2.  **Query Parameter**:
    *   Append `?token=YOUR_MCP_TOKEN` to the server URL.
    *   Example: `http://localhost:4000/mcp?token=YOUR_MCP_TOKEN`

Replace `YOUR_MCP_TOKEN` with the actual value of the `MCP_TOKEN` environment variable set in your `.env` file.

**Endpoint**: `http://localhost:4000/mcp` (or as configured by `PORT` if not using Docker Compose defaults).

Consult your MCP client's documentation on how to configure connections to remote HTTP MCP servers, including how to send custom headers or append query parameters.

## Development

To run the server locally for development without Docker:

1.  **Install dependencies:**
    ```bash
    npm install
    ```
2.  **Compile TypeScript:**
    ```bash
    npm run build
    ```
3.  **Set environment variables** (e.g., in your shell or using a tool like `dotenv` directly in the code if preferred for local dev):
    ```bash
    export SB_AUTH_TOKEN="your_sb_token"
    export MCP_TOKEN="your_mcp_token"
    export SB_API_BASE_URL="http://localhost:3000" # If running SilverBullet locally
    export PORT="4000"
    ```
4.  **Start the server:**
    ```bash
    npm start
    ```