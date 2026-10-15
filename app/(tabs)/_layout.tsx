import { Redirect, Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { HapticTab } from "@/components/haptic-tab";
import { palette } from "@/components/pos/ui";
import { useWorkspace } from "@/lib/workspace-context";

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { authLoading, isAuthenticated, workspaceLoading, workspace, workspaceError } = useWorkspace();
  const bottomPadding = Platform.OS === "web" ? 9 : Math.max(insets.bottom, 8);
  const tabBarHeight = 57 + bottomPadding;
  if (authLoading || (isAuthenticated && workspaceLoading)) return <View style={{ flex: 1, backgroundColor: palette.background, alignItems: "center", justifyContent: "center", gap: 12 }}><ActivityIndicator color={palette.evergreen} /><Text style={{ color: palette.muted, fontSize: 12 }}>Connecting to your workspace…</Text></View>;
  if (!isAuthenticated) return <Redirect href={"/sign-in" as never} />;
  if (!workspace && !workspaceError) return <Redirect href={"/workspace" as never} />;
  if (workspaceError) return <View style={{ flex: 1, backgroundColor: palette.background, alignItems: "center", justifyContent: "center", padding: 24 }}><MaterialIcons name="cloud-off" size={28} color={palette.coral} /><Text style={{ color: palette.ink, fontWeight: "800", textAlign: "center", marginTop: 10 }}>Workspace unavailable</Text><Text style={{ color: palette.muted, textAlign: "center", marginTop: 6 }}>{workspaceError}</Text></View>;
  const manager = workspace?.role === "manager";
  const cashier = workspace?.role === "cashier";
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarButton: HapticTab, tabBarActiveTintColor: palette.evergreen, tabBarInactiveTintColor: palette.muted, tabBarLabelStyle: { fontSize: 9, fontWeight: "800", marginTop: -2 }, tabBarItemStyle: { paddingTop: 6 }, tabBarStyle: { paddingTop: 6, paddingBottom: bottomPadding, height: tabBarHeight, backgroundColor: palette.surface, borderTopColor: palette.line, borderTopWidth: 1, elevation: 0 } }}>
      <Tabs.Screen name="index" options={{ title: "Sell", href: cashier || manager ? undefined : null, tabBarIcon: ({ color, size }) => <MaterialIcons name="point-of-sale" size={size} color={color} /> }} />
      <Tabs.Screen name="kitchen" options={{ title: "Kitchen", tabBarIcon: ({ color, size }) => <MaterialIcons name="soup-kitchen" size={size} color={color} /> }} />
      <Tabs.Screen name="reports" options={{ title: "Books", href: manager ? undefined : null, tabBarIcon: ({ color, size }) => <MaterialIcons name="account-balance" size={size} color={color} /> }} />
      <Tabs.Screen name="history" options={{ title: "History", href: cashier || manager ? undefined : null, tabBarIcon: ({ color, size }) => <MaterialIcons name="receipt-long" size={size} color={color} /> }} />
      <Tabs.Screen name="manage" options={{ title: manager ? "Manage" : "Account", tabBarIcon: ({ color, size }) => <MaterialIcons name={manager ? "tune" : "account-circle"} size={size} color={color} /> }} />
    </Tabs>
  );
}
