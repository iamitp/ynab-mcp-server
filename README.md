# YNAB MCP Server

[![SafeSkill 93/100](https://img.shields.io/badge/SafeSkill-93%2F100_Verified%20Safe-brightgreen)](https://safeskill.dev/scan/iamitp-ynab-mcp-server)

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

## License

MIT
