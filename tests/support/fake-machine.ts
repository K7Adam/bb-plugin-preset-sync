/**
 * One simulated BB machine: an in-memory BB server state behind the fake
 * plugin host plus its own home directory. The general-settings endpoint
 * enforces the same contract as BB's PUT /settings/general (bb 0.48.2): the
 * body replaces the stored object, unknown keys are rejected and the
 * machine keys below are required.
 *
 * The test passes createFakePluginHost in: only *.test.ts files may import the
 * SDK testing entry point (see the public SDK scan in server.test.ts).
 */

export type CreateHost = (options: {
  pluginId: string;
  sdk: never;
}) => { bb: BbPluginApi; harness: unknown };
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PresetSyncService, type SyncSettings } from "../../lib/service";

export const FAKE_REMOTE_URL = "https://example.test/preset.git";

const REQUIRED_GENERAL_KEYS = [
  "showKeyboardHints",
  "steerActiveThreadOnEnter",
  "providerOrder",
  "defaultProviderId",
  "providerCompletedTurnDisplay",
  "streamerMode",
  "managedBranchPrefix",
  "machineServerUrl",
  "machineGitCredentialsEnabled",
  "defaultMachineAccess",
];

const KNOWN_GENERAL_KEYS = new Set([
  ...REQUIRED_GENERAL_KEYS,
  "terminalCopyOnSelect",
  "confirmThreadArchive",
  "showDiagnosticEvents",
  "showUnhandledProviderEvents",
  "keepHistoryAfterContextClear",
  "summarizeShellCommands",
  "allowFastServiceTier",
  "telemetryEnabled",
  "idleProviderSessionTimeoutMinutes",
  "onboardingCompletedAt",
  "earlyAdopter",
]);

export function defaultGeneralSettings(): Record<string, unknown> {
  return {
    showKeyboardHints: true,
    steerActiveThreadOnEnter: true,
    terminalCopyOnSelect: true,
    confirmThreadArchive: true,
    showDiagnosticEvents: false,
    showUnhandledProviderEvents: false,
    keepHistoryAfterContextClear: false,
    summarizeShellCommands: true,
    providerOrder: [],
    defaultProviderId: null,
    providerCompletedTurnDisplay: {},
    streamerMode: false,
    allowFastServiceTier: true,
    telemetryEnabled: true,
    managedBranchPrefix: "bb/",
    idleProviderSessionTimeoutMinutes: 30,
    machineServerUrl: null,
    machineGitCredentialsEnabled: true,
    defaultMachineAccess: null,
    onboardingCompletedAt: null,
    earlyAdopter: false,
  };
}

export interface FakePlugin {
  id: string;
  source: string;
  enabled: boolean;
  catalogEntryId?: string;
  catalogMarketplaceName?: string;
  settings?: {
    schema: Record<string, { type: string; options?: string[]; secret?: boolean }>;
    values: Record<string, unknown>;
  };
}

export interface MachineState {
  general: Record<string, unknown>;
  experiments: Record<string, boolean>;
  keybindingOverrides: unknown[];
  appearance: { themeId: string; faviconColor: string };
  plugins: FakePlugin[];
}

export function baseSettings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    repositoryUrl: FAKE_REMOTE_URL,
    branch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@example.test",
    includePluginSettings: true,
    backgroundCheckInterval: "Off",
    syncPlugins: true,
    syncMarketplaces: true,
    syncGeneralSettings: true,
    syncExperiments: true,
    syncKeybindings: true,
    syncAppearance: true,
    syncVendoredPlugins: false,
    syncVendoredFiles: true,
    vendoredPaths: "~/skills",
    vendorExcludeGlobs: "",
    vendorConflictMode: "skip",
    vendorPruneExtras: false,
    vendorNpmInstall: false,
    vendorMaxFileKb: 512,
    vendorMaxCollectionMb: 50,
    excludedPlugins: "",
    excludedSettingKeys: "",
    excludedPluginSettingKeys: "",
    ...overrides,
  };
}

function validateGeneralUpdate(payload: Record<string, unknown>): void {
  const unknown = Object.keys(payload).filter((key) => !KNOWN_GENERAL_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`400 unknown general settings keys: ${unknown.join(", ")}`);
  const missing = REQUIRED_GENERAL_KEYS.filter((key) => !(key in payload));
  if (!("showDiagnosticEvents" in payload) && !("showUnhandledProviderEvents" in payload)) {
    missing.push("showDiagnosticEvents");
  }
  if (missing.length > 0) throw new Error(`400 missing general settings keys: ${missing.join(", ")}`);
}

export async function createMachine(createHost: CreateHost, args: {
  state?: Partial<MachineState>;
  settings?: Partial<SyncSettings>;
  home?: string;
}) {
  const home = args.home ?? (await mkdtemp(join(tmpdir(), "preset-home-")));
  const state: MachineState = {
    general: defaultGeneralSettings(),
    experiments: { threadRowMetadata: false, performanceDiagnostics: false },
    keybindingOverrides: [],
    appearance: { themeId: "default", faviconColor: "default" },
    plugins: [{ id: "preset-sync", source: "path:/plugin", enabled: true }],
    ...args.state,
  };
  let settings = baseSettings(args.settings);
  const findPlugin = (pluginId: string) => {
    const plugin = state.plugins.find((entry) => entry.id === pluginId);
    if (plugin === undefined) throw new Error(`Plugin ${pluginId} is not installed`);
    return plugin;
  };

  const { bb, harness } = createHost({
    pluginId: "preset-sync",
    sdk: {
      system: {
        config: async () =>
          ({
            generalSettings: { ...state.general },
            experiments: { ...state.experiments },
            keybindingOverrides: [...state.keybindingOverrides],
            appearance: { ...state.appearance, customCss: null },
          }) as never,
        version: async () => ({ currentVersion: "0.48.2" }) as never,
        updateGeneralSettings: async (payload: Record<string, unknown>) => {
          validateGeneralUpdate(payload);
          const { showUnhandledProviderEvents, ...rest } = payload;
          state.general = {
            ...rest,
            showDiagnosticEvents:
              rest.showDiagnosticEvents ?? showUnhandledProviderEvents ?? false,
            showUnhandledProviderEvents:
              rest.showDiagnosticEvents ?? showUnhandledProviderEvents ?? false,
          };
          return { ...state.general } as never;
        },
        updateExperiments: async (payload: Record<string, boolean>) => {
          state.experiments = { ...state.experiments, ...payload };
          return {} as never;
        },
        updateKeyboardSettings: async (payload: unknown[]) => {
          state.keybindingOverrides = [...payload];
          return {} as never;
        },
      },
      theme: {
        set: async (payload: { themeId: string; faviconColor: string }) => {
          state.appearance = { ...payload };
          return {} as never;
        },
      },
      plugins: {
        list: async () =>
          ({
            plugins: state.plugins.map((plugin) => ({
              id: plugin.id,
              source: plugin.source,
              enabled: plugin.enabled,
              hasSettings: plugin.settings !== undefined,
              catalogEntryId: plugin.catalogEntryId,
              catalogMarketplaceName: plugin.catalogMarketplaceName,
            })),
          }) as never,
        getSettings: async ({ pluginId }: { pluginId: string }) => {
          const plugin = findPlugin(pluginId);
          return {
            ok: true,
            schema: plugin.settings?.schema ?? {},
            values: { ...(plugin.settings?.values ?? {}) },
          } as never;
        },
        updateSettings: async ({
          pluginId,
          values,
        }: {
          pluginId: string;
          values: Record<string, unknown>;
        }) => {
          const plugin = findPlugin(pluginId);
          plugin.settings = {
            schema: plugin.settings?.schema ?? {},
            values: { ...(plugin.settings?.values ?? {}), ...values },
          };
          return {} as never;
        },
        install: async ({ source }: { source: string }) => {
          state.plugins.push({ id: source.replace(/^.*[/:]/, ""), source, enabled: true });
          return {} as never;
        },
        enable: async ({ pluginId }: { pluginId: string }) => {
          findPlugin(pluginId).enabled = true;
          return {} as never;
        },
        disable: async ({ pluginId }: { pluginId: string }) => {
          findPlugin(pluginId).enabled = false;
          return {} as never;
        },
        reload: async () => ({}) as never,
        applyUpdate: async () => ({}) as never,
        marketplaces: {
          list: async () => [] as never,
          add: async () => ({}) as never,
        },
        catalog: {
          installPlan: async ({ entryId, marketplace }: { entryId: string; marketplace?: string }) =>
            ({
              kind: "marketplace",
              entryId,
              pluginId: entryId,
              compatible: true,
              incompatibleReason: null,
              marketplace: marketplace ?? "bb-community",
              resolvedSource: { kind: "git", url: "https://example.test/x.git" },
            }) as never,
          install: async ({ entryId, marketplace }: { entryId: string; marketplace?: string }) => {
            state.plugins.push({
              id: entryId,
              source: `git:https://example.test/${entryId}.git`,
              enabled: true,
              catalogEntryId: entryId,
              catalogMarketplaceName: marketplace ?? "bb-community",
            });
            return {} as never;
          },
        },
      },
    } as never,
  });

  const service = new PresetSyncService(bb, async () => settings);
  return {
    home,
    state,
    bb,
    harness,
    service,
    setSettings(next: Partial<SyncSettings>) {
      settings = { ...settings, ...next };
    },
  };
}

export type FakeMachine = Awaited<ReturnType<typeof createMachine>>;

/** Point os.homedir() at the machine's home for the duration of `run`. */
export async function onMachine<T>(machine: FakeMachine, run: () => Promise<T>): Promise<T> {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = machine.home;
  process.env.USERPROFILE = machine.home;
  try {
    return await run();
  } finally {
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
  }
}
