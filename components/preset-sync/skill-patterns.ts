/**
 * Browser-side twin of lib/vendor.ts matchesGlob for single skill names, so
 * the group editor can preview matches without importing Node modules.
 * `*` matches within a name, `?` one character; matching ignores case.
 */
export function matchesSkillPattern(skill: string, pattern: string): boolean {
  const head = pattern.split("/")[0] ?? pattern;
  let source = "^";
  for (const char of head) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i").test(skill);
}
