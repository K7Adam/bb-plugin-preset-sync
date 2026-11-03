import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Agent skills inside synced folders. A skill is the first path segment of a
 * collection (skill-name/SKILL.md plus supporting files), see
 * https://agentskills.io/specification.
 */

export function skillOf(relPath: string): string {
  return relPath.split("/")[0] ?? relPath;
}

export interface SkillHeader {
  name?: string;
  description?: string;
  /** `metadata.version` (spec) or a top-level `version`. */
  version?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** Read name, description and version from SKILL.md frontmatter (flat YAML subset). */
export function parseSkillHeader(text: string): SkillHeader {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (match === null) return {};
  const header: SkillHeader = {};
  let inMetadata = false;
  let multilineKey: "description" | null = null;
  const multiline: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    if (multilineKey !== null) {
      if (/^\s+\S/.test(line)) {
        multiline.push(line.trim());
        continue;
      }
      header[multilineKey] = multiline.join(" ");
      multilineKey = null;
    }
    const top = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (top !== null) {
      const [, key, value] = top;
      inMetadata = key === "metadata" && value!.trim() === "";
      if (key === "name") header.name = unquote(value!);
      else if (key === "version" && header.version === undefined) header.version = unquote(value!);
      else if (key === "description") {
        if (/^[>|][+-]?$/.test(value!.trim())) {
          multilineKey = "description";
          multiline.length = 0;
        } else header.description = unquote(value!);
      }
      continue;
    }
    const nested = /^\s+([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (inMetadata && nested !== null && nested[1] === "version") {
      header.version = unquote(nested[2]!);
    }
  }
  if (multilineKey !== null) header[multilineKey] = multiline.join(" ");
  return header;
}

/** "v1", "1.2", "0.1.0", "2.0.0-beta" -> numeric parts, or null when not a version. */
export function versionParts(value: string | undefined): number[] | null {
  if (value === undefined) return null;
  const match = /^v?(\d+(?:\.\d+)*)/i.exec(value.trim());
  return match === null ? null : match[1]!.split(".").map(Number);
}

/** -1, 0 or 1; null when either side has no comparable version. */
export function compareVersions(left: string | undefined, right: string | undefined): number | null {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** One skill's install record from the skills installer (~/.agents/.skill-lock.json). */
export const skillProvenanceSchema = z
  .object({
    source: z.string(),
    folderHash: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;

export const skillProvenanceFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.record(z.string(), skillProvenanceSchema),
  })
  .strict();

export type SkillProvenanceFile = z.infer<typeof skillProvenanceFileSchema>;

export const EMPTY_PROVENANCE: SkillProvenanceFile = { schemaVersion: 1, skills: {} };

/** Install records of this machine; empty when the skills installer was never used. */
export async function readLocalSkillLock(
  path = join(homedir(), ".agents", ".skill-lock.json"),
): Promise<Record<string, SkillProvenance>> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      skills?: Record<string, { source?: unknown; skillFolderHash?: unknown; updatedAt?: unknown; installedAt?: unknown }>;
    };
    const out: Record<string, SkillProvenance> = {};
    for (const [name, entry] of Object.entries(raw.skills ?? {})) {
      if (typeof entry?.source !== "string" || typeof entry.skillFolderHash !== "string") continue;
      const updatedAt =
        typeof entry.updatedAt === "string"
          ? entry.updatedAt
          : typeof entry.installedAt === "string"
            ? entry.installedAt
            : "";
      out[name] = { source: entry.source, folderHash: entry.skillFolderHash, updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export type NewerSide = "local" | "remote" | "same" | "unknown";
export type NewerEvidence = "version" | "source" | "date" | "none";

export interface NewerVerdict {
  newer: NewerSide;
  evidence: NewerEvidence;
  /** True when the verdict is only a hint and must not decide on its own. */
  hint: boolean;
  reason: string;
}

/**
 * Which side of a skill is newer, from the strongest evidence available:
 * an explicit version, then the installer's record of the same source, then
 * (as a hint only) whether the local copy changed after the preset was published.
 */
export function decideNewer(args: {
  localVersion?: string;
  remoteVersion?: string;
  localSource?: SkillProvenance;
  remoteSource?: SkillProvenance;
  localModifiedAt?: string;
  remotePublishedAt?: string;
  remoteMachine?: string;
}): NewerVerdict {
  const other = args.remoteMachine === undefined ? "the preset" : args.remoteMachine;
  const order = compareVersions(args.localVersion, args.remoteVersion);
  if (order !== null && order !== 0) {
    return {
      newer: order > 0 ? "local" : "remote",
      evidence: "version",
      hint: false,
      reason: `Version ${args.localVersion} here, ${args.remoteVersion} on ${other}.`,
    };
  }
  const local = args.localSource;
  const remote = args.remoteSource;
  if (local !== undefined && remote !== undefined && local.source === remote.source) {
    if (local.folderHash === remote.folderHash) {
      return {
        newer: "same",
        evidence: "source",
        hint: false,
        reason: `Both installed from ${local.source} at the same revision; the difference is a local edit.`,
      };
    }
    if (local.updatedAt !== "" && remote.updatedAt !== "" && local.updatedAt !== remote.updatedAt) {
      const remoteLater = remote.updatedAt > local.updatedAt;
      return {
        newer: remoteLater ? "remote" : "local",
        evidence: "source",
        hint: false,
        reason: `Both installed from ${local.source}; updated ${remoteLater ? `later on ${other}` : "later here"} (${(remoteLater ? remote : local).updatedAt.slice(0, 10)}).`,
      };
    }
  }
  if (args.localModifiedAt !== undefined && args.remotePublishedAt !== undefined) {
    const localLater = args.localModifiedAt > args.remotePublishedAt;
    return {
      newer: localLater ? "local" : "remote",
      evidence: "date",
      hint: true,
      reason: localLater
        ? `Your copy changed after ${other} published (dates only, no version).`
        : `Your copy is older than ${other}'s publish (dates only, no version).`,
    };
  }
  return { newer: "unknown", evidence: "none", hint: true, reason: "No version or install record on either side." };
}

/**
 * Agents load name and description of every skill at startup, about 100
 * tokens each (agentskills.io, progressive disclosure). Estimate from the text.
 */
export function estimateSkillTokens(header: SkillHeader): number {
  const text = `${header.name ?? ""} ${header.description ?? ""}`;
  return Math.max(20, Math.ceil(text.length / 4) + 10);
}
