// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import type { SyncStatus } from "../lib/preset";

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

  it("shows directional actions and the exact remote and local changes", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const status: SyncStatus = {
      checkedAt: "2026-09-04T08:00:00.000Z",
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "0123456789abcdef",
      remoteCapturedAt: "2026-09-04T07:00:00.000Z",
      localCapturedAt: "2026-09-04T08:00:00.000Z",
      stagedAt: null,
      changeCount: 1,
      pushChangeCount: 1,
      pullChanges: [
        {
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
      warnings: [],
      lastOperation: null,
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        settings: {
          repositoryUrl: status.repository,
          branch: "main",
          backgroundCheckInterval: "5 minutes",
        },
        rpc: {
          sync_status: () => status,
          sync_cached_check: () => ({
            checkedAt: status.checkedAt,
            status,
            error: null,
          }),
        },
      },
    );

    expect(await slot.findByText("Available sync")).toBeTruthy();
    expect(slot.getByText("Install remote-plugin from remote-plugin@y5k")).toBeTruthy();
    expect(slot.getByText("Record theme dark in the preset")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Pull remote/i })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Push local/i })).toBeTruthy();
    slot.lifecycle.unmount();

    const accessory = app.navPanels[0]?.experimental_sidebarAccessory;
    if (accessory === undefined) throw new Error("Sidebar accessory is missing");
    const indicator = renderSlot(
      { component: accessory },
      {},
      {
        settings: { repositoryUrl: status.repository },
        rpc: {
          sync_cached_check: () => ({
            checkedAt: status.checkedAt,
            status,
            error: null,
          }),
        },
      },
    );
    expect(await indicator.findByText("↓1 ↑1")).toBeTruthy();
    indicator.lifecycle.unmount();
  });

  it("renders no sidebar indicator while both sides match", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const accessory = app.navPanels[0]?.experimental_sidebarAccessory;
    if (accessory === undefined) throw new Error("Sidebar accessory is missing");
    const repository = "https://github.com/example/preset.git";
    const indicator = renderSlot(
      { component: accessory },
      {},
      {
        settings: { repositoryUrl: repository },
        rpc: {
          sync_cached_check: () => ({
            checkedAt: "2026-09-04T08:00:00.000Z",
            status: {
              checkedAt: "2026-09-04T08:00:00.000Z",
              repository,
              branch: "main",
              remoteHead: "0123456789abcdef",
              remoteCapturedAt: "2026-09-04T07:00:00.000Z",
              localCapturedAt: "2026-09-04T08:00:00.000Z",
              stagedAt: null,
              changeCount: 0,
              pushChangeCount: 0,
              pullChanges: [],
              pushChanges: [],
              warnings: [],
              lastOperation: null,
            },
            error: null,
          }),
        },
      },
    );

    await waitFor(() => expect(indicator.inspection.rpcCalls).toHaveLength(1));
    expect(indicator.container.textContent).toBe("");
    indicator.lifecycle.unmount();
  });
});
