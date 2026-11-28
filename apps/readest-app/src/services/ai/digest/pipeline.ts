import type { BookDoc, SectionItem, TOCItem } from '@/libs/document';

import { getAnalysisChatModelName } from '../analysisService';
import { aiStore } from '../storage/aiStore';
import type { AISettings } from '../types';
import { extractTextFromDocument } from '../utils/chunker';
import { generateBookDigest } from './bookDigest';
import { generateChapterDigest } from './chapterDigest';
import { generateVolumeDigest } from './volumeDigest';
import {
  chapterDigestId,
  hashContent,
  isChapterDigestDone,
  type BookDigest,
  type ChapterDigest,
  type DigestProgress,
  type DigestRecord,
  type VolumeDigest,
} from './types';

export const DEFAULT_DIGEST_CONCURRENCY = 2;
export const DEFAULT_CHAPTERS_PER_VOLUME = 10;

/** The subset of `aiStore` the pipeline needs; injectable for tests. */
export interface DigestStore {
  getDigests(bookHash: string): Promise<DigestRecord[]>;
  saveDigest(record: DigestRecord): Promise<void>;
  deleteDigest(id: string): Promise<void>;
  clearDigests(bookHash: string): Promise<void>;
}

export interface DigestPipelineOptions {
  bookDoc: BookDoc;
  bookHash: string;
  bookTitle: string;
  authorName?: string;
  settings: AISettings;
  signal?: AbortSignal;
  /** Chapters summarized at once. Default 2. */
  concurrency?: number;
  /** Chapters merged into one volume. Default 10. */
  chaptersPerVolume?: number;
  onProgress?: (progress: DigestProgress) => void;
  store?: DigestStore;
}

export interface DigestRunResult {
  /**
   * One record per section the run touched, in section order. Chapters that
   * threw are included with `status: 'failed'` so a UI can show them.
   */
  chapters: ChapterDigest[];
  volumes: VolumeDigest[];
  book: BookDigest;
  /** Sections that threw; they are retried on the next run. */
  failedSections: number[];
  /** Sections skipped because their digest was unchanged or they had no text. */
  skippedSections: number[];
}

interface SectionTarget {
  index: number;
  item: SectionItem;
  title: string;
}

/** Same TOC lookup the indexer uses: the last entry at or before the section. */
function chapterTitleFor(toc: TOCItem[], sectionIndex: number): string {
  if (toc.length === 0) return `Section ${sectionIndex + 1}`;
  for (let index = toc.length - 1; index >= 0; index--) {
    const item = toc[index]!;
    if (item.id <= sectionIndex) return item.label;
  }
  return toc[0]?.label || `Section ${sectionIndex + 1}`;
}

function collectSections(bookDoc: BookDoc): SectionTarget[] {
  const toc = bookDoc.toc ?? [];
  const targets: SectionTarget[] = [];
  (bookDoc.sections ?? []).forEach((item, index) => {
    // Non-linear spine items (covers, colophons) are not part of the story.
    if (item.linear === 'no' || item.size <= 0) return;
    targets.push({ index, item, title: chapterTitleFor(toc, index) });
  });
  return targets;
}

function emit(onProgress: DigestPipelineOptions['onProgress'], progress: DigestProgress): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // A broken progress listener must not abort the run.
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      signal?.throwIfAborted();
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

function failedChapterDigest(args: {
  bookHash: string;
  target: SectionTarget;
  contentHash: string;
  model: string;
  error: string;
  createdAt: number;
}): ChapterDigest {
  const now = Date.now();
  return {
    kind: 'chapter',
    id: chapterDigestId(args.bookHash, args.target.index),
    bookHash: args.bookHash,
    sectionIndex: args.target.index,
    chapterTitle: args.target.title,
    contentHash: args.contentHash,
    status: 'failed',
    error: args.error,
    summary: '',
    characters: [],
    events: [],
    foreshadowing: { planted: [], paid: [] },
    quotes: [],
    model: args.model,
    createdAt: args.createdAt,
    updatedAt: now,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/**
 * Map-reduce the book: every chapter becomes a {@link ChapterDigest}, every
 * `chaptersPerVolume` chapters merge into a {@link VolumeDigest}, and the
 * volumes merge into one {@link BookDigest}.
 *
 * Chapters whose stored digest has the same `contentHash` are skipped, so a
 * cancelled or failed run resumes where it stopped. A chapter that still
 * fails is recorded and excluded from its volume; the run continues.
 */
export async function runDigestPipeline(options: DigestPipelineOptions): Promise<DigestRunResult> {
  const { bookDoc, bookHash, settings, signal } = options;
  signal?.throwIfAborted();
  if (!settings.enabled) throw new Error('AI is disabled. Enable it in AI settings first.');

  const store = options.store ?? aiStore;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_DIGEST_CONCURRENCY);
  const chaptersPerVolume = Math.max(1, options.chaptersPerVolume ?? DEFAULT_CHAPTERS_PER_VOLUME);
  const model = getAnalysisChatModelName(settings);
  const targets = collectSections(bookDoc);

  const existing = await store.getDigests(bookHash);
  const storedChapters = new Map<number, ChapterDigest>();
  for (const record of existing) {
    if (record.kind === 'chapter') storedChapters.set(record.sectionIndex, record);
  }

  const chapters = new Map<number, ChapterDigest>();
  const failedSections: number[] = [];
  const skippedSections: number[] = [];
  let chaptersDone = 0;
  emit(options.onProgress, { phase: 'chapter', done: 0, total: targets.length });

  await runPool(
    targets,
    concurrency,
    async (target) => {
      signal?.throwIfAborted();
      const doc = await target.item.createDocument();
      signal?.throwIfAborted();
      const text = extractTextFromDocument(doc);
      if (!text.trim()) {
        skippedSections.push(target.index);
        chaptersDone += 1;
        emit(options.onProgress, { phase: 'chapter', done: chaptersDone, total: targets.length });
        return;
      }

      const contentHash = hashContent(text);
      const stored = storedChapters.get(target.index);
      if (stored && isChapterDigestDone(stored, contentHash)) {
        chapters.set(target.index, stored);
        skippedSections.push(target.index);
        chaptersDone += 1;
        emit(options.onProgress, { phase: 'chapter', done: chaptersDone, total: targets.length });
        return;
      }

      try {
        const digest = await generateChapterDigest({
          bookHash,
          sectionIndex: target.index,
          chapterTitle: target.title,
          doc,
          settings,
          model,
          signal,
        });
        if (stored) digest.createdAt = stored.createdAt;
        await store.saveDigest(digest);
        chapters.set(target.index, digest);
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        const failure = failedChapterDigest({
          bookHash,
          target,
          contentHash,
          model,
          error: errorMessage(error),
          createdAt: stored?.createdAt ?? Date.now(),
        });
        failedSections.push(target.index);
        chapters.set(target.index, failure);
        await store.saveDigest(failure).catch(() => {
          // A failed write must not turn a chapter failure into a run failure.
        });
      }

      chaptersDone += 1;
      emit(options.onProgress, { phase: 'chapter', done: chaptersDone, total: targets.length });
    },
    signal,
  );

  throwIfAborted(signal);

  const usable = targets
    .map((target) => chapters.get(target.index))
    .filter((digest): digest is ChapterDigest => digest?.status === 'complete');
  if (usable.length === 0) {
    throw new Error('No chapters could be summarized, so no book digest was produced.');
  }

  const groups = chunk(usable, chaptersPerVolume);
  const volumes: VolumeDigest[] = [];
  emit(options.onProgress, { phase: 'volume', done: 0, total: groups.length });

  for (const group of groups) {
    throwIfAborted(signal);
    const volume = await generateVolumeDigest({
      bookHash,
      from: group[0]!.sectionIndex,
      to: group[group.length - 1]!.sectionIndex,
      chapters: group,
      settings,
      model,
      signal,
    });
    await store.saveDigest(volume);
    volumes.push(volume);
    emit(options.onProgress, { phase: 'volume', done: volumes.length, total: groups.length });
  }

  throwIfAborted(signal);
  emit(options.onProgress, { phase: 'book', done: 0, total: 1 });

  const book = await generateBookDigest({
    bookHash,
    bookTitle: options.bookTitle,
    authorName: options.authorName,
    volumes,
    settings,
    model,
    signal,
  });
  await store.saveDigest(book);
  emit(options.onProgress, { phase: 'book', done: 1, total: 1 });

  return {
    chapters: targets
      .map((target) => chapters.get(target.index))
      .filter((digest): digest is ChapterDigest => digest !== undefined),
    volumes,
    book,
    failedSections: failedSections.sort((a, b) => a - b),
    skippedSections: skippedSections.sort((a, b) => a - b),
  };
}

/** Remove every stored digest for a book (chapter, volume and book). */
export async function clearBookDigests(
  bookHash: string,
  store: DigestStore = aiStore,
): Promise<void> {
  await store.clearDigests(bookHash);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Digest run aborted.');
}
