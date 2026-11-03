import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { restoreFile } from "./folder-sync";
import { latestJournal, markRestored, type SettingChange } from "./journal";
import type { SyncBase } from "./merge";
import { errorMessage, sameJson, type RestoreResult } from "./preset";
import type { SystemConfig } from "./plugins-api";
import { expandHome, readVendorState, toHomeRelative, writeVendorState } from "./vendor";

/** Keep only changes whose current value is still what the pull wrote. */
function untouched(
  changes: Record<string, SettingChange>,
  current: Record<string, unknown>,
  skipped: string[],
  label: (key: string) => string,
): Record<string, unknown> {
  const restore: Record<string, unknown> = {};
  for (const [key, change] of Object.entries(changes)) {
    if (sameJson(current[key], change.applied)) restore[key] = change.previous;
    else skipped.push(`${label(key)} changed after the pull, left as it is`);
  }
  return restore;
}

/**
 * Undo the most recent pull: put back replaced files, remove files it added,
 * and reset settings it changed. Anything edited after the pull is left alone.
 * Plugins the pull installed stay installed and are listed.
 */
export async function restoreLastPull(
  bb: BbPluginApi,
  writeBase: (base: SyncBase) => Promise<void>,
): Promise<RestoreResult> {
  const journal = await latestJournal();
  if (journal === null) throw new Error("There is no pull to restore.");
  const { dir, data } = journal;
  const restored: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const file of data.files) {
    const targetDir = expandHome(file.target);
    if (toHomeRelative(targetDir) !== file.target) {
      errors.push(`${file.target}/${file.path}: target is outside the home folder`);
      continue;
    }
    try {
      const result = await restoreFile({ ...file, targetDir, journalDir: dir });
      if (result.restored) restored.push(`${file.target}/${file.path}`);
      else skipped.push(`${file.target}/${file.path}: ${result.note ?? "not restored"}`);
    } catch (cause) {
      errors.push(`${file.target}/${file.path}: ${errorMessage(cause)}`);
    }
  }

  const config = await bb.sdk.system.config();
  const general = untouched(
    data.general,
    config.generalSettings as Record<string, unknown>,
    skipped,
    (key) => `Setting ${key}`,
  );
  if (Object.keys(general).length > 0) {
    if ("showDiagnosticEvents" in general) {
      general.showUnhandledProviderEvents = general.showDiagnosticEvents;
    }
    try {
      await bb.sdk.system.updateGeneralSettings({
        ...config.generalSettings,
        ...general,
      } as SystemConfig["generalSettings"]);
      restored.push(`${Object.keys(general).length} BB settings`);
    } catch (cause) {
      errors.push(`BB settings: ${errorMessage(cause)}`);
    }
  }

  const experiments = untouched(
    data.experiments,
    config.experiments as Record<string, unknown>,
    skipped,
    (key) => `Experiment ${key}`,
  );
  if (Object.keys(experiments).length > 0) {
    try {
      await bb.sdk.system.updateExperiments(experiments as SystemConfig["experiments"]);
      restored.push(`${Object.keys(experiments).length} experiments`);
    } catch (cause) {
      errors.push(`Experiments: ${errorMessage(cause)}`);
    }
  }

  if (data.keybindingOverrides !== undefined) {
    if (sameJson(config.keybindingOverrides, data.keybindingOverrides.applied)) {
      await bb.sdk.system
        .updateKeyboardSettings(data.keybindingOverrides.previous as SystemConfig["keybindingOverrides"])
        .then(() => restored.push("Keyboard shortcuts"))
        .catch((cause: unknown) => errors.push(`Keyboard shortcuts: ${errorMessage(cause)}`));
    } else {
      skipped.push("Keyboard shortcuts changed after the pull, left as they are");
    }
  }

  if (data.appearance !== undefined) {
    const current = { themeId: config.appearance.themeId, faviconColor: config.appearance.faviconColor };
    if (sameJson(current, data.appearance.applied)) {
      await bb.sdk.theme
        .set(data.appearance.previous as { themeId: string; faviconColor: "default" })
        .then(() => restored.push("Theme"))
        .catch((cause: unknown) => errors.push(`Theme: ${errorMessage(cause)}`));
    } else {
      skipped.push("Theme changed after the pull, left as it is");
    }
  }

  for (const [pluginId, changes] of Object.entries(data.pluginSettings)) {
    try {
      const response = await bb.sdk.plugins.getSettings({ pluginId });
      const values = untouched(changes, response.values, skipped, (key) => `${pluginId}.${key}`);
      const restorable = Object.fromEntries(
        Object.entries(values).filter(([key, value]) => {
          if (value !== undefined) return true;
          skipped.push(`${pluginId}.${key} had no value before the pull and stays set`);
          return false;
        }),
      ) as Record<string, string | boolean | number>;
      if (Object.keys(restorable).length === 0) continue;
      await bb.sdk.plugins.updateSettings({ pluginId, values: restorable });
      restored.push(`${Object.keys(restorable).length} settings for ${pluginId}`);
    } catch (cause) {
      errors.push(`Settings for ${pluginId}: ${errorMessage(cause)}`);
    }
  }

  if (data.installedPlugins.length > 0) {
    skipped.push(
      `Plugins installed by the pull stay installed: ${data.installedPlugins.join(", ")}. Remove them in Settings → Plugins if needed.`,
    );
  }

  // Put the sync base back, so the next preview offers the preset changes again
  // instead of treating the restored values as local edits.
  await writeBase(data.previousBase);
  const state = await readVendorState();
  const touchedTargets = new Set(data.files.map((file) => file.target));
  const previous = data.previousFolderState as typeof state.collections;
  const collections = Object.fromEntries(
    Object.entries(state.collections).flatMap(([id, current]) => {
      if (current.target === undefined || !touchedTargets.has(current.target)) return [[id, current]];
      return previous[id] === undefined ? [] : [[id, previous[id]]];
    }),
  );
  await writeVendorState({ collections });
  await markRestored(dir);
  return { run: data.runId, restored, skipped, errors };
}
