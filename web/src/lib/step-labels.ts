// Friendly names for the work steps shown under a reply. "Technical details" shows the raw labels instead.

const RULES: [RegExp, string][] = [
  [/^Refused:/i, "Skipped a request that is not allowed"],
  [/^(search_notes|read_note)\b/, "Reading notes"],
  [/^list_dir\b/, "Looking through a folder"],
  [/^read_file\b/, "Reading a file"],
  [/^find_text\b/, "Searching file contents"],
  [/^git_log\b/, "Reading commit history"],
  [/^git_branches\b/, "Looking at branches"],
  [/^git_diff\b/, "Comparing changes"],
  [/^web_search\b/, "Searching the web"],
  [/^web_fetch\b/, "Reading a web page"],
  [/^list_defects\b/, "Checking defects"],
  [/^list_qa_runs\b/, "Checking QA runs"],
  [/^health\b/, "Checking system health"],
  [/^list_pulls\b/, "Checking pull requests"],
  [/^(create_followup|create_task)\b/, "Saving a follow-up or task"],
  [/^propose_note\b/, "Proposing a note for review"],
  [/^draft_defect\b/, "Recording a defect draft"],
  [/^open_(attachment|link)\b/, "Asking you to approve opening something"],
  [/^update_todos\b/, "Updating the to-do list"],
  [/^ask_user\b/, "Asking you a question"],
  [/^run_agent\b/, "Asking a specialist role"],
  [/^Searching notes, commits and files|^Searched notes, commits and files/, "Looking through the project"],
  [/^Tool set:/, "Choosing the right tools"],
  [/answered in [\d.]+ s/, "Got the model's reply"],
  [/: asking /, "Thinking"],
  [/^Asking /, "Thinking"],
  [/^Checked citations/, "Checking the sources"],
];

export function friendlyStep(label: string): string {
  for (const [re, text] of RULES) if (re.test(label)) return text;
  return label;
}

export const stepText = (label: string, technical: boolean): string => (technical ? label : friendlyStep(label));
