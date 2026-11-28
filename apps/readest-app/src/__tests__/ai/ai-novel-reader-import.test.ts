import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { TOCItem } from '@/libs/document';
import { getAnalysisReportId } from '@/services/ai/analysisService';
import {
  flattenTocForImport,
  importAiNovelReaderV2Reports,
  type AiNovelReaderV2Dataset,
  type AiNovelReaderV2ImportContext,
} from '@/services/ai/import/aiNovelReaderV2';
import type { AIAnalysisReport } from '@/services/ai/types';

const { saveAnalysisReportsIfAbsentMock } = vi.hoisted(() => ({
  saveAnalysisReportsIfAbsentMock: vi.fn(),
}));

vi.mock('@/services/ai/storage/aiStore', () => ({
  aiStore: { saveAnalysisReportsIfAbsent: saveAnalysisReportsIfAbsentMock },
}));

/**
 * The real ai-novel-reader-v2 export is not bundled (2.1 MB), so the importer
 * takes the dataset as an argument and these tests build a small fixture.
 */
const dataset: AiNovelReaderV2Dataset = {
  version: 2,
  source: 'ai-novel-reader-v2',
  bookHash: 'lingjing-xingzhe',
  bookTitle: '灵境行者',
  authorName: '卖报小郎君',
  sectionCount: 3,
  tocSignature: { '0': '第一卷 初入灵境', '1': '第1章 旧疾', '2': '第2章 夜行' },
  reports: [
    {
      sectionIndex: 1,
      chapterTitle: '第1章 旧疾',
      content: '张元清清晨旧疾复发。',
      createdAt: 100,
      updatedAt: 200,
      sourceChapterIds: ['ch-1'],
      sourceSummaryIds: ['sum-1'],
    },
    {
      sectionIndex: 2,
      chapterTitle: '第2章 夜行',
      content: '上半夜的巡守记录。\n\n---\n\n下半夜的巡守记录。',
      createdAt: 300,
      updatedAt: 400,
      sourceChapterIds: ['ch-2a', 'ch-2b'],
      sourceSummaryIds: ['sum-2a', 'sum-2b'],
    },
  ],
};

const toc: TOCItem[] = [
  {
    id: 0,
    label: '第一卷 初入灵境',
    href: 'volume-1.xhtml',
    index: 0,
    subitems: [
      { id: 1, label: '第1章 旧疾', href: 'chapter-1.xhtml', index: 0 },
      { id: 2, label: '第2章 夜行', href: 'chapter-2.xhtml', index: 0 },
    ],
  },
];

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

  test('maps exported summaries into durable chapter reports', async () => {
    saveAnalysisReportsIfAbsentMock.mockImplementation(
      async (reports: AIAnalysisReport[]) => reports,
    );

    const inserted = await importAiNovelReaderV2Reports(context, { dataset });

    expect(inserted).toBe(2);
    expect(saveAnalysisReportsIfAbsentMock).toHaveBeenCalledTimes(1);
    expect(saveAnalysisReportsIfAbsentMock).toHaveBeenCalledWith(expect.any(Array), {
      replaceFailed: true,
    });
    const reports = saveAnalysisReportsIfAbsentMock.mock.calls[0]![0] as AIAnalysisReport[];
    expect(new Set(reports.map((item) => item.sectionIndex))).toEqual(new Set([1, 2]));

    const first = reports.find((item) => item.sectionIndex === 1);
    expect(first).toEqual(
      expect.objectContaining({
        id: getAnalysisReportId(dataset.bookHash, 'chapter', 1),
        bookHash: dataset.bookHash,
        bookTitle: dataset.bookTitle,
        kind: 'chapter',
        chapterTitle: '第1章 旧疾',
        content: '张元清清晨旧疾复发。',
        model: 'ai-novel-reader-v2 / chapter-summary',
        status: 'complete',
        sources: [],
        importedFrom: 'ai-novel-reader-v2',
        sourceChapterIds: ['ch-1'],
        sourceSummaryIds: ['sum-1'],
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

    expect(firstInserted).toBe(1);
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

    await expect(importAiNovelReaderV2Reports(context, { dataset })).resolves.toBe(2);
    expect(stored.get(id)).toEqual(
      expect.objectContaining({
        status: 'complete',
        importedFrom: 'ai-novel-reader-v2',
        content: expect.stringContaining('张元清清晨旧疾复发'),
      }),
    );
  });

  test('does not import for a mismatched book identity or TOC', async () => {
    const mismatches: AiNovelReaderV2ImportContext[] = [
      { ...context, bookHash: 'another-book' },
      { ...context, bookTitle: '另一本书' },
      { ...context, authorName: '另一位作者' },
      { ...context, toc: toc.slice(0, -1) },
      {
        ...context,
        toc: toc.map((item) => ({ ...item, label: `${item.label}（不同版本）` })),
      },
    ];

    for (const mismatch of mismatches) {
      await expect(importAiNovelReaderV2Reports(mismatch, { dataset })).resolves.toBe(0);
    }
    expect(saveAnalysisReportsIfAbsentMock).not.toHaveBeenCalled();
  });

  test('skips safely when no dataset is installed', async () => {
    await expect(importAiNovelReaderV2Reports(context)).resolves.toBe(0);
    await expect(importAiNovelReaderV2Reports(context, { dataset: null })).resolves.toBe(0);
    expect(saveAnalysisReportsIfAbsentMock).not.toHaveBeenCalled();
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
