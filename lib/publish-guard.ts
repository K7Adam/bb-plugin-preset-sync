import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PresetSnapshot } from "./preset";
import { resolveWithin, type VendoredCollection } from "./vendor";

/**
 * Before this machine publishes, look for terms that must not leave it (for
 * example a company domain or a work e-mail address) in everything it would
 * contribute: plugin entries, settings and the files of synced folders.
 */

export const publishHitSchema = z.object({ where: z.string(), term: z.string() }).strict();
export type PublishHit = z.infer<typeof publishHitSchema>;

const MAX_HITS = 50;
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

export function parseBlockTerms(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(/[,\n]+/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 3),
    ),
  ];
}

function termsIn(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

export async function scanPublish(args: {
  snapshot: PresetSnapshot;
  collections: readonly VendoredCollection[];
  sourceDirs: ReadonlyMap<string, string>;
  terms: readonly string[];
}): Promise<PublishHit[]> {
  const { terms } = args;
  if (terms.length === 0) return [];
  const hits: PublishHit[] = [];
  const add = (where: string, text: string) => {
    for (const term of termsIn(text, terms)) {
      if (hits.length < MAX_HITS) hits.push({ where, term });
    }
  };

  for (const plugin of args.snapshot.plugins) add(`Plugin ${plugin.id}`, `${plugin.id} ${plugin.install}`);
  for (const entry of args.snapshot.pluginSettings) {
    add(`Plugin setting ${entry.id}.${entry.key}`, String(entry.value));
  }
  for (const marketplace of args.snapshot.marketplaces) {
    add(`Marketplace ${marketplace.name}`, `${marketplace.name} ${marketplace.source}`);
  }
  add("BB preferences", JSON.stringify(args.snapshot.settings));

  for (const collection of args.collections) {
    const sourceDir = args.sourceDirs.get(collection.id);
    if (sourceDir === undefined) continue;
    const label = collection.target ?? collection.id;
    for (const entry of collection.entries) {
      if (hits.length >= MAX_HITS) return hits;
      add(`${label}/${entry.path} (file name)`, entry.path);
      if (entry.size > MAX_SCANNED_FILE_BYTES) continue;
      const content = await readFile(resolveWithin(sourceDir, entry.path)).catch(() => null);
      if (content === null || content.subarray(0, 8000).includes(0)) continue;
      add(`${label}/${entry.path}`, content.toString("utf8"));
    }
  }
  return hits;
}

export class PublishBlockedError extends Error {
  constructor(readonly hits: PublishHit[]) {
    super(
      `Publishing is blocked: ${hits.length} ${hits.length === 1 ? "place contains" : "places contain"} a blocked term (${[
        ...new Set(hits.map((hit) => hit.term)),
      ].join(", ")}). Review them, exclude them, or publish anyway after checking.`,
    );
  }
}
