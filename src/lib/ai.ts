import OpenAI from 'openai';
import { candidatesToFindings } from './report';
import {
  AskResponse,
  ConversationMessage,
  FixSuggestion,
  PullRequestSnapshot,
  ReviewFinding,
  ReviewReport,
  ReviewSummary,
  RiskCandidate
} from './types';
import { buildReport } from './report';

type AiAnalysis = {
  summary: ReviewSummary;
  findings: ReviewFinding[];
  missingContext: string[];
  followUps: string[];
};

const REVIEW_SCHEMA = {
  name: 'pr_review_analysis',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings', 'missingContext', 'followUps'],
    properties: {
      summary: {
        type: 'object',
        additionalProperties: false,
        required: [
          'headline',
          'businessChange',
          'technicalChange',
          'modules',
          'dependencyChange',
          'architectureImpact',
          'testCoverage',
          'reviewerFocus',
          'inferredFacts'
        ],
        properties: {
          headline: { type: 'string' },
          businessChange: { type: 'string' },
          technicalChange: { type: 'string' },
          modules: { type: 'array', items: { type: 'string' } },
          dependencyChange: { type: 'string' },
          architectureImpact: { type: 'string' },
          testCoverage: { type: 'string' },
          reviewerFocus: { type: 'array', items: { type: 'string' } },
          inferredFacts: { type: 'array', items: { type: 'string' } }
        }
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'filePath',
            'lineStart',
            'lineEnd',
            'position',
            'category',
            'severity',
            'confidence',
            'recommendationLevel',
            'title',
            'problem',
            'impact',
            'evidence',
            'suggestion',
            'postToGitHub',
            'source'
          ],
          properties: {
            id: { type: 'string' },
            filePath: { type: 'string' },
            lineStart: { type: ['number', 'null'] },
            lineEnd: { type: ['number', 'null'] },
            position: { type: ['number', 'null'] },
            category: {
              type: 'string',
              enum: ['security', 'correctness', 'performance', 'compatibility', 'maintainability', 'test', 'style']
            },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            confidence: { type: 'number' },
            recommendationLevel: { type: 'string', enum: ['must_fix', 'should_improve', 'for_reference'] },
            title: { type: 'string' },
            problem: { type: 'string' },
            impact: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            suggestion: { type: 'string' },
            postToGitHub: { type: 'boolean' },
            source: { type: 'string', enum: ['ai', 'rule', 'merged'] }
          }
        }
      },
      missingContext: { type: 'array', items: { type: 'string' } },
      followUps: { type: 'array', items: { type: 'string' } }
    }
  },
  strict: true
} as const;

const ASK_RESPONSE_SCHEMA = {
  name: 'ask_response',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'relatedFindings', 'referencedFiles'],
    properties: {
      answer: { type: 'string' },
      relatedFindings: {
        type: 'array',
        items: { type: 'string' }
      },
      referencedFiles: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  },
  strict: true
} as const;

const FIX_SUGGESTION_SCHEMA = {
  name: 'fix_suggestion',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findingId', 'title', 'explanation', 'codeBlocks', 'considerations', 'testSuggestions'],
    properties: {
      findingId: { type: 'string' },
      title: { type: 'string' },
      explanation: { type: 'string' },
      codeBlocks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['filename', 'language', 'originalCode', 'suggestedCode'],
          properties: {
            filename: { type: 'string' },
            language: { type: 'string' },
            originalCode: { type: 'string' },
            suggestedCode: { type: 'string' },
            lineStart: { type: ['number', 'null'] },
            lineEnd: { type: ['number', 'null'] }
          }
        }
      },
      considerations: {
        type: 'array',
        items: { type: 'string' }
      },
      testSuggestions: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  },
  strict: true
} as const;

const DEEPSEEK_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';

function createClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL
  });
}

export async function analyzeWithAi(input: {
  snapshot: PullRequestSnapshot;
  candidates: RiskCandidate[];
  startedAt: number;
  mode?: 'fast' | 'deep';
}): Promise<ReviewReport> {
  const apiKey = process.env.OPENAI_API_KEY;
  // DeepSeek 模型默认值
  const model = process.env.OPENAI_MODEL || 'deepseek-chat';
  const fastModel = process.env.OPENAI_FAST_MODEL || 'deepseek-chat';
  const ruleFindings = candidatesToFindings(input.candidates);

  if (!apiKey) {
    return buildReport({
      snapshot: input.snapshot,
      findings: ruleFindings,
      startedAt: input.startedAt,
      aiEnabled: false,
      model: null,
      fastModel: null,
      missingContext: ['未配置 OPENAI_API_KEY，本次仅返回规则分析结果。']
    });
  }

  try {
    const client = createClient(apiKey);
    const analysis = await requestAiReview(client, {
      snapshot: input.snapshot,
      candidates: input.candidates,
      model: input.mode === 'fast' ? fastModel : model
    });

    const merged = mergeFindings(ruleFindings, analysis.findings);
    return buildReport({
      snapshot: input.snapshot,
      summary: analysis.summary,
      findings: merged,
      missingContext: analysis.missingContext,
      followUps: analysis.followUps,
      startedAt: input.startedAt,
      aiEnabled: true,
      model,
      fastModel
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知模型调用错误';
    return buildReport({
      snapshot: input.snapshot,
      findings: ruleFindings,
      startedAt: input.startedAt,
      aiEnabled: false,
      model,
      fastModel,
      missingContext: [`AI 分析失败，已降级为规则分析：${message}`]
    });
  }
}

async function requestAiReview(client: OpenAI, input: {
  snapshot: PullRequestSnapshot;
  candidates: RiskCandidate[];
  model: string;
}): Promise<AiAnalysis> {
  const prompt = buildReviewPrompt(input.snapshot, input.candidates);
  const response = await client.chat.completions.create({
    model: input.model,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: REVIEW_SCHEMA
    },
    messages: [
      {
        role: 'system',
        content:
          '你是企业级 GitHub PR 代码评审助手。你必须基于提供的 PR diff 和上下文输出结构化 JSON。没有证据的问题必须降级或放入 missingContext，禁止编造不存在的代码。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('模型未返回内容');
  }

  return JSON.parse(content) as AiAnalysis;
}

function buildReviewPrompt(snapshot: PullRequestSnapshot, candidates: RiskCandidate[]): string {
  const files = snapshot.files.map((file) => ({
    filename: file.filename,
    status: file.status,
    language: file.language,
    additions: file.additions,
    deletions: file.deletions,
    riskTags: file.riskTags,
    patch: trimPatch(file.patch)
  }));

  const payload = {
    pr: {
      title: snapshot.metadata.title,
      body: snapshot.metadata.body,
      author: snapshot.metadata.author,
      baseRef: snapshot.metadata.baseRef,
      headRef: snapshot.metadata.headRef,
      additions: snapshot.metadata.additions,
      deletions: snapshot.metadata.deletions,
      changedFiles: snapshot.metadata.changedFiles,
      checks: snapshot.checks
    },
    commits: snapshot.commits.slice(0, 20),
    files,
    ruleCandidates: candidates.slice(0, 40)
  };

  return [
    '请分析以下 GitHub PR。',
    '',
    '输出要求：',
    '- 生成简洁但完整的 PR 变更总结。',
    '- 识别真实且有证据的风险代码。',
    '- 每条 finding 必须引用 evidence。',
    '- lineStart/lineEnd 使用新文件行号；无法定位时填 null。',
    '- position 使用 diff position；无法定位时填 null。',
    '- postToGitHub 只对高价值、高置信度、可定位问题设为 true。',
    '- 建议等级只能是 must_fix、should_improve、for_reference。',
    '',
    JSON.stringify(payload, null, 2)
  ].join('\n');
}

function trimPatch(patch: string | null, max: number = 9000): string | null {
  if (!patch) return null;
  if (patch.length <= max) return patch;
  return `${patch.slice(0, max)}\n... [patch truncated for context budget]`;
}

function mergeFindings(ruleFindings: ReviewFinding[], aiFindings: ReviewFinding[]): ReviewFinding[] {
  const normalizedAi = aiFindings.map((finding, index) => ({
    ...finding,
    id: finding.id || `ai-${index}`,
    confidence: Math.max(0, Math.min(1, finding.confidence)),
    postToGitHub: Boolean(finding.postToGitHub && finding.position !== null && finding.confidence >= 0.72)
  }));

  return [...ruleFindings, ...normalizedAi];
}

export async function askQuestion(input: {
  snapshot: PullRequestSnapshot;
  question: string;
  report: ReviewReport | null;
  conversationHistory?: ConversationMessage[];
}): Promise<AskResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  const fastModel = process.env.OPENAI_FAST_MODEL || 'deepseek-chat';

  if (!apiKey) {
    return {
      answer: '未配置 OPENAI_API_KEY，无法回答问题。',
      relatedFindings: [],
      referencedFiles: []
    };
  }

  const client = createClient(apiKey);
  const prompt = buildAskPrompt(input.snapshot, input.question, input.report, input.conversationHistory);

  const response = await client.chat.completions.create({
    model: fastModel,
    temperature: 0.3,
    response_format: {
      type: 'json_schema',
      json_schema: ASK_RESPONSE_SCHEMA
    },
    messages: [
      {
        role: 'system',
        content: '你是企业级 GitHub PR 代码评审助手。回答用户关于 PR 的问题时，必须基于提供的 PR diff 和上下文。如果问题超出 PR 范围或无法从上下文中回答，请诚实说明。注意用户可能在追问之前的对话，请结合历史上下文回答。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('模型未返回内容');
  }

  return JSON.parse(content) as AskResponse;
}

function buildAskPrompt(
  snapshot: PullRequestSnapshot,
  question: string,
  report: ReviewReport | null,
  conversationHistory?: ConversationMessage[]
): string {
  const files = snapshot.files.map(file => ({
    filename: file.filename,
    status: file.status,
    language: file.language,
    additions: file.additions,
    deletions: file.deletions,
    patch: trimPatch(file.patch)
  }));

  const relevantFindings = report?.findings.slice(0, 10).map(f => ({
    id: f.id,
    title: f.title,
    filePath: f.filePath,
    problem: f.problem,
    suggestion: f.suggestion
  })) || [];

  const historySection = conversationHistory && conversationHistory.length > 0
    ? [
        '',
        '## 最近对话历史',
        '以下是用户与机器人最近的对话，请结合历史上下文回答当前问题：',
        '',
        ...conversationHistory
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .map(m => `${m.role === 'user' ? '用户' : '机器人'}: ${m.content.slice(0, 500)}`),
        ''
      ]
    : [];

  return [
    '请回答用户关于以下 GitHub PR 的问题。',
    '',
    '## PR 信息',
    `- 标题: ${snapshot.metadata.title}`,
    `- 作者: ${snapshot.metadata.author}`,
    `- 分支: ${snapshot.metadata.baseRef} <- ${snapshot.metadata.headRef}`,
    `- 变更: +${snapshot.metadata.additions} / -${snapshot.metadata.deletions}`,
    '',
    '## PR 描述',
    snapshot.metadata.body || '(无描述)',
    '',
    '## 变更文件',
    JSON.stringify(files, null, 2),
    '',
    '## 已识别的建议',
    relevantFindings.length ? JSON.stringify(relevantFindings, null, 2) : '(暂无)',
    ...historySection,
    '',
    '## 用户问题',
    question,
    '',
    '## 回答要求',
    '- 回答必须基于提供的 PR 上下文',
    '- 如果用户在追问之前的对话，请结合历史上下文回答',
    '- 如果问题涉及具体代码，引用相关文件和行号',
    '- 如果问题超出 PR 范围，诚实说明',
    '- 如果与已识别的建议相关，列出建议 ID',
    '- 使用简洁专业的中文回答'
  ].join('\n');
}

export async function generateFixSuggestion(input: {
  snapshot: PullRequestSnapshot;
  finding: ReviewFinding;
}): Promise<FixSuggestion> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'deepseek-chat';

  if (!apiKey) {
    throw new Error('未配置 OPENAI_API_KEY，无法生成修复建议。');
  }

  const client = createClient(apiKey);
  const prompt = buildFixPrompt(input.snapshot, input.finding);

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: FIX_SUGGESTION_SCHEMA
    },
    messages: [
      {
        role: 'system',
        content: '你是企业级 GitHub PR 代码评审助手。生成修复代码时，必须基于提供的 PR diff，确保代码风格一致、逻辑正确、与现有代码兼容。如果无法生成可靠的修复代码，请在 considerations 中说明原因。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('模型未返回内容');
  }

  return JSON.parse(content) as FixSuggestion;
}

function buildFixPrompt(snapshot: PullRequestSnapshot, finding: ReviewFinding): string {
  const targetFile = snapshot.files.find(f => f.filename === finding.filePath);

  const contextFiles = snapshot.files
    .filter(f => f.filename !== finding.filePath)
    .slice(0, 3)
    .map(f => ({
      filename: f.filename,
      language: f.language,
      patch: trimPatch(f.patch, 3000)
    }));

  return [
    '请为以下 PR 评审建议生成具体的修复代码。',
    '',
    '## PR 信息',
    `- 标题: ${snapshot.metadata.title}`,
    `- 作者: ${snapshot.metadata.author}`,
    '',
    '## 目标建议',
    `- ID: ${finding.id}`,
    `- 标题: ${finding.title}`,
    `- 文件: ${finding.filePath}`,
    `- 行号: ${finding.lineStart ?? '未知'} - ${finding.lineEnd ?? '未知'}`,
    `- 类别: ${finding.category}`,
    `- 严重性: ${finding.severity}`,
    `- 置信度: ${Math.round(finding.confidence * 100)}%`,
    '',
    '## 问题描述',
    finding.problem,
    '',
    '## 影响',
    finding.impact,
    '',
    '## 现有建议',
    finding.suggestion,
    '',
    '## 证据',
    ...finding.evidence.map(e => `- ${e}`),
    '',
    '## 目标文件变更',
    targetFile ? JSON.stringify({
      filename: targetFile.filename,
      status: targetFile.status,
      language: targetFile.language,
      additions: targetFile.additions,
      deletions: targetFile.deletions,
      patch: trimPatch(targetFile.patch, 6000)
    }, null, 2) : '(文件未在变更列表中)',
    '',
    '## 相关文件变更',
    contextFiles.length ? JSON.stringify(contextFiles, null, 2) : '(无相关文件)',
    '',
    '## 输出要求',
    '- 生成可应用的修复代码，保持与现有代码风格一致',
    '- originalCode: 需要修改的原始代码片段',
    '- suggestedCode: 修复后的代码片段',
    '- 如果需要多个文件修改，提供多个 codeBlock',
    '- 在 considerations 中说明潜在风险和注意事项',
    '- 在 testSuggestions 中建议相关的测试用例',
    '- 如果无法生成可靠的修复代码，在 considerations 中说明原因'
  ].join('\n');
}
