import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  ApplyResult,
  CachedSyncCheck,
  CaptureResult,
  PlanChange,
  PushResult,
  SyncPlan,
  SyncStatus,
} from "./lib/preset";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

type PendingAction = "pull" | "push" | "fresh-push" | null;

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function readableDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === "unknown") return "legacy snapshot";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function StatusBadge({
  status,
  configured,
}: {
  status: SyncStatus | null;
  configured: boolean;
}) {
  if (!configured) {
    return <span className="text-xs text-muted-foreground">Setup required</span>;
  }
  if (status === null) {
    return <span className="text-xs text-muted-foreground">Not checked</span>;
  }
  const clean = status.changeCount === 0;
  const pushClean = status.pushChangeCount === 0;
  const labels = [
    status.changeCount > 0 ? `↓${status.changeCount}` : null,
    status.pushChangeCount > 0 ? `↑${status.pushChangeCount}` : null,
  ].filter((label): label is string => label !== null);
  return (
    <span
      className={
        clean && pushClean
          ? "rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
          : "rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
      }
    >
      {clean && pushClean ? "In sync" : labels.join(" ")}
    </span>
  );
}

function ChangeList({
  changes,
  empty,
}: {
  changes: PlanChange[];
  empty: string;
}) {
  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {changes.map((change, index) => (
        <li key={`${change.kind}-${change.target}-${index}`} className="flex gap-2">
          <span
            className={
              change.risk === "full-trust"
                ? "text-destructive"
                : "text-muted-foreground"
            }
          >
            {change.risk === "full-trust" ? "!" : "•"}
          </span>
          <span>{change.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function ResultNotice({ children }: { children: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
      {children}
    </div>
  );
}

function PresetSyncSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginSettings = useSettings();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const repository =
    typeof pluginSettings.values?.repositoryUrl === "string"
      ? pluginSettings.values.repositoryUrl.trim()
      : "";
  const configured = repository !== "";
  const branch =
    typeof pluginSettings.values?.branch === "string"
      ? pluginSettings.values.branch
      : "main";

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!configured) {
      setStatus(null);
      setPlan(null);
      setError(null);
      return;
    }
    setBusy("status");
    try {
      const next = await rpc.call("sync_status");
      setStatus(next);
      setError(null);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  }, [configured, reportError, rpc]);

  const loadCachedStatus = useCallback(async () => {
    if (!configured) return;
    try {
      const check: CachedSyncCheck | null = await rpc.call("sync_cached_check");
      if (check !== null) {
        if (check.status !== null && check.status.repository === repository) {
          setStatus(check.status);
        }
        setError(check.error);
      }
    } catch (cause) {
      reportError(cause);
    }
  }, [configured, reportError, repository, rpc]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, repository, branch]);
  useRealtime("preset-sync-changed", () => {
    void refreshStatus();
  });
  useRealtime("preset-sync-state", () => {
    void loadCachedStatus();
  });

  const preview = async (): Promise<SyncPlan | null> => {
    setBusy("preview");
    try {
      const next = await rpc.call("sync_preview");
      setPlan(next);
      setError(null);
      setNotice(
        next.changes.length === 0
          ? "This machine already matches the Git preset."
          : `Previewed ${next.changes.length} changes; nothing has been applied.`,
      );
      return next;
    } catch (cause) {
      reportError(cause);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const capture = async () => {
    setBusy("capture");
    try {
      const result: CaptureResult = await rpc.call("sync_capture");
      setNotice(
        `Staged ${result.pluginCount} plugins and ${result.pluginSettingCount} non-secret plugin settings.` +
          (result.vendoredCount > 0
            ? ` Vendored ${result.vendoredCount} collections (${result.vendoredFileCount} files).`
            : ""),
      );
      setError(null);
      await refreshStatus();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const openPullConfirmation = async () => {
    const nextPlan = plan ?? (await preview());
    if (nextPlan !== null && nextPlan.changes.length > 0) setPendingAction("pull");
  };

  const confirmAction = async () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === null) return;
    setBusy(action);
    try {
      if (action === "pull") {
        const result: ApplyResult = await rpc.call("sync_pull", { confirmed: true });
        setNotice(
          result.ok
            ? `Applied ${result.applied.length} changes from GitHub.`
            : `Applied ${result.applied.length} changes with ${result.errors.length} errors.`,
        );
        setError(result.errors.length === 0 ? null : result.errors.join(" · "));
        setPlan(null);
      } else {
        const result: PushResult = await rpc.call("sync_push", {
          fresh: action === "fresh-push",
        });
        setNotice(
          result.pushed
            ? `Pushed ${result.changedFiles.length} files at ${shortSha(result.head)}.`
            : `Git preset is already current at ${shortSha(result.head)}.`,
        );
        setError(null);
      }
      await refreshStatus();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const confirmationTitle =
    pendingAction === "pull"
      ? "Apply preset to this BB installation?"
      : pendingAction === "push"
        ? "Push the staged preset to GitHub?"
        : "Capture this machine and push to GitHub?";
  const confirmationDescription =
    pendingAction === "pull"
      ? "This can install full-trust plugins and update BB settings. Local plugins absent from the preset will remain installed."
      : "The managed preset JSON files in the configured branch will be committed and pushed. Other repository files are preserved.";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon name="Github" className="size-4" />
                Git preset
              </CardTitle>
              <CardDescription className="mt-1 break-all">
                {configured ? `${repository} · ${branch}` : "Repository not configured"}
              </CardDescription>
            </div>
            <StatusBadge status={status} configured={configured} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Remote commit</div>
              <div className="font-mono">{status ? shortSha(status.remoteHead) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Remote capture</div>
              <div>{readableDate(status?.remoteCapturedAt)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Local stage</div>
              <div>{readableDate(status?.stagedAt)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Last checked</div>
              <div>{readableDate(status?.checkedAt)}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled || !configured} onClick={refreshStatus}>
              <Icon name={busy === "status" ? "Spinner" : "ArrowReloadHorizontal"} />
              Check
            </Button>
          </div>
        </CardContent>
      </Card>

      {status !== null &&
      (status.pullChanges.length > 0 || status.pushChanges.length > 0) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Available sync</CardTitle>
            <CardDescription>
              Choose the direction after reviewing exactly what will change.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <section className="space-y-3 rounded-md border border-border p-3">
              <div>
                <div className="flex items-center justify-between gap-2 font-medium">
                  <span>Pull to this BB</span>
                  <span className="text-xs text-muted-foreground">
                    ↓ {status.pullChanges.length}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Remote → this machine</p>
              </div>
              <ChangeList
                changes={status.pullChanges}
                empty="No remote changes to apply."
              />
              <Button
                size="sm"
                disabled={disabled || status.pullChanges.length === 0}
                onClick={() => void openPullConfirmation()}
              >
                <Icon name="ArrowDown" />
                Pull remote
              </Button>
            </section>
            <section className="space-y-3 rounded-md border border-border p-3">
              <div>
                <div className="flex items-center justify-between gap-2 font-medium">
                  <span>Push this BB</span>
                  <span className="text-xs text-muted-foreground">
                    ↑ {status.pushChanges.length}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">This machine → remote</p>
              </div>
              <ChangeList
                changes={status.pushChanges}
                empty="No local changes to publish."
              />
              <Button
                size="sm"
                disabled={disabled || status.pushChanges.length === 0}
                onClick={() => setPendingAction("fresh-push")}
              >
                <Icon name="ArrowUp" />
                Push local
              </Button>
            </section>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Publish this machine</CardTitle>
          <CardDescription>
            Capture only portable configuration. Credentials, provider sessions, history, and
            secret plugin settings are excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void capture()}>
            <Icon name="FolderExport" />
            Stage current
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !configured || status?.stagedAt == null}
            onClick={() => setPendingAction("push")}
          >
            <Icon name="ArrowUp" />
            Push staged
          </Button>
          <Button size="sm" disabled={disabled || !configured} onClick={() => setPendingAction("fresh-push")}>
            <Icon name="Cloud" />
            Capture & push
          </Button>
        </CardContent>
      </Card>

      {!configured ? (
        <ResultNotice>
          Set Preset repository in Settings → Plugins → Preset Sync, then return here to sync.
        </ResultNotice>
      ) : null}
      {notice === null ? null : <ResultNotice>{notice}</ResultNotice>}
      {error === null ? null : (
        <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {plan === null ? null : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pull preview</CardTitle>
            <CardDescription>
              {plan.changes.length} pending changes from {shortSha(plan.remoteHead)}. No changes
              have been applied.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything is already in sync.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {plan.changes.map((change, index) => (
                  <li key={`${change.kind}-${change.target}-${index}`} className="flex gap-2">
                    <span className={change.risk === "full-trust" ? "text-destructive" : "text-muted-foreground"}>
                      {change.risk === "full-trust" ? "!" : "+"}
                    </span>
                    <span>{change.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan.warnings.length === 0 ? null : (
              <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                {plan.warnings.map((warning) => (
                  <div key={warning}>• {warning}</div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={pendingAction !== null} onOpenChange={(open) => !open && setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmationTitle}</DialogTitle>
            <DialogDescription>{confirmationDescription}</DialogDescription>
          </DialogHeader>
          {pendingAction === "pull" && plan !== null ? (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border p-3 text-sm">
              {plan.changes.map((change, index) => (
                <div key={`${change.kind}-${change.target}-${index}`} className="py-1">
                  {change.risk === "full-trust" ? "! " : "+ "}
                  {change.summary}
                </div>
              ))}
            </div>
          ) : null}
          {pendingAction === "fresh-push" && status !== null ? (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border p-3">
              <ChangeList
                changes={status.pushChanges}
                empty="No local changes to publish."
              />
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void confirmAction()}>
              {pendingAction === "pull" ? "Apply changes" : "Commit & push"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PresetSyncPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
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
  useRealtime("preset-sync-state", () => {
    void load();
  });

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
  if (
    status === null ||
    status.repository !== repository ||
    (status.changeCount === 0 && status.pushChangeCount === 0)
  ) {
    return null;
  }
  const label = [
    status.changeCount > 0 ? `↓${status.changeCount}` : null,
    status.pushChangeCount > 0 ? `↑${status.pushChangeCount}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const details = [
    ...status.pullChanges.map((change) => `↓ ${change.summary}`),
    ...status.pushChanges.map((change) => `↑ ${change.summary}`),
  ].join("\n");
  return (
    <span
      className="inline-flex max-w-16 items-center whitespace-nowrap text-[11px] font-semibold text-foreground"
      title={details}
      aria-label={`${status.changeCount} remote and ${status.pushChangeCount} local preset changes`}
    >
      {label}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "preset-sync",
    title: "Preset Sync",
    description: "Synchronize portable BB configuration through a Git repository.",
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
