/**
 * Layered book digests: chapter → volume → whole book.
 *
 * Every digest is a plain JSON record so it can be persisted, diffed and
 * re-merged without the model in the loop. The `parse*Payload` functions below are
 * the only place that trusts model output, so they coerce aggressively and
 * throw {@link DigestParseError} when a required field is missing.
 */

export type DigestKind = 'chapter' | 'volume' | 'book';

export interface DigestCharacter {
  name: string;
  change: string;
}

export interface DigestEvent {
  text: string;
  importance: 1 | 2 | 3;
}

export interface DigestForeshadowing {
  planted: string[];
  paid: string[];
}

interface DigestBase {
  bookHash: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

/** One chapter's structured summary. */
export interface ChapterDigest extends DigestBase {
  kind: 'chapter';
  id: string;
  sectionIndex: number;
  chapterTitle: string;
  /** Fingerprint of the chapter text; a changed hash invalidates the digest. */
  contentHash: string;
  status: 'complete' | 'failed';
  error?: string;
  summary: string;
  characters: DigestCharacter[];
  events: DigestEvent[];
  foreshadowing: DigestForeshadowing;
  quotes: string[];
}

/** A run of consecutive chapters merged into one summary. */
export interface VolumeDigest extends DigestBase {
  kind: 'volume';
  id: string;
  from: number;
  to: number;
  summary: string;
  arcs: string[];
  characters: DigestCharacter[];
  threads: string[];
  /** Chapter digest ids this volume was built from. */
  chapterIds: string[];
}

/** The whole book, built from the volume digests. */
export interface BookDigest extends DigestBase {
  kind: 'book';
  id: string;
  bookTitle: string;
  logline: string;
  themes: string[];
  characterArcs: DigestCharacter[];
  structure: { part: string; summary: string }[];
  threads: string[];
  /** Volume digest ids this book digest was built from. */
  volumeIds: string[];
}

export type DigestRecord = ChapterDigest | VolumeDigest | BookDigest;

export type DigestPhase = 'chapter' | 'volume' | 'book';

/** Progress for a digest run; `done`/`total` are in the phase's own units. */
export interface DigestProgress {
  phase: DigestPhase;
  done: number;
  total: number;
}

export interface ChapterDigestPayload {
  summary: string;
  characters: DigestCharacter[];
  events: DigestEvent[];
  foreshadowing: DigestForeshadowing;
  quotes: string[];
}

export interface VolumeDigestPayload {
  summary: string;
  arcs: string[];
  characters: DigestCharacter[];
  threads: string[];
}

export interface BookDigestPayload {
  logline: string;
  themes: string[];
  characterArcs: DigestCharacter[];
  structure: { part: string; summary: string }[];
  threads: string[];
}

/** The model returned something we could not turn into a usable digest. */
export class DigestParseError extends Error {
  readonly raw: string;

  constructor(message: string, raw = '') {
    super(message);
    this.name = 'DigestParseError';
    this.raw = raw;
  }
}

export function chapterDigestId(bookHash: string, sectionIndex: number): string {
  return `${bookHash}:chapter:${sectionIndex}`;
}

export function volumeDigestId(bookHash: string, from: number, to: number): string {
  return `${bookHash}:volume:${from}-${to}`;
}

export function bookDigestId(bookHash: string): string {
  return `${bookHash}:book`;
}

/**
 * Order-insensitive-enough fingerprint used to skip unchanged chapters.
 * FNV-1a over whitespace-normalized text plus its length; no crypto
 * dependency so it runs identically in the browser and in tests.
 */
export function hashContent(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16)}-${normalized.length}`;
}

export function isChapterDigestDone(
  digest: ChapterDigest | undefined,
  contentHash: string,
): boolean {
  return digest?.status === 'complete' && digest.contentHash === contentHash;
}

/** Pull a JSON object out of model output, tolerating Markdown fences and prose. */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new DigestParseError('The model did not return a JSON object.', raw);
}

/**
 * The loose shape a model reply is coerced from. Declared as optional fields
 * rather than an index signature so the normalizers can use dot access.
 */
interface JsonRecord {
  summary?: unknown;
  logline?: unknown;
  characters?: unknown;
  characterArcs?: unknown;
  events?: unknown;
  foreshadowing?: unknown;
  quotes?: unknown;
  arcs?: unknown;
  threads?: unknown;
  themes?: unknown;
  structure?: unknown;
  planted?: unknown;
  paid?: unknown;
  name?: unknown;
  change?: unknown;
  text?: unknown;
  importance?: unknown;
  part?: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asRequiredString(value: unknown, field: string): string {
  const text = asString(value);
  if (!text) throw new DigestParseError(`Digest is missing "${field}".`);
  return text;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item) => item.length > 0);
}

function asCharacters(value: unknown): DigestCharacter[] {
  if (!Array.isArray(value)) return [];
  const characters: DigestCharacter[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) characters.push({ name, change: '' });
      continue;
    }
    const record = asRecord(item);
    const name = asString(record.name);
    if (!name) continue;
    characters.push({ name, change: asString(record.change) });
  }
  return characters;
}

function asImportance(value: unknown): 1 | 2 | 3 {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (numeric === 1 || numeric === 3) return numeric;
  return 2;
}

function asEvents(value: unknown): DigestEvent[] {
  if (!Array.isArray(value)) return [];
  const events: DigestEvent[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) events.push({ text, importance: 2 });
      continue;
    }
    const record = asRecord(item);
    const text = asString(record.text);
    if (!text) continue;
    events.push({ text, importance: asImportance(record.importance) });
  }
  return events;
}

function asForeshadowing(value: unknown): DigestForeshadowing {
  const record = asRecord(value);
  return { planted: asStringArray(record.planted), paid: asStringArray(record.paid) };
}

function asStructure(value: unknown): { part: string; summary: string }[] {
  if (!Array.isArray(value)) return [];
  const parts: { part: string; summary: string }[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const part = asString(record.part);
    const summary = asString(record.summary);
    if (!part && !summary) continue;
    parts.push({ part, summary });
  }
  return parts;
}

export function parseChapterDigestPayload(raw: string): ChapterDigestPayload {
  const record = asRecord(extractJsonObject(raw));
  return {
    summary: asRequiredString(record.summary, 'summary'),
    characters: asCharacters(record.characters),
    events: asEvents(record.events),
    foreshadowing: asForeshadowing(record.foreshadowing),
    quotes: asStringArray(record.quotes),
  };
}

export function parseVolumeDigestPayload(raw: string): VolumeDigestPayload {
  const record = asRecord(extractJsonObject(raw));
  return {
    summary: asRequiredString(record.summary, 'summary'),
    arcs: asStringArray(record.arcs),
    characters: asCharacters(record.characters),
    threads: asStringArray(record.threads),
  };
}

export function parseBookDigestPayload(raw: string): BookDigestPayload {
  const record = asRecord(extractJsonObject(raw));
  return {
    logline: asRequiredString(record.logline, 'logline'),
    themes: asStringArray(record.themes),
    characterArcs: asCharacters(record.characterArcs),
    structure: asStructure(record.structure),
    threads: asStringArray(record.threads),
  };
}
