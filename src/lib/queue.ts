import { processCommentBotJob, processPullRequestReviewJob } from './automation';
import { appendAudit, createJob, getJob, updateJob } from './store';
import type { ReviewJob } from './types';

type QueueState = {
  running: boolean;
  pending: string[];
};

const globalForQueue = globalThis as typeof globalThis & {
  __prInsightQueue?: QueueState;
};

const queueState: QueueState = globalForQueue.__prInsightQueue || {
  running: false,
  pending: []
};

globalForQueue.__prInsightQueue = queueState;

export async function enqueuePullRequestReview(input: {
  prUrl: string;
  repositoryFullName?: string | null;
  installationId: number;
  action: string;
  headSha?: string | null;
  payload?: Record<string, unknown>;
}): Promise<ReviewJob> {
  const job = await createJob({
    type: 'pr_review',
    prUrl: input.prUrl,
    repositoryFullName: input.repositoryFullName || null,
    installationId: input.installationId,
    action: input.action,
    headSha: input.headSha || null,
    payload: input.payload || {}
  });

  pushJob(job.id);
  return job;
}

export async function enqueueCommentBot(input: {
  prUrl: string;
  repositoryFullName?: string | null;
  installationId: number;
  action: string;
  payload: Record<string, unknown>;
}): Promise<ReviewJob> {
  const job = await createJob({
    type: 'comment_bot',
    prUrl: input.prUrl,
    repositoryFullName: input.repositoryFullName || null,
    installationId: input.installationId,
    action: input.action,
    headSha: null,
    payload: input.payload,
    maxAttempts: 1
  });

  pushJob(job.id);
  return job;
}

function pushJob(jobId: string): void {
  if (!queueState.pending.includes(jobId)) {
    queueState.pending.push(jobId);
  }
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (queueState.running) {
    return;
  }

  queueState.running = true;

  try {
    while (queueState.pending.length) {
      const jobId = queueState.pending.shift();
      if (!jobId) continue;
      const job = await getJob(jobId);
      if (!job || job.status !== 'queued') {
        continue;
      }

      await runJob(job);
    }
  } finally {
    queueState.running = false;
  }
}

async function runJob(job: ReviewJob): Promise<void> {
  const now = new Date().toISOString();
  const runningJob = await updateJob(job.id, {
    status: 'running',
    attempts: job.attempts + 1,
    startedAt: job.startedAt || now,
    error: null
  });
  await appendAudit({
    type: 'job.started',
    jobId: job.id,
    prUrl: job.prUrl,
    repositoryFullName: job.repositoryFullName,
    message: `${job.type} job started`,
    metadata: { attempt: runningJob.attempts }
  });

  try {
    if (job.type === 'pr_review') {
      await processPullRequestReviewJob(runningJob);
    } else {
      await processCommentBotJob(runningJob);
    }

    await appendAudit({
      type: 'job.succeeded',
      jobId: job.id,
      prUrl: job.prUrl,
      repositoryFullName: job.repositoryFullName,
      message: `${job.type} job succeeded`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown job error';
    const canRetry = runningJob.attempts < runningJob.maxAttempts;
    await updateJob(job.id, {
      status: canRetry ? 'queued' : 'failed',
      error: message,
      completedAt: canRetry ? null : new Date().toISOString()
    });
    await appendAudit({
      type: 'job.failed',
      jobId: job.id,
      prUrl: job.prUrl,
      repositoryFullName: job.repositoryFullName,
      message,
      metadata: { retry: canRetry, attempt: runningJob.attempts }
    });

    if (canRetry) {
      pushJob(job.id);
    }
  }
}
