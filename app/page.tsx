'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { parseEpub } from '@/lib/epub-parser';
import { useEpub } from '@/context/EpubContext';

const ANTHROPIC_API_KEY_STORAGE_KEY = 'sbr_anthropic_api_key';
const ANTHROPIC_MODEL_STORAGE_KEY = 'sbr_anthropic_model';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export default function HomePage() {
  const { setEpub } = useEpub();
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setAnthropicApiKey(localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) ?? '');
      setAnthropicModel(localStorage.getItem(ANTHROPIC_MODEL_STORAGE_KEY) ?? DEFAULT_ANTHROPIC_MODEL);
    } catch {
      // Keep empty/default settings when localStorage is unavailable.
    }
  }, []);

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
      if (!file.name.toLowerCase().endsWith('.epub')) {
        setError('Veuillez sélectionner un fichier .epub');
        return;
      }
      setError(null);
      setIsParsing(true);
      try {
        const parsed = await parseEpub(file);
        setEpub(parsed);
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
    <div className="min-h-screen bg-[#f7f1e8] text-stone-900">
      <header className="border-b border-stone-200/70 bg-[#f7f1e8]/95 px-4 py-3 backdrop-blur sm:px-5">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-stone-200/70">
              📖
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight sm:text-base">SmartBook Reader</p>
              <p className="hidden text-xs text-stone-500 sm:block">Lecteur ePub local</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="flex-none rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:border-violet-200 hover:text-violet-700 sm:px-4 sm:text-sm"
          >
            Configurer l’IA
          </button>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-5 sm:px-5 sm:py-8 lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <section className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-500">
              Lecture augmentée
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
              Ouvrir un ePub
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-stone-600 sm:text-base">
              Importez un livre, reprenez votre lecture, ajoutez des commentaires IA si vous le souhaitez.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 text-xs font-medium text-stone-600">
            <span className="rounded-full bg-white/85 px-3 py-1.5 shadow-sm ring-1 ring-stone-200/70">
              Fichier local
            </span>
            <span className="rounded-full bg-white/85 px-3 py-1.5 shadow-sm ring-1 ring-stone-200/70">
              Position sauvegardée
            </span>
            <span className="rounded-full bg-white/85 px-3 py-1.5 shadow-sm ring-1 ring-stone-200/70">
              {anthropicApiKey.trim() ? 'IA prête' : 'IA à configurer'}
            </span>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-stone-200 bg-white p-3 shadow-xl shadow-stone-300/30 sm:p-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Zone de dépôt de fichier ePub"
            onClick={() => !isParsing && inputRef.current?.click()}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && !isParsing && inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className={[
              'relative flex min-h-[16rem] cursor-pointer flex-col justify-between rounded-[1.35rem] border p-4 transition-all duration-200 sm:min-h-[20rem] sm:p-6',
              isDragging
                ? 'border-violet-400 bg-violet-50'
                : 'border-stone-200 bg-[#fffdf7] hover:border-violet-300',
              isParsing ? 'pointer-events-none opacity-70' : '',
            ].join(' ')}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".epub"
              className="hidden"
              onChange={onInputChange}
            />

            <div className="flex items-start justify-between gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-2xl shadow-sm ring-1 ring-stone-200/70 sm:h-14 sm:w-14 sm:text-3xl">
                {isParsing ? '⏳' : isDragging ? '📥' : '📚'}
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-stone-500 shadow-sm ring-1 ring-stone-200/70">
                .epub
              </span>
            </div>

            <div>
              {isParsing ? (
                <div>
                  <div className="h-11 w-11 rounded-full border-4 border-violet-500 border-t-transparent animate-spin" />
                  <p className="mt-4 text-xl font-semibold text-stone-900">Lecture du fichier…</p>
                  <p className="mt-2 text-sm leading-relaxed text-stone-500">
                    Extraction des chapitres et paragraphes.
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl">
                    Choisir un ePub
                  </p>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-stone-500">
                    Touchez pour choisir un fichier. Sur ordinateur, vous pouvez aussi le déposer ici.
                  </p>
                  <span className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 sm:w-auto">
                    Choisir le fichier
                  </span>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-3 rounded-2xl bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500 sm:text-sm">
            {anthropicApiKey.trim()
              ? 'IA configurée dans ce navigateur.'
              : 'IA non configurée. Vous pourrez lire sans commentaire IA.'}
          </div>
        </section>
      </main>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/30 p-3 sm:items-center sm:p-4">
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[2rem] bg-white p-4 shadow-2xl sm:rounded-3xl sm:p-5">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-200 sm:hidden" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Configuration IA</h2>
                <p className="mt-1 text-sm text-stone-500">
                  Ces réglages sont enregistrés uniquement dans ce navigateur.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="rounded-full px-3 py-1 text-sm font-medium text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              >
                Fermer
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                  Clé Anthropic locale
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
                  Modèle
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
                Supprimer la clé
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
