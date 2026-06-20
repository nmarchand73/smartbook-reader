'use client';

import { useEffect, useRef, useCallback, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useEpub } from '@/context/EpubContext';
import { getCachedExplanation, setCachedExplanation } from '@/lib/cache';
import type { Paragraph } from '@/lib/epub-parser';

const PARAGRAPHS_PER_PAGE = 5;
const FONT_SIZE_STORAGE_KEY = 'sbr_reader_font_size';
const DEFAULT_BOOK_FONT_SIZE = 18;
const MIN_BOOK_FONT_SIZE = 15;
const MAX_BOOK_FONT_SIZE = 24;
const BOOK_FONT_SIZE_STEP = 1;
const SPLIT_STORAGE_KEY = 'sbr_reader_split_percent';
const DEFAULT_SPLIT_PERCENT = 42;
const MIN_SPLIT_PERCENT = 28;
const MAX_SPLIT_PERCENT = 64;

// ── Streaming fetch helper ────────────────────────────────────────────────────

async function fetchExplanation(
  passage: string,
  bookTitle: string,
  author: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passage, bookTitle, author }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Erreur serveur : ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    onChunk(full);
  }

  return full;
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function ExplanationSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-label="Génération en cours…">
      <div className="h-4 bg-slate-200 rounded w-full" />
      <div className="h-4 bg-slate-200 rounded w-5/6" />
      <div className="h-4 bg-slate-200 rounded w-full" />
      <div className="h-4 bg-slate-200 rounded w-4/5" />
      <div className="h-4 bg-slate-200 rounded w-full" />
      <div className="h-4 bg-slate-200 rounded w-3/4" />
    </div>
  );
}

// ── Main reader ───────────────────────────────────────────────────────────────

export default function ReaderPage() {
  const { epub, currentIndex, navigate } = useEpub();
  const router = useRouter();

  const [explanation, setExplanation] = useState<string | null>(null);
  const [explainedParagraphIndex, setExplainedParagraphIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bookFontSize, setBookFontSize] = useState(DEFAULT_BOOK_FONT_SIZE);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT);
  const [isResizingSplit, setIsResizingSplit] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  // Redirect to upload if no epub is loaded
  useEffect(() => {
    if (epub === null) {
      // Give context a moment to rehydrate from sessionStorage
      const t = setTimeout(() => {
        if (!epub) router.replace('/');
      }, 300);
      return () => clearTimeout(t);
    }
  }, [epub, router]);

  useEffect(() => {
    try {
      const storedFontSize = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (!storedFontSize) return;

      const parsedFontSize = Number(storedFontSize);
      if (!Number.isFinite(parsedFontSize)) return;

      setBookFontSize(Math.min(MAX_BOOK_FONT_SIZE, Math.max(MIN_BOOK_FONT_SIZE, parsedFontSize)));
    } catch {
      // Keep the default size when localStorage is unavailable.
    }
  }, []);

  const updateBookFontSize = useCallback((nextSize: number) => {
    const clampedSize = Math.min(MAX_BOOK_FONT_SIZE, Math.max(MIN_BOOK_FONT_SIZE, nextSize));
    setBookFontSize(clampedSize);

    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, clampedSize.toString());
    } catch {
      // Font size still updates for the current session.
    }
  }, []);

  useEffect(() => {
    try {
      const storedSplitPercent = localStorage.getItem(SPLIT_STORAGE_KEY);
      if (!storedSplitPercent) return;

      const parsedSplitPercent = Number(storedSplitPercent);
      if (!Number.isFinite(parsedSplitPercent)) return;

      setSplitPercent(Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, parsedSplitPercent)));
    } catch {
      // Keep the default split when localStorage is unavailable.
    }
  }, []);

  const updateSplitPercent = useCallback((nextPercent: number) => {
    const clampedPercent = Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, nextPercent));
    setSplitPercent(clampedPercent);

    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, clampedPercent.toString());
    } catch {
      // Split still updates for the current session.
    }
  }, []);

  const handleSplitResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsResizingSplit(true);
  }, []);

  const handleSplitKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        updateSplitPercent(splitPercent - 2);
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        updateSplitPercent(splitPercent + 2);
      }
    },
    [splitPercent, updateSplitPercent]
  );

  useEffect(() => {
    if (!isResizingSplit) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const mainElement = mainRef.current;
      if (!mainElement) return;

      const bounds = mainElement.getBoundingClientRect();
      const nextPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
      updateSplitPercent(nextPercent);
    };

    const handlePointerUp = () => setIsResizingSplit(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isResizingSplit, updateSplitPercent]);

  const loadExplanation = useCallback(
    async (paragraph: Paragraph, epubTitle: string, epubAuthor: string) => {
      setExplainedParagraphIndex(paragraph.globalIndex);

      // Check cache first
      const cached = getCachedExplanation(epubTitle, paragraph.text);
      if (cached) {
        setExplanation(cached);
        setIsLoading(false);
        setLoadError(null);
        return;
      }

      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setExplanation(null);
      setIsLoading(true);
      setLoadError(null);

      try {
        const full = await fetchExplanation(
          paragraph.text,
          epubTitle,
          epubAuthor,
          text => {
            setExplanation(text);
          },
          controller.signal
        );
        setCachedExplanation(epubTitle, paragraph.text, full);
        setIsLoading(false);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setLoadError('Impossible de générer l\'explication. Vérifiez votre connexion.');
        setIsLoading(false);
      }
    },
    []
  );

  const resetExplanation = useCallback(() => {
    abortRef.current?.abort();
    setExplanation(null);
    setExplainedParagraphIndex(null);
    setIsLoading(false);
    setLoadError(null);
  }, []);

  const selectParagraph = useCallback(
    (index: number) => {
      navigate(index);
      if (explainedParagraphIndex !== index) resetExplanation();
    },
    [explainedParagraphIndex, navigate, resetExplanation]
  );

  const explainParagraph = useCallback(
    (paragraph: Paragraph) => {
      if (!epub) return;
      navigate(paragraph.globalIndex);
      loadExplanation(paragraph, epub.title, epub.author);
    },
    [epub, loadExplanation, navigate]
  );

  // Cancel in-flight generation when leaving the reader
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const pageStart = Math.floor(currentIndex / PARAGRAPHS_PER_PAGE) * PARAGRAPHS_PER_PAGE;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        resetExplanation();
        navigate(pageStart + PARAGRAPHS_PER_PAGE);
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        resetExplanation();
        navigate(pageStart - PARAGRAPHS_PER_PAGE);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIndex, navigate, resetExplanation]);

  if (!epub) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Chargement…
      </div>
    );
  }

  const currentPage = Math.floor(currentIndex / PARAGRAPHS_PER_PAGE);
  const pageStartIndex = currentPage * PARAGRAPHS_PER_PAGE;
  const pageParagraphs = epub.paragraphs.slice(pageStartIndex, pageStartIndex + PARAGRAPHS_PER_PAGE);
  const paragraph = epub.paragraphs[currentIndex];
  const total = epub.paragraphs.length;
  const totalPages = Math.ceil(total / PARAGRAPHS_PER_PAGE);
  const isFirst = currentPage === 0;
  const isLast = currentPage === totalPages - 1;
  const pageChapterTitles = Array.from(new Set(pageParagraphs.map(item => item.chapterTitle)));
  const chapterLabel = pageChapterTitles.length > 1
    ? `${pageChapterTitles[0]} - ${pageChapterTitles[pageChapterTitles.length - 1]}`
    : pageChapterTitles[0];

  return (
    <div className="flex flex-col h-screen bg-stone-50 overflow-hidden">
      {/* ── Header ── */}
      <header className="flex-none flex items-center justify-between gap-4 px-5 py-3 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl">📖</span>
          <div className="min-w-0">
            <h1 className="font-semibold text-slate-900 truncate leading-tight">
              {epub.title}
            </h1>
            <p className="text-xs text-slate-400 truncate">{epub.author}</p>
          </div>
        </div>
        <div className="flex flex-none items-center gap-3">
          <div
            className="flex items-center rounded-full border border-stone-200 bg-stone-50 p-1 shadow-sm"
            aria-label="Réglage de la taille du texte"
          >
            <button
              type="button"
              onClick={() => updateBookFontSize(bookFontSize - BOOK_FONT_SIZE_STEP)}
              disabled={bookFontSize <= MIN_BOOK_FONT_SIZE}
              aria-label="Réduire la taille du texte"
              className="rounded-full px-3 py-1 text-xs font-semibold text-stone-500 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              A−
            </button>
            <span className="px-2 font-serif text-sm text-stone-700" aria-hidden="true">
              Aa
            </span>
            <button
              type="button"
              onClick={() => updateBookFontSize(bookFontSize + BOOK_FONT_SIZE_STEP)}
              disabled={bookFontSize >= MAX_BOOK_FONT_SIZE}
              aria-label="Augmenter la taille du texte"
              className="rounded-full px-3 py-1 text-base font-semibold text-stone-700 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              A+
            </button>
          </div>
          <button
            onClick={() => router.push('/')}
            className="text-xs text-slate-400 hover:text-slate-700 transition-colors whitespace-nowrap"
          >
            ← Changer de livre
          </button>
        </div>
      </header>

      {/* ── Chapter label ── */}
      {chapterLabel && (
        <div className="flex-none px-5 py-2 bg-stone-100 border-b border-stone-200 text-xs text-stone-500 font-medium uppercase tracking-wide">
          {chapterLabel}
        </div>
      )}

      {/* ── Main panels ── */}
      <main
        ref={mainRef}
        className={[
          'flex-1 flex flex-col-reverse md:flex-row overflow-hidden',
          isResizingSplit ? 'select-none cursor-col-resize' : '',
        ].join(' ')}
        style={{ '--reader-split-percent': `${splitPercent}%` } as CSSProperties}
      >
        {/* Left: AI explanation (appears bottom on mobile, left on desktop) */}
        <section
          aria-label="Explication IA"
          className="reader-explanation-pane flex-1 md:flex-none overflow-y-auto panel-scroll bg-stone-100 border-t md:border-t-0 border-stone-200 px-6 md:px-10 py-8"
        >
          <div className="max-w-prose mx-auto">
            <div className="flex items-center gap-2 mb-5">
              <span className="text-violet-500 text-lg">✨</span>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-500">
                Explication à la demande
              </h2>
            </div>

            <div className="mb-5 rounded-xl border border-violet-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-violet-500">
                Paragraphe sélectionné
              </p>
              <p className="mt-2 line-clamp-4 font-serif text-sm leading-relaxed text-stone-600">
                {paragraph?.text}
              </p>
              {paragraph && (
                <button
                  type="button"
                  onClick={() => explainParagraph(paragraph)}
                  disabled={isLoading && explainedParagraphIndex === paragraph.globalIndex}
                  className="mt-4 inline-flex items-center rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-wait disabled:bg-violet-300"
                >
                  {isLoading && explainedParagraphIndex === paragraph.globalIndex
                    ? 'Génération...'
                    : 'Expliquer ce paragraphe'}
                </button>
              )}
            </div>

            {isLoading && !explanation && <ExplanationSkeleton />}

            {loadError && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {loadError}
                <button
                  onClick={() => paragraph && explainParagraph(paragraph)}
                  className="mt-2 block text-red-700 underline hover:no-underline"
                >
                  Réessayer
                </button>
              </div>
            )}

            {explanation && (
              <p className="rounded-2xl bg-white p-5 text-stone-700 shadow-sm leading-relaxed text-[15px]">
                {explanation}
                {isLoading && (
                  <span className="inline-block w-0.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                )}
              </p>
            )}

            {!isLoading && !loadError && !explanation && (
              <div className="rounded-xl border border-dashed border-stone-200 bg-white/70 p-5 text-sm leading-relaxed text-stone-500">
                Cliquez sur « Expliquer » dans un paragraphe, ou utilisez le bouton ci-dessus,
                pour générer une explication uniquement quand vous en avez besoin.
              </div>
            )}
          </div>
        </section>

        <button
          type="button"
          role="separator"
          aria-label="Ajuster la largeur des panneaux"
          aria-orientation="vertical"
          aria-valuemin={MIN_SPLIT_PERCENT}
          aria-valuemax={MAX_SPLIT_PERCENT}
          aria-valuenow={Math.round(splitPercent)}
          onPointerDown={handleSplitResizeStart}
          onKeyDown={handleSplitKeyDown}
          className="reader-splitter hidden md:flex flex-none items-center justify-center bg-stone-200 transition-colors hover:bg-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <span className="h-10 w-1 rounded-full bg-stone-400/60" />
        </button>

        {/* Right: Book text */}
        <section
          aria-label="Texte du livre"
          className="reader-book-pane flex-1 md:flex-none overflow-y-auto panel-scroll bg-stone-200/70 px-4 py-6 md:px-8 md:py-10"
        >
          <div className="mx-auto max-w-3xl">
            {pageParagraphs.length > 0 ? (
              <div
                className="book-page min-h-full rounded-sm px-8 py-10 md:px-16 md:py-16"
                style={{ '--book-font-size': `${bookFontSize}px` } as CSSProperties}
              >
                <div className="mb-10 border-b border-stone-200 pb-4 text-center">
                  <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-stone-400">
                    {chapterLabel}
                  </p>
                </div>
                <div className="space-y-5">
                  {pageParagraphs.map(item => {
                    const isSelected = item.globalIndex === currentIndex;
                    const isExplaining = isLoading && explainedParagraphIndex === item.globalIndex;

                    return (
                      <article
                        key={item.globalIndex}
                        className={[
                          'book-paragraph-block relative rounded-lg px-4 py-2 transition-colors',
                          isSelected
                            ? 'book-paragraph-active'
                            : '',
                        ].join(' ')}
                      >
                        <button
                          type="button"
                          onClick={() => selectParagraph(item.globalIndex)}
                          className="book-paragraph block w-full text-left"
                        >
                          {item.text}
                        </button>
                        <div className="book-explain-action mt-2 flex justify-end transition-opacity">
                          <button
                            type="button"
                            onClick={() => explainParagraph(item)}
                            disabled={isExplaining}
                            className="rounded-full border border-stone-300 bg-[#fffdf7]/95 px-3 py-1.5 text-xs font-medium text-violet-700 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:cursor-wait disabled:text-violet-300"
                          >
                            {isExplaining ? 'Génération...' : 'Expliquer'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-slate-400 italic">Fin du livre.</p>
            )}
          </div>
        </section>
      </main>

      {/* ── Navigation footer ── */}
      <footer className="flex-none flex items-center justify-between gap-4 px-5 py-3 bg-white border-t border-slate-200">
        <button
          onClick={() => {
            resetExplanation();
            navigate(pageStartIndex - PARAGRAPHS_PER_PAGE);
          }}
          disabled={isFirst}
          aria-label="Page précédente"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all
            disabled:opacity-30 disabled:cursor-not-allowed
            enabled:text-slate-700 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
        >
          ← Précédent
        </button>

        <span className="text-xs text-slate-400 tabular-nums">
          Page {currentPage + 1} / {totalPages}
        </span>

        <button
          onClick={() => {
            resetExplanation();
            navigate(pageStartIndex + PARAGRAPHS_PER_PAGE);
          }}
          disabled={isLast}
          aria-label="Page suivante"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all
            disabled:opacity-30 disabled:cursor-not-allowed
            enabled:text-slate-700 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
        >
          Suivant →
        </button>
      </footer>
    </div>
  );
}
