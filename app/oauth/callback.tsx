import { ThemedView } from "@/components/themed-view";
import * as Api from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useWorkspace } from "@/lib/workspace-context";

const completedCallbackKeys = new Set<string>();

async function synchronizeAuthenticatedSession(sessionToken: string, refreshAuth: () => Promise<void>) {
  await Auth.setSessionToken(sessionToken);
  if (Platform.OS === "web" && !(await Api.establishSession(sessionToken))) {
    throw new Error("Could not establish the secure app session. Please try signing in again.");
  }

  // Re-fetch the signed-in user through the server instead of trusting callback URL fields
  // or a user profile cached from an earlier account on this device.
  await Auth.clearUserInfo();
  const verifiedUser = await Api.getMe();
  if (!verifiedUser) throw new Error("The app could not verify the signed-in account. Please try again.");
  await Auth.setUserInfo({
    id: verifiedUser.id,
    openId: verifiedUser.openId,
    name: verifiedUser.name,
    email: verifiedUser.email,
    loginMethod: verifiedUser.loginMethod,
    lastSignedIn: new Date(verifiedUser.lastSignedIn),
  });
  await refreshAuth();
}

export default function OAuthCallback() {
  const router = useRouter();
  const { refreshAuth } = useWorkspace();
  const params = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
    sessionToken?: string;
    user?: string;
  }>();
  const [status, setStatus] = useState<"processing" | "success" | "error">("processing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const callbackKey = params.sessionToken
        ? `token:${params.sessionToken}`
        : params.code && params.state
          ? `code:${params.code}:${params.state}`
          : null;
      if (callbackKey && completedCallbackKeys.has(callbackKey)) {
        router.replace("/");
        return;
      }
      try {
        if (params.sessionToken) {
          await synchronizeAuthenticatedSession(params.sessionToken, refreshAuth);
          if (callbackKey) completedCallbackKeys.add(callbackKey);
          setStatus("success");
          setTimeout(() => router.replace("/"), 350);
          return;
        }

        let url: string | null = null;
        if (params.code || params.state || params.error) {
          const urlParams = new URLSearchParams();
          if (params.code) urlParams.set("code", params.code);
          if (params.state) urlParams.set("state", params.state);
          if (params.error) urlParams.set("error", params.error);
          url = `?${urlParams.toString()}`;
        } else {
          url = await Linking.getInitialURL();
        }

        const error = params.error || (url ? new URL(url, "http://dummy").searchParams.get("error") : null);
        if (error) throw new Error(error);

        let code = params.code ?? null;
        let state = params.state ?? null;
        let sessionToken: string | null = null;
        if (url) {
          try {
            const urlObj = new URL(url);
            code = code ?? urlObj.searchParams.get("code");
            state = state ?? urlObj.searchParams.get("state");
            sessionToken = urlObj.searchParams.get("sessionToken");
          } catch {
            const match = url.match(/[?&](code|state|sessionToken)=([^&]+)/g);
            match?.forEach((param) => {
              const [key, value] = param.substring(1).split("=");
              if (key === "code") code = decodeURIComponent(value);
              if (key === "state") state = decodeURIComponent(value);
              if (key === "sessionToken") sessionToken = decodeURIComponent(value);
            });
          }
        }

        if (!sessionToken) {
          if (!code || !state) throw new Error("Missing code or state parameter.");
          const result = await Api.exchangeOAuthCode(code, state);
          sessionToken = result.sessionToken;
        }
        if (!sessionToken) throw new Error("No session token was received.");

        await synchronizeAuthenticatedSession(sessionToken, refreshAuth);
        if (callbackKey) completedCallbackKeys.add(callbackKey);
        setStatus("success");
        setTimeout(() => router.replace("/"), 350);
      } catch (error) {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to complete authentication.");
      }
    };

    void handleCallback();
  }, [params.code, params.state, params.error, params.sessionToken, router, refreshAuth]);

  return (
    <SafeAreaView className="flex-1" edges={["top", "bottom", "left", "right"]}>
      <ThemedView className="flex-1 items-center justify-center gap-4 p-5">
        {status === "processing" && <><ActivityIndicator size="large" /><Text className="mt-4 text-base leading-6 text-center text-foreground">Completing authentication…</Text></>}
        {status === "success" && <><Text className="text-base leading-6 text-center text-foreground">Authentication successful.</Text><Text className="text-base leading-6 text-center text-foreground">Opening your workspace…</Text></>}
        {status === "error" && <><Text className="mb-2 text-xl font-bold leading-7 text-error">Authentication failed</Text><Text className="text-base leading-6 text-center text-foreground">{errorMessage}</Text></>}
      </ThemedView>
    </SafeAreaView>
  );
}
