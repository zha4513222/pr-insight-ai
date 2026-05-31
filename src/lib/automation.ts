import { analyzeWithAi, askQuestion, generateFixSuggestion } from './ai';
import {
  createInstallationAccessToken,
  createPullRequestIssueComment,
  fetchPullRequestSnapshot,
  hasExistingReviewMarker,
  publishReviewWithFallback
} from './github';
import { findRiskCandidates } from './risk-rules';
import {
  addConversationMessage,
  addFeedback,
  appendAudit,
  getConversationHistory,
  getLatestReportForPr,
  saveReport,
  updateJob
} from './store';
import type { BotIntent, ConversationMessage, FeedbackVerdict, ReviewFinding, ReviewJob, ReviewReport } from './types';

export async function processPullRequestReviewJob(job: ReviewJob): Promise<void> {
  if (!job.installationId) {
    throw new Error('PR review job missing installation id');
  }

  const token = await createInstallationAccessToken(job.installationId);
  const marker = buildReviewMarker(job.prUrl, job.headSha || 'unknown');

  if (process.env.GITHUB_APP_SKIP_DUPLICATE_REVIEWS !== 'false') {
    const existing = await hasExistingReviewMarker({
      prUrl: job.prUrl,
      githubToken: token,
      marker
    });

    if (existing) {
      await updateJob(job.id, {
        status: 'succeeded',
        result: { ignored: true, reason: 'review already exists for this head sha' },
        completedAt: new Date().toISOString()
      });
      await appendAudit({
        type: 'job.succeeded',
        jobId: job.id,
        prUrl: job.prUrl,
        repositoryFullName: job.repositoryFullName,
        message: 'Skipped duplicate review for same head sha'
      });
      return;
    }
  }

  const report = await analyzePullRequest(job.prUrl, token);
  await saveReport(report);
  const comments = buildAutoReviewComments(report.findings);
  const body = [marker, report.publishDraft].join('\n\n');
  const publishResult = await publishReviewWithFallback({
    prUrl: job.prUrl,
    githubToken: token,
    body,
    event: shouldRequestChanges(report.findings) ? 'REQUEST_CHANGES' : 'COMMENT',
    comments
  });

  await updateJob(job.id, {
    status: 'succeeded',
    reportId: report.id,
    result: {
      reviewUrl: publishResult.url,
      findings: report.findings.length,
      inlineComments: comments.length,
      elapsedMs: report.elapsedMs
    },
    completedAt: new Date().toISOString()
  });
  await appendAudit({
    type: 'review.published',
    jobId: job.id,
    prUrl: job.prUrl,
    repositoryFullName: job.repositoryFullName,
    message: 'Automated PR review published',
    metadata: { reviewUrl: publishResult.url, reportId: report.id, inlineComments: comments.length }
  });
}

export async function analyzePullRequest(prUrl: string, githubToken?: string, mode?: 'fast' | 'deep'): Promise<ReviewReport> {
  const startedAt = Date.now();
  const snapshot = await fetchPullRequestSnapshot(prUrl, githubToken);
  const candidates = findRiskCandidates(snapshot.files);
  return analyzeWithAi({
    snapshot,
    candidates,
    startedAt,
    mode: mode || (process.env.GITHUB_APP_REVIEW_MODE === 'fast' ? 'fast' : 'deep')
  });
}

export async function processCommentBotJob(job: ReviewJob): Promise<void> {
  if (!job.installationId) {
    throw new Error('Comment bot job missing installation id');
  }

  const token = await createInstallationAccessToken(job.installationId);
  const command = parseBotCommand(String(job.payload.body || ''));
  const actor = String(job.payload.actor || 'unknown');
  const commentUrl = typeof job.payload.commentUrl === 'string' ? job.payload.commentUrl : null;
  const latestReport = await getLatestReportForPr(job.prUrl);

  const conversationHistory = await getConversationHistory(job.prUrl, 10);

  const userMessage = await addConversationMessage({
    prUrl: job.prUrl,
    reportId: latestReport?.id || null,
    role: 'user',
    intent: command.intent,
    findingId: command.findingId,
    content: String(job.payload.body || ''),
    sourceCommentUrl: commentUrl,
    actor
  });

  let reply: string;

  if (command.intent === 'feedback') {
    const feedback = await addFeedback({
      reportId: latestReport?.id || null,
      findingId: command.findingId,
      prUrl: job.prUrl,
      repositoryFullName: job.repositoryFullName,
      actor,
      verdict: command.verdict,
      note: command.note,
      sourceCommentUrl: commentUrl
    });
    reply = [
      `@${actor} 已记录反馈：${labelFeedback(command.verdict)}。`,
      '',
      command.findingId ? `关联建议：\`${command.findingId}\`` : '未指定具体建议，已作为 PR 级反馈记录。',
      feedback.note ? `补充说明：${feedback.note}` : '',
      '',
      '后续同类评审会将该反馈纳入误报/有效性分析。'
    ].filter(Boolean).join('\n');
  } else if (command.intent === 'explain') {
    reply = buildExplanationReply(actor, latestReport, command.findingId);
  } else if (command.intent === 'ask') {
    reply = await buildAskReply(actor, job.prUrl, token, latestReport, command.question, conversationHistory);
  } else if (command.intent === 'follow_up') {
    reply = await buildFollowUpReply(actor, job.prUrl, token, latestReport, conversationHistory);
  } else if (command.intent === 'fix') {
    reply = await buildFixReply(actor, job.prUrl, token, latestReport, command.findingId);
  } else if (command.intent === 'reanalyze') {
    const report = await analyzePullRequest(job.prUrl, token, process.env.GITHUB_APP_REVIEW_MODE === 'fast' ? 'fast' : 'deep');
    await saveReport(report);
    reply = [
      `@${actor} 已完成重新分析。`,
      '',
      `报告 ID：\`${report.id}\``,
      `发现建议：${report.findings.length} 条`,
      `总体风险分：${report.riskScore.overall}`,
      '',
      report.publishDraft
    ].join('\n');
  } else {
    reply = buildHelpReply(actor, latestReport);
  }

  const posted = await createPullRequestIssueComment({
    prUrl: job.prUrl,
    githubToken: token,
    body: reply
  });

  await addConversationMessage({
    prUrl: job.prUrl,
    reportId: latestReport?.id || null,
    role: 'assistant',
    intent: command.intent,
    findingId: command.findingId,
    content: reply,
    sourceCommentUrl: posted.url,
    actor: 'pr-insight-ai'
  });

  await updateJob(job.id, {
    status: 'succeeded',
    reportId: latestReport?.id || null,
    result: { replyUrl: posted.url, intent: command.intent },
    completedAt: new Date().toISOString()
  });
  await appendAudit({
    type: 'bot.replied',
    jobId: job.id,
    prUrl: job.prUrl,
    repositoryFullName: job.repositoryFullName,
    actor,
    message: `Comment bot replied: ${command.intent}`,
    metadata: { replyUrl: posted.url, findingId: command.findingId, question: command.question }
  });
}

export function buildReviewMarker(prUrl: string, headSha: string): string {
  return `<!-- pr-insight-ai:${prUrl}:${headSha} -->`;
}

export function buildAutoReviewComments(findings: ReviewFinding[]) {
  const maxComments = Number(process.env.GITHUB_APP_MAX_INLINE_COMMENTS || 8);
  return findings
    .filter((finding) => finding.postToGitHub && finding.position !== null)
    .slice(0, maxComments)
    .map((finding) => ({
      path: finding.filePath,
      position: finding.position as number,
      body: formatInlineComment(finding)
    }));
}

export function shouldRequestChanges(findings: ReviewFinding[]): boolean {
  if (process.env.GITHUB_APP_REQUEST_CHANGES !== 'true') {
    return false;
  }

  return findings.some(
    (finding) =>
      finding.recommendationLevel === 'must_fix' &&
      finding.confidence >= 0.82 &&
      (finding.severity === 'critical' || finding.severity === 'high')
  );
}

function parseBotCommand(body: string): {
  intent: BotIntent;
  verdict: FeedbackVerdict;
  findingId: string | null;
  note: string;
  question: string | null;
} {
  const trigger = process.env.PR_INSIGHT_BOT_TRIGGER || '/pr-insight';
  const normalized = body.trim();
  const lower = normalized.toLowerCase();

  if (!lower.includes(trigger.toLowerCase()) && !lower.includes('@pr-insight-ai')) {
    return { intent: 'help', verdict: 'needs_more_context', findingId: null, note: '', question: null };
  }

  const findingId = normalized.match(/\b(?:finding|建议|issue|id)[:：\s]+([a-z0-9_.:/-]+)/i)?.[1] || null;
  const note = normalized.replace(new RegExp(escapeRegExp(trigger), 'ig'), '').trim();

  const askMatch = normalized.match(new RegExp(`${escapeRegExp(trigger)}\\s+ask\\s+(.+)`, 'is'));
  if (askMatch) {
    return { intent: 'ask', verdict: 'needs_more_context', findingId: null, note: '', question: askMatch[1].trim() };
  }

  const whatMatch = normalized.match(new RegExp(`${escapeRegExp(trigger)}\\s+what\\s+(?:is\\s+)?(.+)`, 'is'));
  if (whatMatch) {
    return { intent: 'ask', verdict: 'needs_more_context', findingId: null, note: '', question: `请解释: ${whatMatch[1].trim()}` };
  }

  const fixMatch = normalized.match(new RegExp(`${escapeRegExp(trigger)}\\s+fix\\s+(?:finding[:：\\s]*)?([a-z0-9_.:/-]+)`, 'i'));
  if (fixMatch) {
    return { intent: 'fix', verdict: 'needs_more_context', findingId: fixMatch[1], note: '', question: null };
  }

  if (/继续|更多|细节|详细|追问|follow\s*up|more|detail/i.test(normalized)) {
    return { intent: 'follow_up', verdict: 'needs_more_context', findingId, note, question: null };
  }

  if (/误报|false[-\s]?positive|fp\b/i.test(normalized)) {
    return { intent: 'feedback', verdict: 'false_positive', findingId, note, question: null };
  }

  if (/有效|valid|确实|true[-\s]?positive/i.test(normalized)) {
    return { intent: 'feedback', verdict: 'valid', findingId, note, question: null };
  }

  if (/忽略|ignore|won'?t\s+fix/i.test(normalized)) {
    return { intent: 'feedback', verdict: 'ignored', findingId, note, question: null };
  }

  if (/重新|reanalyze|rerun|再分析/i.test(normalized)) {
    return { intent: 'reanalyze', verdict: 'needs_more_context', findingId, note, question: null };
  }

  if (/解释|explain|why|为什么|详情/i.test(normalized)) {
    return { intent: 'explain', verdict: 'needs_more_context', findingId, note, question: null };
  }

  return { intent: 'help', verdict: 'needs_more_context', findingId, note, question: null };
}

function buildExplanationReply(actor: string, report: ReviewReport | null, findingId: string | null): string {
  if (!report) {
    return `@${actor} 暂未找到该 PR 的历史分析报告。可以评论 \`/pr-insight reanalyze\` 触发重新分析。`;
  }

  const finding = findingId
    ? report.findings.find((item) => item.id === findingId || item.id.endsWith(findingId))
    : report.findings[0];

  if (!finding) {
    return [
      `@${actor} 未找到对应建议。`,
      '',
      '可以使用以下格式指定建议 ID：',
      '`/pr-insight explain finding:<finding-id>`'
    ].join('\n');
  }

  return [
    `@${actor} 这是该建议的判断依据：`,
    '',
    `**${finding.title}**`,
    '',
    `位置：\`${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''}\``,
    `类型：${finding.category}，严重级别：${finding.severity}，置信度：${Math.round(finding.confidence * 100)}%`,
    '',
    `问题：${finding.problem}`,
    '',
    `影响：${finding.impact}`,
    '',
    '证据：',
    ...finding.evidence.slice(0, 5).map((item) => `- \`${item}\``),
    '',
    `建议：${finding.suggestion}`,
    '',
    `如果你认为这是误报，可以回复：\`/pr-insight false-positive finding:${finding.id} 原因...\``
  ].join('\n');
}

async function buildAskReply(
  actor: string,
  prUrl: string,
  token: string,
  report: ReviewReport | null,
  question: string | null,
  conversationHistory?: ConversationMessage[]
): Promise<string> {
  if (!question) {
    return [
      `@${actor} 请提供要询问的问题。`,
      '',
      '用法：`/pr-insight ask <问题>`',
      '例如：`/pr-insight ask 这个 PR 修改了哪些 API 接口？`'
    ].join('\n');
  }

  try {
    const snapshot = await fetchPullRequestSnapshot(prUrl, token);
    const response = await askQuestion({ snapshot, question, report, conversationHistory });

    const lines: string[] = [
      `@${actor} ${response.answer}`,
      ''
    ];

    if (response.relatedFindings.length > 0 && report) {
      lines.push('**相关建议：**');
      for (const findingId of response.relatedFindings.slice(0, 5)) {
        const finding = report.findings.find(f => f.id === findingId || f.id.endsWith(findingId));
        if (finding) {
          lines.push(`- \`${finding.id}\`: ${finding.title}`);
        }
      }
      lines.push('');
    }

    if (response.referencedFiles.length > 0) {
      lines.push(`**涉及文件：** ${response.referencedFiles.map(f => `\`${f}\``).join(', ')}`);
      lines.push('');
    }

    lines.push('_回答基于 PR diff 和评审报告生成，请结合业务上下文确认。_');
    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return [
      `@${actor} 回答问题时发生错误：${message}`,
      '',
      '请稍后重试，或使用 `/pr-insight help` 查看可用命令。'
    ].join('\n');
  }
}

async function buildFollowUpReply(
  actor: string,
  prUrl: string,
  token: string,
  report: ReviewReport | null,
  conversationHistory: ConversationMessage[]
): Promise<string> {
  if (conversationHistory.length === 0) {
    return [
      `@${actor} 没有之前的对话记录。`,
      '',
      '请先使用 `/pr-insight ask <问题>` 开始对话。',
      '例如：`/pr-insight ask 这个 PR 改了什么？`'
    ].join('\n');
  }

  const lastUserMessage = conversationHistory.find(m => m.role === 'user');
  const lastBotMessage = conversationHistory.find(m => m.role === 'assistant');

  let followUpQuestion = '请继续解释之前的回答，提供更多细节。';
  if (lastUserMessage && lastUserMessage.intent === 'ask') {
    followUpQuestion = `关于之前的问题"${lastUserMessage.content.slice(0, 100)}"，请提供更多细节和深入解释。`;
  } else if (lastUserMessage && lastUserMessage.intent === 'explain' && lastUserMessage.findingId) {
    followUpQuestion = `关于建议 ${lastUserMessage.findingId}，请提供更详细的解释和具体的修复建议。`;
  }

  try {
    const snapshot = await fetchPullRequestSnapshot(prUrl, token);
    const response = await askQuestion({
      snapshot,
      question: followUpQuestion,
      report,
      conversationHistory
    });

    const lines: string[] = [
      `@${actor} ${response.answer}`,
      ''
    ];

    if (response.relatedFindings.length > 0 && report) {
      lines.push('**相关建议：**');
      for (const findingId of response.relatedFindings.slice(0, 5)) {
        const finding = report.findings.find(f => f.id === findingId || f.id.endsWith(findingId));
        if (finding) {
          lines.push(`- \`${finding.id}\`: ${finding.title}`);
        }
      }
      lines.push('');
    }

    lines.push('_追问回答基于之前的对话上下文，请结合业务场景确认。_');
    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return [
      `@${actor} 追问回答时发生错误：${message}`,
      '',
      '请稍后重试，或使用 `/pr-insight help` 查看可用命令。'
    ].join('\n');
  }
}

async function buildFixReply(
  actor: string,
  prUrl: string,
  token: string,
  report: ReviewReport | null,
  findingId: string | null
): Promise<string> {
  if (!report) {
    return [
      `@${actor} 暂未找到该 PR 的历史分析报告。`,
      '',
      '可以评论 `/pr-insight reanalyze` 触发重新分析后再请求修复建议。'
    ].join('\n');
  }

  if (!findingId) {
    return [
      `@${actor} 请指定要生成修复的建议 ID。`,
      '',
      '用法：`/pr-insight fix finding:<id>`',
      '例如：`/pr-insight fix finding:rule-hardcoded-secret-auth.ts-42`'
    ].join('\n');
  }

  const finding = report.findings.find(
    f => f.id === findingId || f.id.endsWith(findingId)
  );

  if (!finding) {
    return [
      `@${actor} 未找到 ID 为 \`${findingId}\` 的建议。`,
      '',
      '可用建议 ID：',
      ...report.findings.slice(0, 10).map(f => `- \`${f.id}\`: ${f.title}`)
    ].join('\n');
  }

  if (!finding.filePath || finding.confidence < 0.5) {
    return [
      `@${actor} 该建议的上下文不足，无法生成可靠的修复代码。`,
      '',
      `**${finding.title}**`,
      '',
      `建议：${finding.suggestion}`
    ].join('\n');
  }

  try {
    const snapshot = await fetchPullRequestSnapshot(prUrl, token);
    const fix = await generateFixSuggestion({ snapshot, finding });

    const lines: string[] = [
      `@${actor} 以下是针对建议 \`${findingId}\` 的修复方案：`,
      '',
      `## ${fix.title}`,
      '',
      fix.explanation,
      ''
    ];

    for (const block of fix.codeBlocks) {
      lines.push(`### \`${block.filename}\``);
      if (block.lineStart && block.lineEnd) {
        lines.push(`行 ${block.lineStart}-${block.lineEnd}`);
      }
      lines.push('');

      if (block.originalCode) {
        lines.push('**原代码：**');
        lines.push('```' + block.language);
        lines.push(block.originalCode);
        lines.push('```');
        lines.push('');
      }

      lines.push('**建议修改为：**');
      lines.push('```' + block.language);
      lines.push(block.suggestedCode);
      lines.push('```');
      lines.push('');
    }

    if (fix.considerations.length > 0) {
      lines.push('**注意事项：**');
      for (const c of fix.considerations) {
        lines.push(`- ${c}`);
      }
      lines.push('');
    }

    if (fix.testSuggestions.length > 0) {
      lines.push('**建议测试：**');
      for (const t of fix.testSuggestions) {
        lines.push(`- ${t}`);
      }
      lines.push('');
    }

    lines.push('_修复代码由 AI 生成，请仔细 review 后应用。确保代码风格与现有代码一致，并在本地测试通过后再提交。_');
    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return [
      `@${actor} 生成修复建议时发生错误：${message}`,
      '',
      '请稍后重试，或查看原建议详情：',
      `**${finding.title}**`,
      '',
      `问题：${finding.problem}`,
      '',
      `建议：${finding.suggestion}`
    ].join('\n');
  }
}

function buildHelpReply(actor: string, report: ReviewReport | null): string {
  const latest = report
    ? [`最新报告：\`${report.id}\`，建议数：${report.findings.length}，风险分：${report.riskScore.overall}`]
    : ['暂未找到该 PR 的分析报告。'];

  return [
    `@${actor} 我可以协助解释、回答问题和生成修复建议。`,
    '',
    ...latest,
    '',
    '## 查询与分析',
    '- `/pr-insight ask <问题>` - 询问关于 PR 的任意问题',
    '- `/pr-insight what <术语/代码>` - 解释 PR 中的概念或代码',
    '- `/pr-insight explain finding:<id>` - 解释某条建议的详情',
    '- `/pr-insight reanalyze` - 重新分析当前 PR',
    '',
    '## 反馈与修复',
    '- `/pr-insight fix finding:<id>` - 生成修复代码建议',
    '- `/pr-insight false-positive finding:<id> 原因...` - 标记误报',
    '- `/pr-insight valid finding:<id> 原因...` - 标记有效',
    '- `/pr-insight ignore finding:<id> 原因...` - 标记忽略',
    '',
    '## 多轮对话',
    '- `/pr-insight 继续` 或 `/pr-insight 更多细节` - 追问上一个话题',
    '',
    '## 示例',
    '- `/pr-insight ask 这个 PR 修改了哪些认证逻辑？`',
    '- `/pr-insight 继续` - 追问更多细节',
    '- `/pr-insight what dangerouslySetInnerHTML`',
    '- `/pr-insight fix finding:rule-hardcoded-secret-auth.ts-42`'
  ].join('\n');
}

function labelFeedback(verdict: FeedbackVerdict): string {
  if (verdict === 'false_positive') return '误报';
  if (verdict === 'valid') return '有效';
  if (verdict === 'ignored') return '忽略';
  return '需要更多上下文';
}

function formatInlineComment(finding: ReviewFinding): string {
  const levelLabel = finding.recommendationLevel === 'must_fix'
    ? '必须修复'
    : finding.recommendationLevel === 'should_improve'
      ? '建议优化'
      : '仅供参考';

  return [
    `**${levelLabel}：${finding.title}**`,
    '',
    finding.problem,
    '',
    `建议 ID：\`${finding.id}\``,
    '',
    `影响：${finding.impact}`,
    '',
    `建议：${finding.suggestion}`,
    '',
    '_PR Insight AI 自动评审建议，请结合业务上下文确认。_'
  ].join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
