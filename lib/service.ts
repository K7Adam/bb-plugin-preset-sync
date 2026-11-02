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
}

interface StagedPreset extends CapturedPreset {
  stagedAt: string;
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
  value: string | boolean,
): boolean {
  if (descriptor.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
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
    const value = await this.bb.storage.kv.get<StagedPreset>(STAGED_KEY);
    if (value === undefined) return null;
    return {
      snapshot: presetSnapshotSchema.parse(value.snapshot),
      warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
      stagedAt: String(value.stagedAt),
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
    const warnings: string[] = [];

    const plugins = pluginList.plugins.flatMap((plugin) => {
      if (plugin.id === SELF_PLUGIN_ID) return [];
      const install = pluginInstallSpec(plugin);
      if (!isPortableInstallSource(install)) {
        warnings.push(`Skipped local-path plugin ${plugin.id}.`);
        return [];
      }
      return [{ id: plugin.id, install, enabled: plugin.enabled }];
    });

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
                if (typeof value !== "string" && typeof value !== "boolean") return [];
                if (!settingValueMatchesDescriptor(descriptor, value)) return [];
                return [{ id: plugin.id, key, value }];
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
    const scope = scopeFromSettings(settings);
    warnings.push(...syncScopeWarnings(scope, null, snapshot));
    return {
      snapshot: applySyncScope(snapshot, scope),
      warnings: unique(warnings),
    };
  }

  private async remoteAndLocal(signal?: AbortSignal): Promise<{
    remote: Awaited<ReturnType<typeof readRemotePreset>>;
    remoteScoped: Awaited<ReturnType<typeof readRemotePreset>>;
    local: CapturedPreset;
    scope: SyncScope;
    settings: SyncSettings;
  }> {
    const settings = await this.remoteSettings();
    const [remote, local] = await Promise.all([
      readRemotePreset({
        repositoryUrl: settings.repositoryUrl,
        branch: settings.branch,
        githubToken: settings.githubToken,
        signal,
      }),
      this.captureSnapshot(signal),
    ]);
    const scope = scopeFromSettings(settings);
    return {
      remote,
      remoteScoped: {
        ...remote,
        snapshot: applySyncScope(remote.snapshot, scope),
      },
      local: {
        ...local,
        warnings: [
          ...local.warnings,
          ...syncScopeWarnings(scope, remote.snapshot, local.snapshot),
        ],
      },
      scope,
      settings,
    };
  }

  async preview(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => {
      const { remoteScoped, local, settings } = await this.remoteAndLocal(signal);
      return buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remoteScoped.head,
        local: local.snapshot,
        remote: remoteScoped.snapshot,
        warnings: local.warnings,
      });
    });
  }

  async status(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remote, remoteScoped, local, scope, settings } =
        await this.remoteAndLocal(signal);
      const plan = buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remoteScoped.head,
        local: local.snapshot,
        remote: remoteScoped.snapshot,
        warnings: local.warnings,
      });
      const [staged, lastOperation] = await Promise.all([
        this.readStaged(),
        this.readLastOperation(),
      ]);
      const pushChanges = buildPushChanges(
        mergePresetForPush(local.snapshot, remote.snapshot, scope),
        remote.snapshot,
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

  async capture() {
    return this.exclusive(async () => {
      const captured = await this.captureSnapshot();
      const staged: StagedPreset = {
        ...captured,
        stagedAt: new Date().toISOString(),
      };
      const bytes = Buffer.byteLength(JSON.stringify(staged), "utf8");
      if (bytes > MAX_STAGED_BYTES) {
        throw new Error(
          `Captured preset is ${bytes} bytes; the safe staging limit is ${MAX_STAGED_BYTES} bytes.`,
        );
      }
      await this.bb.storage.kv.set(STAGED_KEY, staged);
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
        warnings: staged.warnings,
      };
    });
  }

  async push(args: { fresh: boolean; message?: string; signal?: AbortSignal }) {
    return this.exclusive(async () => {
      const settings = await this.remoteSettings();
      let staged = await this.readStaged();
      if (args.fresh || staged === null) {
        if (!args.fresh && staged === null) {
          throw new Error('No staged preset. Run "bb preset capture" or use "bb preset push --fresh".');
        }
        const captured = await this.captureSnapshot(args.signal);
        staged = {
          ...captured,
          stagedAt: new Date().toISOString(),
        };
        await this.bb.storage.kv.set(STAGED_KEY, staged);
      }
      const scope = scopeFromSettings(settings);
      let remoteSnapshot: PresetSnapshot | null = null;
      try {
        remoteSnapshot = (
          await readRemotePreset({
            repositoryUrl: settings.repositoryUrl,
            branch: settings.branch,
            githubToken: settings.githubToken,
            signal: args.signal,
          })
        ).snapshot;
      } catch {
        remoteSnapshot = null;
      }
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
        mergePresetForPush(staged.snapshot, remoteSnapshot, scope),
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
        warnings: staged.warnings,
      };
    });
  }

  async pullAndApply(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remoteScoped, local, settings } = await this.remoteAndLocal(signal);
      const plan = buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remoteScoped.head,
        local: local.snapshot,
        remote: remoteScoped.snapshot,
        warnings: local.warnings,
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

      let pluginList = await this.bb.sdk.plugins.list({ signal });
      let installed = new Map(pluginList.plugins.map((plugin) => [plugin.id, plugin]));
      for (const plugin of remoteScoped.snapshot.plugins) {
        if (plugin.id === SELF_PLUGIN_ID || installed.has(plugin.id)) continue;
        if (!isPortableInstallSource(plugin.install)) {
          skipped.push(`Skipped local-path plugin ${plugin.id}`);
          continue;
        }
        await attempt(`Installed plugin ${plugin.id}`, () =>
          installPluginFromPreset(this.bb, plugin.install, signal),
        );
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
          const values: Record<string, string | boolean> = {};
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
