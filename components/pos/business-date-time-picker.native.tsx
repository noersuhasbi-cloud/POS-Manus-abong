import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Card, palette, Pill } from "@/components/pos/ui";
import { businessDateTimeInput, businessDateTimeToUtc } from "@/shared/promotions";

type DateMode = "date" | "time";
type DateTimeFieldProps = { label: string; value: Date; onChange: (value: Date) => void; timeZone: string };
type TimeFieldProps = { label: string; value: string; onChange: (value: string) => void; timeZone: string };

function mergeDateTime(current: Date, selected: Date, mode: DateMode, timeZone: string) {
  const previous = businessDateTimeInput(current, timeZone);
  const picked = businessDateTimeInput(selected, timeZone);
  const local = mode === "date" ? `${picked.slice(0, 10)} ${previous.slice(11)}` : `${previous.slice(0, 10)} ${picked.slice(11)}`;
  return new Date(businessDateTimeToUtc(local, timeZone));
}

function dateForBusinessTime(value: string, timeZone: string) {
  for (let day = 0; day < 7; day++) {
    const businessDate = businessDateTimeInput(new Date(Date.now() + day * 86_400_000), timeZone).slice(0, 10);
    try { return new Date(businessDateTimeToUtc(`${businessDate} ${value}`, timeZone)); }
    catch { /* A daylight-saving gap can make today's wall time unavailable; try the next day. */ }
  }
  return new Date();
}

function localTimeFromDate(value: Date, timeZone: string) {
  return businessDateTimeInput(value, timeZone).slice(11, 16);
}

export function BusinessDateTimeField({ label, value, onChange, timeZone }: DateTimeFieldProps) {
  const [iosOpen, setIosOpen] = useState(false);
  const [iosMode, setIosMode] = useState<DateMode>("date");
  const [draft, setDraft] = useState(value);
  const local = businessDateTimeInput(value, timeZone);

  function openPicker(mode: DateMode) {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: value,
        mode,
        display: mode === "date" ? "calendar" : "clock",
        is24Hour: true,
        timeZoneName: timeZone,
        onChange: (event, selected) => {
          if (event.type !== "set" || !selected) return;
          try { onChange(mergeDateTime(value, selected, mode, timeZone)); }
          catch { /* Keep the prior value if a daylight-saving gap makes the selected wall time invalid. */ }
        },
      });
      return;
    }
    setDraft(value);
    setIosMode(mode);
    setIosOpen(true);
  }

  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.row}>
      <Pressable accessibilityRole="button" onPress={() => openPicker("date")} style={styles.valueButton}>
        <Text style={styles.valueLabel}>DATE</Text><Text style={styles.valueText}>{local.slice(0, 10)}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => openPicker("time")} style={styles.valueButton}>
        <Text style={styles.valueLabel}>TIME</Text><Text style={styles.valueText}>{local.slice(11, 16)}</Text>
      </Pressable>
    </View>
    <Text style={styles.timeZone}>Business timezone · {timeZone}</Text>
    {Platform.OS === "ios" ? <Modal visible={iosOpen} transparent animationType="slide" onRequestClose={() => setIosOpen(false)}>
      <View style={styles.backdrop}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close date and time picker" style={StyleSheet.absoluteFill} onPress={() => setIosOpen(false)} />
        <Card style={styles.sheet}>
          <Text style={styles.sheetTitle}>{label}</Text>
          <Text style={styles.timeZone}>Business timezone · {timeZone}</Text>
          <View style={styles.modeRow}><Pill label="Date" selected={iosMode === "date"} onPress={() => setIosMode("date")} /><Pill label="Time" selected={iosMode === "time"} onPress={() => setIosMode("time")} /></View>
          <DateTimePicker
            value={draft}
            mode={iosMode}
            display="spinner"
            is24Hour
            timeZoneName={timeZone}
            onChange={(_event, selected) => { if (selected) { try { setDraft(mergeDateTime(draft, selected, iosMode, timeZone)); } catch { /* Keep the previous selection for nonexistent local times. */ } } }}
          />
          <View style={styles.actions}>
            <Pressable onPress={() => setIosOpen(false)} style={styles.cancelButton}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            <Pressable onPress={() => { onChange(draft); setIosOpen(false); }} style={styles.saveButton}><Text style={styles.saveText}>Use date & time</Text></Pressable>
          </View>
        </Card>
      </View>
    </Modal> : null}
  </View>;
}

export function BusinessTimeField({ label, value, onChange, timeZone }: TimeFieldProps) {
  const [iosOpen, setIosOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  function openPicker() {
    const pickerValue = dateForBusinessTime(value || "12:00", timeZone);
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: pickerValue,
        mode: "time",
        display: "clock",
        is24Hour: true,
        timeZoneName: timeZone,
        onChange: (event, selected) => { if (event.type === "set" && selected) onChange(localTimeFromDate(selected, timeZone)); },
      });
      return;
    }
    setDraft(value || "12:00");
    setIosOpen(true);
  }

  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" onPress={openPicker} style={styles.timeButton}>
      <Text style={styles.valueText}>{value || "Choose time"}</Text>
      <Text style={styles.valueLabel}>24-HOUR · {timeZone}</Text>
    </Pressable>
    {Platform.OS === "ios" ? <Modal visible={iosOpen} transparent animationType="slide" onRequestClose={() => setIosOpen(false)}>
      <View style={styles.backdrop}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close time picker" style={StyleSheet.absoluteFill} onPress={() => setIosOpen(false)} />
        <Card style={styles.sheet}>
          <Text style={styles.sheetTitle}>{label}</Text>
          <Text style={styles.timeZone}>Business timezone · {timeZone}</Text>
          <DateTimePicker
            value={dateForBusinessTime(draft, timeZone)}
            mode="time"
            display="spinner"
            is24Hour
            timeZoneName={timeZone}
            onChange={(_event, selected) => { if (selected) setDraft(localTimeFromDate(selected, timeZone)); }}
          />
          <View style={styles.actions}>
            <Pressable onPress={() => setIosOpen(false)} style={styles.cancelButton}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            <Pressable onPress={() => { onChange(draft); setIosOpen(false); }} style={styles.saveButton}><Text style={styles.saveText}>Use time</Text></Pressable>
          </View>
        </Card>
      </View>
    </Modal> : null}
  </View>;
}

const styles = StyleSheet.create({
  field: { marginTop: 10 },
  label: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.8, marginBottom: 5 },
  row: { flexDirection: "row", gap: 8 },
  valueButton: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, paddingVertical: 7 },
  timeButton: { minHeight: 45, justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, paddingVertical: 7 },
  valueLabel: { color: palette.muted, fontSize: 7, fontWeight: "900", letterSpacing: 0.6 },
  valueText: { color: palette.ink, fontSize: 11, fontWeight: "800", marginTop: 2 },
  timeZone: { color: palette.muted, fontSize: 8, marginTop: 5 },
  backdrop: { flex: 1, justifyContent: "center", backgroundColor: "rgba(17,36,30,0.42)", padding: 18 },
  sheet: { padding: 15 },
  sheetTitle: { color: palette.ink, fontSize: 13, fontWeight: "900" },
  modeRow: { flexDirection: "row", gap: 7, marginTop: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10 },
  cancelButton: { flex: 1, minHeight: 42, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette.line, borderRadius: 11, backgroundColor: palette.surface },
  saveButton: { flex: 1, minHeight: 42, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: palette.evergreen },
  cancelText: { color: palette.muted, fontSize: 10, fontWeight: "800" },
  saveText: { color: palette.white, fontSize: 10, fontWeight: "900" },
});
