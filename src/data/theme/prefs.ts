import { logWarn } from "@schema/log.ts";
import { SCHEMA_VERSION } from "@schema/version.ts";
import { z } from "zod";
import { isNotFound, resolveDir } from "../opfs.ts";

// Theme preference persisted in OPFS (`settings/theme.json`), schemaVersion-tagged like every
// persisted artifact. Best-effort by design — a preference, not data: environments without OPFS
// (Node, old Safari) read null and skip writes silently; main-thread createWritable is guarded
// (Safari <26 lacked it — the worker-confined sync-handle rule is for the field cache's hot path,
// not this one-shot boot read).

const SETTINGS_DIR = ["settings"] as const;
const THEME_FILE = "theme.json";

const ThemePrefSchema = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), name: z.string() });
type ThemePref = Readonly<z.infer<typeof ThemePrefSchema>>;

function hasOpfs(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

/** The persisted theme name, or null when unset/unreadable/foreign-schema. Never throws. */
export async function readThemePref(): Promise<string | null> {
  if (!hasOpfs()) return null;
  try {
    const dir = await resolveDir(SETTINGS_DIR);
    if (dir === undefined) return null;
    const handle = await dir.getFileHandle(THEME_FILE);
    const text = await (await handle.getFile()).text();
    const pref = ThemePrefSchema.safeParse(JSON.parse(text));
    return pref.success ? pref.data.name : null; // foreign schema / shape reads as unset, not an error
  } catch (error) {
    if (isNotFound(error)) return null;
    logWarn("theme", "pref unreadable, falling back to default", error);
    return null;
  }
}

/** Persist the theme name; silent no-op where OPFS or createWritable is unavailable. */
export async function writeThemePref(name: string): Promise<void> {
  if (!hasOpfs()) return;
  try {
    const dir = await resolveDir(SETTINGS_DIR, { create: true });
    if (dir === undefined) return;
    const handle = await dir.getFileHandle(THEME_FILE, { create: true });
    if (typeof handle.createWritable !== "function") return; // Safari <26 main thread
    const writable = await handle.createWritable();
    const pref: ThemePref = { schemaVersion: SCHEMA_VERSION, name };
    await writable.write(JSON.stringify(pref));
    await writable.close();
  } catch (error) {
    logWarn("theme", "pref write failed", error);
  }
}
