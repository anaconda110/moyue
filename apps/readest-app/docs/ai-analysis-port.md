# AI analysis service port — milestone 1

Port of the AI analysis **service layer** from `origin/feat/ai-analysis-rail`
(baseline 2026-10-25) onto `main` @ `679dc6b` (2026-11-28). UI work
(`Notebook.tsx`, `AIAssistant.tsx`, `HeaderBar.tsx`, `AIPanel.tsx`,
`NotebookAIToggler.tsx`) is deliberately out of scope and left for milestone 2.

The old branch was **never** rebased or merged; files were copied and adapted
one at a time against the current tree.

## Files

| File | Disposition |
| --- | --- |
| `src/services/ai/rag/engines.ts` | **dropped in** — no upstream equivalent exists |
| `src/services/ai/rag/settings.ts` | **dropped in** |
| `src/services/ai/rag/topK.ts` | **dropped in** |
| `src/services/ai/rag/LocalEmbeddingModel.ts` | **dropped in** (uses `EmbeddingModel` from `services/reedy/models`, unchanged upstream) |
| `src/services/ai/analysisService.ts` | **dropped in** — new file, no upstream counterpart; `ai` SDK version (`^6.0.299`) is the same on both branches so `generateText({ maxOutputTokens, maxRetries, abortSignal })` needed no change |
| `src/services/ai/import/aiNovelReaderV2.ts` | **adapted** — the 2.1 MB bundled dataset was removed (see below) |
| `src/store/aiAnalysisStore.ts` | **dropped in** |
| `src/services/ai/types.ts` | **adapted** — added `AIAnalysis*` types, the five retrieval settings fields, and two new `EmbeddingProgress['phase']` members |
| `src/services/ai/constants.ts` | **adapted** — `DEFAULT_AI_SETTINGS` gains `ragEngine`, `ragFallback`, `topKDefault`, `topKTiers`, `ragCacheLimitMB`; imports the defaults from `rag/` so there is one source of truth |
| `src/services/ai/utils/retry.ts` | **adapted** — added `INDEX_EMBEDDING_BATCH` timeout and `INDEX_EMBEDDING` retry config |
| `src/services/ai/storage/aiStore.ts` | **adapted** — IndexedDB v3 → v4 with an `analysisReports` store, report CRUD, and an optional `sectionIndex` filter on the vector and BM25 searches |
| `src/services/ai/adapters/retrievalBackend.ts` | **adapted** — added `IndexStats`, `SearchBookResponse`, `SearchOptions`, `searchBook()` and the optional `getIndexStats()` |
| `src/services/ai/adapters/LegacyIdbBackend.ts` | **adapted** — `getIndexStats`, `searchBook`, `sectionIndex` pass-through, `signal` pass-through to `indexBook` |
| `src/services/ai/adapters/ReedyBackend.ts` | **adapted, partially** — local embedding model, `getIndexStats`, `searchBook`; **the `sectionIndex`/`buildLookupTool` wiring was dropped** (see conflicts) |
| `src/services/ai/adapters/TauriChatAdapter.ts` | **adapted, partially** — size-aware `getTopKForChunkCount` retrieval breadth; **`consumeSectionIndex` was dropped** (see conflicts) |
| `src/services/ai/adapters/index.ts` | **adapted** — exports the new retrieval types |
| `src/services/ai/ragService.ts` | **adapted** — indexing now goes through `LocalEmbeddingModel` in bounded batches with per-batch progress/abort, dimension and count validation, and `sectionIndex` support in `hybridSearch` |
| `src/__tests__/ai/analysisService.test.ts` | **dropped in** unchanged |
| `src/__tests__/ai/rag-cache.test.ts` | **dropped in** unchanged |
| `src/__tests__/ai/rag-indexing.test.ts` | **dropped in** unchanged |
| `src/__tests__/ai/ai-novel-reader-import.test.ts` | **rewritten** against a synthetic dataset fixture (the real export is not in the repo) |
| `src/__tests__/store/ai-analysis-store.test.ts` | **dropped in** unchanged |
| `src/data/aiNovelReaderV2/*.json` | **not ported** — 2.1 MB historical export, explicitly out of scope |
| `patches/@assistant-ui__react@0.11.58.patch` | **not ported** — UI-layer patch, milestone 2 |

## Differences from the old implementation

### The bundled import dataset is gone

`import/aiNovelReaderV2.ts` used to `import rawDataset from
'@/data/aiNovelReaderV2/lingjing-xingzhe-chapters.json'`. Shipping a 2.1 MB
single-book export is not acceptable, and a literal dynamic import of a missing
file would fail the Vite build rather than degrade at runtime.

The importer now takes the dataset as an argument:

```ts
importAiNovelReaderV2Reports(context, { dataset, store? })
```

With no dataset it resolves to `0` and never touches storage, so
`aiAnalysisStore.loadReports()` (which calls it without a dataset) keeps
working and simply imports nothing. `store` stays injectable for tests, and the
dataset/match types (`AiNovelReaderV2Dataset`,
`AiNovelReaderV2DatasetReport`) are exported so a future loader can supply one.

**Milestone 2 recommendation:** read the export from the user's data directory
and pass it in. That needs a Tauri/`fetch`-based loader plus a file-picker in
settings; neither exists yet, so this milestone deliberately does not add one.

### `sectionIndex` stops at the legacy path

`SearchOptions.sectionIndex` (chapter-scoped retrieval for "chat about this
chapter") is wired through `aiStore.hybridSearch` → `ragService.hybridSearch` →
`LegacyIdbBackend`. On the old branch it was also threaded into Reedy's
`BookRetriever.search`, `buildLookupTool`, and `TauriChatAdapter`, which
required fork-only changes under `services/reedy/` (`RetrieveArgs`,
`lookupPassage` schema/cache key, `BookIndexer`). Those files are outside this
milestone's scope and upstream's `RetrieveArgs` has no `sectionIndex`, so the
Reedy side of chapter scoping and `TauriChatAdapter.consumeSectionIndex` were
left out. Nothing in milestone 1 calls them: chapter analysis reads the section
document directly instead of the retrieval index.

**Milestone 2:** add `sectionIndex` to `services/reedy/retrieval/BookRetriever`
(`RetrieveArgs`) and `tools/lookupPassage.ts`, then restore
`consumeSectionIndex` in `TauriChatAdapter` and `buildLookupTool`.

### Reedy index progress phases

`EmbeddingProgress['phase']` gained `loading-model` and `preparing`, but
`ReedyBackend`'s `phaseMap` still maps only the two phases upstream's
`BookIndexer` emits (`chunking`, `embedding`). The old branch widened
`BookIndexer`'s phase union at the same time; that change is part of the
`services/reedy` work deferred above.

### Indexing behaviour changes in `ragService`

- Embedding runs in `embeddingModel.batchSize` batches under
  `AI_TIMEOUTS.INDEX_EMBEDDING_BATCH` / `AI_RETRY_CONFIGS.INDEX_EMBEDDING`, and
  verifies vector count and dimension per batch before anything is persisted.
- A book that yields no extractable text now throws
  (`No extractable text was found in this book.`) instead of silently writing
  an empty index.
- `indexBook` accepts an `AbortSignal` and reports `chunking` progress per
  section.

### Embedding provider switch

`ragService` and `ReedyBackend` no longer embed through the chat provider
(`getAIProvider(...).getEmbeddingModel()`); they use `LocalEmbeddingModel`
backed by `@xenova/transformers`, with `ragFallback` defaulting to the built-in
TF-IDF hashing model when a semantic model cannot load. `@xenova/transformers
^2.17.2` was added to `apps/readest-app/package.json` and `pnpm-lock.yaml`; the
lockfile diff is that dependency plus its transitive packages
(`onnxruntime-*`, `flatbuffers`, `long@4`, …) and a few npm "deprecated"
metadata strings — no unrelated version changes.

Consequence to plan for: **existing indexes were embedded with the chat
provider's model and are not compatible with the new query embeddings.** The
legacy path does not compare `BookIndexMeta.embeddingModel` at search time, so
an old index silently degrades to BM25 + mismatched vectors instead of
reporting `stale_index`. Re-indexing fixes it. A follow-up should compare the
stored model id in `hybridSearch`/`isBookIndexed` and surface a "re-index this
book" state (Reedy already reports `stale_index`).

## Conflicts encountered

1. **`services/reedy` drifted between branches.** The old branch carries
   fork-only Reedy changes (section scoping, a registry rewrite, indexer
   phases, Reedy UI). Since only `services/ai/adapters/*` was in scope, the
   port keeps upstream Reedy untouched and drops the Reedy-side section
   plumbing described above.
2. **`EmbeddingProgress['phase']` is consumed by `AIAssistant.tsx`** (milestone
   1 does not touch that file). It only branches on `phase === 'embedding'` for
   the progress bar and otherwise shows "Preparing…", so the extra members are
   safe.
3. **Missing submodule / dependencies.** The worktree had no
   `node_modules` and an uninitialised `packages/foliate-js` submodule, so
   `pnpm install` first failed with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. After
   `git submodule update --init --depth 1 packages/foliate-js`, install
   succeeded: `pnpm install --filter @readest/readest-app... 
   --child-concurrency=1 --network-concurrency=8` (4m 27s, no OOM).

## Verification

- `pnpm --filter @readest/readest-app test --run <five test paths>`:
  **5 files / 25 tests passed**.
- `pnpm --filter @readest/readest-app test --run src/__tests__/ai` (all AI
  tests, including the pre-existing `ai-store`, `providers`, `constants`,
  `retry`, `chunker` suites): **9 files / 74 tests passed**.
- `biome lint` + `biome format` on every touched path: clean.
- `tsc --noEmit` over a scoped project containing `services/ai/**`, the new
  store and the five test files: **no errors in any ported file**. (The only
  diagnostics come from environment gaps the scoped project exposes:
  uninitialised `js-mdict` / `simplecc-wasm` / `tauri-plugin-turso` submodules,
  the `@pdfjs/*` path mapping, plus declaration-file-dependent errors in
  unrelated `bookshelves`/`readerStore` files that the scoped include omits.)
- Full-project `tsc --noEmit` was **not** completed on this machine; see
  "Residual issues".

## Residual issues / recommendations

1. **Full `tsc --noEmit` does not fit on this machine.** On the 3.8 GB box
   (≈1.3 GB free, 2 GB swap) the compiler died at a 2 GB heap with
   `FATAL ERROR: Ineffective mark-compacts near heap limit`; a 3 GB-heap run
   spent over 30 minutes swapping at ~2 GB RSS without producing diagnostics
   and had to be terminated. **`pnpm --filter @readest/readest-app lint` was
   therefore not run to completion** — CI or a larger machine must run it
   before merge. The scoped typecheck above covers every file this port
   touches.
2. **Stale legacy indexes** after the embedding-provider switch (see above).
3. **Dataset loading** for `ai-novel-reader-v2` is not wired; the importer is
   inert until milestone 2 supplies a dataset.
4. **Chapter-scoped chat retrieval on Reedy** needs the `services/reedy`
   changes described above.
5. No UI consumes `useAIAnalysisStore`, `searchBook`, or the new settings
   fields yet — milestone 2.
