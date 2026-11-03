# BB Preset Sync

Preset Sync keeps portable BB plugins and settings aligned across computers
through a Git repository. It adds a **Preset Sync** page to the BB sidebar, a
section under **Settings → Plugins → Preset Sync**, and the `bb preset` command.

## Install

From the y5k marketplace:

```bash
bb marketplace add git:https://github.com/imyeskela/y5k-bb-marketplace.git@main
bb plugin install preset-sync@y5k --yes
```

Or install the tagged release directly:

```bash
bb plugin install git:https://github.com/imyeskela/bb-plugin-preset-sync.git@v0.2.2 --yes
```

## First setup

1. Create a Git repository for the preset. For a private GitHub repository,
   initialize it with a README so that the `main` branch exists.
2. Set **Preset repository** under **Settings → Plugins → Preset Sync**, or run:

   ```bash
   bb plugin config preset-sync set repositoryUrl https://github.com/OWNER/bb-preset.git
   ```

3. Make sure Git can authenticate. For GitHub, the usual setup is:

   ```bash
   gh auth login
   gh auth setup-git
   ```

   Alternatively, store a PAT in the secret **GitHub token** plugin setting.
   Secret settings are kept out of the frontend and are never captured.

4. Capture this computer and initialize or update the preset:

   ```bash
   bb preset push --fresh
   ```

On another computer, install the plugin, configure the same repository, open
**Preset Sync** in the sidebar and choose **Review updates**. Every change is
listed by area with a checkbox; untick what you do not want, decide conflicts,
then apply. From the command line:

```bash
bb preset diff
bb preset pull --yes --plan <fingerprint printed by diff>
```

`pull` without `--yes` only prints a preview and changes nothing. With
`--plan` the pull is refused when the preset or this machine changed after the
preview. `--only <id,id>` applies selected changes (ids are printed by `diff`).

The sidebar indicator stays hidden while everything matches. Otherwise it shows
`↓` for updates from the preset, `↑` for local changes to publish and `≠` for
conflicts that need a decision.

Background comparisons run every five minutes by default. Change
**Background check interval** under **Settings → Plugins → Preset Sync** to
`Off`, 1, 5, 10, 15, 30, or 60 minutes. A background check never pulls or
pushes automatically.

## How a pull decides

Preset Sync remembers the values and file hashes of the last sync on each
machine and compares three versions: the last sync, this machine and the
preset.

| Situation | Result |
| --- | --- |
| Only the preset changed | Updated, the old file or value is backed up |
| Only this machine changed | Kept, and offered for the next publish |
| Both changed | Kept, shown as a conflict: **Keep mine** or **Use preset** |
| Missing here, present in the preset | Added |
| Missing in the preset | Left alone, nothing is ever deleted |

Every pull that changes something writes a backup to
`~/.bb/preset-vendored/backup/<run>/`. `bb preset restore --yes` (or **Undo this
pull** on the page) puts back the replaced files and settings of the most recent
pull and removes files it added. Anything edited after the pull is left as it
is. Plugins installed by the pull stay installed.

## What stays on each machine

Some settings describe the machine itself and never travel: `machineServerUrl`,
`machineGitCredentialsEnabled`, `defaultMachineAccess`,
`onboardingCompletedAt`, and the experiments `performanceDiagnostics` and
`serverMove`.

Others stay local by default because machines usually differ:
`providerOrder`, `defaultProviderId`, `streamerMode`,
`idleProviderSessionTimeoutMinutes`, and plugin settings whose key ends in
`Command`, `Path`, `Dir`, `Directory`, `Home`, `Folder`, `Executable` or
`Binary`. List them in **Also sync these machine settings** or **Also sync these
plugin paths or commands** to sync them anyway.

Publishing never overwrites another machine's values for settings this machine
does not sync.

Publishing also never removes what other machines contributed: plugins,
marketplaces and folder files this machine does not have, skips or excludes
stay in the preset. Something leaves the preset only when this machine had it at
the last sync and removed it since. The `bb-cli` skill, which bb installs on
every machine, is never synced.

## Sync scope

The **What this machine syncs** panel on the Preset Sync page switches areas on
or off for this machine. The same keys are available under **Settings → Plugins
→ Preset Sync** and via `bb plugin config preset-sync set <key> <value>`:

| Setting | Default | Effect |
| --- | --- | --- |
| `syncPlugins` | `true` | Install plugins and match enabled or disabled |
| `includePluginSettings` | `true` | Non-secret plugin settings |
| `syncGeneralSettings` | `true` | BB preferences (see above for what stays local) |
| `syncExperiments` | `true` | Experiment flags |
| `syncKeybindings` | `true` | Keyboard shortcut overrides |
| `syncAppearance` | `true` | Theme and favicon color |
| `syncMarketplaces` | `true` | Third-party marketplaces |
| `syncVendoredFiles` | `false` | Folders listed in `vendoredPaths` |
| `vendoredPaths` | `""` | One folder per line inside the home folder, for example `~/.agents/skills` |
| `vendorExcludeGlobs` | `""` | Patterns skipped in both directions, for example `private/**` |
| `vendorConflictMode` | `skip` | `skip` keeps your file on a conflict; `backup` uses the preset version |
| `syncVendoredPlugins` | `false` | Copy plugins installed from a local folder into the preset |
| `excludedPlugins` | `""` | Plugin IDs left completely unmanaged |
| `excludedSettingKeys` | `""` | BB preferences kept on this machine |
| `syncedSettingKeys` | `""` | Machine settings synced anyway |
| `excludedPluginSettingKeys` | `""` | `pluginId.key` pairs kept on this machine |
| `syncedPluginSettingKeys` | `""` | Path-like `pluginId.key` pairs synced anyway |

Folders never follow symbolic links, neither when publishing nor when pulling;
a linked folder inside a synced folder is skipped, and a synced folder that is
itself a link is skipped as a whole. `~/.claude/skills/synced` belongs to the
Claude app and is always left alone.

## Skills

A synced folder of agent skills is handled skill by skill (a skill is a folder
with a `SKILL.md`, see [agentskills.io](https://agentskills.io/specification)).

**Skill groups.** The Skills panel on the Preset Sync page shows, per folder,
how many skills are here now, after the pull and in the preset, with an
estimate of the startup tokens agents spend on their names and descriptions.
Named groups such as "Android" (`android-*, compose-*`) can be skipped on this
machine: a skipped group is neither pulled here nor published from here, and
stays in the preset for other machines. Groups are stored per machine.

**Conflicts.** When a skill changed here and in the preset since the last
sync, the whole skill waits for one decision. The page shows which side is
newer and why, in this order of evidence:

1. `metadata.version` (or a top-level `version`) of both `SKILL.md` files;
2. the skills installer's record (`~/.agents/.skill-lock.json`): the same
   source with a different folder hash, the later `updatedAt` wins. Each
   machine publishes these records in `preset/skill-provenance.json`;
3. only as a marked hint: whether your copy changed after the preset was
   published.

"Show differences" opens the files in BB's diff viewer (− only in your copy,
+ only in the other machine's). Choose Keep mine or Use the other version, take
the newer version for every skill with clear evidence at once, or remember a
rule for a skill: always mine, always the preset, or always the newer one (a
date-only hint never decides on its own).

## Never publish these terms

List terms such as a company domain or a work e-mail address under **Never
publish these terms**. Before every publish, Preset Sync searches plugin
entries, settings and the files of synced folders this machine contributes. If
it finds one, nothing is pushed and the page lists every place; "Publish
anyway" (or `--allow-flagged`) continues after checking.

## Commands

```text
bb preset status
bb preset diff
bb preset capture
bb preset push [--fresh] [--message <text>] [--allow-flagged]
bb preset pull --yes [--plan <fingerprint>] [--only <id,id>]
bb preset restore --yes
bb preset skills
```

## Captured data

- installed plugins and enabled/disabled state;
- third-party marketplaces;
- BB preferences and experiment flags that are not machine-specific;
- keyboard shortcut overrides;
- selected theme and favicon color;
- non-secret plugin settings that pass additional safety checks;
- the folders you chose, without symbolic links, credential-like files or files
  that look like they contain secrets.

The plugin never captures tokens, API keys, passwords, provider credentials,
sessions, threads, history, databases, runtime state, itself, local `path:`
marketplaces, settings containing machine-local paths, or local `path:` plugins
unless **Sync plugins installed from a local folder** is on.

Applying a preset can install full-trust plugins and update BB configuration.
Only sync from a repository you control, inspect changes with `bb preset diff`,
and keep the repository private if its non-secret configuration is sensitive.

## Development

```bash
npm install --include=dev
npm run check
bb plugin install . --yes
```

The MIT-licensed source and prebuilt `dist/` artifacts are committed. BB
installs production dependencies and builds Git installations automatically;
users do not need to run `npm install` manually.
