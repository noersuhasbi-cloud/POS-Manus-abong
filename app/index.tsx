import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { palette } from "@/components/pos/ui";
import { useWorkspace } from "@/lib/workspace-context";

export default function IndexRoute() {
  const router = useRouter();
  const { authLoading, isAuthenticated, workspaceLoading, workspace, workspaceError, refreshWorkspace } = useWorkspace();
  useEffect(() => {
    if (authLoading || (isAuthenticated && workspaceLoading) || workspaceError) return;
    router.replace((!isAuthenticated ? "/sign-in" : workspace ? "/(tabs)" : "/workspace") as never);
  }, [authLoading, isAuthenticated, workspaceLoading, workspace, workspaceError, router]);
  if (workspaceError) return <View style={{ flex: 1, backgroundColor: palette.background, alignItems: "center", justifyContent: "center", padding: 28, gap: 12 }}><MaterialIcons name="cloud-off" size={32} color={palette.coral} /><Text style={{ color: palette.ink, fontWeight: "800", textAlign: "center" }}>Couldn’t reach your shared workspace.</Text><Text style={{ color: palette.muted, textAlign: "center" }}>{workspaceError}</Text><Text onPress={() => void refreshWorkspace()} style={{ color: palette.evergreen, fontWeight: "800", padding: 10 }}>Try again</Text></View>;
  return <View style={{ flex: 1, backgroundColor: palette.background, alignItems: "center", justifyContent: "center", gap: 12 }}><ActivityIndicator size="large" color={palette.evergreen} /><Text style={{ color: palette.muted, fontSize: 12 }}>Opening your register…</Text></View>;
}
