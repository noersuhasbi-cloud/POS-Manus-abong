import AsyncStorage from "@react-native-async-storage/async-storage";
import { legacySnapshotOwnerCanAccess } from "@/shared/legacy";

export const LEGACY_STORAGE_KEY = "till-table-pos:local:v1";
const LEGACY_OWNER_KEY = `${LEGACY_STORAGE_KEY}:owner-open-id`;

let ownershipQueue: Promise<unknown> = Promise.resolve();

export function legacyImportKey(openId: string) {
  return `${LEGACY_STORAGE_KEY}:imported:${encodeURIComponent(openId)}`;
}

async function bindLegacySnapshotOwnerSerially(openId: string): Promise<boolean> {
  if (!openId) return false;
  try {
    const snapshot = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (!snapshot) return true;
    const owner = await AsyncStorage.getItem(LEGACY_OWNER_KEY);
    if (owner) return legacySnapshotOwnerCanAccess(owner, openId);
    await AsyncStorage.setItem(LEGACY_OWNER_KEY, openId);
    return true;
  } catch {
    // Fail closed: storage errors must never expose an unowned local register snapshot.
    return false;
  }
}

/** Bind an existing local register snapshot to the first verified account that sees it. */
export function bindLegacySnapshotOwner(openId: string): Promise<boolean> {
  const result = ownershipQueue.then(() => bindLegacySnapshotOwnerSerially(openId));
  ownershipQueue = result.then(() => undefined, () => undefined);
  return result;
}
