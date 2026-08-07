import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  eraseUmaNoteDeviceData,
  UMA_NOTE_LOCAL_STORAGE_KEYS,
} from "../lib/storage/device-data";
import { LOCAL_DATABASE_NAME } from "../lib/storage/local-db";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function indexedDbFactory(result: "success" | "error" = "success") {
  const deleteDatabase = vi.fn((name: string) => {
    void name;
    const listeners = new Map<string, EventListener>();
    const request = {
      error: result === "error" ? new Error("delete failed") : null,
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
        if (type === result) queueMicrotask(() => listener(new Event(type)));
      },
    };
    return request as unknown as IDBOpenDBRequest;
  });
  return { deleteDatabase } as unknown as IDBFactory & { deleteDatabase: typeof deleteDatabase };
}

describe("UMA NOTE device data erasure", () => {
  it("removes only known UMA NOTE localStorage keys and its IndexedDB", async () => {
    const storage = new MemoryStorage();
    for (const key of UMA_NOTE_LOCAL_STORAGE_KEYS) storage.setItem(key, "owned");
    storage.setItem("other-site:key", "keep");
    storage.setItem("unknown-library", "keep");
    const factory = indexedDbFactory();
    const close = vi.fn();

    await eraseUmaNoteDeviceData({
      database: { name: LOCAL_DATABASE_NAME, backend: "memory", close } as never,
      localStorage: storage,
      indexedDB: factory,
    });

    expect(close).toHaveBeenCalledOnce();
    expect(factory.deleteDatabase).toHaveBeenCalledWith(LOCAL_DATABASE_NAME);
    for (const key of UMA_NOTE_LOCAL_STORAGE_KEYS) expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem("other-site:key")).toBe("keep");
    expect(storage.getItem("unknown-library")).toBe("keep");
  });

  it("reports IndexedDB deletion failure and does not claim the remaining cleanup", async () => {
    const storage = new MemoryStorage();
    storage.setItem(UMA_NOTE_LOCAL_STORAGE_KEYS[0], "owned");

    await expect(eraseUmaNoteDeviceData({
      localStorage: storage,
      indexedDB: indexedDbFactory("error"),
    })).rejects.toThrow("delete failed");
    expect(storage.getItem(UMA_NOTE_LOCAL_STORAGE_KEYS[0])).toBe("owned");
  });

  it("keeps normal logout separate and gates erasure behind the confirmation button", () => {
    const source = readFileSync("app/components/uma-note-app.tsx", "utf8");
    const logoutStart = source.indexOf("async function signOut() {");
    const logoutEnd = source.indexOf("async function confirmDeviceDataErase()", logoutStart);
    const normalLogout = source.slice(logoutStart, logoutEnd);
    expect(normalLogout).toContain("signOutFromCloud");
    expect(normalLogout).not.toContain("eraseUmaNoteDeviceData");
    expect(source).toContain("onClick={confirmDeviceDataErase}");
    expect(source).toContain("Supabase上のクラウドデータは削除されません");
  });

  it("does not contain cloud writes, delete RPCs, or origin-wide clearing", () => {
    const source = readFileSync("lib/storage/device-data.ts", "utf8");
    expect(source).not.toMatch(/\.clear\s*\(/u);
    expect(source).not.toMatch(/\.from\s*\(|\.rpc\s*\(|supabase/iu);
  });
});
