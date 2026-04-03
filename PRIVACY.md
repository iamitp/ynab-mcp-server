# Privacy Policy

**YNAB MCP Server**
Last updated: April 2026

## Overview

YNAB MCP Server is an open-source Model Context Protocol (MCP) server that connects your YNAB budget to Claude AI. This policy explains how data is handled when you use this service.

## Data We Access

When you connect your YNAB account, the server accesses only the YNAB budget data you explicitly request through Claude — such as account balances, transactions, and budget categories. This data is fetched live from the YNAB API on demand and is never stored permanently.

## Data Storage

- **No personal data is written to disk.** OAuth tokens and session data are held in server memory only for the duration of your session.
- **Tokens are never logged.** Access tokens and session identifiers are not written to any log files.
- **Sessions expire.** Memory is cleared automatically when the server restarts or when your session expires (after 7 days of inactivity).

## Data Transmission

All communication between your browser, the MCP server, and the YNAB API is encrypted via HTTPS/TLS. No data is transmitted to any third party other than YNAB's official API (`api.youneedabudget.com`).

## Third-Party Services

- **YNAB** — Your budget data is fetched from and written to YNAB via their official API. YNAB's own privacy policy applies: https://www.youneedabudget.com/privacy-policy/
- **ngrok** — Used as an HTTPS tunnel. Network traffic passes through ngrok's infrastructure encrypted. ngrok's privacy policy: https://ngrok.com/privacy

## Authentication

Authentication is handled via OAuth 2.0. You sign in with your own YNAB credentials — your YNAB password is never seen or stored by this server. You can revoke access at any time from your YNAB account settings under **Authorized Applications**.

## Your Rights

Since no personal data is persisted, there is nothing to delete or export. You can disconnect the integration at any time by revoking access in YNAB and removing the connector from Claude.ai.

## Contact

For privacy questions, open an issue at: https://github.com/amitpatnaik/ynab-mcp-server/issues
