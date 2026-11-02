import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPullPlan,
  buildPushChanges,
  isPortableInstallSource,
  isSensitiveSettingKey,
  parseCatalogInstallSource,
  pluginSettingPresetEntrySchema,
  readPresetSnapshot,
  samePresetConfiguration,
  writePresetSnapshot,
  settingSafetyIssue,
  applySyncScope,
  mergePresetForPush,
  parseIdListSetting,
  FULL_SYNC_SCOPE,
  type PresetSnapshot,
  type SyncScope,
} from "../lib/preset";
import type { VendoredManifest } from "../lib/vendor";

const temporaryDirectories: string[] = [];

function snapshot(overrides: Partial<PresetSnapshot> = {}): PresetSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-04T00:00:00.000Z",
    bbVersion: "0.41.0",
    settings: {
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
    },
    plugins: [],
    marketplaces: [],
    pluginSettings: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("preset safety", () => {
  it("recognizes secret-like keys and machine-local plugin sources", () => {
    expect(isSensitiveSettingKey("githubToken")).toBe(true);
    expect(isSensitiveSettingKey("api_key")).toBe(true);
    expect(isSensitiveSettingKey("displayMode")).toBe(false);
    expect(isPortableInstallSource("path:/tmp/plugin")).toBe(false);
    expect(isPortableInstallSource("/tmp/plugin")).toBe(false);
    expect(isPortableInstallSource("../../plugin")).toBe(false);
    expect(isPortableInstallSource("plugin@bb-community")).toBe(true);
    expect(
      isPortableInstallSource("git:https://github.com/example/plugin.git@main"),
    ).toBe(true);
    expect(settingSafetyIssue("startFolder", "/Users/alice/work")).toBe(
      "machine-local path",
    );
    expect(
      settingSafetyIssue("options", JSON.stringify({ apiToken: "should-not-leak" })),
    ).toBe("credential-like data");
    expect(parseCatalogInstallSource("bb-sidebar@bb-community")).toEqual({
      entryId: "bb-sidebar",
      marketplace: "bb-community",
    });
    expect(parseCatalogInstallSource("bb-sidebar")).toEqual({
      entryId: "bb-sidebar",
    });
    expect(
      parseCatalogInstallSource("git:https://github.com/example/plugin.git@main"),
    ).toBeNull();
  });

  it("flags plugin installs as full-trust and never plans removal of extras", () => {
    const local = snapshot({
      plugins: [{ id: "local-only", install: "builtin:local-only", enabled: true }],
    });
    const remote = snapshot({
      plugins: [{ id: "shared", install: "shared@bb-community", enabled: true }],
    });
    const plan = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc123",
      local,
      remote,
    });

    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        kind: "plugin-install",
        target: "shared",
        risk: "full-trust",
      }),
    );
    expect(plan.changes.some((change) => change.action === "disable")).toBe(false);
    expect(plan.warnings).toContain(
      "Local plugin local-only is not in the preset and will be kept installed.",
    );
  });

  it("describes the exact preset changes available in the push direction", () => {
    const local = snapshot({
      plugins: [{ id: "local-only", install: "builtin:local-only", enabled: true }],
      settings: {
        ...snapshot().settings,
        appearance: { themeId: "dark", faviconColor: "default" },
      },
    });
    const remote = snapshot({
      plugins: [{ id: "remote-only", install: "builtin:remote-only", enabled: true }],
    });

    const changes = buildPushChanges(local, remote);

    expect(changes).toContainEqual(
      expect.objectContaining({
        action: "add",
        target: "local-only",
        summary: "Add plugin local-only to the preset",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        action: "remove",
        target: "remote-only",
        summary: "Remove plugin remote-only from the preset",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "appearance",
        summary: "Record theme dark in the preset",
      }),
    );
  });

  it("round-trips managed files while excluding Preset Sync itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-test-"));
    temporaryDirectories.push(directory);
    await writePresetSnapshot(
      directory,
      snapshot({
        plugins: [
          { id: "preset-sync", install: "path:/plugin", enabled: true },
          { id: "tasks", install: "builtin:tasks", enabled: true },
        ],
        pluginSettings: [
          { id: "preset-sync", key: "repositoryUrl", value: "private" },
          { id: "tasks", key: "view", value: "compact" },
        ],
      }),
    );

    const restored = await readPresetSnapshot(directory);
    expect(restored.plugins.map((plugin) => plugin.id)).toEqual(["tasks"]);
    expect(restored.pluginSettings).toEqual([
      { id: "tasks", key: "view", value: "compact" },
    ]);
  });

  it("ignores capture timestamps when deciding whether a push is needed", () => {
    const first = snapshot({ capturedAt: "2026-09-04T00:00:00.000Z" });
    const second = snapshot({ capturedAt: "2026-09-04T01:00:00.000Z" });
    expect(samePresetConfiguration(first, second)).toBe(true);
    expect(
      samePresetConfiguration(first, {
        ...second,
        settings: {
          ...second.settings,
          appearance: { themeId: "dark", faviconColor: "default" },
        },
      }),
    ).toBe(false);
  });

  it("rejects symbolic links in managed preset paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "preset"));
    await symlink(join(directory, "outside.json"), join(directory, "preset", "settings.json"));

    await expect(readPresetSnapshot(directory)).rejects.toThrow(
      "Preset path must not be a symbolic link: preset/settings.json",
    );
  });
});

describe("vendored pull plan", () => {
  const pluginPayload = (id: string, hash = "h1"): VendoredManifest => ({
    schemaVersion: 1,
    collections: [
      {
        id,
        kind: "plugin",
        pluginId: id,
        repoDir: `vendored/plugins/${id}`,
        hash,
        fileCount: 12,
        bytes: 4096,
        entries: [],
      },
    ],
  });
  const filesPayload = (id: string, hash = "h1"): VendoredManifest => ({
    schemaVersion: 1,
    collections: [
      {
        id,
        kind: "files",
        repoDir: `vendored/files/${id}`,
        target: "~/.agents/skills",
        hash,
        fileCount: 7,
        bytes: 2048,
        entries: [],
      },
    ],
  });

  it("plans a vendored plugin install instead of skipping it", () => {
    const remote = snapshot({
      plugins: [{ id: "wip", install: "vendored:wip", enabled: true }],
    });
    const plan = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local: snapshot(),
      remote,
      remoteVendored: pluginPayload("wip"),
    });
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        kind: "plugin-install",
        action: "install",
        target: "wip",
        summary: "Install wip from vendored files (12 files)",
      }),
    );
  });

  it("skips vendored installs whose payload is missing", () => {
    const remote = snapshot({
      plugins: [{ id: "wip", install: "vendored:wip", enabled: true }],
    });
    const plan = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local: snapshot(),
      remote,
    });
    expect(plan.changes).toHaveLength(0);
    expect(
      plan.warnings.some((warning) => warning.includes("missing its payload")),
    ).toBe(true);
  });

  it("plans vendored plugin updates by content hash", () => {
    const remote = snapshot({
      plugins: [{ id: "wip", install: "vendored:wip", enabled: true }],
    });
    const local = snapshot({
      plugins: [{ id: "wip", install: "vendored:wip", enabled: true }],
    });
    const stale = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local,
      remote,
      remoteVendored: pluginPayload("wip", "new-hash"),
      appliedVendored: {
        collections: { wip: { hash: "old-hash", appliedAt: "x" } },
      },
    });
    expect(stale.changes).toContainEqual(
      expect.objectContaining({ kind: "vendored", target: "wip" }),
    );

    const current = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local,
      remote,
      remoteVendored: pluginPayload("wip", "same-hash"),
      appliedVendored: {
        collections: { wip: { hash: "same-hash", appliedAt: "x" } },
      },
    });
    expect(current.changes.filter((c) => c.kind === "vendored")).toHaveLength(0);
  });

  it("plans file collection syncs only when not yet applied", () => {
    const remote = snapshot();
    const pending = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local: snapshot(),
      remote,
      remoteVendored: filesPayload("agents-skills"),
    });
    expect(pending.changes).toContainEqual(
      expect.objectContaining({
        kind: "vendored",
        summary: "Sync 7 files to ~/.agents/skills",
      }),
    );

    const done = buildPullPlan({
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "abc",
      local: snapshot(),
      remote,
      remoteVendored: filesPayload("agents-skills"),
      appliedVendored: {
        collections: {
          "agents-skills": { hash: "h1", appliedAt: "x" },
        },
      },
    });
    expect(done.changes).toHaveLength(0);
  });

  it("describes vendored changes in the push direction", () => {
    const local = pluginPayload("wip", "new-hash");
    const remote = pluginPayload("wip", "old-hash");
    const changes = buildPushChanges(snapshot(), snapshot(), {
      local,
      remote,
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "vendored",
        action: "update",
        target: "wip",
      }),
    );
  });

  it("round-trips number plugin settings through the preset schema", () => {
    const parsed = pluginSettingPresetEntrySchema.parse({
      id: "agent-usage",
      key: "overlayRefreshMinutes",
      value: 3,
    });
    expect(parsed.value).toBe(3);
  });
});

describe("sync scope", () => {
  const scope = (overrides: Partial<SyncScope> = {}): SyncScope => ({
    ...FULL_SYNC_SCOPE,
    ...overrides,
  });

  it("parses comma- and newline-separated id lists", () => {
    expect(parseIdListSetting("jira, env-catalog\n")).toEqual(
      new Set(["jira", "env-catalog"]),
    );
    expect(parseIdListSetting(undefined)).toEqual(new Set());
  });

  it("filters excluded plugins and setting keys from both directions", () => {
    const snap = snapshot({
      plugins: [
        { id: "jira", install: "jira@bb-community", enabled: true },
        { id: "tasks", install: "builtin:tasks", enabled: true },
      ],
      pluginSettings: [
        { id: "jira", key: "baseUrl", value: "https://x" },
        { id: "tasks", key: "view", value: "board" },
      ],
    });
    snap.settings.generalSettings.defaultProviderId = "claude-code";
    const filtered = applySyncScope(
      snap,
      scope({
        excludedPlugins: new Set(["jira"]),
        excludedSettingKeys: new Set(["defaultProviderId"]),
      }),
    );
    expect(filtered.plugins.map((p) => p.id)).toEqual(["tasks"]);
    expect(filtered.pluginSettings.map((e) => `${e.id}.${e.key}`)).toEqual([
      "tasks.view",
    ]);
    expect(filtered.settings.generalSettings.defaultProviderId).toBeUndefined();
  });

  it("push merge preserves remote values outside the local scope", () => {
    const remote = snapshot({
      plugins: [{ id: "jira", install: "jira@bb-community", enabled: true }],
      marketplaces: [{ name: "acme", source: "https://acme/m.json" }],
    });
    remote.settings.generalSettings.defaultProviderId = "claude-code";
    remote.settings.generalSettings.managedBranchPrefix = "acme/";
    const localBase = snapshot({
      plugins: [{ id: "tasks", install: "builtin:tasks", enabled: true }],
    });
    localBase.settings.generalSettings.managedBranchPrefix = "bb/";
    const local = applySyncScope(
      localBase,
      scope({
        syncMarketplaces: false,
        excludedPlugins: new Set(["jira"]),
        excludedSettingKeys: new Set(["defaultProviderId"]),
      }),
    );
    const merged = mergePresetForPush(
      local,
      remote,
      scope({
        syncMarketplaces: false,
        excludedPlugins: new Set(["jira"]),
        excludedSettingKeys: new Set(["defaultProviderId"]),
      }),
    );
    // In-scope plugin captured, excluded remote plugin preserved
    expect(merged.plugins.map((p) => p.id).sort()).toEqual(["jira", "tasks"]);
    // Disabled category keeps remote values
    expect(merged.marketplaces).toEqual(remote.marketplaces);
    // Excluded key preserved from remote, in-scope key from local
    expect(merged.settings.generalSettings.defaultProviderId).toBe("claude-code");
    expect(merged.settings.generalSettings.managedBranchPrefix).toBe("bb/");
  });
});
