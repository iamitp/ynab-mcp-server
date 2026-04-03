/**
 * In-memory OAuth state store.
 *
 * Holds registered clients, pending authorizations, issued auth codes,
 * and active sessions. Everything is lost on server restart — users
 * simply re-authenticate (acceptable for MVP).
 */

import crypto from "crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function generateId(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pending authorization request: exists between GET /authorize and GET /oauth/callback */
export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;   // S256 challenge from Claude.ai — verified at /token time
  state?: string;          // Claude.ai's state — must be echoed back unchanged
  expiresAt: number;       // unix ms
}

/** Short-lived code: exists between GET /oauth/callback and POST /token */
export interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;   // copied from PendingAuth so SDK can verify PKCE
  ynabCode: string;        // code received from YNAB — exchanged at /token time
  expiresAt: number;       // unix ms
}

/** Long-lived session: exists after POST /token succeeds */
export interface Session {
  ynabAccessToken: string;
  ynabRefreshToken: string;
  ynabExpiresAt: number;   // unix SECONDS (from YNAB expires_in)
  scopes: string[];
  clientId: string;
  tokenExpiresAt: number;  // unix SECONDS — our token's expiry shown to Claude.ai
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const clients  = new Map<string, OAuthClientInformationFull>();
const pending  = new Map<string, PendingAuth>();   // keyed on ynabState
const codes    = new Map<string, AuthCode>();       // keyed on our opaque code
const sessions = new Map<string, Session>();        // keyed on our opaque token

// ---------------------------------------------------------------------------
// Client store
// ---------------------------------------------------------------------------

export function getClient(clientId: string): OAuthClientInformationFull | undefined {
  return clients.get(clientId);
}

/**
 * The SDK already assigns client_id and client_id_issued_at before calling this.
 * We just persist and return the object as-is.
 */
export function registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
  clients.set(client.client_id, client);
  return client;
}

// ---------------------------------------------------------------------------
// Pending auth (between /authorize and /callback)
// ---------------------------------------------------------------------------

export function savePendingAuth(ynabState: string, auth: Omit<PendingAuth, "expiresAt">): void {
  pending.set(ynabState, { ...auth, expiresAt: Date.now() + 10 * 60 * 1000 });
}

export function consumePendingAuth(ynabState: string): PendingAuth | undefined {
  const auth = pending.get(ynabState);
  if (auth) pending.delete(ynabState);
  return auth;
}

// ---------------------------------------------------------------------------
// Auth codes (between /callback and /token)
// ---------------------------------------------------------------------------

export function saveAuthCode(code: string, data: Omit<AuthCode, "expiresAt">): void {
  codes.set(code, { ...data, expiresAt: Date.now() + 5 * 60 * 1000 });
}

/** Peek without deleting — used by challengeForAuthorizationCode */
export function getAuthCode(code: string): AuthCode | undefined {
  const data = codes.get(code);
  if (data && data.expiresAt < Date.now()) {
    codes.delete(code);
    return undefined;
  }
  return data;
}

/** Read and delete — used by exchangeAuthorizationCode */
export function consumeAuthCode(code: string): AuthCode | undefined {
  const data = codes.get(code);
  if (data) codes.delete(code);
  return data;
}

// ---------------------------------------------------------------------------
// Sessions (after token exchange)
// ---------------------------------------------------------------------------

export function createSession(token: string, session: Session): void {
  sessions.set(token, session);
}

export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function updateSession(token: string, updates: Partial<Session>): void {
  const existing = sessions.get(token);
  if (existing) sessions.set(token, { ...existing, ...updates });
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

// ---------------------------------------------------------------------------
// Background cleanup — runs every 5 minutes
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, v] of codes)   if (v.expiresAt < now) codes.delete(k);
  // Sessions expire via tokenExpiresAt checked in verifyAccessToken — no cleanup needed here
}, 5 * 60 * 1000).unref(); // unref so this timer doesn't keep the process alive
