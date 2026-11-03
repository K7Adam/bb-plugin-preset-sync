import { useState } from "react";
import type { ApplyResult, PlanChange, PlanConflict, RestoreResult, SyncPlan, SyncStatus } from "../../lib/preset";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import {
  CONFLICT_AREA_LABEL,
  SCOPE_ROWS,
  changeId,
  groupChanges,
  plural,
  readableDate,
  shortSha,
  summarizeWarnings,
  type ScopeRow,
  type ScopeToggleKey,
} from "./scope-model";

export type ConflictChoice = "keep-local" | "take-remote";
type SettingValues = Record<string, string | boolean> | undefined;

export function Notice({ tone = "neutral", children }: { tone?: "neutral" | "error"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
          : "rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
      }
    >
      {children}
    </div>
  );
}

function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-foreground" : "bg-muted ring-1 ring-inset ring-muted-foreground/40"
      }`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function SetupGuide() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Set up Preset Sync</CardTitle>
        <CardDescription>
          Keep plugins, preferences and chosen folders the same on all your computers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>Create an empty private Git repository, for example on GitHub.</li>
          <li>Enter its URL as Preset repository in Settings → Plugins → Preset Sync.</li>
          <li>On your main computer choose Publish this machine.</li>
          <li>On every other computer review the updates and apply them.</li>
        </ol>
      </CardContent>
    </Card>
  );
}

export function StatusSummary({
  repository,
  branch,
  status,
  busy,
  onCheck,
}: {
  repository: string;
  branch: string;
  status: SyncStatus | null;
  busy: boolean;
  onCheck: () => void;
}) {
  const pull = status?.changeCount ?? 0;
  const push = status?.pushChangeCount ?? 0;
  const conflicts = status?.conflicts.length ?? 0;
  const parts = [
    pull > 0 ? plural(pull, "update from the preset", "updates from the preset") : null,
    conflicts > 0 ? `${plural(conflicts, "conflict", "conflicts")} to decide` : null,
    push > 0 ? `${plural(push, "change", "changes")} on this machine not published yet` : null,
  ].filter((part): part is string => part !== null);
  const headline =
    status === null ? "Not checked yet" : parts.length === 0 ? "Everything is in sync" : parts.join(" · ");
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{headline}</CardTitle>
            <CardDescription className="mt-1 break-all">
              {repository} · {branch}
              {status === null ? "" : ` · preset ${shortSha(status.remoteHead)}, checked ${readableDate(status.checkedAt)}`}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={onCheck}>
            <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} />
            Check now
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}

export function ScopePanel({
  values,
  disabled,
  onUpdate,
}: {
  values: SettingValues;
  disabled: boolean;
  onUpdate: (values: Record<string, string | boolean>) => Promise<void>;
}) {
  const current = (row: ScopeRow) =>
    typeof values?.[row.key] === "boolean" ? (values[row.key] as boolean) : row.defaultOn;
  const folders = typeof values?.vendoredPaths === "string" ? values.vendoredPaths : "";
  const conflictMode = values?.vendorConflictMode === "skip" || values?.vendorConflictMode === undefined ? "skip" : "backup";
  const [draft, setDraft] = useState<string | null>(null);
  const foldersOn = current(SCOPE_ROWS.find((row) => row.key === "syncVendoredFiles")!);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">What this machine syncs</CardTitle>
        <CardDescription>
          Switch a row off and this machine neither publishes nor receives it. Other machines keep their own choice.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {SCOPE_ROWS.map((row) => (
          <div key={row.key} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{row.title}</div>
                <p className="text-xs text-muted-foreground">{row.description}</p>
                {row.staysHere === undefined ? null : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <Icon name="Lock" className="mr-1 inline size-3" />
                    Always stays here: {row.staysHere}
                  </p>
                )}
              </div>
              <Switch
                checked={current(row)}
                label={`Sync ${row.title}`}
                disabled={disabled}
                onChange={(next) => void onUpdate({ [row.key satisfies ScopeToggleKey]: next })}
              />
            </div>
            {row.key === "syncVendoredFiles" && foldersOn ? (
              <div className="mt-3 space-y-3 rounded-md bg-muted/30 p-3">
                <label className="block text-xs font-medium" htmlFor="preset-sync-folders">
                  Folders, one per line, inside your home folder
                </label>
                <textarea
                  id="preset-sync-folders"
                  className="h-20 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                  placeholder="~/.agents/skills"
                  value={draft ?? folders}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || draft === null || draft === folders}
                    onClick={() =>
                      void onUpdate({ vendoredPaths: draft ?? folders }).then(() => setDraft(null))
                    }
                  >
                    Save folders
                  </Button>
                </div>
                <fieldset className="space-y-1 text-xs">
                  <legend className="font-medium">When a file changed here and in the preset</legend>
                  {(
                    [
                      ["skip", "Keep my version and let me decide (recommended)"],
                      ["backup", "Use the preset version; mine is backed up"],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="preset-sync-conflict-mode"
                        checked={conflictMode === value}
                        disabled={disabled}
                        onChange={() => void onUpdate({ vendorConflictMode: value })}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ChangeRow({
  change,
  checked,
  onToggle,
}: {
  change: PlanChange;
  checked: boolean;
  onToggle: () => void;
}) {
  const id = `change-${changeId(change)}`;
  return (
    <li className="flex items-start gap-2 py-1">
      <input id={id} type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} />
      <label htmlFor={id} className="min-w-0 text-sm">
        <span>{change.summary}</span>
        {change.risk === "full-trust" ? (
          <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
            full access
          </span>
        ) : null}
        {change.detail === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{change.detail}</span>
        )}
      </label>
    </li>
  );
}

function ConflictRow({
  conflict,
  choice,
  onChoose,
}: {
  conflict: PlanConflict;
  choice: ConflictChoice | undefined;
  onChoose: (next: ConflictChoice) => void;
}) {
  return (
    <li className="space-y-1.5 rounded-md border border-border p-2">
      <div className="text-sm">
        <span className="text-xs text-muted-foreground">{CONFLICT_AREA_LABEL[conflict.area]} · </span>
        <span className="break-all font-medium">{conflict.target}</span>
      </div>
      <p className="text-xs text-muted-foreground">{conflict.detail}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Decide ${conflict.target}`}>
        <Button size="sm" variant={choice === "keep-local" ? "default" : "outline"} aria-pressed={choice === "keep-local"} onClick={() => onChoose("keep-local")}>
          Keep mine
        </Button>
        <Button size="sm" variant={choice === "take-remote" ? "default" : "outline"} aria-pressed={choice === "take-remote"} onClick={() => onChoose("take-remote")}>
          Use preset
        </Button>
      </div>
    </li>
  );
}

export function ReviewPanel({
  plan,
  busy,
  onApply,
  onClose,
}: {
  plan: SyncPlan;
  busy: boolean;
  onApply: (selection: string[], resolutions: Record<string, ConflictChoice>) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(plan.changes.map(changeId)));
  const [resolutions, setResolutions] = useState<Record<string, ConflictChoice>>({});
  const [showNotes, setShowNotes] = useState(false);
  const groups = groupChanges(plan.changes);
  const notes = summarizeWarnings(plan.warnings);
  const decided = Object.keys(resolutions).length;
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Review updates from the preset</CardTitle>
        <CardDescription>
          Nothing has changed yet. Untick what you do not want. Replaced files and settings are backed up, and the pull can be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan.changes.length === 0 && plan.conflicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">There is nothing to apply.</p>
        ) : null}
        {groups.map(({ row, changes }) => (
          <section key={row.key}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{row.title}</h3>
            <ul>
              {changes.map((change) => (
                <ChangeRow key={changeId(change)} change={change} checked={selected.has(changeId(change))} onToggle={() => toggle(changeId(change))} />
              ))}
            </ul>
          </section>
        ))}
        {plan.conflicts.length === 0 ? null : (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Changed on both sides · {plural(plan.conflicts.length, "decision", "decisions")}
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Your version stays until you choose. Keep mine also tells Preset Sync not to ask again.
            </p>
            <ul className="space-y-2">
              {plan.conflicts.map((conflict) => (
                <ConflictRow
                  key={conflict.id}
                  conflict={conflict}
                  choice={resolutions[conflict.id]}
                  onChoose={(next) => setResolutions((previous) => ({ ...previous, [conflict.id]: next }))}
                />
              ))}
            </ul>
          </section>
        )}
        {notes.length === 0 ? null : (
          <div className="text-xs text-muted-foreground">
            <button type="button" className="underline underline-offset-2" onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? "Hide" : "Show"} {plural(notes.length, "note", "notes")}
            </button>
            {showNotes ? (
              <ul className="mt-1 space-y-0.5">
                {notes.map((note) => (
                  <li key={note}>• {note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" disabled={busy || (selected.size === 0 && decided === 0)} onClick={() => onApply([...selected], resolutions)}>
            <Icon name={busy ? "Spinner" : "ArrowDown"} />
            Apply {plural(selected.size, "change", "changes")}
            {decided > 0 ? ` and ${plural(decided, "decision", "decisions")}` : ""}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PublishPanel({
  status,
  busy,
  onPublish,
}: {
  status: SyncStatus | null;
  busy: boolean;
  onPublish: () => void;
}) {
  const changes = status?.pushChanges ?? [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Publish this machine</CardTitle>
        <CardDescription>
          Records this machine in the preset. Settings this machine does not sync keep the values other machines published.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing new to publish.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {changes.map((change, index) => (
              <li key={`${change.kind}-${change.target}-${index}`}>• {change.summary}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={busy || changes.length === 0} onClick={onPublish}>
            <Icon name="ArrowUp" />
            Publish {plural(changes.length, "change", "changes")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PullResult({
  result,
  busy,
  onUndo,
}: {
  result: ApplyResult;
  busy: boolean;
  onUndo: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Notice tone={result.ok ? "neutral" : "error"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {result.ok
            ? `Applied ${plural(result.applied.length, "change", "changes")}.`
            : `Applied ${plural(result.applied.length, "change", "changes")}, ${plural(result.errors.length, "problem", "problems")}.`}
          {result.skipped.length > 0 ? ` ${plural(result.skipped.length, "item was", "items were")} left as they are.` : ""}
        </span>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </Button>
          {result.backupRun === null ? null : (
            <Button variant="outline" size="sm" disabled={busy} onClick={onUndo}>
              <Icon name="RotateCcw" />
              Undo this pull
            </Button>
          )}
        </span>
      </div>
      {open ? (
        <ul className="mt-2 space-y-0.5 text-xs">
          {result.applied.map((entry) => <li key={`a-${entry}`}>+ {entry}</li>)}
          {result.skipped.map((entry) => <li key={`s-${entry}`}>– {entry}</li>)}
          {result.errors.map((entry) => <li key={`e-${entry}`} className="text-destructive">× {entry}</li>)}
        </ul>
      ) : null}
    </Notice>
  );
}

export function RestoreSummary({ result }: { result: RestoreResult }) {
  return (
    <Notice tone={result.errors.length === 0 ? "neutral" : "error"}>
      Undid the last pull: {plural(result.restored.length, "item", "items")} restored
      {result.skipped.length > 0 ? `, ${plural(result.skipped.length, "item", "items")} left as they are because they changed afterwards` : ""}.
      {result.skipped.concat(result.errors).length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs">
          {[...result.skipped, ...result.errors].map((entry) => <li key={entry}>• {entry}</li>)}
        </ul>
      ) : null}
    </Notice>
  );
}
