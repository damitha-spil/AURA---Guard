// Words the CLI shows to people.

export const copy = {
  help: `AURA Guard

  index [--force] [--max N]   Read the vault and the repos into the index
  ask <text...> [--audience internal_dev|qa_internal|customer_support] [--limit n]
                              Search what Guard knows
  check                       Check the vault notes
  stale                       Notes whose code changed
  history <repo> <path>       Recent commits for a path
  cochange <repo> <path>      Files that change together with a path
  status                      What is in the index
  graph import <repo> <graph.json>
                              Load a graphify code graph for a repo
  graph blast <repo> <path>   Code that depends on a file (two hops)
  help                        Show this text`,
  busy: "Not indexing now:",
  busyHint: "Use --force to run anyway.",
  indexed: (added: number, updated: number, removed: number) =>
    `Notes: ${added} added, ${updated} updated, ${removed} removed.`,
  repoLine: (repo: string, commits: number, files: number) => `${repo}: ${commits} new commits, ${files} files.`,
  repoSkipped: (repo: string, why: string) => `${repo}: skipped (${why}).`,
  problemLine: (file: string, message: string) => `Problem in ${file}: ${message}`,
  vaultOk: "The vault is fine.",
  vaultProblems: (n: number) => `${n} problem(s) in the vault.`,
  noHits: "Nothing found.",
  noStale: "No stale notes.",
  noHistory: "No history found.",
  noCochange: "No co-changed files found.",
  needArgs: (cmd: string, args: string) => `Usage: ${cmd} ${args}`,
  unknownCommand: (c: string) => `Unknown command: ${c}. Try "help".`,
  badAudience: "Audience must be internal_dev, qa_internal or customer_support.",
  graphImported: (repo: string, nodes: number, edges: number) =>
    `${repo}: ${nodes} graph nodes, ${edges} edges loaded.`,
  noGraphHits: "No graph nodes found for that path. Only code files that graphify parses have nodes.",
  noIndex: "Index not built yet; run `npm run guard -- index`",
};
