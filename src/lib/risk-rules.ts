import { ChangedFile, FindingCategory, RecommendationLevel, RiskCandidate, Severity } from './types';
import { getAddedLines } from './parse-diff';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  jsx: 'JavaScript React',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  java: 'Java',
  kt: 'Kotlin',
  go: 'Go',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  sql: 'SQL',
  yml: 'YAML',
  yaml: 'YAML',
  json: 'JSON',
  toml: 'TOML',
  xml: 'XML',
  md: 'Markdown'
};

const FILE_TAG_RULES: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /auth|permission|acl|rbac|oauth|jwt|session/i, tag: '权限/认证敏感文件' },
  { pattern: /migration|schema|database|repository|dao|model/i, tag: '数据层变更' },
  { pattern: /package-lock|yarn\.lock|pnpm-lock|package\.json|requirements|pom\.xml|build\.gradle/i, tag: '依赖或构建变更' },
  { pattern: /\.env|secret|credential|private|certificate|key/i, tag: '敏感配置风险' },
  { pattern: /test|spec|__tests__/i, tag: '测试相关变更' },
  { pattern: /route|controller|api|endpoint/i, tag: '公共接口变更' }
];

type Rule = {
  id: string;
  category: FindingCategory;
  severity: Severity;
  recommendationLevel: RecommendationLevel;
  title: string;
  pattern: RegExp;
  reason: string;
};

const LINE_RULES: Rule[] = [
  {
    id: 'hardcoded-secret',
    category: 'security',
    severity: 'critical',
    recommendationLevel: 'must_fix',
    title: '疑似硬编码敏感信息',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i,
    reason: '新增代码中出现疑似密钥、token 或密码，可能导致敏感信息泄露。'
  },
  {
    id: 'sql-concat',
    category: 'security',
    severity: 'high',
    recommendationLevel: 'must_fix',
    title: '疑似 SQL 拼接风险',
    pattern: /(select|insert|update|delete)\s+.*(\+|\$\{)/i,
    reason: '新增代码疑似通过字符串拼接构造 SQL，存在注入或转义遗漏风险。'
  },
  {
    id: 'command-exec',
    category: 'security',
    severity: 'high',
    recommendationLevel: 'must_fix',
    title: '命令执行调用需要人工确认输入来源',
    pattern: /\b(exec|execSync|spawn|spawnSync|system|popen|subprocess)\s*\(/i,
    reason: '新增代码包含命令执行能力，若参数来自用户输入可能导致命令注入。'
  },
  {
    id: 'unsafe-html',
    category: 'security',
    severity: 'high',
    recommendationLevel: 'must_fix',
    title: '不安全 HTML 注入风险',
    pattern: /(dangerouslySetInnerHTML|innerHTML\s*=)/,
    reason: '新增代码直接注入 HTML，需要确认内容已清洗并防止 XSS。'
  },
  {
    id: 'missing-await',
    category: 'correctness',
    severity: 'medium',
    recommendationLevel: 'should_improve',
    title: 'Promise 错误处理或等待逻辑需要确认',
    pattern: /\.(then|catch)\(|new Promise|Promise\.all\(/,
    reason: '新增异步流程需要确认错误处理、等待顺序和并发副作用。'
  },
  {
    id: 'unbounded-loop',
    category: 'performance',
    severity: 'medium',
    recommendationLevel: 'should_improve',
    title: '循环中的外部调用或重计算需要关注性能',
    pattern: /(forEach|for\s*\(|while\s*\().*(fetch|query|request|axios|http)/i,
    reason: '新增循环中疑似包含外部请求或查询，可能造成 N+1 或延迟放大。'
  },
  {
    id: 'todo-in-change',
    category: 'maintainability',
    severity: 'low',
    recommendationLevel: 'for_reference',
    title: '新增 TODO/FIXME 需要确认是否影响交付',
    pattern: /\b(TODO|FIXME|HACK)\b/i,
    reason: '新增代码包含待办标记，建议确认是否应在合并前处理。'
  },
  {
    id: 'console-log',
    category: 'maintainability',
    severity: 'low',
    recommendationLevel: 'for_reference',
    title: '新增调试日志需要确认',
    pattern: /\bconsole\.(log|debug|warn|error)\s*\(/,
    reason: '新增 console 输出可能不符合生产日志规范。'
  }
];

export function detectLanguage(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_BY_EXTENSION[extension] || 'Unknown';
}

export function tagFileRisk(filename: string, language: string, status: string, patch: string): string[] {
  const tags = new Set<string>();

  for (const rule of FILE_TAG_RULES) {
    if (rule.pattern.test(filename)) {
      tags.add(rule.tag);
    }
  }

  if (status === 'removed') {
    tags.add('删除文件');
  }

  if (patch.length > 12000) {
    tags.add('大文件变更');
  }

  if (language === 'Unknown') {
    tags.add('未知语言或二进制文件');
  }

  return Array.from(tags);
}

export function findRiskCandidates(files: ChangedFile[]): RiskCandidate[] {
  const candidates: RiskCandidate[] = [];

  for (const file of files) {
    for (const line of getAddedLines(file.hunks)) {
      for (const rule of LINE_RULES) {
        if (!rule.pattern.test(line.content)) {
          continue;
        }

        candidates.push({
          id: `rule-${rule.id}-${file.filename}-${line.newLine || line.position}`,
          filePath: file.filename,
          lineStart: line.newLine,
          lineEnd: line.newLine,
          position: line.position,
          category: rule.category,
          severity: rule.severity,
          confidence: rule.severity === 'critical' ? 0.9 : 0.72,
          title: rule.title,
          reason: rule.reason,
          evidence: [`+${line.content.trim()}`],
          recommendationLevel: rule.recommendationLevel,
          source: 'rule'
        });
      }
    }

    if (!file.riskTags.length) {
      continue;
    }

    const significantTag = file.riskTags.find((tag) => tag !== '测试相关变更');
    if (significantTag && (file.additions + file.deletions > 20 || significantTag.includes('敏感') || significantTag.includes('数据'))) {
      candidates.push({
        id: `rule-file-${file.filename}-${significantTag}`,
        filePath: file.filename,
        lineStart: null,
        lineEnd: null,
        position: null,
        category: categoryForTag(significantTag),
        severity: severityForTag(significantTag),
        confidence: 0.62,
        title: `${significantTag}需要重点 Review`,
        reason: `该文件命中「${significantTag}」，且本次变更规模或敏感度较高。`,
        evidence: [`${file.status}: +${file.additions} / -${file.deletions}`],
        recommendationLevel: significantTag.includes('敏感') || significantTag.includes('数据') ? 'must_fix' : 'should_improve',
        source: 'rule'
      });
    }
  }

  return dedupeCandidates(candidates);
}

function categoryForTag(tag: string): FindingCategory {
  if (tag.includes('权限') || tag.includes('敏感')) return 'security';
  if (tag.includes('数据')) return 'correctness';
  if (tag.includes('依赖') || tag.includes('公共接口')) return 'compatibility';
  if (tag.includes('测试')) return 'test';
  return 'maintainability';
}

function severityForTag(tag: string): Severity {
  if (tag.includes('敏感')) return 'high';
  if (tag.includes('权限') || tag.includes('数据')) return 'medium';
  return 'low';
}

function dedupeCandidates(candidates: RiskCandidate[]): RiskCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.filePath}:${candidate.lineStart}:${candidate.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
