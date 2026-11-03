import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyFolder, type FolderPlan } from "./folder-sync";
import type { PullJournal } from "./journal";
import type { SyncBase } from "./merge";
import {
  errorMessage,
  isPortableInstallSource,
  isPortableMarketplaceSource,
  planSettingDecisions,
  sameJson,
  settingSafetyIssue,
  SELF_PLUGIN_ID,
  type PresetSnapshot,
  type SettingDecision,
} from "./preset";
import {
  installPluginFromPreset,
  pluginPathSource,
  settingValueMatchesDescriptor,
  type InstalledPlugin,
  type SystemConfig,
} from "./plugins-api";
import {
  VENDORED_PLUGIN_PRESERVE_NAMES,
  isValidVendoredId,
  isValidVendoredRepoDir,
  materializeVendoredFiles,
  prepareVendoredPlugin,
  vendoredPluginDir,
  vendoredPluginId,
  vendoredTrashRoot,
  type VendorAppliedState,
  type VendoredCollection,
  type VendoredManifest,
} from "./vendor";

export type ConflictChoice = "keep-local" | "take-remote";

export type RunProcess = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stderr: string }>;

export interface PullInputs {
  bb: BbPluginApi;
  remote: { snapshot: PresetSnapshot; vendored: VendoredManifest };
  /** This machine, scoped like the remote snapshot. */
  local: PresetSnapshot;
  localPluginSettingKeys: ReadonlyMap<string, ReadonlySet<string>>;
  applied: VendorAppliedState;
  base: SyncBase;
  folders: FolderPlan[];
  payloadRoot: string | null;
  /** Change ids to apply; undefined applies every planned change. */
  selection?: ReadonlySet<string>;
  /** Conflict id -> choice. Unresolved conflicts keep the local value. */
  resolutions: Readonly<Record<string, ConflictChoice>>;
  /**
   * Choice for a conflicted file of a synced folder: the user's decision for
   * its skill, a remembered rule, or the conflict mode. Undefined keeps it.
   */
  fileConflictChoice: (collectionId: string, path: string) => ConflictChoice | undefined;
  npmInstall: boolean;
  journal: PullJournal;
  runProcess: RunProcess;
  signal?: AbortSignal;
}

export interface PullOutcome {
  applied: string[];
  skipped: string[];
  errors: string[];
  warnings: string[];
  base: SyncBase;
  folderState: VendorAppliedState["collections"];
}

class Outcome {
  readonly applied: string[] = [];
  readonly skipped: string[] = [];
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  async attempt(label: string, operation: () => Promise<unknown>): Promise<boolean> {
    try {
      await operation();
      this.applied.push(label);
      return true;
    } catch (cause) {
      this.errors.push(`${label}: ${errorMessage(cause)}`);
      return false;
    }
  }
}

function payloadSource(root: string | null, collection: VendoredCollection): string | null {
  if (root === null || !isValidVendoredRepoDir(collection.repoDir)) return null;
  return join(root, ...collection.repoDir.replace(/^vendored\//, "").split("/"));
}

/** Apply a previewed pull. Every step is independent; one failure never blocks the rest. */
export async function applyPull(inputs: PullInputs): Promise<PullOutcome> {
  const out = new Outcome();
  const base: SyncBase = structuredClone(inputs.base);
  const folderState: VendorAppliedState["collections"] = { ...inputs.applied.collections };
  const selected = (id: string) => inputs.selection === undefined || inputs.selection.has(id);
  const choice = (conflictId: string): ConflictChoice | undefined => inputs.resolutions[conflictId];

  await applyMarketplaces(inputs, out, selected);
  await applyFolders(inputs, out, selected, folderState);
  await applyVendoredPlugins(inputs, out, selected, folderState);
  await installPortablePlugins(inputs, out, selected);

  const installed = new Map(
    (await inputs.bb.sdk.plugins.list({ signal: inputs.signal })).plugins.map((plugin) => [
      plugin.id,
      plugin,
    ]),
  );
  const decisions = planSettingDecisions({
    local: inputs.local,
    remote: inputs.remote.snapshot,
    base: inputs.base,
    localPluginSettingKeys: inputs.localPluginSettingKeys,
  });
  const settingsUpdated = await applyPluginSettings(inputs, out, selected, choice, installed, decisions.pluginSettings, base);
  await applyPluginStates(inputs, out, selected, installed, settingsUpdated);
  await applyGeneralSettings(inputs, out, selected, choice, decisions.general, base);
  await applyExperiments(inputs, out, selected, choice, decisions.experiments, base);
  await applyWholeValue(inputs, out, selected, choice, decisions.keybindings, base, "keybindings");
  await applyWholeValue(inputs, out, selected, choice, decisions.appearance, base, "appearance");

  return { ...out, base, folderState };
}

async function applyMarketplaces(inputs: PullInputs, out: Outcome, selected: (id: string) => boolean) {
  const current = new Map(
    (await inputs.bb.sdk.plugins.marketplaces.list({ signal: inputs.signal })).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  for (const marketplace of inputs.remote.snapshot.marketplaces) {
    if (current.has(marketplace.name) || !selected(`marketplace:${marketplace.name}`)) continue;
    if (!isPortableMarketplaceSource(marketplace.source)) {
      out.skipped.push(`Skipped local marketplace ${marketplace.name}`);
      continue;
    }
    await out.attempt(`Added marketplace ${marketplace.name}`, () =>
      inputs.bb.sdk.plugins.marketplaces.add({ source: marketplace.source }),
    );
  }
}

async function applyFolders(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  folderState: VendorAppliedState["collections"],
) {
  for (const plan of inputs.folders) {
    const id = plan.collection.id;
    const resolveConflict = (path: string) => inputs.fileConflictChoice(id, path);
    const folderSelected = selected(`files:${id}`);
    const resolvedConflicts = plan.decisions.filter(
      (decision) => decision.action === "conflict" && resolveConflict(decision.path) !== undefined,
    );
    if (!folderSelected && resolvedConflicts.length === 0) continue;
    const sourceDir = payloadSource(inputs.payloadRoot, plan.collection);
    if (sourceDir === null) {
      out.errors.push(`Folder ${plan.target}: invalid collection metadata`);
      continue;
    }
    // Without the folder change selected only explicitly resolved conflicts are written.
    const scopedPlan: FolderPlan = folderSelected
      ? plan
      : {
          ...plan,
          decisions: plan.decisions.filter(
            (decision) => decision.action === "same" || resolvedConflicts.includes(decision),
          ),
        };
    const result = await applyFolder({
      plan: scopedPlan,
      sourceDir,
      baseFiles: inputs.applied.collections[id]?.files,
      resolveConflict,
      journal: inputs.journal,
    });
    out.skipped.push(...result.skipped);
    out.errors.push(...result.errors);
    if (result.written > 0) {
      out.applied.push(`Synced ${result.written} ${result.written === 1 ? "file" : "files"} to ${plan.target}`);
    }
    if (result.errors.length === 0) {
      folderState[id] = {
        hash: plan.collection.hash,
        appliedAt: new Date().toISOString(),
        target: plan.target,
        files: result.baseFiles,
      };
    }
  }
}

async function applyVendoredPlugins(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  folderState: VendorAppliedState["collections"],
) {
  const collections = new Map(
    inputs.remote.vendored.collections
      .filter((entry) => entry.kind === "plugin")
      .map((entry) => [entry.pluginId ?? entry.id, entry]),
  );
  const installed = new Map(
    (await inputs.bb.sdk.plugins.list({ signal: inputs.signal })).plugins.map((plugin) => [
      plugin.id,
      plugin,
    ]),
  );
  for (const plugin of inputs.remote.snapshot.plugins) {
    if (plugin.id === SELF_PLUGIN_ID || vendoredPluginId(plugin.install) !== plugin.id) continue;
    const current = installed.get(plugin.id);
    if (!selected(current === undefined ? `plugin-install:${plugin.id}` : `vendored:${plugin.id}`)) continue;
    const collection = collections.get(plugin.id);
    const sourceDir = collection === undefined ? null : payloadSource(inputs.payloadRoot, collection);
    if (collection === undefined || sourceDir === null || !isValidVendoredId(collection.id)) {
      out.skipped.push(`Skipped vendored plugin ${plugin.id}: payload missing or invalid`);
      continue;
    }
    const managed = vendoredPluginDir(plugin.id);
    if (current !== undefined) {
      const currentPath = pluginPathSource(current);
      if (currentPath === null || resolve(currentPath) !== resolve(managed)) {
        out.skipped.push(`Kept vendored plugin ${plugin.id} installed from its existing source`);
        continue;
      }
    }
    await out.attempt(
      `${current === undefined ? "Installed" : "Updated"} vendored plugin ${plugin.id}`,
      async () => {
        const managedExists = await lstat(managed)
          .then((entry) => entry.isDirectory())
          .catch(() => false);
        if (!managedExists || inputs.applied.collections[collection.id]?.hash !== collection.hash) {
          const result = await materializeVendoredFiles({
            sourceDir,
            entries: collection.entries,
            targetDir: managed,
            conflict: "overwrite",
            pruneExtras: true,
            // One trash folder per pull, so earlier runs are never overwritten.
            backupRoot: join(vendoredTrashRoot(), inputs.journal.runId, "plugins", collection.id),
            preserveNames: VENDORED_PLUGIN_PRESERVE_NAMES,
          });
          if (result.errors.length > 0) throw new Error(result.errors.slice(0, 3).join("; "));
          folderState[collection.id] = { hash: collection.hash, appliedAt: new Date().toISOString() };
        }
        if (inputs.npmInstall) {
          const issue = await prepareVendoredPlugin(managed, inputs.runProcess);
          if (issue !== null) out.warnings.push(`Vendored plugin ${plugin.id}: ${issue}.`);
        }
        if (current === undefined) {
          await inputs.bb.sdk.plugins.install({ source: `path:${managed}` });
          inputs.journal.recordInstalledPlugin(plugin.id);
        } else {
          await inputs.bb.sdk.plugins
            .applyUpdate({ pluginId: plugin.id })
            .catch(() => inputs.bb.sdk.plugins.reload({ pluginId: plugin.id }));
        }
      },
    );
  }
}

async function installPortablePlugins(inputs: PullInputs, out: Outcome, selected: (id: string) => boolean) {
  const installed = new Set(
    (await inputs.bb.sdk.plugins.list({ signal: inputs.signal })).plugins.map((plugin) => plugin.id),
  );
  for (const plugin of inputs.remote.snapshot.plugins) {
    if (plugin.id === SELF_PLUGIN_ID || installed.has(plugin.id)) continue;
    if (!selected(`plugin-install:${plugin.id}`)) continue;
    if (vendoredPluginId(plugin.install) !== null) {
      out.skipped.push(`Skipped vendored plugin ${plugin.id}`);
      continue;
    }
    if (!isPortableInstallSource(plugin.install)) {
      out.skipped.push(`Skipped local-path plugin ${plugin.id}`);
      continue;
    }
    const ok = await out.attempt(`Installed plugin ${plugin.id}`, () =>
      installPluginFromPreset(inputs.bb, plugin.install, inputs.signal),
    );
    if (ok) inputs.journal.recordInstalledPlugin(plugin.id);
  }
}

/** Decide whether one setting is written, and keep the base in step. */
function settingAction(
  decision: SettingDecision,
  changeSelected: boolean,
  resolution: ConflictChoice | undefined,
  record: Record<string, unknown>,
  baseKey: string,
): boolean {
  if (decision.decision === "same") {
    record[baseKey] = decision.remote;
    return false;
  }
  if (decision.decision === "conflict") {
    if (resolution === "keep-local") record[baseKey] = decision.remote;
    return resolution === "take-remote";
  }
  return decision.decision === "take-remote" && changeSelected;
}

async function applyPluginSettings(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  choice: (conflictId: string) => ConflictChoice | undefined,
  installed: Map<string, InstalledPlugin>,
  decisions: ReturnType<typeof planSettingDecisions>["pluginSettings"],
  base: SyncBase,
): Promise<Set<string>> {
  const byPlugin = new Map<string, typeof decisions>();
  for (const decision of decisions) {
    const list = byPlugin.get(decision.pluginId) ?? [];
    list.push(decision);
    byPlugin.set(decision.pluginId, list);
  }
  const updated = new Set<string>();
  for (const [pluginId, list] of byPlugin) {
    const wanted = list.filter((decision) =>
      settingAction(
        decision,
        selected(`plugin-settings:${pluginId}`),
        choice(`conflict:plugin-settings:${pluginId}.${decision.key}`),
        base.pluginSettings,
        `${pluginId}.${decision.key}`,
      ),
    );
    if (wanted.length === 0) continue;
    if (!installed.has(pluginId)) {
      out.skipped.push(`Skipped settings for missing plugin ${pluginId}`);
      continue;
    }
    try {
      const response = await inputs.bb.sdk.plugins.getSettings({ pluginId, signal: inputs.signal });
      const values: Record<string, string | boolean | number> = {};
      for (const decision of wanted) {
        const descriptor = response.schema[decision.key];
        const value = decision.remote as string | boolean | number | null;
        if (
          value === null ||
          descriptor === undefined ||
          ("secret" in descriptor && descriptor.secret === true) ||
          settingSafetyIssue(decision.key, value) !== null ||
          !settingValueMatchesDescriptor(descriptor, value)
        ) {
          out.skipped.push(`Skipped unsafe or unknown setting ${pluginId}.${decision.key}`);
          continue;
        }
        if (!sameJson(response.values[decision.key], value)) {
          values[decision.key] = value;
          inputs.journal.recordPluginSetting(pluginId, decision.key, {
            previous: response.values[decision.key],
            applied: value,
          });
        }
      }
      if (Object.keys(values).length === 0) continue;
      const ok = await out.attempt(
        `Updated ${Object.keys(values).length} settings for ${pluginId}`,
        () => inputs.bb.sdk.plugins.updateSettings({ pluginId, values }),
      );
      if (ok) {
        updated.add(pluginId);
        for (const key of Object.keys(values)) base.pluginSettings[`${pluginId}.${key}`] = values[key];
      }
    } catch (cause) {
      out.errors.push(`Settings for ${pluginId}: ${errorMessage(cause)}`);
    }
  }
  return updated;
}

async function applyPluginStates(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  installedBefore: Map<string, InstalledPlugin>,
  settingsUpdated: Set<string>,
) {
  for (const desired of inputs.remote.snapshot.plugins) {
    if (desired.id === SELF_PLUGIN_ID) continue;
    const current = installedBefore.get(desired.id);
    if (current === undefined) continue;
    if (current.enabled !== desired.enabled) {
      if (!selected(`plugin-state:${desired.id}`)) continue;
      await out.attempt(`${desired.enabled ? "Enabled" : "Disabled"} plugin ${desired.id}`, () =>
        desired.enabled
          ? inputs.bb.sdk.plugins.enable({ pluginId: desired.id })
          : inputs.bb.sdk.plugins.disable({ pluginId: desired.id }),
      );
    } else if (desired.enabled && settingsUpdated.has(desired.id)) {
      await out.attempt(`Reloaded plugin ${desired.id}`, () =>
        inputs.bb.sdk.plugins.reload({ pluginId: desired.id }),
      );
    }
  }
}

async function applyGeneralSettings(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  choice: (conflictId: string) => ConflictChoice | undefined,
  decisions: SettingDecision[],
  base: SyncBase,
) {
  const wanted = decisions.filter((decision) =>
    settingAction(
      decision,
      selected(`general:${decision.key}`),
      choice(`conflict:general:${decision.key}`),
      base.general,
      decision.key,
    ),
  );
  if (wanted.length === 0) return;
  const updates: Record<string, unknown> = {};
  for (const decision of wanted) updates[decision.key] = decision.remote;
  if ("showDiagnosticEvents" in updates) {
    updates.showUnhandledProviderEvents = updates.showDiagnosticEvents;
  }
  const ok = await out.attempt(
    `Updated ${wanted.length} BB ${wanted.length === 1 ? "setting" : "settings"}`,
    async () => {
      // BB replaces the whole object on update: start from every current value,
      // including machine keys the preset never carries.
      const current = (await inputs.bb.sdk.system.config({ signal: inputs.signal }))
        .generalSettings as Record<string, unknown>;
      for (const decision of wanted) {
        inputs.journal.recordSetting("general", decision.key, {
          previous: current[decision.key],
          applied: decision.remote,
        });
      }
      await inputs.bb.sdk.system.updateGeneralSettings({
        ...current,
        ...updates,
      } as SystemConfig["generalSettings"]);
    },
  );
  if (ok) for (const decision of wanted) base.general[decision.key] = decision.remote;
}

async function applyExperiments(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  choice: (conflictId: string) => ConflictChoice | undefined,
  decisions: SettingDecision[],
  base: SyncBase,
) {
  const wanted = decisions.filter((decision) =>
    settingAction(
      decision,
      selected(`experiment:${decision.key}`),
      choice(`conflict:experiment:${decision.key}`),
      base.experiments,
      decision.key,
    ),
  );
  if (wanted.length === 0) return;
  const updates = Object.fromEntries(wanted.map((decision) => [decision.key, decision.remote]));
  const ok = await out.attempt(
    `Updated ${wanted.length} ${wanted.length === 1 ? "experiment" : "experiments"}`,
    async () => {
      for (const decision of wanted) {
        inputs.journal.recordSetting("experiments", decision.key, {
          previous: decision.local,
          applied: decision.remote,
        });
      }
      await inputs.bb.sdk.system.updateExperiments(updates as SystemConfig["experiments"]);
    },
  );
  if (ok) for (const decision of wanted) base.experiments[decision.key] = decision.remote;
}

async function applyWholeValue(
  inputs: PullInputs,
  out: Outcome,
  selected: (id: string) => boolean,
  choice: (conflictId: string) => ConflictChoice | undefined,
  decision: SettingDecision | null,
  base: SyncBase,
  kind: "keybindings" | "appearance",
) {
  const baseKey = kind === "keybindings" ? "keybindingOverrides" : "appearance";
  if (decision === null) {
    base[baseKey] = kind === "keybindings"
      ? inputs.remote.snapshot.settings.keybindingOverrides
      : inputs.remote.snapshot.settings.appearance;
    return;
  }
  const holder: Record<string, unknown> = {};
  const write = settingAction(decision, selected(kind), choice(`conflict:${kind}`), holder, baseKey);
  if (baseKey in holder) base[baseKey] = holder[baseKey];
  if (!write) return;
  const change = { previous: decision.local, applied: decision.remote };
  const ok =
    kind === "keybindings"
      ? await out.attempt("Updated keyboard shortcuts", async () => {
          inputs.journal.recordKeybindings(change);
          await inputs.bb.sdk.system.updateKeyboardSettings(
            decision.remote as SystemConfig["keybindingOverrides"],
          );
        })
      : await out.attempt("Updated BB theme", async () => {
          inputs.journal.recordAppearance(change);
          await inputs.bb.sdk.theme.set(
            decision.remote as PresetSnapshot["settings"]["appearance"],
          );
        });
  if (ok) base[baseKey] = decision.remote;
}
