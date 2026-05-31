import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { enqueueCommentBot, enqueuePullRequestReview } from '@/lib/queue';
import { appendAudit } from '@/lib/store';

export const runtime = 'nodejs';
export const maxDuration = 30;

const SUPPORTED_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const COMMENT_TRIGGER_PATTERN = /\/pr-insight|@pr-insight-ai/i;

type PullRequestWebhookPayload = {
  action: string;
  installation?: {
    id: number;
  };
  repository?: {
    full_name: string;
  };
  pull_request?: {
    html_url: string;
    draft?: boolean;
    head?: {
      sha?: string;
    };
  };
};

type IssueCommentWebhookPayload = {
  action: string;
  installation?: {
    id: number;
  };
  repository?: {
    full_name: string;
    html_url: string;
  };
  issue?: {
    number: number;
    html_url: string;
    pull_request?: unknown;
  };
  comment?: {
    body: string;
    html_url: string;
    user?: {
      login?: string;
    };
  };
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  const event = request.headers.get('x-github-event');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  if (event === 'pull_request') {
    return handlePullRequestEvent(rawBody);
  }

  if (event === 'issue_comment') {
    return handleIssueCommentEvent(rawBody);
  }

  return NextResponse.json({ ignored: true, reason: `unsupported event: ${event}` });
}

async function handlePullRequestEvent(rawBody: string) {
  const payload = JSON.parse(rawBody) as PullRequestWebhookPayload;

  if (!SUPPORTED_ACTIONS.has(payload.action)) {
    return NextResponse.json({ ignored: true, reason: `unsupported action: ${payload.action}` });
  }

  if (!payload.installation?.id || !payload.pull_request?.html_url) {
    return NextResponse.json({ error: 'missing installation or pull_request payload' }, { status: 400 });
  }

  if (payload.pull_request.draft && process.env.GITHUB_APP_REVIEW_DRAFTS !== 'true') {
    return NextResponse.json({ ignored: true, reason: 'draft PR review disabled' });
  }

  const job = await enqueuePullRequestReview({
    prUrl: payload.pull_request.html_url,
    repositoryFullName: payload.repository?.full_name || null,
    installationId: payload.installation.id,
    action: payload.action,
    headSha: payload.pull_request.head?.sha || null,
    payload: {
      event: 'pull_request',
      action: payload.action
    }
  });

  return NextResponse.json({
    queued: true,
    jobId: job.id,
    repository: payload.repository?.full_name,
    prUrl: payload.pull_request.html_url,
    action: payload.action
  });
}

async function handleIssueCommentEvent(rawBody: string) {
  const payload = JSON.parse(rawBody) as IssueCommentWebhookPayload;

  if (payload.action !== 'created') {
    return NextResponse.json({ ignored: true, reason: `unsupported comment action: ${payload.action}` });
  }

  if (!payload.issue?.pull_request) {
    return NextResponse.json({ ignored: true, reason: 'comment is not on a pull request' });
  }

  const body = payload.comment?.body || '';
  if (!COMMENT_TRIGGER_PATTERN.test(body)) {
    return NextResponse.json({ ignored: true, reason: 'comment did not mention PR Insight AI' });
  }

  if (!payload.installation?.id || !payload.repository?.html_url || !payload.issue.number) {
    return NextResponse.json({ error: 'missing installation, repository or issue payload' }, { status: 400 });
  }

  const prUrl = `${payload.repository.html_url}/pull/${payload.issue.number}`;
  await appendAudit({
    type: 'comment.received',
    prUrl,
    repositoryFullName: payload.repository.full_name,
    actor: payload.comment?.user?.login || null,
    message: 'PR comment received for bot processing',
    metadata: { commentUrl: payload.comment?.html_url }
  });

  const job = await enqueueCommentBot({
    prUrl,
    repositoryFullName: payload.repository.full_name,
    installationId: payload.installation.id,
    action: payload.action,
    payload: {
      body,
      actor: payload.comment?.user?.login || 'unknown',
      commentUrl: payload.comment?.html_url || null
    }
  });

  return NextResponse.json({
    queued: true,
    jobId: job.id,
    repository: payload.repository.full_name,
    prUrl
  });
}

function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    return process.env.NODE_ENV !== 'production';
  }

  if (!signature?.startsWith('sha256=')) {
    return false;
  }

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeCompare(expected, signature);
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}
