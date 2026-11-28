import type { AISettings } from '../types';
import { requestDigestJson } from './generate';
import {
  parseVolumeDigestPayload,
  volumeDigestId,
  type ChapterDigest,
  type VolumeDigest,
} from './types';

export interface VolumeDigestRequest {
  bookHash: string;
  /** Section index of the first chapter in the volume. */
  from: number;
  /** Section index of the last chapter in the volume. */
  to: number;
  chapters: ChapterDigest[];
  settings: AISettings;
  model: string;
  signal?: AbortSignal;
}

const SCHEMA = `{
  "summary": "300-400 words covering this run of chapters as one arc",
  "arcs": ["a storyline that advances across these chapters"],
  "characters": [{ "name": "name", "change": "how they changed across this volume" }],
  "threads": ["open question or unresolved thread carried forward"]
}`;

/** Compact, lossless-enough rendering of a chapter digest for the merge prompt. */
export function renderChapterForMerge(digest: ChapterDigest): string {
  const lines = [`### Chapter ${digest.sectionIndex + 1}: ${digest.chapterTitle}`];
  if (digest.summary) lines.push(digest.summary);
  if (digest.events.length > 0) {
    lines.push(
      `Events: ${digest.events.map((event) => `${event.text} (${event.importance})`).join('; ')}`,
    );
  }
  if (digest.characters.length > 0) {
    lines.push(`Characters: ${digest.characters.map((c) => `${c.name} — ${c.change}`).join('; ')}`);
  }
  if (digest.foreshadowing.planted.length > 0) {
    lines.push(`Planted: ${digest.foreshadowing.planted.join('; ')}`);
  }
  if (digest.foreshadowing.paid.length > 0) {
    lines.push(`Paid off: ${digest.foreshadowing.paid.join('; ')}`);
  }
  if (digest.quotes.length > 0) lines.push(`Quotes: ${digest.quotes.join(' | ')}`);
  return lines.join('\n');
}

function buildVolumePrompt(req: VolumeDigestRequest): string {
  const chapters = req.chapters.map(renderChapterForMerge).join('\n\n');
  return `Merge these chapter digests into one summary of chapters ${req.from + 1}–${req.to + 1}.

<CHAPTER_DIGESTS>
${chapters}
</CHAPTER_DIGESTS>

Reply with JSON of exactly this shape:
${SCHEMA}

Use only what the chapter digests say. Keep an arc only if it spans more than one chapter, and list a thread only if the chapters leave it unresolved.`;
}

/** Merge consecutive chapter digests into one volume digest. */
export async function generateVolumeDigest(req: VolumeDigestRequest): Promise<VolumeDigest> {
  const payload = await requestDigestJson({
    settings: req.settings,
    prompt: buildVolumePrompt(req),
    signal: req.signal,
    maxOutputTokens: 1600,
    parse: parseVolumeDigestPayload,
  });

  const now = Date.now();
  return {
    kind: 'volume',
    id: volumeDigestId(req.bookHash, req.from, req.to),
    bookHash: req.bookHash,
    from: req.from,
    to: req.to,
    model: req.model,
    createdAt: now,
    updatedAt: now,
    chapterIds: req.chapters.map((chapter) => chapter.id),
    ...payload,
  };
}
