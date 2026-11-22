import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { TOCItem } from '@/libs/document';
import { getAnalysisReportId } from '@/services/ai/analysisService';
import {
  flattenTocForImport,
  getAiNovelReaderV2DatasetPath,
  importAiNovelReaderV2Reports,
  loadAiNovelReaderV2Dataset,
  type AiNovelReaderV2Dataset,
  type AiNovelReaderV2ImportContext,
} from '@/services/ai/import/aiNovelReaderV2';
import type { AIAnalysisReport } from '@/services/ai/types';
import type { AppService } from '@/types/system';

const { saveAnalysisReportsIfAbsentMock } = vi.hoisted(() => ({
  saveAnalysisReportsIfAbsentMock: vi.fn(),
}));

vi.mock('@/services/ai/storage/aiStore', () => ({
  aiStore: { saveAnalysisReportsIfAbsent: saveAnalysisReportsIfAbsentMock },
}));

// Synthetic fixture: the real export is user data and never ships with the app.
const dataset: AiNovelReaderV2Dataset = {
  version: 1,
  source: 'ai-novel-reader-v2',
  bookHash: 'synthetic-book-hash',
  bookTitle: '合成书',
  authorName: '测试作者',
  sectionCount: 5,
  tocSignature: {
    0: '封面',
    1: '第1章',
    2: '第2章',
    3: '第3章',
    4: '第4章',
  },
  reports: [
    {
      sectionIndex: 1,
      chapterTitle: '第1章',
      content: '第一章摘要',
      createdAt: 100,
      updatedAt: 110,
      sourceChapterIds: ['chapter-1'],
      sourceSummaryIds: ['summary-1'],
    },
    {
      sectionIndex: 2,
      chapterTitle: '第2章',
      content: '第二章摘要\n\n---\n\n第二章补充',
      createdAt: 200,
      updatedAt: 220,
      sourceChapterIds: ['chapter-2', 'chapter-2b'],
      sourceSummaryIds: ['summary-2', 'summary-2b'],
    },
    {
      sectionIndex: 4,
      chapterTitle: '第4章',
      content: '第四章摘要',
      createdAt: 400,
      updatedAt: 410,
      sourceChapterIds: ['chapter-4'],
      sourceSummaryIds: ['summary-4'],
    },
  ],
};

const toc: TOCItem[] = Object.entries(dataset.tocSignature).map(([id, label]) => ({
  id: Number(id),
  label,
  href: `chapter-${id}.xhtml`,
  index: 0,
}));

const context: AiNovelReaderV2ImportContext = {
  bookHash: dataset.bookHash,
  bookTitle: dataset.bookTitle,
  authorName: dataset.authorName,
  toc,
};

function report(
  id: string,
  content: string,
  overrides: Partial<AIAnalysisReport> = {},
): AIAnalysisReport {
  return {
    id,
    bookHash: dataset.bookHash,
    bookTitle: dataset.bookTitle,
    kind: 'chapter',
    sectionIndex: 1,
    chapterTitle: '用户已有报告',
    content,
    model: 'user-model',
    status: 'complete',
    sources: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('ai-novel-reader-v2 summary import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveAnalysisReportsIfAbsentMock.mockResolvedValue([]);
  });

  test('maps every exported summary into durable chapter reports', async () => {
    saveAnalysisReportsIfAbsentMock.mockImplementation(
      async (reports: AIAnalysisReport[]) => reports,
    );

    const inserted = await importAiNovelReaderV2Reports(context, { dataset });

    expect(inserted).toBe(3);
    expect(saveAnalysisReportsIfAbsentMock).toHaveBeenCalledTimes(1);
    expect(saveAnalysisReportsIfAbsentMock).toHaveBeenCalledWith(expect.any(Array), {
      replaceFailed: true,
    });
    const reports = saveAnalysisReportsIfAbsentMock.mock.calls[0]![0] as AIAnalysisReport[];
    expect(reports).toHaveLength(3);
    expect(reports.map((item) => item.sectionIndex)).toEqual([1, 2, 4]);

    const first = reports.find((item) => item.sectionIndex === 1);
    expect(first).toEqual(
      expect.objectContaining({
        id: getAnalysisReportId(dataset.bookHash, 'chapter', 1),
        bookHash: dataset.bookHash,
        bookTitle: dataset.bookTitle,
        kind: 'chapter',
        chapterTitle: dataset.tocSignature['1'],
        content: '第一章摘要',
        model: 'ai-novel-reader-v2 / chapter-summary',
        status: 'complete',
        sources: [],
        importedFrom: 'ai-novel-reader-v2',
        sourceChapterIds: ['chapter-1'],
        sourceSummaryIds: ['summary-1'],
      }),
    );
  });

  test('preserves merged source order and timestamp bounds', async () => {
    saveAnalysisReportsIfAbsentMock.mockImplementation(
      async (reports: AIAnalysisReport[]) => reports,
    );
    await importAiNovelReaderV2Reports(context, { dataset });

    const reports = saveAnalysisReportsIfAbsentMock.mock.calls[0]![0] as AIAnalysisReport[];
    const merged = dataset.reports.find((item) => item.sectionIndex === 2);
    const imported = reports.find((item) => item.sectionIndex === 2);

    expect(merged?.sourceSummaryIds).toHaveLength(2);
    expect(imported?.content).toContain('\n\n---\n\n');
    expect(imported?.createdAt).toBe(merged?.createdAt);
    expect(imported?.updatedAt).toBe(merged?.updatedAt);
    expect(imported?.sourceSummaryIds).toEqual(merged?.sourceSummaryIds);
  });

  test('is idempotent and never overwrites an existing user report', async () => {
    const existing = report(
      getAnalysisReportId(dataset.bookHash, 'chapter', 1),
      '用户已经生成的报告',
    );
    const stored = new Map<string, AIAnalysisReport>([[existing.id, existing]]);
    const saveIfAbsent = async (reports: AIAnalysisReport[]) => {
      const inserted: AIAnalysisReport[] = [];
      for (const item of reports) {
        if (stored.has(item.id)) continue;
        stored.set(item.id, item);
        inserted.push(item);
      }
      return inserted;
    };
    saveAnalysisReportsIfAbsentMock.mockImplementation(saveIfAbsent);

    const firstInserted = await importAiNovelReaderV2Reports(context, { dataset });
    const secondInserted = await importAiNovelReaderV2Reports(context, { dataset });

    expect(firstInserted).toBe(2);
    expect(secondInserted).toBe(0);
    expect(stored.get(existing.id)).toEqual(existing);
  });

  test('requests replacement of failed empty placeholders', async () => {
    const id = getAnalysisReportId(dataset.bookHash, 'chapter', 1);
    const failed = report(id, '', { status: 'error', error: 'Provider unavailable' });
    const stored = new Map<string, AIAnalysisReport>([[id, failed]]);
    saveAnalysisReportsIfAbsentMock.mockImplementation(
      async (reports: AIAnalysisReport[], options?: { replaceFailed?: boolean }) => {
        const inserted: AIAnalysisReport[] = [];
        for (const item of reports) {
          const existing = stored.get(item.id);
          const canReplace =
            options?.replaceFailed && existing?.status === 'error' && !existing.content;
          if (existing && !canReplace) continue;
          stored.set(item.id, item);
          inserted.push(item);
        }
        return inserted;
      },
    );

    await expect(importAiNovelReaderV2Reports(context, { dataset })).resolves.toBe(3);
    expect(stored.get(id)).toEqual(
      expect.objectContaining({
        status: 'complete',
        importedFrom: 'ai-novel-reader-v2',
        content: '第一章摘要',
      }),
    );
  });

  test('does not import without a dataset, for a mismatched identity or a mismatched TOC', async () => {
    await expect(importAiNovelReaderV2Reports(context)).resolves.toBe(0);

    const mismatches: AiNovelReaderV2ImportContext[] = [
      { ...context, bookHash: 'another-book' },
      { ...context, bookTitle: '另一本书' },
      { ...context, authorName: '另一位作者' },
      { ...context, toc: toc.slice(0, -1) },
      {
        ...context,
        toc: toc.map((item, index) =>
          index === 3 ? { ...item, label: `${item.label}（不同版本）` } : item,
        ),
      },
    ];

    for (const mismatch of mismatches) {
      await expect(importAiNovelReaderV2Reports(mismatch, { dataset })).resolves.toBe(0);
    }
    expect(saveAnalysisReportsIfAbsentMock).not.toHaveBeenCalled();
  });

  test('loads the optional export from the app data directory', async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(dataset));
    const appService = { exists, readFile } as unknown as AppService;

    await expect(loadAiNovelReaderV2Dataset(appService, dataset.bookHash)).resolves.toEqual(
      dataset,
    );
    expect(exists).toHaveBeenCalledWith(getAiNovelReaderV2DatasetPath(dataset.bookHash), 'Data');
    expect(readFile).toHaveBeenCalledWith(
      getAiNovelReaderV2DatasetPath(dataset.bookHash),
      'Data',
      'text',
    );
  });

  test('treats a missing, malformed or foreign export as absent', async () => {
    const missing = {
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
    } as unknown as AppService;
    await expect(loadAiNovelReaderV2Dataset(missing, dataset.bookHash)).resolves.toBeNull();
    expect(missing.readFile).not.toHaveBeenCalled();

    const malformed = {
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue('{not json'),
    } as unknown as AppService;
    await expect(loadAiNovelReaderV2Dataset(malformed, dataset.bookHash)).resolves.toBeNull();

    const foreign = {
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ ...dataset, bookHash: 'other' })),
    } as unknown as AppService;
    await expect(loadAiNovelReaderV2Dataset(foreign, dataset.bookHash)).resolves.toBeNull();
  });

  test('flattens nested TOC entries in document order', () => {
    const nested: TOCItem[] = [
      {
        id: 0,
        label: '第一卷',
        href: '',
        index: 0,
        subitems: [
          { id: 1, label: '第1章', href: '', index: 0 },
          { id: 2, label: '第2章', href: '', index: 0 },
        ],
      },
      { id: 3, label: '第3章', href: '', index: 0 },
    ];

    expect(flattenTocForImport(nested).map((item) => item.id)).toEqual([0, 1, 2, 3]);
  });
});
