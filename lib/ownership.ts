/**
 * Who owns which setting. "sync" values travel through the preset by default,
 * "local" values stay on this machine unless the user opts them in, and
 * "fixed-local" values identify the machine itself and never travel.
 */
export type Ownership = "sync" | "local" | "fixed-local";

export const GENERAL_SETTING_OWNERSHIP: Readonly<Record<string, Ownership>> = {
  showKeyboardHints: "sync",
  steerActiveThreadOnEnter: "sync",
  terminalCopyOnSelect: "sync",
  confirmThreadArchive: "sync",
  showDiagnosticEvents: "sync",
  showUnhandledProviderEvents: "sync",
  keepHistoryAfterContextClear: "sync",
  summarizeShellCommands: "sync",
  earlyAdopter: "sync",
  managedBranchPrefix: "sync",
  allowFastServiceTier: "sync",
  telemetryEnabled: "sync",
  providerCompletedTurnDisplay: "sync",
  providerOrder: "local",
  defaultProviderId: "local",
  streamerMode: "local",
  idleProviderSessionTimeoutMinutes: "local",
  machineServerUrl: "fixed-local",
  machineGitCredentialsEnabled: "fixed-local",
  defaultMachineAccess: "fixed-local",
  onboardingCompletedAt: "fixed-local",
};

/** Plain-language names for the general settings shown in previews. */
export const GENERAL_SETTING_LABELS: Readonly<Record<string, string>> = {
  showKeyboardHints: "Show keyboard shortcut hints",
  steerActiveThreadOnEnter: "Enter steers a running thread",
  terminalCopyOnSelect: "Copy terminal selection",
  confirmThreadArchive: "Confirm before archiving threads",
  showDiagnosticEvents: "Show diagnostic events",
  showUnhandledProviderEvents: "Show diagnostic events",
  keepHistoryAfterContextClear: "Keep messages after a context clear",
  summarizeShellCommands: "Summarize shell commands",
  earlyAdopter: "Early adopter",
  managedBranchPrefix: "Branch prefix",
  allowFastServiceTier: "Allow the fast service tier",
  telemetryEnabled: "Anonymous telemetry",
  providerCompletedTurnDisplay: "Finished turn display per provider",
  providerOrder: "Provider order",
  defaultProviderId: "Default provider",
  streamerMode: "Streamer mode",
  idleProviderSessionTimeoutMinutes: "Release idle agent sessions",
};

/** Experiments that change how this machine runs, never synced. */
export const FIXED_LOCAL_EXPERIMENTS: ReadonlySet<string> = new Set([
  "performanceDiagnostics",
  "serverMove",
]);

/** Plugin setting keys that usually hold paths or commands of this machine. */
const MACHINE_PLUGIN_SETTING_KEY =
  /(?:command|path|dir|directory|home|folder|executable|binary)$/i;

/** Sub-folders another application manages inside a synced folder. */
export const APP_MANAGED_SUBFOLDERS: Readonly<Record<string, readonly string[]>> = {
  "~/.claude/skills": ["synced/**"],
};

export interface OwnershipChoices {
  /** Keys this machine keeps local even though they sync by default. */
  localKeys: ReadonlySet<string>;
  /** Keys this machine syncs even though they stay local by default. */
  syncKeys: ReadonlySet<string>;
}

export function generalSettingOwnership(key: string): Ownership {
  return GENERAL_SETTING_OWNERSHIP[key] ?? "local";
}

export function isGeneralSettingSynced(key: string, choices: OwnershipChoices): boolean {
  const ownership = generalSettingOwnership(key);
  if (ownership === "fixed-local" || choices.localKeys.has(key)) return false;
  return ownership === "sync" || choices.syncKeys.has(key);
}

export function isExperimentSynced(key: string): boolean {
  return !FIXED_LOCAL_EXPERIMENTS.has(key);
}

export function pluginSettingOwnership(key: string): Ownership {
  return MACHINE_PLUGIN_SETTING_KEY.test(key) ? "local" : "sync";
}

/** `choices` hold `pluginId.key` pairs. */
export function isPluginSettingSynced(
  pluginId: string,
  key: string,
  choices: OwnershipChoices,
): boolean {
  const pair = `${pluginId}.${key}`;
  if (choices.localKeys.has(pair)) return false;
  return pluginSettingOwnership(key) === "sync" || choices.syncKeys.has(pair);
}

/** Exclude patterns that always apply to a folder with the given target. */
export function appManagedExcludes(target: string | undefined): readonly string[] {
  return target === undefined ? [] : (APP_MANAGED_SUBFOLDERS[target] ?? []);
}
