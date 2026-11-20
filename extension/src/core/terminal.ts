export const TERMINAL_ALLOWLIST = ["git", "cargo", "npm", "npx", "node", "tsc", "vitest", "playwright", "pytest", "dotnet", "yarn", "pnpm"];
const MAX_COMMAND = 300;

/** First word, without folders or a .exe/.cmd/.bat suffix, lower case. */
export function commandWord(line: string): string {
  const t = line.trim().replace(/^&\s+/, ""); // PowerShell call operator
  const quoted = /^(["'])(.*?)\1/.exec(t);
  const first = quoted ? (quoted[2] ?? "") : (t.split(/\s+/)[0] ?? "");
  const base = first.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** The command line to record (still to be masked), or null if not allow-listed. */
export function allowedCommand(line: string): string | null {
  const t = line.trim();
  if (!t || !TERMINAL_ALLOWLIST.includes(commandWord(t))) return null;
  return t.length > MAX_COMMAND ? t.slice(0, MAX_COMMAND) : t;
}
