'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { parseEpub } from '@/lib/epub-parser';
import { parsePdf } from '@/lib/pdf-parser';
import { useEpub } from '@/context/EpubContext';
import { APP_VERSION } from '@/config/version';
import {
  getBookKeyFromEpub,
  getRecentBooks,
  type RecentBook,
} from '@/lib/recent-books';

const ANTHROPIC_API_KEY_STORAGE_KEY = 'sbr_anthropic_api_key';
const ANTHROPIC_MODEL_STORAGE_KEY = 'sbr_anthropic_model';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

function getProgressPercent(book: RecentBook): number {
  if (book.paragraphCount <= 1) return 0;
  return Math.round((book.currentIndex / (book.paragraphCount - 1)) * 100);
}

function formatLastRead(timestamp: number): string {
  const elapsedMs = Date.now() - timestamp;
  const elapsedDays = Math.floor(elapsedMs / 86_400_000);

  if (elapsedDays <= 0) return 'Aujourd’hui';
  if (elapsedDays === 1) return 'Hier';
  if (elapsedDays < 7) return `Il y a ${elapsedDays} jours`;

  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
  }).format(timestamp);
}

export default function HomePage() {
  const { epub, currentIndex, setEpub } = useEpub();
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const [recentBooks, setRecentBooks] = useState<RecentBook[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setAnthropicApiKey(localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) ?? '');
      setAnthropicModel(localStorage.getItem(ANTHROPIC_MODEL_STORAGE_KEY) ?? DEFAULT_ANTHROPIC_MODEL);
      setRecentBooks(getRecentBooks());
    } catch {
      // Keep empty/default settings when localStorage is unavailable.
    }
  }, []);

  useEffect(() => {
    setRecentBooks(getRecentBooks());
  }, [epub, currentIndex]);

  const updateAnthropicApiKey = useCallback((nextApiKey: string) => {
    setAnthropicApiKey(nextApiKey);
    try {
      if (nextApiKey.trim()) {
        localStorage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, nextApiKey.trim());
      } else {
        localStorage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
      }
    } catch {}
  }, []);

  const updateAnthropicModel = useCallback((nextModel: string) => {
    setAnthropicModel(nextModel);
    try {
      localStorage.setItem(ANTHROPIC_MODEL_STORAGE_KEY, nextModel);
    } catch {}
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const fileName = file.name.toLowerCase();
      const isEpub = fileName.endsWith('.epub');
      const isPdf = fileName.endsWith('.pdf');

      if (!isEpub && !isPdf) {
        setError('Veuillez sélectionner un fichier .epub ou .pdf');
        return;
      }
      setError(null);
      setIsParsing(true);
      try {
        const parsed = isPdf ? await parsePdf(file) : await parseEpub(file);
        setEpub(parsed);
        setRecentBooks(getRecentBooks());
        router.push('/reader');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erreur lors de la lecture du fichier.');
        setIsParsing(false);
      }
    },
    [setEpub, router]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f7f1e8] text-stone-900">
      <header className="border-b border-stone-200/70 bg-[#f7f1e8]/95 px-4 py-3 backdrop-blur sm:px-5">
        <div className="mx-auto flex w-full max-w-6xl min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white text-xs font-bold tracking-tight text-violet-700 shadow-sm ring-1 ring-stone-200/70">
              SB
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight sm:text-base">SmartBook Reader</p>
              <p className="hidden text-xs text-stone-500 sm:block">
                Lire, annoter, reprendre · v{APP_VERSION}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="flex-none rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:border-violet-200 hover:text-violet-700 sm:px-4 sm:text-sm"
          >
            Réglages
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-5 sm:py-8">
        <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div className="min-w-0 max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-500">
              Lecture locale
            </p>
            <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
              Ouvrir un ePub ou un PDF
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-stone-600 sm:text-base">
              Importez un document, lisez-le, commentez-le avec l’IA si besoin, puis reprenez exactement où vous vous étiez arrêté.
            </p>
          </div>

          <div className="min-w-0 rounded-[1.5rem] border border-stone-200 bg-white/70 p-4 text-sm leading-relaxed text-stone-500 shadow-sm">
            <p className="font-semibold text-stone-900">Vos données restent ici.</p>
            <p className="mt-1">
              Le fichier n’est pas envoyé. La clé IA est optionnelle et stockée localement.
            </p>
          </div>
        </section>

        <section className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start">
          <div className="min-w-0 rounded-[1.75rem] border border-stone-200 bg-white p-3 shadow-xl shadow-stone-300/30 sm:p-4">
            <div
              role="button"
              tabIndex={0}
              aria-label="Zone de dépôt de fichier ePub ou PDF"
              onClick={() => !isParsing && inputRef.current?.click()}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && !isParsing && inputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={[
                'relative flex min-h-[18rem] cursor-pointer flex-col justify-between rounded-[1.35rem] border p-4 transition-all duration-200 sm:min-h-[22rem] sm:p-6',
                isDragging
                  ? 'border-violet-400 bg-violet-50'
                  : 'border-stone-200 bg-[#fffdf7] hover:border-violet-300',
                isParsing ? 'pointer-events-none opacity-70' : '',
              ].join(' ')}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".epub,.pdf,application/epub+zip,application/pdf"
                className="hidden"
                onChange={onInputChange}
              />

              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-xs font-bold uppercase tracking-wide text-violet-700 shadow-sm ring-1 ring-stone-200/70 sm:h-14 sm:w-14">
                  {isParsing ? '...' : isDragging ? 'Drop' : 'Doc'}
                </div>
                <div className="flex min-w-0 flex-wrap justify-end gap-2">
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-stone-500 shadow-sm ring-1 ring-stone-200/70">
                    ePub
                  </span>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-stone-500 shadow-sm ring-1 ring-stone-200/70">
                    PDF texte
                  </span>
                </div>
              </div>

              <div>
                {isParsing ? (
                  <div aria-busy="true" aria-live="polite">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 ring-1 ring-violet-100">
                      <div className="flex gap-1" aria-hidden="true">
                        <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                        <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                        <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                      </div>
                    </div>
                    <p className="mt-4 text-xl font-semibold text-stone-900">Préparation du document…</p>
                    <p className="mt-2 text-sm leading-relaxed text-stone-500">
                      Extraction du texte et construction de la navigation.
                    </p>
                    <div className="mt-5 space-y-2.5" aria-hidden="true">
                      <div className="loading-shimmer h-3.5 w-48 rounded-full" />
                      <div className="loading-shimmer h-3.5 w-64 max-w-full rounded-full" />
                      <div className="loading-shimmer h-3.5 w-40 rounded-full" />
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl">
                      Charger un document
                    </p>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-stone-500">
                      Glissez un fichier ici ou choisissez-le depuis l’appareil. Les PDF scannés comme images ne sont pas encore lisibles.
                    </p>
                    <span className="mt-5 inline-flex w-full items-center justify-center rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 sm:w-auto">
                      Choisir un fichier
                    </span>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="mt-3 rounded-2xl bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500 sm:text-sm">
              {anthropicApiKey.trim()
                ? 'Commentaires IA disponibles avec la clé enregistrée sur cet appareil.'
                : 'Lecture disponible sans clé IA. Ajoutez une clé seulement pour générer des commentaires.'}
            </div>
          </div>

          <div className="min-w-0 rounded-[1.75rem] border border-stone-200 bg-white/85 p-3 shadow-sm sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div>
                <h2 className="text-base font-semibold text-stone-900">Reprendre</h2>
                <p className="text-xs text-stone-400">Lectures gardées sur cet appareil</p>
              </div>
              {recentBooks.length > 0 && (
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-500">
                  {recentBooks.length}
                </span>
              )}
            </div>

            {recentBooks.length > 0 ? (
              <div className="divide-y divide-stone-100">
                {recentBooks.slice(0, 4).map(book => {
                  const loadedBookKey = epub ? getBookKeyFromEpub(epub) : null;
                  const canResume = loadedBookKey === book.key;
                  const progress = getProgressPercent(book);

                  return (
                    <button
                      key={book.key}
                      type="button"
                      onClick={() => {
                        if (canResume) {
                          router.push('/reader');
                          return;
                        }

                        inputRef.current?.click();
                      }}
                      className="group w-full rounded-2xl px-3 py-3 text-left transition-colors hover:bg-stone-50"
                    >
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 sm:flex-nowrap sm:gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-stone-900">{book.title}</p>
                          <p className="mt-0.5 truncate text-xs text-stone-400">
                            {book.author} · {formatLastRead(book.updatedAt)}
                          </p>
                        </div>
                        <span className="flex-none rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-500 group-hover:bg-white">
                          {canResume ? 'Reprendre' : 'Réimporter'}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100">
                          <div
                            className="h-full rounded-full bg-violet-500"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="w-9 text-right text-[11px] tabular-nums text-stone-400">
                          {progress}%
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl bg-stone-50 px-4 py-5 text-sm leading-relaxed text-stone-500">
                Vos lectures récentes apparaîtront ici après le premier import.
              </div>
            )}

            {recentBooks.some(book => (epub ? getBookKeyFromEpub(epub) : null) !== book.key) && (
              <p className="mt-2 px-2 text-[11px] leading-relaxed text-stone-400">
                Réimportez le même fichier pour retrouver sa position et ses commentaires.
              </p>
            )}
          </div>
        </section>
      </main>

      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/30 p-3 sm:items-center sm:p-4"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[2rem] bg-white p-4 shadow-2xl sm:rounded-3xl sm:p-5"
            onClick={event => event.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-200 sm:hidden" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Réglages</h2>
                <p className="mt-1 text-sm text-stone-500">
                  Clé IA enregistrée sur cet appareil, jamais intégrée au code public.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="rounded-full bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-200"
              >
                Terminé
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                  Clé Anthropic
                </label>
                <input
                  type="password"
                  value={anthropicApiKey}
                  onChange={event => updateAnthropicApiKey(event.target.value)}
                  placeholder="sk-ant-..."
                  className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-3 text-base text-stone-800 outline-none transition-colors focus:border-violet-300 sm:py-2 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                  Modèle à utiliser
                </label>
                <input
                  type="text"
                  value={anthropicModel}
                  onChange={event => updateAnthropicModel(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-3 text-base text-stone-800 outline-none transition-colors focus:border-violet-300 sm:py-2 sm:text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => updateAnthropicApiKey('')}
                className="rounded-full bg-stone-100 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-200"
              >
                Retirer la clé
              </button>
              <p className="text-xs leading-relaxed text-stone-400">
                La sauvegarde est automatique. Fermez quand c’est bon.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
