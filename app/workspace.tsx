import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { Card, palette, Pill, PrimaryButton, Wordmark } from "@/components/pos/ui";
import { LEGACY_STORAGE_KEY, readLegacyPosSnapshot } from "@/lib/pos-store";
import { useWorkspace } from "@/lib/workspace-context";
import { trpc } from "@/lib/trpc";
import type { CurrencyCode } from "@/shared/pos";
import { toLegacyImportRecord } from "@/shared/legacy";

export default function WorkspaceSetupScreen() {
  const router = useRouter();
  const { isAuthenticated, authLoading, refreshWorkspace, logout } = useWorkspace();
  const utils = trpc.useUtils();
  const create = trpc.workspace.create.useMutation();
  const join = trpc.workspace.join.useMutation();
  const importLegacy = trpc.pos.importLegacy.useMutation();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>("IDR");
  const [taxPercent, setTaxPercent] = useState("0");
  const [timezone, setTimezone] = useState("Asia/Jakarta");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [importOld, setImportOld] = useState(false);
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [snapshot, setSnapshot] = useState({ orders: [], transactions: [] } as Awaited<ReturnType<typeof readLegacyPosSnapshot>>);
  const [legacyChecked, setLegacyChecked] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const existingCount = snapshot.orders.length + snapshot.transactions.length;
  useEffect(() => { void readLegacyPosSnapshot().then((value) => { setSnapshot(value); setLegacyChecked(true); }).catch(() => setLegacyChecked(true)); }, []);

  async function completeWorkspace() {
    setError(""); setNotice("");
    try {
      if (mode === "join") {
        await join.mutateAsync({ code: code.trim() });
      } else {
        const tax = Number(taxPercent);
        if (!Number.isFinite(tax) || tax < 0 || tax > 30) throw new Error("Tax rate must be between 0% and 30%.");
        await create.mutateAsync({ name: name.trim(), currency, taxRateBasisPoints: Math.round(tax * 100), timezone: timezone.trim() });
        if (importOld && existingCount > 0) {
          if (!currencyConfirmed) throw new Error("Confirm the selected currency matches the old register amounts before importing.");
          try {
            const result = await importLegacy.mutateAsync({ currencyConfirmed: true, orders: snapshot.orders.map(toLegacyImportRecord), transactions: snapshot.transactions.map(toLegacyImportRecord) });
            await AsyncStorage.setItem(`${LEGACY_STORAGE_KEY}:imported`, result.importId);
            setNotice(`${result.imported} local records imported without changing their amounts.`);
          } catch (importError) {
            setNotice("Workspace created. The local records remain on this device; import can be retried from Manage.");
            setError(importError instanceof Error ? importError.message : "Local import did not finish.");
          }
        }
      }
      await Promise.all([refreshWorkspace(), utils.workspace.current.invalidate()]);
      router.replace("/(tabs)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t save your workspace. Try again.");
    }
  }

  const loading = authLoading || create.isPending || join.isPending || importLegacy.isPending;
  if (!authLoading && !isAuthenticated) router.replace("/sign-in" as never);
  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.top}><Wordmark /><Pressable onPress={() => void logout()}><Text style={styles.signOut}>Sign out</Text></Pressable></View>
        <Text style={styles.eyebrow}>YOUR TEAM WORKSPACE</Text><Text style={styles.title}>Bring the shift together.</Text><Text style={styles.subtitle}>Create a register for your business, or join your team with a one-time code from a manager.</Text>
        <View style={styles.modeRow}><Pill label="Create workspace" selected={mode === "create"} onPress={() => setMode("create")} /><Pill label="Join with code" selected={mode === "join"} onPress={() => setMode("join")} /></View>
        <Card style={styles.form}>
          {mode === "create" ? <>
            <Text style={styles.fieldLabel}>BUSINESS NAME</Text><TextInput value={name} onChangeText={setName} placeholder="e.g. Little Fern Café" placeholderTextColor="#98A39A" style={styles.input} maxLength={120} />
            <Text style={[styles.fieldLabel, { marginTop: 16 }]}>CURRENCY</Text><View style={styles.currencyRow}><Pill label="IDR · Rupiah" selected={currency === "IDR"} onPress={() => setCurrency("IDR")} /><Pill label="USD · US dollar" selected={currency === "USD"} onPress={() => setCurrency("USD")} /></View>
            <Text style={[styles.fieldLabel, { marginTop: 16 }]}>BUSINESS TIME ZONE · IANA NAME</Text><TextInput value={timezone} onChangeText={setTimezone} autoCapitalize="none" autoCorrect={false} placeholder="Asia/Jakarta" placeholderTextColor="#98A39A" style={styles.input} maxLength={64} /><Text style={styles.hint}>Used for daily report cutoffs and invoice/bill calendar dates; it is separate from currency.</Text>
            <Text style={[styles.fieldLabel, { marginTop: 16 }]}>SALES TAX RATE · OPTIONAL</Text><View style={styles.taxRow}><TextInput value={taxPercent} onChangeText={setTaxPercent} keyboardType="decimal-pad" placeholder="0" style={[styles.input, { flex: 1 }]} /><Text style={styles.percent}>%</Text></View><Text style={styles.hint}>Starts at 0%. A manager can configure the rate for your business later.</Text>
            {legacyChecked && existingCount > 0 ? <Pressable onPress={() => setImportOld(!importOld)} style={styles.importBox}><View style={[styles.checkbox, importOld && styles.checkboxActive]}>{importOld ? <MaterialIcons name="check" size={14} color={palette.white} /> : null}</View><View style={{ flex: 1 }}><Text style={styles.importTitle}>Import {existingCount} old register records</Text><Text style={styles.hint}>Only if these amounts match the selected currency. Values stay unchanged; nothing imports without your choice.</Text></View></Pressable> : null}
            {importOld && existingCount > 0 ? <Pressable onPress={() => setCurrencyConfirmed(!currencyConfirmed)} style={styles.confirmCurrency}><View style={[styles.checkbox, currencyConfirmed && styles.checkboxActive]}>{currencyConfirmed ? <MaterialIcons name="check" size={14} color={palette.white} /> : null}</View><Text style={styles.confirmText}>I confirm the existing amounts are already in {currency}.</Text></Pressable> : null}
          </> : <>
            <Text style={styles.fieldLabel}>ONE-TIME INVITE CODE</Text><TextInput value={code} onChangeText={(value) => setCode(value.replace(/\s/g, "").toUpperCase())} placeholder="Paste the code from your manager" placeholderTextColor="#98A39A" autoCapitalize="characters" style={styles.input} maxLength={32} />
            <Text style={styles.hint}>Invite codes expire after 48 hours and can be used once. You’ll get the role selected by your manager.</Text>
          </>}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={{ marginTop: 20 }}><PrimaryButton label={mode === "create" ? "Create workspace" : "Join workspace"} icon={mode === "create" ? "storefront" : "group-add"} onPress={() => void completeWorkspace()} loading={loading} disabled={mode === "create" ? name.trim().length < 2 : code.trim().length < 12} /></View>
        </Card>
        <View style={styles.note}><MaterialIcons name="verified-user" size={17} color={palette.evergreen} /><Text style={styles.noteText}>Workspace roles and records are checked on the server, not just hidden in the app.</Text></View>
      </ScrollView>
    </ScreenContainer>
  );
}
const styles = StyleSheet.create({ page: { flexGrow: 1, padding: 20, paddingBottom: 40, backgroundColor: palette.background }, top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }, signOut: { color: palette.muted, fontSize: 11, fontWeight: "800", padding: 8 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: "900", letterSpacing: 1.4 }, title: { color: palette.ink, fontSize: 29, fontWeight: "900", letterSpacing: -0.8, marginTop: 6 }, subtitle: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 7, maxWidth: 350 }, modeRow: { flexDirection: "row", gap: 8, marginTop: 19, marginBottom: 12, flexWrap: "wrap" }, form: { padding: 17 }, fieldLabel: { color: palette.muted, fontSize: 9, fontWeight: "900", letterSpacing: 1.1, marginBottom: 8 }, input: { minHeight: 47, borderRadius: 13, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FBFAF5", paddingHorizontal: 13, color: palette.ink, fontSize: 13 }, currencyRow: { flexDirection: "row", gap: 7, flexWrap: "wrap" }, taxRow: { flexDirection: "row", alignItems: "center", gap: 8 }, percent: { fontSize: 14, color: palette.muted, fontWeight: "800" }, hint: { color: palette.muted, fontSize: 10, lineHeight: 15, marginTop: 6 }, importBox: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 18, padding: 11, borderRadius: 13, backgroundColor: palette.evergreenSoft }, checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: palette.line, alignItems: "center", justifyContent: "center", backgroundColor: palette.surface }, checkboxActive: { backgroundColor: palette.evergreen, borderColor: palette.evergreen }, importTitle: { color: palette.ink, fontSize: 11, fontWeight: "800" }, confirmCurrency: { flexDirection: "row", gap: 9, alignItems: "center", marginTop: 12 }, confirmText: { flex: 1, color: palette.ink, fontSize: 10, lineHeight: 15 }, error: { color: palette.coral, fontSize: 11, lineHeight: 16, marginTop: 10 }, notice: { color: palette.evergreen, fontSize: 10, fontWeight: "700", marginTop: 10 }, note: { marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, noteText: { flex: 1, color: palette.muted, fontSize: 10, lineHeight: 15 } });
