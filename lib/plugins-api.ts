import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseCatalogInstallSource } from "./preset";

export type InstalledPlugin = Awaited<
  ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>
>["plugins"][number];

export type SystemConfig = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["config"]>>;

export function pluginInstallSpec(plugin: InstalledPlugin): string {
  if (plugin.source.startsWith("builtin:")) return plugin.source;
  if (plugin.catalogEntryId !== undefined && plugin.catalogMarketplaceName !== undefined) {
    return `${plugin.catalogEntryId}@${plugin.catalogMarketplaceName}`;
  }
  return plugin.source;
}

export function pluginPathSource(plugin: InstalledPlugin): string | null {
  return plugin.source.startsWith("path:") ? plugin.source.slice(5) : null;
}

export async function installPluginFromPreset(
  bb: BbPluginApi,
  source: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const catalogTarget = parseCatalogInstallSource(source);
  if (catalogTarget === null) {
    return bb.sdk.plugins.install({ source });
  }

  const plan = await bb.sdk.plugins.catalog.installPlan({
    ...catalogTarget,
    signal,
  });
  if (!plan.compatible) {
    throw new Error(
      plan.incompatibleReason ?? `Catalog plugin ${catalogTarget.entryId} is incompatible`,
    );
  }

  if (plan.kind === "marketplace") {
    const unresolvedReason = plan.resolvedSource.unresolvedReason;
    if (unresolvedReason !== undefined) {
      throw new Error(unresolvedReason);
    }
    // BB accepts a confirmed source only for third-party marketplaces and
    // refuses it for its own (bb-official, bb-community).
    return bb.sdk.plugins.catalog.install(
      plan.official ? catalogTarget : { ...catalogTarget, confirmedSource: plan.resolvedSource },
    );
  }

  return bb.sdk.plugins.catalog.install(catalogTarget);
}

export function settingValueMatchesDescriptor(
  descriptor: { type: string; options?: string[] },
  value: string | boolean | number,
): boolean {
  if (descriptor.type === "boolean") return typeof value === "boolean";
  if (descriptor.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (typeof value !== "string") {
    // Number values stored against string descriptors (CLI-set overrides)
    // round-trip as JSON, which is safe to sync.
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (descriptor.type === "string" || descriptor.type === "project")
    );
  }
  if (descriptor.type === "select") return descriptor.options?.includes(value) ?? false;
  return descriptor.type === "string" || descriptor.type === "project";
}
