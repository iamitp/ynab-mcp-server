/**
 * YNAB OAuth Callback Route
 *
 * YNAB redirects here after the user authorizes access.
 * We link the YNAB code back to the original Claude.ai authorization request
 * and redirect Claude.ai with our own short-lived code.
 *
 * Route: GET /oauth/callback?code=YNAB_CODE&state=YNAB_STATE
 */

import { Router } from "express";
import { consumePendingAuth, saveAuthCode, generateId } from "./oauth-store.js";

export function makeCallbackRouter(): Router {
  const router = Router();

  router.get("/oauth/callback", (req, res) => {
    const { code: ynabCode, state: ynabState, error, error_description } = req.query as Record<string, string | undefined>;

    // --- Error from YNAB ---
    if (error) {
      // Try to find the pending auth to redirect back with error
      const pending = ynabState ? consumePendingAuth(ynabState) : undefined;
      if (pending) {
        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set("error", error);
        if (error_description) redirectUrl.searchParams.set("error_description", error_description);
        if (pending.state) redirectUrl.searchParams.set("state", pending.state);
        return res.redirect(redirectUrl.toString());
      }
      return res.status(400).send(`Authorization failed: ${error}. ${error_description ?? ""}`);
    }

    // --- Missing params ---
    if (!ynabCode || !ynabState) {
      return res.status(400).send("Missing code or state from YNAB callback.");
    }

    // --- Look up the pending authorization ---
    const pending = consumePendingAuth(ynabState);
    if (!pending) {
      return res.status(400).send("Authorization request not found or expired. Please try connecting again.");
    }

    // --- Issue our own short-lived code ---
    const ourCode = generateId(32);
    saveAuthCode(ourCode, {
      clientId:      pending.clientId,
      redirectUri:   pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      ynabCode,
    });

    // --- Redirect back to Claude.ai with our code ---
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", ourCode);
    if (pending.state) redirectUrl.searchParams.set("state", pending.state);

    return res.redirect(redirectUrl.toString());
  });

  return router;
}
