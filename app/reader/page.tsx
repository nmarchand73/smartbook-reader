'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEpub } from '@/context/EpubContext';
import { getCachedExplanation, setCachedExplanation } from '@/lib/cache';
import type { Paragraph } from '@/lib/epub-parser';

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
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pregenRef = useRef<AbortController | null>(null);

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

  const loadExplanation = useCallback(
    async (paragraph: Paragraph, epubTitle: string, epubAuthor: string) => {
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
            setIsLoading(false);
          },
          controller.signal
        );
        setCachedExplanation(epubTitle, paragraph.text, full);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setLoadError('Impossible de générer l\'explication. Vérifiez votre connexion.');
        setIsLoading(false);
      }
    },
    []
  );

  const pregenNext = useCallback(
    (index: number, epubTitle: string, epubAuthor: string, paragraphs: Paragraph[]) => {
      const nextPara = paragraphs[index + 1];
      if (!nextPara) return;
      if (getCachedExplanation(epubTitle, nextPara.text)) return; // already cached

      pregenRef.current?.abort();
      const controller = new AbortController();
      pregenRef.current = controller;

      let accumulated = '';
      fetchExplanation(
        nextPara.text,
        epubTitle,
        epubAuthor,
        text => { accumulated = text; },
        controller.signal
      )
        .then(() => {
          if (accumulated) setCachedExplanation(epubTitle, nextPara.text, accumulated);
        })
        .catch(() => {/* best-effort, silently ignore */});
    },
    []
  );

  // Load explanation whenever the current paragraph changes
  useEffect(() => {
    if (!epub) return;
    const para = epub.paragraphs[currentIndex];
    if (!para) return;

    loadExplanation(para, epub.title, epub.author);
    pregenNext(currentIndex, epub.title, epub.author, epub.paragraphs);

    return () => {
      abortRef.current?.abort();
    };
  }, [epub, currentIndex, loadExplanation, pregenNext]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') navigate(currentIndex + 1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') navigate(currentIndex - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIndex, navigate]);

  if (!epub) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Chargement…
      </div>
    );
  }

  const paragraph = epub.paragraphs[currentIndex];
  const total = epub.paragraphs.length;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === total - 1;

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
        <button
          onClick={() => router.push('/')}
          className="flex-none text-xs text-slate-400 hover:text-slate-700 transition-colors whitespace-nowrap"
        >
          ← Changer de livre
        </button>
      </header>

      {/* ── Chapter label ── */}
      {paragraph && (
        <div className="flex-none px-5 py-2 bg-white border-b border-slate-100 text-xs text-slate-400 font-medium uppercase tracking-wide">
          {paragraph.chapterTitle}
        </div>
      )}

      {/* ── Main panels ── */}
      <main className="flex-1 flex flex-col-reverse md:flex-row overflow-hidden">
        {/* Left: AI explanation (appears bottom on mobile, left on desktop) */}
        <section
          aria-label="Explication IA"
          className="md:w-1/2 flex-1 md:flex-none overflow-y-auto panel-scroll bg-slate-50 border-t md:border-t-0 md:border-r border-slate-200 px-6 md:px-10 py-8"
        >
          <div className="max-w-prose mx-auto">
            <div className="flex items-center gap-2 mb-5">
              <span className="text-violet-500 text-lg">✨</span>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-violet-500">
                Explication IA
              </h2>
            </div>

            {isLoading && !explanation && <ExplanationSkeleton />}

            {loadError && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {loadError}
                <button
                  onClick={() => loadExplanation(paragraph, epub.title, epub.author)}
                  className="mt-2 block text-red-700 underline hover:no-underline"
                >
                  Réessayer
                </button>
              </div>
            )}

            {explanation && (
              <p className="text-slate-700 leading-relaxed text-[15px]">
                {explanation}
                {isLoading && (
                  <span className="inline-block w-0.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                )}
              </p>
            )}
          </div>
        </section>

        {/* Right: Book text */}
        <section
          aria-label="Texte du livre"
          className="md:w-1/2 flex-1 md:flex-none overflow-y-auto panel-scroll bg-white px-6 md:px-10 py-8"
        >
          <div className="max-w-prose mx-auto">
            {paragraph ? (
              <p className="font-serif text-[17px] leading-[1.85] text-slate-800">
                {paragraph.text}
              </p>
            ) : (
              <p className="text-slate-400 italic">Fin du livre.</p>
            )}
          </div>
        </section>
      </main>

      {/* ── Navigation footer ── */}
      <footer className="flex-none flex items-center justify-between gap-4 px-5 py-3 bg-white border-t border-slate-200">
        <button
          onClick={() => navigate(currentIndex - 1)}
          disabled={isFirst}
          aria-label="Paragraphe précédent"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all
            disabled:opacity-30 disabled:cursor-not-allowed
            enabled:text-slate-700 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
        >
          ← Précédent
        </button>

        <span className="text-xs text-slate-400 tabular-nums">
          {currentIndex + 1} / {total}
        </span>

        <button
          onClick={() => navigate(currentIndex + 1)}
          disabled={isLast}
          aria-label="Paragraphe suivant"
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
