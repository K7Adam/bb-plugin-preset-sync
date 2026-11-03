/**
 * Directory-backed stand-in for lib/git.ts. Only the Git transport is faked:
 * reading and writing the preset goes through the real preset and vendor
 * modules, so tests exercise the same files a real clone would contain.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { readPresetSnapshot, writePresetSnapshot, type PresetSnapshot } from "../../lib/preset";
import {
  VENDORED_REPO_DIR,
  exportVendoredToRepo,
  readVendoredManifest,
  writeVendoredManifest,
  type VendoredManifest,
} from "../../lib/vendor";

const remotes = new Map<string, string>();

export function registerFakeRemote(repositoryUrl: string, directory: string): void {
  remotes.set(repositoryUrl, directory);
}

export function clearFakeRemotes(): void {
  remotes.clear();
}

function remoteDir(repositoryUrl: string): string {
  const directory = remotes.get(repositoryUrl);
  if (directory === undefined) throw new Error(`Unknown fake remote ${repositoryUrl}`);
  return directory;
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else files.push(relative(root, absolute));
  }
  return files.sort();
}

/** Content hash of the whole remote, standing in for the commit sha. */
export async function fakeHead(repositoryUrl: string): Promise<string> {
  const root = remoteDir(repositoryUrl);
  const hash = createHash("sha1");
  for (const file of await listFiles(root)) {
    hash.update(file);
    hash.update(await readFile(join(root, file)));
  }
  return hash.digest("hex");
}

export async function readRemotePreset(options: {
  repositoryUrl: string;
  copyVendoredTo?: string;
}): Promise<{
  snapshot: PresetSnapshot;
  head: string;
  vendored: VendoredManifest;
  vendoredWarning?: string;
}> {
  const root = remoteDir(options.repositoryUrl);
  const [snapshot, vendored, head] = await Promise.all([
    readPresetSnapshot(root),
    readVendoredManifest(root),
    fakeHead(options.repositoryUrl),
  ]);
  if (options.copyVendoredTo !== undefined && vendored.collections.length > 0) {
    await cp(join(root, VENDORED_REPO_DIR), options.copyVendoredTo, { recursive: true });
  }
  return { snapshot, head, vendored };
}

export async function pushRemotePreset(
  options: { repositoryUrl: string },
  snapshot: PresetSnapshot,
  vendored?: {
    manifest: VendoredManifest;
    sourceDirs: Map<string, string>;
    preserved?: Map<string, Set<string>>;
  },
): Promise<{ pushed: boolean; head: string; changedFiles: string[]; vendoredErrors: string[] }> {
  const root = remoteDir(options.repositoryUrl);
  await mkdir(root, { recursive: true });
  await writePresetSnapshot(root, snapshot);
  const manifest = vendored?.manifest ?? { schemaVersion: 1 as const, collections: [] };
  await writeVendoredManifest(root, manifest);
  const exported =
    vendored === undefined
      ? { errors: [] as string[] }
      : await exportVendoredToRepo({ repoDir: root, manifest, sourceDirs: vendored.sourceDirs, preserved: vendored.preserved });
  return {
    pushed: true,
    head: await fakeHead(options.repositoryUrl),
    changedFiles: [],
    vendoredErrors: exported.errors,
  };
}
