import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps, ReactNode } from "react";
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { OrderStatus, PaymentMethod } from "@/lib/pos-store";
import { formatMoney } from "@/shared/accounting";
import type { CurrencyCode } from "@/shared/pos";

export const palette = {
  background: "#F5F3EA",
  surface: "#FFFEFA",
  ink: "#182A25",
  muted: "#708078",
  line: "#E5E6DC",
  evergreen: "#173F35",
  evergreenSoft: "#E8F0EB",
  amber: "#D7A14F",
  amberSoft: "#F7EEDB",
  coral: "#C97455",
  coralSoft: "#F8E8E0",
  sage: "#E3EADD",
  white: "#FFFFFF",
};

export function money(value: number, currency: CurrencyCode = "IDR") {
  return formatMoney(value, currency);
}

export function shortTime(iso: string, timezone?: string) {
  return new Intl.DateTimeFormat(undefined, { ...(timezone ? { timeZone: timezone } : {}), hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function elapsedLabel(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return minutes < 1 ? "Just now" : `${minutes} min`;
}

export function orderStatusLabel(status: OrderStatus) {
  if (status === "cancelled") return "Cancelled";
  return status === "new" ? "New" : status === "preparing" ? "Preparing" : status === "ready" ? "Ready" : "Completed";
}

export function orderStatusColor(status: OrderStatus) {
  if (status === "cancelled") return { bg: palette.coralSoft, fg: palette.coral };
  if (status === "new") return { bg: palette.amberSoft, fg: "#98661F" };
  if (status === "preparing") return { bg: palette.evergreenSoft, fg: palette.evergreen };
  if (status === "ready") return { bg: palette.coralSoft, fg: "#A84E36" };
  return { bg: "#EEF0EB", fg: palette.muted };
}

export function transactionStatusColor(status: "paid" | "refunded" | "voided") {
  if (status === "paid") return { bg: palette.evergreenSoft, fg: palette.evergreen };
  if (status === "refunded") return { bg: palette.amberSoft, fg: "#98661F" };
  return { bg: "#EEF0EB", fg: palette.muted };
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  const brandImage = Platform.OS === "web"
    ? { uri: "/manus-storage/async-images/yZdMiZAH439suWWT6KI74v/image-1.webp" }
    : require("../../assets/images/icon.png");
  return (
    <View style={styles.wordmark}>
      <Image source={brandImage} resizeMode="cover" style={styles.brandImage} />
      {!compact && (
        <View>
          <Text style={styles.brandTitle}>TILL & TABLE</Text>
          <Text style={styles.brandCaption}>SERVICE, IN SYNC</Text>
        </View>
      )}
    </View>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  right,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderMain}>
        <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
        <Text style={styles.pageTitle}>{title}</Text>
        {subtitle ? <Text style={styles.pageSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Pill({
  label,
  selected = false,
  onPress,
  count,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  count?: number;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, selected && styles.pillSelected]}>
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text>
      {count !== undefined ? (
        <View style={[styles.pillCount, selected && styles.pillCountSelected]}>
          <Text style={[styles.pillCountText, selected && styles.pillCountTextSelected]}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function PrimaryButton({
  label,
  onPress,
  icon,
  disabled,
  loading,
  tone = "green",
}: {
  label: string;
  onPress: () => void;
  icon?: ComponentProps<typeof MaterialIcons>["name"];
  disabled?: boolean;
  loading?: boolean;
  tone?: "green" | "amber" | "light";
}) {
  const background = tone === "amber" ? palette.amber : tone === "light" ? palette.evergreenSoft : palette.evergreen;
  const foreground = tone === "light" ? palette.evergreen : palette.white;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.primaryButton, { backgroundColor: background }, (disabled || loading) && styles.disabled, pressed && styles.pressed]}
    >
      {loading ? <ActivityIndicator color={foreground} /> : null}
      {!loading && icon ? <MaterialIcons name={icon} size={19} color={foreground} /> : null}
      <Text style={[styles.primaryButtonText, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  tone = "light",
}: {
  icon: ComponentProps<typeof MaterialIcons>["name"];
  onPress: () => void;
  label?: string;
  tone?: "light" | "dark";
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label ?? icon} style={[styles.iconButton, tone === "dark" && styles.iconButtonDark]}>
      <MaterialIcons name={icon} size={20} color={tone === "dark" ? palette.white : palette.evergreen} />
    </Pressable>
  );
}

export function StatusPill({ status }: { status: OrderStatus }) {
  const color = orderStatusColor(status);
  return (
    <View style={[styles.statusPill, { backgroundColor: color.bg }]}>
      <View style={[styles.statusDot, { backgroundColor: color.fg }]} />
      <Text style={[styles.statusText, { color: color.fg }]}>{orderStatusLabel(status)}</Text>
    </View>
  );
}

export function MoneyLine({ label, value, emphasized = false, currency = "IDR" }: { label: string; value: number; emphasized?: boolean; currency?: CurrencyCode }) {
  return (
    <View style={styles.moneyLine}>
      <Text style={[styles.moneyLabel, emphasized && styles.moneyEmphasized]}>{label}</Text>
      <Text style={[styles.moneyValue, emphasized && styles.moneyEmphasized]}>{money(value, currency)}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, body }: { icon: ComponentProps<typeof MaterialIcons>["name"]; title: string; body: string }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}><MaterialIcons name={icon} size={25} color={palette.evergreen} /></View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function paymentIcon(method: PaymentMethod): ComponentProps<typeof MaterialIcons>["name"] {
  return method === "Cash" ? "payments" : method === "Card" ? "credit-card" : method === "QRIS" ? "qr-code-scanner" : method === "Gift Card" ? "card-giftcard" : "account-balance-wallet";
}

const styles = StyleSheet.create({
  wordmark: { flexDirection: "row", alignItems: "center", gap: 9 },
  brandImage: { width: 34, height: 34, borderRadius: 12, backgroundColor: palette.evergreen },
  brandTitle: { color: palette.evergreen, fontSize: 11, fontWeight: "900", letterSpacing: 1.35 },
  brandCaption: { marginTop: 1, color: palette.muted, fontSize: 8, fontWeight: "700", letterSpacing: 1.25 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 },
  pageHeaderMain: { flex: 1 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: "800", letterSpacing: 1.6, marginBottom: 5 },
  pageTitle: { color: palette.ink, fontSize: 28, lineHeight: 33, fontWeight: "800", letterSpacing: -0.8 },
  pageSubtitle: { color: palette.muted, fontSize: 13, marginTop: 5, lineHeight: 18 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 20, marginBottom: 11 },
  sectionTitle: { color: palette.ink, fontSize: 16, fontWeight: "800", letterSpacing: -0.25 },
  sectionAction: { color: palette.evergreen, fontSize: 12, fontWeight: "800" },
  card: { backgroundColor: palette.surface, borderRadius: 18, borderColor: palette.line, borderWidth: 1, padding: 15 },
  pill: { minHeight: 38, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center" },
  pillSelected: { borderColor: palette.evergreen, backgroundColor: palette.evergreen },
  pillText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  pillTextSelected: { color: palette.white },
  pillCount: { backgroundColor: "#F0F1EC", minWidth: 19, height: 19, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  pillCountSelected: { backgroundColor: "rgba(255,255,255,0.2)" },
  pillCountText: { color: palette.muted, fontSize: 10, fontWeight: "800" },
  pillCountTextSelected: { color: palette.white },
  primaryButton: { minHeight: 52, paddingHorizontal: 16, borderRadius: 15, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  primaryButtonText: { fontSize: 14, fontWeight: "800", letterSpacing: 0.1 },
  disabled: { opacity: 0.48 },
  pressed: { transform: [{ scale: 0.985 }], opacity: 0.9 },
  iconButton: { width: 40, height: 40, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center" },
  iconButtonDark: { backgroundColor: palette.evergreen, borderColor: palette.evergreen },
  statusPill: { flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 9, paddingVertical: 6, borderRadius: 12 },
  statusDot: { width: 6, height: 6, borderRadius: 4 },
  statusText: { fontSize: 10, fontWeight: "800" },
  moneyLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginVertical: 5 },
  moneyLabel: { color: palette.muted, fontSize: 12 },
  moneyValue: { color: palette.ink, fontSize: 12, fontWeight: "700" },
  moneyEmphasized: { color: palette.ink, fontSize: 15, fontWeight: "900" },
  emptyState: { alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingVertical: 34, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 20 },
  emptyIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  emptyTitle: { fontSize: 15, color: palette.ink, fontWeight: "800", textAlign: "center" },
  emptyBody: { marginTop: 6, fontSize: 12, color: palette.muted, lineHeight: 18, textAlign: "center", maxWidth: 250 },
  divider: { height: 1, backgroundColor: palette.line, marginVertical: 8 },
});
