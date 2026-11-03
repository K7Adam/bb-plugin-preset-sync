import { z } from "zod";
import type { FolderPlan } from "./folder-sync";
import { skillConflictInfoSchema } from "./preset";
import { estimateSkillTokens, skillOf, type SkillHeader } from "./skills";
import { matchesGlob } from "./vendor";

/**
 * Named skill groups this machine skips, for example "Android" with
 * `android-*`. They are stored per machine, shown on the Preset Sync page and
 * apply to every synced folder in both directions: a skipped skill is neither
 * pulled here nor published from here, and stays in the preset for others.
 */
export const skillGroupSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().trim().min(1).max(80),
    patterns: z.array(z.string().trim().min(1).max(200)).max(500),
    skip: z.boolean(),
  })
  .strict();

export type SkillGroup = z.infer<typeof skillGroupSchema>;

export const skillGroupsSchema = z.array(skillGroupSchema).max(50);

/** A pattern names skills (`android-*`); it also covers everything inside them. */
export function groupExcludes(groups: readonly SkillGroup[]): string[] {
  return groups
    .filter((group) => group.skip)
    .flatMap((group) =>
      group.patterns.flatMap((pattern) => (pattern.includes("/") ? [pattern] : [pattern, `${pattern}/**`])),
    );
}

export function groupOfSkill(skill: string, groups: readonly SkillGroup[]): SkillGroup | undefined {
  return groups.find((group) => group.patterns.some((pattern) => matchesGlob(skill, pattern)));
}

export const skillStatusSchema = z.enum([
  "same",
  "new",
  "update",
  "conflict",
  "only-here",
  "linked",
  "skipped",
]);

export const skillRowSchema = z
  .object({
    name: z.string(),
    status: skillStatusSchema,
    here: z.boolean(),
    inPreset: z.boolean(),
    group: z.string().optional(),
    localVersion: z.string().optional(),
    remoteVersion: z.string().optional(),
    tokens: z.number().int().nonnegative(),
  })
  .strict();

export const folderOverviewSchema = z
  .object({
    collectionId: z.string(),
    target: z.string(),
    skills: z.array(skillRowSchema),
    counts: z
      .object({
        here: z.number().int().nonnegative(),
        afterPull: z.number().int().nonnegative(),
        inPreset: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict(),
    tokensHere: z.number().int().nonnegative(),
    tokensAfterPull: z.number().int().nonnegative(),
  })
  .strict();

export const skillsOverviewSchema = z
  .object({
    remoteMachine: z.string().optional(),
    folders: z.array(folderOverviewSchema),
    groups: skillGroupsSchema,
  })
  .strict();

export type SkillRow = z.infer<typeof skillRowSchema>;
export type FolderOverview = z.infer<typeof folderOverviewSchema>;
export type SkillsOverview = z.infer<typeof skillsOverviewSchema>;

export function buildFolderOverview(args: {
  plan: FolderPlan;
  /** Top-level entries of the local folder. */
  localEntries: { name: string; linked: boolean }[];
  localHeaders: Map<string, SkillHeader>;
  remoteHeaders: Map<string, SkillHeader>;
  excludeGlobs: readonly string[];
  groups: readonly SkillGroup[];
}): FolderOverview {
  const { plan } = args;
  const remoteSkills = new Set(plan.collection.entries.map((entry) => skillOf(entry.path)));
  const actions = new Map<string, Set<string>>();
  for (const decision of plan.decisions) {
    const skill = skillOf(decision.path);
    const set = actions.get(skill) ?? new Set<string>();
    set.add(decision.action);
    actions.set(skill, set);
  }
  const local = new Map(args.localEntries.map((entry) => [entry.name, entry]));
  const names = [...new Set([...remoteSkills, ...local.keys()])]
    .filter((name) => !name.startsWith("."))
    .sort((left, right) => left.localeCompare(right));

  const rows: SkillRow[] = names.map((name) => {
    const here = local.has(name);
    const inPreset = remoteSkills.has(name);
    const skipped = args.excludeGlobs.some(
      (glob) => matchesGlob(name, glob) || matchesGlob(`${name}/SKILL.md`, glob),
    );
    const set = actions.get(name) ?? new Set<string>();
    const status: SkillRow["status"] = skipped
      ? "skipped"
      : local.get(name)?.linked === true
        ? "linked"
        : !inPreset
          ? "only-here"
          : set.has("conflict")
            ? "conflict"
            : !here
              ? "new"
              : set.has("update") || set.has("add")
                ? "update"
                : "same";
    const header = args.localHeaders.get(name) ?? args.remoteHeaders.get(name) ?? {};
    const group = groupOfSkill(name, args.groups)?.name;
    return {
      name,
      status,
      here,
      inPreset,
      ...(group === undefined ? {} : { group }),
      ...(args.localHeaders.get(name)?.version === undefined
        ? {}
        : { localVersion: args.localHeaders.get(name)!.version }),
      ...(args.remoteHeaders.get(name)?.version === undefined
        ? {}
        : { remoteVersion: args.remoteHeaders.get(name)!.version }),
      tokens: estimateSkillTokens(header),
    };
  });

  const afterPull = rows.filter((row) => row.here || row.status === "new");
  return {
    collectionId: plan.collection.id,
    target: plan.target,
    skills: rows,
    counts: {
      here: rows.filter((row) => row.here).length,
      afterPull: afterPull.length,
      inPreset: rows.filter((row) => row.inPreset).length,
      skipped: rows.filter((row) => row.status === "skipped" && row.inPreset && !row.here).length,
    },
    tokensHere: rows.filter((row) => row.here).reduce((sum, row) => sum + row.tokens, 0),
    tokensAfterPull: afterPull.reduce((sum, row) => sum + row.tokens, 0),
  };
}

export const conflictFileSchema = z
  .object({
    path: z.string(),
    change: z.enum(["differs", "new-in-preset"]),
    patch: z.string(),
    lineEndingsOnly: z.boolean(),
    binary: z.boolean(),
  })
  .strict();

export const conflictDetailSchema = z
  .object({
    conflictId: z.string(),
    remoteMachine: z.string().optional(),
    skill: skillConflictInfoSchema,
    files: z.array(conflictFileSchema),
  })
  .strict();

export type ConflictDetail = z.infer<typeof conflictDetailSchema>;
