'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Code2,
  FileWarning,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Send,
  ShieldAlert
} from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import type { ReviewFinding, ReviewReport } from '@/lib/types';

type AnalyzeResponse = {
  report?: ReviewReport;
  error?: string;
};

type PublishResponse = {
  result?: {
    id: number;
    url: string;
  };
  error?: string;
};

const severityLabel: Record<ReviewFinding['severity'], string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低'
};

const levelLabel: Record<ReviewFinding['recommendationLevel'], string> = {
  must_fix: '必须修复',
  should_improve: '建议优化',
  for_reference: '仅供参考'
};

const categoryLabel: Record<ReviewFinding['category'], string> = {
  security: '安全',
  correctness: '正确性',
  performance: '性能',
  compatibility: '兼容性',
  maintainability: '可维护性',
  test: '测试',
  style: '风格'
};

export default function Home() {
  const [prUrl, setPrUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [mode, setMode] = useState<'fast' | 'deep'>('deep');
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<Record<string, string>>({});

  const selectedFindings = useMemo(() => {
    if (!report) return [];
    return report.findings.filter((finding) => selectedIds.has(finding.id));
  }, [report, selectedIds]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPublishUrl(null);
    setIsAnalyzing(true);
    setReport(null);
    setSelectedIds(new Set());

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prUrl,
          githubToken: githubToken.trim() || undefined,
          mode
        })
      });
      const data = (await response.json()) as AnalyzeResponse;

      if (!response.ok || !data.report) {
        throw new Error(data.error || '分析失败');
      }

      setReport(data.report);
      setSelectedIds(new Set(data.report.findings.filter((finding) => finding.postToGitHub).map((finding) => finding.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '分析失败');
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function publishReview() {
    if (!report) return;

    setError(null);
    setPublishUrl(null);
    setIsPublishing(true);

    try {
      const comments = selectedFindings
        .filter((finding) => finding.position !== null)
        .map((finding) => ({
          path: finding.filePath,
          position: finding.position as number,
          body: formatInlineComment(finding)
        }));

      const response = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prUrl,
          githubToken: githubToken.trim() || undefined,
          body: report.publishDraft,
          event: 'COMMENT',
          comments
        })
      });

      const data = (await response.json()) as PublishResponse;
      if (!response.ok || !data.result) {
        throw new Error(data.error || '发布失败');
      }

      setPublishUrl(data.result.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '发布失败');
    } finally {
      setIsPublishing(false);
    }
  }

  function toggleFinding(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function sendFeedback(finding: ReviewFinding, verdict: 'false_positive' | 'valid' | 'ignored') {
    if (!report) return;

    setFeedbackStatus((current) => ({ ...current, [finding.id]: '提交中' }));

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportId: report.id,
          findingId: finding.id,
          prUrl: report.snapshot.metadata.url,
          repositoryFullName: `${report.snapshot.metadata.owner}/${report.snapshot.metadata.repo}`,
          actor: 'web-user',
          verdict,
          note: `Marked from web UI as ${verdict}`
        })
      });

      if (!response.ok) {
        throw new Error('反馈提交失败');
      }

      setFeedbackStatus((current) => ({ ...current, [finding.id]: verdictLabel(verdict) }));
    } catch (caught) {
      setFeedbackStatus((current) => ({
        ...current,
        [finding.id]: caught instanceof Error ? caught.message : '反馈提交失败'
      }));
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <div className="brand">
            <GitPullRequest size={22} />
            <span>PR Insight AI</span>
          </div>
          <h1>GitHub PR AI 代码评审控制台</h1>
        </div>
        <div className="top-note">GitHub App 自动评审 + Web 手动补跑</div>
      </section>

      <form className="control-panel" onSubmit={analyze}>
        <div className="integration-note">
          生产使用时将 GitHub App webhook 指向 <code>/api/github/webhook</code>，PR opened / synchronize 后会自动发布评审意见。此页面用于手动分析、调试和补跑。
        </div>
        <div className="field grow">
          <label htmlFor="pr-url">GitHub PR 链接</label>
          <input
            id="pr-url"
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            placeholder="https://github.com/org/repo/pull/123"
            required
          />
        </div>
        <div className="field token-field">
          <label htmlFor="github-token">GitHub Token</label>
          <input
            id="github-token"
            value={githubToken}
            onChange={(event) => setGithubToken(event.target.value)}
            placeholder="私有仓库或发布 review 时填写"
            type="password"
          />
        </div>
        <div className="field mode-field">
          <label htmlFor="mode">模式</label>
          <select id="mode" value={mode} onChange={(event) => setMode(event.target.value as 'fast' | 'deep')}>
            <option value="deep">深度分析</option>
            <option value="fast">快速分析</option>
          </select>
        </div>
        <button className="primary-button" disabled={isAnalyzing}>
          {isAnalyzing ? <Loader2 className="spin" size={18} /> : <Code2 size={18} />}
          {isAnalyzing ? '分析中' : 'Analyze PR'}
        </button>
      </form>

      {error ? (
        <section className="alert error-alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </section>
      ) : null}

      {publishUrl ? (
        <section className="alert success-alert">
          <CheckCircle2 size={18} />
          <span>Review 已发布：</span>
          <a href={publishUrl} target="_blank" rel="noreferrer">
            打开 GitHub
          </a>
        </section>
      ) : null}

      {isAnalyzing ? <LoadingState /> : null}

      {report ? (
        <section className="report-grid">
          <Overview report={report} />
          <Summary report={report} />
          <RiskPanel report={report} />
          <Findings
            findings={report.findings}
            selectedIds={selectedIds}
            onToggle={toggleFinding}
            feedbackStatus={feedbackStatus}
            onFeedback={sendFeedback}
          />
          <PublishPanel
            report={report}
            selectedCount={selectedFindings.length}
            onPublish={publishReview}
            isPublishing={isPublishing}
          />
        </section>
      ) : null}
    </main>
  );
}

function LoadingState() {
  return (
    <section className="loading-state">
      <Loader2 className="spin" size={22} />
      <div>
        <strong>正在拉取 PR 并执行分析</strong>
        <p>系统会先解析 diff 和风险规则，再调用 AI 生成结构化评审报告。</p>
      </div>
    </section>
  );
}

function Overview({ report }: { report: ReviewReport }) {
  const { metadata, checks } = report.snapshot;
  return (
    <section className="panel overview-panel">
      <div className="panel-title">
        <ClipboardList size={18} />
        <h2>PR 概览</h2>
      </div>
      <div className="metric-grid">
        <Metric label="风险评分" value={report.riskScore.overall.toString()} tone={report.riskScore.overall >= 65 ? 'danger' : report.riskScore.overall >= 35 ? 'warning' : 'ok'} />
        <Metric label="变更文件" value={metadata.changedFiles.toString()} />
        <Metric label="新增/删除" value={`+${metadata.additions} / -${metadata.deletions}`} />
        <Metric label="Checks" value={checks.conclusionSummary} tone={checks.failed > 0 ? 'danger' : 'ok'} />
      </div>
      <div className="pr-meta">
        <a href={metadata.url} target="_blank" rel="noreferrer">
          #{metadata.number} {metadata.title}
        </a>
        <span>{metadata.author}</span>
        <span>{metadata.headRef} → {metadata.baseRef}</span>
        <span>{report.aiEnabled ? `AI: ${report.model}` : '规则分析模式'}</span>
        <span>{Math.round(report.elapsedMs / 100) / 10}s</span>
      </div>
    </section>
  );
}

function Summary({ report }: { report: ReviewReport }) {
  const { summary } = report;
  return (
    <section className="panel summary-panel">
      <div className="panel-title">
        <MessageSquare size={18} />
        <h2>变更总结</h2>
      </div>
      <p className="headline">{summary.headline}</p>
      <div className="summary-list">
        <SummaryRow label="业务变更" value={summary.businessChange} />
        <SummaryRow label="技术变更" value={summary.technicalChange} />
        <SummaryRow label="依赖变更" value={summary.dependencyChange} />
        <SummaryRow label="架构影响" value={summary.architectureImpact} />
        <SummaryRow label="测试覆盖" value={summary.testCoverage} />
      </div>
      <div className="tag-row">
        {summary.modules.map((module) => (
          <span key={module} className="tag">{module}</span>
        ))}
      </div>
    </section>
  );
}

function RiskPanel({ report }: { report: ReviewReport }) {
  const scores = report.riskScore;
  return (
    <section className="panel risk-panel">
      <div className="panel-title">
        <ShieldAlert size={18} />
        <h2>风险分布</h2>
      </div>
      <div className="score-bars">
        <ScoreBar label="安全" value={scores.security} />
        <ScoreBar label="正确性" value={scores.correctness} />
        <ScoreBar label="性能" value={scores.performance} />
        <ScoreBar label="兼容性" value={scores.compatibility} />
        <ScoreBar label="测试" value={scores.test} />
        <ScoreBar label="可维护性" value={scores.maintainability} />
      </div>
      {report.missingContext.length ? (
        <div className="context-note">
          <strong>上下文缺口</strong>
          {report.missingContext.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Findings({
  findings,
  selectedIds,
  onToggle,
  feedbackStatus,
  onFeedback
}: {
  findings: ReviewFinding[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  feedbackStatus: Record<string, string>;
  onFeedback: (finding: ReviewFinding, verdict: 'false_positive' | 'valid' | 'ignored') => void;
}) {
  return (
    <section className="panel findings-panel">
      <div className="panel-title">
        <FileWarning size={18} />
        <h2>Review 建议</h2>
      </div>
      {findings.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={20} />
          <span>未识别到明确风险。仍建议 reviewer 结合业务上下文完成最终确认。</span>
        </div>
      ) : (
        <div className="finding-list">
          {findings.map((finding) => (
            <article className="finding-card" key={finding.id}>
              <div className="finding-head">
                <label className="select-line">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(finding.id)}
                    onChange={() => onToggle(finding.id)}
                    disabled={finding.position === null}
                  />
                  <span>{finding.position === null ? '文件级展示' : '可发布行评'}</span>
                </label>
                <div className="badges">
                  <span className={`badge severity-${finding.severity}`}>{severityLabel[finding.severity]}</span>
                  <span className="badge">{levelLabel[finding.recommendationLevel]}</span>
                  <span className="badge">{categoryLabel[finding.category]}</span>
                  <span className="badge">{Math.round(finding.confidence * 100)}%</span>
                </div>
              </div>
              <h3>{finding.title}</h3>
              <div className="location">
                {finding.filePath}
                {finding.lineStart ? `:${finding.lineStart}` : ''}
              </div>
              <p>{finding.problem}</p>
              <p className="impact">{finding.impact}</p>
              <div className="evidence">
                {finding.evidence.slice(0, 3).map((item, index) => (
                  <code key={`${finding.id}-${index}`}>{item}</code>
                ))}
              </div>
              <div className="suggestion">
                <ChevronRight size={16} />
                <span>{finding.suggestion}</span>
              </div>
              <div className="feedback-actions">
                <span>反馈闭环</span>
                <button type="button" onClick={() => onFeedback(finding, 'valid')}>有效</button>
                <button type="button" onClick={() => onFeedback(finding, 'false_positive')}>误报</button>
                <button type="button" onClick={() => onFeedback(finding, 'ignored')}>忽略</button>
                {feedbackStatus[finding.id] ? <strong>{feedbackStatus[finding.id]}</strong> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function verdictLabel(verdict: 'false_positive' | 'valid' | 'ignored') {
  if (verdict === 'false_positive') return '已标记误报';
  if (verdict === 'valid') return '已标记有效';
  return '已标记忽略';
}

function PublishPanel({
  report,
  selectedCount,
  onPublish,
  isPublishing
}: {
  report: ReviewReport;
  selectedCount: number;
  onPublish: () => void;
  isPublishing: boolean;
}) {
  return (
    <section className="panel publish-panel">
      <div className="panel-title">
        <Send size={18} />
        <h2>GitHub Review 发布预览</h2>
      </div>
      <textarea readOnly value={report.publishDraft} />
      <div className="publish-actions">
        <span>已选择 {selectedCount} 条可定位建议作为 inline comment。</span>
        <button className="secondary-button" onClick={onPublish} disabled={isPublishing}>
          {isPublishing ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          {isPublishing ? '发布中' : 'Post review'}
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'danger' | 'warning' | 'ok' }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-row">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-row">
      <span>{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(4, value)}%` }} />
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function formatInlineComment(finding: ReviewFinding): string {
  return [
    `**${levelLabel[finding.recommendationLevel]}：${finding.title}**`,
    '',
    finding.problem,
    '',
    `影响：${finding.impact}`,
    '',
    `建议：${finding.suggestion}`,
    '',
    '_AI 辅助评审建议，请结合业务上下文确认。_'
  ].join('\n');
}
