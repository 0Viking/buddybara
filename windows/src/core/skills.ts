// A skill's name as Claude Code wants it, the rules addons.rs `skill_name`
// writes it by: lowercase letters, digits and dashes, at most 64 characters.
// Settings → Skills → New skill shows it as it is typed. Tested on its own.

/** `My Notes` → `my-notes`; "" when nothing is left. */
export function skillName(raw: string): string {
  let out = "";
  for (const ch of raw.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if ("-_ .".includes(ch) && out && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "").slice(0, 64).replace(/-+$/, "");
}
