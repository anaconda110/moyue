import type { AISettings } from '../types';
import { chunkSection, extractTextFromDocument } from '../utils/chunker';
import { callDigestModel, requestDigestJson } from './generate';
import {
  chapterDigestId,
  hashContent,
  parseChapterDigestPayload,
  type ChapterDigest,
  type ChapterDigestPayload,
} from './types';

/** Above this the chapter is summarized in parts and merged, never truncated. */
export const MAX_SINGLE_CALL_CHARS = 24_000;
/** Target size of one partial summary call. */
const PART_CHARS = 9_000;
const PART_OVERLAP = 400;
/** Upper bound on partial calls for a very long chapter. */
const MAX_PARTS = 12;

export interface ChapterDigestRequest {
  bookHash: string;
  sectionIndex: number;
  chapterTitle: string;
  doc: Document;
  settings: AISettings;
  /** Resolved once per run by the pipeline so the whole book uses one model. */
  model: string;
  signal?: AbortSignal;
}

const SCHEMA = `{
  "summary": "200-300 words covering what happens and why it matters",
  "characters": [{ "name": "name", "change": "what changed for them in this chapter" }],
  "events": [{ "text": "one concrete event", "importance": 1 }],
  "foreshadowing": { "planted": ["thread set up here"], "paid": ["earlier thread resolved here"] },
  "quotes": ["at most three short verbatim lines worth keeping"]
}`;

function buildChapterPrompt(chapterTitle: string, body: string, partial: boolean): string {
  return `Digest the chapter "${chapterTitle}".
${partial ? 'The chapter was too long for one pass, so the notes below are ordered partial summaries of consecutive parts. Merge them; do not treat a part boundary as a scene break.' : 'The chapter text is supplied in full.'}

<CHAPTER>
${body}
</CHAPTER>

Reply with JSON of exactly this shape:
${SCHEMA}

Use importance 1 for background detail, 2 for plot movement, 3 for turning points. Keep every array empty when the chapter has nothing for it.`;
}

function buildPartialPrompt(
  chapterTitle: string,
  part: string,
  index: number,
  total: number,
): string {
  return `You are compressing part ${index + 1} of ${total} of the chapter "${chapterTitle}" so it can be merged with the other parts later.

<PART>
${part}
</PART>

Write plain prose notes (no JSON, no headings) covering: what happens, who acts and why, what changes, what is set up or paid off, and any line worth quoting. Do not summarize parts you were not given.`;
}

async function digestLongChapter(
  req: ChapterDigestRequest,
  text: string,
): Promise<ChapterDigestPayload> {
  // Bound the number of calls on pathological chapters by widening each part
  // rather than dropping text.
  const maxChunkSize = Math.max(PART_CHARS, Math.ceil(text.length / MAX_PARTS));
  const parts = chunkSection(req.doc, req.sectionIndex, req.chapterTitle, req.bookHash, 0, {
    maxChunkSize,
    overlapSize: PART_OVERLAP,
    minChunkSize: 200,
  }).map((part) => part.text);

  const notes: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    req.signal?.throwIfAborted();
    const note = await callDigestModel({
      settings: req.settings,
      prompt: buildPartialPrompt(req.chapterTitle, parts[index]!, index, parts.length),
      signal: req.signal,
      maxOutputTokens: 800,
    });
    notes.push(`Part ${index + 1}/${parts.length}:\n${note}`);
  }

  req.signal?.throwIfAborted();
  return requestDigestJson({
    settings: req.settings,
    prompt: buildChapterPrompt(req.chapterTitle, notes.join('\n\n'), true),
    signal: req.signal,
    maxOutputTokens: 1600,
    parse: parseChapterDigestPayload,
  });
}

/**
 * Summarize one chapter. Long chapters are map-reduced in parts; malformed
 * JSON gets one repair round (see {@link requestDigestJson}). Throws on
 * failure — the pipeline records the failure and keeps going.
 */
export async function generateChapterDigest(req: ChapterDigestRequest): Promise<ChapterDigest> {
  const text = extractTextFromDocument(req.doc);
  if (!text.trim()) throw new Error('This chapter has no extractable text.');

  const payload =
    text.length <= MAX_SINGLE_CALL_CHARS
      ? await requestDigestJson({
          settings: req.settings,
          prompt: buildChapterPrompt(req.chapterTitle, text, false),
          signal: req.signal,
          maxOutputTokens: 1600,
          parse: parseChapterDigestPayload,
        })
      : await digestLongChapter(req, text);

  const now = Date.now();
  return {
    kind: 'chapter',
    id: chapterDigestId(req.bookHash, req.sectionIndex),
    bookHash: req.bookHash,
    sectionIndex: req.sectionIndex,
    chapterTitle: req.chapterTitle,
    contentHash: hashContent(text),
    status: 'complete',
    model: req.model,
    createdAt: now,
    updatedAt: now,
    ...payload,
  };
}
