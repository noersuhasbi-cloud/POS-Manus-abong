import { describe, expect, it } from "vitest";
import {
  decodeOAuthState,
  encodeOAuthState,
  isAllowedOAuthCallback,
  safeNonceMatches,
} from "../server/_core/oauth-state";

describe("OAuth state", () => {
  it("round-trips the redirect URI, nonce, and return origin", () => {
    const value = {
      redirectUri: "https://app.example.test/api/oauth/callback",
      nonce: "random-one-time-value",
      returnOrigin: "https://app.example.test",
    };
    expect(decodeOAuthState(encodeOAuthState(value))).toEqual(value);
  });

  it("continues to accept redirect-only state from older native builds", () => {
    const redirectUri = "manus12345://oauth/callback";
    const legacy = Buffer.from(redirectUri, "utf8").toString("base64");
    expect(decodeOAuthState(legacy)).toEqual({ redirectUri });
  });

  it("requires both nonce values and compares them safely", () => {
    expect(safeNonceMatches("nonce", "nonce")).toBe(true);
    expect(safeNonceMatches("nonce", "other")).toBe(false);
    expect(safeNonceMatches("nonce", undefined)).toBe(false);
  });

  it("accepts only an absolute callback on the initiating origin", () => {
    expect(
      isAllowedOAuthCallback(
        "https://app.example.test/api/oauth/callback",
        "https://app.example.test",
      ),
    ).toBe(true);
    expect(
      isAllowedOAuthCallback(
        "https://other.example.test/api/oauth/callback",
        "https://app.example.test",
      ),
    ).toBe(false);
    expect(isAllowedOAuthCallback("https://app.example.test/", "https://app.example.test")).toBe(
      false,
    );
  });
});
