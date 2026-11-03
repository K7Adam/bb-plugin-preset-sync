import { useState } from "react";
import type { FolderOverview, SkillGroup, SkillRow, SkillsOverview } from "../../lib/skill-groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { matchesSkillPattern } from "./skill-patterns";

type Status = SkillRow["status"];

export const STATUS_LOOK: Record<Status, { label: string; className: string; bar: string }> = {
  same: { label: "in sync", className: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/40" },
  new: { label: "new from preset", className: "bg-sky-500/15 text-sky-600 dark:text-sky-300", bar: "bg-sky-500" },
  update: { label: "update", className: "bg-sky-500/15 text-sky-600 dark:text-sky-300", bar: "bg-sky-400" },
  conflict: { label: "changed on both", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300", bar: "bg-amber-500" },
  "only-here": { label: "only here", className: "bg-violet-500/15 text-violet-700 dark:text-violet-300", bar: "bg-violet-500" },
  linked: { label: "linked", className: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/20" },
  skipped: { label: "skipped here", className: "bg-muted text-muted-foreground line-through", bar: "bg-muted-foreground/15" },
};

const FILTERS: { id: "all" | Status; label: string }[] = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "conflict", label: "Changed on both" },
  { id: "only-here", label: "Only here" },
  { id: "skipped", label: "Skipped" },
];

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {note === undefined ? null : <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

function StatusBar({ folder }: { folder: FolderOverview }) {
  const counts = new Map<Status, number>();
  for (const row of folder.skills) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const total = folder.skills.length || 1;
  return (
    <div className="space-y-1">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Skills by status">
        {[...counts].map(([status, count]) => (
          <div key={status} className={STATUS_LOOK[status].bar} style={{ width: `${(count / total) * 100}%` }} title={`${STATUS_LOOK[status].label}: ${count}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {[...counts].map(([status, count]) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span className={`inline-block size-2 rounded-full ${STATUS_LOOK[status].bar}`} />
            {STATUS_LOOK[status].label} {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function newGroupId(name: string, taken: readonly SkillGroup[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "group";
  let id = base;
  for (let n = 2; taken.some((group) => group.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

function GroupEditor({
  groups,
  presetSkills,
  busy,
  onSave,
}: {
  groups: SkillGroup[];
  presetSkills: string[];
  busy: boolean;
  onSave: (next: SkillGroup[]) => void;
}) {
  const [name, setName] = useState("");
  const [patterns, setPatterns] = useState("");
  const parsed = patterns.split(/[,\n]+/).map((entry) => entry.trim()).filter(Boolean);
  const preview = presetSkills.filter((skill) => parsed.some((pattern) => matchesSkillPattern(skill, pattern)));
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Skill groups on this machine</div>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No groups yet. A skipped group is neither pulled here nor published from here; other machines keep it.</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => {
            const matched = presetSkills.filter((skill) => group.patterns.some((pattern) => matchesSkillPattern(skill, pattern)));
            return (
              <li key={group.id} className="rounded-md border border-border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{group.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{matched.length} {matched.length === 1 ? "skill" : "skills"} in the preset</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={group.skip ? "default" : "outline"} aria-pressed={group.skip} disabled={busy}
                      onClick={() => onSave(groups.map((entry) => (entry.id === group.id ? { ...entry, skip: !entry.skip } : entry)))}>
                      {group.skip ? "Skipped here" : "Synced here"}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove group ${group.name}`} disabled={busy}
                      onClick={() => onSave(groups.filter((entry) => entry.id !== group.id))}>
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {group.patterns.slice(0, 12).map((pattern) => (
                    <code key={pattern} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{pattern}</code>
                  ))}
                  {group.patterns.length > 12 ? <span className="text-[11px] text-muted-foreground">+{group.patterns.length - 12} more</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
        <input aria-label="New group name" className="h-8 rounded-md border border-input bg-transparent px-2 text-sm" placeholder="Name, e.g. Android" value={name} onChange={(event) => setName(event.target.value)} />
        <div>
          <input aria-label="New group patterns" className="h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs" placeholder="android-*, compose-*" value={patterns} onChange={(event) => setPatterns(event.target.value)} />
          {parsed.length > 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Matches {preview.length}: {preview.slice(0, 8).join(", ")}{preview.length > 8 ? " …" : ""}</p>
          ) : null}
        </div>
        <Button size="sm" variant="outline" disabled={busy || name.trim() === "" || parsed.length === 0}
          onClick={() => {
            onSave([...groups, { id: newGroupId(name, groups), name: name.trim(), patterns: parsed, skip: true }]);
            setName("");
            setPatterns("");
          }}>
          <Icon name="Plus" />
          Add and skip
        </Button>
      </div>
    </div>
  );
}

function FolderSkills({ folder }: { folder: FolderOverview }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const rows = folder.skills.filter((row) => filter === "all" || row.status === filter);
  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-sm">{folder.target}</h3>
        <span className="text-xs text-muted-foreground">~{folder.tokensHere.toLocaleString()} → ~{folder.tokensAfterPull.toLocaleString()} startup tokens</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Here now" value={String(folder.counts.here)} />
        <Metric label="After pull" value={String(folder.counts.afterPull)} />
        <Metric label="In the preset" value={String(folder.counts.inPreset)} />
        <Metric label="Not pulled here" value={String(folder.counts.skipped)} note="skipped, stay in the preset" />
      </div>
      <StatusBar folder={folder} />
      <div className="flex flex-wrap gap-1" role="group" aria-label={`Filter skills of ${folder.target}`}>
        {FILTERS.map((entry) => (
          <Button key={entry.id} size="sm" variant={filter === entry.id ? "default" : "ghost"} aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
            {entry.label}
          </Button>
        ))}
      </div>
      <ul className="max-h-72 divide-y divide-border overflow-y-auto text-sm">
        {rows.map((row) => (
          <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs">{row.name}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {row.group === undefined ? null : <span className="text-muted-foreground">{row.group}</span>}
              {row.localVersion !== undefined || row.remoteVersion !== undefined ? (
                <span className="text-muted-foreground">
                  {!row.here || row.localVersion === undefined
                    ? row.remoteVersion
                    : row.remoteVersion !== undefined && row.remoteVersion !== row.localVersion
                      ? `${row.localVersion} here · ${row.remoteVersion} in the preset`
                      : row.localVersion}
                </span>
              ) : null}
              <span className={`rounded px-1.5 py-0.5 ${STATUS_LOOK[row.status].className}`}>{STATUS_LOOK[row.status].label}</span>
            </span>
          </li>
        ))}
        {rows.length === 0 ? <li className="py-2 text-xs text-muted-foreground">Nothing in this view.</li> : null}
      </ul>
    </section>
  );
}

export function SkillsPanel({
  overview,
  busy,
  onLoad,
  onSaveGroups,
}: {
  overview: SkillsOverview | null;
  busy: boolean;
  onLoad: () => void;
  onSaveGroups: (groups: SkillGroup[]) => void;
}) {
  const presetSkills = [
    ...new Set((overview?.folders ?? []).flatMap((folder) => folder.skills.filter((row) => row.inPreset).map((row) => row.name))),
  ].sort();
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Skills</CardTitle>
            <CardDescription>
              Which skills this machine has, what the preset{overview?.remoteMachine === undefined ? "" : ` from ${overview.remoteMachine}`} would add, and which groups stay away from here.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={onLoad}>
            <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} />
            {overview === null ? "Show skills" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      {overview === null ? null : (
        <CardContent className="space-y-4">
          {overview.folders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No synced folders. Turn on Folders below and list your skill folders.</p>
          ) : (
            overview.folders.map((folder) => <FolderSkills key={folder.collectionId} folder={folder} />)
          )}
          <GroupEditor groups={overview.groups} presetSkills={presetSkills} busy={busy} onSave={onSaveGroups} />
        </CardContent>
      )}
    </Card>
  );
}
