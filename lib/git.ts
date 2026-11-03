import { execFile } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MANAGED_PRESET_FILES,
  errorMessage,
  readPresetSnapshot,
  samePresetConfiguration,
  writePresetSnapshot,
  type PresetSnapshot,
} from "./preset";
import {
  VENDORED_REPO_DIR,
  exportVendoredToRepo,
  readVendoredManifest,
  sameVendoredManifest,
  writeVendoredManifest,
  type VendoredManifest,
} from "./vendor";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export interface GitRepositoryOptions {
  repositoryUrl: string;
  branch: string;
  githubToken?: string;
  signal?: AbortSignal;
}

export interface GitPushOptions extends GitRepositoryOptions {
  authorName: string;
  authorEmail: string;
  message: string;
}

function validateBranch(branch: string): string {
  const normalized = branch.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock")
  ) {
    throw new Error(`Invalid Git branch name: ${branch}`);
  }
  return normalized;
}

function validateRepositoryUrl(repositoryUrl: string): string {
  const normalized = repositoryUrl.trim();
  if (normalized.startsWith("https://") || normalized.startsWith("ssh://")) {
    const parsed = new URL(normalized);
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error(
        "Do not embed credentials in the repository URL; use the GitHub token setting.",
      );
    }
    return normalized;
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(normalized)) {
    return normalized;
  }
  throw new Error("Repository URL must use HTTPS or SSH.");
}

function gitEnvironment(repositoryUrl: string, githubToken?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GCM_INTERACTIVE: "Never",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
  };
  const token = githubToken?.trim();
  if (token === undefined || token === "") return env;

  let hostname = "";
  try {
    hostname = new URL(repositoryUrl).hostname.toLowerCase();
  } catch {
    return env;
  }
  if (hostname !== "github.com" && !hostname.endsWith(".github.com")) return env;

  const existingCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isSafeInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "http.https://github.com/.extraheader";
  env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${token}`,
  ).toString("base64")}`;
  return env;
}

function redact(value: string, secret?: string): string {
  const token = secret?.trim();
  return token === undefined || token === ""
    ? value
    : value.split(token).join("[redacted]");
}

async function runGit(
  args: string[],
  options: GitRepositoryOptions & { cwd?: string },
): Promise<string> {
  const repositoryUrl = validateRepositoryUrl(options.repositoryUrl);
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: gitEnvironment(repositoryUrl, options.githubToken),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      signal: options.signal,
      timeout: GIT_TIMEOUT_MS,
    });
    // Preserve leading spaces: Git porcelain status uses them as column data.
    return result.stdout.trimEnd();
  } catch (cause) {
    const candidate = cause as Error & { stderr?: string; stdout?: string };
    const detail = candidate.stderr?.trim() || candidate.stdout?.trim() || errorMessage(cause);
    throw new Error(`Git command failed: ${redact(detail, options.githubToken)}`);
  }
}

async function withClone<T>(
  options: GitRepositoryOptions,
  operation: (repoDir: string) => Promise<T>,
): Promise<T> {
  const repositoryUrl = validateRepositoryUrl(options.repositoryUrl);
  const branch = validateBranch(options.branch);
  const tempRoot = await mkdtemp(join(tmpdir(), "bb-preset-sync-"));
  const repoDir = join(tempRoot, "repo");
  try {
    await runGit(
      ["clone", "--quiet", "--single-branch", "--branch", branch, repositoryUrl, repoDir],
      options,
    );
    // Vendored payloads are sha256-verified on pull — the clone must hand back
    // the exact bytes that were committed, regardless of the user's global
    // autocrlf/eol settings.
    await runGit(
      ["config", "core.autocrlf", "false"],
      { ...options, cwd: repoDir },
    ).catch(() => undefined);
    await runGit(["config", "core.eol", "lf"], { ...options, cwd: repoDir }).catch(
      () => undefined,
    );
    return await operation(repoDir);
  } finally {
    // Windows: a just-exited git child or AV scan can hold .git handles briefly;
    // retry instead of letting cleanup mask the operation result.
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function readExistingPreset(
  repoDir: string,
): Promise<PresetSnapshot | null> {
  try {
    return await readPresetSnapshot(repoDir);
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !cause.message.includes("Preset file is missing:")
    ) {
      throw cause;
    }
    const present = await Promise.all(
      MANAGED_PRESET_FILES.map(async (relativePath) => {
        try {
          await access(join(repoDir, relativePath));
          return true;
        } catch (accessCause) {
          if ((accessCause as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw accessCause;
        }
      }),
    );
    if (present.some(Boolean)) {
      throw new Error(`Preset repository is incomplete: ${cause.message}`);
    }
    return null;
  }
}

export async function readRemotePreset(
  options: GitRepositoryOptions & { copyVendoredTo?: string },
): Promise<{
  snapshot: PresetSnapshot;
  head: string;
  vendored: VendoredManifest;
  vendoredWarning?: string;
}> {
  return withClone(options, async (repoDir) => {
    const [snapshot, head, vendored] = await Promise.all([
      readPresetSnapshot(repoDir),
      runGit(["rev-parse", "HEAD"], { ...options, cwd: repoDir }),
      readVendoredManifest(repoDir).catch((cause) => ({
        warning: `vendored.json could not be read (${errorMessage(cause)}); vendored payloads will be skipped.`,
        manifest: null,
      })),
    ]);
    const vendoredWarning =
      vendored !== null && "warning" in vendored
        ? vendored.warning
        : undefined;
    const vendoredManifest =
      vendored !== null && "warning" in vendored
        ? { schemaVersion: 1 as const, collections: [] }
        : vendored;
    if (
      options.copyVendoredTo !== undefined &&
      vendoredManifest.collections.length > 0
    ) {
      await cp(join(repoDir, VENDORED_REPO_DIR), options.copyVendoredTo, {
        recursive: true,
        // Vendored payloads must be regular files; symlinks are filtered out
        // entirely (also avoids Windows privilege requirements).
        dereference: false,
        verbatimSymlinks: true,
        filter: (source) => {
          try {
            return !lstatSync(source).isSymbolicLink();
          } catch {
            return false;
          }
        },
      }).catch(() => undefined);
      // A missing vendored/ directory is tolerated; materialization verifies
      // each manifest entry against real files and reports gaps.
    }
    return { snapshot, head, vendored: vendoredManifest, vendoredWarning };
  });
}

export async function pushRemotePreset(
  options: GitPushOptions,
  snapshot: PresetSnapshot,
  vendored?: {
    manifest: VendoredManifest;
    sourceDirs: Map<string, string>;
    preserved?: Map<string, Set<string>>;
  },
): Promise<{
  pushed: boolean;
  head: string;
  changedFiles: string[];
  vendoredErrors: string[];
}> {
  const branch = validateBranch(options.branch);
  const authorName = options.authorName.trim();
  const authorEmail = options.authorEmail.trim();
  const message = options.message.trim();
  if (authorName === "" || /[\r\n]/.test(authorName)) {
    throw new Error("Git author name must be a single non-empty line.");
  }
  if (authorEmail === "" || /[\r\n]/.test(authorEmail)) {
    throw new Error("Git author email must be a single non-empty line.");
  }
  if (message === "" || /[\r\n]/.test(message)) {
    throw new Error("Commit message must be a single non-empty line.");
  }

  return withClone(options, async (repoDir) => {
    const [existing, existingHead, existingVendored] = await Promise.all([
      readExistingPreset(repoDir),
      runGit(["rev-parse", "HEAD"], { ...options, cwd: repoDir }),
      readVendoredManifest(repoDir).catch(() => null),
    ]);
    const vendoredManifest = vendored?.manifest ?? {
      schemaVersion: 1 as const,
      collections: [],
    };
    if (
      existing !== null &&
      samePresetConfiguration(existing, snapshot) &&
      vendored !== undefined &&
      existingVendored !== null &&
      sameVendoredManifest(existingVendored, vendoredManifest)
    ) {
      return { pushed: false, head: existingHead, changedFiles: [], vendoredErrors: [] };
    }

    await writePresetSnapshot(repoDir, snapshot);
    await writeVendoredManifest(repoDir, vendoredManifest);
    const vendoredErrors: string[] = [];
    if (vendored !== undefined) {
      const exported = await exportVendoredToRepo({
        repoDir,
        manifest: vendoredManifest,
        sourceDirs: vendored.sourceDirs,
        preserved: vendored.preserved,
      });
      vendoredErrors.push(...exported.errors);
    } else {
      await rm(join(repoDir, VENDORED_REPO_DIR), {
        recursive: true,
        force: true,
      });
    }
    const status = await runGit(
      ["status", "--porcelain=v1", "--", "preset", VENDORED_REPO_DIR],
      { ...options, cwd: repoDir },
    );
    const changedFiles = status
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (changedFiles.length === 0) {
      return {
        pushed: false,
        head: existingHead,
        changedFiles,
        vendoredErrors,
      };
    }

    await runGit(["add", "--", ...MANAGED_PRESET_FILES, VENDORED_REPO_DIR], {
      ...options,
      cwd: repoDir,
    });
    await runGit(
      [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "--quiet",
        "-m",
        message,
      ],
      { ...options, cwd: repoDir },
    );
    await runGit(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], {
      ...options,
      cwd: repoDir,
    });
    return {
      pushed: true,
      head: await runGit(["rev-parse", "HEAD"], { ...options, cwd: repoDir }),
      changedFiles,
      vendoredErrors,
    };
  });
}
