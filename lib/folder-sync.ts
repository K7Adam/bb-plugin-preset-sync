import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { decideMerge } from "./merge";
import { backupLabel, type PullJournal } from "./journal";
import { skillOf } from "./skills";
import {
  isValidVendoredRelPath,
  matchesGlob,
  resolveWithin,
  sha256Hex,
  symlinkedParent,
  type VendoredCollection,
} from "./vendor";

/**
 * Pull-side planning and writing for a synced folder. Every file gets a
 * three-way decision against the hash recorded at the last sync, so a file
 * edited only here is never overwritten and a file changed only in the preset
 * updates without a question.
 */

export type FolderAction = "add" | "update" | "conflict" | "same" | "keep-local" | "skip";

export interface FolderDecision {
  path: string;
  sha256: string;
  size: number;
  action: FolderAction;
  reason?: string;
}

export interface FolderPlan {
  collection: VendoredCollection;
  target: string;
  targetDir: string;
  decisions: FolderDecision[];
  /** Folder-level problem that blocks every write (for example a linked target). */
  blocked?: string;
}

export interface FolderCounts {
  add: number;
  update: number;
  conflict: number;
  skip: number;
}

export function countFolder(plan: FolderPlan): FolderCounts {
  const counts: FolderCounts = { add: 0, update: 0, conflict: 0, skip: 0 };
  for (const decision of plan.decisions) {
    if (decision.action === "add") counts.add += 1;
    else if (decision.action === "update") counts.update += 1;
    else if (decision.action === "conflict") counts.conflict += 1;
    else if (decision.action === "skip") counts.skip += 1;
  }
  return counts;
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path));
  } catch {
    return null;
  }
}

export async function planFolder(args: {
  collection: VendoredCollection;
  target: string;
  targetDir: string;
  excludeGlobs: readonly string[];
  baseFiles: Record<string, string> | undefined;
}): Promise<FolderPlan> {
  const { collection, target, targetDir, excludeGlobs, baseFiles } = args;
  const plan: FolderPlan = { collection, target, targetDir, decisions: [] };
  // Check every folder from the home folder down to the target itself
  // (lstat, not realpath: Windows short names would look like links).
  const homeRelative = target.startsWith("~/") ? target.slice(2) : target;
  const linkedAncestor = await symlinkedParent(homedir(), `${homeRelative}/_`);
  if (linkedAncestor !== null) {
    plan.blocked = `~/${linkedAncestor} is a symbolic link`;
  }

  for (const entry of collection.entries) {
    const decide = (action: FolderAction, reason?: string) =>
      plan.decisions.push({ path: entry.path, sha256: entry.sha256, size: entry.size, action, reason });
    if (!isValidVendoredRelPath(entry.path)) {
      decide("skip", "invalid path in the preset");
      continue;
    }
    if (excludeGlobs.some((glob) => matchesGlob(entry.path, glob))) {
      decide("skip", "excluded on this machine");
      continue;
    }
    if (plan.blocked !== undefined) {
      decide("skip", plan.blocked);
      continue;
    }
    const linked = await symlinkedParent(targetDir, entry.path);
    if (linked !== null) {
      decide("skip", `folder ${linked} is a symbolic link`);
      continue;
    }
    const absolute = resolveWithin(targetDir, entry.path);
    const existing = await lstat(absolute).catch(() => null);
    const base = baseFiles?.[entry.path];
    if (existing === null) {
      // Deleted here after the last sync while the preset kept it: respect the deletion.
      if (base !== undefined && base === entry.sha256) decide("keep-local", "deleted on this machine");
      else decide("add");
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isFile()) {
      decide("skip", "not a regular file on this machine");
      continue;
    }
    const local = await sha256OfFile(absolute);
    const decision = decideMerge({
      local,
      remote: entry.sha256,
      base: base === undefined ? undefined : { value: base },
      withoutBase: "conflict",
      equal: (left, right) => left === right,
    });
    decide(
      decision === "same"
        ? "same"
        : decision === "take-remote"
          ? "update"
          : decision === "keep-local"
            ? "keep-local"
            : "conflict",
    );
  }
  // A skill is one unit: when any of its files conflicts, the whole skill
  // waits for one decision so it never ends up half old, half new.
  const conflictedSkillNames = new Set(
    plan.decisions.filter((entry) => entry.action === "conflict").map((entry) => skillOf(entry.path)),
  );
  for (const entry of plan.decisions) {
    if (
      (entry.action === "add" || entry.action === "update") &&
      conflictedSkillNames.has(skillOf(entry.path))
    ) {
      entry.action = "conflict";
    }
  }
  return plan;
}

/** Conflicted skills of a folder plan with the files that differ. */
export function conflictedSkills(plan: FolderPlan): { skill: string; paths: string[] }[] {
  const bySkill = new Map<string, string[]>();
  for (const entry of plan.decisions) {
    if (entry.action !== "conflict") continue;
    const skill = skillOf(entry.path);
    bySkill.set(skill, [...(bySkill.get(skill) ?? []), entry.path]);
  }
  return [...bySkill]
    .map(([skill, paths]) => ({ skill, paths }))
    .sort((left, right) => left.skill.localeCompare(right.skill));
}

export interface FolderApplyResult {
  written: number;
  skipped: string[];
  errors: string[];
  /** Base hashes to record for the next three-way decision. */
  baseFiles: Record<string, string>;
}

/**
 * Write the planned files. All payloads are verified before the first write,
 * so a damaged preset leaves the folder untouched.
 */
export async function applyFolder(args: {
  plan: FolderPlan;
  sourceDir: string;
  baseFiles: Record<string, string> | undefined;
  resolveConflict: (path: string) => "keep-local" | "take-remote" | undefined;
  journal: PullJournal;
}): Promise<FolderApplyResult> {
  const { plan, sourceDir, journal } = args;
  const result: FolderApplyResult = {
    written: 0,
    skipped: [],
    errors: [],
    baseFiles: { ...(args.baseFiles ?? {}) },
  };

  const toWrite: { decision: FolderDecision; content: Buffer }[] = [];
  for (const decision of plan.decisions) {
    if (decision.action === "same") {
      result.baseFiles[decision.path] = decision.sha256;
      continue;
    }
    if (decision.action === "skip") {
      result.skipped.push(`${plan.target}/${decision.path} (${decision.reason ?? "skipped"})`);
      continue;
    }
    if (decision.action === "keep-local") continue;
    if (decision.action === "conflict") {
      const choice = args.resolveConflict(decision.path);
      if (choice === "keep-local") {
        // The user has seen the preset version and keeps theirs.
        result.baseFiles[decision.path] = decision.sha256;
        continue;
      }
      if (choice !== "take-remote") {
        result.skipped.push(`${plan.target}/${decision.path} (kept your version, changed on both sides)`);
        continue;
      }
    }
    try {
      const content = await readFile(resolveWithin(sourceDir, decision.path));
      if (content.byteLength !== decision.size || sha256Hex(content) !== decision.sha256) {
        result.errors.push(`${plan.target}/${decision.path} failed integrity verification`);
        continue;
      }
      toWrite.push({ decision, content });
    } catch (cause) {
      result.errors.push(`${plan.target}/${decision.path}: ${(cause as Error).message}`);
    }
  }
  if (result.errors.length > 0) {
    result.errors.unshift(`Nothing in ${plan.target} was changed because the preset payload is incomplete`);
    return { ...result, baseFiles: { ...(args.baseFiles ?? {}) } };
  }

  await mkdir(plan.targetDir, { recursive: true });
  for (const { decision, content } of toWrite) {
    const absolute = resolveWithin(plan.targetDir, decision.path);
    try {
      // Re-check right before writing: the folder may have changed since the plan.
      const linked = await symlinkedParent(plan.targetDir, decision.path);
      if (linked !== null) {
        result.skipped.push(`${plan.target}/${decision.path} (folder ${linked} is a symbolic link)`);
        continue;
      }
      const existing = await lstat(absolute).catch(() => null);
      if (existing?.isSymbolicLink()) {
        result.skipped.push(`${plan.target}/${decision.path} (target is a symbolic link)`);
        continue;
      }
      if (existing !== null) await journal.backupFile(plan.target, absolute, decision.path);
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.bb-preset-tmp`;
      await writeFile(temporary, content);
      await rename(temporary, absolute);
      journal.recordFile({
        target: plan.target,
        path: decision.path,
        hadFile: existing !== null,
        writtenSha: decision.sha256,
      });
      result.baseFiles[decision.path] = decision.sha256;
      result.written += 1;
    } catch (cause) {
      result.errors.push(`${plan.target}/${decision.path}: ${(cause as Error).message}`);
    }
  }
  return result;
}

/** Undo one journaled file write, unless the file changed after the pull. */
export async function restoreFile(args: {
  targetDir: string;
  target: string;
  path: string;
  hadFile: boolean;
  writtenSha: string;
  journalDir: string;
}): Promise<{ restored: boolean; note?: string }> {
  const absolute = resolveWithin(args.targetDir, args.path);
  if ((await symlinkedParent(args.targetDir, args.path)) !== null) {
    return { restored: false, note: "a folder on the way is now a symbolic link" };
  }
  const current = await sha256OfFile(absolute);
  if (current !== args.writtenSha) {
    return { restored: false, note: "changed after the pull, left as it is" };
  }
  if (!args.hadFile) {
    await rm(absolute, { force: true });
    return { restored: true };
  }
  const backup = resolveWithin(resolve(args.journalDir, backupLabel(args.target)), args.path);
  const content = await readFile(backup);
  const temporary = `${absolute}.bb-preset-tmp`;
  await writeFile(temporary, content);
  await rename(temporary, absolute);
  return { restored: true };
}
