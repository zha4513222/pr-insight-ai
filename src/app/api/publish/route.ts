import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { publishPullRequestReview } from '@/lib/github';

export const runtime = 'nodejs';

const publishSchema = z.object({
  prUrl: z.string().url(),
  githubToken: z.string().optional(),
  body: z.string().min(1),
  event: z.enum(['COMMENT', 'REQUEST_CHANGES']).optional(),
  comments: z
    .array(
      z.object({
        path: z.string(),
        position: z.number(),
        body: z.string()
      })
    )
    .optional()
});

export async function POST(request: NextRequest) {
  try {
    const payload = publishSchema.parse(await request.json());
    const result = await publishPullRequestReview(payload);
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '发布失败';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
