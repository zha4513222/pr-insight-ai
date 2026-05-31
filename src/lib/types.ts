export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RecommendationLevel = 'must_fix' | 'should_improve' | 'for_reference';

export type FindingCategory =
  | 'security'
  | 'correctness'
  | 'performance'
  | 'compatibility'
  | 'maintainability'
  | 'test'
  | 'style';

export type PrIdentity = {
  owner: string;
  repo: string;
  number: number;
};

export type PrMetadata = PrIdentity & {
  url: string;
  title: string;
  body: string;
  author: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type CommitInfo = {
  sha: string;
  author: string;
  message: string;
  date: string | null;
};

export type CheckInfo = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  conclusionSummary: string;
};

export type DiffLine = {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLine: number | null;
  newLine: number | null;
  position: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  previousFilename: string | null;
  hunks: DiffHunk[];
  language: string;
  riskTags: string[];
};

export type PullRequestSnapshot = {
  metadata: PrMetadata;
  commits: CommitInfo[];
  files: ChangedFile[];
  checks: CheckInfo;
  fetchedAt: string;
};

export type RiskCandidate = {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  position: number | null;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  title: string;
  reason: string;
  evidence: string[];
  recommendationLevel: RecommendationLevel;
  source: 'rule';
};

export type ReviewFinding = {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  position: number | null;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  recommendationLevel: RecommendationLevel;
  title: string;
  problem: string;
  impact: string;
  evidence: string[];
  suggestion: string;
  postToGitHub: boolean;
  source: 'ai' | 'rule' | 'merged';
};

export type ReviewSummary = {
  headline: string;
  businessChange: string;
  technicalChange: string;
  modules: string[];
  dependencyChange: string;
  architectureImpact: string;
  testCoverage: string;
  reviewerFocus: string[];
  inferredFacts: string[];
};

export type RiskScore = {
  overall: number;
  security: number;
  correctness: number;
  performance: number;
  compatibility: number;
  test: number;
  maintainability: number;
};

export type ReviewReport = {
  id: string;
  generatedAt: string;
  aiEnabled: boolean;
  model: string | null;
  fastModel: string | null;
  elapsedMs: number;
  snapshot: PullRequestSnapshot;
  summary: ReviewSummary;
  riskScore: RiskScore;
  findings: ReviewFinding[];
  missingContext: string[];
  followUps: string[];
  publishDraft: string;
};

export type AnalyzeRequest = {
  prUrl: string;
  githubToken?: string;
  mode?: 'fast' | 'deep';
};

export type PublishReviewRequest = {
  prUrl: string;
  githubToken?: string;
  body: string;
  event?: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: Array<{
    path: string;
    position: number;
    body: string;
  }>;
};

export type ReviewJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type ReviewJobType = 'pr_review' | 'comment_bot';

export type ReviewJob = {
  id: string;
  type: ReviewJobType;
  status: ReviewJobStatus;
  prUrl: string;
  repositoryFullName: string | null;
  installationId: number | null;
  action: string;
  headSha: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  reportId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AuditEventType =
  | 'job.queued'
  | 'job.started'
  | 'job.succeeded'
  | 'job.failed'
  | 'review.published'
  | 'comment.received'
  | 'bot.replied'
  | 'feedback.recorded'
  | 'manual.analyzed';

export type AuditEvent = {
  id: string;
  type: AuditEventType;
  jobId?: string;
  prUrl?: string;
  repositoryFullName?: string | null;
  actor?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type FeedbackVerdict = 'false_positive' | 'valid' | 'ignored' | 'needs_more_context';

export type FindingFeedback = {
  id: string;
  reportId: string | null;
  findingId: string | null;
  prUrl: string;
  repositoryFullName: string | null;
  actor: string;
  verdict: FeedbackVerdict;
  note: string;
  sourceCommentUrl: string | null;
  createdAt: string;
};

export type BotIntent = 'feedback' | 'explain' | 'reanalyze' | 'help' | 'ask' | 'fix' | 'follow_up';

export type AskResponse = {
  answer: string;
  relatedFindings: string[];
  referencedFiles: string[];
};

export type FixSuggestion = {
  findingId: string;
  title: string;
  explanation: string;
  codeBlocks: Array<{
    filename: string;
    language: string;
    originalCode: string;
    suggestedCode: string;
    lineStart: number | null;
    lineEnd: number | null;
  }>;
  considerations: string[];
  testSuggestions: string[];
};

export type ConversationMessage = {
  id: string;
  prUrl: string;
  reportId: string | null;
  role: 'user' | 'assistant';
  intent: string | null;
  findingId: string | null;
  content: string;
  sourceCommentUrl: string | null;
  actor: string;
  createdAt: string;
};

export type PersistedState = {
  jobs: ReviewJob[];
  reports: ReviewReport[];
  feedback: FindingFeedback[];
  conversations: ConversationMessage[];
};
