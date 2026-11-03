import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyResultSchema,
  cachedSyncCheckSchema,
  captureResultSchema,
  errorMessage,
  pushResultSchema,
  restoreResultSchema,
  syncPlanSchema,
  syncStatusSchema,
  SELF_PLUGIN_ID,
  type SyncPlan,
} from "./lib/preset";
import { PresetSyncService } from "./lib/service";

export const rpcContract = defineRpcContract({
  sync_status: {
    input: z.null(),
    output: syncStatusSchema,
  },
  sync_cached_check: {
    input: z.null(),
    output: cachedSyncCheckSchema.nullable(),
  },
  sync_preview: {
    input: z.null(),
    output: syncPlanSchema,
  },
  sync_capture: {
    input: z.null(),
    output: captureResultSchema,
  },
  sync_push: {
    input: z
      .object({
        fresh: z.boolean(),
        message: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    output: pushResultSchema,
  },
  sync_pull: {
    input: z
      .object({
        confirmed: z.literal(true),
        /** Fingerprint of the plan the user reviewed. */
        fingerprint: z.string().min(1).optional(),
        selectedChangeIds: z.array(z.string().min(1)).max(500).optional(),
        resolutions: z
          .record(z.string().min(1), z.enum(["keep-local", "take-remote"]))
          .optional(),
      })
      .strict(),
    output: applyResultSchema,
  },
  sync_restore: {
    input: z.object({ confirmed: z.literal(true) }).strict(),
    output: restoreResultSchema,
  },
  /** Change what this machine syncs; only these keys can be written from the page. */
  sync_update_scope: {
    input: z
      .object({
        values: z
          .object({
            syncPlugins: z.boolean(),
            includePluginSettings: z.boolean(),
            syncGeneralSettings: z.boolean(),
            syncExperiments: z.boolean(),
            syncKeybindings: z.boolean(),
            syncAppearance: z.boolean(),
            syncMarketplaces: z.boolean(),
            syncVendoredFiles: z.boolean(),
            syncVendoredPlugins: z.boolean(),
            vendoredPaths: z.string().max(4_000),
            vendorExcludeGlobs: z.string().max(4_000),
            vendorConflictMode: z.enum(["skip", "backup"]),
          })
          .partial()
          .strict()
          .refine((values) => Object.keys(values).length > 0, "Nothing to update"),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

const usage = [
  "Usage:",
  "  bb preset status [--json]",
  "  bb preset diff [--json]",
  "  bb preset capture [--json]",
  "  bb preset push [--fresh] [--message <text>] [--json]",
  "  bb preset pull --yes [--plan <fingerprint>] [--only <id,id>] [--json]",
  "  bb preset restore --yes [--json]",
  "",
  "Pull never removes anything: plugins and files missing from the preset stay.",
  "Machine settings (provider order, server URL, paths) stay on each machine.",
  "A file or setting changed here and in the preset is kept and shown as a conflict.",
  "Every pull backs up what it replaces; restore undoes the most recent pull.",
  "Secret settings, credentials, sessions, and runtime data are never captured.",
].join("\n");

function planText(plan: SyncPlan): string {
  const lines = [
    `${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"} from ${plan.repository}#${plan.branch}`,
    `Remote: ${plan.remoteHead.slice(0, 12)} (captured ${plan.remoteCapturedAt})`,
  ];
  if (plan.changes.length === 0) lines.push("Nothing to apply from the preset.");
  for (const change of plan.changes) {
    lines.push(
      `  ${change.risk === "full-trust" ? "!" : "+"} ${change.summary}  [${change.id ?? change.kind}]`,
    );
    if (change.detail !== undefined) lines.push(`      ${change.detail}`);
  }
  if (plan.conflicts.length > 0) {
    lines.push(
      `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"}, your version is kept:`,
    );
    for (const conflict of plan.conflicts) {
      lines.push(`  ~ ${conflict.target}: ${conflict.detail}`);
    }
  }
  for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  lines.push(`Plan: ${plan.fingerprint}`);
  return lines.join("\n");
}

function parsePositiveInt(value: string | boolean | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOption(
  argv: string[],
  name: string,
): { ok: true; value?: string } | { ok: false } {
  const index = argv.indexOf(name);
  if (index === -1) return { ok: true };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return { ok: false };
  return { ok: true, value };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repositoryUrl: {
      type: "string",
      label: "Preset repository",
      description:
        "Git repository that stores the preset (HTTPS or SSH). Use a private repository you own.",
    },
    branch: {
      type: "string",
      label: "Branch",
      description: "Git branch used for pull and push.",
      default: "main",
    },
    githubToken: {
      type: "string",
      label: "GitHub token (optional)",
      description:
        "Stored in BB's protected secrets file. Leave empty when Git Credential Manager or gh already authenticates Git.",
      secret: true,
    },
    gitAuthorName: {
      type: "string",
      label: "Git author name",
      default: "BB Preset Sync",
    },
    gitAuthorEmail: {
      type: "string",
      label: "Git author email",
      default: "bb-preset-sync@users.noreply.github.com",
    },
    includePluginSettings: {
      type: "boolean",
      label: "Sync plugin settings",
      description:
        "Non-secret plugin settings. Secrets, credential-like values and paths or commands of this machine always stay here.",
      default: true,
    },
    backgroundCheckInterval: {
      type: "select",
      label: "Background check interval",
      description:
        "How often to compare this BB installation with the preset. Checks never change anything. Select Off to disable them.",
      options: ["Off", "1 minute", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "60 minutes"],
      default: "5 minutes",
    },
    syncPlugins: {
      type: "boolean",
      label: "Sync plugins",
      description:
        "Install plugins from the preset and match enabled or disabled. Plugins missing from the preset are never removed.",
      default: true,
    },
    syncMarketplaces: {
      type: "boolean",
      label: "Sync marketplaces",
      description: "Add third-party plugin marketplaces recorded in the preset.",
      default: true,
    },
    syncGeneralSettings: {
      type: "boolean",
      label: "Sync BB preferences",
      description:
        "Preferences such as shortcut hints or the branch prefix. Machine settings (server URL, machine access, provider order, default provider) stay here unless listed below.",
      default: true,
    },
    syncExperiments: {
      type: "boolean",
      label: "Sync experiments",
      description:
        "Experiment flags. Performance diagnostics and server move always stay on this machine.",
      default: true,
    },
    syncKeybindings: {
      type: "boolean",
      label: "Sync keyboard shortcuts",
      description: "Keyboard shortcut overrides.",
      default: true,
    },
    syncAppearance: {
      type: "boolean",
      label: "Sync theme",
      description: "Theme and favicon color.",
      default: true,
    },
    syncVendoredFiles: {
      type: "boolean",
      label: "Sync folders",
      description:
        "Copy the folders listed below (for example skills) between machines. Files you edited here are never overwritten without asking.",
      default: false,
    },
    vendoredPaths: {
      type: "string",
      label: "Folders to sync",
      description:
        "One folder per line inside your home folder, for example ~/.agents/skills. Symbolic links are skipped; folders the Claude app manages (~/.claude/skills/synced) are always left alone.",
      default: "",
      experimental_multiline: true,
    },
    vendorExcludeGlobs: {
      type: "string",
      label: "Skip these files",
      description:
        "Patterns skipped in both directions, one per line or comma-separated, for example private/** or *.draft.md. node_modules, .git, OS noise and credential-like files are always skipped.",
      default: "",
      experimental_multiline: true,
    },
    vendorConflictMode: {
      type: "select",
      label: "When a file changed on both sides",
      description:
        "skip keeps your version and shows the conflict so you can decide (recommended). backup uses the preset version. Replaced files are always backed up and can be restored.",
      options: ["skip", "backup", "overwrite"],
      default: "skip",
    },
    syncVendoredPlugins: {
      type: "boolean",
      label: "Sync plugins installed from a local folder",
      description:
        "Copy their code into the preset so other machines can install them (under ~/.bb/preset-vendored). They run with full access, like every plugin.",
      default: false,
    },
    vendorPruneExtras: {
      type: "boolean",
      label: "Clean up synced plugin copies",
      description:
        "Move files that a vendored plugin no longer ships to ~/.bb/preset-vendored/trash. Your own folders are never pruned.",
      default: false,
    },
    vendorNpmInstall: {
      type: "boolean",
      label: "Install dependencies of synced plugins",
      description:
        "Run npm ci or npm install inside a vendored plugin that ships a package.json without node_modules.",
      default: true,
    },
    vendorMaxFileKb: {
      type: "string",
      label: "Largest file to sync (KB)",
      description: "Larger files are skipped.",
      default: "512",
    },
    vendorMaxCollectionMb: {
      type: "string",
      label: "Largest folder to sync (MB)",
      description: "Files beyond this total size are skipped.",
      default: "50",
    },
    excludedPlugins: {
      type: "string",
      label: "Plugins to leave alone",
      description:
        "Comma-separated plugin IDs that Preset Sync never installs, enables, disables, configures or records.",
      default: "",
    },
    excludedSettingKeys: {
      type: "string",
      label: "Keep these BB preferences on this machine",
      description: "Comma-separated preference keys, for example showKeyboardHints.",
      default: "",
    },
    syncedSettingKeys: {
      type: "string",
      label: "Also sync these machine settings",
      description:
        "Comma-separated keys that normally stay on each machine: providerOrder, defaultProviderId, streamerMode, idleProviderSessionTimeoutMinutes.",
      default: "",
    },
    excludedPluginSettingKeys: {
      type: "string",
      label: "Keep these plugin settings on this machine",
      description: "Comma-separated pluginId.settingKey pairs.",
      default: "",
    },
    syncedPluginSettingKeys: {
      type: "string",
      label: "Also sync these plugin paths or commands",
      description:
        "Comma-separated pluginId.settingKey pairs for settings that look machine-specific (keys ending in Command, Path, Dir, Directory, Home) but are the same everywhere.",
      default: "",
    },
  });

  const service = new PresetSyncService(bb, async () => {
    const value = await settings.get();
    return {
      repositoryUrl: value.repositoryUrl ?? "",
      branch: value.branch,
      githubToken: value.githubToken,
      gitAuthorName: value.gitAuthorName,
      gitAuthorEmail: value.gitAuthorEmail,
      includePluginSettings: value.includePluginSettings,
      backgroundCheckInterval: value.backgroundCheckInterval,
      syncPlugins: value.syncPlugins,
      syncMarketplaces: value.syncMarketplaces,
      syncGeneralSettings: value.syncGeneralSettings,
      syncExperiments: value.syncExperiments,
      syncKeybindings: value.syncKeybindings,
      syncAppearance: value.syncAppearance,
      syncVendoredPlugins: value.syncVendoredPlugins ?? false,
      syncVendoredFiles: value.syncVendoredFiles ?? false,
      vendoredPaths: value.vendoredPaths ?? "",
      vendorExcludeGlobs: value.vendorExcludeGlobs ?? "",
      vendorConflictMode: value.vendorConflictMode ?? "skip",
      vendorPruneExtras: value.vendorPruneExtras ?? false,
      vendorNpmInstall: value.vendorNpmInstall ?? true,
      vendorMaxFileKb: parsePositiveInt(value.vendorMaxFileKb, 512),
      vendorMaxCollectionMb: parsePositiveInt(value.vendorMaxCollectionMb, 50),
      excludedPlugins: value.excludedPlugins ?? "",
      excludedSettingKeys: value.excludedSettingKeys ?? "",
      excludedPluginSettingKeys: value.excludedPluginSettingKeys ?? "",
      syncedSettingKeys: value.syncedSettingKeys ?? "",
      syncedPluginSettingKeys: value.syncedPluginSettingKeys ?? "",
    };
  });

  settings.onChange(() => service.wakeBackgroundCheck());

  bb.rpc.register(rpcContract, {
    sync_status: () => service.status(),
    sync_cached_check: () => service.cachedCheck(),
    sync_preview: () => service.preview(),
    sync_capture: () => service.capture(),
    sync_push: ({ fresh, message }) => service.push({ fresh, message }),
    sync_pull: ({ fingerprint, selectedChangeIds, resolutions }) =>
      service.pullAndApply({
        expectedFingerprint: fingerprint,
        selectedChangeIds,
        resolutions,
      }),
    sync_restore: () => service.restore(),
    sync_update_scope: async ({ values }) => {
      await bb.sdk.plugins.updateSettings({ pluginId: SELF_PLUGIN_ID, values });
      service.wakeBackgroundCheck();
      return { ok: true as const };
    },
  });

  bb.background.service("change-check", {
    start: (signal) => service.runBackgroundChecks(signal),
  });

  bb.cli.register({
    name: "preset",
    summary: "Synchronize BB plugins and settings through a Git repository",
    commands: [
      {
        name: "status",
        summary: "Compare this BB installation with the Git preset",
        usage: "bb preset status [--json]",
      },
      {
        name: "diff",
        summary: "Preview changes and conflicts that pull would apply",
        usage: "bb preset diff [--json]",
      },
      {
        name: "capture",
        summary: "Stage the current BB preset locally",
        usage: "bb preset capture [--json]",
      },
      {
        name: "push",
        summary: "Push the staged or freshly captured preset to Git",
        usage: "bb preset push [--fresh] [--message <text>] [--json]",
      },
      {
        name: "pull",
        summary: "Apply the Git preset after an explicit preview",
        usage: "bb preset pull --yes [--plan <fingerprint>] [--only <id,id>] [--json]",
      },
      {
        name: "restore",
        summary: "Undo the most recent pull",
        usage: "bb preset restore --yes [--json]",
      },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const command = argv.find((argument) => !argument.startsWith("--"));
      const respond = (value: unknown, text: string, exitCode = 0) => ({
        exitCode,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      try {
        switch (command) {
          case undefined:
          case "help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const status = await service.status(context.signal);
            const lines = [
              `Repository: ${status.repository}#${status.branch}`,
              `Remote: ${status.remoteHead.slice(0, 12)} (captured ${status.remoteCapturedAt})`,
              `Pending pull changes: ${status.changeCount}`,
              `Conflicts: ${status.conflicts.length}`,
              `Pending push changes: ${status.pushChangeCount}`,
              `Checked: ${status.checkedAt}`,
              `Staged capture: ${status.stagedAt ?? "none"}`,
            ];
            if (status.lastOperation !== null) {
              lines.push(
                `Last operation: ${status.lastOperation.type} at ${status.lastOperation.at} — ${status.lastOperation.summary}`,
              );
            }
            for (const warning of status.warnings) lines.push(`  ! ${warning}`);
            return respond(status, lines.join("\n"));
          }
          case "diff": {
            const plan = await service.preview(context.signal);
            return respond(plan, planText(plan));
          }
          case "capture": {
            const captured = await service.capture();
            const vendored =
              captured.vendoredCount > 0
                ? `, ${captured.vendoredCount} vendored ${captured.vendoredCount === 1 ? "collection" : "collections"} (${captured.vendoredFileCount} files)`
                : "";
            const text = [
              `Captured ${captured.pluginCount} plugins, ${captured.pluginSettingCount} non-secret plugin settings, ${captured.marketplaceCount} marketplaces${vendored}.`,
              `Staged at ${captured.capturedAt}.`,
              ...captured.warnings.map((warning) => `  ! ${warning}`),
            ].join("\n");
            return respond(captured, text);
          }
          case "push": {
            const parsedMessage = parseOption(argv, "--message");
            if (!parsedMessage.ok) return { exitCode: 2, stderr: usage };
            const known = new Set([
              "push",
              "--fresh",
              "--json",
              "--message",
              parsedMessage.value,
            ]);
            if (argv.some((argument) => !known.has(argument))) {
              return { exitCode: 2, stderr: usage };
            }
            const pushed = await service.push({
              fresh: argv.includes("--fresh"),
              message: parsedMessage.value,
              signal: context.signal,
            });
            const text = pushed.pushed
              ? `Pushed ${pushed.changedFiles.length} preset files at ${pushed.head.slice(0, 12)}.`
              : `Git preset is already current at ${pushed.head.slice(0, 12)}.`;
            return respond(pushed, text);
          }
          case "pull": {
            const planOption = parseOption(argv, "--plan");
            const onlyOption = parseOption(argv, "--only");
            if (!planOption.ok || !onlyOption.ok) return { exitCode: 2, stderr: usage };
            if (!argv.includes("--yes")) {
              const plan = await service.preview(context.signal);
              return {
                ...respond(plan, planText(plan), plan.changes.length === 0 ? 0 : 2),
                stderr:
                  plan.changes.length === 0
                    ? undefined
                    : `Nothing was changed. Review the preview, then rerun with "bb preset pull --yes --plan ${plan.fingerprint}".`,
              };
            }
            const result = await service.pullAndApply({
              signal: context.signal,
              expectedFingerprint: planOption.value,
              selectedChangeIds: onlyOption.value
                ?.split(",")
                .map((id) => id.trim())
                .filter((id) => id !== ""),
            });
            const text = [
              result.ok
                ? `Applied ${result.applied.length} changes from the preset.`
                : `Applied ${result.applied.length} changes with ${result.errors.length} errors.`,
              ...result.applied.map((entry) => `  + ${entry}`),
              ...result.skipped.map((entry) => `  - ${entry}`),
              ...result.errors.map((entry) => `  x ${entry}`),
              ...result.warnings.map((entry) => `  ! ${entry}`),
              result.backupRun === null
                ? "Nothing needed a backup."
                : `Backup: ~/.bb/preset-vendored/backup/${result.backupRun} (undo with "bb preset restore --yes").`,
            ].join("\n");
            return respond(result, text, result.ok ? 0 : 1);
          }
          case "restore": {
            if (!argv.includes("--yes")) {
              return {
                exitCode: 2,
                stderr: 'Restore undoes the most recent pull. Rerun with "bb preset restore --yes".',
              };
            }
            const result = await service.restore();
            const text = [
              `Restored ${result.restored.length} items from ${result.run}.`,
              ...result.restored.map((entry) => `  + ${entry}`),
              ...result.skipped.map((entry) => `  - ${entry}`),
              ...result.errors.map((entry) => `  x ${entry}`),
            ].join("\n");
            return respond(result, text, result.errors.length === 0 ? 0 : 1);
          }
          default:
            return { exitCode: 2, stderr: usage };
        }
      } catch (cause) {
        return {
          exitCode: 1,
          stderr: `Preset Sync: ${errorMessage(cause)}`,
        };
      }
    },
  });

  bb.log.info("ready: bb preset status|diff|capture|push|pull|restore");
}
