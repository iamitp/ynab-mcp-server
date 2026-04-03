/**
 * YNAB MCP Server — shared factory
 *
 * Call createYnabServer() to get a fully-configured McpServer with all tools
 * registered. The caller decides which transport to connect it to (stdio or HTTP).
 *
 * Required env vars:
 *   YNAB_TOKEN     — Personal Access Token from YNAB developer settings
 *   YNAB_BUDGET_ID — Budget UUID (or "last-used")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import axios, { AxiosError } from "axios";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config & constants
// ---------------------------------------------------------------------------

const YNAB_API = "https://api.youneedabudget.com/v1";
const CHARACTER_LIMIT = 30_000;

// ---------------------------------------------------------------------------
// YNAB API client — token passed per-server-instance, not read from env
// ---------------------------------------------------------------------------

function makeYnabClient(token: string, budgetId: string) {
  async function ynabGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const response = await axios.get<{ data: T }>(`${YNAB_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      params,
      timeout: 15_000,
    });
    return response.data.data;
  }

  async function ynabPost<T>(path: string, body: unknown): Promise<T> {
    const response = await axios.post<{ data: T }>(`${YNAB_API}${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 15_000,
    });
    return response.data.data;
  }

  function getBudgetId(): string {
    return budgetId;
  }

  return { ynabGet, ynabPost, getBudgetId };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatINR(milliunits: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(milliunits / 1000);
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Response truncated at ${CHARACTER_LIMIT} chars. Use filters/pagination to narrow results.]`
  );
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const detail = (error.response.data as { error?: { detail?: string } })?.error?.detail ?? "";
      switch (status) {
        case 401: return "Error: Invalid YNAB token. Check the YNAB_TOKEN env var.";
        case 403: return "Error: Access forbidden. You may not have permission for this budget.";
        case 404: return `Error: Not found (${detail || "check your IDs"}).`;
        case 429: return "Error: YNAB rate limit reached (200 req/hr). Try again later.";
        default:  return `Error: YNAB API error ${status}: ${detail}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. YNAB API may be slow — try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

// ---------------------------------------------------------------------------
// Shared Zod fragments
// ---------------------------------------------------------------------------

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable, 'json' for programmatic use");

const paginationFields = {
  limit: z.number().int().min(1).max(500).default(50).describe("Max results to return"),
  offset: z.number().int().min(0).default(0).describe("Number of results to skip (pagination)"),
};

// ---------------------------------------------------------------------------
// TypeScript interfaces for YNAB API responses
// ---------------------------------------------------------------------------

interface YnabAccount {
  id: string; name: string; type: string; on_budget: boolean; closed: boolean;
  balance: number; cleared_balance: number; uncleared_balance: number;
  transfer_payee_id: string | null; deleted: boolean;
}

interface YnabTransaction {
  id: string; date: string; amount: number; memo: string | null; cleared: string;
  approved: boolean; payee_name: string | null; payee_id: string | null;
  category_name: string | null; category_id: string | null; account_name: string | null;
  account_id: string; deleted: boolean; transfer_account_id: string | null;
}

interface YnabScheduledTransaction {
  id: string; date_first: string; date_next: string; frequency: string;
  amount: number; memo: string | null; payee_name: string | null; payee_id: string | null;
  category_name: string | null; category_id: string | null;
  account_name: string | null; account_id: string; deleted: boolean;
}

interface YnabCategoryGroup {
  id: string; name: string; hidden: boolean; deleted: boolean; categories: YnabCategory[];
}

interface YnabCategory {
  id: string; name: string; hidden: boolean; deleted: boolean;
  budgeted: number; activity: number; balance: number;
  category_group_id: string; category_group_name?: string;
  goal_type: string | null; goal_target: number | null;
}

interface YnabMonth {
  month: string; income: number; budgeted: number; activity: number;
  to_be_budgeted: number; age_of_money: number | null; note: string | null;
  categories: YnabCategory[];
}

interface YnabBudgetSummary {
  id: string; name: string; first_month: string; last_modified_on: string;
  currency_format?: { iso_code: string; currency_symbol: string };
  date_format?: { format: string };
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function accountToJson(a: YnabAccount) {
  return {
    id: a.id, name: a.name, type: a.type, on_budget: a.on_budget, closed: a.closed,
    balance_inr: formatINR(a.balance), balance_milliunits: a.balance,
    cleared_balance_inr: formatINR(a.cleared_balance),
    uncleared_balance_inr: formatINR(a.uncleared_balance),
  };
}

function txToJson(t: YnabTransaction) {
  return {
    id: t.id, date: t.date, amount_inr: formatINR(t.amount), amount_milliunits: t.amount,
    payee: t.payee_name ?? null, category: t.category_name ?? null,
    category_id: t.category_id, account: t.account_name ?? t.account_id,
    account_id: t.account_id, memo: t.memo, cleared: t.cleared,
  };
}

function scheduledTxToJson(t: YnabScheduledTransaction) {
  return {
    id: t.id, payee: t.payee_name ?? null, amount_inr: formatINR(t.amount),
    amount_milliunits: t.amount, frequency: t.frequency, date_next: t.date_next,
    date_first: t.date_first, category: t.category_name ?? null,
    category_id: t.category_id, account: t.account_name ?? t.account_id,
    account_id: t.account_id, memo: t.memo,
  };
}

function categoryToJson(c: YnabCategory) {
  return {
    id: c.id, name: c.name,
    budgeted_inr: formatINR(c.budgeted), activity_inr: formatINR(c.activity),
    available_inr: formatINR(c.balance), budgeted_milliunits: c.budgeted,
    activity_milliunits: c.activity, balance_milliunits: c.balance, goal_type: c.goal_type,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createYnabServer(
  ynabToken: string,
  budgetId: string = process.env.YNAB_BUDGET_ID ?? "last-used",
): McpServer {
  const { ynabGet, ynabPost, getBudgetId } = makeYnabClient(ynabToken, budgetId);
  const server = new McpServer({ name: "ynab-mcp-server", version: "1.0.0" });

  // ============================================================
  // Tool: ynab_list_accounts
  // ============================================================
  server.registerTool(
    "ynab_list_accounts",
    {
      title: "List YNAB Accounts",
      description: `List all accounts in the YNAB budget with current balances.

Returns every account (checking, savings, credit cards, loans, cash) along with
cleared balance, uncleared balance, and whether the account is on-budget.

Examples:
  - "What's my current account balance?" → ynab_list_accounts
  - "Show all my credit card accounts" → ynab_list_accounts, filter by type
  - "What's the total across all my accounts?" → ynab_list_accounts, sum balances`,
      inputSchema: z.object({ response_format: responseFormatField }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      try {
        const budgetId = getBudgetId();
        const data = await ynabGet<{ accounts: YnabAccount[] }>(`/budgets/${budgetId}/accounts`);
        const accounts = data.accounts.filter((a) => !a.deleted);

        if (accounts.length === 0) {
          return { content: [{ type: "text", text: "No accounts found in this budget." }] };
        }

        if (response_format === ResponseFormat.JSON) {
          const output = accounts.map(accountToJson);
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: { accounts: output } };
        }

        const onBudget  = accounts.filter((a) => a.on_budget && !a.closed);
        const offBudget = accounts.filter((a) => !a.on_budget && !a.closed);
        const closed    = accounts.filter((a) => a.closed);

        const lines = ["# YNAB Accounts", "", `**Budget ID**: ${budgetId}`, ""];

        const renderGroup = (label: string, items: YnabAccount[]) => {
          if (!items.length) return;
          lines.push(`## ${label}`, "");
          for (const a of items) {
            const uncleared = a.uncleared_balance !== 0 ? ` (${formatINR(a.uncleared_balance)} uncleared)` : "";
            lines.push(`### ${a.name}`, `- **Type**: ${a.type}`, `- **Balance**: ${formatINR(a.balance)}${uncleared}`, `- **ID**: \`${a.id}\``, "");
          }
        };

        renderGroup("On-Budget Accounts", onBudget);
        renderGroup("Off-Budget / Tracking Accounts", offBudget);
        if (closed.length > 0) renderGroup("Closed Accounts", closed);

        const totalOnBudget = onBudget.reduce((s, a) => s + a.balance, 0);
        lines.push(`---`, `**Total on-budget balance: ${formatINR(totalOnBudget)}**`);

        return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_list_transactions
  // ============================================================
  server.registerTool(
    "ynab_list_transactions",
    {
      title: "List / Search YNAB Transactions",
      description: `Retrieve transactions from the YNAB budget with optional filters.

Can filter by date range, account, or search keyword. Returns payee, category,
amount, memo, date, and cleared status.

Args:
  - since_date: Only return transactions on or after this date (YYYY-MM-DD). Default: first of current month.
  - until_date: Only return transactions on or before this date (YYYY-MM-DD). Optional.
  - account_id: Filter to a specific account ID (from ynab_list_accounts). Optional.
  - search: Case-insensitive keyword to filter by payee name or memo. Optional.
  - limit: Max results (default 50, max 500).
  - offset: Pagination offset.

Examples:
  - "Show this month's transactions" → ynab_list_transactions default
  - "What did I spend at Zomato?" → search="zomato"
  - "Show last month's ICICI card spend" → since_date="2026-03-01", until_date="2026-03-31", account_id=<icici id>`,
      inputSchema: z.object({
        since_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().describe("Start date YYYY-MM-DD (default: 1st of current month)"),
        until_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().describe("End date YYYY-MM-DD"),
        account_id: z.string().optional().describe("YNAB account UUID to filter by"),
        search: z.string().max(200).optional().describe("Keyword to search in payee name or memo"),
        ...paginationFields,
        response_format: responseFormatField,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ since_date, until_date, account_id, search, limit, offset, response_format }) => {
      try {
        const budgetId = getBudgetId();
        const today = new Date();
        const defaultSince = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
        const sinceDate = since_date ?? defaultSince;

        const path = account_id
          ? `/budgets/${budgetId}/accounts/${account_id}/transactions`
          : `/budgets/${budgetId}/transactions`;

        const data = await ynabGet<{ transactions: YnabTransaction[] }>(path, { since_date: sinceDate });
        let txs = data.transactions.filter((t) => !t.deleted);

        if (until_date) txs = txs.filter((t) => t.date <= until_date);
        if (search) {
          const q = search.toLowerCase();
          txs = txs.filter((t) =>
            t.payee_name?.toLowerCase().includes(q) ||
            t.memo?.toLowerCase().includes(q) ||
            t.category_name?.toLowerCase().includes(q)
          );
        }

        txs.sort((a, b) => (a.date < b.date ? 1 : -1));
        const total = txs.length;
        const paginated = txs.slice(offset, offset + limit);

        if (paginated.length === 0) {
          return { content: [{ type: "text", text: `No transactions found${search ? ` matching "${search}"` : ""} since ${sinceDate}.` }] };
        }

        const totalAmount = paginated.reduce((s, t) => s + t.amount, 0);

        if (response_format === ResponseFormat.JSON) {
          const output = {
            total, count: paginated.length, offset,
            has_more: total > offset + paginated.length,
            next_offset: total > offset + paginated.length ? offset + paginated.length : undefined,
            total_amount_inr: formatINR(totalAmount),
            transactions: paginated.map(txToJson),
          };
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
        }

        const lines = [
          `# Transactions${search ? ` matching "${search}"` : ""}`,
          `**Date range**: ${sinceDate}${until_date ? ` → ${until_date}` : " → today"}`,
          `**Showing**: ${paginated.length} of ${total} (offset ${offset})`,
          `**Net total**: ${formatINR(totalAmount)}`, "",
        ];

        for (const t of paginated) {
          const sign = t.amount >= 0 ? "+" : "";
          lines.push(
            `### ${t.date} · ${sign}${formatINR(t.amount)}`,
            `- **Payee**: ${t.payee_name ?? "(none)"}`,
            `- **Category**: ${t.category_name ?? "Uncategorized"}`,
            ...(t.memo ? [`- **Memo**: ${t.memo}`] : []),
            `- **Account**: ${t.account_name ?? t.account_id}`,
            `- **Status**: ${t.cleared}`,
            `- **ID**: \`${t.id}\``,
            ""
          );
        }

        if (total > offset + paginated.length) {
          lines.push(`*More results available — use offset=${offset + paginated.length} to see next page.*`);
        }

        return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_create_transaction
  // ============================================================
  server.registerTool(
    "ynab_create_transaction",
    {
      title: "Create YNAB Transaction",
      description: `Create a new transaction in YNAB.

The amount is in INR (not milliunits) — the server handles conversion.
Positive amount = inflow/income. Negative amount = outflow/expense.

Args:
  - account_id: YNAB account UUID (required — get from ynab_list_accounts)
  - date: Transaction date YYYY-MM-DD (default: today)
  - amount_inr: Amount in rupees. Positive = income, negative = expense.
  - payee_name: Merchant or payee name (max 200 chars)
  - memo: Optional note (max 200 chars)
  - category_id: Optional YNAB category UUID (get from ynab_list_categories)
  - cleared: 'cleared' | 'uncleared' | 'reconciled' (default: 'cleared')

Examples:
  - "Add Zomato order ₹450 today" → amount_inr=-450, payee_name="Zomato"
  - "Log salary credit ₹1,30,000" → amount_inr=130000, payee_name="Salary"`,
      inputSchema: z.object({
        account_id: z.string().min(1).describe("YNAB account UUID"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Transaction date YYYY-MM-DD (default: today)"),
        amount_inr: z.number().describe("Amount in INR. Negative = expense. Positive = income."),
        payee_name: z.string().min(1).max(200).describe("Payee or merchant name"),
        memo: z.string().max(200).optional().describe("Optional note"),
        category_id: z.string().optional().describe("YNAB category UUID (optional)"),
        cleared: z.enum(["cleared", "uncleared", "reconciled"]).default("cleared").describe("Cleared status"),
        approved: z.boolean().default(true).describe("Auto-approve the transaction"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ account_id, date, amount_inr, payee_name, memo, category_id, cleared, approved }) => {
      try {
        const budgetId = getBudgetId();
        const txDate = date ?? new Date().toISOString().slice(0, 10);
        const body = {
          transaction: {
            account_id, date: txDate, amount: Math.round(amount_inr * 1000),
            payee_name, memo: memo ?? null, category_id: category_id ?? null,
            cleared, approved,
          },
        };

        const result = await ynabPost<{ transaction: YnabTransaction }>(`/budgets/${budgetId}/transactions`, body);
        const tx = result.transaction;

        return {
          content: [{
            type: "text",
            text: [
              "✅ Transaction created successfully", "",
              `**ID**: \`${tx.id}\``, `**Date**: ${tx.date}`,
              `**Amount**: ${formatINR(tx.amount)}`, `**Payee**: ${tx.payee_name ?? "(none)"}`,
              `**Category**: ${tx.category_name ?? "Uncategorized"}`,
              `**Account**: ${tx.account_name ?? account_id}`,
              `**Memo**: ${tx.memo ?? "(none)"}`, `**Status**: ${tx.cleared}`,
            ].join("\n"),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_list_categories
  // ============================================================
  server.registerTool(
    "ynab_list_categories",
    {
      title: "List YNAB Budget Categories",
      description: `List all budget categories with budgeted, activity (spent), and available balance.

Returns categories grouped by their category group (e.g. "Needs", "Wants", "Savings").
Useful for finding category IDs to use with other tools.

Args:
  - month: Budget month YYYY-MM-DD (first of month, e.g. "2026-04-01"). Default: current month.

Examples:
  - "How much have I budgeted for groceries?" → ynab_list_categories
  - "What categories are over budget this month?" → look for negative available
  - "Find the ID for my EMI category" → ynab_list_categories, search for "EMI"`,
      inputSchema: z.object({
        month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Budget month YYYY-MM-DD (default: current month)"),
        response_format: responseFormatField,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ month, response_format }) => {
      try {
        const budgetId = getBudgetId();
        const today = new Date();
        const targetMonth = month ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;

        const data = await ynabGet<{ category_groups: YnabCategoryGroup[] }>(
          `/budgets/${budgetId}/months/${targetMonth}/categories`
        );

        const groups = data.category_groups.filter(
          (g) => !g.deleted && !g.hidden && g.name !== "Internal Master Category" && g.name !== "Credit Card Payments"
        );

        if (response_format === ResponseFormat.JSON) {
          const output = groups.map((g) => ({
            group: g.name,
            categories: g.categories.filter((c) => !c.deleted && !c.hidden).map(categoryToJson),
          }));
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: { month: targetMonth, groups: output } };
        }

        const lines = [`# Budget Categories — ${targetMonth}`, ""];
        for (const group of groups) {
          const cats = group.categories.filter((c) => !c.deleted && !c.hidden);
          if (!cats.length) continue;
          lines.push(`## ${group.name}`, "");
          for (const c of cats) {
            const flag = c.balance < 0 ? " ⚠️ OVER" : "";
            lines.push(`### ${c.name}${flag}`, `- **Budgeted**: ${formatINR(c.budgeted)}`, `- **Spent**: ${formatINR(c.activity)}`, `- **Available**: ${formatINR(c.balance)}`, `- **ID**: \`${c.id}\``, "");
          }
        }

        return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_list_scheduled_transactions
  // ============================================================
  server.registerTool(
    "ynab_list_scheduled_transactions",
    {
      title: "List YNAB Scheduled Transactions",
      description: `List all scheduled / recurring transactions in YNAB.

Shows next occurrence date, frequency (monthly, weekly, etc.), payee, category, and amount.

Examples:
  - "What recurring payments do I have coming up?" → ynab_list_scheduled_transactions
  - "When is my home loan EMI due?" → ynab_list_scheduled_transactions, find "Home"
  - "Show all monthly subscriptions" → ynab_list_scheduled_transactions, filter frequency=monthly`,
      inputSchema: z.object({ response_format: responseFormatField }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      try {
        const budgetId = getBudgetId();
        const data = await ynabGet<{ scheduled_transactions: YnabScheduledTransaction[] }>(
          `/budgets/${budgetId}/scheduled_transactions`
        );
        const txs = data.scheduled_transactions.filter((t) => !t.deleted);
        txs.sort((a, b) => (a.date_next > b.date_next ? 1 : -1));

        if (txs.length === 0) return { content: [{ type: "text", text: "No scheduled transactions found." }] };

        if (response_format === ResponseFormat.JSON) {
          const output = txs.map(scheduledTxToJson);
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: { scheduled_transactions: output } };
        }

        const lines = ["# Scheduled Transactions", ""];
        const expenses = txs.filter((t) => t.amount < 0);
        const income   = txs.filter((t) => t.amount >= 0);

        const renderGroup = (label: string, items: YnabScheduledTransaction[]) => {
          if (!items.length) return;
          lines.push(`## ${label}`, "");
          for (const t of items) {
            lines.push(
              `### ${t.payee_name ?? "(no payee)"}`,
              `- **Amount**: ${formatINR(t.amount)}`,
              `- **Next date**: ${t.date_next}`,
              `- **Frequency**: ${t.frequency}`,
              `- **Account**: ${t.account_name ?? t.account_id}`,
              `- **Category**: ${t.category_name ?? "Uncategorized"}`,
              ...(t.memo ? [`- **Memo**: ${t.memo}`] : []),
              `- **ID**: \`${t.id}\``,
              ""
            );
          }
        };

        renderGroup("Income", income);
        renderGroup("Expenses", expenses);

        const monthlyExpenses = expenses.filter((t) => t.frequency === "monthly").reduce((s, t) => s + t.amount, 0);
        lines.push(`---`, `**Monthly recurring expenses: ${formatINR(monthlyExpenses)}**`);

        return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_get_month_summary
  // ============================================================
  server.registerTool(
    "ynab_get_month_summary",
    {
      title: "Get YNAB Monthly Budget Summary",
      description: `Get a summary of income, spending, and savings for a specific budget month.

Returns the month's total income, total budgeted amount, total activity (actual spending),
to-be-budgeted amount, and age-of-money.

Args:
  - month: Budget month YYYY-MM-DD (first of month). Default: current month.

Examples:
  - "How much did I spend in March 2026?" → month="2026-03-01"
  - "What's my age of money?" → ynab_get_month_summary
  - "Am I over budget this month?" → compare budgeted vs activity`,
      inputSchema: z.object({
        month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Budget month YYYY-MM-DD (default: current month)"),
        response_format: responseFormatField,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ month, response_format }) => {
      try {
        const budgetId = getBudgetId();
        const today = new Date();
        const targetMonth = month ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
        const data = await ynabGet<{ month: YnabMonth }>(`/budgets/${budgetId}/months/${targetMonth}`);
        const m = data.month;

        if (response_format === ResponseFormat.JSON) {
          const output = {
            month: m.month, income: m.income, income_inr: formatINR(m.income),
            budgeted: m.budgeted, budgeted_inr: formatINR(m.budgeted),
            activity: m.activity, activity_inr: formatINR(m.activity),
            to_be_budgeted: m.to_be_budgeted, to_be_budgeted_inr: formatINR(m.to_be_budgeted),
            age_of_money: m.age_of_money, note: m.note,
          };
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
        }

        const net = m.income + m.activity;
        const lines = [
          `# Budget Summary — ${m.month}`, "",
          `| Metric | Amount |`, `|--------|--------|`,
          `| **Income** | ${formatINR(m.income)} |`,
          `| **Budgeted** | ${formatINR(m.budgeted)} |`,
          `| **Spent (activity)** | ${formatINR(m.activity)} |`,
          `| **To Be Budgeted** | ${formatINR(m.to_be_budgeted)} |`,
          `| **Net (income − spent)** | ${formatINR(net)} |`,
          `| **Age of Money** | ${m.age_of_money != null ? `${m.age_of_money} days` : "N/A"} |`,
        ];
        if (m.note) lines.push("", `**Note**: ${m.note}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_get_budget_settings
  // ============================================================
  server.registerTool(
    "ynab_get_budget_settings",
    {
      title: "Get YNAB Budget Info & Settings",
      description: `Get basic information about the YNAB budget: name, currency format, date format, and first month.

Useful for confirming which budget is active or discovering budget IDs.`,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const budgetId = getBudgetId();
        const data = await ynabGet<{ budget: YnabBudgetSummary }>(`/budgets/${budgetId}`);
        const b = data.budget;
        const lines = [
          `# YNAB Budget`, "",
          `- **Name**: ${b.name}`, `- **ID**: \`${b.id}\``,
          `- **Currency**: ${b.currency_format?.iso_code ?? "INR"} (${b.currency_format?.currency_symbol ?? "₹"})`,
          `- **Date format**: ${b.date_format?.format ?? "YYYY-MM-DD"}`,
          `- **First month**: ${b.first_month}`, `- **Last modified**: ${b.last_modified_on}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  // ============================================================
  // Tool: ynab_get_category_spending
  // ============================================================
  server.registerTool(
    "ynab_get_category_spending",
    {
      title: "Get Spending by Category (Multi-Month)",
      description: `Analyse spending in a specific category across multiple months.

Retrieves category activity (actual spending) for each month in the requested range,
useful for identifying spending trends, averages, and anomalies.

Args:
  - category_id: YNAB category UUID (get from ynab_list_categories).
  - months: Number of past months to analyse (default 6, max 24).

Examples:
  - "How much do I spend on dining out each month?" → find dining category ID, then this tool
  - "Show my grocery spending trend for 6 months" → category_id=<groceries>, months=6`,
      inputSchema: z.object({
        category_id: z.string().min(1).describe("YNAB category UUID"),
        months: z.number().int().min(1).max(24).default(6).describe("Number of past months to include"),
        response_format: responseFormatField,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ category_id, months, response_format }) => {
      try {
        const budgetId = getBudgetId();
        const results: Array<{ month: string; activity: number; budgeted: number; balance: number }> = [];
        const now = new Date();

        for (let i = 0; i < months; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
          try {
            const data = await ynabGet<{ category: YnabCategory }>(
              `/budgets/${budgetId}/months/${monthStr}/categories/${category_id}`
            );
            results.push({ month: monthStr, activity: data.category.activity, budgeted: data.category.budgeted, balance: data.category.balance });
          } catch { /* month may not exist yet */ }
        }

        results.sort((a, b) => (a.month < b.month ? -1 : 1));
        const totalActivity = results.reduce((s, r) => s + r.activity, 0);
        const avgActivity = results.length > 0 ? totalActivity / results.length : 0;

        if (response_format === ResponseFormat.JSON) {
          const output = { category_id, months: results, total_activity: totalActivity, average_monthly: avgActivity };
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
        }

        const lines = [
          `# Category Spending — Last ${months} Months`,
          `**Category ID**: \`${category_id}\``, "",
          `| Month | Budgeted | Spent | Available |`,
          `|-------|----------|-------|-----------|`,
          ...results.map((r) => `| ${r.month.slice(0, 7)} | ${formatINR(r.budgeted)} | ${formatINR(r.activity)} | ${formatINR(r.balance)} |`),
          "", `**Average monthly spend**: ${formatINR(Math.round(avgActivity))}`,
          `**Total over period**: ${formatINR(totalActivity)}`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
      }
    }
  );

  return server;
}
