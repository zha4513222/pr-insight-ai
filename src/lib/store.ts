import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AuditEvent,
  AuditEventType,
  ConversationMessage,
  FeedbackVerdict,
  FindingFeedback,
  PersistedState,
  ReviewJob,
  ReviewJobType,
  ReviewReport
} from './types';

const DATA_DIR = process.env.PR_INSIGHT_DATA_DIR || path.join(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

let writeChain: Promise<unknown> = Promise.resolve();

const initialState: PersistedState = {
  jobs: [],
  reports: [],
  feedback: [],
  conversations: []
};

export async function createJob(input: {
  type: ReviewJobType;
  prUrl: string;
  repositoryFullName?: string | null;
  installationId?: number | null;
  action: string;
  headSha?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<ReviewJob> {
  const now = new Date().toISOString();
  const job: ReviewJob = {
    id: createId('job'),
    type: input.type,
    status: 'queued',
    prUrl: input.prUrl,
    repositoryFullName: input.repositoryFullName || null,
    installationId: input.installationId || null,
    action: input.action,
    headSha: input.headSha || null,
    payload: input.payload || {},
    attempts: 0,
    maxAttempts: input.maxAttempts || 2,
    reportId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null
  };

  await mutateState((state) => {
    state.jobs.unshift(job);
    state.jobs = state.jobs.slice(0, 500);
  });
  await appendAudit({
    type: 'job.queued',
    jobId: job.id,
    prUrl: job.prUrl,
    repositoryFullName: job.repositoryFullName,
    message: `${job.type} job queued`,
    metadata: { action: job.action, headSha: job.headSha }
  });

  return job;
}

export async function getJob(jobId: string): Promise<ReviewJob | null> {
  const state = await readState();
  return state.jobs.find((job) => job.id === jobId) || null;
}

export async function listJobs(limit = 50): Promise<ReviewJob[]> {
  const state = await readState();
  return state.jobs.slice(0, limit);
}

export async function updateJob(jobId: string, patch: Partial<ReviewJob>): Promise<ReviewJob> {
  let updated: ReviewJob | null = null;
  await mutateState((state) => {
    state.jobs = state.jobs.map((job) => {
      if (job.id !== jobId) return job;
      updated = {
        ...job,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      return updated;
    });
  });

  if (!updated) {
    throw new Error(`Job not found: ${jobId}`);
  }

  return updated;
}

export async function saveReport(report: ReviewReport): Promise<void> {
  await mutateState((state) => {
    const withoutSame = state.reports.filter((item) => item.id !== report.id);
    state.reports = [report, ...withoutSame].slice(0, 200);
  });
}

export async function getLatestReportForPr(prUrl: string): Promise<ReviewReport | null> {
  const state = await readState();
  return state.reports.find((report) => report.snapshot.metadata.url === prUrl) || null;
}

export async function getReport(reportId: string): Promise<ReviewReport | null> {
  const state = await readState();
  return state.reports.find((report) => report.id === reportId) || null;
}

export async function addFeedback(input: {
  reportId?: string | null;
  findingId?: string | null;
  prUrl: string;
  repositoryFullName?: string | null;
  actor: string;
  verdict: FeedbackVerdict;
  note: string;
  sourceCommentUrl?: string | null;
}): Promise<FindingFeedback> {
  const feedback: FindingFeedback = {
    id: createId('feedback'),
    reportId: input.reportId || null,
    findingId: input.findingId || null,
    prUrl: input.prUrl,
    repositoryFullName: input.repositoryFullName || null,
    actor: input.actor,
    verdict: input.verdict,
    note: input.note,
    sourceCommentUrl: input.sourceCommentUrl || null,
    createdAt: new Date().toISOString()
  };

  await mutateState((state) => {
    state.feedback.unshift(feedback);
    state.feedback = state.feedback.slice(0, 1000);
  });
  await appendAudit({
    type: 'feedback.recorded',
    prUrl: input.prUrl,
    repositoryFullName: input.repositoryFullName || null,
    actor: input.actor,
    message: `Feedback recorded: ${input.verdict}`,
    metadata: { findingId: input.findingId, note: input.note }
  });

  return feedback;
}

export async function appendAudit(input: {
  type: AuditEventType;
  jobId?: string;
  prUrl?: string;
  repositoryFullName?: string | null;
  actor?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<AuditEvent> {
  await ensureDataDir();
  const event: AuditEvent = {
    id: createId('audit'),
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendFile(AUDIT_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export async function addConversationMessage(input: {
  prUrl: string;
  reportId?: string | null;
  role: 'user' | 'assistant';
  intent?: string | null;
  findingId?: string | null;
  content: string;
  sourceCommentUrl?: string | null;
  actor: string;
}): Promise<ConversationMessage> {
  const message: ConversationMessage = {
    id: createId('conv'),
    prUrl: input.prUrl,
    reportId: input.reportId || null,
    role: input.role,
    intent: input.intent || null,
    findingId: input.findingId || null,
    content: input.content,
    sourceCommentUrl: input.sourceCommentUrl || null,
    actor: input.actor,
    createdAt: new Date().toISOString()
  };

  await mutateState((state) => {
    const prMessages = state.conversations.filter(m => m.prUrl === input.prUrl);
    const otherMessages = state.conversations.filter(m => m.prUrl !== input.prUrl);

    prMessages.unshift(message);

    const maxPerPr = 50;
    const trimmedPrMessages = prMessages.slice(0, maxPerPr);

    state.conversations = [...trimmedPrMessages, ...otherMessages].slice(0, 500);
  });

  return message;
}

export async function getConversationHistory(
  prUrl: string,
  limit: number = 10
): Promise<ConversationMessage[]> {
  const state = await readState();
  const prMessages = state.conversations
    .filter(m => m.prUrl === prUrl)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return prMessages.slice(0, limit);
}

async function mutateState(mutator: (state: PersistedState) => void): Promise<void> {
  writeChain = writeChain.then(async () => {
    const state = await readState();
    mutator(state);
    await ensureDataDir();
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  });
  await writeChain;
}

async function readState(): Promise<PersistedState> {
  await ensureDataDir();
  try {
    const content = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(content) as Partial<PersistedState>;
    return {
      jobs: parsed.jobs || [],
      reports: parsed.reports || [],
      feedback: parsed.feedback || [],
      conversations: parsed.conversations || []
    };
  } catch {
    return structuredClone(initialState);
  }
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
