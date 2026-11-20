import { z } from "zod";
import type { NoteMeta, NoteProblem } from "../types.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case"),
  type: z.enum(["adr", "rule", "pattern", "incident", "domain", "diary", "choice", "journey"]),
  status: z.enum(["proposed", "shadow", "active", "stale", "deprecated"]),
  audience: z
    .array(z.enum(["internal_dev", "qa_internal", "customer_support"]))
    .min(1, "audience must not be empty"),
  department: z.string().min(1).default("dev"),
  source: z.enum(["owner-answer", "commit", "pr-comment", "session", "evidence", "import"]),
  code_anchors: z
    .array(
      z.object({
        repo: z.string().min(1),
        path: z.string().min(1),
        symbol: z.string().optional(),
        verified_sha: z.string().optional(),
      }),
    )
    .optional(),
  created: date,
  reviewed: date.optional(),
  title: z.string().optional(),
});

/** Validate parsed frontmatter. Never throws. */
export function validateMeta(
  data: unknown,
  file: string,
): { meta?: NoteMeta; problems: NoteProblem[] } {
  if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) {
    return { problems: [{ file, message: "missing frontmatter" }] };
  }
  const r = schema.safeParse(data);
  if (r.success) return { meta: r.data as NoteMeta, problems: [] };
  return {
    problems: r.error.issues.map((i) => ({
      file,
      message: `${i.path.join(".") || "frontmatter"}: ${i.message}`,
    })),
  };
}
