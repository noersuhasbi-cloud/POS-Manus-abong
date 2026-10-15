import { parse as parseCookieHeader } from "cookie";
import type { CookieOptions, Request, RequestHandler } from "express";
import {
  LEGACY_COOKIE_NAME,
  SESSION_COOKIE_SUFFIX,
} from "../../shared/const.js";

export const OAUTH_NONCE_COOKIE = "tilltable_oauth_nonce";
export const OAUTH_NONCE_MAX_AGE_MS = 10 * 60 * 1000;

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");

  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}

export function getSessionCookieOptions(
  req: Request,
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    path: "/",
    sameSite: secure ? "none" : "lax",
    secure,
  };
}

function configuredApiHostname(): string | null {
  const packager = process.env.EXPO_PACKAGER_PROXY_URL;
  if (!packager) return null;
  try {
    const url = new URL(packager);
    const hostname = url.hostname.replace(/^8081-/, "3000-");
    return hostname === url.hostname ? null : hostname;
  } catch {
    return null;
  }
}

function legacyParentDomain(hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  if (normalized !== configuredApiHostname()?.toLowerCase()) return null;
  if (!/^3000-[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(normalized)) return null;
  return `.${normalized.split(".").slice(-2).join(".")}`;
}

export function getSessionCookieName(req: Request): string {
  void req;
  return "webdev_app_session";
}

export function getOAuthNonceCookieOptions(
  req: Request,
): Pick<CookieOptions, "httpOnly" | "maxAge" | "path" | "sameSite" | "secure"> {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    maxAge: OAUTH_NONCE_MAX_AGE_MS,
    path: "/api/oauth/callback",
    sameSite: "lax",
    secure,
  };
}

export function getLegacySessionCookieOptions(
  req: Request,
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  const secure = isSecureRequest(req);
  return {
    domain: legacyParentDomain(req.hostname) ?? undefined,
    httpOnly: true,
    path: "/",
    sameSite: secure ? "none" : "lax",
    secure,
  };
}

export function clearLegacySessionCookie(): RequestHandler {
  return (req, res, next) => {
    res.clearCookie(LEGACY_COOKIE_NAME, getLegacySessionCookieOptions(req));
    res.clearCookie(`__Host-manus_session_${SESSION_COOKIE_SUFFIX}`, {
      httpOnly: true,
      path: "/",
      sameSite: "none",
      secure: true,
    });
    res.clearCookie(`manus_local_session_${SESSION_COOKIE_SUFFIX}`, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: false,
    });
    next();
  };
}

export function currentSessionCookie(req: Request): string | undefined {
  if (!req.headers.cookie) return undefined;
  return parseCookieHeader(req.headers.cookie)[getSessionCookieName(req)];
}
