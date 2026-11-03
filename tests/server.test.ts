import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { backgroundIntervalMs, installPluginFromPreset } from "../lib/service";

function createHost() {
  return createFakePluginHost({
    pluginId: "preset-sync",
    sdk: {
      system: {
        config: async () => ({
          generalSettings: {
            defaultProviderId: null,
            providerOrder: [],
            showKeyboardHints: true,
            showUnhandledProviderEvents: false,
            steerActiveThreadOnEnter: true,
            streamerMode: false,
          },
          experiments: {
            changelogPreview: false,
            editMessages: true,
            mobileApp: false,
            timelineWindowing: false,
          },
          keybindingOverrides: [],
          appearance: { themeId: "default", faviconColor: "default" },
        }),
        version: async () => ({ currentVersion: "0.41.0" }),
      },
      plugins: {
        list: async () => ({
          plugins: [
            {
              id: "preset-sync",
              source: "path:/plugin",
              enabled: true,
              hasSettings: true,
            },
            {
              id: "tasks",
              source: "builtin:tasks",
              enabled: true,
              hasSettings: false,
            },
          ],
        }),
        marketplaces: {
          list: async () => [],
        },
      },
    },
  });
}

describe("plugin registration", () => {
  it("registers the preset CLI and stages a secret-safe capture", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    expect(harness.inspection.registrations.cli?.name).toBe("preset");
    expect(harness.inspection.registrations.settingsDescriptors.githubToken).toEqual(
      expect.objectContaining({ secret: true }),
    );
    expect(
      harness.inspection.registrations.settingsDescriptors.repositoryUrl,
    ).not.toHaveProperty("default");
    expect(
      harness.inspection.registrations.settingsDescriptors.backgroundCheckInterval,
    ).toEqual(
      expect.objectContaining({
        type: "select",
        default: "5 minutes",
      }),
    );
    expect(harness.inspection.registrations.services.map((service) => service.name)).toEqual([
      "change-check",
    ]);
    await expect(harness.behavior.callRpc("sync_cached_check", null)).resolves.toBeNull();

    const result = await harness.behavior.runCli(["capture", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        pluginCount: 1,
        pluginSettingCount: 0,
        marketplaceCount: 0,
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("parses the supported background check intervals", () => {
    expect(backgroundIntervalMs("Off")).toBeNull();
    expect(backgroundIntervalMs("1 minute")).toBe(60_000);
    expect(backgroundIntervalMs("30 minutes")).toBe(30 * 60_000);
    expect(backgroundIntervalMs("unexpected")).toBe(5 * 60_000);
  });

  const resolvedSource = {
    kind: "git" as const,
    url: "https://github.com/yusuf8834/bb-sidebar.git",
    range: "^0.2.0",
    resolvedCommit: "abc123",
    resolvedTag: "v0.2.4",
  };

  function catalogHost(official: boolean) {
    return createFakePluginHost({
      pluginId: "preset-sync",
      sdk: {
        plugins: {
          install: async () => {
            throw new Error("direct install must not handle catalog shorthand");
          },
          catalog: {
            installPlan: async ({ entryId, marketplace }) => ({
              kind: "marketplace",
              entryId,
              pluginId: entryId,
              displayName: "BB Sidebar",
              source: `${entryId}@${marketplace}`,
              marketplace: marketplace ?? "bb-community",
              marketplaceDisplayName: official ? "BB Community" : "y5k",
              official,
              author: { name: "Test", url: null },
              compatible: true,
              incompatibleReason: null,
              resolvedSource,
            }),
            install: async () => ({}) as never,
          },
        },
      },
    });
  }

  // BB refuses confirmedSource for its own marketplaces ("install refused:
  // confirmedSource applies only to third-party marketplaces", bb 0.48.2).
  it("installs from BB's own marketplaces without a source confirmation", async () => {
    const { bb, harness } = catalogHost(true);

    await installPluginFromPreset(bb, "bb-sidebar@bb-community");

    expect(harness.inspection.sdk.callsTo("plugins.install")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("plugins.catalog.installPlan")[0]?.[0]).toEqual({
      entryId: "bb-sidebar",
      marketplace: "bb-community",
      signal: undefined,
    });
    expect(harness.inspection.sdk.callsTo("plugins.catalog.install")[0]?.[0]).toEqual({
      entryId: "bb-sidebar",
      marketplace: "bb-community",
    });
    await harness.lifecycle.dispose();
  });

  it("confirms the resolved source for third-party marketplaces", async () => {
    const { bb, harness } = catalogHost(false);

    await installPluginFromPreset(bb, "bb-sidebar@y5k");

    expect(harness.inspection.sdk.callsTo("plugins.catalog.install")[0]?.[0]).toEqual({
      entryId: "bb-sidebar",
      marketplace: "y5k",
      confirmedSource: resolvedSource,
    });
    await harness.lifecycle.dispose();
  });

  it("keeps direct Git sources on the direct install API", async () => {
    const source = "git:https://github.com/example/plugin.git@main";
    const { bb, harness } = createFakePluginHost({
      pluginId: "preset-sync",
      sdk: {
        plugins: {
          install: async () => ({}) as never,
        },
      },
    });

    await installPluginFromPreset(bb, source);

    expect(harness.inspection.sdk.callsTo("plugins.install")[0]?.[0]).toEqual({
      source,
    });
    expect(harness.inspection.sdk.callsTo("plugins.catalog.installPlan")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("plugins.catalog.install")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("explains how to configure a repository before remote operations", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Preset repository is not configured");

    await harness.lifecycle.dispose();
  });

  it("lets the page change only what this machine syncs", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "preset-sync",
      sdk: { plugins: { updateSettings: async () => ({}) as never } },
    });
    await plugin(bb);

    await harness.behavior.callRpc("sync_update_scope", {
      values: { syncPlugins: false, vendorConflictMode: "skip" },
    });
    expect(harness.inspection.sdk.callsTo("plugins.updateSettings")[0]?.[0]).toEqual({
      pluginId: "preset-sync",
      values: { syncPlugins: false, vendorConflictMode: "skip" },
    });
    await expect(
      harness.behavior.callRpc("sync_update_scope", {
        values: { repositoryUrl: "https://example.test/other.git" },
      }),
    ).rejects.toThrow();
    await expect(harness.behavior.callRpc("sync_update_scope", { values: {} })).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("plugins.updateSettings")).toHaveLength(1);

    await harness.lifecycle.dispose();
  });

  it("uses only the public plugin SDK", () => {
    const scan = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^@\//,
        /^react(?:-dom)?(?:\/.*)?$/,
        /^@radix-ui\/react-(?:checkbox|dialog|slot)$/,
        /^@hugeicons\/(?:core-free-icons|react)$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
        /^@testing-library\/react$/,
        /^vitest(?:\/.*)?$/,
      ],
    });
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
