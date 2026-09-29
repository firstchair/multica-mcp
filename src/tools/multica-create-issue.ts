import { z } from "zod";
import {
  buildUnknownAssigneeMessage,
  resolveAgentByName,
} from "../lib/agents.js";
import {
  buildUnknownProjectMessage,
  resolveProject,
} from "../lib/projects.js";
import { runMulticaJson, runMulticaRaw } from "../lib/multica-cli.js";
import type { Issue } from "../lib/types.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

let cachedAppUrl: string | undefined;

async function resolveAppUrl(): Promise<string> {
  if (process.env.MULTICA_APP_URL) return process.env.MULTICA_APP_URL;
  if (cachedAppUrl !== undefined) return cachedAppUrl;
  try {
    const out = await runMulticaRaw(["config", "show"]);
    const match = out.match(/app[_-]?url\s*[:=]\s*"?([^\s"]+)"?/i);
    if (match) {
      cachedAppUrl = match[1];
      return cachedAppUrl;
    }
  } catch {
    // fall through
  }
  cachedAppUrl = "";
  return "";
}

export const multicaCreateIssueSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  priority: z.enum(PRIORITIES).optional().default("medium"),
  status: z.string().optional(),
  parent_issue_id: z.string().optional(),
  cwd: z.string().optional(),
});

export type MulticaCreateIssueInput = z.infer<typeof multicaCreateIssueSchema>;

function withWorkingDirectoryHint(
  description: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) return description;

  const prefix = [
    `**Working directory**: \`${cwd}\``,
    "",
    `Start with \`cd "${cwd}"\` before any file operation.`,
  ].join("\n");

  return description ? `${prefix}\n\n${description}` : prefix;
}

export async function multicaCreateIssue(
  input: MulticaCreateIssueInput,
) {
  if (input.assignee) {
    const agent = await resolveAgentByName(input.assignee);
    if (!agent) {
      throw new Error(await buildUnknownAssigneeMessage(input.assignee));
    }
  }

  const args = ["issue", "create", "--title", input.title];
  const description = withWorkingDirectoryHint(input.description, input.cwd);

  // --description decodes backslash escapes; stdin keeps markdown verbatim.
  if (description) {
    args.push("--description-stdin");
  }

  if (input.status) {
    args.push("--status", input.status);
  }

  if (input.assignee) {
    args.push("--assignee", input.assignee);
  }

  args.push("--priority", input.priority ?? "medium");

  if (input.parent_issue_id) {
    args.push("--parent", input.parent_issue_id);
  }

  if (input.project) {
    const project = await resolveProject(input.project);
    if (!project) {
      throw new Error(await buildUnknownProjectMessage(input.project));
    }
    args.push("--project", project.id);
  }

  const issue = await runMulticaJson<Issue>(args, {
    stdin: description,
  });
  const appUrl = await resolveAppUrl();

  return {
    id: issue.id,
    short_id: issue.identifier,
    title: issue.title,
    status: issue.status,
    assignee: input.assignee ?? null,
    url: appUrl ? `${appUrl}/issues/${issue.id}` : null,
  };
}
