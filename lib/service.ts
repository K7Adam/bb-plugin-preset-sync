import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  buildPullPlan,
  buildPushChanges,
  cachedSyncCheckSchema,
  errorMessage,
  isPortableInstallSource,
  isPortableMarketplaceSource,
  isSensitiveSettingKey,
  lastOperationSchema,
  parseCatalogInstallSource,
  presetSnapshotSchema,
  sameJson,
  settingSafetyIssue,
  SELF_PLUGIN_ID,
  type LastOperation,
  type CachedSyncCheck,
  type PluginSettingPresetEntry,
  type PresetSnapshot,
  type SyncPlan,
  applySyncScope,
  mergePresetForPush,
  parseIdListSetting,
  syncScopeWarnings,
  type SyncScope,
} from "./preset";
import { pushRemotePreset, readRemotePreset } from "./git";
import {
  VENDORED_PLUGIN_PRESERVE_NAMES,
  VendorError,
  collectionIdForPath,
  expandHome,
  isValidVendoredId,
  isValidVendoredRepoDir,
  materializeVendoredFiles,
  parseGlobList,
  prepareVendoredPlugin,
  readVendorState,
  recordVendorApplied,
  toHomeRelative,
  vendorConflictMode,
  vendoredBackupRoot,
  vendoredInstallSource,
  vendoredPluginDir,
  vendoredPluginId,
  vendoredTrashRoot,
  walkVendoredSource,
  type VendoredCollection,
  type VendoredManifest,
} from "./vendor";
import { lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SyncSettings {
  repositoryUrl: string;
  branch: string;
  githubToken?: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  includePluginSettings: boolean;
  backgroundCheckInterval: string;
  syncPlugins: boolean;
  syncMarketplaces: boolean;
  syncGeneralSettings: boolean;
  syncExperiments: boolean;
  syncKeybindings: boolean;
  syncAppearance: boolean;
  syncVendoredPlugins: boolean;
  syncVendoredFiles: boolean;
  vendoredPaths: string;
  vendorExcludeGlobs: string;
  vendorConflictMode: string;
  vendorPruneExtras: boolean;
  vendorNpmInstall: boolean;
  vendorMaxFileKb: number;
  vendorMaxCollectionMb: number;
  excludedPlugins: string;
  excludedSettingKeys: string;
  excludedPluginSettingKeys: string;
}

function scopeFromSettings(settings: SyncSettings): SyncScope {
  return {
    syncPlugins: settings.syncPlugins,
    syncMarketplaces: settings.syncMarketplaces,
    syncGeneralSettings: settings.syncGeneralSettings,
    syncExperiments: settings.syncExperiments,
    syncKeybindings: settings.syncKeybindings,
    syncAppearance: settings.syncAppearance,
    syncPluginSettings: settings.includePluginSettings,
    syncVendoredPlugins: settings.syncVendoredPlugins,
    syncVendoredFiles: settings.syncVendoredFiles,
    excludedPlugins: parseIdListSetting(settings.excludedPlugins),
    excludedSettingKeys: parseIdListSetting(settings.excludedSettingKeys),
    excludedPluginSettingKeys: parseIdListSetting(
      settings.excludedPluginSettingKeys,
    ),
  };
}

interface CapturedPreset {
  snapshot: PresetSnapshot;
  warnings: string[];
  /** Collections whose payloads this machine can publish (live sources). */
  vendored: VendoredCollection[];
  /** Absolute source directory for each collection id this machine captured. */
  vendoredSourceDirs: Map<string, string>;
}

interface StagedPreset extends CapturedPreset {
  stagedAt: string;
}

interface StagedPresetStored {
  snapshot: unknown;
  warnings?: unknown;
  stagedAt: unknown;
  vendored?: unknown;
  vendoredSourceDirs?: unknown;
}

const STAGED_KEY = "staged-preset-v1";
const LAST_OPERATION_KEY = "last-operation-v1";
const CACHED_CHECK_KEY = "cached-check-v1";
const MAX_STAGED_BYTES = 240 * 1024;
const DEFAULT_BACKGROUND_INTERVAL_MS = 5 * 60 * 1_000;
const ALLOWED_BACKGROUND_INTERVALS = new Set([1, 5, 10, 15, 30, 60]);

type SystemConfig = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["config"]>>;

function pluginInstallSpec(plugin: Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>["plugins"][number]): string {
  if (plugin.source.startsWith("builtin:")) return plugin.source;
  if (plugin.catalogEntryId !== undefined && plugin.catalogMarketplaceName !== undefined) {
    return `${plugin.catalogEntryId}@${plugin.catalogMarketplaceName}`;
  }
  return plugin.source;
}

function pluginPathSource(
  plugin: Awaited<
    ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>
  >["plugins"][number],
): string | null {
  return plugin.source.startsWith("path:") ? plugin.source.slice(5) : null;
}

/** Keep vendored collections that are inside this machine's sync scope. */
export function applyVendoredScope(
  collections: VendoredCollection[],
  scope: SyncScope,
): VendoredCollection[] {
  return collections.filter((collection) =>
    collection.kind === "plugin"
      ? scope.syncVendoredPlugins &&
          !scope.excludedPlugins.has(collection.pluginId ?? collection.id)
      : scope.syncVendoredFiles,
  );
}

/**
 * Merge local and remote collections for a push. Local in-scope collections
 * win; out-of-scope or foreign-owned remote collections are preserved so a
 * push never erases another machine's payloads.
 */
export function mergeVendoredForPush(args: {
  local: VendoredCollection[];
  remote: VendoredManifest | null;
  mergedPlugins: { id: string; install: string; enabled: boolean }[];
  scope: SyncScope;
}): VendoredCollection[] {
  const remoteCollections = args.remote?.collections ?? [];
  const localIds = new Set(args.local.map((entry) => entry.id));
  const referencedPluginIds = new Set(
    args.mergedPlugins
      .map((entry) => vendoredPluginId(entry.install))
      .filter((id): id is string => id !== null),
  );
  const merged = [...args.local];
  for (const collection of remoteCollections) {
    if (localIds.has(collection.id)) continue;
    if (collection.kind === "plugin") {
      const pluginId = collection.pluginId ?? collection.id;
      if (
        !args.scope.syncVendoredPlugins ||
        args.scope.excludedPlugins.has(pluginId)
      ) {
        merged.push(collection);
        continue;
      }
      // In scope: keep the remote payload only while a merged plugin entry
      // still references it (it may be owned by another machine).
      if (referencedPluginIds.has(pluginId)) merged.push(collection);
      continue;
    }
    merged.push(collection);
  }
  return merged;
}

export async function installPluginFromPreset(
  bb: BbPluginApi,
  source: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const catalogTarget = parseCatalogInstallSource(source);
  if (catalogTarget === null) {
    return bb.sdk.plugins.install({ source });
  }

  const plan = await bb.sdk.plugins.catalog.installPlan({
    ...catalogTarget,
    signal,
  });
  if (!plan.compatible) {
    throw new Error(
      plan.incompatibleReason ?? `Catalog plugin ${catalogTarget.entryId} is incompatible`,
    );
  }

  if (plan.kind === "marketplace") {
    const unresolvedReason = plan.resolvedSource.unresolvedReason;
    if (unresolvedReason !== undefined) {
      throw new Error(unresolvedReason);
    }
    return bb.sdk.plugins.catalog.install({
      ...catalogTarget,
      confirmedSource: plan.resolvedSource,
    });
  }

  return bb.sdk.plugins.catalog.install(catalogTarget);
}

function settingValueMatchesDescriptor(
  descriptor: { type: string; options?: string[] },
  value: string | boolean | number,
): boolean {
  if (descriptor.type === "boolean") return typeof value === "boolean";
  if (descriptor.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (typeof value !== "string") {
    // Number values stored against string descriptors (CLI-set overrides)
    // round-trip as JSON, which is safe to sync.
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (descriptor.type === "string" || descriptor.type === "project")
    );
  }
  if (descriptor.type === "select") return descriptor.options?.includes(value) ?? false;
  return descriptor.type === "string" || descriptor.type === "project";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function backgroundIntervalMs(value: string): number | null {
  if (value === "Off") return null;
  const minutes = Number.parseInt(value, 10);
  return ALLOWED_BACKGROUND_INTERVALS.has(minutes)
    ? minutes * 60 * 1_000
    : DEFAULT_BACKGROUND_INTERVAL_MS;
}

function cachedCheckFingerprint(check: CachedSyncCheck | null): unknown {
  if (check === null) return null;
  if (check.error !== null) return { error: check.error };
  const status = check.status;
  if (status === null) return { error: null, status: null };
  return {
    error: null,
    status: {
      repository: status.repository,
      branch: status.branch,
      remoteHead: status.remoteHead,
      remoteCapturedAt: status.remoteCapturedAt,
      stagedAt: status.stagedAt,
      changeCount: status.changeCount,
      pushChangeCount: status.pushChangeCount,
      pullChanges: status.pullChanges,
      pushChanges: status.pushChanges,
      warnings: status.warnings,
    },
  };
}

export class PresetSyncService {
  private operationTail: Promise<void> = Promise.resolve();
  private backgroundWake: (() => void) | null = null;
  private backgroundWakePending = false;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly getSettings: () => Promise<SyncSettings>,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readStaged(): Promise<StagedPreset | null> {
    const value = await this.bb.storage.kv.get<StagedPresetStored>(STAGED_KEY);
    if (value === undefined) return null;
    const vendored = Array.isArray(value.vendored)
      ? (value.vendored as VendoredCollection[])
      : [];
    const sourceDirs =
      value.vendoredSourceDirs !== null &&
      typeof value.vendoredSourceDirs === "object"
        ? new Map(
            Object.entries(value.vendoredSourceDirs as Record<string, string>),
          )
        : new Map<string, string>();
    return {
      snapshot: presetSnapshotSchema.parse(value.snapshot),
      warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
      stagedAt: String(value.stagedAt),
      vendored,
      vendoredSourceDirs: sourceDirs,
    };
  }

  private async readLastOperation(): Promise<LastOperation | null> {
    const value = await this.bb.storage.kv.get<LastOperation>(LAST_OPERATION_KEY);
    if (value === undefined) return null;
    const parsed = lastOperationSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  async cachedCheck(): Promise<CachedSyncCheck | null> {
    const value = await this.bb.storage.kv.get<unknown>(CACHED_CHECK_KEY);
    if (value === undefined) return null;
    const parsed = cachedSyncCheckSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private async writeCachedCheck(check: CachedSyncCheck): Promise<void> {
    const previous = await this.cachedCheck();
    await this.bb.storage.kv.set(CACHED_CHECK_KEY, check);
    if (!sameJson(cachedCheckFingerprint(previous), cachedCheckFingerprint(check))) {
      this.bb.realtime.publish("preset-sync-state", {
        checkedAt: check.checkedAt,
        hasError: check.error !== null,
        pullCount: check.status?.changeCount ?? 0,
        pushCount: check.status?.pushChangeCount ?? 0,
      });
    }
  }

  private async writeLastOperation(operation: LastOperation): Promise<void> {
    await this.bb.storage.kv.set(LAST_OPERATION_KEY, operation);
    this.bb.realtime.publish("preset-sync-changed", operation);
  }

  private async remoteSettings(): Promise<SyncSettings> {
    const settings = await this.getSettings();
    const repositoryUrl = settings.repositoryUrl.trim();
    if (repositoryUrl === "") {
      throw new Error(
        'Preset repository is not configured. Set "Preset repository" in Settings → Plugins → Preset Sync.',
      );
    }
    return {
      ...settings,
      repositoryUrl,
      branch: settings.branch.trim() || "main",
    };
  }

  private async captureSnapshot(signal?: AbortSignal): Promise<CapturedPreset> {
    const [config, pluginList, marketplaces, version] = await Promise.all([
      this.bb.sdk.system.config({ signal }),
      this.bb.sdk.plugins.list({ signal }),
      this.bb.sdk.plugins.marketplaces.list({ signal }),
      this.bb.sdk.system.version({ force: false, signal }),
    ]);
    const settings = await this.getSettings();
    const scope = scopeFromSettings(settings);
    const warnings: string[] = [];

    const vendored: VendoredCollection[] = [];
    const vendoredSourceDirs = new Map<string, string>();
    const excludeGlobs = parseGlobList(settings.vendorExcludeGlobs);
    const maxFileBytes = Math.max(1, settings.vendorMaxFileKb) * 1024;
    const maxBytes = Math.max(1, settings.vendorMaxCollectionMb) * 1024 * 1024;

    const plugins: { id: string; install: string; enabled: boolean }[] = [];
    for (const plugin of pluginList.plugins) {
      if (plugin.id === SELF_PLUGIN_ID) continue;
      const install = pluginInstallSpec(plugin);
      const pathSource = pluginPathSource(plugin);

      // A plugin installed from Preset Sync's managed vendored directory is a
      // pull artifact, not a local source: normalize its install spec so the
      // source comparison stays symmetric, but never re-vendor it.
      if (
        pathSource !== null &&
        resolve(pathSource) === resolve(vendoredPluginDir(plugin.id))
      ) {
        plugins.push({
          id: plugin.id,
          install: vendoredInstallSource(plugin.id),
          enabled: plugin.enabled,
        });
        continue;
      }

      if (isPortableInstallSource(install)) {
        plugins.push({ id: plugin.id, install, enabled: plugin.enabled });
        continue;
      }

      if (
        pathSource !== null &&
        scope.syncVendoredPlugins &&
        !scope.excludedPlugins.has(plugin.id) &&
        isValidVendoredId(plugin.id)
      ) {
        try {
          const walk = await walkVendoredSource(pathSource, {
            maxFileBytes,
            maxBytes,
            excludeGlobs,
          });
          if (walk.entries.length === 0) {
            warnings.push(
              `Skipped local-path plugin ${plugin.id}: no vendorable files.`,
            );
            continue;
          }
          for (const skip of walk.skipped) {
            warnings.push(
              `Vendored plugin ${plugin.id}: skipped ${skip.path} (${skip.reason}).`,
            );
          }
          vendored.push({
            id: plugin.id,
            kind: "plugin",
            pluginId: plugin.id,
            repoDir: `vendored/plugins/${plugin.id}`,
            hash: walk.hash,
            fileCount: walk.entries.length,
            bytes: walk.bytes,
            entries: walk.entries,
          });
          vendoredSourceDirs.set(plugin.id, resolve(pathSource));
          plugins.push({
            id: plugin.id,
            install: vendoredInstallSource(plugin.id),
            enabled: plugin.enabled,
          });
          continue;
        } catch (cause) {
          warnings.push(
            `Skipped local-path plugin ${plugin.id}: ${errorMessage(cause)}`,
          );
          continue;
        }
      }

      warnings.push(`Skipped local-path plugin ${plugin.id}.`);
    }

    if (scope.syncVendoredFiles) {
      const collectionIds = new Set(vendored.map((entry) => entry.id));
      for (const configured of parseIdListSetting(settings.vendoredPaths)) {
        const absolute = expandHome(configured);
        const homeRelative = toHomeRelative(absolute);
        if (homeRelative === null || homeRelative === "~") {
          warnings.push(
            `Skipped vendored path ${configured}: only directories inside your home folder are portable.`,
          );
          continue;
        }
        try {
          const walk = await walkVendoredSource(absolute, {
            maxFileBytes,
            maxBytes,
            excludeGlobs,
          });
          if (walk.entries.length === 0) {
            warnings.push(
              `Skipped vendored path ${configured}: no vendorable files.`,
            );
            continue;
          }
          for (const skip of walk.skipped) {
            warnings.push(
              `Vendored ${homeRelative}: skipped ${skip.path} (${skip.reason}).`,
            );
          }
          let id = collectionIdForPath(homeRelative);
          for (let suffix = 2; collectionIds.has(id); suffix += 1) {
            id = `${collectionIdForPath(homeRelative)}-${suffix}`;
          }
          collectionIds.add(id);
          vendored.push({
            id,
            kind: "files",
            repoDir: `vendored/files/${id}`,
            target: homeRelative,
            hash: walk.hash,
            fileCount: walk.entries.length,
            bytes: walk.bytes,
            entries: walk.entries,
          });
          vendoredSourceDirs.set(id, absolute);
        } catch (cause) {
          if (
            cause instanceof VendorError &&
            cause.message.includes("does not exist")
          ) {
            continue; // Optional paths like ~/.claude/skills may not exist.
          }
          warnings.push(
            `Skipped vendored path ${configured}: ${errorMessage(cause)}`,
          );
        }
      }
    }

    const portableMarketplaces = marketplaces.flatMap((marketplace) => {
      if (marketplace.official) return [];
      if (!isPortableMarketplaceSource(marketplace.source)) {
        warnings.push(`Skipped local-path marketplace ${marketplace.name}.`);
        return [];
      }
      return [{ name: marketplace.name, source: marketplace.source }];
    });

    const pluginSettings: PluginSettingPresetEntry[] = [];
    if (settings.includePluginSettings) {
      const captured = await Promise.all(
        pluginList.plugins
          .filter((plugin) => plugin.id !== SELF_PLUGIN_ID && plugin.hasSettings)
          .map(async (plugin) => {
            try {
              const response = await this.bb.sdk.plugins.getSettings({
                pluginId: plugin.id,
                signal,
              });
              return Object.entries(response.schema).flatMap(([key, descriptor]) => {
                const value = response.values[key];
                const syncable =
                  typeof value === "string" ||
                  typeof value === "boolean" ||
                  (typeof value === "number" && Number.isFinite(value));
                const safetyIssue =
                  typeof value === "string" || typeof value === "boolean"
                    ? settingSafetyIssue(key, value)
                    : null;
                if (
                  ("secret" in descriptor && descriptor.secret === true) ||
                  isSensitiveSettingKey(key) ||
                  safetyIssue !== null
                ) {
                  if (
                    safetyIssue !== null &&
                    !("secret" in descriptor && descriptor.secret === true)
                  ) {
                    warnings.push(
                      `Skipped ${plugin.id}.${key}: ${safetyIssue}.`,
                    );
                  }
                  return [];
                }
                if (!syncable || !settingValueMatchesDescriptor(descriptor, value as string | boolean | number)) return [];
                return [{ id: plugin.id, key, value: value as string | boolean | number }];
              });
            } catch (cause) {
              warnings.push(
                `Could not read non-secret settings for ${plugin.id}: ${errorMessage(cause)}`,
              );
              return [];
            }
          }),
      );
      pluginSettings.push(...captured.flat());
    }

    const snapshot = presetSnapshotSchema.parse({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      bbVersion: version.currentVersion,
      settings: {
        generalSettings: config.generalSettings,
        experiments: config.experiments,
        keybindingOverrides: config.keybindingOverrides,
        appearance: {
          themeId: config.appearance.themeId,
          faviconColor: config.appearance.faviconColor,
        },
      },
      plugins,
      marketplaces: portableMarketplaces,
      pluginSettings,
    });
    warnings.push(...syncScopeWarnings(scope, null, snapshot));
    return {
      snapshot: applySyncScope(snapshot, scope),
      vendored,
      vendoredSourceDirs,
      warnings: unique(warnings),
    };
  }

  private async remoteAndLocal(signal?: AbortSignal): Promise<{
    remote: Awaited<ReturnType<typeof readRemotePreset>>;
    remoteScoped: Awaited<ReturnType<typeof readRemotePreset>>;
    local: CapturedPreset;
    appliedVendored: Awaited<ReturnType<typeof readVendorState>>;
    scope: SyncScope;
    settings: SyncSettings;
  }> {
    const settings = await this.remoteSettings();
    const [remote, local, appliedVendored] = await Promise.all([
      readRemotePreset({
        repositoryUrl: settings.repositoryUrl,
        branch: settings.branch,
        githubToken: settings.githubToken,
        signal,
      }),
      this.captureSnapshot(signal),
      readVendorState(),
    ]);
    const scope = scopeFromSettings(settings);
    return {
      remote,
      remoteScoped: {
        ...remote,
        snapshot: applySyncScope(remote.snapshot, scope),
        vendored: {
          schemaVersion: 1,
          collections: applyVendoredScope(remote.vendored.collections, scope),
        },
      },
      local: {
        ...local,
        warnings: [
          ...local.warnings,
          ...(remote.vendoredWarning !== undefined
            ? [remote.vendoredWarning]
            : []),
          ...syncScopeWarnings(scope, remote.snapshot, local.snapshot),
        ],
      },
      appliedVendored,
      scope,
      settings,
    };
  }

  private pullPlan(args: {
    remoteScoped: Awaited<ReturnType<typeof readRemotePreset>>;
    local: CapturedPreset;
    appliedVendored: Awaited<ReturnType<typeof readVendorState>>;
    settings: SyncSettings;
  }): SyncPlan {
    const { remoteScoped, local, appliedVendored, settings } = args;
    return buildPullPlan({
      repository: settings.repositoryUrl,
      branch: settings.branch,
      remoteHead: remoteScoped.head,
      local: local.snapshot,
      remote: remoteScoped.snapshot,
      remoteVendored: remoteScoped.vendored,
      appliedVendored,
      warnings: local.warnings,
    });
  }

  async preview(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => {
      const { remoteScoped, local, appliedVendored, settings } =
        await this.remoteAndLocal(signal);
      return this.pullPlan({ remoteScoped, local, appliedVendored, settings });
    });
  }

  async status(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remote, remoteScoped, local, appliedVendored, scope, settings } =
        await this.remoteAndLocal(signal);
      const plan = this.pullPlan({
        remoteScoped,
        local,
        appliedVendored,
        settings,
      });
      const [staged, lastOperation] = await Promise.all([
        this.readStaged(),
        this.readLastOperation(),
      ]);
      const mergedPlugins = mergePresetForPush(
        local.snapshot,
        remote.snapshot,
        scope,
      ).plugins;
      const pushChanges = buildPushChanges(
        mergePresetForPush(local.snapshot, remote.snapshot, scope),
        remote.snapshot,
        {
          local: {
            schemaVersion: 1,
            collections: mergeVendoredForPush({
              local: applyVendoredScope(local.vendored, scope),
              remote: remote.vendored,
              mergedPlugins,
              scope,
            }),
          },
          remote: remote.vendored,
        },
      );
      const checkedAt = new Date().toISOString();
      const status = {
        checkedAt,
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remote.head,
        remoteCapturedAt: remote.snapshot.capturedAt,
        localCapturedAt: local.snapshot.capturedAt,
        stagedAt: staged?.stagedAt ?? null,
        changeCount: plan.changes.length,
        pushChangeCount: pushChanges.length,
        pullChanges: plan.changes,
        pushChanges,
        warnings: plan.warnings,
        lastOperation,
      };
      await this.writeCachedCheck({ checkedAt, status, error: null });
      return status;
    });
  }

  async checkInBackground(signal?: AbortSignal): Promise<void> {
    try {
      await this.status(signal);
    } catch (cause) {
      if (signal?.aborted) return;
      const checkedAt = new Date().toISOString();
      const previous = await this.cachedCheck();
      const error = errorMessage(cause);
      await this.writeCachedCheck({
        checkedAt,
        status: previous?.status ?? null,
        error,
      });
      if (previous?.error !== error) {
        this.bb.log.warn(`Background check failed: ${error}`);
      }
    }
  }

  wakeBackgroundCheck(): void {
    if (this.backgroundWake !== null) {
      this.backgroundWake();
    } else {
      this.backgroundWakePending = true;
    }
  }

  private waitForBackgroundWake(
    signal: AbortSignal,
    delayMs: number | null,
  ): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    if (this.backgroundWakePending) {
      this.backgroundWakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.backgroundWake === finish) this.backgroundWake = null;
        resolve();
      };
      this.backgroundWake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (delayMs !== null) timer = setTimeout(finish, delayMs);
    });
  }

  async runBackgroundChecks(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const settings = await this.getSettings();
      const delayMs = backgroundIntervalMs(settings.backgroundCheckInterval);
      if (delayMs !== null && settings.repositoryUrl.trim() !== "") {
        await this.checkInBackground(signal);
      }
      if (signal.aborted) return;
      await this.waitForBackgroundWake(signal, delayMs);
    }
  }

  private async stage(captured: CapturedPreset): Promise<StagedPreset> {
    // File entry lists live only until the next push; staging stores just the
    // collection headers to stay within the kv size budget.
    const staged: StagedPreset = {
      snapshot: captured.snapshot,
      warnings: captured.warnings,
      vendored: captured.vendored.map((collection) => ({
        ...collection,
        entries: [],
      })),
      vendoredSourceDirs: captured.vendoredSourceDirs,
      stagedAt: new Date().toISOString(),
    };
    const storable = {
      ...staged,
      vendoredSourceDirs: Object.fromEntries(captured.vendoredSourceDirs),
    };
    const bytes = Buffer.byteLength(JSON.stringify(storable), "utf8");
    if (bytes > MAX_STAGED_BYTES) {
      throw new Error(
        `Captured preset is ${bytes} bytes; the safe staging limit is ${MAX_STAGED_BYTES} bytes.`,
      );
    }
    await this.bb.storage.kv.set(STAGED_KEY, storable);
    return staged;
  }

  async capture() {
    return this.exclusive(async () => {
      const staged = await this.stage(await this.captureSnapshot());
      await this.writeLastOperation({
        type: "capture",
        at: staged.stagedAt,
        summary: `Captured ${staged.snapshot.plugins.length} plugins`,
      });
      return {
        capturedAt: staged.snapshot.capturedAt,
        pluginCount: staged.snapshot.plugins.length,
        pluginSettingCount: staged.snapshot.pluginSettings.length,
        marketplaceCount: staged.snapshot.marketplaces.length,
        vendoredCount: staged.vendored.length,
        vendoredFileCount: staged.vendored.reduce(
          (sum, collection) => sum + collection.fileCount,
          0,
        ),
        warnings: staged.warnings,
      };
    });
  }

  /**
   * Rebuild full vendored collections (entries + hashes) for a push. Fresh
   * captures reuse their walk results; staged collections re-walk their live
   * source so the preset always publishes the current on-disk state.
   */
  private async rebuildVendoredForPush(
    staged: StagedPreset,
    settings: SyncSettings,
    scope: SyncScope,
    signal?: AbortSignal,
  ): Promise<{
    collections: VendoredCollection[];
    sourceDirs: Map<string, string>;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const collections: VendoredCollection[] = [];
    const sourceDirs = new Map<string, string>();
    const excludeGlobs = parseGlobList(settings.vendorExcludeGlobs);
    const maxFileBytes = Math.max(1, settings.vendorMaxFileKb) * 1024;
    const maxBytes = Math.max(1, settings.vendorMaxCollectionMb) * 1024 * 1024;

    let pluginById: Map<
      string,
      Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>["plugins"][number]
    > | null = null;

    for (const collection of applyVendoredScope(staged.vendored, scope)) {
      const knownSource = staged.vendoredSourceDirs.get(collection.id);
      if (collection.entries.length > 0 && knownSource !== undefined) {
        collections.push(collection);
        sourceDirs.set(collection.id, knownSource);
        continue;
      }

      let sourceDir: string | undefined;
      if (collection.kind === "files") {
        sourceDir =
          collection.target !== undefined
            ? expandHome(collection.target)
            : undefined;
      } else {
        pluginById ??= new Map(
          (await this.bb.sdk.plugins.list({ signal })).plugins.map((plugin) => [
            plugin.id,
            plugin,
          ]),
        );
        const plugin = pluginById.get(collection.pluginId ?? collection.id);
        const pathSource = plugin === undefined ? null : pluginPathSource(plugin);
        sourceDir = pathSource === null ? undefined : resolve(pathSource);
      }
      if (sourceDir === undefined) {
        warnings.push(
          `Cannot resolve a source directory for vendored ${collection.id}; keeping the remote payload unchanged.`,
        );
        continue;
      }
      try {
        const walk = await walkVendoredSource(sourceDir, {
          maxFileBytes,
          maxBytes,
          excludeGlobs,
        });
        collections.push({
          ...collection,
          hash: walk.hash,
          fileCount: walk.entries.length,
          bytes: walk.bytes,
          entries: walk.entries,
        });
        sourceDirs.set(collection.id, sourceDir);
        for (const skip of walk.skipped) {
          warnings.push(`Vendored ${collection.id}: skipped ${skip.path} (${skip.reason}).`);
        }
      } catch (cause) {
        warnings.push(
          `Vendored ${collection.id} is unavailable (${errorMessage(cause)}); keeping the remote payload unchanged.`,
        );
      }
    }
    return { collections, sourceDirs, warnings };
  }

  async push(args: { fresh: boolean; message?: string; signal?: AbortSignal }) {
    return this.exclusive(async () => {
      const settings = await this.remoteSettings();
      let staged = await this.readStaged();
      if (args.fresh || staged === null) {
        if (!args.fresh && staged === null) {
          throw new Error('No staged preset. Run "bb preset capture" or use "bb preset push --fresh".');
        }
        staged = await this.stage(await this.captureSnapshot(args.signal));
      }
      const scope = scopeFromSettings(settings);
      let remoteSnapshot: PresetSnapshot | null = null;
      let remoteVendored: VendoredManifest | null = null;
      try {
        const remote = await readRemotePreset({
          repositoryUrl: settings.repositoryUrl,
          branch: settings.branch,
          githubToken: settings.githubToken,
          signal: args.signal,
        });
        remoteSnapshot = remote.snapshot;
        remoteVendored = remote.vendored;
      } catch {
        remoteSnapshot = null;
        remoteVendored = null;
      }
      const mergedSnapshot = mergePresetForPush(
        staged.snapshot,
        remoteSnapshot,
        scope,
      );
      const rebuilt = await this.rebuildVendoredForPush(
        staged,
        settings,
        scope,
        args.signal,
      );
      const mergedVendored = mergeVendoredForPush({
        local: rebuilt.collections,
        remote: remoteVendored,
        mergedPlugins: mergedSnapshot.plugins,
        scope,
      });
      const pushed = await pushRemotePreset(
        {
          repositoryUrl: settings.repositoryUrl,
          branch: settings.branch,
          githubToken: settings.githubToken,
          authorName: settings.gitAuthorName,
          authorEmail: settings.gitAuthorEmail,
          message: args.message?.trim() || "chore: sync BB preset",
          signal: args.signal,
        },
        mergedSnapshot,
        {
          manifest: { schemaVersion: 1, collections: mergedVendored },
          sourceDirs: rebuilt.sourceDirs,
        },
      );
      // File collections just pushed were read from their own target dirs —
      // record them as applied so pull plans do not flag this machine.
      const pushedIds = new Set(
        mergedVendored.map((collection) => collection.id),
      );
      for (const collection of rebuilt.collections) {
        if (collection.kind !== "files" || !pushedIds.has(collection.id)) {
          continue;
        }
        await recordVendorApplied(collection.id, {
          hash: collection.hash,
        }).catch(() => undefined);
      }
      const at = new Date().toISOString();
      await this.writeLastOperation({
        type: "push",
        at,
        summary: pushed.pushed
          ? `Pushed ${pushed.changedFiles.length} preset files`
          : "Preset already matched GitHub",
      });
      return {
        pushed: pushed.pushed,
        head: pushed.head,
        capturedAt: staged.snapshot.capturedAt,
        changedFiles: pushed.changedFiles,
        warnings: unique([
          ...staged.warnings,
          ...rebuilt.warnings,
          ...pushed.vendoredErrors,
        ]),
      };
    });
  }

  private async runProcess(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stderr: string }> {
    // execFile cannot resolve .cmd shims on Windows.
    const executable =
      command === "npm" && process.platform === "win32" ? "npm.cmd" : command;
    try {
      const result = await execFileAsync(executable, args, {
        cwd,
        timeout: 5 * 60_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stderr: String(result.stderr ?? "") };
    } catch (cause) {
      const failure = cause as {
        code?: number | string;
        stderr?: string;
        message?: string;
      };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stderr: String(failure.stderr ?? failure.message ?? "process failed"),
      };
    }
  }

  /** Resolve a preset-declared "~/..." collection target inside the home dir. */
  private resolveVendoredTarget(target: string | undefined): string | null {
    if (target === undefined || target === "~" || !target.startsWith("~/")) {
      return null;
    }
    const resolved = expandHome(target);
    return toHomeRelative(resolved) === target ? resolved : null;
  }

  async pullAndApply(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remoteScoped, local, appliedVendored, settings } =
        await this.remoteAndLocal(signal);
      const plan = this.pullPlan({
        remoteScoped,
        local,
        appliedVendored,
        settings,
      });
      const applied: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      const warnings = [...plan.warnings];

      const attempt = async (label: string, operation: () => Promise<unknown>) => {
        try {
          await operation();
          applied.push(label);
          return true;
        } catch (cause) {
          errors.push(`${label}: ${errorMessage(cause)}`);
          return false;
        }
      };

      const currentMarketplaces = await this.bb.sdk.plugins.marketplaces.list({ signal });
      const marketplaceMap = new Map(
        currentMarketplaces.map((marketplace) => [marketplace.name, marketplace]),
      );
      for (const marketplace of remoteScoped.snapshot.marketplaces) {
        const current = marketplaceMap.get(marketplace.name);
        if (current === undefined) {
          if (!isPortableMarketplaceSource(marketplace.source)) {
            skipped.push(`Skipped local marketplace ${marketplace.name}`);
            continue;
          }
          await attempt(`Added marketplace ${marketplace.name}`, () =>
            this.bb.sdk.plugins.marketplaces.add({ source: marketplace.source }),
          );
        } else if (current.source !== marketplace.source) {
          skipped.push(`Kept marketplace ${marketplace.name} with its existing source`);
        }
      }

      // Fetch vendored payloads once when the preset carries any.
      const vendoredCollections = remoteScoped.vendored.collections;
      let vendoredPayloadDir: string | null = null;
      if (vendoredCollections.length > 0) {
        vendoredPayloadDir = await mkdtemp(join(tmpdir(), "bb-preset-pull-"));
        await readRemotePreset({
          repositoryUrl: settings.repositoryUrl,
          branch: settings.branch,
          githubToken: settings.githubToken,
          copyVendoredTo: vendoredPayloadDir,
          signal,
        });
      }
      const vendoredPayloadRoot = vendoredPayloadDir;
      let pluginList = await this.bb.sdk.plugins.list({ signal });
      let installed = new Map(
        pluginList.plugins.map((plugin) => [plugin.id, plugin]),
      );
      try {
        const conflict = vendorConflictMode(settings.vendorConflictMode);
        const collectionById = new Map(
          vendoredCollections.map((entry) => [entry.id, entry]),
        );
        const collectionByPluginId = new Map(
          vendoredCollections
            .filter((entry) => entry.kind === "plugin")
            .map((entry) => [entry.pluginId ?? entry.id, entry]),
        );
        const payloadSource = (collection: VendoredCollection) =>
          isValidVendoredRepoDir(collection.repoDir)
            ? join(
                vendoredPayloadRoot ?? "",
                ...collection.repoDir.replace(/^vendored\//, "").split("/"),
              )
            : null;

        // File collections: materialize into their declared home-relative target.
        for (const collection of vendoredCollections) {
          if (collection.kind !== "files") continue;
          if (
            !isValidVendoredId(collection.id) ||
            payloadSource(collection) === null
          ) {
            errors.push(
              `Vendored ${collection.id}: invalid collection metadata`,
            );
            continue;
          }
          const targetDir = this.resolveVendoredTarget(collection.target);
          const sourceDir = payloadSource(collection);
          if (targetDir === null || sourceDir === null) {
            errors.push(
              `Vendored ${collection.id}: unsafe target ${collection.target ?? "?"}`,
            );
            continue;
          }
          const previouslyApplied = appliedVendored.collections[collection.id];
          const targetExists = await lstat(targetDir)
            .then((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .catch(() => false);
          if (previouslyApplied?.hash === collection.hash && targetExists) {
            skipped.push(`Vendored ${collection.id} is already current`);
            continue;
          }
          await attempt(
            `Synced ${collection.fileCount} files to ${collection.target}`,
            async () => {
              const result = await materializeVendoredFiles({
                sourceDir,
                entries: collection.entries,
                targetDir,
                conflict,
                pruneExtras: settings.vendorPruneExtras,
                backupRoot: join(vendoredBackupRoot(), collection.id),
              });
              if (result.errors.length > 0) {
                throw new Error(result.errors.slice(0, 3).join("; "));
              }
              for (const note of result.skipped) {
                warnings.push(`Vendored ${collection.id}: skipped ${note}.`);
              }
              await recordVendorApplied(collection.id, {
                hash: collection.hash,
                target: collection.target,
              });
            },
          );
        }

        // Vendored plugins: materialize into the managed dir, then install or
        // update in place so plugin settings survive refreshes.
        for (const plugin of remoteScoped.snapshot.plugins) {
          if (plugin.id === SELF_PLUGIN_ID) continue;
          // The install sentinel must carry this exact plugin id — anything
          // else is a malformed or hostile entry.
          if (vendoredPluginId(plugin.install) !== plugin.id) continue;
          const collection = collectionByPluginId.get(plugin.id);
          const pluginSourceDir =
            collection === undefined ? null : payloadSource(collection);
          if (
            collection === undefined ||
            pluginSourceDir === null ||
            !isValidVendoredId(collection.id)
          ) {
            skipped.push(
              `Skipped vendored plugin ${plugin.id}: payload missing or invalid`,
            );
            continue;
          }
          const current = installed.get(plugin.id);
          if (current !== undefined) {
            const currentPath = pluginPathSource(current);
            const managed = vendoredPluginDir(plugin.id);
            if (
              currentPath === null ||
              resolve(currentPath) !== resolve(managed)
            ) {
              skipped.push(
                `Kept vendored plugin ${plugin.id} installed from its existing source`,
              );
              continue;
            }
          }
          await attempt(
            `${current === undefined ? "Installed" : "Updated"} vendored plugin ${plugin.id}`,
            async () => {
              const managed = vendoredPluginDir(plugin.id);
              const managedExists = await lstat(managed)
                .then((entry) => entry.isDirectory())
                .catch(() => false);
              if (
                !managedExists ||
                appliedVendored.collections[collection.id]?.hash !==
                  collection.hash
              ) {
                const result = await materializeVendoredFiles({
                  sourceDir: pluginSourceDir,
                  entries: collection.entries,
                  targetDir: managed,
                  conflict: "overwrite",
                  pruneExtras: true,
                  backupRoot: join(
                    vendoredTrashRoot(),
                    `plugins/${collection.id}`,
                  ),
                  preserveNames: VENDORED_PLUGIN_PRESERVE_NAMES,
                });
                if (result.errors.length > 0) {
                  throw new Error(result.errors.slice(0, 3).join("; "));
                }
                await recordVendorApplied(collection.id, {
                  hash: collection.hash,
                });
              }
              if (settings.vendorNpmInstall) {
                const prepareIssue = await prepareVendoredPlugin(
                  managed,
                  (command, args, cwd) => this.runProcess(command, args, cwd),
                );
                if (prepareIssue !== null) {
                  warnings.push(`Vendored plugin ${plugin.id}: ${prepareIssue}.`);
                }
              }
              if (current === undefined) {
                await this.bb.sdk.plugins.install({
                  source: `path:${managed}`,
                });
              } else {
                await this.bb.sdk.plugins
                  .applyUpdate({ pluginId: plugin.id })
                  .catch(() =>
                    this.bb.sdk.plugins.reload({ pluginId: plugin.id }),
                  );
              }
            },
          );
        }

        pluginList = await this.bb.sdk.plugins.list({ signal });
        installed = new Map(
          pluginList.plugins.map((plugin) => [plugin.id, plugin]),
        );

        for (const plugin of remoteScoped.snapshot.plugins) {
          if (plugin.id === SELF_PLUGIN_ID || installed.has(plugin.id)) continue;
          if (vendoredPluginId(plugin.install) !== null) {
            skipped.push(`Skipped vendored plugin ${plugin.id}`);
            continue;
          }
          if (!isPortableInstallSource(plugin.install)) {
            skipped.push(`Skipped local-path plugin ${plugin.id}`);
            continue;
          }
          await attempt(`Installed plugin ${plugin.id}`, () =>
            installPluginFromPreset(this.bb, plugin.install, signal),
          );
        }
      } finally {
        if (vendoredPayloadRoot !== null) {
          await rm(vendoredPayloadRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          }).catch(() => undefined);
        }
      }

      pluginList = await this.bb.sdk.plugins.list({ signal });
      installed = new Map(pluginList.plugins.map((plugin) => [plugin.id, plugin]));

      const desiredSettings = new Map<string, PluginSettingPresetEntry[]>();
      for (const entry of remoteScoped.snapshot.pluginSettings) {
        if (
          entry.id === SELF_PLUGIN_ID ||
          settingSafetyIssue(entry.key, entry.value) !== null
        ) {
          continue;
        }
        const entries = desiredSettings.get(entry.id) ?? [];
        entries.push(entry);
        desiredSettings.set(entry.id, entries);
      }
      const settingsUpdated = new Set<string>();
      for (const [pluginId, entries] of desiredSettings) {
        if (!installed.has(pluginId)) {
          skipped.push(`Skipped settings for missing plugin ${pluginId}`);
          continue;
        }
        try {
          const response = await this.bb.sdk.plugins.getSettings({ pluginId, signal });
          const values: Record<string, string | boolean | number> = {};
          for (const entry of entries) {
            const descriptor = response.schema[entry.key];
            if (
              entry.value === null ||
              descriptor === undefined ||
              ("secret" in descriptor && descriptor.secret === true) ||
              settingSafetyIssue(entry.key, entry.value) !== null ||
              !settingValueMatchesDescriptor(descriptor, entry.value)
            ) {
              skipped.push(`Skipped unsafe or unknown setting ${pluginId}.${entry.key}`);
              continue;
            }
            if (!sameJson(response.values[entry.key], entry.value)) {
              values[entry.key] = entry.value;
            }
          }
          if (Object.keys(values).length > 0) {
            const ok = await attempt(
              `Updated ${Object.keys(values).length} settings for ${pluginId}`,
              () => this.bb.sdk.plugins.updateSettings({ pluginId, values }),
            );
            if (ok) settingsUpdated.add(pluginId);
          }
        } catch (cause) {
          errors.push(`Settings for ${pluginId}: ${errorMessage(cause)}`);
        }
      }

      const desiredPluginMap = new Map(
        remoteScoped.snapshot.plugins.map((plugin) => [plugin.id, plugin]),
      );
      for (const [pluginId, desired] of desiredPluginMap) {
        if (pluginId === SELF_PLUGIN_ID) continue;
        const current = installed.get(pluginId);
        if (current === undefined) continue;
        if (current.enabled !== desired.enabled) {
          await attempt(
            `${desired.enabled ? "Enabled" : "Disabled"} plugin ${pluginId}`,
            () =>
              desired.enabled
                ? this.bb.sdk.plugins.enable({ pluginId })
                : this.bb.sdk.plugins.disable({ pluginId }),
          );
        } else if (desired.enabled && settingsUpdated.has(pluginId)) {
          await attempt(`Reloaded plugin ${pluginId}`, () =>
            this.bb.sdk.plugins.reload({ pluginId }),
          );
        }
      }

      if (!sameJson(local.snapshot.settings.generalSettings, remoteScoped.snapshot.settings.generalSettings)) {
        await attempt("Updated BB general settings", () =>
          this.bb.sdk.system.updateGeneralSettings(
            remoteScoped.snapshot.settings.generalSettings as SystemConfig["generalSettings"],
          ),
        );
      }
      if (!sameJson(local.snapshot.settings.experiments, remoteScoped.snapshot.settings.experiments)) {
        await attempt("Updated BB experiments", () =>
          this.bb.sdk.system.updateExperiments(
            remoteScoped.snapshot.settings.experiments as SystemConfig["experiments"],
          ),
        );
      }
      if (
        !sameJson(
          local.snapshot.settings.keybindingOverrides,
          remoteScoped.snapshot.settings.keybindingOverrides,
        )
      ) {
        await attempt("Updated keyboard shortcuts", () =>
          this.bb.sdk.system.updateKeyboardSettings(
            remoteScoped.snapshot.settings
              .keybindingOverrides as SystemConfig["keybindingOverrides"],
          ),
        );
      }
      if (!sameJson(local.snapshot.settings.appearance, remoteScoped.snapshot.settings.appearance)) {
        await attempt("Updated BB theme", () =>
          this.bb.sdk.theme.set(remoteScoped.snapshot.settings.appearance),
        );
      }

      const at = new Date().toISOString();
      const ok = errors.length === 0;
      await this.writeLastOperation({
        type: "pull",
        at,
        summary: ok
          ? `Applied ${applied.length} changes from GitHub`
          : `Applied ${applied.length} changes with ${errors.length} errors`,
      });
      return {
        ok,
        plan,
        applied,
        skipped,
        errors,
        warnings: unique(warnings),
      };
    });
  }
}
