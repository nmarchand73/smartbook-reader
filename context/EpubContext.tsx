'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import type { ParsedEpub } from '@/lib/epub-parser';

interface EpubContextValue {
  epub: ParsedEpub | null;
  currentIndex: number;
  setEpub: (epub: ParsedEpub) => void;
  navigate: (index: number) => void;
}

const EpubContext = createContext<EpubContextValue | null>(null);

const SESSION_KEY = 'sbr_epub_data';
const posKey = (title: string) => `sbr_pos_${title}`;

export function EpubProvider({ children }: { children: ReactNode }) {
  const [epub, setEpubState] = useState<ParsedEpub | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Restore epub from sessionStorage on first mount (survives F5)
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        const parsed: ParsedEpub = JSON.parse(stored);
        setEpubState(parsed);
        const pos = localStorage.getItem(posKey(parsed.title));
        if (pos) setCurrentIndex(Math.min(parseInt(pos, 10), parsed.paragraphs.length - 1));
      }
    } catch {
      // Corrupt storage — start fresh
    }
  }, []);

  const setEpub = useCallback((newEpub: ParsedEpub) => {
    setEpubState(newEpub);
    setCurrentIndex(0);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(newEpub));
    } catch {
      // Storage quota exceeded — in-memory only
    }
  }, []);

  const navigate = useCallback(
    (index: number) => {
      if (!epub) return;
      const clamped = Math.max(0, Math.min(index, epub.paragraphs.length - 1));
      setCurrentIndex(clamped);
      try {
        localStorage.setItem(posKey(epub.title), clamped.toString());
      } catch {}
    },
    [epub]
  );

  return (
    <EpubContext.Provider value={{ epub, currentIndex, setEpub, navigate }}>
      {children}
    </EpubContext.Provider>
  );
}

export function useEpub(): EpubContextValue {
  const ctx = useContext(EpubContext);
  if (!ctx) throw new Error('useEpub must be used inside <EpubProvider>');
  return ctx;
}
