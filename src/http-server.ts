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
import cors from "cors";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { YnabOAuthProvider } from "./ynab-oauth-provider.js";
import { makeCallbackRouter } from "./oauth-callback.js";
import { getSession } from "./oauth-store.js";
import { createYnabServer } from "./server-factory.js";

// ---------------------------------------------------------------------------
// Validate required env vars on startup
// ---------------------------------------------------------------------------

// Strip trailing slash so issuer URL never ends with "/" (prevents double-slash in well-known URLs)
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, "");
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
app.set("trust proxy", 1); // trust ngrok/reverse proxy X-Forwarded-For headers

// CORS — allow browser-based OAuth flows and MCP clients
app.use(cors({
  origin: true,          // reflect request origin (safe because auth is via Bearer token)
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "MCP-Session-Id"],
  exposedHeaders: ["MCP-Session-Id"],
  credentials: true,
}));

// Normalise double-slashes in paths (e.g. Smithery builds well-known URLs by concatenating
// issuer + "/.well-known/..." and our issuer ends with "/" producing "//.well-known/...")
app.use((req, _res, next) => {
  if (req.url.includes("//")) req.url = req.url.replace(/\/\/+/g, "/");
  next();
});

const provider = new YnabOAuthProvider();

// Rate limit config: suppress X-Forwarded-For validation (we handle trust proxy via app.set above)
const rlOpts = { validate: { xForwardedForHeader: false } };

// 1. OAuth router — mounts /.well-known/oauth-authorization-server,
//    /register, /authorize, /token, /revoke
app.use(mcpAuthRouter({
  provider,
  issuerUrl:         new URL(BASE_URL),
  resourceServerUrl: new URL(`${BASE_URL}/mcp`),
  scopesSupported:   ["default", "read-only"],
  resourceName:      "YNAB MCP Server",
  authorizationOptions:      { rateLimit: rlOpts },
  tokenOptions:              { rateLimit: rlOpts },
  clientRegistrationOptions: { rateLimit: rlOpts },
  revocationOptions:         { rateLimit: rlOpts },
}));

// 2. YNAB OAuth callback (must be before body-parser for /mcp)
app.use(makeCallbackRouter());

// 3. Body parser for MCP endpoint
app.use(express.json());

// 4. Health check (unauthenticated)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ynab-mcp", timestamp: new Date().toISOString() });
});

// 4a. Favicon — served so Google/Anthropic favicon lookup returns our logo
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="20" fill="#1F2D3D"/>
  <text x="50" y="58" font-family="Georgia, serif" font-size="52" font-weight="bold" text-anchor="middle" fill="#00DF8D">Y</text>
  <rect x="22" y="72" width="12" height="10" rx="2" fill="#00DF8D" opacity="0.5"/>
  <rect x="38" y="66" width="12" height="16" rx="2" fill="#00DF8D" opacity="0.7"/>
  <rect x="54" y="60" width="12" height="22" rx="2" fill="#00DF8D" opacity="0.9"/>
  <rect x="70" y="68" width="12" height="14" rx="2" fill="#00DF8D" opacity="0.6"/>
</svg>`;
app.get("/favicon.svg", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.send(FAVICON_SVG);
});
app.get("/favicon.ico", (_req, res) => res.redirect("/favicon.svg"));
app.get("/apple-touch-icon.png", (_req, res) => res.redirect("/favicon.svg"));

// 5. Bearer auth middleware — resourceMetadataUrl must match the /mcp path
const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${BASE_URL}/mcp`)),
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[ynab-mcp-http] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[ynab-mcp-http] OAuth discovery: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`[ynab-mcp-http] MCP endpoint:    POST ${BASE_URL}/mcp`);
  console.log(`[ynab-mcp-http] Health check:    GET  ${BASE_URL}/health`);
});
