import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { clearFakeRemotes, registerFakeRemote } from "./support/fake-git";
import {
  FAKE_REMOTE_URL,
  createMachine,
  defaultGeneralSettings,
  onMachine,
  type FakeMachine,
} from "./support/fake-machine";

vi.mock("../lib/git", () => import("./support/fake-git"));

const cleanup: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, ...rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function text(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(root, ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
}

async function machine(args: Parameters<typeof createMachine>[1] = {}): Promise<FakeMachine> {
  const created = await createMachine(createFakePluginHost as never, args);
  cleanup.push(created.home);
  return created;
}

async function push(source: FakeMachine): Promise<void> {
  await onMachine(source, () => source.service.push({ fresh: true }));
}

beforeEach(async () => {
  registerFakeRemote(FAKE_REMOTE_URL, await tempDir("preset-remote-"));
});

afterEach(async () => {
  clearFakeRemotes();
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  );
});

describe("general settings ownership", () => {
  it("merges portable settings and keeps machine settings on pull", async () => {
    const a = await machine({
      state: {
        general: {
          ...defaultGeneralSettings(),
          showKeyboardHints: false,
          providerOrder: ["codex"],
          defaultProviderId: "codex",
          defaultMachineAccess: "connect",
        },
      },
    });
    await push(a);

    const b = await machine({
      state: {
        general: {
          ...defaultGeneralSettings(),
          providerOrder: ["claude-code"],
          defaultProviderId: "claude-code",
          machineServerUrl: "https://b.example.test",
        },
      },
    });
    const result = await onMachine(b, () => b.service.pullAndApply());

    expect(result.errors).toEqual([]);
    expect(b.state.general.showKeyboardHints).toBe(false);
    expect(b.state.general.providerOrder).toEqual(["claude-code"]);
    expect(b.state.general.defaultProviderId).toBe("claude-code");
    expect(b.state.general.machineServerUrl).toBe("https://b.example.test");
    expect(b.state.general.defaultMachineAccess).toBeNull();
  });

  it("lets a machine opt a default-local setting into sync", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), providerOrder: ["codex"] } },
      settings: { syncedSettingKeys: "providerOrder" },
    });
    await push(a);
    const b = await machine({ settings: { syncedSettingKeys: "providerOrder" } });

    await onMachine(b, () => b.service.pullAndApply());

    expect(b.state.general.providerOrder).toEqual(["codex"]);
  });

  it("never syncs fixed machine experiments", async () => {
    const a = await machine({
      state: { experiments: { threadRowMetadata: true, performanceDiagnostics: true } },
    });
    await push(a);
    const b = await machine();

    await onMachine(b, () => b.service.pullAndApply());

    expect(b.state.experiments).toEqual({
      threadRowMetadata: true,
      performanceDiagnostics: false,
    });
  });
});

describe("plugin settings ownership", () => {
  const crew = (home: string, refreshSeconds: number) => ({
    id: "crew",
    source: "git:https://example.test/crew.git",
    enabled: true,
    settings: {
      schema: {
        homeDirectory: { type: "string" },
        refreshSeconds: { type: "number" },
      },
      values: { homeDirectory: home, refreshSeconds },
    },
  });

  it("keeps path-like plugin settings on this machine", async () => {
    const a = await machine({
      state: { plugins: [{ id: "preset-sync", source: "path:/p", enabled: true }, crew("~/A", 5)] },
    });
    await push(a);
    const b = await machine({
      state: { plugins: [{ id: "preset-sync", source: "path:/p", enabled: true }, crew("~/B", 10)] },
    });

    await onMachine(b, () => b.service.pullAndApply());

    const values = b.state.plugins.find((plugin) => plugin.id === "crew")?.settings?.values;
    expect(values).toEqual({ homeDirectory: "~/B", refreshSeconds: 5 });
  });
});

describe("folder sync", () => {
  it("keeps a locally edited file, reports the conflict and adds new files", async () => {
    const a = await machine();
    await put(a.home, "skills/a.md", "remote");
    await put(a.home, "skills/b.md", "new");
    await push(a);

    const b = await machine();
    await put(b.home, "skills/a.md", "mine");
    const plan = await onMachine(b, () => b.service.preview());
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ area: "files", target: "~/skills/a.md" }),
    ]);

    await onMachine(b, () => b.service.pullAndApply());

    expect(await text(b.home, "skills/a.md")).toBe("mine");
    expect(await text(b.home, "skills/b.md")).toBe("new");
  });

  it("updates files that were not edited locally since the last sync", async () => {
    const a = await machine();
    await put(a.home, "skills/a.md", "v1");
    await push(a);
    const b = await machine();
    await onMachine(b, () => b.service.pullAndApply());

    await put(a.home, "skills/a.md", "v2");
    await push(a);
    const plan = await onMachine(b, () => b.service.preview());
    expect(plan.conflicts).toEqual([]);
    await onMachine(b, () => b.service.pullAndApply());

    expect(await text(b.home, "skills/a.md")).toBe("v2");
  });

  it("keeps the backup of every pull instead of overwriting the previous one", async () => {
    const a = await machine();
    await put(a.home, "skills/a.md", "v1");
    await push(a);
    const b = await machine({ settings: { vendorConflictMode: "backup" } });
    await put(b.home, "skills/a.md", "mine1");
    await onMachine(b, () => b.service.pullAndApply());

    await put(b.home, "skills/a.md", "mine2");
    await put(a.home, "skills/a.md", "v2");
    await push(a);
    await onMachine(b, () => b.service.pullAndApply());

    const backupRoot = join(b.home, ".bb", "preset-vendored", "backup");
    const runs = await readdir(backupRoot);
    const contents = await Promise.all(
      runs.map((run) => text(join(backupRoot, run), "skills/a.md")),
    );
    expect(contents.sort()).toEqual(["mine1", "mine2"]);
    expect(await text(b.home, "skills/a.md")).toBe("v2");
  });

  it("never writes through a symbolic link inside the target folder", async () => {
    const a = await machine();
    await put(a.home, "skills/linked/x.md", "remote");
    await push(a);

    const b = await machine();
    const outside = await tempDir("preset-outside-");
    await mkdir(join(b.home, "skills"), { recursive: true });
    await symlink(outside, join(b.home, "skills", "linked"), "junction");

    const result = await onMachine(b, () => b.service.pullAndApply());

    expect(existsSync(join(outside, "x.md"))).toBe(false);
    expect(result.skipped.join("\n")).toMatch(/symbolic link/);
  });

  it("applies this machine's exclude patterns on pull", async () => {
    const a = await machine();
    await put(a.home, "skills/private/p.md", "remote");
    await put(a.home, "skills/public.md", "remote");
    await push(a);
    const b = await machine({ settings: { vendorExcludeGlobs: "private/**" } });

    await onMachine(b, () => b.service.pullAndApply());

    expect(await text(b.home, "skills/private/p.md")).toBeNull();
    expect(await text(b.home, "skills/public.md")).toBe("remote");
  });

  it("leaves folders managed by the Claude app alone", async () => {
    const a = await machine({ settings: { vendoredPaths: "~/.claude/skills" } });
    await put(a.home, ".claude/skills/own/SKILL.md", "own");
    await put(a.home, ".claude/skills/synced/org/manifest.json", "{}");
    await push(a);
    const b = await machine({ settings: { vendoredPaths: "~/.claude/skills" } });

    await onMachine(b, () => b.service.pullAndApply());

    expect(await text(b.home, ".claude/skills/own/SKILL.md")).toBe("own");
    expect(await text(b.home, ".claude/skills/synced/org/manifest.json")).toBeNull();
  });
});

describe("pull safety", () => {
  it("refuses to apply when the preset changed after the preview", async () => {
    const a = await machine();
    await put(a.home, "skills/a.md", "v1");
    await push(a);
    const b = await machine();
    const plan = await onMachine(b, () => b.service.preview());

    await put(a.home, "skills/a.md", "v2");
    await push(a);

    await expect(
      onMachine(b, () => b.service.pullAndApply({ expectedFingerprint: plan.fingerprint })),
    ).rejects.toThrow(/changed since the preview/);
    expect(await text(b.home, "skills/a.md")).toBeNull();
  });

  it("applies only the changes the user selected", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), showKeyboardHints: false } },
    });
    await put(a.home, "skills/a.md", "remote");
    await push(a);
    const b = await machine();
    const plan = await onMachine(b, () => b.service.preview());
    const general = plan.changes.find((change) => change.id === "general:showKeyboardHints");
    expect(general).toBeDefined();

    await onMachine(b, () =>
      b.service.pullAndApply({
        expectedFingerprint: plan.fingerprint,
        selectedChangeIds: [general!.id!],
      }),
    );

    expect(b.state.general.showKeyboardHints).toBe(false);
    expect(await text(b.home, "skills/a.md")).toBeNull();
  });

  it("reaches a stable state: a second pull changes nothing", async () => {
    const a = await machine({
      state: {
        general: { ...defaultGeneralSettings(), showKeyboardHints: false },
        experiments: { threadRowMetadata: true, performanceDiagnostics: false },
      },
    });
    await put(a.home, "skills/a.md", "remote");
    await push(a);
    const b = await machine();
    await put(b.home, "skills/a.md", "mine");

    await onMachine(b, () => b.service.pullAndApply());
    const second = await onMachine(b, () => b.service.preview());

    expect(second.changes).toEqual([]);
    expect(second.conflicts).toEqual([
      expect.objectContaining({ area: "files", target: "~/skills/a.md" }),
    ]);
  });

  it("restores the files and settings the last pull changed", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), showKeyboardHints: false } },
    });
    await put(a.home, "skills/a.md", "v1");
    await push(a);
    const b = await machine();
    await onMachine(b, () => b.service.pullAndApply());
    await put(a.home, "skills/a.md", "v2");
    await put(a.home, "skills/new.md", "new");
    await push(a);
    await onMachine(b, () => b.service.pullAndApply());
    expect(await text(b.home, "skills/a.md")).toBe("v2");

    const restored = await onMachine(b, () => b.service.restore());

    expect(restored.errors).toEqual([]);
    expect(await text(b.home, "skills/a.md")).toBe("v1");
    expect(await text(b.home, "skills/new.md")).toBeNull();
  });
});

describe("conflict decisions", () => {
  async function conflicted() {
    const a = await machine();
    await put(a.home, "skills/a.md", "remote");
    await push(a);
    const b = await machine();
    await put(b.home, "skills/a.md", "mine");
    const plan = await onMachine(b, () => b.service.preview());
    return { a, b, conflictId: plan.conflicts[0]!.id };
  }

  it("uses the preset version when asked and keeps a restorable backup", async () => {
    const { b, conflictId } = await conflicted();

    const result = await onMachine(b, () =>
      b.service.pullAndApply({ resolutions: { [conflictId]: "take-remote" } }),
    );

    expect(await text(b.home, "skills/a.md")).toBe("remote");
    expect(result.backupRun).not.toBeNull();
    expect(
      await text(join(b.home, ".bb", "preset-vendored", "backup", result.backupRun!), "skills/a.md"),
    ).toBe("mine");
    const next = await onMachine(b, () => b.service.preview());
    expect(next.conflicts).toEqual([]);
  });

  it("stops asking once the user keeps their version", async () => {
    const { b, conflictId } = await conflicted();

    await onMachine(b, () => b.service.pullAndApply({ resolutions: { [conflictId]: "keep-local" } }));

    expect(await text(b.home, "skills/a.md")).toBe("mine");
    const next = await onMachine(b, () => b.service.preview());
    expect(next.conflicts).toEqual([]);
    expect(next.changes).toEqual([]);
  });

  it("reports a setting changed on both sides and keeps the local value", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), managedBranchPrefix: "a/" } },
    });
    await push(a);
    const b = await machine();
    await onMachine(b, () => b.service.pullAndApply());
    expect(b.state.general.managedBranchPrefix).toBe("a/");

    a.state.general.managedBranchPrefix = "a2/";
    await push(a);
    b.state.general.managedBranchPrefix = "b/";
    const plan = await onMachine(b, () => b.service.preview());
    await onMachine(b, () => b.service.pullAndApply());

    expect(plan.conflicts).toEqual([
      expect.objectContaining({ id: "conflict:general:managedBranchPrefix" }),
    ]);
    expect(b.state.general.managedBranchPrefix).toBe("b/");
  });
});

describe("publishing", () => {
  it("never publishes this machine's local settings over another machine's", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), providerOrder: ["codex"] } },
      settings: { syncedSettingKeys: "providerOrder" },
    });
    await push(a);
    const b = await machine({
      state: { general: { ...defaultGeneralSettings(), providerOrder: ["claude-code"] } },
    });
    await push(b);
    const c = await machine({ settings: { syncedSettingKeys: "providerOrder" } });

    await onMachine(c, () => c.service.pullAndApply());

    expect(c.state.general.providerOrder).toEqual(["codex"]);
  });

  it("does not publish folders the Claude app manages", async () => {
    const a = await machine({ settings: { vendoredPaths: "~/.claude/skills" } });
    await put(a.home, ".claude/skills/own/SKILL.md", "own");
    await put(a.home, ".claude/skills/synced/org/manifest.json", "{}");
    await push(a);
    const b = await machine({ settings: { vendoredPaths: "~/.claude/skills" } });

    const plan = await onMachine(b, () => b.service.preview());

    expect(plan.changes).toContainEqual(
      expect.objectContaining({ id: "files:claude-skills", summary: "Sync ~/.claude/skills: 1 new file" }),
    );
  });
});

describe("folder safety", () => {
  it("skips a target folder that is itself a symbolic link", async () => {
    const a = await machine();
    await put(a.home, "skills/a.md", "remote");
    await push(a);
    const b = await machine();
    const outside = await tempDir("preset-outside-");
    await symlink(outside, join(b.home, "skills"), "junction");

    const plan = await onMachine(b, () => b.service.preview());
    await onMachine(b, () => b.service.pullAndApply());

    expect(plan.warnings.join("\n")).toMatch(/~\/skills is a symbolic link/);
    expect(existsSync(join(outside, "a.md"))).toBe(false);
  });
});

describe("restore", () => {
  it("resets settings the pull changed and leaves later edits alone", async () => {
    const a = await machine({
      state: {
        general: { ...defaultGeneralSettings(), showKeyboardHints: false, managedBranchPrefix: "a/" },
      },
    });
    await push(a);
    const b = await machine();
    await onMachine(b, () => b.service.pullAndApply());
    b.state.general.managedBranchPrefix = "edited/";

    const restored = await onMachine(b, () => b.service.restore());

    expect(b.state.general.showKeyboardHints).toBe(true);
    expect(b.state.general.managedBranchPrefix).toBe("edited/");
    expect(restored.skipped.join("\n")).toMatch(/managedBranchPrefix changed after the pull/);
    const again = await onMachine(b, () => b.service.preview());
    expect(again.changes.map((change) => change.id)).toContain("general:showKeyboardHints");
  });

  it("refuses when there is nothing to restore", async () => {
    const b = await machine();
    await expect(onMachine(b, () => b.service.restore())).rejects.toThrow(/no pull to restore/);
  });
});

describe("rpc payloads", () => {
  it("returns plans and results that survive a JSON round-trip unchanged", async () => {
    const a = await machine({
      state: { general: { ...defaultGeneralSettings(), showKeyboardHints: false } },
    });
    await put(a.home, "skills/new.md", "remote");
    await push(a);
    const b = await machine();

    const plan = await onMachine(b, () => b.service.preview());
    const status = await onMachine(b, () => b.service.status());
    const result = await onMachine(b, () => b.service.pullAndApply());

    for (const value of [plan, status, result]) {
      expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
    }
  });
});

describe("publishing folders from several machines", () => {
  it("keeps files this machine skips when it publishes", async () => {
    const a = await machine();
    await put(a.home, "skills/linked/x.md", "from a");
    await put(a.home, "skills/private/p.md", "from a");
    await put(a.home, "skills/shared.md", "shared");
    await push(a);

    const b = await machine({ settings: { vendorExcludeGlobs: "private/**" } });
    const outside = await tempDir("preset-outside-");
    await mkdir(join(b.home, "skills"), { recursive: true });
    await symlink(outside, join(b.home, "skills", "linked"), "junction");
    await onMachine(b, () => b.service.pullAndApply());
    await put(b.home, "skills/own-b.md", "from b");
    await push(b);

    const plan = await onMachine(a, () => a.service.preview());
    const status = await onMachine(a, () => a.service.status());

    expect(plan.changes).toEqual([
      expect.objectContaining({ id: "files:skills", summary: "Sync ~/skills: 1 new file" }),
    ]);
    expect(status.pushChanges.filter((change) => change.kind === "vendored")).toEqual([]);
  });

  it("removes a file from the preset when this machine deleted it after a sync", async () => {
    const a = await machine();
    await put(a.home, "skills/old.md", "old");
    await put(a.home, "skills/keep.md", "keep");
    await push(a);
    const b = await machine();
    await onMachine(b, () => b.service.pullAndApply());

    await rm(join(b.home, "skills", "old.md"));
    await push(b);
    const c = await machine();
    await onMachine(c, () => c.service.pullAndApply());

    expect(await text(c.home, "skills/old.md")).toBeNull();
    expect(await text(c.home, "skills/keep.md")).toBe("keep");
  });

  it("never syncs the bb-cli skill that bb installs on every machine", async () => {
    const a = await machine();
    await put(a.home, "skills/bb-cli/SKILL.md", "bb 0.48");
    await put(a.home, "skills/own/SKILL.md", "own");
    a.setSettings({ vendoredPaths: "~/.agents/skills" });
    await put(a.home, ".agents/skills/bb-cli/SKILL.md", "bb 0.48");
    await put(a.home, ".agents/skills/own/SKILL.md", "own");
    await push(a);
    const b = await machine({ settings: { vendoredPaths: "~/.agents/skills" } });
    await put(b.home, ".agents/skills/bb-cli/SKILL.md", "bb 0.49");

    const plan = await onMachine(b, () => b.service.preview());

    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({ summary: "Sync ~/.agents/skills: 1 new file" }),
    );
  });
});

describe("publishing plugins from several machines", () => {
  const plugin = (id: string, source = `git:https://example.test/${id}.git`) => ({
    id,
    source,
    enabled: true,
  });
  const self = { id: "preset-sync", source: "path:/p", enabled: true };

  it("keeps plugins of other machines in the preset when this machine publishes", async () => {
    const a = await machine({ state: { plugins: [self, plugin("only-a")] } });
    await push(a);
    const b = await machine({ state: { plugins: [self, plugin("only-b")] } });
    await push(b);

    const c = await machine({ state: { plugins: [self] } });
    const plan = await onMachine(c, () => c.service.preview());
    const status = await onMachine(a, () => a.service.status());

    expect(plan.changes.map((change) => change.id).sort()).toEqual([
      "plugin-install:only-a",
      "plugin-install:only-b",
    ]);
    expect(status.pushChanges.filter((change) => change.action === "remove")).toEqual([]);
  });

  it("removes a plugin from the preset when this machine uninstalled it after a sync", async () => {
    const a = await machine({ state: { plugins: [self, plugin("shared")] } });
    await push(a);
    const b = await machine({ state: { plugins: [self] } });
    await onMachine(b, () => b.service.pullAndApply());
    b.state.plugins = b.state.plugins.filter((entry) => entry.id !== "shared");
    await push(b);

    const c = await machine({ state: { plugins: [self] } });
    const plan = await onMachine(c, () => c.service.preview());

    expect(plan.changes.filter((change) => change.kind === "plugin-install")).toEqual([]);
  });

  it("does not offer to install a plugin this machine runs from a local folder", async () => {
    const a = await machine({ state: { plugins: [self, plugin("tool")] } });
    await push(a);
    const b = await machine({ state: { plugins: [self, plugin("tool", "path:C:/dev/tool")] } });

    const plan = await onMachine(b, () => b.service.preview());

    expect(plan.changes.filter((change) => change.kind === "plugin-install")).toEqual([]);
  });
});
