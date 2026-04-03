#!/usr/bin/env node
/**
 * YNAB MCP Server — HTTP entry point with OAuth 2.0
 *
 * Exposes the YNAB MCP server over Streamable HTTP with full OAuth support
 * so it can be connected from claude.ai / Claude for Work.
 *
 * Each user authenticates with their own YNAB account via OAuth.
 * No shared credentials — fully multi-user.
 *
 * Required env vars:
 *   BASE_URL          — Public HTTPS URL (e.g. https://xxx.ngrok-free.app)
 *   YNAB_CLIENT_ID    — From app.youneedabudget.com/settings/developer
 *   YNAB_CLIENT_SECRET — From app.youneedabudget.com/settings/developer
 *   PORT              — Port to listen on (default: 3002)
 *
 * Optional:
 *   YNAB_BUDGET_ID    — Default budget (default: "last-used")
 */

import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { YnabOAuthProvider } from "./ynab-oauth-provider.js";
import { makeCallbackRouter } from "./oauth-callback.js";
import { getSession } from "./oauth-store.js";
import { createYnabServer } from "./server-factory.js";

// ---------------------------------------------------------------------------
// Validate required env vars on startup
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("ERROR: BASE_URL environment variable is required");
  process.exit(1);
}
if (!process.env.YNAB_CLIENT_ID || !process.env.YNAB_CLIENT_SECRET) {
  console.error("ERROR: YNAB_CLIENT_ID and YNAB_CLIENT_SECRET are required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app      = express();
const provider = new YnabOAuthProvider();

// 1. OAuth router — mounts /.well-known/oauth-authorization-server,
//    /register, /authorize, /token, /revoke
app.use(mcpAuthRouter({
  provider,
  issuerUrl:    new URL(BASE_URL),
  scopesSupported: ["default", "read-only"],
  resourceName: "YNAB MCP Server",
}));

// 2. YNAB OAuth callback (must be before body-parser for /mcp)
app.use(makeCallbackRouter());

// 3. Body parser for MCP endpoint
app.use(express.json());

// 4. Health check (unauthenticated)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ynab-mcp", timestamp: new Date().toISOString() });
});

// 5. Bearer auth middleware
const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${BASE_URL}/.well-known/oauth-protected-resource`,
});

// 6. Protected MCP endpoint
app.post("/mcp", bearerAuth, async (req, res) => {
  try {
    // Look up the YNAB token for this session
    const session = getSession(req.auth!.token);
    if (!session) {
      res.status(401).json({ error: "Session not found — please re-authenticate" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = createYnabServer(session.ynabAccessToken);

    res.on("close", () => {
      transport.close().catch(() => {/* ignore */});
      server.close().catch(() => {/* ignore */});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ynab-mcp-http] Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /mcp — not supported in stateless mode
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Use POST /mcp for MCP requests" });
});

// DELETE /mcp — no-op for stateless
app.delete("/mcp", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3002", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[ynab-mcp-http] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[ynab-mcp-http] OAuth discovery: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`[ynab-mcp-http] MCP endpoint:    POST ${BASE_URL}/mcp`);
  console.log(`[ynab-mcp-http] Health check:    GET  ${BASE_URL}/health`);
});
