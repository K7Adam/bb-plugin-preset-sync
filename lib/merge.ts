import { z } from "zod";

/**
 * Three-way decisions against the last synchronized value ("base").
 *
 * - same: nothing to do
 * - take-remote: only the preset changed since the last sync
 * - keep-local: only this machine changed since the last sync
 * - conflict: both changed; the local value is kept until the user decides
 */
export type MergeDecision = "same" | "take-remote" | "keep-local" | "conflict";

export function decideMerge<T>(args: {
  local: T;
  remote: T;
  base: { value: T } | undefined;
  /** What to do when nothing was synced yet and the values differ. */
  withoutBase: "take-remote" | "conflict";
  equal: (left: T, right: T) => boolean;
}): MergeDecision {
  const { local, remote, base, equal } = args;
  if (equal(local, remote)) return "same";
  if (base === undefined) return args.withoutBase;
  if (equal(base.value, remote)) return "keep-local";
  if (equal(base.value, local)) return "take-remote";
  return "conflict";
}

const jsonValue: z.ZodType<unknown> = z.unknown();

/** Last synchronized values of every synced setting, kept in plugin storage. */
export const syncBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    general: z.record(z.string(), jsonValue),
    experiments: z.record(z.string(), jsonValue),
    keybindingOverrides: jsonValue.optional(),
    appearance: jsonValue.optional(),
    /** Keyed by `pluginId.key`. */
    pluginSettings: z.record(z.string(), jsonValue),
  })
  .strict();

export type SyncBase = z.infer<typeof syncBaseSchema>;

export const EMPTY_SYNC_BASE: SyncBase = {
  schemaVersion: 1,
  general: {},
  experiments: {},
  pluginSettings: {},
};

export function baseEntry(
  record: Record<string, unknown>,
  key: string,
): { value: unknown } | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? { value: record[key] }
    : undefined;
}
