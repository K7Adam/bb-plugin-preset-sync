import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyResultSchema,
  cachedSyncCheckSchema,
  captureResultSchema,
  errorMessage,
  pushResultSchema,
  syncPlanSchema,
  syncStatusSchema,
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
    input: z.object({ confirmed: z.literal(true) }).strict(),
    output: applyResultSchema,
  },
});

const usage = [
  "Usage:",
  "  bb preset status [--json]",
  "  bb preset diff [--json]",
  "  bb preset capture [--json]",
  "  bb preset push [--fresh] [--message <text>] [--json]",
  "  bb preset pull --yes [--json]",
  "",
  "Pull is additive: local plugins absent from the preset are kept.",
  "Secret settings, credentials, sessions, and runtime data are never captured.",
].join("\n");

function planText(plan: SyncPlan): string {
  const lines = [
    `${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"} from ${plan.repository}#${plan.branch}`,
    `Remote: ${plan.remoteHead.slice(0, 12)} (captured ${plan.remoteCapturedAt})`,
  ];
  if (plan.changes.length === 0) lines.push("Preset already matches this machine.");
  for (const change of plan.changes) {
    lines.push(`  ${change.risk === "full-trust" ? "!" : "+"} ${change.summary}`);
  }
  for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

function parseMessage(argv: string[]): { ok: true; message?: string } | { ok: false } {
  const index = argv.indexOf("--message");
  if (index === -1) return { ok: true };
  const message = argv[index + 1];
  if (message === undefined || message.startsWith("--")) return { ok: false };
  return { ok: true, message };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repositoryUrl: {
      type: "string",
      label: "Preset repository",
      description: "Git repository containing preset/*.json. HTTPS and SSH URLs are supported.",
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
      label: "Capture non-secret plugin settings",
      description:
        "Secret descriptors and suspicious credential-like keys are always excluded.",
      default: true,
    },
    backgroundCheckInterval: {
      type: "select",
      label: "Background check interval",
      description:
        "How often to compare this BB installation with the Git preset. Select Off to disable background checks.",
      options: ["Off", "1 minute", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "60 minutes"],
      default: "5 minutes",
    },
    syncPlugins: {
      type: "boolean",
      label: "Sync plugins",
      description:
        "Capture, install, and enable/disable plugins through the preset. When off, the preset keeps whatever the remote already records.",
      default: true,
    },
    syncMarketplaces: {
      type: "boolean",
      label: "Sync marketplaces",
      description: "Sync third-party plugin marketplaces.",
      default: true,
    },
    syncGeneralSettings: {
      type: "boolean",
      label: "Sync general settings",
      description: "Sync general BB settings through the preset.",
      default: true,
    },
    syncExperiments: {
      type: "boolean",
      label: "Sync experiment flags",
      description: "Sync BB experiment flags.",
      default: true,
    },
    syncKeybindings: {
      type: "boolean",
      label: "Sync keyboard shortcuts",
      description: "Sync keyboard shortcut overrides.",
      default: true,
    },
    syncAppearance: {
      type: "boolean",
      label: "Sync appearance",
      description: "Sync theme and favicon color.",
      default: true,
    },
    excludedPlugins: {
      type: "string",
      label: "Excluded plugins",
      description:
        "Comma-separated plugin IDs left unmanaged: never captured, installed, enabled, disabled, or configured from the preset.",
      default: "",
    },
    excludedSettingKeys: {
      type: "string",
      label: "Excluded general settings keys",
      description:
        "Comma-separated general settings keys excluded from sync (for example: defaultProviderId, providerOrder).",
      default: "",
    },
    excludedPluginSettingKeys: {
      type: "string",
      label: "Excluded plugin settings",
      description:
        "Comma-separated pluginId.settingKey pairs excluded from plugin settings sync.",
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
      excludedPlugins: value.excludedPlugins ?? "",
      excludedSettingKeys: value.excludedSettingKeys ?? "",
      excludedPluginSettingKeys: value.excludedPluginSettingKeys ?? "",
    };
  });

  settings.onChange(() => service.wakeBackgroundCheck());

  bb.rpc.register(rpcContract, {
    sync_status: () => service.status(),
    sync_cached_check: () => service.cachedCheck(),
    sync_preview: () => service.preview(),
    sync_capture: () => service.capture(),
    sync_push: ({ fresh, message }) => service.push({ fresh, message }),
    sync_pull: () => service.pullAndApply(),
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
        summary: "Preview changes that pull would apply",
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
        summary: "Pull and apply the Git preset after an explicit preview",
        usage: "bb preset pull --yes [--json]",
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
            const text = [
              `Captured ${captured.pluginCount} plugins, ${captured.pluginSettingCount} non-secret plugin settings, and ${captured.marketplaceCount} marketplaces.`,
              `Staged at ${captured.capturedAt}.`,
              ...captured.warnings.map((warning) => `  ! ${warning}`),
            ].join("\n");
            return respond(captured, text);
          }
          case "push": {
            const parsedMessage = parseMessage(argv);
            if (!parsedMessage.ok) return { exitCode: 2, stderr: usage };
            const known = new Set([
              "push",
              "--fresh",
              "--json",
              "--message",
              parsedMessage.message,
            ]);
            if (argv.some((argument) => !known.has(argument))) {
              return { exitCode: 2, stderr: usage };
            }
            const pushed = await service.push({
              fresh: argv.includes("--fresh"),
              message: parsedMessage.message,
              signal: context.signal,
            });
            const text = pushed.pushed
              ? `Pushed ${pushed.changedFiles.length} preset files at ${pushed.head.slice(0, 12)}.`
              : `Git preset is already current at ${pushed.head.slice(0, 12)}.`;
            return respond(pushed, text);
          }
          case "pull": {
            if (!argv.includes("--yes")) {
              const plan = await service.preview(context.signal);
              return {
                ...respond(
                  plan,
                  planText(plan),
                  plan.changes.length === 0 ? 0 : 2,
                ),
                stderr:
                  plan.changes.length === 0
                    ? undefined
                    : 'Nothing was changed. Review the preview, then rerun with "bb preset pull --yes".',
              };
            }
            const result = await service.pullAndApply(context.signal);
            const text = [
              result.ok
                ? `Applied ${result.applied.length} changes from GitHub.`
                : `Applied ${result.applied.length} changes with ${result.errors.length} errors.`,
              ...result.applied.map((entry) => `  + ${entry}`),
              ...result.skipped.map((entry) => `  - ${entry}`),
              ...result.errors.map((entry) => `  x ${entry}`),
              ...result.warnings.map((entry) => `  ! ${entry}`),
            ].join("\n");
            return respond(result, text, result.ok ? 0 : 1);
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

  bb.log.info("ready: bb preset status|diff|capture|push|pull");
}
