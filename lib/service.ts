import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { countFolder, planFolder, type FolderPlan } from "./folder-sync";
import { pushRemotePreset, readRemotePreset } from "./git";
import { PullJournal } from "./journal";
import { EMPTY_SYNC_BASE, syncBaseSchema, type SyncBase } from "./merge";
import { appManagedExcludes } from "./ownership";
import {
  applyResultSchema,
  applySyncScope,
  buildPullPlan,
  buildPushChanges,
  cachedSyncCheckSchema,
  errorMessage,
  isPortableInstallSource,
  isPortableMarketplaceSource,
  isSensitiveSettingKey,
  lastOperationSchema,
  mergePresetForPush,
  parseIdListSetting,
  presetSnapshotSchema,
  sameJson,
  settingSafetyIssue,
  syncScopeWarnings,
  SELF_PLUGIN_ID,
  type ApplyResult,
  type CachedSyncCheck,
  type LastOperation,
  type PluginSettingPresetEntry,
  type PresetSnapshot,
  type RestoreResult,
  type SyncPlan,
  type SyncScope,
} from "./preset";
import {
  pluginInstallSpec,
  pluginPathSource,
  settingValueMatchesDescriptor,
  type InstalledPlugin,
} from "./plugins-api";
import { applyPull, type ConflictChoice } from "./pull";
import { restoreLastPull } from "./restore";
import {
  VendorError,
  collectionIdForPath,
  expandHome,
  isValidVendoredId,
  parseGlobList,
  readVendorState,
  recordVendorApplied,
  toHomeRelative,
  vendoredInstallSource,
  vendoredPluginDir,
  vendoredPluginId,
  walkVendoredSource,
  writeVendorState,
  type VendorAppliedState,
  type VendoredCollection,
  type VendoredManifest,
} from "./vendor";

export { installPluginFromPreset } from "./plugins-api";

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
  /** Default-local general settings this machine syncs anyway. */
  syncedSettingKeys?: string;
  /** Default-local `pluginId.key` pairs this machine syncs anyway. */
  syncedPluginSettingKeys?: string;
}

export interface PullOptions {
  signal?: AbortSignal;
  /** Fingerprint of the previewed plan; a different current plan is refused. */
  expectedFingerprint?: string;
  /** Change ids to apply; all planned changes when omitted. */
  selectedChangeIds?: readonly string[];
  /** Conflict id -> choice. */
  resolutions?: Readonly<Record<string, ConflictChoice>>;
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
    excludedPluginSettingKeys: parseIdListSetting(settings.excludedPluginSettingKeys),
    syncedSettingKeys: parseIdListSetting(settings.syncedSettingKeys),
    syncedPluginSettingKeys: parseIdListSetting(settings.syncedPluginSettingKeys),
  };
}

interface CapturedPreset {
  snapshot: PresetSnapshot;
  warnings: string[];
  /** Collections whose payloads this machine can publish (live sources). */
  vendored: VendoredCollection[];
  /** Absolute source directory for each collection id this machine captured. */
  vendoredSourceDirs: Map<string, string>;
  /** Setting keys each installed plugin declares on this machine. */
  pluginSettingKeys: Map<string, Set<string>>;
}

interface StagedPreset extends Omit<CapturedPreset, "pluginSettingKeys"> {
  stagedAt: string;
}

interface StagedPresetStored {
  snapshot: unknown;
  warnings?: unknown;
  stagedAt: unknown;
  vendored?: unknown;
  vendoredSourceDirs?: unknown;
}

type RemotePreset = Awaited<ReturnType<typeof readRemotePreset>>;

interface Gathered {
  settings: SyncSettings;
  scope: SyncScope;
  remote: RemotePreset;
  remoteScoped: RemotePreset;
  local: CapturedPreset;
  applied: VendorAppliedState;
  base: SyncBase;
  folders: FolderPlan[];
  plan: SyncPlan;
}

const STAGED_KEY = "staged-preset-v1";
const LAST_OPERATION_KEY = "last-operation-v1";
const CACHED_CHECK_KEY = "cached-check-v1";
const SYNC_BASE_KEY = "sync-base-v1";
const MAX_STAGED_BYTES = 240 * 1024;
const DEFAULT_BACKGROUND_INTERVAL_MS = 5 * 60 * 1_000;
const ALLOWED_BACKGROUND_INTERVALS = new Set([1, 5, 10, 15, 30, 60]);

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
      conflicts: status.conflicts,
      warnings: status.warnings,
    },
  };
}

function folderBaseFiles(collection: VendoredCollection): Record<string, string> {
  return Object.fromEntries(collection.entries.map((entry) => [entry.path, entry.sha256]));
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

  private async readBase(): Promise<SyncBase> {
    const value = await this.bb.storage.kv.get<unknown>(SYNC_BASE_KEY);
    const parsed = syncBaseSchema.safeParse(value);
    return parsed.success ? parsed.data : structuredClone(EMPTY_SYNC_BASE);
  }

  private async writeBase(base: SyncBase): Promise<void> {
    await this.bb.storage.kv.set(SYNC_BASE_KEY, base);
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
        conflictCount: check.status?.conflicts.length ?? 0,
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

  private async captureLocalPlugin(
    plugin: InstalledPlugin,
    scope: SyncScope,
    limits: { maxFileBytes: number; maxBytes: number; excludeGlobs: string[] },
    out: {
      plugins: { id: string; install: string; enabled: boolean }[];
      vendored: VendoredCollection[];
      vendoredSourceDirs: Map<string, string>;
      warnings: string[];
    },
  ): Promise<void> {
    const install = pluginInstallSpec(plugin);
    const pathSource = pluginPathSource(plugin);

    // A plugin installed from Preset Sync's managed vendored directory is a
    // pull artifact, not a local source: normalize its install spec so the
    // source comparison stays symmetric, but never re-vendor it.
    if (pathSource !== null && resolve(pathSource) === resolve(vendoredPluginDir(plugin.id))) {
      out.plugins.push({ id: plugin.id, install: vendoredInstallSource(plugin.id), enabled: plugin.enabled });
      return;
    }
    if (isPortableInstallSource(install)) {
      out.plugins.push({ id: plugin.id, install, enabled: plugin.enabled });
      return;
    }
    if (
      pathSource === null ||
      !scope.syncVendoredPlugins ||
      scope.excludedPlugins.has(plugin.id) ||
      !isValidVendoredId(plugin.id)
    ) {
      out.warnings.push(`Skipped local-path plugin ${plugin.id}.`);
      return;
    }
    try {
      const walk = await walkVendoredSource(pathSource, limits);
      if (walk.entries.length === 0) {
        out.warnings.push(`Skipped local-path plugin ${plugin.id}: no vendorable files.`);
        return;
      }
      for (const skip of walk.skipped) {
        out.warnings.push(`Vendored plugin ${plugin.id}: skipped ${skip.path} (${skip.reason}).`);
      }
      out.vendored.push({
        id: plugin.id,
        kind: "plugin",
        pluginId: plugin.id,
        repoDir: `vendored/plugins/${plugin.id}`,
        hash: walk.hash,
        fileCount: walk.entries.length,
        bytes: walk.bytes,
        entries: walk.entries,
      });
      out.vendoredSourceDirs.set(plugin.id, resolve(pathSource));
      out.plugins.push({ id: plugin.id, install: vendoredInstallSource(plugin.id), enabled: plugin.enabled });
    } catch (cause) {
      out.warnings.push(`Skipped local-path plugin ${plugin.id}: ${errorMessage(cause)}`);
    }
  }

  private async captureFolders(
    settings: SyncSettings,
    limits: { maxFileBytes: number; maxBytes: number; excludeGlobs: string[] },
    out: {
      vendored: VendoredCollection[];
      vendoredSourceDirs: Map<string, string>;
      warnings: string[];
    },
  ): Promise<void> {
    const collectionIds = new Set(out.vendored.map((entry) => entry.id));
    for (const configured of parseIdListSetting(settings.vendoredPaths)) {
      const absolute = expandHome(configured);
      const homeRelative = toHomeRelative(absolute);
      if (homeRelative === null || homeRelative === "~") {
        out.warnings.push(
          `Skipped vendored path ${configured}: only directories inside your home folder are portable.`,
        );
        continue;
      }
      try {
        const walk = await walkVendoredSource(absolute, {
          ...limits,
          excludeGlobs: [...limits.excludeGlobs, ...appManagedExcludes(homeRelative)],
        });
        if (walk.entries.length === 0) {
          out.warnings.push(`Skipped vendored path ${configured}: no vendorable files.`);
          continue;
        }
        for (const skip of walk.skipped) {
          if (skip.reason === "excluded by glob") continue;
          out.warnings.push(`Vendored ${homeRelative}: skipped ${skip.path} (${skip.reason}).`);
        }
        let id = collectionIdForPath(homeRelative);
        for (let suffix = 2; collectionIds.has(id); suffix += 1) {
          id = `${collectionIdForPath(homeRelative)}-${suffix}`;
        }
        collectionIds.add(id);
        out.vendored.push({
          id,
          kind: "files",
          repoDir: `vendored/files/${id}`,
          target: homeRelative,
          hash: walk.hash,
          fileCount: walk.entries.length,
          bytes: walk.bytes,
          entries: walk.entries,
        });
        out.vendoredSourceDirs.set(id, absolute);
      } catch (cause) {
        if (cause instanceof VendorError && cause.message.includes("does not exist")) {
          continue; // Optional paths like ~/.claude/skills may not exist.
        }
        out.warnings.push(`Skipped vendored path ${configured}: ${errorMessage(cause)}`);
      }
    }
  }

  private async capturePluginSettings(
    plugins: InstalledPlugin[],
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<{ entries: PluginSettingPresetEntry[]; keys: Map<string, Set<string>> }> {
    const keys = new Map<string, Set<string>>();
    const captured = await Promise.all(
      plugins
        .filter((plugin) => plugin.id !== SELF_PLUGIN_ID && plugin.hasSettings)
        .map(async (plugin) => {
          try {
            const response = await this.bb.sdk.plugins.getSettings({ pluginId: plugin.id, signal });
            keys.set(plugin.id, new Set(Object.keys(response.schema)));
            return Object.entries(response.schema).flatMap(([key, descriptor]) => {
              const value = response.values[key];
              const syncable =
                typeof value === "string" ||
                typeof value === "boolean" ||
                (typeof value === "number" && Number.isFinite(value));
              const secret = "secret" in descriptor && descriptor.secret === true;
              const safetyIssue =
                typeof value === "string" || typeof value === "boolean"
                  ? settingSafetyIssue(key, value)
                  : null;
              if (secret || isSensitiveSettingKey(key) || safetyIssue !== null) {
                if (safetyIssue !== null && !secret) {
                  warnings.push(`Skipped ${plugin.id}.${key}: ${safetyIssue}.`);
                }
                return [];
              }
              if (!syncable || !settingValueMatchesDescriptor(descriptor, value as string | boolean | number)) {
                return [];
              }
              return [{ id: plugin.id, key, value: value as string | boolean | number }];
            });
          } catch (cause) {
            warnings.push(`Could not read non-secret settings for ${plugin.id}: ${errorMessage(cause)}`);
            return [];
          }
        }),
    );
    return { entries: captured.flat(), keys };
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
    const limits = {
      maxFileBytes: Math.max(1, settings.vendorMaxFileKb) * 1024,
      maxBytes: Math.max(1, settings.vendorMaxCollectionMb) * 1024 * 1024,
      excludeGlobs: parseGlobList(settings.vendorExcludeGlobs),
    };
    const collected = {
      plugins: [] as { id: string; install: string; enabled: boolean }[],
      vendored: [] as VendoredCollection[],
      vendoredSourceDirs: new Map<string, string>(),
      warnings: [] as string[],
    };
    for (const plugin of pluginList.plugins) {
      if (plugin.id === SELF_PLUGIN_ID) continue;
      await this.captureLocalPlugin(plugin, scope, limits, collected);
    }
    if (scope.syncVendoredFiles) await this.captureFolders(settings, limits, collected);

    const portableMarketplaces = marketplaces.flatMap((marketplace) => {
      if (marketplace.official) return [];
      if (!isPortableMarketplaceSource(marketplace.source)) {
        collected.warnings.push(`Skipped local-path marketplace ${marketplace.name}.`);
        return [];
      }
      return [{ name: marketplace.name, source: marketplace.source }];
    });

    const pluginSettings = settings.includePluginSettings
      ? await this.capturePluginSettings(pluginList.plugins, signal, collected.warnings)
      : { entries: [], keys: new Map<string, Set<string>>() };

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
      plugins: collected.plugins,
      marketplaces: portableMarketplaces,
      pluginSettings: pluginSettings.entries,
    });
    collected.warnings.push(...syncScopeWarnings(scope, null, snapshot));
    return {
      snapshot: applySyncScope(snapshot, scope),
      vendored: collected.vendored,
      vendoredSourceDirs: collected.vendoredSourceDirs,
      pluginSettingKeys: pluginSettings.keys,
      warnings: unique(collected.warnings),
    };
  }

  /** Resolve a preset-declared "~/..." collection target inside the home dir. */
  private resolveVendoredTarget(target: string | undefined): string | null {
    if (target === undefined || target === "~" || !target.startsWith("~/")) {
      return null;
    }
    const resolved = expandHome(target);
    return toHomeRelative(resolved) === target ? resolved : null;
  }

  /** Read the preset once, compare it with this machine and build the plan. */
  private async gather(signal?: AbortSignal, copyVendoredTo?: string): Promise<Gathered> {
    const settings = await this.remoteSettings();
    const scope = scopeFromSettings(settings);
    const [remote, local, applied, base] = await Promise.all([
      readRemotePreset({
        repositoryUrl: settings.repositoryUrl,
        branch: settings.branch,
        githubToken: settings.githubToken,
        copyVendoredTo,
        signal,
      }),
      this.captureSnapshot(signal),
      readVendorState(),
      this.readBase(),
    ]);
    const remoteScoped: RemotePreset = {
      ...remote,
      snapshot: applySyncScope(remote.snapshot, scope),
      vendored: {
        schemaVersion: 1,
        collections: applyVendoredScope(remote.vendored.collections, scope),
      },
    };
    const warnings = [
      ...local.warnings,
      ...(remote.vendoredWarning !== undefined ? [remote.vendoredWarning] : []),
      ...syncScopeWarnings(scope, remote.snapshot, local.snapshot),
    ];

    const localExcludes = parseGlobList(settings.vendorExcludeGlobs);
    const folders: FolderPlan[] = [];
    for (const collection of remoteScoped.vendored.collections) {
      if (collection.kind !== "files") continue;
      const targetDir = this.resolveVendoredTarget(collection.target);
      if (targetDir === null || !isValidVendoredId(collection.id)) {
        warnings.push(`Folder ${collection.target ?? collection.id} has an unsafe target and is skipped.`);
        continue;
      }
      folders.push(
        await planFolder({
          collection,
          target: collection.target!,
          targetDir,
          excludeGlobs: [...localExcludes, ...appManagedExcludes(collection.target)],
          baseFiles: applied.collections[collection.id]?.files,
        }),
      );
    }

    const plan = buildPullPlan({
      repository: settings.repositoryUrl,
      branch: settings.branch,
      remoteHead: remote.head,
      local: local.snapshot,
      remote: remoteScoped.snapshot,
      remoteVendored: remoteScoped.vendored,
      appliedVendored: applied,
      warnings,
      base,
      folders: folders.map((folder) => {
        const counts = countFolder(folder);
        return {
          collectionId: folder.collection.id,
          target: folder.target,
          add: counts.add,
          update: counts.update,
          skipped: counts.skip,
          conflictPaths: folder.decisions
            .filter((decision) => decision.action === "conflict")
            .map((decision) => decision.path),
          blocked: folder.blocked,
        };
      }),
      localPluginSettingKeys: local.pluginSettingKeys,
    });
    return { settings, scope, remote, remoteScoped, local, applied, base, folders, plan };
  }

  async preview(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => (await this.gather(signal)).plan);
  }

  async status(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remote, local, scope, settings, plan } = await this.gather(signal);
      const [staged, lastOperation] = await Promise.all([
        this.readStaged(),
        this.readLastOperation(),
      ]);
      const merged = mergePresetForPush(local.snapshot, remote.snapshot, scope);
      const pushChanges = buildPushChanges(merged, remote.snapshot, {
        local: {
          schemaVersion: 1,
          collections: mergeVendoredForPush({
            local: applyVendoredScope(local.vendored, scope),
            remote: remote.vendored,
            mergedPlugins: merged.plugins,
            scope,
          }),
        },
        remote: remote.vendored,
      });
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
        conflicts: plan.conflicts,
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
   * Rebuild full vendored collections (entries + hashes) for a push. Staged
   * collections re-walk their live source so the preset always publishes the
   * current on-disk state.
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

    let pluginById: Map<string, InstalledPlugin> | null = null;

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
          excludeGlobs: [...excludeGlobs, ...appManagedExcludes(collection.target)],
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
          if (skip.reason === "excluded by glob") continue;
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

  /** After a push both sides agree: record the published values as the base. */
  private async recordPushedBase(
    snapshot: PresetSnapshot,
    scope: SyncScope,
    pushedFolders: VendoredCollection[],
  ): Promise<void> {
    const base = await this.readBase();
    const next: SyncBase = {
      ...base,
      general: { ...base.general, ...snapshot.settings.generalSettings },
      experiments: { ...base.experiments, ...snapshot.settings.experiments },
      pluginSettings: {
        ...base.pluginSettings,
        ...Object.fromEntries(
          snapshot.pluginSettings.map((entry) => [`${entry.id}.${entry.key}`, entry.value]),
        ),
      },
    };
    if (scope.syncKeybindings) next.keybindingOverrides = snapshot.settings.keybindingOverrides;
    if (scope.syncAppearance) next.appearance = snapshot.settings.appearance;
    await this.writeBase(next);
    for (const collection of pushedFolders) {
      await recordVendorApplied(collection.id, {
        hash: collection.hash,
        target: collection.target,
        files: folderBaseFiles(collection),
      }).catch(() => undefined);
    }
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
      const pushedIds = new Set(mergedVendored.map((collection) => collection.id));
      await this.recordPushedBase(
        staged.snapshot,
        scope,
        rebuilt.collections.filter(
          (collection) => collection.kind === "files" && pushedIds.has(collection.id),
        ),
      );
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

  /**
   * Apply the preset. The plan is rebuilt from a single clone that also
   * supplies the file payloads; with `expectedFingerprint` the pull is refused
   * when that plan differs from the one the user previewed.
   */
  async pullAndApply(options: PullOptions = {}): Promise<ApplyResult> {
    return this.exclusive(async () => {
      const payloadRoot = await mkdtemp(join(tmpdir(), "bb-preset-pull-"));
      try {
        const gathered = await this.gather(options.signal, payloadRoot);
        const { plan, settings } = gathered;
        if (
          options.expectedFingerprint !== undefined &&
          options.expectedFingerprint !== plan.fingerprint
        ) {
          throw new Error(
            "The preset or this machine changed since the preview. Nothing was applied; review the new preview.",
          );
        }
        const journal = new PullJournal(gathered.base, gathered.applied.collections);
        const outcome = await applyPull({
          bb: this.bb,
          remote: gathered.remoteScoped,
          local: gathered.local.snapshot,
          localPluginSettingKeys: gathered.local.pluginSettingKeys,
          applied: gathered.applied,
          base: gathered.base,
          folders: gathered.folders,
          payloadRoot,
          selection:
            options.selectedChangeIds === undefined
              ? undefined
              : new Set(options.selectedChangeIds),
          resolutions: options.resolutions ?? {},
          defaultFileConflict: settings.vendorConflictMode === "skip" ? undefined : "take-remote",
          npmInstall: settings.vendorNpmInstall,
          journal,
          runProcess: (command, args, cwd) => this.runProcess(command, args, cwd),
          signal: options.signal,
        });
        await this.writeBase(outcome.base);
        await writeVendorState({ collections: outcome.folderState });
        const saved = await journal.save();

        const ok = outcome.errors.length === 0;
        await this.writeLastOperation({
          type: "pull",
          at: new Date().toISOString(),
          summary: ok
            ? `Applied ${outcome.applied.length} changes from the preset`
            : `Applied ${outcome.applied.length} changes with ${outcome.errors.length} errors`,
        });
        return applyResultSchema.parse({
          ok,
          plan,
          applied: outcome.applied,
          skipped: outcome.skipped,
          errors: outcome.errors,
          warnings: unique([...plan.warnings, ...outcome.warnings]),
          backupRun: saved ? journal.runId : null,
        });
      } finally {
        await rm(payloadRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        }).catch(() => undefined);
      }
    });
  }

  /** Undo the most recent pull (files, settings); see lib/restore.ts. */
  async restore(): Promise<RestoreResult> {
    return this.exclusive(async () => {
      const result = await restoreLastPull(this.bb, (base) => this.writeBase(base));
      await this.writeLastOperation({
        type: "pull",
        at: new Date().toISOString(),
        summary: `Restored ${result.restored.length} items from the last pull`,
      });
      return result;
    });
  }
}
