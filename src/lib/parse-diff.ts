import { DiffHunk, DiffLine } from './types';

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = patch.split('\n');
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;

  for (const rawLine of lines) {
    const hunkMatch = HUNK_PATTERN.exec(rawLine);

    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      current = {
        header: rawLine,
        oldStart: oldLine,
        oldLines: Number(hunkMatch[2] || 1),
        newStart: newLine,
        newLines: Number(hunkMatch[4] || 1),
        lines: []
      };
      hunks.push(current);
      position += 1;
      continue;
    }

    if (!current) {
      continue;
    }

    position += 1;
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    let diffLine: DiffLine;

    if (marker === '+') {
      diffLine = {
        type: 'add',
        content,
        oldLine: null,
        newLine,
        position
      };
      newLine += 1;
    } else if (marker === '-') {
      diffLine = {
        type: 'remove',
        content,
        oldLine,
        newLine: null,
        position
      };
      oldLine += 1;
    } else {
      diffLine = {
        type: 'context',
        content: marker === ' ' ? content : rawLine,
        oldLine,
        newLine,
        position
      };
      oldLine += 1;
      newLine += 1;
    }

    current.lines.push(diffLine);
  }

  return hunks;
}

export function getAddedLines(hunks: DiffHunk[]): DiffLine[] {
  return hunks.flatMap((hunk) => hunk.lines.filter((line) => line.type === 'add'));
}
