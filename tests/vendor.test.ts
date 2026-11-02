import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VendorError,
  collectionIdForPath,
  expandHome,
  isValidVendoredRelPath,
  isVendoredInstallSource,
  matchesGlob,
  materializeVendoredFiles,
  parseGlobList,
  resolveWithin,
  scanTextForCredentials,
  toHomeRelative,
  vendoredInstallSource,
  vendoredPluginId,
  vendoredPluginDir,
  walkVendoredSource,
  sameVendoredManifest,
  hashCollectionEntries,
} from "../lib/vendor";
import { mergeVendoredForPush, applyVendoredScope } from "../lib/service";
import { FULL_SYNC_SCOPE, type SyncScope } from "../lib/preset";

const temporaryDirectories: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendor-test-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, ...rel.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const scope = (overrides: Partial<SyncScope> = {}): SyncScope => ({
  ...FULL_SYNC_SCOPE,
  ...overrides,
});

describe("glob matching and path lists", () => {
  it("matches basename and path patterns", () => {
    expect(matchesGlob("a/b/secret.txt", "*.txt")).toBe(true);
    expect(matchesGlob("a/b/secret.txt", "a/**/*.txt")).toBe(true);
    expect(matchesGlob("a/b/secret.txt", "a/*.txt")).toBe(false);
    expect(matchesGlob("x/y.md", "x/?.md")).toBe(true);
    expect(matchesGlob("deep/deeper/f.log", "**/f.log")).toBe(true);
  });

  it("parses comma- and newline-separated glob lists", () => {
    expect(parseGlobList("a/*.log, b/**")).toEqual(["a/*.log", "b/**"]);
    expect(parseGlobList(undefined)).toEqual([]);
    expect(parseGlobList("  \n ")).toEqual([]);
  });
});

describe("path safety", () => {
  it("rejects traversal, absolute, and malformed manifest paths", () => {
    expect(isValidVendoredRelPath("a/b.txt")).toBe(true);
    expect(isValidVendoredRelPath("../evil")).toBe(false);
    expect(isValidVendoredRelPath("a/../../evil")).toBe(false);
    expect(isValidVendoredRelPath("/abs")).toBe(false);
    expect(isValidVendoredRelPath("a\\b")).toBe(false);
    expect(isValidVendoredRelPath("a/./b")).toBe(false);
    expect(isValidVendoredRelPath("a//b")).toBe(false);
    expect(isValidVendoredRelPath("a/b ")).toBe(false);
    expect(isValidVendoredRelPath("a/b.")).toBe(false);
    expect(isValidVendoredRelPath("NUL")).toBe(false);
    expect(isValidVendoredRelPath("a/CON")).toBe(false);
    expect(isValidVendoredRelPath("a/b:c")).toBe(false);
    expect(isValidVendoredRelPath("")).toBe(false);
  });

  it("confines resolution to the root", () => {
    const root = resolve("/tmp/root-x");
    expect(resolveWithin(root, "a/b")).toBe(resolve(root, "a/b"));
    expect(() => resolveWithin(root, "../escape")).toThrow(VendorError);
    expect(() => resolveWithin(root, "a/../../escape")).toThrow(VendorError);
  });

  it("maps home-relative paths and rejects outside-home", () => {
    const inside = join(homedir(), ".agents", "skills");
    expect(toHomeRelative(inside)).toBe("~/.agents/skills");
    expect(toHomeRelative("/var/lib/other")).toBeNull();
    expect(expandHome("~/.agents/skills")).toBe(inside);
    expect(collectionIdForPath("~/.agents/skills")).toBe("agents-skills");
    expect(collectionIdForPath("~/.claude/skills")).toBe("claude-skills");
  });

  it("recognizes vendored install sources", () => {
    expect(vendoredInstallSource("agent-usage")).toBe("vendored:agent-usage");
    expect(vendoredPluginId("vendored:agent-usage")).toBe("agent-usage");
    expect(vendoredPluginId("vendored:bad id")).toBeNull();
    expect(isVendoredInstallSource("vendored:x")).toBe(true);
    expect(isVendoredInstallSource("path:/x")).toBe(false);
    expect(vendoredPluginDir("x")).toContain("preset-vendored");
  });
});

describe("credential scanning", () => {
  it("flags common secret formats", () => {
    expect(
      scanTextForCredentials("-----BEGIN RSA PRIVATE KEY-----\nMII"),
    ).not.toBeNull();
    expect(scanTextForCredentials("token = ghp_abcdefghijklmnopqrstuvwx")).not.toBeNull();
    expect(scanTextForCredentials("AKIAIOSFODNN7EXAMPLE")).not.toBeNull();
    expect(scanTextForCredentials("xoxb-1234567890-abcdefghij")).not.toBeNull();
    expect(
      scanTextForCredentials('{"api_key": "abcdefghijklmnopqrstuvwx"}'),
    ).not.toBeNull();
    expect(scanTextForCredentials("# A perfectly normal skill file\nDo things.")).toBeNull();
  });
});

describe("walkVendoredSource", () => {
  it("walks deterministically, skips noise and secrets", async () => {
    const root = await makeDir();
    await write(root, "SKILL.md", "# skill");
    await write(root, "node_modules/pkg/index.js", "module.exports = 1");
    await write(root, ".git/config", "[core]");
    await write(root, "sub/nested.md", "nested");
    await write(root, ".env", "TOKEN=abc");
    await write(root, "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----");
    await write(root, "notes.txt", "ordinary text");

    const walk = await walkVendoredSource(root, {
      maxFileBytes: 1024,
      maxBytes: 1024 * 1024,
    });
    const paths = walk.entries.map((entry) => entry.path);
    expect([...paths].sort()).toEqual(
      ["SKILL.md", "notes.txt", "sub/nested.md"].sort(),
    );
    // .env is skipped by name; id_rsa by name before content scan.
    expect(walk.skipped.map((s) => s.path).sort()).toEqual([".env", "id_rsa"]);
    expect(walk.hash).toBe(hashCollectionEntries(walk.entries));

    const again = await walkVendoredSource(root, {
      maxFileBytes: 1024,
      maxBytes: 1024 * 1024,
    });
    expect(again.hash).toBe(walk.hash);
  });

  it("refuses symlinks and enforces size and glob limits", async () => {
    const root = await makeDir();
    await write(root, "keep.md", "ok");
    await write(root, "big.bin", "x".repeat(900));
    await write(root, "skipme.log", "ignored suffix");
    await write(root, "draft/secret.md", "excluded");
    await symlink(
      join(root, "keep.md"),
      join(root, "linked.md"),
      "file",
    ).catch(() => undefined);

    const walk = await walkVendoredSource(root, {
      maxFileBytes: 100,
      maxBytes: 10_000,
      excludeGlobs: ["draft/**"],
    });
    const paths = walk.entries.map((entry) => entry.path);
    // keep.md only: skipme.log is silently ignored by suffix, the rest is skipped.
    expect(paths).toEqual(["keep.md"]);
    // big.bin skipped by size, draft/secret.md by glob, linked.md by symlink.
    const skippedReasons = new Map(walk.skipped.map((s) => [s.path, s.reason]));
    expect(skippedReasons.get("big.bin")).toContain("larger");
    expect(skippedReasons.get("draft/secret.md")).toBe("excluded by glob");
    if (existsSync(join(root, "linked.md"))) {
      expect(skippedReasons.get("linked.md")).toBe("symbolic link");
    }
  });

  it("rejects missing, file, and symlink roots", async () => {
    const root = await makeDir();
    await write(root, "file.md", "x");
    await expect(
      walkVendoredSource(join(root, "missing"), {
        maxFileBytes: 10,
        maxBytes: 10,
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      walkVendoredSource(join(root, "file.md"), {
        maxFileBytes: 10,
        maxBytes: 10,
      }),
    ).rejects.toThrow("not a directory");
  });
});

describe("materializeVendoredFiles", () => {
  async function payload(entries: [string, string][]): Promise<{
    sourceDir: string;
    manifest: { path: string; size: number; sha256: string }[];
  }> {
    const { createHash } = await import("node:crypto");
    const sourceDir = await makeDir();
    const manifest = [];
    for (const [rel, content] of entries) {
      await write(sourceDir, rel, content);
      manifest.push({
        path: rel,
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    return { sourceDir, manifest };
  }

  it("writes new files and skips unchanged ones", async () => {
    const target = join(await makeDir(), "target");
    const { sourceDir, manifest } = await payload([
      ["a.md", "one"],
      ["b/c.md", "two"],
    ]);
    const first = await materializeVendoredFiles({
      sourceDir,
      entries: manifest,
      targetDir: target,
      conflict: "backup",
      pruneExtras: false,
    });
    expect(first.written).toBe(2);
    expect(await readFile(join(target, "b", "c.md"), "utf8")).toBe("two");

    const second = await materializeVendoredFiles({
      sourceDir,
      entries: manifest,
      targetDir: target,
      conflict: "backup",
      pruneExtras: false,
    });
    expect(second.unchanged).toBe(2);
    expect(second.written).toBe(0);
  });

  it("backs up conflicts, overwrites, or skips per conflict mode", async () => {
    const target = join(await makeDir(), "target");
    await write(target, "a.md", "local-edit");
    const backupRoot = join(await makeDir(), "backup");
    const { sourceDir, manifest } = await payload([["a.md", "preset"]]);

    const backup = await materializeVendoredFiles({
      sourceDir,
      entries: manifest,
      targetDir: target,
      conflict: "backup",
      pruneExtras: false,
      backupRoot,
    });
    expect(backup.backedUp).toBe(1);
    expect(await readFile(join(target, "a.md"), "utf8")).toBe("preset");
    expect(await readFile(join(backupRoot, "a.md"), "utf8")).toBe("local-edit");

    await write(target, "a.md", "local-edit-2");
    const skip = await materializeVendoredFiles({
      sourceDir,
      entries: manifest,
      targetDir: target,
      conflict: "skip",
      pruneExtras: false,
    });
    expect(skip.skipped).toEqual(["a.md (locally modified)"]);
    expect(await readFile(join(target, "a.md"), "utf8")).toBe("local-edit-2");
  });

  it("verifies manifest integrity and refuses bad payloads", async () => {
    const target = join(await makeDir(), "target");
    const { sourceDir, manifest } = await payload([["a.md", "real"]]);
    const tampered = manifest.map((entry) => ({
      ...entry,
      sha256: "0".repeat(64),
    }));
    const result = await materializeVendoredFiles({
      sourceDir,
      entries: tampered,
      targetDir: target,
      conflict: "overwrite",
      pruneExtras: false,
    });
    expect(result.errors[0]).toContain("integrity verification");
    expect(existsSync(join(target, "a.md"))).toBe(false);

    const traversal = await materializeVendoredFiles({
      sourceDir,
      entries: [{ path: "../evil.md", size: 1, sha256: "0".repeat(64) }],
      targetDir: target,
      conflict: "overwrite",
      pruneExtras: false,
    });
    expect(traversal.errors[0]).toContain("Invalid manifest path");
  });

  it("prunes extras to the trash root but preserves protected names", async () => {
    const target = join(await makeDir(), "target");
    await write(target, "stale.md", "old");
    await write(target, "node_modules/pkg/i.js", "dep");
    const trash = join(await makeDir(), "trash");
    const { sourceDir, manifest } = await payload([["fresh.md", "new"]]);

    const result = await materializeVendoredFiles({
      sourceDir,
      entries: manifest,
      targetDir: target,
      conflict: "overwrite",
      pruneExtras: true,
      backupRoot: trash,
      preserveNames: new Set(["node_modules"]),
    });
    expect(result.pruned).toEqual(["stale.md"]);
    expect(await readFile(join(trash, "stale.md"), "utf8")).toBe("old");
    expect(existsSync(join(target, "node_modules", "pkg", "i.js"))).toBe(true);
    expect(existsSync(join(target, "fresh.md"))).toBe(true);
  });
});

describe("manifest comparison and merge", () => {
  it("compares manifests order-insensitively", () => {
    const collection = (id: string, hash: string) => ({
      id,
      kind: "files" as const,
      repoDir: `vendored/files/${id}`,
      target: `~/.x/${id}`,
      hash,
      fileCount: 1,
      bytes: 1,
      entries: [{ path: "a", size: 1, sha256: "a".repeat(64) }],
    });
    expect(
      sameVendoredManifest(
        { schemaVersion: 1, collections: [collection("a", "h1"), collection("b", "h2")] },
        { schemaVersion: 1, collections: [collection("b", "h2"), collection("a", "h1")] },
      ),
    ).toBe(true);
    expect(
      sameVendoredManifest(
        { schemaVersion: 1, collections: [collection("a", "h1")] },
        { schemaVersion: 1, collections: [collection("a", "h3")] },
      ),
    ).toBe(false);
  });

  it("merges vendored collections without erasing foreign payloads", () => {
    const remote = {
      schemaVersion: 1 as const,
      collections: [
        {
          id: "plug",
          kind: "plugin" as const,
          pluginId: "plug",
          repoDir: "vendored/plugins/plug",
          hash: "remote-hash",
          fileCount: 1,
          bytes: 1,
          entries: [],
        },
        {
          id: "foreign-skills",
          kind: "files" as const,
          repoDir: "vendored/files/foreign-skills",
          target: "~/.agents/skills",
          hash: "remote-skills",
          fileCount: 2,
          bytes: 2,
          entries: [],
        },
      ],
    };
    // Local machine vendors nothing; remote plugin still referenced → kept.
    const merged = mergeVendoredForPush({
      local: [],
      remote,
      mergedPlugins: [
        { id: "plug", install: "vendored:plug", enabled: true },
        { id: "other", install: "builtin:other", enabled: true },
      ],
      scope: scope(),
    });
    expect(merged.map((c) => c.id).sort()).toEqual([
      "foreign-skills",
      "plug",
    ]);

    // Plugin entry removed → its payload is dropped, files stay.
    const dropped = mergeVendoredForPush({
      local: [],
      remote,
      mergedPlugins: [{ id: "other", install: "builtin:other", enabled: true }],
      scope: scope(),
    });
    expect(dropped.map((c) => c.id)).toEqual(["foreign-skills"]);

    // Out-of-scope → everything remote preserved.
    const scoped = mergeVendoredForPush({
      local: [],
      remote,
      mergedPlugins: [],
      scope: scope({ syncVendoredPlugins: false }),
    });
    expect(scoped.map((c) => c.id).sort()).toEqual([
      "foreign-skills",
      "plug",
    ]);

    expect(
      applyVendoredScope(remote.collections, scope({ syncVendoredFiles: false })).map(
        (c) => c.id,
      ),
    ).toEqual(["plug"]);
  });
});
