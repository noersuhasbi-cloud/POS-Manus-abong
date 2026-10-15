import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, palette, Wordmark } from "@/components/pos/ui";
import { startOAuthLogin } from "@/constants/oauth";
import { useWorkspace } from "@/lib/workspace-context";
import { useRouter } from "expo-router";

export default function SignInScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { isAuthenticated } = useWorkspace();
  const router = useRouter();
  async function signIn() {
    setLoading(true);
    setError("");
    try {
      if (isAuthenticated) router.replace("/workspace" as never);
      else await startOAuthLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in is unavailable. Try again.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.brand}><Wordmark /></View>
        <View style={styles.hero}><View style={styles.mark}><MaterialIcons name="receipt-long" size={29} color={palette.white} /></View><Text style={styles.kicker}>TICKETS TOGETHER</Text><Text style={styles.title}>Every ticket seen.{"\n"}Every sale counted.</Text><Text style={styles.subtitle}>One calm workspace for the counter, kitchen and books.</Text></View>
        <Card style={styles.card}><Text style={styles.cardTitle}>Sign in to your team</Text><Text style={styles.cardBody}>Use your Manus account. Your manager can invite you to the right business and role.</Text><Pressable disabled={loading} onPress={() => void signIn()} style={({ pressed }) => [styles.button, pressed && { opacity: 0.86 }]}>{loading ? <ActivityIndicator color={palette.white} /> : <MaterialIcons name="login" size={19} color={palette.white} />}<Text style={styles.buttonText}>{loading ? "Opening sign-in…" : "Continue with Manus"}</Text></Pressable>{error ? <Text style={styles.error}>{error}</Text> : null}<Text style={styles.privacy}><MaterialIcons name="lock-outline" size={13} color={palette.muted} /> Workspace information is shared only with its members.</Text></Card>
        <Text style={styles.footer}>SERVICE, IN SYNC · TILL & TABLE</Text>
      </ScrollView>
    </ScreenContainer>
  );
}
const styles = StyleSheet.create({ page: { flexGrow: 1, padding: 22, justifyContent: "center", backgroundColor: palette.background }, brand: { marginBottom: 45 }, hero: { marginBottom: 24 }, mark: { width: 55, height: 55, borderRadius: 18, backgroundColor: palette.evergreen, alignItems: "center", justifyContent: "center", marginBottom: 17 }, kicker: { color: palette.coral, fontSize: 10, fontWeight: "900", letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 33, fontWeight: "900", lineHeight: 37, letterSpacing: -1.2, marginTop: 6 }, subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 300 }, card: { padding: 19 }, cardTitle: { color: palette.ink, fontSize: 17, fontWeight: "900" }, cardBody: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 7, marginBottom: 17 }, button: { minHeight: 52, borderRadius: 15, backgroundColor: palette.evergreen, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 }, buttonText: { color: palette.white, fontSize: 14, fontWeight: "800" }, error: { color: palette.coral, marginTop: 10, fontSize: 11, lineHeight: 16 }, privacy: { color: palette.muted, fontSize: 10, marginTop: 16, flexDirection: "row", textAlign: "center" }, footer: { textAlign: "center", color: palette.muted, fontSize: 8, fontWeight: "800", letterSpacing: 1.5, marginTop: 28 } });
