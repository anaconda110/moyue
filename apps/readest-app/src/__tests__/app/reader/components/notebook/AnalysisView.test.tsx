// @vitest-environment happy-dom
import { bookDataStoreHooks } from '@/__tests__/helpers/book-data-store-mock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import AnalysisView from '@/app/reader/components/notebook/AnalysisView';
import type { AIAnalysisReport } from '@/services/ai/types';

const BOOK_HASH = 'bookhash';

const h = vi.hoisted(() => ({
  // Stable identity: the real store hands back the same object until settings
  // change, and the component memoizes its backend on it.
  settings: { aiSettings: { enabled: true, provider: 'ollama' } },
  reports: {} as Record<string, unknown>,
  loadedBooks: {} as Record<string, boolean>,
  loadingBooks: {} as Record<string, boolean>,
  loadReports: vi.fn(async () => {}),
  startAnalysis: vi.fn(() => 'started-report'),
  cancelAnalysis: vi.fn(),
  deleteReport: vi.fn(async () => {}),
  progress: {
    pageinfo: { current: 7, total: 20 },
    section: { current: 3, total: 12 },
    sectionLabel: 'Chapter Four',
  } as Record<string, unknown>,
  goTo: vi.fn(),
  isIndexed: vi.fn(async () => true),
  indexBook: vi.fn(
    async (
      _doc: unknown,
      _hash: string,
      options?: { onProgress?: (progress: unknown) => void },
    ) => {
      options?.onProgress?.({ phase: 'embedding', current: 1, total: 2 });
    },
  ),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: h.settings }),
}));

vi.mock('@/store/bookDataStore', () => ({
  ...bookDataStoreHooks(() => ({
    getBookData: () => ({
      book: { title: 'Test Book', author: 'Test Author' },
      bookDoc: { toc: [], sections: [{}, {}, {}, {}] },
    }),
  })),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector: (s: { getView: () => unknown }) => unknown) =>
    selector({ getView: () => ({ goTo: h.goTo }) }),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => h.progress,
}));

vi.mock('@/store/aiAnalysisStore', () => ({
  useAIAnalysisStore: (
    selector: (s: {
      reports: Record<string, unknown>;
      loadedBooks: Record<string, boolean>;
      loadingBooks: Record<string, boolean>;
      loadReports: typeof h.loadReports;
      startAnalysis: typeof h.startAnalysis;
      cancelAnalysis: typeof h.cancelAnalysis;
      deleteReport: typeof h.deleteReport;
    }) => unknown,
  ) =>
    selector({
      reports: h.reports,
      loadedBooks: h.loadedBooks,
      loadingBooks: h.loadingBooks,
      loadReports: h.loadReports,
      startAnalysis: h.startAnalysis,
      cancelAnalysis: h.cancelAnalysis,
      deleteReport: h.deleteReport,
    }),
}));

vi.mock('@/services/ai/analysisService', () => ({
  getAnalysisReportId: (bookHash: string, kind: string, sectionIndex?: number) =>
    `${bookHash}:${kind}:${kind === 'chapter' ? (sectionIndex ?? 'unknown') : 'all'}`,
}));

vi.mock('@/services/ai/adapters', () => ({
  LegacyIdbBackend: class {},
  ReedyBackend: class {},
  selectBackend: () => ({
    kind: 'legacy-idb',
    isIndexed: h.isIndexed,
    indexBook: h.indexBook,
    clearBook: vi.fn(),
    searchBook: vi.fn(),
  }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: null }),
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/i18n/i18n', () => ({
  default: { resolvedLanguage: 'en', language: 'en' },
}));

function report(overrides: Partial<AIAnalysisReport> = {}): AIAnalysisReport {
  return {
    id: `${BOOK_HASH}:chapter:3`,
    bookHash: BOOK_HASH,
    bookTitle: 'Test Book',
    kind: 'chapter',
    sectionIndex: 3,
    chapterTitle: 'Chapter Four',
    content: '## Key events\n\nThe protagonist leaves the village.',
    model: 'test-model',
    status: 'complete',
    sources: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function renderView() {
  return render(<AnalysisView bookKey={`${BOOK_HASH}-0`} />);
}

beforeEach(() => {
  h.settings.aiSettings.enabled = true;
  h.reports = {};
  h.loadedBooks = { [BOOK_HASH]: true };
  h.loadingBooks = {};
  h.isIndexed.mockResolvedValue(true);
  h.loadReports.mockClear();
  h.startAnalysis.mockClear();
  h.cancelAnalysis.mockClear();
  h.deleteReport.mockClear();
  h.indexBook.mockClear();
  h.goTo.mockClear();
});

afterEach(cleanup);

describe('AnalysisView', () => {
  test('defaults to the chapter scope and shows the empty state', () => {
    renderView();

    expect(
      screen.getByRole('button', { name: 'Chapter Analysis' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Book Analysis' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByText('No analysis yet')).toBeTruthy();
    expect(screen.getByText('Chapter Four')).toBeTruthy();
    expect(h.loadReports).toHaveBeenCalledWith(BOOK_HASH, {
      bookTitle: 'Test Book',
      authorName: 'Test Author',
      toc: [],
    });
  });

  test('starts a chapter analysis for the current section', () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /Generate analysis/ }));

    expect(h.startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chapter',
        bookHash: BOOK_HASH,
        bookTitle: 'Test Book',
        authorName: 'Test Author',
        sectionIndex: 3,
        chapterTitle: 'Chapter Four',
        currentPage: 7,
        language: 'en',
      }),
    );
  });

  test('starts a whole-book analysis from the book scope', async () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Book Analysis' }));
    expect(screen.getByText('Whole book')).toBeTruthy();
    await screen.findByText('No analysis yet');

    fireEvent.click(screen.getByRole('button', { name: /Generate analysis/ }));

    expect(h.startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'book',
        bookHash: BOOK_HASH,
        backend: expect.objectContaining({ kind: 'legacy-idb' }),
      }),
    );
  });

  test('asks to index the book before a whole-book analysis', async () => {
    h.isIndexed.mockResolvedValue(false);
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Book Analysis' }));

    await screen.findByText('Index This Book');
    fireEvent.click(screen.getByRole('button', { name: /Start Indexing/ }));

    await waitFor(() => expect(h.indexBook).toHaveBeenCalled());
    expect(h.indexBook).toHaveBeenCalledWith(
      expect.anything(),
      BOOK_HASH,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    await screen.findByText('No analysis yet');
  });

  test('renders a completed report with markdown, model, coverage and sources', () => {
    h.reports = {
      [`${BOOK_HASH}:chapter:3`]: report({
        coverage: 'The complete current chapter text was analyzed.',
        sources: [
          {
            id: '3-chapter',
            chapterTitle: 'Chapter Four',
            sectionIndex: 3,
            text: 'The protagonist leaves the village.',
            score: 1,
            cfi: '/body/DocFragment[3]',
          },
        ],
      }),
    };

    renderView();

    expect(screen.getByRole('heading', { name: 'Key events' })).toBeTruthy();
    // Once in the report body, once as the source excerpt.
    expect(screen.getAllByText('The protagonist leaves the village.')).toHaveLength(2);
    expect(screen.getByText('test-model')).toBeTruthy();
    expect(screen.getByText('The complete current chapter text was analyzed.')).toBeTruthy();
    expect(screen.getByText(/Sources/)).toBeTruthy();

    fireEvent.click(screen.getByText(/\[S1\]/));
    expect(h.goTo).toHaveBeenCalledWith('/body/DocFragment[3]', { focus: true });
  });

  test('shows a failed report with a retry action', () => {
    h.reports = {
      [`${BOOK_HASH}:chapter:3`]: report({
        status: 'error',
        content: '',
        error: 'Provider unavailable',
      }),
    };

    renderView();

    expect(screen.getByText('Analysis failed')).toBeTruthy();
    expect(screen.getByText('Provider unavailable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(h.startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chapter', sectionIndex: 3 }),
    );
  });

  test('shows a running report and can cancel it', () => {
    h.reports = {
      [`${BOOK_HASH}:chapter:3`]: report({ status: 'running', content: '' }),
    };

    renderView();

    expect(screen.getByText('Analyzing...')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    expect(h.cancelAnalysis).toHaveBeenCalledWith(`${BOOK_HASH}:chapter:3`);
  });

  test('asks for AI to be enabled when it is off', () => {
    h.settings.aiSettings.enabled = false;
    renderView();

    expect(screen.getByText('Enable AI in Settings')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Generate analysis/ })).toBeNull();
  });
});
