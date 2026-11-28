// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { BookDoc } from '@/libs/document';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import {
  runDigestPipeline,
  type DigestPipelineOptions,
  type DigestStore,
} from '@/services/ai/digest/pipeline';
import type { DigestProgress, DigestRecord } from '@/services/ai/digest/types';
import type { AISettings } from '@/services/ai/types';

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generateTextMock,
}));

vi.mock('@/services/ai/providers', () => ({
  getAIProvider: () => ({ getModel: () => 'digest-model' }),
}));

const settings: AISettings = { ...DEFAULT_AI_SETTINGS, enabled: true, provider: 'ollama' };

const CHAPTER_JSON = JSON.stringify({
  summary: 'The hero leaves home.',
  characters: [{ name: 'Hero', change: 'commits to the journey' }],
  events: [{ text: 'The village burns', importance: 3 }],
  foreshadowing: { planted: ['the broken sword'], paid: [] },
  quotes: ['We ride at dawn.'],
});

const VOLUME_JSON = JSON.stringify({
  summary: 'One volume of the journey.',
  arcs: ['the road out of the village'],
  characters: [{ name: 'Hero', change: 'hardens' }],
  threads: ['who burned the village'],
});

const BOOK_JSON = JSON.stringify({
  logline: 'A hero rises.',
  themes: ['growth'],
  characterArcs: [{ name: 'Hero', change: 'rises' }],
  structure: [{ part: 'One', summary: 'the journey begins' }],
  threads: ['the broken sword'],
});

function defaultResponder(prompt: string): string {
  if (prompt.includes('You are compressing part')) return 'Notes about this part of the chapter.';
  if (prompt.includes('Merge these chapter digests')) return VOLUME_JSON;
  if (prompt.includes('Write the whole-book digest')) return BOOK_JSON;
  return CHAPTER_JSON;
}

let responder: (prompt: string) => string = defaultResponder;

class FakeDigestStore implements DigestStore {
  records = new Map<string, DigestRecord>();

  async getDigests(bookHash: string): Promise<DigestRecord[]> {
    return [...this.records.values()].filter((record) => record.bookHash === bookHash);
  }

  async saveDigest(record: DigestRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async deleteDigest(id: string): Promise<void> {
    this.records.delete(id);
  }

  async clearDigests(bookHash: string): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.bookHash === bookHash) this.records.delete(id);
    }
  }
}

function makeBook(sectionTexts: string[]): BookDoc {
  return {
    metadata: { title: 'Test Book', author: 'Test Author' },
    toc: sectionTexts.map((_, index) => ({
      id: index,
      label: `Chapter ${index + 1}`,
      href: `chapter-${index + 1}.xhtml`,
      index: 0,
    })),
    sections: sectionTexts.map((text) => ({
      id: `s-${text.length}`,
      cfi: '',
      size: text.length,
      linear: 'yes',
      createDocument: async () => {
        const doc = document.implementation.createHTMLDocument('chapter');
        doc.body.textContent = text;
        return doc;
      },
    })),
  } as unknown as BookDoc;
}

function run(overrides: Partial<DigestPipelineOptions> = {}): ReturnType<typeof runDigestPipeline> {
  return runDigestPipeline({
    bookDoc: makeBook(['Alpha text', 'Beta text', 'Gamma text']),
    bookHash: 'bookhash',
    bookTitle: 'Test Book',
    authorName: 'Test Author',
    settings,
    store: new FakeDigestStore(),
    concurrency: 2,
    chaptersPerVolume: 10,
    ...overrides,
  });
}

const prompts = () =>
  generateTextMock.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
const chapterCalls = () => prompts().filter((prompt) => prompt.includes('Digest the chapter'));
const partialCalls = () =>
  prompts().filter((prompt) => prompt.includes('You are compressing part'));

beforeEach(() => {
  responder = defaultResponder;
  generateTextMock.mockReset();
  generateTextMock.mockImplementation(async ({ prompt }: { prompt: string }) => ({
    text: responder(prompt),
  }));
});

describe('runDigestPipeline', () => {
  test('summarizes every chapter, merges a volume and then the book', async () => {
    const store = new FakeDigestStore();
    const progress: DigestProgress[] = [];

    const result = await run({ store, onProgress: (event) => progress.push(event) });

    expect(result.chapters.map((chapter) => chapter.status)).toEqual([
      'complete',
      'complete',
      'complete',
    ]);
    expect(result.chapters.map((chapter) => chapter.chapterTitle)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
    ]);
    expect(result.failedSections).toEqual([]);
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toEqual(
      expect.objectContaining({
        from: 0,
        to: 2,
        summary: 'One volume of the journey.',
        chapterIds: ['bookhash:chapter:0', 'bookhash:chapter:1', 'bookhash:chapter:2'],
      }),
    );
    expect(result.book).toEqual(
      expect.objectContaining({
        id: 'bookhash:book',
        bookTitle: 'Test Book',
        logline: 'A hero rises.',
        volumeIds: ['bookhash:volume:0-2'],
      }),
    );
    // 3 chapters + 1 volume + 1 book
    expect(generateTextMock).toHaveBeenCalledTimes(5);
    expect(store.records.size).toBe(5);
    expect(progress[0]).toEqual({ phase: 'chapter', done: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ phase: 'book', done: 1, total: 1 });
    expect(progress.some((event) => event.phase === 'volume' && event.done === 1)).toBe(true);
  });

  test('skips chapters whose contentHash is unchanged on a second run', async () => {
    const store = new FakeDigestStore();
    await run({ store });
    generateTextMock.mockClear();

    const second = await run({ store });

    expect(chapterCalls()).toHaveLength(0);
    // Only the volume and the book are regenerated.
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(second.skippedSections).toEqual([0, 1, 2]);
    expect(second.chapters.every((chapter) => chapter.status === 'complete')).toBe(true);
    expect(store.records.size).toBe(5);
  });

  test('retries a malformed chapter reply once before giving up', async () => {
    let chapterTwoCalls = 0;
    responder = (prompt) => {
      if (prompt.includes('"Chapter 2"')) {
        chapterTwoCalls += 1;
        return chapterTwoCalls === 1 ? 'Sorry, I cannot do JSON.' : CHAPTER_JSON;
      }
      return defaultResponder(prompt);
    };

    const result = await run();

    expect(chapterTwoCalls).toBe(2);
    expect(result.failedSections).toEqual([]);
    expect(result.chapters[1]?.status).toBe('complete');
  });

  test('records a permanently failed chapter and still finishes the book', async () => {
    responder = (prompt) =>
      prompt.includes('"Chapter 2"') ? 'Still not JSON.' : defaultResponder(prompt);

    const store = new FakeDigestStore();
    const result = await run({ store });

    expect(result.failedSections).toEqual([1]);
    expect(result.chapters.map((chapter) => chapter.status)).toEqual([
      'complete',
      'failed',
      'complete',
    ]);
    expect(result.chapters[1]).toEqual(
      expect.objectContaining({ error: expect.stringContaining('JSON'), summary: '' }),
    );
    // The volume is built from the two chapters that succeeded.
    expect(result.volumes[0]?.chapterIds).toEqual(['bookhash:chapter:0', 'bookhash:chapter:2']);
    expect(result.book.logline).toBe('A hero rises.');
    const storedFailure = store.records.get('bookhash:chapter:1');
    expect(storedFailure).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  test('never runs more chapters at once than the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    generateTextMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      if (!prompt.includes('Digest the chapter')) return { text: defaultResponder(prompt) };
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { text: CHAPTER_JSON };
    });

    await run({
      bookDoc: makeBook(['a', 'b', 'c', 'd', 'e', 'f']),
      concurrency: 2,
    });

    expect(maxActive).toBe(2);
  });

  test('stops when the signal aborts and leaves the book digest unwritten', async () => {
    const controller = new AbortController();
    responder = (prompt) => {
      if (prompt.includes('"Chapter 2"')) controller.abort();
      return defaultResponder(prompt);
    };

    const store = new FakeDigestStore();
    await expect(run({ store, signal: controller.signal, concurrency: 1 })).rejects.toThrow();

    expect(store.records.has('bookhash:book')).toBe(false);
    expect(store.records.has('bookhash:volume:0-2')).toBe(false);
  });

  test('map-reduces a chapter that exceeds the single-call budget', async () => {
    const longChapter = 'The road went on. '.repeat(2_000); // ~36k chars

    const result = await run({ bookDoc: makeBook([longChapter]), concurrency: 1 });

    expect(partialCalls().length).toBeGreaterThanOrEqual(2);
    expect(chapterCalls()).toHaveLength(1);
    expect(result.chapters[0]?.status).toBe('complete');
    expect(result.chapters[0]?.summary).toBe('The hero leaves home.');
    // Every part of the chapter is present in the merge prompt.
    const mergePrompt = chapterCalls()[0]!;
    expect(mergePrompt).toContain('Part 1/');
    expect(mergePrompt).toContain('Notes about this part of the chapter.');
  });

  test('refuses to run when AI is disabled', async () => {
    await expect(run({ settings: { ...settings, enabled: false } })).rejects.toThrow(
      /AI is disabled/,
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
