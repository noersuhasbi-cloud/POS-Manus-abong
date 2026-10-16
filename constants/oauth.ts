import * as Linking from "expo-linking";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import * as ReactNative from "react-native";

// Extract scheme from bundle ID (last segment timestamp, prefixed with "manus")
// e.g., "space.manus.my.app.t20240115103045" -> "manus20240115103045"
const bundleId = "space.manus.tilltable.t154908903758619";
const timestamp = bundleId.split(".").pop()?.replace(/^t/, "") ?? "";
const schemeFromBundleId = `manus${timestamp}`;

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const env = {
  portal: extra.oauthPortalUrl ?? process.env.EXPO_PUBLIC_OAUTH_PORTAL_URL ?? "",
  server: extra.oauthServerUrl ?? process.env.EXPO_PUBLIC_OAUTH_SERVER_URL ?? "",
  appId: extra.appId ?? process.env.EXPO_PUBLIC_APP_ID ?? "",
  ownerId: process.env.EXPO_PUBLIC_OWNER_OPEN_ID ?? "",
  ownerName: process.env.EXPO_PUBLIC_OWNER_NAME ?? "",
  apiBaseUrl: extra.apiBaseUrl ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
  deepLinkScheme: schemeFromBundleId,
};

export const OAUTH_PORTAL_URL = env.portal;
export const OAUTH_SERVER_URL = env.server;
export const APP_ID = env.appId;
export const OWNER_OPEN_ID = env.ownerId;
export const OWNER_NAME = env.ownerName;
export const API_BASE_URL = env.apiBaseUrl;

/**
 * Get the API base URL, deriving from current hostname if not set.
 * Metro runs on 8081, API server runs on 3000.
 * URL pattern: https://PORT-sandboxid.region.domain
 */
export function getApiBaseUrl(): string {
  // If API_BASE_URL is set, use it
  if (API_BASE_URL) {
    return API_BASE_URL.replace(/\/$/, "");
  }

  // On web, derive from current hostname by replacing port 8081 with 3000
  if (ReactNative.Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const { protocol, hostname } = window.location;
    // Pattern: 8081-sandboxid.region.domain -> 3000-sandboxid.region.domain
    const apiHostname = hostname.replace(/^8081-/, "3000-");
    if (apiHostname !== hostname) {
      return `${protocol}//${apiHostname}`;
    }
  }

  // Fallback to empty (will use relative URL)
  return "";
}

export const SESSION_TOKEN_KEY = "app_session_token";
export const USER_INFO_KEY = "manus-runtime-user-info";
export const NATIVE_OAUTH_STATE_KEY = "native-oauth-pending-state";
const NATIVE_OAUTH_CONSUMED_STATE_KEY = "native-oauth-consumed-state";

const encodeState = (value: string) => {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(value);
  }
  const BufferImpl = (globalThis as Record<string, any>).Buffer;
  if (BufferImpl) {
    return BufferImpl.from(value, "utf-8").toString("base64");
  }
  throw new Error("This device cannot encode a secure sign-in state.");
};

function createNativeOAuthNonce() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Secure sign-in randomness is unavailable on this device.");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isFreshNativeOAuthState(value: string) {
  try {
    const BufferImpl = (globalThis as Record<string, any>).Buffer;
    const decoded = typeof globalThis.atob === "function"
      ? globalThis.atob(value)
      : BufferImpl ? BufferImpl.from(value, "base64").toString("utf-8") : "";
    const state = JSON.parse(decoded) as { redirectUri?: unknown; nonce?: unknown; issuedAt?: unknown };
    const ageMs = typeof state.issuedAt === "number" ? Date.now() - state.issuedAt : Number.POSITIVE_INFINITY;
    return state.redirectUri === getRedirectUri()
      && typeof state.nonce === "string"
      && /^[a-f0-9]{64}$/.test(state.nonce)
      && ageMs >= -60_000
      && ageMs <= 10 * 60_000;
  } catch {
    return false;
  }
}

export async function consumeNativeOAuthState(actualState: string | null | undefined) {
  const expectedState = await SecureStore.getItemAsync(NATIVE_OAUTH_STATE_KEY);
  if (!expectedState || !actualState || expectedState !== actualState || !isFreshNativeOAuthState(expectedState)) return false;
  const consumedState = await SecureStore.getItemAsync(NATIVE_OAUTH_CONSUMED_STATE_KEY);
  if (consumedState === expectedState) return false;
  try {
    await SecureStore.setItemAsync(NATIVE_OAUTH_CONSUMED_STATE_KEY, expectedState);
    await SecureStore.deleteItemAsync(NATIVE_OAUTH_STATE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function clearPendingNativeOAuthState() {
  try {
    await SecureStore.deleteItemAsync(NATIVE_OAUTH_STATE_KEY);
  } catch {
    // The pending state is short lived; callback validation still fails closed if it remains.
  }
}

/**
 * Get the redirect URI for OAuth callback.
 * - Web: uses API server callback endpoint
 * - Native: uses deep link scheme
 */
export const getRedirectUri = () => {
  if (ReactNative.Platform.OS === "web") {
    const origin = getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "");
    return `${origin}/api/oauth/callback`;
  } else {
    return Linking.createURL("/oauth/callback", {
      scheme: env.deepLinkScheme,
    });
  }
};

export const getLoginUrl = (state: string, redirectUri: string) => {
  if (!OAUTH_PORTAL_URL || !APP_ID) {
    throw new Error("Manus login configuration is unavailable");
  }

  const url = new URL(`${OAUTH_PORTAL_URL}/app-auth`);
  url.searchParams.set("appId", APP_ID);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};

/**
 * Start OAuth login flow.
 *
 * On native platforms (iOS/Android), open the system browser directly so
 * the OAuth callback returns via deep link to the app.
 *
 * On web, this simply redirects to the login URL.
 *
 * @returns Always null, the callback is handled via deep link.
 */
export async function startOAuthLogin(): Promise<string | null> {
  if (ReactNative.Platform.OS === "web") {
    if (typeof window !== "undefined") {
      const response = await fetch(`${getApiBaseUrl()}/api/oauth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ redirectUri: getRedirectUri() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.loginUrl !== "string") {
        const missing = Array.isArray(result.missing) ? ` Missing: ${result.missing.join(", ")}.` : "";
        throw new Error(`${result.error || "Could not start Manus sign-in."}${missing}`);
      }
      window.location.assign(result.loginUrl);
    }
    return null;
  }

  try {
    const redirectUri = getRedirectUri();
    const state = encodeState(JSON.stringify({ redirectUri, nonce: createNativeOAuthNonce(), issuedAt: Date.now() }));
    await SecureStore.setItemAsync(NATIVE_OAUTH_STATE_KEY, state);
    const loginUrl = getLoginUrl(state, redirectUri);
    const supported = await Linking.canOpenURL(loginUrl);
    if (!supported) throw new Error("This device cannot open the Manus sign-in page.");
    await Linking.openURL(loginUrl);
  } catch (error) {
    await clearPendingNativeOAuthState();
    throw error instanceof Error ? error : new Error("Could not open Manus sign-in.");
  }

  // The OAuth callback will reopen the app via deep link.
  return null;
}
