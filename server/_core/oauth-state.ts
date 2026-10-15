import { timingSafeEqual } from "node:crypto";

export type OAuthState = {
  redirectUri: string;
  nonce?: string;
  returnOrigin?: string;
};

export function encodeOAuthState(state: OAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeOAuthState(encoded: string): OAuthState {
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error("Invalid OAuth state encoding.");
  }

  try {
    const parsed: unknown = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && "redirectUri" in parsed) {
      const value = parsed as { redirectUri?: unknown; nonce?: unknown; returnOrigin?: unknown };
      if (typeof value.redirectUri === "string" && value.redirectUri.length > 0) {
        return {
          redirectUri: value.redirectUri,
          ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}),
          ...(typeof value.returnOrigin === "string" ? { returnOrigin: value.returnOrigin } : {}),
        };
      }
    }
  } catch {
    // Older native builds encoded the redirect URI string directly; keep accepting those.
  }

  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(decoded)) return { redirectUri: decoded };
  throw new Error("OAuth state did not contain a valid redirect URI.");
}

export function safeNonceMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function isAllowedOAuthCallback(redirectUri: string, origin: string): boolean {
  try {
    const url = new URL(redirectUri);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/api/oauth/callback" &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}
