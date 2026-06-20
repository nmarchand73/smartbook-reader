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
    <div className="min-h-screen bg-stone-50 px-4 py-4 text-stone-900 sm:px-5 sm:py-6">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white shadow-sm sm:h-10 sm:w-10">
            📖
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight sm:text-base">SmartBook Reader</p>
            <p className="hidden text-xs text-stone-500 sm:block">Lecture ePub augmentée</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:border-violet-200 hover:text-violet-700 sm:px-4 sm:text-sm"
        >
          ⚙ Réglages IA
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 py-6 sm:gap-8 sm:py-10 lg:grid lg:min-h-[calc(100vh-6rem)] lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <section className="order-2 space-y-4 sm:space-y-6 lg:order-1">
          <div className="space-y-3">
            <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-stone-950 sm:text-4xl md:text-5xl">
              Ouvrir un livre
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-stone-600 sm:text-base">
              Choisissez un fichier ePub depuis votre ordinateur. Le fichier est lu dans le navigateur.
            </p>
          </div>

          <div className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
            <h2 className="font-semibold text-stone-900">Avant de commencer</h2>
            <div className="mt-4 space-y-3 text-sm leading-relaxed text-stone-600">
              <div className="flex gap-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-500">1</span>
                <p>Importez un fichier `.epub`. La dernière position est restaurée si le livre a déjà été ouvert.</p>
              </div>
              <div className="flex gap-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-500">2</span>
                <p>Pour les commentaires IA sur GitHub Pages, renseignez votre clé Anthropic dans `Réglages IA`.</p>
              </div>
              <div className="flex gap-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-500">3</span>
                <p>Dans le lecteur, sélectionnez un paragraphe, plusieurs paragraphes, ou quelques lignes avant de demander une explication.</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-4 text-sm leading-relaxed text-stone-500">
            Les livres, la position de lecture, le cache et les réglages sont stockés localement dans ce navigateur.
          </div>
        </section>

        <section className="order-1 rounded-[1.75rem] border border-stone-200 bg-white/90 p-3 shadow-xl shadow-stone-300/30 sm:rounded-[2rem] sm:p-5 lg:order-2 lg:shadow-2xl">
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
              'relative flex min-h-[17rem] cursor-pointer flex-col items-center justify-center gap-4 rounded-[1.35rem] border-2 border-dashed p-5 text-center transition-all duration-200 sm:min-h-[22rem] sm:gap-5 sm:rounded-[1.5rem] sm:p-8',
              isDragging
                ? 'border-violet-500 bg-violet-50'
                : 'border-stone-300 bg-stone-50/70 hover:border-violet-300 hover:bg-violet-50/50',
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

            {isParsing ? (
              <>
                <div className="h-11 w-11 rounded-full border-4 border-violet-500 border-t-transparent animate-spin" />
                <div>
                  <p className="font-medium text-stone-700">Lecture du fichier en cours…</p>
                  <p className="mt-1 text-sm text-stone-400">Extraction des chapitres et paragraphes</p>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-white text-3xl shadow-sm sm:h-16 sm:w-16">
                  {isDragging ? '📥' : '📚'}
                </div>
                <div>
                  <p className="text-base font-semibold text-stone-800 sm:text-lg">Déposez votre ePub</p>
                  <p className="mt-1 text-sm text-stone-500">ou cliquez pour choisir un fichier</p>
                </div>
                <span className="rounded-full bg-violet-600 px-5 py-2 text-sm font-medium text-white shadow-sm">
                  Choisir un ePub
                </span>
              </>
            )}
          </div>

          {error && (
            <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-3 rounded-2xl bg-stone-50 p-3 text-sm leading-relaxed text-stone-500 sm:mt-4 sm:p-4">
            {anthropicApiKey.trim()
              ? 'IA configurée dans ce navigateur.'
              : 'IA non configurée : ouvrez Réglages IA pour renseigner une clé Anthropic locale.'}
          </div>
        </section>
      </main>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/30 p-3 sm:items-center sm:p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-4 shadow-2xl sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Réglages IA</h2>
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
                  className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-violet-300"
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
                  className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-violet-300"
                />
              </div>
              <button
                type="button"
                onClick={() => updateAnthropicApiKey('')}
                className="rounded-full bg-stone-100 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-200"
              >
                Effacer la clé locale
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
  );
}
