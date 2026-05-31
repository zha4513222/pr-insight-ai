import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzePullRequest } from '@/lib/automation';
import { appendAudit, saveReport } from '@/lib/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

const analyzeSchema = z.object({
  prUrl: z.string().url(),
  githubToken: z.string().optional(),
  mode: z.enum(['fast', 'deep']).optional()
});

export async function POST(request: NextRequest) {
  try {
    const payload = analyzeSchema.parse(await request.json());
    const report = await analyzePullRequest(payload.prUrl, payload.githubToken, payload.mode || 'deep');
    await saveReport(report);
    await appendAudit({
      type: 'manual.analyzed',
      prUrl: payload.prUrl,
      repositoryFullName: `${report.snapshot.metadata.owner}/${report.snapshot.metadata.repo}`,
      message: 'Manual PR analysis completed',
      metadata: { reportId: report.id, findings: report.findings.length }
    });

    return NextResponse.json({ report });
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析失败';
    return NextResponse.json(
      {
        error: message
      },
      { status: 400 }
    );
  }
}
