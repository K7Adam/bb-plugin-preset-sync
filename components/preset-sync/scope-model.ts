import type { PlanChange, PlanConflict } from "../../lib/preset";

/** Settings keys the "What syncs" panel may change through sync_update_scope. */
export type ScopeToggleKey =
  | "syncPlugins"
  | "includePluginSettings"
  | "syncGeneralSettings"
  | "syncExperiments"
  | "syncKeybindings"
  | "syncAppearance"
  | "syncMarketplaces"
  | "syncVendoredFiles"
  | "syncVendoredPlugins";

export interface ScopeRow {
  key: ScopeToggleKey;
  title: string;
  description: string;
  /** What never travels, shown so nobody has to guess. */
  staysHere?: string;
  defaultOn: boolean;
  /** Plan change kinds and id prefixes that belong to this row. */
  matches: (change: PlanChange) => boolean;
}

export const SCOPE_ROWS: readonly ScopeRow[] = [
  {
    key: "syncPlugins",
    title: "Plugins",
    description: "Installs plugins from the preset and matches enabled or disabled.",
    staysHere: "Plugins that are not in the preset are never removed.",
    defaultOn: true,
    matches: (change) => change.kind === "plugin-install" || change.kind === "plugin-state",
  },
  {
    key: "includePluginSettings",
    title: "Plugin settings",
    description: "Non-secret settings of your plugins.",
    staysHere: "Secrets, and paths or commands of this machine.",
    defaultOn: true,
    matches: (change) => change.kind === "plugin-settings",
  },
  {
    key: "syncGeneralSettings",
    title: "BB preferences",
    description: "Preferences such as shortcut hints, Enter behaviour or the branch prefix.",
    staysHere: "Server URL, machine access, provider order and default provider.",
    defaultOn: true,
    matches: (change) => change.kind === "general-settings",
  },
  {
    key: "syncExperiments",
    title: "Experiments",
    description: "Experiment flags from Settings → Experiments.",
    staysHere: "Performance diagnostics and server move.",
    defaultOn: true,
    matches: (change) => change.kind === "experiments",
  },
  {
    key: "syncKeybindings",
    title: "Keyboard shortcuts",
    description: "Your shortcut overrides.",
    defaultOn: true,
    matches: (change) => change.kind === "keybindings",
  },
  {
    key: "syncAppearance",
    title: "Theme",
    description: "Theme and favicon color.",
    defaultOn: true,
    matches: (change) => change.kind === "appearance",
  },
  {
    key: "syncMarketplaces",
    title: "Plugin marketplaces",
    description: "Third-party marketplaces you added.",
    defaultOn: true,
    matches: (change) => change.kind === "marketplace",
  },
  {
    key: "syncVendoredFiles",
    title: "Folders",
    description: "Folders you choose, for example skills. Edited files are never overwritten without asking.",
    staysHere: "Symbolic links and folders the Claude app manages.",
    defaultOn: false,
    matches: (change) => change.id?.startsWith("files:") === true,
  },
  {
    key: "syncVendoredPlugins",
    title: "Plugins from a local folder",
    description: "Copies their code into the preset so other machines can install them.",
    staysHere: "They run with full access, like every plugin.",
    defaultOn: false,
    matches: (change) => change.id?.startsWith("vendored:") === true,
  },
];

export function rowFor(change: PlanChange): ScopeRow | undefined {
  // Vendored plugin installs are listed with the local-folder plugins.
  if (change.kind === "plugin-install" && change.summary.includes("from vendored files")) {
    return SCOPE_ROWS.find((row) => row.key === "syncVendoredPlugins");
  }
  return SCOPE_ROWS.find((row) => row.matches(change));
}

export function changeId(change: PlanChange): string {
  return change.id ?? `${change.kind}:${change.target}`;
}

export function groupChanges(changes: readonly PlanChange[]): { row: ScopeRow; changes: PlanChange[] }[] {
  const groups = new Map<ScopeToggleKey, PlanChange[]>();
  for (const change of changes) {
    const row = rowFor(change);
    if (row === undefined) continue;
    groups.set(row.key, [...(groups.get(row.key) ?? []), change]);
  }
  return SCOPE_ROWS.flatMap((row) => {
    const list = groups.get(row.key);
    return list === undefined ? [] : [{ row, changes: list }];
  });
}

export const CONFLICT_AREA_LABEL: Record<PlanConflict["area"], string> = {
  files: "File",
  "general-settings": "BB preference",
  experiments: "Experiment",
  "plugin-settings": "Plugin setting",
  keybindings: "Keyboard shortcuts",
  appearance: "Theme",
};

/** Collapse the long per-plugin "kept installed" notes into one line. */
export function summarizeWarnings(warnings: readonly string[]): string[] {
  const kept: string[] = [];
  const rest: string[] = [];
  for (const warning of warnings) {
    const match = /^Local plugin (.+) is not in the preset and will be kept installed\.$/.exec(warning);
    if (match !== null) kept.push(match[1]!);
    else rest.push(warning);
  }
  return kept.length === 0
    ? rest
    : [
        `${kept.length} ${kept.length === 1 ? "plugin is" : "plugins are"} installed here but not in the preset and stay installed: ${kept.join(", ")}.`,
        ...rest,
      ];
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function shortSha(value: string): string {
  return value.slice(0, 12);
}

export function readableDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === "unknown") return "legacy snapshot";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
