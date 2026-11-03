import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  decideNewer,
  estimateSkillTokens,
  parseSkillHeader,
  readLocalSkillLock,
} from "../lib/skills";

describe("skill frontmatter", () => {
  it("reads the version from metadata as the specification recommends", () => {
    expect(
      parseSkillHeader('---\nname: gcp-dataflow\ndescription: Build pipelines.\nmetadata:\n  author: g\n  version: v4\n---\n# Body'),
    ).toEqual({ name: "gcp-dataflow", description: "Build pipelines.", version: "v4" });
    expect(parseSkillHeader('---\r\nname: x\r\nmetadata:\r\n  version: "0.1.0"\r\n---\r\n').version).toBe("0.1.0");
  });

  it("accepts a top-level version and folded descriptions", () => {
    expect(
      parseSkillHeader("---\nname: m\nversion: 1.1.0\ndescription: >\n  Test mobile\n  apps.\nlicense: MIT\n---"),
    ).toEqual({ name: "m", version: "1.1.0", description: "Test mobile apps." });
  });

  it("returns nothing for a file without frontmatter", () => {
    expect(parseSkillHeader("# Just text")).toEqual({});
  });
});

describe("version comparison", () => {
  it("compares the formats found in real skills", () => {
    expect(compareVersions("v2", "v1")).toBe(1);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.1.0", "1.1")).toBe(0);
    expect(compareVersions("v4", "4.0.0")).toBe(0);
    expect(compareVersions("latest", "v1")).toBeNull();
    expect(compareVersions(undefined, "v1")).toBeNull();
  });
});

describe("which side is newer", () => {
  const source = (folderHash: string, updatedAt: string) => ({
    source: "vercel-labs/agent-skills",
    folderHash,
    updatedAt,
  });

  it("trusts an explicit version first", () => {
    expect(
      decideNewer({ localVersion: "v1", remoteVersion: "v2", remoteMachine: "OMEN" }),
    ).toEqual(expect.objectContaining({ newer: "remote", evidence: "version", hint: false }));
  });

  it("uses the installer record of the same source next", () => {
    const verdict = decideNewer({
      localSource: source("aaa", "2026-09-18T14:26:22.269Z"),
      remoteSource: source("bbb", "2026-10-30T08:00:00.000Z"),
      remoteMachine: "OMEN",
    });
    expect(verdict).toEqual(expect.objectContaining({ newer: "remote", evidence: "source", hint: false }));
    expect(verdict.reason).toContain("OMEN");
  });

  it("calls an edit of the same installed revision a local change", () => {
    expect(
      decideNewer({ localSource: source("aaa", "x"), remoteSource: source("aaa", "x") }).newer,
    ).toBe("same");
  });

  it("falls back to dates only as a hint", () => {
    expect(
      decideNewer({
        localModifiedAt: "2026-09-18T16:26:00.000Z",
        remotePublishedAt: "2026-11-02T19:35:32.049Z",
      }),
    ).toEqual(expect.objectContaining({ newer: "remote", evidence: "date", hint: true }));
    expect(decideNewer({}).newer).toBe("unknown");
  });
});

describe("installer lock file", () => {
  it("reads source, folder hash and update time per skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lock-"));
    try {
      const file = join(dir, ".skill-lock.json");
      await writeFile(
        file,
        JSON.stringify({
          version: 3,
          skills: {
            deslop: { source: "a/b", skillFolderHash: "h1", updatedAt: "2026-09-18T14:26:22.269Z" },
            broken: { source: 1 },
          },
        }),
      );
      expect(await readLocalSkillLock(file)).toEqual({
        deslop: { source: "a/b", folderHash: "h1", updatedAt: "2026-09-18T14:26:22.269Z" },
      });
      expect(await readLocalSkillLock(join(dir, "missing.json"))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("context cost", () => {
  it("estimates the startup tokens of a skill from name and description", () => {
    expect(estimateSkillTokens({ name: "x", description: "a".repeat(400) })).toBe(111);
    expect(estimateSkillTokens({})).toBe(20);
  });
});
