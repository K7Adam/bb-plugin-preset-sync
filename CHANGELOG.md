# Changelog

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
