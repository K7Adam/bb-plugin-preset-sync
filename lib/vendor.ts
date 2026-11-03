import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * Vendored content: files copied into the Git preset so that machine-local
 * plugin directories and user file collections (for example skill folders)
 * become installable on other machines.
 *
 * Security model:
 * - Nothing outside the configured roots is ever read or written.
 * - Symbolic links are never followed on capture and never materialized on pull.
 * - Well-known secret file names and credential-looking file contents are
 *   refused so the preset cannot leak secrets into Git.
 * - Manifest-declared relative paths are re-validated on pull, so a tampered
 *   preset cannot write outside its collection target.
 */

export const VENDORED_PRESET_FILE = "preset/vendored.json";
export const VENDORED_REPO_DIR = "vendored";
export const VENDORED_INSTALL_PREFIX = "vendored:";

const manifestEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const vendoredCollectionSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(["plugin", "files"]),
    pluginId: z.string().min(1).optional(),
    repoDir: z.string().min(1),
    target: z.string().min(1).optional(),
    hash: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    entries: z.array(manifestEntrySchema),
  })
  .strict();

export const vendoredManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    collections: z.array(vendoredCollectionSchema),
  })
  .strict();

export type VendoredManifestEntry = z.infer<typeof manifestEntrySchema>;
export type VendoredCollection = z.infer<typeof vendoredCollectionSchema>;
export type VendoredManifest = z.infer<typeof vendoredManifestSchema>;

export const EMPTY_VENDORED_MANIFEST: VendoredManifest = {
  schemaVersion: 1,
  collections: [],
};

export interface VendorSettings {
  vendorLocalPlugins: boolean;
  vendoredPaths: string;
  vendorExcludeGlobs: string;
  vendorConflictMode: string;
  vendorPruneExtras: boolean;
  vendorNpmInstall: boolean;
  vendorMaxFileKb: number;
  vendorMaxCollectionMb: number;
}

export type VendorConflictMode = "backup" | "overwrite" | "skip";

export function vendorConflictMode(value: string): VendorConflictMode {
  return value === "overwrite" || value === "skip" ? value : "backup";
}

/** Directories and files that are never vendored (generated, VCS, OS noise). */
const IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".trash",
  "Thumbs.db",
  "desktop.ini",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

const IGNORED_FILE_SUFFIXES = [".log", ".tmp", ".swp", ".tsbuildinfo", ".pyc"];

/** Basenames (lowercase, glob-style) that may contain credentials. */
const SECRET_NAME_PATTERNS = [
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  ".my.cnf",
  ".kubeconfig",
  "kubeconfig",
  "credentials",
  "credentials.*",
  "*.credentials",
  "secrets.*",
  "*.secret",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.ppk",
  "*.ovpn",
  "*.kdbx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
];

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /-----BEGIN OPENSSH PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+\-]{20,}["']?/i,
];

const MAX_REL_PATH_LENGTH = 220;
const MAX_FILE_COUNT = 5000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class VendorError extends Error {}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Glob matcher over collection-relative POSIX paths.
 * `*` matches within a segment, `**` across segments, `?` one char.
 * Patterns without "/" match the basename at any depth.
 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  const source = pattern.includes("/") ? relPath : basename(relPath);
  const regex = globToRegex(pattern);
  return regex.test(source);
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${out}$`, "i");
}

export function parseGlobList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\\/g, "/"));
}

function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_NAME_PATTERNS.some((pattern) =>
    matchesGlob(lower, pattern.toLowerCase()),
  );
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  return !buffer.includes(0) && !buffer.toString("utf8").includes("�");
}

export function scanTextForCredentials(text: string): string | null {
  for (const pattern of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) return `credential-like content (${pattern.source.slice(0, 40)}…)`;
  }
  return null;
}

/** Validate a manifest-relative POSIX path strictly. */
export function isValidVendoredRelPath(relPath: string): boolean {
  if (
    relPath === "" ||
    relPath.length > MAX_REL_PATH_LENGTH ||
    relPath.startsWith("/") ||
    relPath.endsWith("/") ||
    relPath.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f]/.test(relPath)
  ) {
    return false;
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(" ") ||
      segment.endsWith(".") ||
      /[<>:"|?*\x00-\x1f]/.test(segment)
    ) {
      return false;
    }
    // Windows device names cannot be materialized on Windows targets.
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) return false;
  }
  return true;
}

/**
 * Return the first folder between `root` (exclusive) and the file `rel` that
 * is a symbolic link or junction, or null. Writing through such a folder
 * would land outside the target even though the path text stays inside it.
 */
export async function symlinkedParent(root: string, rel: string): Promise<string | null> {
  const segments = rel.split("/");
  let current = resolve(root);
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]!);
    const entry = await lstat(current).catch(() => null);
    if (entry === null) return null;
    if (entry.isSymbolicLink()) return segments.slice(0, index + 1).join("/");
  }
  return null;
}

/** Resolve `rel` inside `root`, refusing any escape. Returns the absolute path. */
export function resolveWithin(root: string, rel: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, rel.split("/").join(sep));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new VendorError(`Path escapes its collection root: ${rel}`);
  }
  return target;
}

export function expandHome(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

/** Returns "~/relative" when the absolute path lives inside the home directory. */
export function toHomeRelative(absolutePath: string): string | null {
  const home = resolve(homedir());
  const target = resolve(absolutePath);
  if (target === home) return "~";
  if (!target.startsWith(`${home}${sep}`)) return null;
  return `~/${target.slice(home.length + 1).split(sep).join("/")}`;
}

export function collectionIdForPath(homeRelative: string): string {
  const slug = homeRelative
    .replace(/^~\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? "files" : slug;
}

export function isVendoredInstallSource(source: string): boolean {
  return /^vendored:[a-z0-9][a-z0-9._-]{0,79}$/i.test(source.trim());
}

/** Collection ids double as path segments — keep them strictly slugs. */
export function isValidVendoredId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id);
}

/** Remote-declared repo dirs must be exactly vendored/<group>/<id>. */
export function isValidVendoredRepoDir(repoDir: string): boolean {
  return /^vendored\/(?:plugins|files)\/[a-z0-9][a-z0-9._-]{0,79}$/i.test(repoDir);
}

export function vendoredInstallSource(pluginId: string): string {
  return `${VENDORED_INSTALL_PREFIX}${pluginId}`;
}

export function vendoredPluginId(source: string): string | null {
  const match = /^vendored:([a-z0-9][a-z0-9._-]{0,79})$/i.exec(source.trim());
  return match?.[1] ?? null;
}

export function vendoredRootDir(): string {
  return join(homedir(), ".bb", "preset-vendored");
}

export function vendoredPluginDir(pluginId: string): string {
  return join(vendoredRootDir(), "plugins", pluginId);
}

export function vendoredBackupRoot(): string {
  return join(vendoredRootDir(), "backup");
}

export function vendoredTrashRoot(): string {
  return join(vendoredRootDir(), "trash");
}

export function vendoredStateFile(): string {
  return join(vendoredRootDir(), "state.json");
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface WalkResult {
  entries: VendoredManifestEntry[];
  hash: string;
  bytes: number;
  skipped: SkippedEntry[];
}

interface WalkLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxBytes: number;
  excludeGlobs: string[];
}

async function walkDirectory(
  dir: string,
  relPrefix: string,
  limits: WalkLimits,
  result: WalkResult,
): Promise<void> {
  let dirEntries;
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    throw new VendorError(
      `Cannot read vendored directory ${dir}: ${(cause as Error).message}`,
    );
  }
  dirEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of dirEntries) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    const absolute = join(dir, entry.name);

    if (IGNORED_NAMES.has(entry.name)) continue;

    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      result.skipped.push({ path: rel, reason: "symbolic link" });
      continue;
    }
    if (stat.isDirectory()) {
      await walkDirectory(absolute, rel, limits, result);
      continue;
    }
    if (!stat.isFile()) {
      result.skipped.push({ path: rel, reason: "not a regular file" });
      continue;
    }
    if (IGNORED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      continue;
    }
    if (!isValidVendoredRelPath(rel)) {
      result.skipped.push({ path: rel, reason: "unsafe file name" });
      continue;
    }
    if (isSecretFileName(entry.name)) {
      result.skipped.push({ path: rel, reason: "credential-like file name" });
      continue;
    }
    if (limits.excludeGlobs.some((glob) => matchesGlob(rel, glob))) {
      result.skipped.push({ path: rel, reason: "excluded by glob" });
      continue;
    }
    if (stat.size > limits.maxFileBytes) {
      result.skipped.push({
        path: rel,
        reason: `larger than ${limits.maxFileBytes} bytes`,
      });
      continue;
    }
    if (result.entries.length >= limits.maxFiles) {
      result.skipped.push({
        path: rel,
        reason: `collection exceeds ${limits.maxFiles} files`,
      });
      continue;
    }
    if (result.bytes + stat.size > limits.maxBytes) {
      result.skipped.push({
        path: rel,
        reason: `collection exceeds ${limits.maxBytes} bytes`,
      });
      continue;
    }

    const content = await readFile(absolute);
    if (looksLikeUtf8Text(content)) {
      const issue = scanTextForCredentials(content.toString("utf8"));
      if (issue !== null) {
        result.skipped.push({ path: rel, reason: issue });
        continue;
      }
    }

    result.entries.push({ path: rel, size: stat.size, sha256: sha256Hex(content) });
    result.bytes += stat.size;
  }
}

/**
 * Walk a vendored source directory deterministically. Content-hashes every
 * file so the collection hash changes exactly when content changes.
 */
export async function walkVendoredSource(
  rootDir: string,
  options: {
    maxFileBytes: number;
    maxBytes: number;
    excludeGlobs?: string[];
  },
): Promise<WalkResult> {
  const root = resolve(rootDir);
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat === null) {
    throw new VendorError(`Vendored path does not exist: ${rootDir}`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new VendorError(`Vendored path must not be a symbolic link: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new VendorError(`Vendored path is not a directory: ${rootDir}`);
  }
  const result: WalkResult = { entries: [], hash: "", bytes: 0, skipped: [] };
  await walkDirectory(
    root,
    "",
    {
      maxFileBytes: options.maxFileBytes,
      maxFiles: MAX_FILE_COUNT,
      maxBytes: Math.min(options.maxBytes, MAX_TOTAL_BYTES),
      excludeGlobs: options.excludeGlobs ?? [],
    },
    result,
  );
  result.entries.sort((a, b) => a.path.localeCompare(b.path));
  result.hash = hashCollectionEntries(result.entries);
  return result;
}

export function hashCollectionEntries(entries: VendoredManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.path}${entry.size}${entry.sha256}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Copy the manifest-listed files from `sourceDir` into `targetDir`.
 * Returns per-action counts; never throws for individual file conflicts.
 */
export async function materializeVendoredFiles(args: {
  sourceDir: string;
  entries: VendoredManifestEntry[];
  targetDir: string;
  conflict: VendorConflictMode;
  pruneExtras: boolean;
  backupRoot?: string;
  preserveNames?: ReadonlySet<string>;
}): Promise<{
  written: number;
  unchanged: number;
  backedUp: number;
  skipped: string[];
  pruned: string[];
  errors: string[];
}> {
  const { sourceDir, entries, targetDir, conflict, pruneExtras, backupRoot } = args;
  const preserve = args.preserveNames ?? new Set<string>();
  const out = {
    written: 0,
    unchanged: 0,
    backedUp: 0,
    skipped: [] as string[],
    pruned: [] as string[],
    errors: [] as string[],
  };

  const targetStat = await lstat(targetDir).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    out.errors.push(`Target must not be a symbolic link: ${targetDir}`);
    return out;
  }
  await mkdir(targetDir, { recursive: true });

  const manifestPaths = new Set<string>();
  for (const entry of entries) {
    if (!isValidVendoredRelPath(entry.path)) {
      out.errors.push(`Invalid manifest path skipped: ${entry.path}`);
      continue;
    }
    manifestPaths.add(entry.path);
    const source = resolveWithin(sourceDir, entry.path);
    const target = resolveWithin(targetDir, entry.path);
    try {
      const linkedFolder = await symlinkedParent(targetDir, entry.path);
      if (linkedFolder !== null) {
        out.skipped.push(`${entry.path} (folder ${linkedFolder} is a symbolic link)`);
        continue;
      }
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        out.skipped.push(`${entry.path} (not a regular file in the preset)`);
        continue;
      }
      const content = await readFile(source);
      const digest = sha256Hex(content);
      if (digest !== entry.sha256 || content.byteLength !== entry.size) {
        out.errors.push(
          `${entry.path} failed integrity verification against the manifest`,
        );
        continue;
      }
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        out.skipped.push(`${entry.path} (target is a symbolic link)`);
        continue;
      }
      if (existing?.isFile()) {
        const existingContent = await readFile(target);
        if (
          existingContent.byteLength === content.byteLength &&
          sha256Hex(existingContent) === digest
        ) {
          out.unchanged += 1;
          continue;
        }
        if (conflict === "skip") {
          out.skipped.push(`${entry.path} (locally modified)`);
          continue;
        }
        if (conflict === "backup" && backupRoot !== undefined) {
          const backupPath = resolveWithin(backupRoot, entry.path);
          await mkdir(dirname(backupPath), { recursive: true });
          await cp(target, backupPath, { force: true });
          out.backedUp += 1;
        }
      }
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.bb-vendor-tmp`;
      await writeFile(temporary, content);
      await rename(temporary, target);
      out.written += 1;
    } catch (cause) {
      out.errors.push(`${entry.path}: ${(cause as Error).message}`);
    }
  }

  if (pruneExtras) {
    const extras: string[] = [];
    await collectExtras(targetDir, "", manifestPaths, preserve, extras).catch(
      (cause) => out.errors.push(`prune scan: ${(cause as Error).message}`),
    );
    for (const rel of extras) {
      const absolute = resolveWithin(targetDir, rel);
      try {
        if (backupRoot !== undefined) {
          const trashPath = resolveWithin(backupRoot, rel);
          await mkdir(dirname(trashPath), { recursive: true });
          await rename(absolute, trashPath);
        } else {
          await rm(absolute, { force: true });
        }
        out.pruned.push(rel);
      } catch (cause) {
        out.errors.push(`prune ${rel}: ${(cause as Error).message}`);
      }
    }
    await removeEmptyDirs(targetDir, preserve);
  }
  return out;
}

async function collectExtras(
  dir: string,
  relPrefix: string,
  manifestPaths: ReadonlySet<string>,
  preserve: ReadonlySet<string>,
  extras: string[],
): Promise<void> {
  const dirEntries = await readdir(dir, { withFileTypes: true });
  for (const entry of dirEntries) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    if (preserve.has(entry.name) || IGNORED_NAMES.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectExtras(absolute, rel, manifestPaths, preserve, extras);
    } else if (!manifestPaths.has(rel)) {
      extras.push(rel);
    }
  }
}

async function removeEmptyDirs(
  dir: string,
  preserve: ReadonlySet<string>,
): Promise<void> {
  const dirEntries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || preserve.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    await removeEmptyDirs(absolute, preserve);
    const remaining = await readdir(absolute).catch(() => ["?"]);
    // rmdir only ever removes an empty directory, so a race cannot delete content.
    if (remaining.length === 0) await rmdir(absolute).catch(() => undefined);
  }
}

/**
 * Copy vendored payloads described by a manifest from live source dirs into a
 * cloned preset repository. Collections without a local source keep whatever
 * the repo already carries (they are owned by another machine); directories no
 * longer referenced by the manifest are pruned.
 */
export async function exportVendoredToRepo(args: {
  repoDir: string;
  manifest: VendoredManifest;
  sourceDirs: Map<string, string>;
}): Promise<{ copied: number; errors: string[] }> {
  const errors: string[] = [];
  let copied = 0;
  const vendoredRoot = resolveWithin(args.repoDir, VENDORED_REPO_DIR);
  const expectedDirs = new Set(
    args.manifest.collections
      .map((collection) => collection.repoDir)
      .filter(isValidVendoredRepoDir),
  );

  // Payloads are sha256-verified on pull — forbid text conversion so clones
  // on any autocrlf setting hand back the exact committed bytes.
  await mkdir(vendoredRoot, { recursive: true });
  await writeFile(
    join(vendoredRoot, ".gitattributes"),
    "* -text\n",
    "utf8",
  );

  for (const collection of args.manifest.collections) {
    const sourceDir = args.sourceDirs.get(collection.id);
    if (!isValidVendoredRepoDir(collection.repoDir)) {
      errors.push(
        `Collection ${collection.id} has an invalid repoDir: ${collection.repoDir}`,
      );
      continue;
    }
    const targetRoot = resolveWithin(args.repoDir, collection.repoDir);
    if (
      !targetRoot.startsWith(`${vendoredRoot}${sep}`) &&
      targetRoot !== vendoredRoot
    ) {
      errors.push(`Collection ${collection.id} escapes ${VENDORED_REPO_DIR}/`);
      continue;
    }
    if (sourceDir === undefined) continue; // foreign-owned: keep repo content
    await rm(targetRoot, { recursive: true, force: true });
    for (const entry of collection.entries) {
      if (!isValidVendoredRelPath(entry.path)) {
        errors.push(`${collection.id}/${entry.path}: invalid path`);
        continue;
      }
      try {
        const source = resolveWithin(sourceDir, entry.path);
        const sourceStat = await lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          errors.push(`${collection.id}/${entry.path}: not a regular file`);
          continue;
        }
        const target = resolveWithin(targetRoot, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { force: true });
        copied += 1;
      } catch (cause) {
        errors.push(
          `${collection.id}/${entry.path}: ${(cause as Error).message}`,
        );
      }
    }
  }

  // Drop repo directories the manifest no longer references.
  for (const group of ["plugins", "files"] as const) {
    const groupDir = join(vendoredRoot, group);
    const entries = await readdir(groupDir, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[],
    );
    for (const entry of entries) {
      const rel = `${VENDORED_REPO_DIR}/${group}/${entry.name}`;
      if (!expectedDirs.has(rel)) {
        await rm(join(groupDir, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  return { copied, errors };
}

export interface VendorAppliedState {
  collections: Record<
    string,
    {
      hash: string;
      appliedAt: string;
      target?: string;
      /** Last synchronized sha256 per collection-relative path (three-way base). */
      files?: Record<string, string>;
    }
  >;
}

export async function writeVendorState(state: VendorAppliedState): Promise<void> {
  const file = vendoredStateFile();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function readVendorState(): Promise<VendorAppliedState> {
  try {
    const raw = JSON.parse(await readFile(vendoredStateFile(), "utf8"));
    const collections =
      raw !== null && typeof raw === "object" && raw.collections !== null &&
      typeof raw.collections === "object"
        ? (raw.collections as VendorAppliedState["collections"])
        : {};
    return { collections };
  } catch {
    return { collections: {} };
  }
}

export async function recordVendorApplied(
  collectionId: string,
  record: { hash: string; target?: string; files?: Record<string, string> },
): Promise<void> {
  const state = await readVendorState();
  await writeVendorState({
    collections: {
      ...state.collections,
      [collectionId]: {
        hash: record.hash,
        appliedAt: new Date().toISOString(),
        target: record.target,
        files: record.files ?? state.collections[collectionId]?.files,
      },
    },
  });
}

export async function readVendoredManifest(repoDir: string): Promise<VendoredManifest> {
  try {
    const raw = JSON.parse(
      await readFile(join(repoDir, VENDORED_PRESET_FILE), "utf8"),
    );
    return vendoredManifestSchema.parse(raw);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_VENDORED_MANIFEST;
    }
    if (cause instanceof Error && cause.message.includes("ENOENT")) {
      return EMPTY_VENDORED_MANIFEST;
    }
    throw cause;
  }
}

export async function writeVendoredManifest(
  repoDir: string,
  manifest: VendoredManifest,
): Promise<void> {
  const path = join(repoDir, VENDORED_PRESET_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Manifest comparison that ignores collection ordering. */
export function sameVendoredManifest(
  left: VendoredManifest,
  right: VendoredManifest,
): boolean {
  const normalize = (manifest: VendoredManifest) =>
    [...manifest.collections]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((collection) => ({
        ...collection,
        entries: [...collection.entries].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
      }));
  return (
    JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
  );
}

/** Marker recording which dependency set was last prepared successfully. */
const PREPARED_DEPS_MARKER = ".bb-vendored-deps";

export const VENDORED_PLUGIN_PRESERVE_NAMES = new Set([
  "node_modules",
  ".git",
  PREPARED_DEPS_MARKER,
]);

/**
 * Ensure npm dependencies of a materialized vendored plugin exist. Runs
 * `npm ci` (lockfile present) or `npm install` only when the dependency
 * inputs changed since the last successful prepare.
 */
export async function prepareVendoredPlugin(
  pluginDir: string,
  run: (
    command: string,
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stderr: string }>,
): Promise<string | null> {
  const manifestPath = join(pluginDir, "package.json");
  let manifestSource: string;
  try {
    manifestSource = await readFile(manifestPath, "utf8");
  } catch {
    return null; // No package.json — nothing to prepare.
  }
  try {
    const manifest = JSON.parse(manifestSource);
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    if (Object.keys(deps).length === 0) return null;

    const lockSource = await readFile(
      join(pluginDir, "package-lock.json"),
      "utf8",
    ).catch(() => "");
    const depsSha = sha256Hex(
      Buffer.from(`${manifestSource}${lockSource}`, "utf8"),
    );
    const markerPath = join(pluginDir, PREPARED_DEPS_MARKER);
    const prepared = await readFile(markerPath, "utf8").catch(() => "");
    const hasModules = await stat(join(pluginDir, "node_modules"))
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (prepared.trim() === depsSha && hasModules) return null;

    const hasLock = lockSource !== "";
    const result = await run(
      "npm",
      hasLock
        ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
        : ["install", "--omit=dev", "--no-audit", "--no-fund"],
      pluginDir,
    );
    if (result.code !== 0) {
      return `npm ${hasLock ? "ci" : "install"} failed: ${result.stderr.slice(0, 300)}`;
    }
    await writeFile(markerPath, `${depsSha}\n`, "utf8").catch(() => undefined);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

