import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

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

export const settingsPresetSchema = z
  .object({
    generalSettings: z
      .object({
        defaultProviderId: z.string().nullable(),
        providerOrder: z.array(z.string()),
        showKeyboardHints: z.boolean(),
        showUnhandledProviderEvents: z.boolean(),
        steerActiveThreadOnEnter: z.boolean(),
        streamerMode: z.boolean(),
        terminalCopyOnSelect: z.boolean().optional(),
        confirmThreadArchive: z.boolean().optional(),
        showDiagnosticEvents: z.boolean().optional(),
        keepHistoryAfterContextClear: z.boolean().optional(),
        summarizeShellCommands: z.boolean().optional(),
        providerCompletedTurnDisplay: z.record(z.string(), z.string()).optional(),
        allowFastServiceTier: z.boolean().optional(),
        telemetryEnabled: z.boolean().optional(),
        managedBranchPrefix: z.string().optional(),
        idleProviderSessionTimeoutMinutes: z.number().optional(),
        defaultMachineAccess: z.string().optional(),
        earlyAdopter: z.boolean().optional(),
      }),
    experiments: z.record(z.string(), z.boolean()),
    keybindingOverrides: z.array(keybindingOverrideSchema),
    appearance: z
      .object({
        themeId: z.string().min(1),
        faviconColor: faviconColorSchema,
      })
      .strict(),
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
    value: z.union([z.string(), z.boolean()]),
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
      "metadata",
    ]),
    action: z.enum(["add", "remove", "install", "enable", "disable", "update"]),
    target: z.string(),
    summary: z.string(),
    risk: z.enum(["configuration", "full-trust"]),
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
    warnings: z.array(z.string()),
  })
  .strict();

export type SyncPlan = z.infer<typeof syncPlanSchema>;
export type PlanChange = z.infer<typeof planChangeSchema>;

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
  })
  .strict();

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
] as const;

async function assertPresetPathsSafe(repoDir: string): Promise<void> {
  const root = resolve(repoDir);
  for (const relativePath of ["preset", ...MANAGED_PRESET_FILES]) {
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
  value: string | boolean,
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

export function buildPullPlan(args: {
  repository: string;
  branch: string;
  remoteHead: string;
  local: PresetSnapshot;
  remote: PresetSnapshot;
  warnings?: string[];
}): SyncPlan {
  const { repository, branch, remoteHead } = args;
  const local = sortSnapshot(args.local);
  const remote = sortSnapshot(args.remote);
  const changes: PlanChange[] = [];
  const warnings = [...(args.warnings ?? [])];

  const localMarketplaces = new Map(
    local.marketplaces.map((entry) => [entry.name, entry]),
  );
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
    if (current === undefined) {
      if (!isPortableInstallSource(plugin.install)) {
        warnings.push(
          `Plugin ${plugin.id} uses a machine-local source and will be skipped.`,
        );
        continue;
      }
      changes.push({
        kind: "plugin-install",
        action: "install",
        target: plugin.id,
        summary: `Install ${plugin.id} from ${plugin.install}`,
        risk: "full-trust",
      });
    } else if (current.install !== plugin.install) {
      warnings.push(
        `Plugin ${plugin.id} is installed from another source; Preset Sync will not replace it automatically.`,
      );
    }
    if (current !== undefined && current.enabled !== plugin.enabled) {
      changes.push({
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
      warnings.push(
        `Local plugin ${plugin.id} is not in the preset and will be kept installed.`,
      );
    }
  }

  const localSettingValues = new Map(
    local.pluginSettings.map((entry) => [`${entry.id}\u0000${entry.key}`, entry.value]),
  );
  const changedSettingsByPlugin = new Map<string, number>();
  for (const setting of remote.pluginSettings) {
    if (
      setting.id === SELF_PLUGIN_ID ||
      settingSafetyIssue(setting.key, setting.value) !== null
    ) {
      continue;
    }
    if (!sameJson(localSettingValues.get(`${setting.id}\u0000${setting.key}`), setting.value)) {
      changedSettingsByPlugin.set(
        setting.id,
        (changedSettingsByPlugin.get(setting.id) ?? 0) + 1,
      );
    }
  }
  for (const [pluginId, count] of [...changedSettingsByPlugin].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    changes.push({
      kind: "plugin-settings",
      action: "update",
      target: pluginId,
      summary: `Update ${count} non-secret ${plural(count, "setting", "settings")} for ${pluginId}`,
      risk: "configuration",
    });
  }

  if (!sameJson(local.settings.generalSettings, remote.settings.generalSettings)) {
    changes.push({
      kind: "general-settings",
      action: "update",
      target: "BB general settings",
      summary: "Update BB general settings",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.experiments, remote.settings.experiments)) {
    changes.push({
      kind: "experiments",
      action: "update",
      target: "BB experiments",
      summary: "Update BB experiment flags",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.keybindingOverrides, remote.settings.keybindingOverrides)) {
    changes.push({
      kind: "keybindings",
      action: "update",
      target: "Keyboard shortcuts",
      summary: "Replace keyboard shortcut overrides",
      risk: "configuration",
    });
  }
  if (!sameJson(local.settings.appearance, remote.settings.appearance)) {
    changes.push({
      kind: "appearance",
      action: "update",
      target: "Theme",
      summary: `Switch to theme ${remote.settings.appearance.themeId}`,
      risk: "configuration",
    });
  }

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
    warnings: [...new Set(warnings)],
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

  return changes.map((change) => planChangeSchema.parse(change));
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
