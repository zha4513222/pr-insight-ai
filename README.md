# PR Insight AI

AI-assisted GitHub Pull Request review console.

## Capabilities

- Analyze public or private GitHub PRs.
- Run as a GitHub App and automatically review PRs from webhook events.
- Fetch PR metadata, commits, changed files, patches, and check status.
- Parse line-level diffs and map findings to changed lines.
- Run deterministic risk rules before AI review.
- Use OpenAI structured analysis when `OPENAI_API_KEY` is configured.
- Fall back to a rules-only report when AI credentials are unavailable.
- Preview and optionally publish a GitHub PR review.

## Configuration

Create `.env.local` from `.env.example`.

- `OPENAI_API_KEY`: enables AI summaries and review findings.
- `OPENAI_MODEL`: deep review model, defaults to `gpt-5.5`.
- `OPENAI_FAST_MODEL`: summary/classification model, defaults to `gpt-5.4-mini`.
- `GITHUB_TOKEN`: optional server-side token for private repositories.

Users can also paste a GitHub token into the UI for a single analysis or publish request.

## GitHub App Integration

Create a GitHub App and point its webhook URL to:

`https://<your-domain>/api/github/webhook`

Minimum permissions:

- Metadata: read
- Contents: read
- Pull requests: read and write
- Checks: read
- Issues: read and write

Subscribe to these events:

- `Pull request`
- `Issue comment`

The app reviews `opened`, `reopened`, `synchronize`, and `ready_for_review` PR actions.

Set these environment variables:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

The webhook posts a PR review automatically. It includes a hidden marker containing the PR URL and head SHA so repeated webhook deliveries do not duplicate reviews for the same commit.

## Persistence, Queue, and Feedback

The MVP includes a file-backed persistence adapter under `.data`:

- `state.json`: jobs, reports, finding feedback, and conversation history
- `audit.jsonl`: append-only audit events

GitHub webhooks enqueue jobs and return immediately. An in-process queue then runs PR analysis, publishes reviews, and records audit events. For production, replace this adapter with PostgreSQL plus a durable worker queue such as Redis/BullMQ or a cloud task queue.

## PR Comment Bot

On a PR, comment with `/pr-insight` to talk to the review bot:

- `/pr-insight ask <问题>` - 询问关于 PR 的任意问题
- `/pr-insight what <术语/代码>` - 解释 PR 中的概念或代码
- `/pr-insight explain finding:<finding-id>` - 解释某条建议的详情
- `/pr-insight fix finding:<finding-id>` - 生成修复代码建议
- `/pr-insight false-positive finding:<finding-id> reason...` - 标记误报
- `/pr-insight valid finding:<finding-id> reason...` - 标记有效
- `/pr-insight ignore finding:<finding-id> reason...` - 标记忽略
- `/pr-insight reanalyze` - 重新分析当前 PR
- `/pr-insight 继续` 或 `/pr-insight 更多细节` - 追问上一个话题

The bot remembers conversation history and supports multi-turn dialogue. It replies in the PR conversation and records feedback for future false-positive analysis.

### Examples

```
/pr-insight ask 这个 PR 修改了哪些认证逻辑？
/pr-insight 继续
/pr-insight 更多细节
/pr-insight what dangerouslySetInnerHTML
/pr-insight fix finding:rule-hardcoded-secret-auth.ts-42
```
