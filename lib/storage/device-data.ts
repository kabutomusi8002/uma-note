import {
  deleteLocalDatabase,
  type DeleteLocalDatabaseOptions,
  type LocalDatabase,
} from "./local-db";

export const UMA_NOTE_LOCAL_STORAGE_KEYS = [
  "uma-note:races:v1",
  "uma-note:rules:v1",
  "uma-note:active-race:v1",
  "uma-note:dirty-races:v1",
  "uma-note:settings:v1",
  "uma-note:installation-id:v1",
  "uma-note:active-owner-scope:v1",
  "uma-note:local-db:v2",
] as const;

export type EraseDeviceDataOptions = DeleteLocalDatabaseOptions & {
  database?: LocalDatabase | null;
  localStorage?: Storage | null;
};

function browserLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Removes only explicitly owned UMA NOTE browser data; never clears the origin. */
export async function eraseUmaNoteDeviceData(
  options: EraseDeviceDataOptions = {},
): Promise<void> {
  options.database?.close();
  await deleteLocalDatabase({
    ...(options.name ? { name: options.name } : {}),
    ...(options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {}),
  });

  const storage = options.localStorage === undefined
    ? browserLocalStorage()
    : options.localStorage;
  if (!storage) return;
  for (const key of UMA_NOTE_LOCAL_STORAGE_KEYS) {
    storage.removeItem(key);
  }
}
