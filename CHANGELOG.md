# Changelog

## 0.4.2

- Name the publisher by its bb machine name (as in `bb machine list`, for
  example "Work Venneker") instead of the Windows host name; the host name is
  only the fallback. A changed name is published even when nothing else
  changed.

## 0.4.1

- Install plugins from BB's own marketplaces (bb-official, bb-community)
  without a source confirmation. BB accepts a confirmed source only for
  third-party marketplaces and refused the install before.

## 0.4.0

- Treat a skill as one unit: when any file of a skill changed on both sides,
  the whole skill waits for one decision, so it never ends up half old, half
  new.
- Show which side of a conflicted skill is newer and why: an explicit
  `metadata.version` first, then the skills installer's record of the same
  source (`~/.agents/.skill-lock.json`, published as
  `preset/skill-provenance.json`), and only as a marked hint the dates.
- Show the difference of a conflicted skill file by file in BB's diff viewer,
  with Keep mine, Use the other machine's version, a one-click "take the newer
  version" for skills with clear evidence, and a remembered rule per skill
  (always mine, always the preset, always the newer one).
- Record the machine that published last, so the page says "OMEN is newer"
  instead of "the preset".
- Add skill groups per machine: named, skipped groups are neither pulled here
  nor published from here, with live counts, matches and an estimate of the
  startup tokens of all skills.
- Add "Never publish these terms": a publish that would contain one stops and
  lists every place; it continues only after "Publish anyway".
- Add `bb preset skills` and `bb preset push --allow-flagged`.

## 0.3.1

- Publishing no longer erases other machines from the preset: plugins,
  marketplaces, their settings and folder files this machine does not have or
  skips stay as other machines published them. Something leaves the preset only
  when this machine had it at the last sync and removed it since.
- Never sync the `bb-cli` skill, which bb installs on every machine itself.
- A plugin installed here from a local folder is no longer offered for
  installation from the preset.
- Load the app once before the UI tests so a cold start under a parallel run
  cannot exceed a test timeout.

## 0.3.0

- Decide every setting and file three-way against the last sync: changes made
  only in the preset are applied, changes made only on this machine are kept,
  and changes on both sides are shown as conflicts with Keep mine or Use preset.
- Keep machine settings on each machine: server URL, machine access and Git
  credential use always stay local; provider order, default provider, streamer
  mode, idle session timeout and path-like plugin settings stay local unless
  opted in. Publishing never overwrites another machine's values for them.
- Merge BB preferences into the current settings instead of sending a partial
  object, which BB rejects for missing machine keys.
- Apply exclude patterns on pull as well as on publish, and always leave
  `~/.claude/skills/synced`, which the Claude app manages, alone.
- Never write through a symbolic link inside or above a synced folder.
- Back up every pull into its own folder and add `bb preset restore` and Undo
  this pull to undo the most recent pull.
- Refuse a pull whose plan differs from the reviewed preview (`--plan`), read
  the preset once per pull, and verify all file payloads before writing any.
- Apply selected changes only (`--only`, checkboxes on the page).
- Fix pruning of empty folders in vendored plugin copies.
- Folders and local-folder plugins are now opt-in, and the default conflict
  mode keeps your file.
- Redesign the Preset Sync page: a plain status line, a What this machine syncs
  panel with switches, a grouped review with checkboxes and conflict decisions,
  and a publish panel. The sidebar indicator also counts conflicts.

## 0.2.2

- Restore `plugin@marketplace` entries through BB's catalog API instead of
  treating them as machine-local package paths.
- Confirm the resolved source from the catalog install plan before installing
  third-party marketplace plugins.

## 0.2.1

- Show directional `↓ remote` and `↑ local` change counts in the BB sidebar.
- List the exact pull and push changes with explicit actions on the Preset Sync page.
- Add a configurable background comparison interval from one to sixty minutes,
  including an Off option.
- Keep the background indicator silent while the preset is fully synchronized.

## 0.2.0

- Publish a generic configuration with no user-specific repository default.
- Add a dedicated Preset Sync page to the BB sidebar.
- Explain first-time setup in the UI and CLI.
- Allow `push --fresh` to initialize an existing Git repository that has no
  preset files yet.
- Add frontend registration coverage and public-release documentation.

## 0.1.3

- Harden Git input validation, secret filtering, path filtering, and preset
  filesystem handling.
