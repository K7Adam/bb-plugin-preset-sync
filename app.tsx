import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ApplyResult, CachedSyncCheck, RestoreResult, SyncPlan, SyncStatus } from "./lib/preset";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Notice,
  PublishPanel,
  PullResult,
  RestoreSummary,
  ReviewPanel,
  ScopePanel,
  SetupGuide,
  StatusSummary,
  type ConflictChoice,
} from "./components/preset-sync/panels";
import { plural } from "./components/preset-sync/scope-model";

type Pending =
  | { kind: "pull"; selection: string[]; resolutions: Record<string, ConflictChoice> }
  | { kind: "publish" }
  | { kind: "undo" }
  | null;

const STALE_PLAN = "changed since the preview";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function confirmationText(pending: Exclude<Pending, null>, plan: SyncPlan | null) {
  if (pending.kind === "publish") {
    return {
      title: "Publish this machine to the preset?",
      description:
        "The preset files in the configured branch are committed and pushed. Other machines see the changes on their next check.",
      action: "Publish",
    };
  }
  if (pending.kind === "undo") {
    return {
      title: "Undo the last pull?",
      description:
        "Replaced files and settings go back to how they were. Anything you changed after the pull is left alone. Installed plugins stay installed.",
      action: "Undo pull",
    };
  }
  const fullAccess =
    plan?.changes.filter(
      (change) => change.risk === "full-trust" && pending.selection.includes(change.id ?? ""),
    ).length ?? 0;
  const decisions = Object.keys(pending.resolutions).length;
  return {
    title: `Apply ${plural(pending.selection.length, "change", "changes")}${decisions > 0 ? ` and ${plural(decisions, "decision", "decisions")}` : ""}?`,
    description: [
      fullAccess > 0
        ? `${plural(fullAccess, "plugin gets", "plugins get")} installed with full access to this machine.`
        : null,
      "Everything replaced is backed up and the pull can be undone.",
    ]
      .filter(Boolean)
      .join(" "),
    action: "Apply",
  };
}

function PresetSyncSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginSettings = useSettings();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<ApplyResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const values = pluginSettings.values;
  const repository = typeof values?.repositoryUrl === "string" ? values.repositoryUrl.trim() : "";
  const configured = repository !== "";
  const branch = typeof values?.branch === "string" ? values.branch : "main";

  const refreshStatus = useCallback(async () => {
    if (!configured) {
      setStatus(null);
      setPlan(null);
      return;
    }
    setBusy("status");
    try {
      setStatus(await rpc.call("sync_status"));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, [configured, rpc]);

  const loadCachedStatus = useCallback(async () => {
    if (!configured) return;
    try {
      const check: CachedSyncCheck | null = await rpc.call("sync_cached_check");
      if (check !== null) {
        if (check.status !== null && check.status.repository === repository) setStatus(check.status);
        setError(check.error);
      }
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [configured, repository, rpc]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, repository, branch]);
  useRealtime("preset-sync-changed", () => void refreshStatus());
  useRealtime("preset-sync-state", () => void loadCachedStatus());

  const openReview = async () => {
    setBusy("preview");
    setPullResult(null);
    setRestoreResult(null);
    try {
      setPlan(await rpc.call("sync_preview"));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const updateScope = async (next: Record<string, string | boolean>) => {
    setBusy("scope");
    try {
      await rpc.call("sync_update_scope", { values: next });
      setPlan(null);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    const action = pending;
    setPending(null);
    if (action === null) return;
    setBusy(action.kind);
    try {
      if (action.kind === "pull") {
        const result = await rpc.call("sync_pull", {
          confirmed: true,
          fingerprint: plan?.fingerprint || undefined,
          selectedChangeIds: action.selection,
          resolutions: action.resolutions,
        });
        setPullResult(result);
        setPlan(null);
        setError(null);
      } else if (action.kind === "undo") {
        setRestoreResult(await rpc.call("sync_restore", { confirmed: true }));
        setPullResult(null);
        setError(null);
      } else {
        const result = await rpc.call("sync_push", { fresh: true });
        setNotice(
          result.pushed
            ? `Published ${plural(result.changedFiles.length, "file", "files")} to the preset.`
            : "The preset already matched this machine.",
        );
        setError(null);
      }
      await refreshStatus();
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      // The preset moved on: show the fresh plan instead of applying a stale one.
      if (action.kind === "pull" && message.includes(STALE_PLAN)) await openReview();
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const hasPullWork = (status?.changeCount ?? 0) > 0 || (status?.conflicts.length ?? 0) > 0;
  const dialog = pending === null ? null : confirmationText(pending, plan);

  return (
    <div className="space-y-4">
      {!configured ? <SetupGuide /> : (
        <>
          <StatusSummary repository={repository} branch={branch} status={status} busy={busy === "status"} onCheck={() => void refreshStatus()} />
          {plan === null ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={disabled} variant={hasPullWork ? "default" : "outline"} onClick={() => void openReview()}>
                Review updates
              </Button>
            </div>
          ) : (
            <ReviewPanel
              plan={plan}
              busy={disabled}
              onClose={() => setPlan(null)}
              onApply={(selection, resolutions) => setPending({ kind: "pull", selection, resolutions })}
            />
          )}
        </>
      )}
      {notice === null ? null : <Notice>{notice}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {pullResult === null ? null : (
        <PullResult result={pullResult} busy={disabled} onUndo={() => setPending({ kind: "undo" })} />
      )}
      {restoreResult === null ? null : <RestoreSummary result={restoreResult} />}
      <ScopePanel values={values} disabled={disabled} onUpdate={updateScope} />
      {configured ? (
        <PublishPanel status={status} busy={disabled} onPublish={() => setPending({ kind: "publish" })} />
      ) : null}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.title}</DialogTitle>
            <DialogDescription>{dialog?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void confirm()}>{dialog?.action}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PresetSyncPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        <PresetSyncSettings />
      </div>
    </div>
  );
}

function PresetSyncSidebarAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginSettings = useSettings();
  const [check, setCheck] = useState<CachedSyncCheck | null>(null);
  const repository =
    typeof pluginSettings.values?.repositoryUrl === "string"
      ? pluginSettings.values.repositoryUrl.trim()
      : "";

  const load = useCallback(async () => {
    try {
      setCheck(await rpc.call("sync_cached_check"));
    } catch {
      // The narrow sidebar indicator stays quiet when cached state is unavailable.
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("preset-sync-state", () => void load());

  if (repository === "" || check === null) return null;
  if (check.error !== null) {
    return (
      <span
        className="text-xs font-semibold text-destructive"
        title={`Preset Sync check failed: ${check.error}`}
        aria-label="Preset Sync background check failed"
      >
        !
      </span>
    );
  }
  const status = check.status;
  const conflicts = status?.conflicts.length ?? 0;
  if (
    status === null ||
    status.repository !== repository ||
    (status.changeCount === 0 && status.pushChangeCount === 0 && conflicts === 0)
  ) {
    return null;
  }
  const label = [
    status.changeCount > 0 ? `↓${status.changeCount}` : null,
    status.pushChangeCount > 0 ? `↑${status.pushChangeCount}` : null,
    conflicts > 0 ? `≠${conflicts}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const details = [
    ...status.pullChanges.map((change) => `↓ ${change.summary}`),
    ...status.pushChanges.map((change) => `↑ ${change.summary}`),
    ...status.conflicts.map((conflict) => `≠ ${conflict.target}`),
  ].join("\n");
  return (
    <span
      className="inline-flex max-w-20 items-center whitespace-nowrap text-[11px] font-semibold text-foreground"
      title={details}
      aria-label={`${status.changeCount} remote and ${status.pushChangeCount} local preset changes, ${conflicts} conflicts`}
    >
      {label}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "preset-sync",
    title: "Preset Sync",
    description: "Keep plugins, preferences and chosen folders the same on all your computers.",
    component: PresetSyncSettings,
  });
  app.slots.navPanel({
    id: "preset-sync",
    title: "Preset Sync",
    icon: "Cloud",
    path: "preset-sync",
    component: PresetSyncPage,
    experimental_sidebarAccessory: PresetSyncSidebarAccessory,
  });
});
