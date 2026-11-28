/** Chat tools: the engine runs these through the chat's ask route. */
export const TOOL_COMMANDS = [
  { name: "web", usage: "/web <query>", help: "Search the web" },
  { name: "fetch", usage: "/fetch <url>", help: "Get the text of a web page" },
  { name: "browse", usage: "/browse <url>", help: "Open a page in a browser" },
  { name: "ls", usage: "/ls <repoId>/path", help: "List a folder" },
  { name: "read", usage: "/read <repoId>/path", help: "Read a file" },
  { name: "find", usage: "/find <text>", help: "Find text in files" },
  { name: "system", usage: "/system", help: "Show details of this computer" },
  { name: "processes", usage: "/processes", help: "Show running programs" },
  { name: "time", usage: "/time", help: "Show the date and time" },
  { name: "n8n", usage: "/n8n status|workflows|executions|trigger <path>", help: "Inspect or trigger n8n workflows" },
  { name: "create", usage: "/create agent|tool|skill <description>", help: "Let REO create an agent, composite tool, or skill" },
];

export const SLASH_MENU = [
  ...TOOL_COMMANDS,
  { name: "index", usage: "/index", help: "Read the notes and repos again" },
  { name: "status", usage: "/status", help: "Show index counts and last commits" },
];

/** Used when the server's command list cannot be loaded, so /index and /status still work. */
export const BASIC_COMMANDS = ["index", "status"];

export const slashName = (line: string): string | null =>
  /^\/([a-z0-9]+)(?=\s|$)/i.exec(line.trim())?.[1].toLowerCase() ?? null;

/** True when the line belongs to /api/command. Everything else goes to the chat's ask route. */
export function isRunnerCommand(line: string, runnerNames: readonly string[]): boolean {
  const name = slashName(line);
  if (!name || TOOL_COMMANDS.some((c) => c.name === name)) return false;
  // "/qa status|plan|..." and a bare "/qa" are commands; "/qa <request>" goes to the QA agent.
  if (name === "qa") return /^\/qa(\s*$|\s+(status|plan|generate|check|run)\b)/i.test(line.trim());
  return runnerNames.includes(name) || BASIC_COMMANDS.includes(name);
}
