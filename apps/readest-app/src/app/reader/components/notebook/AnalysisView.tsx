'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangleIcon,
  BookOpenIcon,
  Clock3Icon,
  Loader2Icon,
  PlayIcon,
  RotateCwIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';

import i18n from '@/i18n/i18n';
import { Button } from '@/components/ui/button';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { isTauriAppPlatform } from '@/services/environment';
import {
  LegacyIdbBackend,
  ReedyBackend,
  selectBackend,
  type RetrievalBackend,
} from '@/services/ai/adapters';
import { getAnalysisReportId } from '@/services/ai/analysisService';
import type {
  AIAnalysisKind,
  AIAnalysisReport,
  AIAnalysisSource,
  EmbeddingProgress,
} from '@/services/ai/types';
import { useAIAnalysisStore } from '@/store/aiAnalysisStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { AppService } from '@/types/system';

interface AnalysisViewProps {
  bookKey: string;
}

function formatReportTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(i18n.resolvedLanguage || i18n.language || 'en');
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/**
 * Notebook "Analysis" tab: durable, evidence-grounded chapter and whole-book
 * reports. Generation and persistence live in `analysisService` and
 * `aiAnalysisStore`; this component only picks the scope and renders it.
 */
const AnalysisView: React.FC<AnalysisViewProps> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const bookData = getBookData(bookKey);
  const progress = useBookProgress(bookKey);

  const reports = useAIAnalysisStore((s) => s.reports);
  const loadedBooks = useAIAnalysisStore((s) => s.loadedBooks);
  const loadingBooks = useAIAnalysisStore((s) => s.loadingBooks);
  const loadReports = useAIAnalysisStore((s) => s.loadReports);
  const startAnalysis = useAIAnalysisStore((s) => s.startAnalysis);
  const cancelAnalysis = useAIAnalysisStore((s) => s.cancelAnalysis);
  const deleteReport = useAIAnalysisStore((s) => s.deleteReport);

  const [kind, setKind] = useState<AIAnalysisKind>('chapter');
  const [indexed, setIndexed] = useState(false);
  const [isLoadingIndex, setIsLoadingIndex] = useState(true);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<EmbeddingProgress | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  const aiSettings = settings?.aiSettings;
  const aiEnabled = aiSettings?.enabled === true;
  const bookHash = bookKey.split('-')[0] || '';
  const bookDoc = bookData?.bookDoc ?? null;
  const bookTitle = bookData?.book?.title || _('Unknown');
  const authorName = bookData?.book?.author || '';
  const currentPage = progress?.pageinfo?.current ?? 0;
  const sectionIndex = progress?.section?.current ?? 0;
  const chapterTitle = progress?.sectionLabel || null;

  // Same backend gate the chat adapter uses: Reedy on Tauri when enabled,
  // the legacy IndexedDB index everywhere else.
  const backend = useMemo<RetrievalBackend | null>(() => {
    if (!aiSettings) return null;
    const legacy = new LegacyIdbBackend(aiSettings);
    const reedy: RetrievalBackend | null =
      appService && isTauriAppPlatform()
        ? new ReedyBackend(appService as AppService, aiSettings)
        : null;
    return selectBackend({ settings: aiSettings, isTauri: isTauriAppPlatform(), legacy, reedy });
  }, [aiSettings, appService]);

  useEffect(() => {
    let alive = true;
    if (!bookHash || !backend) {
      setIsLoadingIndex(false);
      return;
    }
    setIsLoadingIndex(true);
    backend
      .isIndexed(bookHash)
      .then((value) => {
        if (alive) setIndexed(value);
      })
      .catch(() => {
        if (alive) setIndexed(false);
      })
      .finally(() => {
        if (alive) setIsLoadingIndex(false);
      });
    return () => {
      alive = false;
    };
  }, [backend, bookHash]);

  useEffect(() => {
    if (!bookHash || !bookDoc) return;
    void loadReports(bookHash, { bookTitle, authorName, toc: bookDoc.toc ?? [] });
  }, [authorName, bookDoc, bookHash, bookTitle, loadReports]);

  const handleIndex = useCallback(async () => {
    if (!bookDoc || !backend || isIndexing) return;
    setIndexError(null);
    setIsIndexing(true);
    try {
      await backend.indexBook(bookDoc, bookHash, { onProgress: setIndexProgress });
      setIndexed(true);
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : String(error));
      setIndexed(false);
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
    }
  }, [backend, bookDoc, bookHash, isIndexing]);

  const reportId = getAnalysisReportId(
    bookHash,
    kind,
    kind === 'chapter' ? sectionIndex : undefined,
  );
  const report = reports[reportId];
  const isRunning = report?.status === 'queued' || report?.status === 'running';
  const reportsReady = loadedBooks[bookHash] === true;
  const isLoadingReports =
    !report && !!bookDoc && (loadingBooks[bookHash] === true || !reportsReady);

  const handleGenerate = useCallback(() => {
    if (!aiEnabled || !aiSettings || !bookDoc) return;
    if (kind === 'book' && (!backend || !indexed)) return;
    startAnalysis({
      kind,
      settings: aiSettings,
      backend: backend ?? undefined,
      bookDoc,
      bookHash,
      bookTitle,
      authorName,
      sectionIndex,
      chapterTitle,
      currentPage,
      language: i18n.resolvedLanguage || i18n.language || 'en',
    });
  }, [
    aiEnabled,
    aiSettings,
    authorName,
    backend,
    bookDoc,
    bookHash,
    bookTitle,
    chapterTitle,
    currentPage,
    indexed,
    kind,
    sectionIndex,
    startAnalysis,
  ]);

  const handleDelete = useCallback(() => {
    if (report) void deleteReport(report.id);
  }, [deleteReport, report]);

  const handleSourceClick = useCallback(
    (source: AIAnalysisSource) => {
      if (!source.cfi) return;
      getView(bookKey)?.goTo(source.cfi, { focus: true });
    },
    [bookKey, getView],
  );

  const scopeTitle = kind === 'chapter' ? chapterTitle || _('This chapter') : _('Whole book');
  const canGenerate = aiEnabled && !!bookDoc && (kind === 'chapter' || (!!backend && indexed));

  return (
    <div className='flex h-full min-h-0 flex-col' data-analysis-view>
      <div className='border-base-300/70 shrink-0 border-b px-3 py-2'>
        <div
          className='bg-base-200/60 grid grid-cols-2 gap-0.5 rounded-lg p-0.5'
          role='group'
          aria-label={_('Analysis scope')}
        >
          <ScopeButton
            selected={kind === 'chapter'}
            onClick={() => setKind('chapter')}
            label={_('Chapter Analysis')}
          />
          <ScopeButton
            selected={kind === 'book'}
            onClick={() => setKind('book')}
            label={_('Book Analysis')}
          />
        </div>

        <div className='mt-2 flex items-center justify-between gap-2'>
          <h2 className='text-base-content min-w-0 truncate text-sm font-medium' title={scopeTitle}>
            {scopeTitle}
          </h2>
          <div className='flex shrink-0 items-center gap-1'>
            {aiEnabled && isRunning ? (
              <Button
                size='sm'
                variant='outline'
                className='h-8 px-2.5 text-xs'
                onClick={() => report && cancelAnalysis(report.id)}
              >
                <XIcon className='size-3.5' />
                {_('Cancel')}
              </Button>
            ) : aiEnabled ? (
              <Button
                size='sm'
                className='h-8 px-2.5 text-xs'
                disabled={!canGenerate}
                title={kind === 'book' && !indexed ? _('Index this book first') : undefined}
                onClick={handleGenerate}
              >
                {report ? <RotateCwIcon className='size-3.5' /> : <PlayIcon className='size-3.5' />}
                {report ? _('Regenerate') : _('Generate')}
              </Button>
            ) : null}
            {report && !isRunning && (
              <Button
                size='icon-sm'
                variant='ghost'
                aria-label={_('Delete analysis')}
                title={_('Delete analysis')}
                onClick={handleDelete}
              >
                <Trash2Icon className='size-3.5' />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-3'>
        {!aiEnabled ? (
          <Notice
            icon={<SparklesIcon className='text-base-content/30 size-7' />}
            title={_('AI Assistant')}
            description={_('Enable AI in Settings')}
          />
        ) : isLoadingReports ? (
          <Notice
            icon={<Loader2Icon className='text-primary size-6 animate-spin' />}
            title={_('Loading saved analyses...')}
          />
        ) : kind === 'book' && !indexed ? (
          <IndexState
            isLoading={isLoadingIndex}
            isIndexing={isIndexing}
            progress={indexProgress}
            error={indexError}
            onIndex={() => void handleIndex()}
            canIndex={!!bookDoc && !!backend}
          />
        ) : isRunning ? (
          <RunningState report={report} />
        ) : report && (report.status === 'error' || report.status === 'cancelled') ? (
          <FailureState
            report={report}
            canRetry={canGenerate}
            onRetry={handleGenerate}
            onDelete={handleDelete}
          />
        ) : report ? (
          <ReportView report={report} onSourceClick={handleSourceClick} />
        ) : (
          <EmptyState kind={kind} canGenerate={canGenerate} onGenerate={handleGenerate} />
        )}
      </div>
    </div>
  );
};

const ScopeButton: React.FC<{
  selected: boolean;
  label: string;
  onClick: () => void;
}> = ({ selected, label, onClick }) => (
  <button
    type='button'
    aria-pressed={selected}
    onClick={onClick}
    className={
      selected
        ? 'bg-base-100 text-base-content min-h-7 rounded-md px-2 text-xs font-medium shadow-xs'
        : 'text-base-content/60 hover:text-base-content min-h-7 rounded-md px-2 text-xs transition-colors'
    }
  >
    {label}
  </button>
);

function Notice({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className='text-base-content/50 flex h-full flex-col items-center justify-center gap-2 px-5 text-center'>
      {icon}
      <h3 className='text-base-content text-sm font-medium'>{title}</h3>
      {description && <p className='max-w-sm text-xs leading-5'>{description}</p>}
    </div>
  );
}

function EmptyState({
  kind,
  canGenerate,
  onGenerate,
}: {
  kind: AIAnalysisKind;
  canGenerate: boolean;
  onGenerate: () => void;
}) {
  const _ = useTranslation();
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 px-4 text-center'>
      <div className='bg-primary/10 rounded-full p-3'>
        <SparklesIcon className='text-primary size-6' />
      </div>
      <div>
        <h3 className='text-base-content mb-1 text-sm font-medium'>{_('No analysis yet')}</h3>
        <p className='text-base-content/50 text-xs'>
          {kind === 'chapter'
            ? _('Generate an evidence-based analysis of this chapter.')
            : _('Generate an evidence-based overview from indexed passages across the book.')}
        </p>
      </div>
      <Button size='sm' className='h-8 text-xs' onClick={onGenerate} disabled={!canGenerate}>
        <SparklesIcon className='size-3.5' />
        {_('Generate analysis')}
      </Button>
    </div>
  );
}

function IndexState({
  isLoading,
  isIndexing,
  progress,
  error,
  onIndex,
  canIndex,
}: {
  isLoading: boolean;
  isIndexing: boolean;
  progress: EmbeddingProgress | null;
  error: string | null;
  onIndex: () => void;
  canIndex: boolean;
}) {
  const _ = useTranslation();
  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const progressLabel =
    progress?.phase === 'embedding'
      ? `${progress.current} / ${progress.total} ${_('chunks')}`
      : progress?.phase === 'chunking'
        ? _('Analyzing chapters...')
        : progress?.phase === 'loading-model'
          ? _('Loading embedding model...')
          : _('Preparing...');

  if (isLoading) {
    return (
      <Notice
        icon={<Loader2Icon className='text-primary size-6 animate-spin' />}
        title={_('Checking index status...')}
      />
    );
  }

  if (isIndexing) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
        <Loader2Icon className='text-primary size-6 animate-spin' />
        <div>
          <p className='text-base-content mb-1 text-sm font-medium'>{_('Indexing book...')}</p>
          <p className='text-base-content/50 text-xs'>{progressLabel}</p>
        </div>
        <div className='bg-muted h-1.5 w-32 overflow-hidden rounded-full'>
          <div
            className='bg-primary h-full transition-all duration-300'
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 px-5 text-center'>
        <div className='bg-warning/10 rounded-full p-3'>
          <AlertTriangleIcon className='text-warning size-6' />
        </div>
        <div>
          <h3 className='text-base-content text-sm font-medium'>{_('Indexing failed')}</h3>
          <p className='text-base-content/55 mt-1 max-h-32 overflow-y-auto text-xs leading-5'>
            {error}
          </p>
        </div>
        <Button size='sm' variant='outline' className='h-8 text-xs' onClick={onIndex}>
          <RotateCwIcon className='size-3.5' />
          {_('Retry indexing')}
        </Button>
      </div>
    );
  }

  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
      <div className='bg-primary/10 rounded-full p-3'>
        <BookOpenIcon className='text-primary size-6' />
      </div>
      <div>
        <h3 className='text-base-content mb-0.5 text-sm font-medium'>{_('Index This Book')}</h3>
        <p className='text-base-content/50 text-xs'>
          {_('Whole-book analysis searches the book index.')}
        </p>
      </div>
      <Button size='sm' className='h-8 text-xs' onClick={onIndex} disabled={!canIndex}>
        <BookOpenIcon className='size-3.5' />
        {_('Start Indexing')}
      </Button>
    </div>
  );
}

function RunningState({ report }: { report?: AIAnalysisReport }) {
  const _ = useTranslation();
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 px-5 text-center'>
      <Loader2Icon className='text-primary size-7 animate-spin' />
      <div>
        <h3 className='text-base-content text-sm font-medium'>
          {report?.status === 'queued' ? _('Analysis queued') : _('Analyzing...')}
        </h3>
        <p className='text-base-content/50 mt-1 text-xs'>
          {report?.kind === 'chapter'
            ? _('Reading the current chapter and preparing an evidence-grounded report.')
            : _('Searching the book index and preparing an evidence-grounded report.')}
        </p>
        {report?.model && (
          <p className='text-base-content/40 mt-2 font-mono text-[10px]'>{report.model}</p>
        )}
      </div>
    </div>
  );
}

function FailureState({
  report,
  canRetry,
  onRetry,
  onDelete,
}: {
  report: AIAnalysisReport;
  canRetry: boolean;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const _ = useTranslation();
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 px-5 text-center'>
      <div className='bg-warning/10 rounded-full p-3'>
        <AlertTriangleIcon className='text-warning size-6' />
      </div>
      <div>
        <h3 className='text-base-content text-sm font-medium'>
          {report.status === 'cancelled' ? _('Analysis cancelled') : _('Analysis failed')}
        </h3>
        <p className='text-base-content/55 mt-1 max-h-32 overflow-y-auto text-xs leading-5'>
          {report.error || _('Unknown error')}
        </p>
      </div>
      <div className='flex items-center gap-2'>
        {canRetry && (
          <Button size='sm' variant='outline' className='h-8 text-xs' onClick={onRetry}>
            <RotateCwIcon className='size-3.5' />
            {_('Retry')}
          </Button>
        )}
        <Button size='sm' variant='ghost' className='h-8 text-xs' onClick={onDelete}>
          <Trash2Icon className='size-3.5' />
          {_('Delete analysis')}
        </Button>
      </div>
    </div>
  );
}

function ReportView({
  report,
  onSourceClick,
}: {
  report: AIAnalysisReport;
  onSourceClick: (source: AIAnalysisSource) => void;
}) {
  const _ = useTranslation();
  return (
    <article className='flex flex-col gap-4' data-analysis-report>
      <div className='text-base-content/45 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]'>
        <span className='inline-flex items-center gap-1'>
          <Clock3Icon className='size-3' />
          {formatReportTime(report.updatedAt)}
        </span>
        <span className='font-mono'>{report.model}</span>
        {report.sources.length > 0 && (
          <span>{_('{{count}} sources', { count: report.sources.length })}</span>
        )}
      </div>

      {report.coverage && (
        <div className='border-primary/20 bg-primary/5 text-base-content/65 rounded-lg border px-3 py-2 text-xs leading-5'>
          <div className='text-base-content mb-0.5 font-medium'>{_('Evidence limits')}</div>
          {report.coverage}
        </div>
      )}

      <div className='prose prose-sm dark:prose-invert text-base-content max-w-none break-words'>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.content}</ReactMarkdown>
      </div>

      {report.sources.length > 0 && (
        <section className='border-base-300/70 border-t pt-3'>
          <h3 className='text-base-content mb-2 text-xs font-semibold'>
            {_('Sources')} ({report.sources.length})
          </h3>
          <ul className='space-y-1.5'>
            {report.sources.map((source, index) => {
              const body = (
                <>
                  <div className='text-base-content/55 mb-1 flex items-center justify-between gap-2 text-[11px]'>
                    <span className='truncate'>
                      [S{index + 1}]{' '}
                      {source.chapterTitle ||
                        _('Section {{index}}', { index: source.sectionIndex + 1 })}
                    </span>
                    {source.pageNumber !== undefined && (
                      <span className='shrink-0'>
                        {_('Page {{page}}', { page: source.pageNumber })}
                      </span>
                    )}
                  </div>
                  <p className='text-base-content/70 line-clamp-3 text-xs leading-5'>
                    {source.text}
                  </p>
                </>
              );

              return (
                <li key={`${source.id}-${index}`}>
                  {source.cfi ? (
                    <button
                      type='button'
                      onClick={() => onSourceClick(source)}
                      className='border-base-300 bg-base-100 hover:border-primary/40 hover:bg-base-200/60 w-full rounded-lg border p-2.5 text-left transition-colors'
                    >
                      {body}
                    </button>
                  ) : (
                    <div className='border-base-300 bg-base-100 rounded-lg border p-2.5'>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

export default AnalysisView;
