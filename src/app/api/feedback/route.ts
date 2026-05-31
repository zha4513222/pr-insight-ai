import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { addFeedback } from '@/lib/store';

export const runtime = 'nodejs';

const feedbackSchema = z.object({
  reportId: z.string().nullable().optional(),
  findingId: z.string().nullable().optional(),
  prUrl: z.string().url(),
  repositoryFullName: z.string().nullable().optional(),
  actor: z.string().default('web-user'),
  verdict: z.enum(['false_positive', 'valid', 'ignored', 'needs_more_context']),
  note: z.string().default(''),
  sourceCommentUrl: z.string().nullable().optional()
});

export async function POST(request: NextRequest) {
  try {
    const payload = feedbackSchema.parse(await request.json());
    const feedback = await addFeedback(payload);
    return NextResponse.json({ feedback });
  } catch (error) {
    const message = error instanceof Error ? error.message : '反馈记录失败';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
