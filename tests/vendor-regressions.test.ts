import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeVendoredFiles, walkVendoredSource } from "../lib/vendor";

const cleanup: string[] = [];
async function dir(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "vendor-regression-"));
  cleanup.push(created);
  return created;
}
async function put(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, ...rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("materializeVendoredFiles regressions", () => {
  it("does not write through a symbolic link in a parent folder", async () => {
    const source = await dir();
    const target = await dir();
    const outside = await dir();
    await put(source, "linked/x.md", "remote");
    await symlink(outside, join(target, "linked"), "junction");
    const walk = await walkVendoredSource(source, { maxFileBytes: 1024, maxBytes: 1024 * 1024 });

    const result = await materializeVendoredFiles({
      sourceDir: source,
      entries: walk.entries,
      targetDir: target,
      conflict: "overwrite",
      pruneExtras: false,
    });

    expect(existsSync(join(outside, "x.md"))).toBe(false);
    expect(result.skipped.join("\n")).toMatch(/symbolic link/);
  });

  it("removes folders that pruning left empty", async () => {
    const source = await dir();
    const target = await dir();
    const trash = await dir();
    await put(source, "keep.md", "keep");
    await put(target, "keep.md", "keep");
    await put(target, "old/deeper/gone.md", "gone");
    const walk = await walkVendoredSource(source, { maxFileBytes: 1024, maxBytes: 1024 * 1024 });

    await expect(
      materializeVendoredFiles({
        sourceDir: source,
        entries: walk.entries,
        targetDir: target,
        conflict: "overwrite",
        pruneExtras: true,
        backupRoot: trash,
      }),
    ).resolves.toEqual(expect.objectContaining({ errors: [] }));
    expect(existsSync(join(target, "old"))).toBe(false);
    expect(existsSync(join(trash, "old", "deeper", "gone.md"))).toBe(true);
  });
});

describe("plan wording", () => {
  it("names empty and unset values instead of printing nothing", async () => {
    const { describeValue } = await import("../lib/preset");
    expect(describeValue("")).toBe("empty");
    expect(describeValue(undefined)).toBe("not set");
    expect(describeValue(false)).toBe("off");
    expect(describeValue([])).toBe("none");
    expect(describeValue({ codex: "flat" })).toBe("codex: flat");
  });
});
