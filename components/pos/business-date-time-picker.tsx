import { useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { palette } from "@/components/pos/ui";
import { businessDateTimeInput, businessDateTimeToUtc } from "@/shared/promotions";

type DateTimeFieldProps = { label: string; value: Date; onChange: (value: Date) => void; timeZone: string };
type TimeFieldProps = { label: string; value: string; onChange: (value: string) => void; timeZone: string };
const browserDateTimeProps = { type: "datetime-local", step: 60 } as unknown as TextInputProps;
const browserTimeProps = { type: "time", step: 60 } as unknown as TextInputProps;

function localValue(value: Date, timeZone: string) {
  try { return businessDateTimeInput(value, timeZone).replace(" ", "T"); }
  catch { return ""; }
}

export function BusinessDateTimeField(props: DateTimeFieldProps) {
  return <DateTimeInput key={`${props.value.getTime()}-${props.timeZone}`} {...props} />;
}
function DateTimeInput({ label, value, onChange, timeZone }: DateTimeFieldProps) {
  const [draft, setDraft] = useState(() => localValue(value, timeZone));
  return <View style={styles.field}>
    <Text style={styles.label}>{label} · BUSINESS TIMEZONE · {timeZone}</Text>
    <TextInput {...browserDateTimeProps} value={draft} onChangeText={(text) => {
      setDraft(text);
      const local = text.replace("T", " ").slice(0, 16);
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(local)) {
        try { onChange(new Date(businessDateTimeToUtc(local, timeZone))); } catch { /* Keep incomplete or invalid input visible for correction. */ }
      }
    }} style={styles.input} />
  </View>;
}

export function BusinessTimeField(props: TimeFieldProps) {
  return <TimeInput key={`${props.value}-${props.timeZone}`} {...props} />;
}
function TimeInput({ label, value, onChange, timeZone }: TimeFieldProps) {
  const [draft, setDraft] = useState(value);
  return <View style={styles.field}>
    <Text style={styles.label}>{label} · BUSINESS TIMEZONE · {timeZone}</Text>
    <TextInput {...browserTimeProps} value={draft} onChangeText={(text) => {
      setDraft(text);
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) onChange(text);
    }} style={styles.input} />
  </View>;
}

const styles = StyleSheet.create({
  field: { marginTop: 10 },
  label: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.65, marginBottom: 5 },
  input: { minHeight: 41, borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, color: palette.ink, fontSize: 11 },
});
