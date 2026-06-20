'use client';

import { useCallback, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { parseEpub } from '@/lib/epub-parser';
import { useEpub } from '@/context/EpubContext';

export default function HomePage() {
  const { setEpub } = useEpub();
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="text-5xl mb-4">📖</div>
          <h1 className="text-3xl font-bold text-slate-900">SmartBook Reader</h1>
          <p className="text-slate-500">
            Lisez votre ePub avec des explications IA en vis-à-vis, paragraphe par paragraphe.
          </p>
        </div>

        {/* Drop zone */}
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
            'relative flex flex-col items-center justify-center gap-4',
            'rounded-2xl border-2 border-dashed p-12 cursor-pointer',
            'transition-all duration-200 select-none',
            isDragging
              ? 'border-violet-500 bg-violet-50'
              : 'border-slate-300 bg-white hover:border-violet-400 hover:bg-violet-50/30',
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
              <div className="h-10 w-10 rounded-full border-4 border-violet-500 border-t-transparent animate-spin" />
              <p className="text-slate-600 font-medium">Lecture du fichier en cours…</p>
            </>
          ) : (
            <>
              <div className="text-4xl">{isDragging ? '📥' : '📚'}</div>
              <div className="text-center">
                <p className="font-semibold text-slate-700">
                  Glissez votre fichier .epub ici
                </p>
                <p className="text-sm text-slate-400 mt-1">ou cliquez pour parcourir</p>
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Features list */}
        <ul className="space-y-2 text-sm text-slate-500">
          {[
            '✨ Explication IA de chaque paragraphe',
            '⚡ Pré-génération en arrière-plan',
            '💾 Cache local — jamais deux fois la même requête',
            '📍 Reprise automatique à la dernière position',
          ].map(f => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
