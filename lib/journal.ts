import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { syncBaseSchema, type SyncBase } from "./merge";
import { resolveWithin, vendoredBackupRoot, type VendorAppliedState } from "./vendor";

/**
 * Every pull that changes something writes one journal run:
 * ~/.bb/preset-vendored/backup/<run>/ holds copies of the files it replaced
 * (laid out like the home folder, for example skills/a.md) and restore.json
 * records what changed so `restore` can undo exactly this pull.
 */

const JOURNAL_FILE = "restore.json";
const RESTORED_FILE = "restored.json";

const journalFileSchema = z
  .object({
    target: z.string(),
    path: z.string(),
    hadFile: z.boolean(),
    writtenSha: z.string(),
  })
  .strict();

/** A setting the pull changed: its value before and the value the pull wrote. */
const settingChangeSchema = z.object({ previous: z.unknown(), applied: z.unknown() }).strict();
export type SettingChange = z.infer<typeof settingChangeSchema>;

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    createdAt: z.string(),
    files: z.array(journalFileSchema),
    general: z.record(z.string(), settingChangeSchema).default({}),
    experiments: z.record(z.string(), settingChangeSchema).default({}),
    keybindingOverrides: settingChangeSchema.optional(),
    appearance: settingChangeSchema.optional(),
    /** pluginId -> key -> change */
    pluginSettings: z.record(z.string(), z.record(z.string(), settingChangeSchema)).default({}),
    installedPlugins: z.array(z.string()).default([]),
    previousBase: syncBaseSchema,
    previousFolderState: z.record(z.string(), z.unknown()),
  })
  .strict();

export type JournalData = z.infer<typeof journalSchema>;
export type JournalFile = z.infer<typeof journalFileSchema>;

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

/** "~/skills" becomes "skills", the folder layout inside a backup run. */
export function backupLabel(target: string): string {
  return target.replace(/^~\/?/, "") || "home";
}

export class PullJournal {
  readonly runId = newRunId();
  readonly dir = join(vendoredBackupRoot(), this.runId);
  private readonly data: JournalData;

  constructor(previousBase: SyncBase, previousFolderState: VendorAppliedState["collections"]) {
    this.data = {
      schemaVersion: 1,
      runId: this.runId,
      createdAt: new Date().toISOString(),
      files: [],
      general: {},
      experiments: {},
      pluginSettings: {},
      installedPlugins: [],
      previousBase,
      previousFolderState,
    };
  }

  /** Copy the current file aside before the pull replaces it. */
  async backupFile(target: string, absolute: string, rel: string): Promise<void> {
    const backupPath = resolveWithin(join(this.dir, backupLabel(target)), rel);
    await mkdir(dirname(backupPath), { recursive: true });
    await cp(absolute, backupPath, { force: false, errorOnExist: true });
  }

  recordFile(entry: JournalFile): void {
    this.data.files.push(entry);
  }

  recordSetting(kind: "general" | "experiments", key: string, change: SettingChange): void {
    this.data[kind][key] = change;
  }

  recordKeybindings(change: SettingChange): void {
    this.data.keybindingOverrides = change;
  }

  recordAppearance(change: SettingChange): void {
    this.data.appearance = change;
  }

  recordPluginSetting(pluginId: string, key: string, change: SettingChange): void {
    this.data.pluginSettings[pluginId] = { ...this.data.pluginSettings[pluginId], [key]: change };
  }

  recordInstalledPlugin(pluginId: string): void {
    this.data.installedPlugins.push(pluginId);
  }

  get isEmpty(): boolean {
    const d = this.data;
    return (
      d.files.length === 0 &&
      Object.keys(d.general).length === 0 &&
      Object.keys(d.experiments).length === 0 &&
      d.keybindingOverrides === undefined &&
      d.appearance === undefined &&
      Object.keys(d.pluginSettings).length === 0 &&
      d.installedPlugins.length === 0
    );
  }

  async save(): Promise<boolean> {
    if (this.isEmpty) return false;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, JOURNAL_FILE), `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    return true;
  }
}

/** The most recent pull that has not been restored yet. */
export async function latestJournal(): Promise<{ dir: string; data: JournalData } | null> {
  const root = vendoredBackupRoot();
  const runs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const run of runs) {
    const dir = join(root, run);
    const raw = await readFile(join(dir, JOURNAL_FILE), "utf8").catch(() => null);
    if (raw === null) continue;
    const parsed = journalSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { dir, data: parsed.data };
  }
  return null;
}

export async function markRestored(dir: string): Promise<void> {
  await rename(join(dir, JOURNAL_FILE), join(dir, RESTORED_FILE));
}
