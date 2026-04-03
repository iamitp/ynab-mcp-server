/**
 * YNAB OAuth Provider
 *
 * Implements OAuthServerProvider from the MCP SDK.
 * Acts as an OAuth Authorization Server to Claude.ai while proxying
 * the actual user authentication to YNAB's OAuth server.
 *
 * Flow:
 *   Claude.ai  →  our /authorize  →  YNAB authorize  →  user logs in
 *   YNAB callback  →  our /oauth/callback  →  exchange code  →  session token
 *   Claude.ai sends Bearer token  →  we verify & proxy YNAB API calls
 */

import axios from "axios";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  generateId,
  getClient,
  registerClient,
  savePendingAuth,
  getAuthCode,
  consumeAuthCode,
  createSession,
  getSession,
  updateSession,
  deleteSession,
} from "./oauth-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YNAB_AUTH_URL   = "https://app.youneedabudget.com/oauth/authorize";
const YNAB_TOKEN_URL  = "https://api.youneedabudget.com/oauth/token";
const TOKEN_LIFETIME  = 7 * 24 * 60 * 60; // 7 days in seconds — our token lifetime

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// ---------------------------------------------------------------------------
// YNAB OAuth Provider
// ---------------------------------------------------------------------------

export class YnabOAuthProvider implements OAuthServerProvider {
  /**
   * We handle PKCE verification locally (the SDK will call challengeForAuthorizationCode
   * and verify the S256 hash before calling exchangeAuthorizationCode).
   * YNAB does not support PKCE on its own endpoints, so we must do it ourselves.
   */
  readonly skipLocalPkceValidation = false;

  // ---- Client store -------------------------------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => getClient(clientId),

      registerClient: (client) => {
        // The SDK has already set client_id and client_id_issued_at before calling this.
        // We just persist and return.
        return registerClient(client as OAuthClientInformationFull);
      },
    };
  }

  // ---- Authorization flow -------------------------------------------------

  /**
   * Step 1: Claude.ai redirects here. We create a pending auth record keyed on
   * a random `ynabState`, then redirect the user to YNAB's authorize page.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const ynabState   = generateId(32);
    const baseUrl     = requireEnv("BASE_URL");
    const ynabClientId = requireEnv("YNAB_CLIENT_ID");

    // Save pending auth keyed on ynabState so we can look it up in /callback
    savePendingAuth(ynabState, {
      clientId:      client.client_id,
      redirectUri:   params.redirectUri,
      codeChallenge: params.codeChallenge,
      state:         params.state,
    });

    const authUrl = new URL(YNAB_AUTH_URL);
    authUrl.searchParams.set("client_id",     ynabClientId);
    authUrl.searchParams.set("redirect_uri",  `${baseUrl}/oauth/callback`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state",         ynabState);
    // NOTE: YNAB ignores PKCE params — we verify PKCE locally before issuing our token

    res.redirect(authUrl.toString());
  }

  /**
   * Step 3a: SDK calls this to retrieve the code challenge for PKCE verification.
   * Called BEFORE exchangeAuthorizationCode. Must NOT delete the code.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = getAuthCode(authorizationCode); // peek — does not consume
    if (!code) throw new InvalidTokenError("Authorization code not found or expired");
    return code.codeChallenge;
  }

  /**
   * Step 3b: SDK calls this after verifying PKCE. Exchange our code for a session.
   *
   * 1. Consume the auth code to get the YNAB code
   * 2. Exchange YNAB code for YNAB tokens
   * 3. Create a long-lived opaque session token
   * 4. Return our token to Claude.ai
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,   // undefined because skipLocalPkceValidation=false
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = consumeAuthCode(authorizationCode);
    if (!code) throw new InvalidTokenError("Authorization code not found, expired, or already used");

    const baseUrl        = requireEnv("BASE_URL");
    const ynabClientId   = requireEnv("YNAB_CLIENT_ID");
    const ynabClientSecret = requireEnv("YNAB_CLIENT_SECRET");

    // Exchange YNAB code for YNAB tokens
    const ynabResp = await axios.post<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>(YNAB_TOKEN_URL, null, {
      params: {
        client_id:     ynabClientId,
        client_secret: ynabClientSecret,
        redirect_uri:  `${baseUrl}/oauth/callback`,
        grant_type:    "authorization_code",
        code:          code.ynabCode,
      },
      timeout: 15_000,
    });

    const { access_token, refresh_token, expires_in } = ynabResp.data;

    // Create our long-lived opaque session token
    const opaqueToken = generateId(32);
    const nowSeconds  = Math.floor(Date.now() / 1000);

    createSession(opaqueToken, {
      ynabAccessToken:  access_token,
      ynabRefreshToken: refresh_token,
      ynabExpiresAt:    nowSeconds + (expires_in ?? 7200),
      scopes:           ["default"],
      clientId:         client.client_id,
      tokenExpiresAt:   nowSeconds + TOKEN_LIFETIME,
    });

    return {
      access_token:  opaqueToken,
      token_type:    "bearer",
      expires_in:    TOKEN_LIFETIME,
      scope:         "default",
      // No refresh_token returned to Claude.ai — we transparently refresh YNAB tokens
    };
  }

  /**
   * Not used: we don't issue refresh tokens to Claude.ai.
   * Instead, YNAB refresh happens transparently in verifyAccessToken.
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
  ): Promise<OAuthTokens> {
    throw new InvalidTokenError("Refresh tokens are not supported. Please re-authenticate.");
  }

  /**
   * Called on every POST /mcp request by requireBearerAuth middleware.
   * Transparently refreshes the YNAB token if it's close to expiry.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = getSession(token);
    if (!session) throw new InvalidTokenError("Invalid or expired access token");

    const nowSeconds = Math.floor(Date.now() / 1000);

    // Check our token hasn't expired
    if (session.tokenExpiresAt < nowSeconds) {
      deleteSession(token);
      throw new InvalidTokenError("Access token has expired. Please re-authenticate.");
    }

    // Transparently refresh YNAB token if it expires within 5 minutes
    if (session.ynabExpiresAt - nowSeconds < 300) {
      try {
        await this._refreshYnabToken(token, session.ynabRefreshToken);
      } catch (err) {
        console.error("[ynab-oauth] Failed to refresh YNAB token:", err);
        // Don't block the request — the YNAB API call may still succeed if only slightly expired
      }
    }

    return {
      token,
      clientId:  session.clientId,
      scopes:    session.scopes,
      expiresAt: session.tokenExpiresAt,
    };
  }

  /**
   * Optional: revoke our session token.
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    deleteSession(request.token);
  }

  // ---- Private helpers ----------------------------------------------------

  private async _refreshYnabToken(sessionToken: string, ynabRefreshToken: string): Promise<void> {
    const ynabClientId     = requireEnv("YNAB_CLIENT_ID");
    const ynabClientSecret = requireEnv("YNAB_CLIENT_SECRET");

    const resp = await axios.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>(YNAB_TOKEN_URL, null, {
      params: {
        client_id:     ynabClientId,
        client_secret: ynabClientSecret,
        grant_type:    "refresh_token",
        refresh_token: ynabRefreshToken,
      },
      timeout: 15_000,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    updateSession(sessionToken, {
      ynabAccessToken:  resp.data.access_token,
      ynabRefreshToken: resp.data.refresh_token,
      ynabExpiresAt:    nowSeconds + (resp.data.expires_in ?? 7200),
    });

    console.error("[ynab-oauth] YNAB token refreshed successfully");
  }
}
