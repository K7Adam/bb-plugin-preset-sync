import { useState } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { PlanConflict, SkillRule } from "../../lib/preset";
import type { ConflictDetail } from "../../lib/skill-groups";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export type ConflictChoice = "keep-local" | "take-remote";

const EVIDENCE_LABEL = {
  version: "by version",
  source: "by install source",
  date: "by date only",
  none: "no evidence",
} as const;

const RULE_LABEL: Record<SkillRule, string> = {
  "keep-local": "always keep mine",
  "take-remote": "always use the preset",
  newer: "always take the newer one",
};

function NewerBadge({ conflict, machine }: { conflict: PlanConflict; machine: string }) {
  const skill = conflict.skill!;
  const text =
    skill.newer === "remote"
      ? `${machine} is newer`
      : skill.newer === "local"
        ? "Yours is newer"
        : skill.newer === "same"
          ? "Same release, edited here"
          : "Unclear which is newer";
  const tone =
    skill.newer === "remote"
      ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
      : skill.newer === "local"
        ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {text}
      <span className="font-normal opacity-80"> · {EVIDENCE_LABEL[skill.evidence]}</span>
    </span>
  );
}

export function SkillConflictCard({
  conflict,
  machine: machineName,
  choice,
  onChoose,
  loadDetail,
  onRule,
}: {
  conflict: PlanConflict;
  machine: string;
  choice: ConflictChoice | undefined;
  onChoose: (next: ConflictChoice) => void;
  loadDetail: (conflictId: string) => Promise<ConflictDetail>;
  onRule: (rule: SkillRule | null) => Promise<void>;
}) {
  const skill = conflict.skill!;
  // Without a published machine name the other side is simply "Preset".
  const named = machineName !== "the preset";
  const machine = named ? machineName : "Preset";
  const useLabel = named ? `Use ${machineName}'s` : "Use preset";
  const [detail, setDetail] = useState<ConflictDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rule, setRule] = useState<SkillRule | "">(skill.rule ?? "");
  const recommended: ConflictChoice | undefined =
    skill.hint ? undefined : skill.newer === "remote" ? "take-remote" : skill.newer === "local" || skill.newer === "same" ? "keep-local" : undefined;

  const toggleDetail = async () => {
    if (detail !== null) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      setDetail(await loadDetail(conflict.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-medium">{skill.skill}</div>
          <div className="text-xs text-muted-foreground">{conflict.target} · {skill.paths.length === 1 ? "1 file" : `${skill.paths.length} files`}</div>
        </div>
        <NewerBadge conflict={conflict} machine={machine} />
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className={`rounded-md border p-2 ${choice === "keep-local" ? "border-foreground" : "border-border"}`}>
          <div className="font-medium">This machine</div>
          <div className="text-muted-foreground">Version {skill.localVersion ?? "not set"}</div>
        </div>
        <div className={`rounded-md border p-2 ${choice === "take-remote" ? "border-foreground" : "border-border"}`}>
          <div className="font-medium">{machine}</div>
          <div className="text-muted-foreground">Version {skill.remoteVersion ?? "not set"}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {skill.reason}
        {skill.hint ? " This is only a hint, please look at the difference." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Decide ${skill.skill}`}>
        <Button size="sm" variant={choice === "keep-local" ? "default" : "outline"} aria-pressed={choice === "keep-local"} onClick={() => onChoose("keep-local")}>
          Keep mine{recommended === "keep-local" ? " (recommended)" : ""}
        </Button>
        <Button size="sm" variant={choice === "take-remote" ? "default" : "outline"} aria-pressed={choice === "take-remote"} onClick={() => onChoose("take-remote")}>
          {useLabel}{recommended === "take-remote" ? " (recommended)" : ""}
        </Button>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void toggleDetail()}>
          <Icon name={loading ? "Spinner" : "FileDiff"} />
          {detail === null ? "Show differences" : "Hide differences"}
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          Next time
          <select
            aria-label={`Rule for ${skill.skill}`}
            className="h-7 rounded-md border border-input bg-transparent px-1 text-xs"
            value={rule}
            onChange={(event) => {
              const next = event.target.value as SkillRule | "";
              setRule(next);
              void onRule(next === "" ? null : next);
            }}
          >
            <option value="">ask me</option>
            {(Object.keys(RULE_LABEL) as SkillRule[]).map((value) => (
              <option key={value} value={value}>{RULE_LABEL[value]}</option>
            ))}
          </select>
        </label>
      </div>
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
      {detail === null ? null : (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">Lines with − are only in your copy, lines with + only in {named ? `${machineName}'s` : "the preset's"}.</p>
          {detail.files.map((file) => (
            <div key={file.path} className="overflow-hidden rounded-md border border-border">
              <div className="border-b border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
                {file.path}
                {file.change === "new-in-preset" ? " · only in the preset" : ""}
              </div>
              {file.binary ? (
                <p className="p-2 text-xs text-muted-foreground">Binary or very large file, no text difference shown.</p>
              ) : file.lineEndingsOnly ? (
                <p className="p-2 text-xs text-muted-foreground">Only the line endings differ.</p>
              ) : (
                <Diff patch={file.patch} path={file.path} view="unified" overflow="wrap" />
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
