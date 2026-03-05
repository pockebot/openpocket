import { SessionManager } from "@mariozechner/pi-coding-agent";
import { z } from "zod";

export const TASK_JOURNAL_SNAPSHOT_CUSTOM_TYPE = "openpocket.journal.snapshot";

const TodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "done"]),
  tags: z.array(z.string()).optional(),
});

const EvidenceItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  fields: z.record(z.unknown()).optional(),
  source: z.record(z.unknown()).optional(),
  confidence: z.number().optional(),
});

const ArtifactItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  value: z.string(),
  description: z.string().optional(),
});

export const TaskJournalSnapshotSchema = z.object({
  version: z.literal(1),
  task: z.string(),
  runId: z.string(),
  updatedAt: z.string(),
  todos: z.array(TodoItemSchema),
  evidence: z.array(EvidenceItemSchema),
  artifacts: z.array(ArtifactItemSchema),
  progress: z.object({
    milestones: z.array(z.string()),
    blockers: z.array(z.string()),
  }),
  completion: z.object({
    status: z.enum(["unknown", "in_progress", "ready_to_finish"]),
    missing: z.array(z.string()).optional(),
  }),
});

export type TaskJournalSnapshot = z.infer<typeof TaskJournalSnapshotSchema>;

export function appendTaskJournalSnapshot(sessionPath: string, snapshot: TaskJournalSnapshot): void {
  const manager = SessionManager.open(sessionPath);
  manager.appendCustomEntry(TASK_JOURNAL_SNAPSHOT_CUSTOM_TYPE, snapshot);
}

export function readLatestTaskJournalSnapshot(sessionPath: string): TaskJournalSnapshot | null {
  try {
    const manager = SessionManager.open(sessionPath);
    const entries = manager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "custom") {
        continue;
      }
      if (entry.customType !== TASK_JOURNAL_SNAPSHOT_CUSTOM_TYPE) {
        continue;
      }
      const parsed = TaskJournalSnapshotSchema.safeParse(entry.data);
      return parsed.success ? parsed.data : null;
    }
    return null;
  } catch {
    return null;
  }
}

