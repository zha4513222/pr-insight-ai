import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import {
  ChangedFile,
  CheckInfo,
  CommitInfo,
  PrIdentity,
  PrMetadata,
  PullRequestSnapshot
} from './types';
import { parsePatch } from './parse-diff';
import { detectLanguage, tagFileRisk } from './risk-rules';

const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePrUrl(prUrl: string): PrIdentity {
  const trimmed = prUrl.trim();
  const match = PR_URL_PATTERN.exec(trimmed);

  if (!match) {
    throw new Error('请输入有效的 GitHub PR 链接，例如 https://github.com/org/repo/pull/123');
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3])
  };
}

function createOctokit(token?: string) {
  const auth = token || process.env.GITHUB_TOKEN || undefined;
  return new Octokit(auth ? { auth } : {});
}

export async function createInstallationAccessToken(installationId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY);

  if (!appId || !privateKey) {
    throw new Error('缺少 GITHUB_APP_ID 或 GITHUB_APP_PRIVATE_KEY，无法使用 GitHub App 鉴权。');
  }

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId
  });
  const installationAuthentication = await auth({ type: 'installation' });
  return installationAuthentication.token;
}

function normalizePrivateKey(privateKey?: string): string | undefined {
  if (!privateKey) return undefined;
  return privateKey.replace(/\\n/g, '\n');
}

export async function fetchPullRequestSnapshot(prUrl: string, githubToken?: string): Promise<PullRequestSnapshot> {
  const identity = parsePrUrl(prUrl);
  const octokit = createOctokit(githubToken);

  const [{ data: pr }, files, commits] = await Promise.all([
    octokit.pulls.get({
      owner: identity.owner,
      repo: identity.repo,
      pull_number: identity.number
    }),
    octokit.paginate(octokit.pulls.listFiles, {
      owner: identity.owner,
      repo: identity.repo,
      pull_number: identity.number,
      per_page: 100
    }),
    octokit.paginate(octokit.pulls.listCommits, {
      owner: identity.owner,
      repo: identity.repo,
      pull_number: identity.number,
      per_page: 100
    })
  ]);
  const checks = await fetchChecks(octokit, pr.head.sha, identity);

  const metadata: PrMetadata = {
    ...identity,
    url: pr.html_url,
    title: pr.title,
    body: pr.body || '',
    author: pr.user?.login || 'unknown',
    state: pr.state,
    isDraft: Boolean(pr.draft),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changedFiles: pr.changed_files || files.length
  };

  const changedFiles: ChangedFile[] = files.map((file) => {
    const language = detectLanguage(file.filename);
    return {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch || null,
      previousFilename: file.previous_filename || null,
      hunks: file.patch ? parsePatch(file.patch) : [],
      language,
      riskTags: tagFileRisk(file.filename, language, file.status, file.patch || '')
    };
  });

  const commitInfos: CommitInfo[] = commits.map((commit) => ({
    sha: commit.sha,
    author: commit.commit.author?.name || commit.author?.login || 'unknown',
    message: commit.commit.message,
    date: commit.commit.author?.date || null
  }));

  return {
    metadata,
    commits: commitInfos,
    files: changedFiles,
    checks,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchChecks(octokit: Octokit, ref: string, identity: PrIdentity): Promise<CheckInfo> {
  try {
    const { data } = await octokit.checks.listForRef({
      owner: identity.owner,
      repo: identity.repo,
      ref,
      per_page: 100
    });

    const total = data.total_count;
    const failed = data.check_runs.filter((run) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion || '')).length;
    const passed = data.check_runs.filter((run) => run.conclusion === 'success').length;
    const pending = data.check_runs.filter((run) => !run.conclusion || run.status !== 'completed').length;

    return {
      total,
      passed,
      failed,
      pending,
      conclusionSummary: total === 0 ? '未发现 GitHub Checks' : `${passed} passed, ${failed} failed, ${pending} pending`
    };
  } catch {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      conclusionSummary: '无法读取 GitHub Checks，可能缺少权限或该仓库未启用 checks'
    };
  }
}

export async function publishPullRequestReview(request: {
  prUrl: string;
  githubToken?: string;
  body: string;
  event?: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: Array<{ path: string; position: number; body: string }>;
}) {
  const identity = parsePrUrl(request.prUrl);
  const octokit = createOctokit(request.githubToken);

  const { data } = await octokit.pulls.createReview({
    owner: identity.owner,
    repo: identity.repo,
    pull_number: identity.number,
    body: request.body,
    event: request.event || 'COMMENT',
    comments: request.comments?.length ? request.comments : undefined
  });

  return {
    id: data.id,
    url: data.html_url
  };
}

export async function hasExistingReviewMarker(request: {
  prUrl: string;
  githubToken?: string;
  marker: string;
}): Promise<boolean> {
  const identity = parsePrUrl(request.prUrl);
  const octokit = createOctokit(request.githubToken);
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner: identity.owner,
    repo: identity.repo,
    pull_number: identity.number,
    per_page: 100
  });

  return reviews.some((review) => review.body?.includes(request.marker));
}

export async function publishReviewWithFallback(request: {
  prUrl: string;
  githubToken?: string;
  body: string;
  event?: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: Array<{ path: string; position: number; body: string }>;
}) {
  try {
    return await publishPullRequestReview(request);
  } catch (error) {
    if (!request.comments?.length) {
      throw error;
    }

    const fallbackBody = [
      request.body,
      '',
      '> 部分行级评论定位失败，已降级为 summary review。请在工具报告中查看原始定位信息。'
    ].join('\n');

    return publishPullRequestReview({
      ...request,
      body: fallbackBody,
      comments: undefined
    });
  }
}

export async function createPullRequestIssueComment(request: {
  prUrl: string;
  githubToken?: string;
  body: string;
}) {
  const identity = parsePrUrl(request.prUrl);
  const octokit = createOctokit(request.githubToken);
  const { data } = await octokit.issues.createComment({
    owner: identity.owner,
    repo: identity.repo,
    issue_number: identity.number,
    body: request.body
  });

  return {
    id: data.id,
    url: data.html_url
  };
}
