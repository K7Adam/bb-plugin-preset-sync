import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 400 * 1024;

function looksBinary(buffer: Buffer | null): boolean {
  return buffer !== null && buffer.subarray(0, 8000).includes(0);
}

async function gitDiff(before: string, after: string, ignoreCr: boolean): Promise<string> {
  const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3"];
  if (ignoreCr) args.push("--ignore-cr-at-eol");
  try {
    await execFileAsync("git", [...args, "--", before, after], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return "";
  } catch (cause) {
    // git diff --no-index exits with 1 when the files differ.
    const failure = cause as { code?: number; stdout?: string };
    if (failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
    throw cause;
  }
}

/** Rewrite git's temporary paths so the patch names the skill file. */
function relabel(patch: string, path: string, beforeMissing: boolean, afterMissing: boolean): string {
  const lines = patch.split("\n");
  const out: string[] = [`diff --git a/${path} b/${path}`];
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ")) out.push(beforeMissing ? "--- /dev/null" : `--- a/${path}`);
    else if (line.startsWith("+++ ")) out.push(afterMissing ? "+++ /dev/null" : `+++ b/${path}`);
    else if (/^(new|deleted) file mode /.test(line)) continue;
    else out.push(line);
  }
  return out.join("\n");
}

/**
 * Unified patch from this machine's file (a) to the preset's file (b).
 * Lines starting with "-" are only here, "+" only in the preset.
 */
export async function unifiedDiff(
  path: string,
  local: Buffer | null,
  remote: Buffer | null,
): Promise<{ patch: string; lineEndingsOnly: boolean; binary: boolean }> {
  if (looksBinary(local) || looksBinary(remote)) return { patch: "", lineEndingsOnly: false, binary: true };
  if ((local?.byteLength ?? 0) + (remote?.byteLength ?? 0) > MAX_DIFF_BYTES) {
    return { patch: "", lineEndingsOnly: false, binary: true };
  }
  const dir = await mkdtemp(join(tmpdir(), "bb-preset-diff-"));
  try {
    const before = join(dir, "local");
    const after = join(dir, "preset");
    await Promise.all([writeFile(before, local ?? ""), writeFile(after, remote ?? "")]);
    const patch = await gitDiff(before, after, true);
    if (patch === "" && local !== null && remote !== null && !local.equals(remote)) {
      return { patch: "", lineEndingsOnly: true, binary: false };
    }
    return { patch: relabel(patch, path, local === null, remote === null), lineEndingsOnly: false, binary: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
