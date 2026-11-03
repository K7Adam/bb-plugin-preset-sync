import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PublishBlockedError } from "../lib/publish-guard";
import { clearFakeRemotes, registerFakeRemote } from "./support/fake-git";
import { FAKE_REMOTE_URL, createMachine, onMachine, type FakeMachine } from "./support/fake-machine";

vi.mock("../lib/git", () => import("./support/fake-git"));

const cleanup: string[] = [];

async function machine(args: Parameters<typeof createMachine>[1] = {}): Promise<FakeMachine> {
  const created = await createMachine(createFakePluginHost as never, args);
  cleanup.push(created.home);
  return created;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, ...rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function text(root: string, rel: string): Promise<string | null> {
  return readFile(join(root, ...rel.split("/")), "utf8").catch(() => null);
}

const skill = (name: string, body: string, version?: string) =>
  `---\nname: ${name}\ndescription: ${name} helps with ${body}.\n${version === undefined ? "" : `metadata:\n  version: "${version}"\n`}---\n${body}\n`;

async function lock(home: string, skills: Record<string, { hash: string; updatedAt: string }>) {
  await put(
    home,
    ".agents/.skill-lock.json",
    JSON.stringify({
      version: 3,
      skills: Object.fromEntries(
        Object.entries(skills).map(([name, entry]) => [
          name,
          { source: "acme/skills", sourceType: "github", skillFolderHash: entry.hash, updatedAt: entry.updatedAt },
        ]),
      ),
    }),
  );
}

const push = (source: FakeMachine, allowFlagged?: boolean) =>
  onMachine(source, () => source.service.push({ fresh: true, allowFlagged }));

beforeEach(async () => {
  const remote = await mkdtemp(join(tmpdir(), "preset-remote-"));
  cleanup.push(remote);
  registerFakeRemote(FAKE_REMOTE_URL, remote);
});

afterEach(async () => {
  clearFakeRemotes();
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

describe("skills as units", () => {
  it("holds back every file of a conflicted skill until one decision", async () => {
    const omen = await machine();
    await put(omen.home, "skills/s/SKILL.md", skill("s", "one"));
    await put(omen.home, "skills/s/ref.md", "r1");
    await push(omen);
    const work = await machine();
    await onMachine(work, () => work.service.pullAndApply());

    await put(omen.home, "skills/s/SKILL.md", skill("s", "two"));
    await put(omen.home, "skills/s/ref.md", "r2");
    await push(omen);
    await put(work.home, "skills/s/ref.md", "mine");
    const plan = await onMachine(work, () => work.service.preview());

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        id: "conflict:skill:skills:s",
        target: "~/skills/s",
        skill: expect.objectContaining({
          paths: expect.arrayContaining(["s/ref.md", "s/SKILL.md"]),
        }),
      }),
    ]);
    expect(plan.remoteMachine).toBe(hostname());
    await onMachine(work, () => work.service.pullAndApply());
    expect(await text(work.home, "skills/s/SKILL.md")).toBe(skill("s", "one"));

    await onMachine(work, () =>
      work.service.pullAndApply({ resolutions: { "conflict:skill:skills:s": "take-remote" } }),
    );
    expect(await text(work.home, "skills/s/SKILL.md")).toBe(skill("s", "two"));
    expect(await text(work.home, "skills/s/ref.md")).toBe("r2");
  });
});

describe("which machine has the newer skill", () => {
  it("marks the preset newer when it carries a higher version", async () => {
    const omen = await machine();
    await put(omen.home, "skills/x/SKILL.md", skill("x", "new", "1.0.0"));
    await push(omen);
    const work = await machine();
    await put(work.home, "skills/x/SKILL.md", skill("x", "old", "0.9.0"));

    const plan = await onMachine(work, () => work.service.preview());

    expect(plan.conflicts[0]?.skill).toEqual(
      expect.objectContaining({
        localVersion: "0.9.0",
        remoteVersion: "1.0.0",
        newer: "remote",
        evidence: "version",
        hint: false,
      }),
    );
  });

  it("uses the installer record when skills carry no version", async () => {
    const omen = await machine();
    await put(omen.home, "skills/deslop/SKILL.md", skill("deslop", "newer text"));
    await lock(omen.home, { deslop: { hash: "h2", updatedAt: "2026-10-30T08:00:00.000Z" } });
    await push(omen);
    const work = await machine();
    await put(work.home, "skills/deslop/SKILL.md", skill("deslop", "older text"));
    await lock(work.home, { deslop: { hash: "h1", updatedAt: "2026-09-18T14:26:22.269Z" } });

    const plan = await onMachine(work, () => work.service.preview());

    expect(plan.conflicts[0]?.skill).toEqual(
      expect.objectContaining({ newer: "remote", evidence: "source", hint: false }),
    );
    expect(plan.conflicts[0]?.skill?.reason).toContain("acme/skills");
  });

  it("applies a remembered 'newer' rule only on strong evidence", async () => {
    const omen = await machine();
    await put(omen.home, "skills/x/SKILL.md", skill("x", "new", "2.0.0"));
    await put(omen.home, "skills/y/SKILL.md", skill("y", "theirs"));
    await push(omen);
    const work = await machine();
    await put(work.home, "skills/x/SKILL.md", skill("x", "old", "1.0.0"));
    await put(work.home, "skills/y/SKILL.md", skill("y", "mine"));
    await onMachine(work, async () => {
      await work.service.setSkillRule("skills", "x", "newer");
      await work.service.setSkillRule("skills", "y", "newer");
    });

    const plan = await onMachine(work, () => work.service.preview());
    await onMachine(work, () => work.service.pullAndApply());

    expect(plan.conflicts.find((entry) => entry.skill?.skill === "x")?.skill?.rule).toBe("newer");
    expect(await text(work.home, "skills/x/SKILL.md")).toBe(skill("x", "new", "2.0.0"));
    expect(await text(work.home, "skills/y/SKILL.md")).toBe(skill("y", "mine"));
  });
});

describe("skill groups", () => {
  it("skips a group here, keeps it in the preset and reports it in the overview", async () => {
    const omen = await machine();
    await put(omen.home, "skills/android-cli/SKILL.md", skill("android-cli", "android"));
    await put(omen.home, "skills/keep/SKILL.md", skill("keep", "general"));
    await push(omen);
    const work = await machine();
    await onMachine(work, () =>
      work.service.saveGroups([{ id: "android", name: "Android", patterns: ["android-*"], skip: true }]),
    );

    const overview = await onMachine(work, () => work.service.skillsOverview());
    await onMachine(work, () => work.service.pullAndApply());
    await put(work.home, "skills/own/SKILL.md", skill("own", "work"));
    await push(work);
    const third = await machine();
    const thirdPlan = await onMachine(third, () => third.service.preview());

    expect(overview.folders[0]?.skills.find((row) => row.name === "android-cli")).toEqual(
      expect.objectContaining({ status: "skipped", group: "Android", inPreset: true, here: false }),
    );
    expect(overview.folders[0]?.counts).toEqual({ here: 0, afterPull: 1, inPreset: 2, skipped: 1 });
    expect(overview.folders[0]?.tokensAfterPull).toBeGreaterThan(0);
    expect(await text(work.home, "skills/android-cli/SKILL.md")).toBeNull();
    expect(await text(work.home, "skills/keep/SKILL.md")).not.toBeNull();
    expect(thirdPlan.changes).toContainEqual(
      expect.objectContaining({ id: "files:skills", summary: "Sync ~/skills: 3 new files" }),
    );
  });
});

describe("publish guard", () => {
  it("blocks a publish that contains a blocked term until it is allowed", async () => {
    const work = await machine({ settings: { publishBlockTerms: "venneker, vieh-venneker.de" } });
    await put(work.home, "skills/website/SKILL.md", skill("website", "the venneker website"));

    const check = await onMachine(work, () => work.service.publishCheck());
    await expect(push(work)).rejects.toBeInstanceOf(PublishBlockedError);
    await push(work, true);
    const other = await machine();
    const plan = await onMachine(other, () => other.service.preview());

    expect(check.hits).toEqual([{ where: "~/skills/website/SKILL.md", term: "venneker" }]);
    expect(plan.changes.map((change) => change.id)).toContain("files:skills");
  });
});

describe("conflict detail", () => {
  it("shows the difference of a conflicted skill as a patch", async () => {
    const omen = await machine();
    await put(omen.home, "skills/s/SKILL.md", skill("s", "remote line"));
    await push(omen);
    const work = await machine();
    await put(work.home, "skills/s/SKILL.md", skill("s", "local line"));

    const detail = await onMachine(work, () => work.service.conflictDetail("conflict:skill:skills:s"));

    expect(detail.files).toHaveLength(1);
    expect(detail.files[0]).toEqual(expect.objectContaining({ path: "s/SKILL.md", change: "differs", binary: false }));
    expect(detail.files[0]?.patch).toContain("-local line");
    expect(detail.files[0]?.patch).toContain("+remote line");
    expect(detail.files[0]?.patch).toContain("+++ b/skills/s/SKILL.md");
  });
});

describe("publishing machine name", () => {
  it("names the publisher by its bb machine name", async () => {
    const work = await machine({ state: { machineName: "Work Venneker" } });
    await put(work.home, "skills/a/SKILL.md", skill("a", "work"));
    await push(work);
    const omen = await machine();

    const plan = await onMachine(omen, () => omen.service.preview());

    expect(plan.remoteMachine).toBe("Work Venneker");
  });

  it("falls back to the host name when bb has no machine name", async () => {
    const work = await machine();
    await put(work.home, "skills/a/SKILL.md", skill("a", "work"));
    await push(work);
    const omen = await machine();

    expect((await onMachine(omen, () => omen.service.preview())).remoteMachine).toBe(hostname());
  });
});
