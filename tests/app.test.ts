// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import type { SyncPlan, SyncStatus } from "../lib/preset";

// The first import transforms the whole app bundle; under a parallel full run
// that alone can exceed a test timeout. Load it once up front so each test
// measures only its own behaviour.
beforeAll(async () => {
  await loadPluginApp(() => import("../app"));
}, 120_000);

const repository = "https://github.com/example/preset.git";

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    checkedAt: "2026-09-04T08:00:00.000Z",
    repository,
    branch: "main",
    remoteHead: "0123456789abcdef",
    remoteCapturedAt: "2026-09-04T07:00:00.000Z",
    localCapturedAt: "2026-09-04T08:00:00.000Z",
    stagedAt: null,
    changeCount: 1,
    pushChangeCount: 1,
    pullChanges: [
      {
        id: "plugin-install:remote-plugin",
        kind: "plugin-install",
        action: "install",
        target: "remote-plugin",
        summary: "Install remote-plugin from remote-plugin@y5k",
        risk: "full-trust",
      },
    ],
    pushChanges: [
      {
        kind: "appearance",
        action: "update",
        target: "Theme",
        summary: "Record theme dark in the preset",
        risk: "configuration",
      },
    ],
    conflicts: [
      {
        id: "conflict:files:skills:a.md",
        area: "files",
        target: "~/skills/a.md",
        detail: "Changed here and in the preset since the last sync. Your version is kept until you choose.",
      },
    ],
    warnings: [],
    lastOperation: null,
    ...overrides,
  };
}

function plan(): SyncPlan {
  const current = status();
  return {
    repository,
    branch: "main",
    remoteHead: current.remoteHead,
    remoteCapturedAt: current.remoteCapturedAt,
    localCapturedAt: current.localCapturedAt,
    changes: current.pullChanges,
    conflicts: current.conflicts,
    warnings: [
      "Local plugin jira is not in the preset and will be kept installed.",
      "Local plugin tasks is not in the preset and will be kept installed.",
    ],
    fingerprint: "plan-fingerprint",
  };
}

function rpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  return {
    sync_status: () => status(),
    sync_cached_check: () => ({ checkedAt: status().checkedAt, status: status(), error: null }),
    sync_preview: () => plan(),
    sync_pull: () => ({
      ok: true,
      plan: plan(),
      applied: ["Synced 1 file to ~/skills"],
      skipped: [],
      errors: [],
      warnings: [],
      backupRun: "2026-09-04T08-00-00-000Z-abc123",
    }),
    sync_update_scope: () => ({ ok: true }),
    ...overrides,
  };
}

type Mounted = { lifecycle: { unmount(): void } };
const mounted: Mounted[] = [];
function track<T extends Mounted>(slot: T): T {
  mounted.push(slot);
  return slot;
}
afterEach(() => {
  for (const slot of mounted.splice(0)) {
    try {
      slot.lifecycle.unmount();
    } catch {
      // already unmounted by the test
    }
  }
});

const settings = { repositoryUrl: repository, branch: "main", backgroundCheckInterval: "5 minutes" };

describe("plugin app registration", () => {
  it(
    "exposes Preset Sync in settings and the sidebar",
    { timeout: 20_000 },
    async () => {
      const app = await loadPluginApp(() => import("../app"));

      expect(app.settingsSections).toEqual([
        expect.objectContaining({ id: "preset-sync", title: "Preset Sync" }),
      ]);
      expect(app.navPanels).toEqual([
        expect.objectContaining({
          id: "preset-sync",
          title: "Preset Sync",
          icon: "Cloud",
          path: "preset-sync",
        }),
      ]);
      expect(app.navPanels[0]?.experimental_sidebarAccessory).toBeTypeOf("function");
    },
  );

  it("explains the first steps before a repository is configured", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = track(renderSlot(app.navPanels[0]!, { subPath: "" }, { settings: {}, rpc: rpc() }));

    expect(await slot.findByText("Set up Preset Sync")).toBeTruthy();
    expect(slot.getByText("What this machine syncs")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("summarizes pending work in plain words", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = track(renderSlot(app.navPanels[0]!, { subPath: "" }, { settings, rpc: rpc() }));

    expect(
      await slot.findByText(
        "1 update from the preset · 1 conflict to decide · 1 change on this machine not published yet",
      ),
    ).toBeTruthy();
    expect(slot.getByText(/Record theme dark in the preset/)).toBeTruthy();
    expect(slot.getByRole("button", { name: /Publish 1 change/ })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("applies exactly the reviewed selection and conflict decisions", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = track(renderSlot(app.navPanels[0]!, { subPath: "" }, { settings, rpc: rpc() }));

    fireEvent.click(await slot.findByRole("button", { name: "Review updates" }));
    expect(await slot.findByText("Review updates from the preset")).toBeTruthy();
    expect(slot.getByText("full access")).toBeTruthy();
    expect(slot.queryByText(/2 plugins are installed here but not in the preset/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Show 1 note" }));
    expect(slot.getByText(/2 plugins are installed here but not in the preset/)).toBeTruthy();

    fireEvent.click(slot.getByRole("checkbox", { name: /Install remote-plugin/ }));
    fireEvent.click(slot.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(slot.getByRole("button", { name: "Apply 0 changes and 1 decision" }));
    fireEvent.click(await slot.findByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "sync_pull")?.input).toEqual({
        confirmed: true,
        fingerprint: "plan-fingerprint",
        selectedChangeIds: [],
        resolutions: { "conflict:files:skills:a.md": "keep-local" },
      }),
    );
    expect(await slot.findByRole("button", { name: /Undo this pull/ })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("changes what this machine syncs from the page", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = track(renderSlot(app.navPanels[0]!, { subPath: "" }, { settings, rpc: rpc() }));

    const plugins = await slot.findByRole("switch", { name: "Sync Plugins" });
    expect(plugins.getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("switch", { name: "Sync Folders" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(plugins);

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.find((call) => call.method === "sync_update_scope")?.input,
      ).toEqual({ values: { syncPlugins: false } }),
    );
    slot.lifecycle.unmount();
  });

  it("shows pull, push and conflict counts in the sidebar", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const accessory = app.navPanels[0]?.experimental_sidebarAccessory;
    if (accessory === undefined) throw new Error("Sidebar accessory is missing");
    const indicator = track(renderSlot(
      { component: accessory },
      {},
      { settings: { repositoryUrl: repository }, rpc: rpc() },
    ));
    expect(await indicator.findByText("↓1 ↑1 ≠1")).toBeTruthy();
    indicator.lifecycle.unmount();
  });

  it("renders no sidebar indicator while both sides match", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const accessory = app.navPanels[0]?.experimental_sidebarAccessory;
    if (accessory === undefined) throw new Error("Sidebar accessory is missing");
    const clean = status({
      changeCount: 0,
      pushChangeCount: 0,
      pullChanges: [],
      pushChanges: [],
      conflicts: [],
    });
    const indicator = track(renderSlot(
      { component: accessory },
      {},
      {
        settings: { repositoryUrl: repository },
        rpc: {
          sync_cached_check: () => ({ checkedAt: clean.checkedAt, status: clean, error: null }),
        },
      },
    ));

    await waitFor(() => expect(indicator.inspection.rpcCalls).toHaveLength(1));
    expect(indicator.container.textContent).toBe("");
    indicator.lifecycle.unmount();
  });
});

describe("skills on the page", () => {
  const skillConflict = {
    id: "conflict:skill:agents-skills:deslop",
    area: "files" as const,
    target: "~/.agents/skills/deslop",
    detail: "Changed here and in the preset since the last sync (1 file differs).",
    skill: {
      collectionId: "agents-skills",
      skill: "deslop",
      paths: ["deslop/SKILL.md"],
      newer: "remote" as const,
      evidence: "source" as const,
      hint: false,
      reason: "Both installed from acme/skills; updated later on OMEN (2026-10-30).",
    },
  };

  it("shows which machine is newer, the difference and the remembered rule", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const plan = { ...((): SyncPlan => ({
      repository,
      branch: "main",
      remoteHead: "0123456789abcdef",
      remoteCapturedAt: "2026-11-02T19:35:32.049Z",
      localCapturedAt: "2026-11-03T08:00:00.000Z",
      remoteMachine: "OMEN",
      changes: [],
      conflicts: [skillConflict],
      warnings: [],
      fingerprint: "fp",
    }))() };
    const slot = track(
      renderSlot(app.navPanels[0]!, { subPath: "" }, {
        settings,
        rpc: rpc({
          sync_preview: () => plan,
          sync_conflict_detail: () => ({
            conflictId: skillConflict.id,
            remoteMachine: "OMEN",
            skill: skillConflict.skill,
            files: [
              {
                path: "deslop/SKILL.md",
                change: "differs",
                patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n",
                lineEndingsOnly: false,
                binary: false,
              },
            ],
          }),
          sync_set_skill_rule: () => ({ ok: true }),
        }),
      }),
    );

    fireEvent.click(await slot.findByRole("button", { name: "Review updates" }));
    expect(await slot.findByText(/OMEN is newer/)).toBeTruthy();
    expect(slot.getByText(/by install source/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Show differences/ }));
    expect(await slot.findByText(/Lines with − are only in your copy/)).toBeTruthy();
    fireEvent.change(slot.getByRole("combobox", { name: "Rule for deslop" }), { target: { value: "newer" } });
    fireEvent.click(slot.getByRole("button", { name: /Take the newer version for 1 skill/ }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "sync_set_skill_rule")?.input).toEqual({
        collectionId: "agents-skills",
        skill: "deslop",
        rule: "newer",
      }),
    );
    expect(slot.getByRole("button", { name: /Use OMEN's \(recommended\)/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows skill counts per folder and saves a skipped group", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const overview = {
      remoteMachine: "OMEN",
      groups: [],
      folders: [
        {
          collectionId: "agents-skills",
          target: "~/.agents/skills",
          skills: [
            { name: "android-cli", status: "new", here: false, inPreset: true, tokens: 60 },
            { name: "deslop", status: "conflict", here: true, inPreset: true, tokens: 50 },
          ],
          counts: { here: 1, afterPull: 2, inPreset: 2, skipped: 0 },
          tokensHere: 50,
          tokensAfterPull: 110,
        },
      ],
    };
    const slot = track(
      renderSlot(app.navPanels[0]!, { subPath: "" }, {
        settings,
        rpc: rpc({ sync_skills_overview: () => overview, sync_save_skill_groups: () => ({ ok: true }) }),
      }),
    );

    fireEvent.click(await slot.findByRole("button", { name: "Show skills" }));
    expect(await slot.findByText("~/.agents/skills")).toBeTruthy();
    expect(slot.getByText("~50 → ~110 startup tokens")).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "New group name" }), { target: { value: "Android" } });
    fireEvent.change(slot.getByRole("textbox", { name: "New group patterns" }), { target: { value: "android-*" } });
    expect(slot.getByText(/Matches 1: android-cli/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Add and skip/ }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "sync_save_skill_groups")?.input).toEqual({
        groups: [{ id: "android", name: "Android", patterns: ["android-*"], skip: true }],
      }),
    );
  });

  it("stops a publish with blocked terms until the user publishes anyway", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = track(
      renderSlot(app.navPanels[0]!, { subPath: "" }, {
        settings,
        rpc: rpc({
          sync_publish_check: () => ({
            hits: [{ where: "~/.agents/skills/venneker-website-doku/SKILL.md", term: "venneker" }],
            terms: ["venneker"],
          }),
          sync_push: () => ({ pushed: true, head: "abc", capturedAt: "x", changedFiles: [], warnings: [] }),
        }),
      }),
    );

    fireEvent.click(await slot.findByRole("button", { name: /Publish 1 change/ }));
    expect(await slot.findByText(/Not published: 1 place contains/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "sync_push")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Publish anyway" }));
    fireEvent.click(await slot.findByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "sync_push")?.input).toEqual({
        fresh: true,
        allowFlagged: true,
      }),
    );
  });
});
