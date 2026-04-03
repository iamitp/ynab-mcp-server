#!/usr/bin/env node
/**
 * YNAB MCP Server — stdio entry point
 *
 * Used by Claude Code CLI via ~/.mcp.json.
 * For claude.ai / Claude for Work, run http-server.ts instead.
 *
 * Required env vars:
 *   YNAB_TOKEN     — Personal Access Token from YNAB developer settings
 *   YNAB_BUDGET_ID — Budget UUID (or "last-used")
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createYnabServer } from "./server-factory.js";

async function main() {
  const token = process.env.YNAB_TOKEN;
  if (!token) {
    console.error("ERROR: YNAB_TOKEN environment variable is not set");
    process.exit(1);
  }

  const server = createYnabServer(token);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ynab-mcp] server running via stdio");
}

main().catch((err) => {
  console.error("[ynab-mcp] Fatal error:", err);
  process.exit(1);
});
