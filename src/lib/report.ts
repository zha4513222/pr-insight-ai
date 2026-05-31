import {
  ChangedFile,
  PullRequestSnapshot,
  RecommendationLevel,
  ReviewFinding,
  ReviewReport,
  ReviewSummary,
  RiskCandidate,
  RiskScore,
  Severity
} from './types';

export function buildFallbackSummary(snapshot: PullRequestSnapshot): ReviewSummary {
  const { metadata, commits, files } = snapshot;
  const modules = summarizeModules(files);
  const dependencyFiles = files.filter((file) => file.riskTags.includes('依赖或构建变更')).map((file) => file.filename);
  const testFiles = files.filter((file) => file.riskTags.includes('测试相关变更'));

  return {
    headline: `${metadata.title || '该 PR'} 修改了 ${metadata.changedFiles} 个文件，新增 ${metadata.additions} 行，删除 ${metadata.deletions} 行。`,
    businessChange: metadata.body
      ? `PR 描述显示：${truncate(metadata.body.replace(/\s+/g, ' '), 420)}`
      : '未提供明确 PR 描述，需要 reviewer 结合变更文件确认业务意图。',
    technicalChange: `主要变更集中在 ${modules.length ? modules.join('、') : '仓库根目录或少量文件'}。最近提交包括：${commits.slice(0, 3).map((commit) => commit.message.split('\n')[0]).join('；') || '无提交摘要'}`,
    modules,
    dependencyChange: dependencyFiles.length ? `检测到依赖或构建相关变更：${dependencyFiles.join('、')}` : '未检测到明显依赖或构建文件变更。',
    architectureImpact: inferArchitectureImpact(files),
    testCoverage: testFiles.length
      ? `检测到 ${testFiles.length} 个测试相关文件变更。仍需确认测试是否覆盖核心风险路径。`
      : '未检测到测试文件变更。若该 PR 修改了业务逻辑、权限、数据或公共接口，建议补充测试。',
    reviewerFocus: buildReviewerFocus(files),
    inferredFacts: ['业务变更定位基于 PR 标题、描述、提交信息和文件路径推断，需结合项目背景确认。']
  };
}

export function candidatesToFindings(candidates: RiskCandidate[]): ReviewFinding[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    filePath: candidate.filePath,
    lineStart: candidate.lineStart,
    lineEnd: candidate.lineEnd,
    position: candidate.position,
    category: candidate.category,
    severity: candidate.severity,
    confidence: candidate.confidence,
    recommendationLevel: candidate.recommendationLevel,
    title: candidate.title,
    problem: candidate.reason,
    impact: impactForSeverity(candidate.severity),
    evidence: candidate.evidence,
    suggestion: suggestionForCandidate(candidate),
    postToGitHub: candidate.recommendationLevel !== 'for_reference' && candidate.confidence >= 0.7 && candidate.position !== null,
    source: 'rule'
  }));
}

export function buildRiskScore(findings: ReviewFinding[], snapshot: PullRequestSnapshot): RiskScore {
  const base = Math.min(35, Math.ceil(snapshot.metadata.changedFiles / 4) + Math.ceil((snapshot.metadata.additions + snapshot.metadata.deletions) / 200));
  const dimensions = {
    security: scoreCategory(findings, 'security'),
    correctness: scoreCategory(findings, 'correctness'),
    performance: scoreCategory(findings, 'performance'),
    compatibility: scoreCategory(findings, 'compatibility'),
    test: scoreCategory(findings, 'test'),
    maintainability: scoreCategory(findings, 'maintainability')
  };
  const overall = clamp(Math.max(base, ...Object.values(dimensions)) + (snapshot.checks.failed > 0 ? 10 : 0), 0, 100);

  return {
    overall,
    ...dimensions
  };
}

export function buildPublishDraft(summary: ReviewSummary, findings: ReviewFinding[]): string {
  const mustFix = findings.filter((finding) => finding.recommendationLevel === 'must_fix');
  const shouldImprove = findings.filter((finding) => finding.recommendationLevel === 'should_improve');

  const lines = [
    '## AI PR Review 摘要',
    '',
    summary.headline,
    '',
    `**业务变更**：${summary.businessChange}`,
    '',
    `**技术变更**：${summary.technicalChange}`,
    '',
    `**测试情况**：${summary.testCoverage}`,
    '',
    `**重点关注**：${summary.reviewerFocus.length ? summary.reviewerFocus.join('；') : '未识别到特别高风险区域。'}`
  ];

  if (mustFix.length || shouldImprove.length) {
    lines.push('', '## 建议优先处理的问题');
    for (const finding of [...mustFix, ...shouldImprove].slice(0, 8)) {
      lines.push('', `- [${labelForLevel(finding.recommendationLevel)}] ${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''} - ${finding.title}`);
      lines.push(`  ${finding.problem}`);
    }
  }

  lines.push('', '_该评审由 AI 辅助生成，请 reviewer 结合业务上下文确认。_');
  return lines.join('\n');
}

export function buildReport(input: {
  snapshot: PullRequestSnapshot;
  summary?: ReviewSummary;
  findings: ReviewFinding[];
  missingContext?: string[];
  followUps?: string[];
  startedAt: number;
  aiEnabled: boolean;
  model: string | null;
  fastModel: string | null;
}): ReviewReport {
  const summary = input.summary || buildFallbackSummary(input.snapshot);
  const normalizedFindings = normalizeFindings(input.findings);
  return {
    id: `${input.snapshot.metadata.owner}-${input.snapshot.metadata.repo}-${input.snapshot.metadata.number}-${input.snapshot.metadata.headSha.slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    aiEnabled: input.aiEnabled,
    model: input.model,
    fastModel: input.fastModel,
    elapsedMs: Date.now() - input.startedAt,
    snapshot: input.snapshot,
    summary,
    riskScore: buildRiskScore(normalizedFindings, input.snapshot),
    findings: normalizedFindings,
    missingContext: input.missingContext || detectMissingContext(input.snapshot),
    followUps: input.followUps || buildFollowUps(input.snapshot, normalizedFindings),
    publishDraft: buildPublishDraft(summary, normalizedFindings)
  };
}

export function normalizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => finding.title && finding.problem)
    .filter((finding) => {
      const key = `${finding.filePath}:${finding.lineStart}:${finding.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || b.confidence - a.confidence);
}

function summarizeModules(files: ChangedFile[]): string[] {
  const modules = new Map<string, number>();
  for (const file of files) {
    const first = file.filename.split('/')[0] || file.filename;
    modules.set(first, (modules.get(first) || 0) + file.changes);
  }

  return Array.from(modules.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([module]) => module);
}

function inferArchitectureImpact(files: ChangedFile[]): string {
  const tags = new Set(files.flatMap((file) => file.riskTags));
  const impacts: string[] = [];

  if (tags.has('公共接口变更')) impacts.push('涉及公共接口或路由，需关注调用方兼容性');
  if (tags.has('数据层变更')) impacts.push('涉及数据层，需关注事务、迁移和数据一致性');
  if (tags.has('依赖或构建变更')) impacts.push('涉及依赖或构建配置，需关注构建、部署和版本兼容');
  if (tags.has('权限/认证敏感文件')) impacts.push('涉及认证或权限模块，需关注权限绕过和访问控制');

  return impacts.length ? impacts.join('；') : '未从文件路径识别到明显架构级影响。';
}

function buildReviewerFocus(files: ChangedFile[]): string[] {
  const tags = new Set(files.flatMap((file) => file.riskTags));
  const focus: string[] = [];

  if (tags.has('权限/认证敏感文件')) focus.push('确认认证、授权、session 或 token 处理是否保持安全边界');
  if (tags.has('数据层变更')) focus.push('确认数据库访问、事务边界、迁移和回滚策略');
  if (tags.has('依赖或构建变更')) focus.push('确认依赖升级、lockfile 和构建配置是否兼容');
  if (!files.some((file) => file.riskTags.includes('测试相关变更'))) focus.push('确认是否需要补充测试覆盖');

  return focus;
}

function detectMissingContext(snapshot: PullRequestSnapshot): string[] {
  const missing: string[] = [];
  const patchless = snapshot.files.filter((file) => !file.patch && file.status !== 'removed');
  if (patchless.length) {
    missing.push(`${patchless.length} 个文件未返回 patch，可能是二进制文件、超大文件或 GitHub API 限制。`);
  }
  if (!snapshot.metadata.body) {
    missing.push('PR 描述为空，业务意图主要依赖代码和提交信息推断。');
  }
  return missing;
}

function buildFollowUps(snapshot: PullRequestSnapshot, findings: ReviewFinding[]): string[] {
  const followUps: string[] = [];

  if (!snapshot.files.some((file) => file.riskTags.includes('测试相关变更')) && snapshot.metadata.additions > 20) {
    followUps.push('确认本次业务或数据逻辑变更是否需要新增测试。');
  }

  if (findings.some((finding) => finding.category === 'security')) {
    followUps.push('对安全相关结论进行人工复核，确认输入来源、权限边界和日志脱敏。');
  }

  if (snapshot.checks.failed > 0) {
    followUps.push('GitHub Checks 存在失败项，建议优先查看 CI 失败原因。');
  }

  return followUps;
}

function scoreCategory(findings: ReviewFinding[], category: ReviewFinding['category']): number {
  const categoryFindings = findings.filter((finding) => finding.category === category);
  const raw = categoryFindings.reduce((score, finding) => score + severityWeight(finding.severity) * finding.confidence * 9, 0);
  return clamp(Math.round(raw), 0, 100);
}

function severityWeight(severity: Severity): number {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function impactForSeverity(severity: Severity): string {
  if (severity === 'critical') return '可能导致严重安全、数据或线上稳定性问题，应在合并前处理。';
  if (severity === 'high') return '可能影响安全、正确性或兼容性，建议作为阻塞项 review。';
  if (severity === 'medium') return '可能在边界场景或规模扩大后造成问题，建议修复或补充说明。';
  return '影响相对有限，主要用于提升可维护性或交付质量。';
}

function suggestionForCandidate(candidate: RiskCandidate): string {
  if (candidate.category === 'security') {
    return '确认输入来源和权限边界，避免硬编码敏感信息，必要时使用参数化查询、密钥管理或白名单校验。';
  }
  if (candidate.category === 'performance') {
    return '确认该逻辑在批量数据下的复杂度和外部调用次数，必要时增加批处理、缓存或分页限制。';
  }
  if (candidate.category === 'test') {
    return '补充覆盖核心路径、边界条件和失败场景的测试。';
  }
  return '结合上下文确认该变更是否符合预期，并补充必要的测试、错误处理或注释说明。';
}

function labelForLevel(level: RecommendationLevel): string {
  if (level === 'must_fix') return '必须修复';
  if (level === 'should_improve') return '建议优化';
  return '仅供参考';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
