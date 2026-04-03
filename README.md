# YNAB MCP Server

Connect your [YNAB](https://www.ynab.com) budget directly to Claude AI. Ask questions about your finances in natural language — balances, spending, categories, transactions, and more.

## What you can ask Claude

- *"What are my current account balances?"*
- *"How much did I spend on dining out this month?"*
- *"Show me my top 5 spending categories for March"*
- *"What recurring payments do I have coming up?"*
- *"Am I over budget anywhere this month?"*
- *"Add a ₹450 Zomato expense to my Food category"*

## Connect via Claude.ai

1. Go to **claude.ai → Settings → Connectors → Add custom connector**
2. Enter URL: `https://wriest-gerri-unaccrued.ngrok-free.dev/mcp`
3. Click **Add** and sign in with your YNAB account

## Available Tools

| Tool | Description |
|------|-------------|
| `ynab_list_accounts` | All accounts with current balances |
| `ynab_list_transactions` | Transactions with date/account/keyword filters |
| `ynab_create_transaction` | Add a new transaction |
| `ynab_list_categories` | Budget categories with budgeted/spent/available |
| `ynab_list_scheduled_transactions` | Upcoming recurring transactions |
| `ynab_get_month_summary` | Income, spending, age of money for any month |
| `ynab_get_budget_settings` | Budget name, currency, date format |
| `ynab_get_category_spending` | Multi-month spending trend for any category |

## Self-Hosting

Clone this repo, set up your own YNAB OAuth app, and host it yourself:

```bash
git clone https://github.com/amitpatnaik/ynab-mcp-server
cd ynab-mcp-server
npm install
```

Create a `.env.local` with:
```
BASE_URL=https://your-public-url.ngrok-free.dev
YNAB_CLIENT_ID=your_ynab_client_id
YNAB_CLIENT_SECRET=your_ynab_client_secret
PORT=3002
```

Build and run:
```bash
npm run build
npm run start:http
```

Expose publicly with ngrok:
```bash
ngrok http 3002 --domain=your-static-domain.ngrok-free.app
```

Then add your URL to claude.ai as a custom connector.

## Security

- Each user authenticates with **their own YNAB account** via OAuth 2.0
- No shared credentials — your budget data stays yours
- Tokens are stored in memory only and never persisted to disk
- YNAB tokens are automatically refreshed transparently

## Tech Stack

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [YNAB API v1](https://api.youneedabudget.com)
- TypeScript + Express
- OAuth 2.0 with PKCE

## Troubleshooting

**"Session not found — please re-authenticate"**
Your session expired (sessions last 7 days). Disconnect and reconnect the integration in Claude.ai Settings → Connectors.

**"Authorization Required" loop**
The YNAB OAuth app may be in Restricted Mode. Only the developer's YNAB account can authorize during this period. See [YNAB OAuth documentation](https://api.youneedabudget.com/#oauth-applications).

**Tools return no data / empty results**
Ensure your YNAB budget has data for the requested month. Default budget is "last-used" — if you have multiple budgets, confirm which is active via `ynab_get_budget_settings`.

**Server not reachable**
If self-hosting, verify your tunnel (ngrok) is running and the `BASE_URL` env var matches the public URL. Check `pm2 status` and `pm2 logs ynab-mcp-http`.

**OAuth callback fails**
Ensure the redirect URI registered in your YNAB OAuth app matches `{BASE_URL}/oauth/callback`.

For other issues, open a GitHub issue: https://github.com/amitpatnaik/ynab-mcp-server/issues

## Legal

- [Privacy Policy](PRIVACY.md)
- [Terms of Service](TERMS.md)

## License

MIT
