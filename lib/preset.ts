import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { baseEntry, decideMerge, type MergeDecision, type SyncBase } from "./merge";
import {
  GENERAL_SETTING_LABELS,
  isExperimentSynced,
  isGeneralSettingSynced,
  isPluginSettingSynced,
  type OwnershipChoices,
} from "./ownership";
import {
  EMPTY_VENDORED_MANIFEST,
  vendoredPluginId,
  type VendoredManifest,
  type VendorAppliedState,
} from "./vendor";

export const PRESET_SCHEMA_VERSION = 1 as const;
export const SELF_PLUGIN_ID = "preset-sync";

const faviconColorSchema = z.enum([
  "blue",
  "default",
  "green",
  "orange",
  "pink",
  "purple",
  "red",
  "teal",
  "yellow",
]);

const shortcutSchema = z
  .object({
    alt: z.boolean(),
    control: z.boolean(),
    key: z.string(),
    meta: z.boolean(),
    mod: z.boolean(),
    shift: z.boolean(),
  })
  .strict();

const keybindingOverrideSchema = z
  .object({
    command: z.string().min(1),
    shortcut: shortcutSchema.nullable(),
  })
  .strict();

function dropNullishFields(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v != null,
      ),
    );
  }
  return value;
}

export const settingsPresetSchema = z
  .object({
    generalSettings: z
      .object({
        defaultProviderId: z.string().nullish(),
        providerOrder: z.array(z.string()).nullish(),
        showKeyboardHints: z.boolean().nullish(),
        showUnhandledProviderEvents: z.boolean().nullish(),
        steerActiveThreadOnEnter: z.boolean().nullish(),
        streamerMode: z.boolean().nullish(),
        terminalCopyOnSelect: z.boolean().nullish(),
        confirmThreadArchive: z.boolean().nullish(),
        showDiagnosticEvents: z.boolean().nullish(),
        keepHistoryAfterContextClear: z.boolean().nullish(),
        summarizeShellCommands: z.boolean().nullish(),
        providerCompletedTurnDisplay: z
          .record(z.string(), z.string().nullable())
          .nullish(),
        allowFastServiceTier: z.boolean().nullish(),
        telemetryEnabled: z.boolean().nullish(),
        managedBranchPrefix: z.string().nullish(),
        idleProviderSessionTimeoutMinutes: z.number().nullish(),
        defaultMachineAccess: z.string().nullish(),
        earlyAdopter: z.boolean().nullish(),
      })
      .nullish()
      .transform((v) => v ?? {}),
    experiments: z
      .record(z.string(), z.boolean().nullable())
      .nullish()
      .transform((v) => v ?? {}),
    keybindingOverrides: z
      .array(keybindingOverrideSchema)
      .nullish()
      .transform((v) => (v ?? []).filter((e) => e != null)),
    appearance: z.preprocess(
      (v) => dropNullishFields(v ?? {}),
      z.object({
        themeId: z.string().min(1).default("default"),
        faviconColor: faviconColorSchema.default("default"),
      }),
    ),
  })
  .strict();

export const pluginPresetEntrySchema = z
  .object({
    id: z.string().min(1),
    install: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export const marketplacePresetEntrySchema = z
  .object({
    name: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export const pluginSettingPresetEntrySchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    value: z.union([z.string(), z.boolean(), z.number(), z.null()]),
  })
  .strict();

export const presetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
    capturedAt: z.string(),
    bbVersion: z.string(),
    settings: settingsPresetSchema,
    plugins: z.array(pluginPresetEntrySchema),
    marketplaces: z.array(marketplacePresetEntrySchema),
    pluginSettings: z.array(pluginSettingPresetEntrySchema),
  })
  .strict();

export type PresetSnapshot = z.infer<typeof presetSnapshotSchema>;
export type PluginPresetEntry = z.infer<typeof pluginPresetEntrySchema>;
export type PluginSettingPresetEntry = z.infer<
  typeof pluginSettingPresetEntrySchema
>;

export const planChangeSchema = z
  .object({
    kind: z.enum([
      "marketplace",
      "plugin-install",
      "plugin-state",
      "plugin-settings",
      "general-settings",
      "experiments",
      "keybindings",
      "appearance",
      "vendored",
      "metadata",
    ]),
    action: z.enum(["add", "remove", "install", "enable", "disable", "update"]),
    target: z.string(),
    summary: z.string(),
    risk: z.enum(["configuration", "full-trust"]),
    /** Stable id used to select single changes for a pull. */
    id: z.string().optional(),
    /** Extra explanation shown under the summary. */
    detail: z.string().optional(),
  })
  .strict();

/** Something changed both here and in the preset since the last sync. */
export const planConflictSchema = z
  .object({
    id: z.string(),
    area: z.enum(["files", "general-settings", "experiments", "plugin-settings", "keybindings", "appearance"]),
    target: z.string(),
    detail: z.string(),
  })
  .strict();

export const syncPlanSchema = z
  .object({
    repository: z.string(),
    branch: z.string(),
    remoteHead: z.string(),
    remoteCapturedAt: z.string(),
    localCapturedAt: z.string(),
    changes: z.array(planChangeSchema),
    conflicts: z.array(planConflictSchema).default([]),
    warnings: z.array(z.string()),
    /** Hash of exactly this plan; a pull with another fingerprint is refused. */
    fingerprint: z.string().default(""),
  })
  .strict();

export type SyncPlan = z.infer<typeof syncPlanSchema>;
export type PlanChange = z.infer<typeof planChangeSchema>;
export type PlanConflict = z.infer<typeof planConflictSchema>;

export const lastOperationSchema = z
  .object({
    type: z.enum(["capture", "pull", "push"]),
    at: z.string(),
    summary: z.string(),
  })
  .strict();

export type LastOperation = z.infer<typeof lastOperationSchema>;

export const syncStatusSchema = z
  .object({
    checkedAt: z.string(),
    repository: z.string(),
    branch: z.string(),
    remoteHead: z.string(),
    remoteCapturedAt: z.string(),
    localCapturedAt: z.string(),
    stagedAt: z.string().nullable(),
    changeCount: z.number().int().nonnegative(),
    pushChangeCount: z.number().int().nonnegative(),
    pullChanges: z.array(planChangeSchema),
    pushChanges: z.array(planChangeSchema),
    conflicts: z.array(planConflictSchema).default([]),
    warnings: z.array(z.string()),
    lastOperation: lastOperationSchema.nullable(),
  })
  .strict();

export const cachedSyncCheckSchema = z
  .object({
    checkedAt: z.string(),
    status: syncStatusSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const captureResultSchema = z
  .object({
    capturedAt: z.string(),
    pluginCount: z.number().int().nonnegative(),
    pluginSettingCount: z.number().int().nonnegative(),
    marketplaceCount: z.number().int().nonnegative(),
    vendoredCount: z.number().int().nonnegative().default(0),
    vendoredFileCount: z.number().int().nonnegative().default(0),
    warnings: z.array(z.string()),
  })
  .strict();

export const pushResultSchema = z
  .object({
    pushed: z.boolean(),
    head: z.string(),
    capturedAt: z.string(),
    changedFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export const applyResultSchema = z
  .object({
    ok: z.boolean(),
    plan: syncPlanSchema,
    applied: z.array(z.string()),
    skipped: z.array(z.string()),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    /** Backup run that `restore` can undo, or null when nothing changed. */
    backupRun: z.string().nullable().default(null),
  })
  .strict();

export const restoreResultSchema = z
  .object({
    run: z.string(),
    restored: z.array(z.string()),
    skipped: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .strict();

export type RestoreResult = z.infer<typeof restoreResultSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type CachedSyncCheck = z.infer<typeof cachedSyncCheckSchema>;
export type CaptureResult = z.infer<typeof captureResultSchema>;
export type PushResult = z.infer<typeof pushResultSchema>;
export type ApplyResult = z.infer<typeof applyResultSchema>;

const settingsFileSchema = settingsPresetSchema.extend({
  schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
});
const pluginsFileSchema = z
  .object({
    schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
    plugins: z.array(pluginPresetEntrySchema),
  })
  .strict();
const marketplacesFileSchema = z
  .object({
    schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
    marketplaces: z.array(marketplacePresetEntrySchema),
  })
  .strict();
const pluginSettingsFileSchema = z
  .object({
    schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
    settings: z.array(pluginSettingPresetEntrySchema),
  })
  .strict();
const metadataFileSchema = z
  .object({
    schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
    bbVersion: z.string(),
    capturedAt: z.string().optional(),
  })
  .passthrough();

export const MANAGED_PRESET_FILES = [
  "preset/settings.json",
  "preset/plugins.json",
  "preset/marketplaces.json",
  "preset/plugin-settings.json",
  "preset/metadata.json",
  "preset/vendored.json",
] as const;

async function assertPresetPathsSafe(repoDir: string): Promise<void> {
  const root = resolve(repoDir);
  for (const relativePath of ["preset", "vendored", ...MANAGED_PRESET_FILES]) {
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Preset path escapes the repository: ${relativePath}`);
    }
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        throw new Error(`Preset path must not be a symbolic link: ${relativePath}`);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function samePresetConfiguration(
  left: PresetSnapshot,
  right: PresetSnapshot,
): boolean {
  return sameJson(
    { ...sortSnapshot(left), capturedAt: "" },
    { ...sortSnapshot(right), capturedAt: "" },
  );
}

function sortSnapshot(snapshot: PresetSnapshot): PresetSnapshot {
  return {
    ...snapshot,
    plugins: [...snapshot.plugins]
      .filter((plugin) => plugin.id !== SELF_PLUGIN_ID)
      .sort((left, right) => left.id.localeCompare(right.id)),
    marketplaces: [...snapshot.marketplaces].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    pluginSettings: [...snapshot.pluginSettings]
      .filter((setting) => setting.id !== SELF_PLUGIN_ID)
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) || left.key.localeCompare(right.key),
      ),
  };
}

async function readJson(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `Preset file is missing: ${path}`
        : `Could not read preset file ${path}: ${errorMessage(cause)}`,
    );
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    throw new Error(`Preset file is not valid JSON (${path}): ${errorMessage(cause)}`);
  }
}

async function readOptionalPluginSettings(
  path: string,
): Promise<z.infer<typeof pluginSettingsFileSchema>> {
  try {
    return pluginSettingsFileSchema.parse(await readJson(path));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: PRESET_SCHEMA_VERSION, settings: [] };
    }
    if (cause instanceof Error && cause.message.includes("Preset file is missing:")) {
      return { schemaVersion: PRESET_SCHEMA_VERSION, settings: [] };
    }
    throw cause;
  }
}

function parsePresetFile<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Preset file has an invalid schema (${path}): ${details}`);
}

export async function readPresetSnapshot(repoDir: string): Promise<PresetSnapshot> {
  await assertPresetPathsSafe(repoDir);
  const presetDir = join(repoDir, "preset");
  const paths = {
    settings: join(presetDir, "settings.json"),
    plugins: join(presetDir, "plugins.json"),
    marketplaces: join(presetDir, "marketplaces.json"),
    pluginSettings: join(presetDir, "plugin-settings.json"),
    metadata: join(presetDir, "metadata.json"),
  };

  const [settingsValue, pluginsValue, marketplacesValue, metadataValue] =
    await Promise.all([
      readJson(paths.settings),
      readJson(paths.plugins),
      readJson(paths.marketplaces),
      readJson(paths.metadata),
    ]);
  const pluginSettings = await readOptionalPluginSettings(paths.pluginSettings);

  const settings = parsePresetFile(settingsFileSchema, settingsValue, paths.settings);
  const plugins = parsePresetFile(pluginsFileSchema, pluginsValue, paths.plugins);
  const marketplaces = parsePresetFile(
    marketplacesFileSchema,
    marketplacesValue,
    paths.marketplaces,
  );
  const metadata = parsePresetFile(metadataFileSchema, metadataValue, paths.metadata);

  return sortSnapshot(
    presetSnapshotSchema.parse({
      schemaVersion: PRESET_SCHEMA_VERSION,
      capturedAt: metadata.capturedAt ?? "unknown",
      bbVersion: metadata.bbVersion,
      settings: {
        generalSettings: settings.generalSettings,
        experiments: settings.experiments,
        keybindingOverrides: settings.keybindingOverrides,
        appearance: settings.appearance,
      },
      plugins: plugins.plugins,
      marketplaces: marketplaces.marketplaces,
      pluginSettings: pluginSettings.settings,
    }),
  );
}

async function writePrettyJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writePresetSnapshot(
  repoDir: string,
  rawSnapshot: PresetSnapshot,
): Promise<void> {
  const snapshot = sortSnapshot(presetSnapshotSchema.parse(rawSnapshot));
  await assertPresetPathsSafe(repoDir);
  const presetDir = join(repoDir, "preset");
  await mkdir(presetDir, { recursive: true });

  await Promise.all([
    writePrettyJson(join(presetDir, "settings.json"), {
      schemaVersion: PRESET_SCHEMA_VERSION,
      ...snapshot.settings,
    }),
    writePrettyJson(join(presetDir, "plugins.json"), {
      schemaVersion: PRESET_SCHEMA_VERSION,
      plugins: snapshot.plugins,
    }),
    writePrettyJson(join(presetDir, "marketplaces.json"), {
      schemaVersion: PRESET_SCHEMA_VERSION,
      marketplaces: snapshot.marketplaces,
    }),
    writePrettyJson(join(presetDir, "plugin-settings.json"), {
      schemaVersion: PRESET_SCHEMA_VERSION,
      settings: snapshot.pluginSettings,
    }),
    writePrettyJson(join(presetDir, "metadata.json"), {
      schemaVersion: PRESET_SCHEMA_VERSION,
      bbVersion: snapshot.bbVersion,
      capturedAt: snapshot.capturedAt,
      managedBy: "bb-plugin-preset-sync",
    }),
  ]);
}

export interface SyncScope {
  syncPlugins: boolean;
  syncMarketplaces: boolean;
  syncGeneralSettings: boolean;
  syncExperiments: boolean;
  syncKeybindings: boolean;
  syncAppearance: boolean;
  syncPluginSettings: boolean;
  syncVendoredPlugins: boolean;
  syncVendoredFiles: boolean;
  excludedPlugins: ReadonlySet<string>;
  /** General settings this machine keeps local although they sync by default. */
  excludedSettingKeys: ReadonlySet<string>;
  /** `pluginId.key` pairs this machine keeps local. */
  excludedPluginSettingKeys: ReadonlySet<string>;
  /** Default-local general settings this machine opts into sync. */
  syncedSettingKeys?: ReadonlySet<string>;
  /** Default-local `pluginId.key` pairs this machine opts into sync. */
  syncedPluginSettingKeys?: ReadonlySet<string>;
}

export const FULL_SYNC_SCOPE: SyncScope = {
  syncPlugins: true,
  syncMarketplaces: true,
  syncGeneralSettings: true,
  syncExperiments: true,
  syncKeybindings: true,
  syncAppearance: true,
  syncPluginSettings: true,
  syncVendoredPlugins: true,
  syncVendoredFiles: true,
  excludedPlugins: new Set(),
  excludedSettingKeys: new Set(),
  excludedPluginSettingKeys: new Set(),
  syncedSettingKeys: new Set(),
  syncedPluginSettingKeys: new Set(),
};

export function generalChoices(scope: SyncScope): OwnershipChoices {
  return { localKeys: scope.excludedSettingKeys, syncKeys: scope.syncedSettingKeys ?? new Set() };
}

export function pluginSettingChoices(scope: SyncScope): OwnershipChoices {
  return {
    localKeys: scope.excludedPluginSettingKeys,
    syncKeys: scope.syncedPluginSettingKeys ?? new Set(),
  };
}

export function isPluginSettingInScope(
  scope: SyncScope,
  entry: { id: string; key: string },
): boolean {
  return (
    scope.syncPluginSettings &&
    !scope.excludedPlugins.has(entry.id) &&
    isPluginSettingSynced(entry.id, entry.key, pluginSettingChoices(scope))
  );
}

function pickKeys<T>(record: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
}

export function parseIdListSetting(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  return new Set(
    value
      .split(/[,\n]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function applySyncScope(
  snapshot: PresetSnapshot,
  scope: SyncScope,
): PresetSnapshot {
  return {
    ...snapshot,
    plugins: scope.syncPlugins
      ? snapshot.plugins.filter((entry) => !scope.excludedPlugins.has(entry.id))
      : [],
    marketplaces: scope.syncMarketplaces ? snapshot.marketplaces : [],
    pluginSettings: snapshot.pluginSettings.filter((entry) =>
      isPluginSettingInScope(scope, entry),
    ),
    settings: {
      generalSettings: scope.syncGeneralSettings
        ? pickKeys(snapshot.settings.generalSettings, (key) =>
            isGeneralSettingSynced(key, generalChoices(scope)),
          )
        : {},
      experiments: scope.syncExperiments
        ? pickKeys(snapshot.settings.experiments, isExperimentSynced)
        : {},
      keybindingOverrides: scope.syncKeybindings
        ? snapshot.settings.keybindingOverrides
        : [],
      appearance: scope.syncAppearance
        ? snapshot.settings.appearance
        : { themeId: "default", faviconColor: "default" },
    },
  };
}

export interface PushMergeContext {
  /** Plugin ids and marketplace names agreed at this machine's last sync. */
  base?: { plugins?: readonly string[]; marketplaces?: readonly string[] };
  /** Every plugin installed here, also the ones the snapshot cannot record (local paths). */
  installedPluginIds?: ReadonlySet<string>;
}

/**
 * Publish this machine without erasing other machines: preset plugins and
 * marketplaces this machine does not have stay, unless it had them at the last
 * sync and removed them since.
 */
export function mergePresetForPush(
  local: PresetSnapshot,
  remote: PresetSnapshot | null,
  scope: SyncScope,
  context: PushMergeContext = {},
): PresetSnapshot {
  const remotePlugins = remote?.plugins ?? [];
  const remoteSettings = remote?.pluginSettings ?? [];
  const localPluginIds = new Set(local.plugins.map((entry) => entry.id));
  const installedHere = (id: string) =>
    localPluginIds.has(id) || (context.installedPluginIds?.has(id) ?? false);
  const basePlugins = new Set(context.base?.plugins ?? []);
  const keepRemotePlugin = (id: string) =>
    !localPluginIds.has(id) &&
    (scope.excludedPlugins.has(id) || installedHere(id) || !basePlugins.has(id));
  const localMarketplaceNames = new Set(local.marketplaces.map((entry) => entry.name));
  const baseMarketplaces = new Set(context.base?.marketplaces ?? []);
  const remoteGeneral = remote?.settings.generalSettings ?? {};
  const remoteExperiments = remote?.settings.experiments ?? {};
  // Values this machine does not sync stay as other machines published them.
  const preservedGeneralKeys = pickKeys(
    remoteGeneral,
    (key) => !isGeneralSettingSynced(key, generalChoices(scope)),
  );
  const preservedExperiments = pickKeys(remoteExperiments, (key) => !isExperimentSynced(key));
  return {
    ...local,
    plugins: scope.syncPlugins
      ? [...local.plugins, ...remotePlugins.filter((entry) => keepRemotePlugin(entry.id))]
      : remotePlugins,
    marketplaces: scope.syncMarketplaces
      ? [
          ...local.marketplaces,
          ...(remote?.marketplaces ?? []).filter(
            (entry) => !localMarketplaceNames.has(entry.name) && !baseMarketplaces.has(entry.name),
          ),
        ]
      : (remote?.marketplaces ?? []),
    pluginSettings: scope.syncPluginSettings
      ? [
          ...local.pluginSettings,
          ...remoteSettings.filter(
            (entry) =>
              (!isPluginSettingInScope(scope, entry) || keepRemotePlugin(entry.id)) &&
              !local.pluginSettings.some(
                (own) => own.id === entry.id && own.key === entry.key,
              ),
          ),
        ]
      : remoteSettings,
    settings: {
      generalSettings: scope.syncGeneralSettings
        ? { ...preservedGeneralKeys, ...local.settings.generalSettings }
        : remoteGeneral,
      experiments: scope.syncExperiments
        ? { ...preservedExperiments, ...local.settings.experiments }
        : remoteExperiments,
      keybindingOverrides: scope.syncKeybindings
        ? local.settings.keybindingOverrides
        : (remote?.settings.keybindingOverrides ?? []),
      appearance: scope.syncAppearance
        ? local.settings.appearance
        : (remote?.settings.appearance ?? {
            themeId: "default",
            faviconColor: "default",
          }),
    },
  };
}

export function syncScopeWarnings(
  scope: SyncScope,
  remote: PresetSnapshot | null,
  local: PresetSnapshot,
): string[] {
  const warnings: string[] = [];
  const remotePluginIds = new Set((remote?.plugins ?? []).map((p) => p.id));
  const localPluginIds = new Set(local.plugins.map((p) => p.id));
  for (const id of scope.excludedPlugins) {
    if (remotePluginIds.has(id)) {
      warnings.push(
        `Plugin ${id} is in the preset but excluded on this machine (kept unmanaged).`,
      );
    } else if (localPluginIds.has(id)) {
      warnings.push(
        `Local plugin ${id} is excluded and not recorded in the preset.`,
      );
    }
  }
  const remoteGeneral = remote?.settings.generalSettings ?? {};
  const generalKeys = new Set([
    ...Object.keys(remoteGeneral),
    ...Object.keys(local.settings.generalSettings),
  ]);
  for (const key of scope.excludedSettingKeys) {
    if (generalKeys.has(key)) {
      warnings.push(`General setting ${key} is excluded from sync on this machine.`);
    }
  }
  const remoteSettingKeys = new Set(
    (remote?.pluginSettings ?? []).map((e) => `${e.id}.${e.key}`),
  );
  for (const pair of scope.excludedPluginSettingKeys) {
    if (remoteSettingKeys.has(pair)) {
      warnings.push(
        `Plugin setting ${pair} is in the preset but excluded on this machine.`,
      );
    }
  }
  return warnings;
}

export function isSensitiveSettingKey(key: string): boolean {
  return /(?:api.?key|auth|credential|pass(?:word)?|private.?key|secret|token)/i.test(
    key,
  );
}

function inspectSettingValue(value: unknown): "credential-like data" | "machine-local path" | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const issue = inspectSettingValue(entry);
      if (issue !== null) return issue;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveSettingKey(key)) return "credential-like data";
      const issue = inspectSettingValue(entry);
      if (issue !== null) return issue;
    }
    return null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (
    /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/.test(trimmed) ||
    /(?:^|[\s"'=])(?:\/(?:Users|home|root|private|tmp|opt|var|usr|etc)\/|[A-Za-z]:[\\/])/.test(
      value,
    )
  ) {
    return "machine-local path";
  }
  if (
    /(?:[?&](?:access_?)?token=|authorization:\s*bearer\s+|https?:\/\/[^/@\s]+:[^/@\s]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(
      value,
    ) ||
    /(?:api.?key|pass(?:word)?|secret|token)\s*[:=]\s*["']?[^\s,}\]]+/i.test(value)
  ) {
    return "credential-like data";
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return inspectSettingValue(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  return null;
}

export function settingSafetyIssue(
  key: string,
  value: string | boolean | number | null,
): "credential-like key" | "credential-like data" | "machine-local path" | null {
  if (isSensitiveSettingKey(key)) return "credential-like key";
  return inspectSettingValue(value);
}

export function parseCatalogInstallSource(
  source: string,
): { entryId: string; marketplace?: string } | null {
  const match = /^([a-z0-9][a-z0-9._-]*)(?:@([a-z0-9][a-z0-9-]*))?$/i.exec(
    source.trim(),
  );
  if (match === null) return null;
  const entryId = match[1]!;
  const marketplace = match[2];
  return marketplace === undefined ? { entryId } : { entryId, marketplace };
}

export function isPortableInstallSource(source: string): boolean {
  const normalized = source.trim();
  return (
    /^builtin:[a-z0-9][a-z0-9._-]*$/i.test(normalized) ||
    /^npm:(?:@?[a-z0-9][a-z0-9._/-]*)(?:@[^\s]+)?$/i.test(normalized) ||
    /^https:\/\/[^\s]+$/i.test(normalized) ||
    /^ssh:\/\/[^\s]+$/i.test(normalized) ||
    /^git@[^\s:]+:[^\s]+$/i.test(normalized) ||
    /^git:(?:https?:\/\/|ssh:\/\/|git@[^\s:]+:|[a-z0-9.-]+[:/])[^\s]+$/i.test(
      normalized,
    ) ||
    parseCatalogInstallSource(normalized) !== null
  );
}

export function isPortableMarketplaceSource(source: string): boolean {
  const normalized = source.trim();
  return (
    /^https:\/\/[^\s]+$/i.test(normalized) ||
    /^git:(?:https?:\/\/|ssh:\/\/|git@[^\s:]+:|[a-z0-9.-]+[:/])[^\s]+$/i.test(
      normalized,
    )
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export interface FolderPlanSummary {
  collectionId: string;
  target: string;
  add: number;
  update: number;
  skipped: number;
  conflictPaths: string[];
  blocked?: string;
}

export interface SettingDecision {
  key: string;
  decision: MergeDecision;
  local: unknown;
  remote: unknown;
}

export interface PluginSettingDecision extends SettingDecision {
  pluginId: string;
}

export interface SettingDecisions {
  general: SettingDecision[];
  experiments: SettingDecision[];
  keybindings: SettingDecision | null;
  appearance: SettingDecision | null;
  pluginSettings: PluginSettingDecision[];
}

function settingDecision(
  key: string,
  local: unknown,
  remote: unknown,
  base: { value: unknown } | undefined,
): SettingDecision {
  return {
    key,
    local,
    remote,
    decision: decideMerge({ local, remote, base, withoutBase: "take-remote", equal: sameJson }),
  };
}

/**
 * Three-way decisions for every synced setting. Both snapshots must already be
 * scoped to this machine (applySyncScope), so local-only keys never appear.
 */
export function planSettingDecisions(args: {
  local: PresetSnapshot;
  remote: PresetSnapshot;
  base?: SyncBase;
  localPluginSettingKeys?: ReadonlyMap<string, ReadonlySet<string>>;
}): SettingDecisions {
  const { local, remote, base } = args;
  const general: SettingDecision[] = [];
  const remoteGeneral = remote.settings.generalSettings as Record<string, unknown>;
  const localGeneral = local.settings.generalSettings as Record<string, unknown>;
  for (const key of Object.keys(remoteGeneral).sort()) {
    // Legacy alias of showDiagnosticEvents; applied together with it.
    if (key === "showUnhandledProviderEvents" && "showDiagnosticEvents" in remoteGeneral) continue;
    const remoteValue = remoteGeneral[key];
    if (remoteValue === undefined) continue;
    general.push(
      settingDecision(key, localGeneral[key], remoteValue, base && baseEntry(base.general, key)),
    );
  }

  const experiments: SettingDecision[] = [];
  for (const [key, remoteValue] of Object.entries(remote.settings.experiments).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (remoteValue === null) continue;
    experiments.push(
      settingDecision(
        key,
        local.settings.experiments[key] ?? false,
        remoteValue,
        base && baseEntry(base.experiments, key),
      ),
    );
  }

  const keybindings = settingDecision(
    "keybindingOverrides",
    local.settings.keybindingOverrides,
    remote.settings.keybindingOverrides,
    base?.keybindingOverrides === undefined ? undefined : { value: base.keybindingOverrides },
  );
  const appearance = settingDecision(
    "appearance",
    local.settings.appearance,
    remote.settings.appearance,
    base?.appearance === undefined ? undefined : { value: base.appearance },
  );

  const localSettingValues = new Map(
    local.pluginSettings.map((entry) => [`${entry.id}.${entry.key}`, entry.value]),
  );
  const pluginSettings: PluginSettingDecision[] = [];
  for (const entry of remote.pluginSettings) {
    if (entry.id === SELF_PLUGIN_ID || settingSafetyIssue(entry.key, entry.value) !== null) continue;
    const knownKeys = args.localPluginSettingKeys?.get(entry.id);
    if (knownKeys !== undefined && !knownKeys.has(entry.key)) continue;
    const pair = `${entry.id}.${entry.key}`;
    pluginSettings.push({
      pluginId: entry.id,
      ...settingDecision(
        entry.key,
        localSettingValues.get(pair),
        entry.value,
        base && baseEntry(base.pluginSettings, pair),
      ),
    });
  }

  return {
    general,
    experiments,
    keybindings: keybindings.decision === "same" ? null : keybindings,
    appearance: appearance.decision === "same" ? null : appearance,
    pluginSettings,
  };
}

export function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (value === "") return "empty";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(String).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0 ? "none" : entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  }
  return String(value);
}

function settingLabel(key: string): string {
  return GENERAL_SETTING_LABELS[key] ?? key;
}

export function planFingerprint(plan: {
  remoteHead: string;
  changes: PlanChange[];
  conflicts: PlanConflict[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        remoteHead: plan.remoteHead,
        changes: plan.changes.map((change) => [change.id, change.summary, change.detail ?? ""]),
        conflicts: plan.conflicts.map((conflict) => [conflict.id, conflict.detail]),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

const FULL_TRUST_DETAIL = "Runs with full access to this machine, like every BB plugin.";

function marketplaceAndPluginChanges(
  local: PresetSnapshot,
  remote: PresetSnapshot,
  remoteVendored: VendoredManifest,
  appliedVendored: VendorAppliedState,
  changes: PlanChange[],
  warnings: string[],
  installedPluginIds: ReadonlySet<string> = new Set(),
): void {
  const vendoredPluginCollections = new Map(
    remoteVendored.collections
      .filter((entry) => entry.kind === "plugin" && entry.pluginId !== undefined)
      .map((entry) => [entry.pluginId!, entry]),
  );
  const localMarketplaces = new Map(local.marketplaces.map((entry) => [entry.name, entry]));
  for (const marketplace of remote.marketplaces) {
    const current = localMarketplaces.get(marketplace.name);
    if (current === undefined) {
      if (!isPortableMarketplaceSource(marketplace.source)) {
        warnings.push(
          `Marketplace ${marketplace.name} uses a machine-local source and will be skipped.`,
        );
        continue;
      }
      changes.push({
        id: `marketplace:${marketplace.name}`,
        kind: "marketplace",
        action: "add",
        target: marketplace.name,
        summary: `Add marketplace ${marketplace.name}`,
        risk: "configuration",
      });
    } else if (current.source !== marketplace.source) {
      warnings.push(
        `Marketplace ${marketplace.name} already exists with another source; it will be kept unchanged.`,
      );
    }
  }

  const localPlugins = new Map(local.plugins.map((entry) => [entry.id, entry]));
  const remotePluginIds = new Set(remote.plugins.map((entry) => entry.id));
  for (const plugin of remote.plugins) {
    if (plugin.id === SELF_PLUGIN_ID) continue;
    const current = localPlugins.get(plugin.id);
    const vendoredCollection = vendoredPluginCollections.get(plugin.id);
    if (current === undefined && installedPluginIds.has(plugin.id)) {
      // Installed here from a source the preset does not record (a local folder).
      warnings.push(
        `Plugin ${plugin.id} is installed from another source; Preset Sync will not replace it automatically.`,
      );
      continue;
    }
    if (current === undefined) {
      if (vendoredPluginId(plugin.install) !== null) {
        if (vendoredCollection === undefined) {
          warnings.push(
            `Plugin ${plugin.id} is vendored but the preset is missing its payload; it will be skipped.`,
          );
          continue;
        }
        changes.push({
          id: `plugin-install:${plugin.id}`,
          kind: "plugin-install",
          action: "install",
          target: plugin.id,
          summary: `Install ${plugin.id} from vendored files (${vendoredCollection.fileCount} files)`,
          detail: FULL_TRUST_DETAIL,
          risk: "full-trust",
        });
      } else if (!isPortableInstallSource(plugin.install)) {
        warnings.push(`Plugin ${plugin.id} uses a machine-local source and will be skipped.`);
        continue;
      } else {
        changes.push({
          id: `plugin-install:${plugin.id}`,
          kind: "plugin-install",
          action: "install",
          target: plugin.id,
          summary: `Install ${plugin.id} from ${plugin.install}`,
          detail: FULL_TRUST_DETAIL,
          risk: "full-trust",
        });
      }
    } else if (
      vendoredPluginId(plugin.install) !== null &&
      current.install === plugin.install &&
      vendoredCollection !== undefined &&
      appliedVendored.collections[vendoredCollection.id]?.hash !== vendoredCollection.hash
    ) {
      changes.push({
        id: `vendored:${plugin.id}`,
        kind: "vendored",
        action: "update",
        target: plugin.id,
        summary: `Update vendored plugin ${plugin.id} (${vendoredCollection.fileCount} files)`,
        risk: "full-trust",
      });
    } else if (current.install !== plugin.install) {
      warnings.push(
        `Plugin ${plugin.id} is installed from another source; Preset Sync will not replace it automatically.`,
      );
    }
    if (current !== undefined && current.enabled !== plugin.enabled) {
      changes.push({
        id: `plugin-state:${plugin.id}`,
        kind: "plugin-state",
        action: plugin.enabled ? "enable" : "disable",
        target: plugin.id,
        summary: `${plugin.enabled ? "Enable" : "Disable"} plugin ${plugin.id}`,
        risk: "configuration",
      });
    }
  }
  for (const plugin of local.plugins) {
    if (!remotePluginIds.has(plugin.id) && plugin.id !== SELF_PLUGIN_ID) {
      warnings.push(`Local plugin ${plugin.id} is not in the preset and will be kept installed.`);
    }
  }
}

function folderChanges(
  args: {
    folders?: FolderPlanSummary[];
    remoteVendored: VendoredManifest;
    appliedVendored: VendorAppliedState;
  },
  changes: PlanChange[],
  conflicts: PlanConflict[],
  warnings: string[],
): void {
  if (args.folders === undefined) {
    // Without a per-file scan only the collection hash can tell what changed.
    for (const collection of args.remoteVendored.collections) {
      if (collection.kind !== "files") continue;
      const applied = args.appliedVendored.collections[collection.id];
      if (applied?.hash === collection.hash) continue;
      changes.push({
        id: `files:${collection.id}`,
        kind: "vendored",
        action: applied === undefined ? "add" : "update",
        target: collection.id,
        summary: `${applied === undefined ? "Sync" : "Update"} ${collection.fileCount} ${plural(collection.fileCount, "file", "files")} to ${collection.target}`,
        risk: "configuration",
      });
    }
    return;
  }
  for (const folder of args.folders) {
    if (folder.blocked !== undefined) {
      warnings.push(`Folder ${folder.target} is skipped: ${folder.blocked}.`);
    }
    if (folder.add + folder.update > 0) {
      const parts = [
        folder.add > 0 ? `${folder.add} new` : null,
        folder.update > 0 ? `${folder.update} updated` : null,
      ].filter((part): part is string => part !== null);
      changes.push({
        id: `files:${folder.collectionId}`,
        kind: "vendored",
        action: folder.update > 0 ? "update" : "add",
        target: folder.collectionId,
        summary: `Sync ${folder.target}: ${parts.join(", ")} ${plural(folder.add + folder.update, "file", "files")}`,
        // RPC results must be plain JSON: omit the key instead of sending undefined.
        ...(folder.update > 0
          ? {
              detail:
                "Updated files were not edited on this machine since the last sync. Replaced files are backed up for restore.",
            }
          : {}),
        risk: "configuration",
      });
    }
    for (const path of folder.conflictPaths) {
      conflicts.push({
        id: `conflict:files:${folder.collectionId}:${path}`,
        area: "files",
        target: `${folder.target}/${path}`,
        detail: "Changed here and in the preset since the last sync. Your version is kept until you choose.",
      });
    }
  }
}

function settingChanges(
  decisions: SettingDecisions,
  local: PresetSnapshot,
  remote: PresetSnapshot,
  changes: PlanChange[],
  conflicts: PlanConflict[],
): void {
  const both = (decision: SettingDecision) =>
    `This machine: ${describeValue(decision.local)} · Preset: ${describeValue(decision.remote)}`;

  const pluginSettingChanges = new Map<string, string[]>();
  for (const decision of decisions.pluginSettings) {
    if (decision.decision === "take-remote") {
      const lines = pluginSettingChanges.get(decision.pluginId) ?? [];
      lines.push(`${decision.key}: ${describeValue(decision.local)} → ${describeValue(decision.remote)}`);
      pluginSettingChanges.set(decision.pluginId, lines);
    } else if (decision.decision === "conflict") {
      conflicts.push({
        id: `conflict:plugin-settings:${decision.pluginId}.${decision.key}`,
        area: "plugin-settings",
        target: `${decision.pluginId}: ${decision.key}`,
        detail: both(decision),
      });
    }
  }
  for (const [pluginId, lines] of [...pluginSettingChanges].sort(([a], [b]) => a.localeCompare(b))) {
    changes.push({
      id: `plugin-settings:${pluginId}`,
      kind: "plugin-settings",
      action: "update",
      target: pluginId,
      summary: `Update ${lines.length} non-secret ${plural(lines.length, "setting", "settings")} for ${pluginId}`,
      detail: lines.join("; "),
      risk: "configuration",
    });
  }

  for (const decision of decisions.general) {
    if (decision.decision === "take-remote") {
      changes.push({
        id: `general:${decision.key}`,
        kind: "general-settings",
        action: "update",
        target: decision.key,
        summary: `${settingLabel(decision.key)}: ${describeValue(decision.local)} → ${describeValue(decision.remote)}`,
        risk: "configuration",
      });
    } else if (decision.decision === "conflict") {
      conflicts.push({
        id: `conflict:general:${decision.key}`,
        area: "general-settings",
        target: settingLabel(decision.key),
        detail: both(decision),
      });
    }
  }
  for (const decision of decisions.experiments) {
    if (decision.decision === "take-remote") {
      changes.push({
        id: `experiment:${decision.key}`,
        kind: "experiments",
        action: decision.remote === true ? "enable" : "disable",
        target: decision.key,
        summary: `Experiment ${decision.key}: ${describeValue(decision.local)} → ${describeValue(decision.remote)}`,
        risk: "configuration",
      });
    } else if (decision.decision === "conflict") {
      conflicts.push({
        id: `conflict:experiment:${decision.key}`,
        area: "experiments",
        target: `Experiment ${decision.key}`,
        detail: both(decision),
      });
    }
  }
  if (decisions.keybindings?.decision === "take-remote") {
    changes.push({
      id: "keybindings",
      kind: "keybindings",
      action: "update",
      target: "Keyboard shortcuts",
      summary: "Replace keyboard shortcut overrides",
      risk: "configuration",
    });
  } else if (decisions.keybindings?.decision === "conflict") {
    conflicts.push({
      id: "conflict:keybindings",
      area: "keybindings",
      target: "Keyboard shortcuts",
      detail: "Shortcut overrides changed here and in the preset since the last sync.",
    });
  }
  if (decisions.appearance?.decision === "take-remote") {
    changes.push({
      id: "appearance",
      kind: "appearance",
      action: "update",
      target: "Theme",
      summary: `Switch to theme ${remote.settings.appearance.themeId}`,
      risk: "configuration",
    });
  } else if (decisions.appearance?.decision === "conflict") {
    conflicts.push({
      id: "conflict:appearance",
      area: "appearance",
      target: "Theme",
      detail: `This machine: ${local.settings.appearance.themeId} · Preset: ${remote.settings.appearance.themeId}`,
    });
  }
}

export function buildPullPlan(args: {
  repository: string;
  branch: string;
  remoteHead: string;
  local: PresetSnapshot;
  remote: PresetSnapshot;
  remoteVendored?: VendoredManifest;
  appliedVendored?: VendorAppliedState;
  warnings?: string[];
  base?: SyncBase;
  /** Per-file folder plans; when given they replace the hash-only folder check. */
  folders?: FolderPlanSummary[];
  localPluginSettingKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every plugin installed here, also the ones the snapshot cannot record. */
  installedPluginIds?: ReadonlySet<string>;
}): SyncPlan {
  const { repository, branch, remoteHead } = args;
  const local = sortSnapshot(args.local);
  const remote = sortSnapshot(args.remote);
  const remoteVendored = args.remoteVendored ?? EMPTY_VENDORED_MANIFEST;
  const appliedVendored = args.appliedVendored ?? { collections: {} };
  const changes: PlanChange[] = [];
  const conflicts: PlanConflict[] = [];
  const warnings = [...(args.warnings ?? [])];

  marketplaceAndPluginChanges(
    local,
    remote,
    remoteVendored,
    appliedVendored,
    changes,
    warnings,
    args.installedPluginIds,
  );
  folderChanges({ folders: args.folders, remoteVendored, appliedVendored }, changes, conflicts, warnings);
  const decisions = planSettingDecisions({
    local,
    remote,
    base: args.base,
    localPluginSettingKeys: args.localPluginSettingKeys,
  });
  settingChanges(decisions, local, remote, changes, conflicts);

  if (remote.bbVersion !== local.bbVersion) {
    warnings.push(
      `Preset was captured with BB ${remote.bbVersion}; this machine runs BB ${local.bbVersion}.`,
    );
  }

  return syncPlanSchema.parse({
    repository,
    branch,
    remoteHead,
    remoteCapturedAt: remote.capturedAt,
    localCapturedAt: local.capturedAt,
    changes,
    conflicts,
    warnings: [...new Set(warnings)],
    fingerprint: planFingerprint({ remoteHead, changes, conflicts }),
  });
}

function sortedKeys<T>(left: Map<string, T>, right: Map<string, T>): string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Describe what a fresh push would change in the managed Git preset. */
export function buildPushChanges(
  localSnapshot: PresetSnapshot,
  remoteSnapshot: PresetSnapshot,
  vendored?: { local?: VendoredManifest; remote?: VendoredManifest },
): PlanChange[] {
  const local = sortSnapshot(localSnapshot);
  const remote = sortSnapshot(remoteSnapshot);
  const changes: PlanChange[] = [];

  const localMarketplaces = new Map(
    local.marketplaces.map((entry) => [entry.name, entry]),
  );
  const remoteMarketplaces = new Map(
    remote.marketplaces.map((entry) => [entry.name, entry]),
  );
  for (const name of sortedKeys(localMarketplaces, remoteMarketplaces)) {
    const next = localMarketplaces.get(name);
    const current = remoteMarketplaces.get(name);
    if (next !== undefined && current === undefined) {
      changes.push({
        kind: "marketplace",
        action: "add",
        target: name,
        summary: `Add marketplace ${name} to the preset`,
        risk: "configuration",
      });
    } else if (next === undefined && current !== undefined) {
      changes.push({
        kind: "marketplace",
        action: "remove",
        target: name,
        summary: `Remove marketplace ${name} from the preset`,
        risk: "configuration",
      });
    } else if (next !== undefined && current !== undefined && next.source !== current.source) {
      changes.push({
        kind: "marketplace",
        action: "update",
        target: name,
        summary: `Update marketplace ${name} source in the preset`,
        risk: "configuration",
      });
    }
  }

  const localPlugins = new Map(local.plugins.map((entry) => [entry.id, entry]));
  const remotePlugins = new Map(remote.plugins.map((entry) => [entry.id, entry]));
  for (const id of sortedKeys(localPlugins, remotePlugins)) {
    const next = localPlugins.get(id);
    const current = remotePlugins.get(id);
    if (next !== undefined && current === undefined) {
      changes.push({
        kind: "plugin-install",
        action: "add",
        target: id,
        summary: `Add plugin ${id} to the preset`,
        risk: "full-trust",
      });
      continue;
    }
    if (next === undefined && current !== undefined) {
      changes.push({
        kind: "plugin-install",
        action: "remove",
        target: id,
        summary: `Remove plugin ${id} from the preset`,
        risk: "configuration",
      });
      continue;
    }
    if (next === undefined || current === undefined) continue;
    if (next.install !== current.install) {
      changes.push({
        kind: "plugin-install",
        action: "update",
        target: id,
        summary: `Update plugin ${id} source in the preset`,
        risk: "full-trust",
      });
    }
    if (next.enabled !== current.enabled) {
      changes.push({
        kind: "plugin-state",
        action: next.enabled ? "enable" : "disable",
        target: id,
        summary: `Record plugin ${id} as ${next.enabled ? "enabled" : "disabled"}`,
        risk: "configuration",
      });
    }
  }

  const localSettings = new Map(
    local.pluginSettings.map((entry) => [
      `${entry.id}\u0000${entry.key}`,
      entry,
    ]),
  );
  const remoteSettings = new Map(
    remote.pluginSettings.map((entry) => [
      `${entry.id}\u0000${entry.key}`,
      entry,
    ]),
  );
  const changedSettingsByPlugin = new Map<string, number>();
  for (const key of sortedKeys(localSettings, remoteSettings)) {
    const next = localSettings.get(key);
    const current = remoteSettings.get(key);
    if (!sameJson(next?.value, current?.value)) {
      const pluginId = (next ?? current)?.id;
      if (pluginId !== undefined) {
        changedSettingsByPlugin.set(
          pluginId,
          (changedSettingsByPlugin.get(pluginId) ?? 0) + 1,
        );
      }
    }
  }
  for (const [pluginId, count] of [...changedSettingsByPlugin].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    changes.push({
      kind: "plugin-settings",
      action: "update",
      target: pluginId,
      summary: `Update ${count} captured ${plural(count, "setting", "settings")} for ${pluginId}`,
      risk: "configuration",
    });
  }

  if (!sameJson(local.settings.generalSettings, remote.settings.generalSettings)) {
    changes.push({
      kind: "general-settings",
      action: "update",
      target: "BB general settings",
      summary: "Update BB general settings in the preset",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.experiments, remote.settings.experiments)) {
    changes.push({
      kind: "experiments",
      action: "update",
      target: "BB experiments",
      summary: "Update BB experiment flags in the preset",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.keybindingOverrides, remote.settings.keybindingOverrides)) {
    changes.push({
      kind: "keybindings",
      action: "update",
      target: "Keyboard shortcuts",
      summary: "Update keyboard shortcut overrides in the preset",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.appearance, remote.settings.appearance)) {
    changes.push({
      kind: "appearance",
      action: "update",
      target: "Theme",
      summary: `Record theme ${local.settings.appearance.themeId} in the preset`,
      risk: "configuration",
    });
  }
  if (local.bbVersion !== remote.bbVersion) {
    changes.push({
      kind: "metadata",
      action: "update",
      target: "BB version",
      summary: `Record BB ${local.bbVersion} in preset metadata`,
      risk: "configuration",
    });
  }

  if (vendored !== undefined) {
    const localCollections = new Map(
      (vendored.local?.collections ?? []).map((entry) => [entry.id, entry]),
    );
    const remoteCollections = new Map(
      (vendored.remote?.collections ?? []).map((entry) => [entry.id, entry]),
    );
    for (const id of sortedKeys(localCollections, remoteCollections)) {
      const next = localCollections.get(id);
      const current = remoteCollections.get(id);
      const label =
        (next ?? current)?.kind === "plugin"
          ? `vendored plugin ${(next ?? current)?.pluginId ?? id}`
          : `vendored files ${id}`;
      if (next !== undefined && current === undefined) {
        changes.push({
          kind: "vendored",
          action: "add",
          target: id,
          summary: `Add ${label} to the preset (${next.fileCount} files)`,
          risk: "configuration",
        });
      } else if (next === undefined && current !== undefined) {
        changes.push({
          kind: "vendored",
          action: "remove",
          target: id,
          summary: `Remove ${label} from the preset`,
          risk: "configuration",
        });
      } else if (
        next !== undefined &&
        current !== undefined &&
        next.hash !== current.hash
      ) {
        changes.push({
          kind: "vendored",
          action: "update",
          target: id,
          summary: `Update ${label} in the preset (${next.fileCount} files)`,
          risk: "configuration",
        });
      }
    }
  }

  return changes.map((change) => planChangeSchema.parse(change));
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
