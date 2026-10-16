import { ONE_YEAR_MS } from "../../shared/const.js";
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import { getUserByOpenId, upsertUser } from "../db";
import {
  OAUTH_NONCE_COOKIE,
  getOAuthNonceCookieOptions,
  getSessionCookieName,
  getSessionCookieOptions,
} from "./cookies";
import { ENV } from "./env";
import { decodeOAuthState, encodeOAuthState, isAllowedOAuthCallback, isValidNativeOAuthState, safeNonceMatches } from "./oauth-state";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

async function syncUser(userInfo: {
  openId?: string | null;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  platform?: string | null;
}) {
  if (!userInfo.openId) {
    throw new Error("openId missing from user info");
  }

  const lastSignedIn = new Date();
  await upsertUser({
    openId: userInfo.openId,
    name: userInfo.name || null,
    email: userInfo.email ?? null,
    loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
    lastSignedIn,
  });
  const saved = await getUserByOpenId(userInfo.openId);
  return (
    saved ?? {
      openId: userInfo.openId,
      name: userInfo.name,
      email: userInfo.email,
      loginMethod: userInfo.loginMethod ?? null,
      lastSignedIn,
    }
  );
}

function buildUserResponse(
  user:
    | Awaited<ReturnType<typeof getUserByOpenId>>
    | {
        openId: string;
        name?: string | null;
        email?: string | null;
        loginMethod?: string | null;
        lastSignedIn?: Date | null;
      },
) {
  return {
    id: (user as any)?.id ?? null,
    openId: user?.openId ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    loginMethod: user?.loginMethod ?? null,
    lastSignedIn: (user?.lastSignedIn ?? new Date()).toISOString(),
  };
}

export function registerOAuthRoutes(app: Express) {
  app.post("/api/oauth/start", (req: Request, res: Response) => {
    const missing = [
      ["MANUS_PROJECT_ID", ENV.appId],
      ["MANUS_OAUTH_PORTAL_URL", ENV.oAuthPortalUrl],
      ["MANUS_OAUTH_API_URL", ENV.oAuthServerUrl],
      ["MANUS_JWT_SECRET", ENV.cookieSecret],
      ["DATABASE_URL", ENV.databaseUrl],
    ].filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) {
      res.status(503).json({
        error: "Manus sign-in is not configured for this server environment.",
        missing,
      });
      return;
    }

    const originHeader = req.get("origin");
    const redirectUri = req.body?.redirectUri;
    const browserSameOrigin = req.headers["sec-fetch-site"] === "same-origin";
    let callbackOrigin = "";
    try {
      if (typeof redirectUri === "string") callbackOrigin = new URL(redirectUri).origin;
    } catch {
      callbackOrigin = "";
    }
    const origin = browserSameOrigin ? callbackOrigin : originHeader;
    if (
      !origin ||
      typeof redirectUri !== "string" ||
      !isAllowedOAuthCallback(redirectUri, origin) ||
      (!browserSameOrigin && originHeader !== origin)
    ) {
      res.status(400).json({ error: "The OAuth callback must use this app's origin." });
      return;
    }

    const nonce = randomBytes(32).toString("base64url");
    const state = encodeOAuthState({ redirectUri, nonce, returnOrigin: origin });
    const loginUrl = new URL("/app-auth", ENV.oAuthPortalUrl);
    loginUrl.searchParams.set("appId", ENV.appId);
    loginUrl.searchParams.set("redirectUri", redirectUri);
    loginUrl.searchParams.set("state", state);
    loginUrl.searchParams.set("responseType", "code");

    res.cookie(OAUTH_NONCE_COOKIE, nonce, getOAuthNonceCookieOptions(req));
    res.json({ loginUrl: loginUrl.toString() });
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    let decodedState;
    try {
      decodedState = decodeOAuthState(state);
    } catch {
      res.status(400).json({ error: "The OAuth state is invalid. Restart sign-in and try again." });
      return;
    }
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    const nonceCookieOptions = getOAuthNonceCookieOptions(req);
    res.clearCookie(OAUTH_NONCE_COOKIE, {
      httpOnly: nonceCookieOptions.httpOnly,
      path: nonceCookieOptions.path,
      sameSite: nonceCookieOptions.sameSite,
      secure: nonceCookieOptions.secure,
    });
    let returnOriginMatches = false;
    try {
      returnOriginMatches =
        Boolean(decodedState.returnOrigin) &&
        new URL(decodedState.returnOrigin!).origin === new URL(decodedState.redirectUri).origin;
    } catch {
      returnOriginMatches = false;
    }
    if (!safeNonceMatches(decodedState.nonce, cookies[OAUTH_NONCE_COOKIE]) || !returnOriginMatches) {
      res.status(400).json({ error: "The sign-in request expired or could not be verified. Please try again." });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      await syncUser(userInfo);
      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(getSessionCookieName(req), sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.redirect(302, new URL("/", decodedState.returnOrigin!).toString());
    } catch {
      console.error("[OAuth] Callback failed");
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  app.get("/api/oauth/mobile", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    if (!isValidNativeOAuthState(state)) {
      res.status(400).json({ error: "The native sign-in state is missing or invalid. Start sign-in again." });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      const user = await syncUser(userInfo);

      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(getSessionCookieName(req), sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.json({
        app_session_id: sessionToken,
        user: buildUserResponse(user),
      });
    } catch {
      console.error("[OAuth] Mobile exchange failed");
      res.status(500).json({ error: "OAuth mobile exchange failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(getSessionCookieName(req), {
      ...cookieOptions,
      maxAge: -1,
    });
    res.json({ success: true });
  });

  // Get current authenticated user - works with both cookie (web) and Bearer token (mobile)
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      res.json({ user: buildUserResponse(user) });
    } catch {
      console.error("[Auth] /api/auth/me failed");
      res.status(401).json({ error: "Not authenticated", user: null });
    }
  });

  // Establish session cookie from Bearer token
  // Used by iframe preview: frontend receives token via postMessage, then calls this endpoint
  // to get a proper Set-Cookie response from the backend (3000-xxx domain)
  app.post("/api/auth/session", async (req: Request, res: Response) => {
    try {
      // Authenticate using Bearer token from Authorization header
      const user = await sdk.authenticateRequest(req);

      // Get the token from the Authorization header to set as cookie
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.status(400).json({ error: "Bearer token required" });
        return;
      }
      const token = authHeader.slice("Bearer ".length).trim();

      // Set cookie for this domain (3000-xxx)
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(getSessionCookieName(req), token, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.json({ success: true, user: buildUserResponse(user) });
    } catch {
      console.error("[Auth] /api/auth/session failed");
      res.status(401).json({ error: "Invalid token" });
    }
  });
}
