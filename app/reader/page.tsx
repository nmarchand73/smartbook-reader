'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  Fragment,
  useCallback,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { useRouter } from 'next/navigation';
import { useEpub } from '@/context/EpubContext';
import { clearExplanationCache, getCachedExplanation, setCachedExplanation } from '@/lib/cache';
import { EXPLANATION_SYSTEM_PROMPT } from '@/config/prompts';
import type { Paragraph } from '@/lib/epub-parser';

const PARAGRAPHS_PER_PAGE = 5;
const FONT_SIZE_STORAGE_KEY = 'sbr_reader_font_size';
const DEFAULT_BOOK_FONT_SIZE = 16;
const MIN_BOOK_FONT_SIZE = 8;
const MAX_BOOK_FONT_SIZE = 24;
const BOOK_FONT_SIZE_STEP = 1;
const SPLIT_STORAGE_KEY = 'sbr_reader_split_percent';
const DEFAULT_SPLIT_PERCENT = 42;
const MIN_SPLIT_PERCENT = 28;
const MAX_SPLIT_PERCENT = 64;
const READING_MODE_STORAGE_KEY = 'sbr_reader_mode';
const ANTHROPIC_API_KEY_STORAGE_KEY = 'sbr_anthropic_api_key';
const ANTHROPIC_MODEL_STORAGE_KEY = 'sbr_anthropic_model';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 900;

type ReadingMode = 'pages' | 'scroll';
interface ChapterOption {
  title: string;
  firstIndex: number;
}
interface SelectedPassage {
  text: string;
  label: string;
  paragraphIndex: number | null;
  paragraphIndexes: number[];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getPageIndexForParagraph(pages: Paragraph[][], paragraphIndex: number): number {
  const pageIndex = pages.findIndex(page =>
    page.some(paragraph => paragraph.globalIndex === paragraphIndex)
  );

  return pageIndex >= 0 ? pageIndex : 0;
}

function buildExplanationPrompt(passage: string, bookTitle: string, author: string): string {
  const contextLines = [
    bookTitle ? `- Titre du livre : ${bookTitle}` : null,
    author ? `- Auteur : ${author}` : null,
  ].filter((line): line is string => line !== null);

  return `## Contexte du livre
${contextLines.length > 0 ? contextLines.join('\n') : '- Métadonnées indisponibles'}

Utilise ce contexte pour éclairer le passage quand il est pertinent, sans plaquer des généralités sur l'œuvre ou l'auteur.

## Passage à commenter
${passage.slice(0, 2000)}`;
}

function extractAnthropicText(responseBody: unknown): string {
  if (
    typeof responseBody !== 'object' ||
    responseBody === null ||
    !('content' in responseBody) ||
    !Array.isArray(responseBody.content)
  ) {
    return '';
  }

  return responseBody.content
    .map(block => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text;
      }

      return '';
    })
    .join('');
}

// ── Streaming fetch helper ────────────────────────────────────────────────────

async function fetchExplanation(
  passage: string,
  bookTitle: string,
  author: string,
  onChunk: (text: string) => void,
  options: {
    apiKey: string;
    model: string;
  },
  signal?: AbortSignal
): Promise<string> {
  if (options.apiKey.trim()) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: options.model.trim() || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: EXPLANATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildExplanationPrompt(passage, bookTitle, author),
          },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Erreur Anthropic : ${response.status}`);
    }

    const responseBody = await response.json();
    const full = extractAnthropicText(responseBody);
    if (!full) throw new Error('Réponse Anthropic vide.');
    onChunk(full);
    return full;
  }

  const response = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      passage,
      bookTitle,
      author,
      model: options.model.trim() || DEFAULT_ANTHROPIC_MODEL,
    }),
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

  const finalChunk = decoder.decode();
  if (finalChunk) {
    full += finalChunk;
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
  const [explainedParagraphIndexes, setExplainedParagraphIndexes] = useState<number[]>([]);
  const [selectedParagraphIndex, setSelectedParagraphIndex] = useState<number | null>(null);
  const [selectedParagraphIndexes, setSelectedParagraphIndexes] = useState<number[]>([]);
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const [selectedPassage, setSelectedPassage] = useState<SelectedPassage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bookFontSize, setBookFontSize] = useState(DEFAULT_BOOK_FONT_SIZE);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT);
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const [areAiSettingsLoaded, setAreAiSettingsLoaded] = useState(false);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const [readingMode, setReadingMode] = useState<ReadingMode>('pages');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isExplanationOpen, setIsExplanationOpen] = useState(false);
  const [cacheClearMessage, setCacheClearMessage] = useState<string | null>(null);
  const [paginatedPages, setPaginatedPages] = useState<Paragraph[][]>([]);
  const [paginationLayoutVersion, setPaginationLayoutVersion] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const bookPaneRef = useRef<HTMLElement | null>(null);
  const paginationMeasureRef = useRef<HTMLDivElement | null>(null);
  const previousReadingModeRef = useRef<ReadingMode>('pages');

  const rememberExplainedParagraphs = useCallback((paragraphIndexes: number[]) => {
    if (paragraphIndexes.length === 0) return;

    setExplainedParagraphIndexes(currentIndexes =>
      Array.from(new Set([...currentIndexes, ...paragraphIndexes])).sort((a, b) => a - b)
    );
  }, []);

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

      setBookFontSize(clampNumber(parsedFontSize, MIN_BOOK_FONT_SIZE, MAX_BOOK_FONT_SIZE));
    } catch {
      // Keep the default size when localStorage is unavailable.
    }
  }, []);

  const updateBookFontSize = useCallback((nextSize: number) => {
    const clampedSize = clampNumber(nextSize, MIN_BOOK_FONT_SIZE, MAX_BOOK_FONT_SIZE);
    setBookFontSize(clampedSize);
    setPaginationLayoutVersion(version => version + 1);

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

      setSplitPercent(clampNumber(parsedSplitPercent, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT));
    } catch {
      // Keep the default split when localStorage is unavailable.
    }
  }, []);

  const updateSplitPercent = useCallback((nextPercent: number) => {
    const clampedPercent = clampNumber(nextPercent, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT);
    setSplitPercent(clampedPercent);
    setPaginationLayoutVersion(version => version + 1);

    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, clampedPercent.toString());
    } catch {
      // Split still updates for the current session.
    }
  }, []);

  useEffect(() => {
    try {
      const storedReadingMode = localStorage.getItem(READING_MODE_STORAGE_KEY);
      if (storedReadingMode === 'pages' || storedReadingMode === 'scroll') {
        setReadingMode(storedReadingMode);
      }
    } catch {
      // Keep the default mode when localStorage is unavailable.
    }
  }, []);

  useEffect(() => {
    try {
      setAnthropicApiKey(localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) ?? '');
      setAnthropicModel(localStorage.getItem(ANTHROPIC_MODEL_STORAGE_KEY) ?? DEFAULT_ANTHROPIC_MODEL);
    } catch {
      // Keep empty/default AI settings when localStorage is unavailable.
    } finally {
      setAreAiSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!epub) return;

    const cachedIndexes = epub.paragraphs
      .filter(paragraph => getCachedExplanation(epub.title, paragraph.text))
      .map(paragraph => paragraph.globalIndex);

    setExplainedParagraphIndexes(cachedIndexes);
  }, [epub]);

  const updateAnthropicApiKey = useCallback((nextApiKey: string) => {
    setAnthropicApiKey(nextApiKey);

    try {
      if (nextApiKey.trim()) {
        localStorage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, nextApiKey.trim());
      } else {
        localStorage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
      }
    } catch {
      // API key still updates for the current session.
    }
  }, []);

  const updateAnthropicModel = useCallback((nextModel: string) => {
    setAnthropicModel(nextModel);

    try {
      localStorage.setItem(ANTHROPIC_MODEL_STORAGE_KEY, nextModel);
    } catch {
      // Model still updates for the current session.
    }
  }, []);

  const updateReadingMode = useCallback((nextMode: ReadingMode) => {
    setReadingMode(nextMode);

    try {
      localStorage.setItem(READING_MODE_STORAGE_KEY, nextMode);
    } catch {
      // Reading mode still updates for the current session.
    }
  }, []);

  const handleSplitResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsResizingSplit(true);
  }, []);

  const updateCurrentParagraphFromScroll = useCallback(() => {
    if (readingMode !== 'scroll') return;

    const bookPane = bookPaneRef.current;
    if (!bookPane) return;

    const paneBounds = bookPane.getBoundingClientRect();
    const paragraphElements = Array.from(
      bookPane.querySelectorAll<HTMLElement>('[data-paragraph-index]')
    );
    const currentParagraph = paragraphElements.find(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom >= paneBounds.top + 120;
    }) ?? paragraphElements[paragraphElements.length - 1];

    const paragraphIndex = Number(currentParagraph?.dataset.paragraphIndex);
    if (Number.isFinite(paragraphIndex) && paragraphIndex !== currentIndex) {
      navigate(paragraphIndex);
    }
  }, [currentIndex, navigate, readingMode]);

  const handleSplitKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
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

  useEffect(() => {
    const bookPane = bookPaneRef.current;
    if (!bookPane) return;

    const observer = new ResizeObserver(() => {
      setPaginationLayoutVersion(version => version + 1);
    });

    observer.observe(bookPane);
    return () => observer.disconnect();
  }, [readingMode]);

  useLayoutEffect(() => {
    if (!epub) return;

    const animationFrame = requestAnimationFrame(() => {
      const bookPane = bookPaneRef.current;
      const measureRoot = paginationMeasureRef.current;
      if (!bookPane || !measureRoot) return;

      const measureContent = measureRoot.querySelector<HTMLElement>('[data-pagination-measure-content]');
      if (!measureContent) return;

      const paneBounds = bookPane.getBoundingClientRect();
      const contentBounds = measureContent.getBoundingClientRect();
      const availableHeight = Math.max(240, paneBounds.bottom - contentBounds.top - 80);
      const nextPages: Paragraph[][] = [];
      let currentPage: Paragraph[] = [];
      let currentHeight = 0;

      epub.paragraphs.forEach(paragraph => {
        const measuredElement = measureRoot.querySelector<HTMLElement>(
          `[data-measure-paragraph-index="${paragraph.globalIndex}"]`
        );
        const measuredHeight = measuredElement?.getBoundingClientRect().height ?? 0;
        const paragraphHeight = Math.max(1, measuredHeight);

        if (currentPage.length > 0 && currentHeight + paragraphHeight > availableHeight) {
          nextPages.push(currentPage);
          currentPage = [];
          currentHeight = 0;
        }

        currentPage.push(paragraph);
        currentHeight += paragraphHeight;
      });

      if (currentPage.length > 0) nextPages.push(currentPage);
      setPaginatedPages(nextPages.length > 0 ? nextPages : [epub.paragraphs]);
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [bookFontSize, epub, paginationLayoutVersion, splitPercent]);

  const loadExplanation = useCallback(
    async (
      passageText: string,
      epubTitle: string,
      epubAuthor: string,
      paragraphIndex: number | null,
      paragraphIndexes: number[]
    ) => {
      setExplainedParagraphIndex(paragraphIndex);

      // Check cache first
      const cached = getCachedExplanation(epubTitle, passageText);
      if (cached) {
        setExplanation(cached);
        setIsLoading(false);
        setLoadError(null);
        rememberExplainedParagraphs(paragraphIndexes);
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
          passageText,
          epubTitle,
          epubAuthor,
          text => {
            setExplanation(text);
          },
          {
            apiKey: anthropicApiKey,
            model: anthropicModel,
          },
          controller.signal
        );
        setCachedExplanation(epubTitle, passageText, full);
        rememberExplainedParagraphs(paragraphIndexes);
        setIsLoading(false);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setLoadError('Impossible de générer l\'explication. Vérifiez votre connexion.');
        setIsLoading(false);
      }
    },
    [anthropicApiKey, anthropicModel, rememberExplainedParagraphs]
  );

  const resetExplanation = useCallback(() => {
    abortRef.current?.abort();
    setSelectedParagraphIndex(null);
    setSelectedParagraphIndexes([]);
    setSelectionAnchorIndex(null);
    setSelectedPassage(null);
    setExplanation(null);
    setExplainedParagraphIndex(null);
    setIsLoading(false);
    setLoadError(null);
    setIsExplanationOpen(false);
  }, []);

  const buildParagraphPassage = useCallback(
    (indexes: number[]): SelectedPassage | null => {
      if (!epub || indexes.length === 0) return null;

      const sortedIndexes = Array.from(new Set(indexes)).sort((a, b) => a - b);
      const selectedParagraphs = sortedIndexes
        .map(index => epub.paragraphs[index])
        .filter((paragraph): paragraph is Paragraph => Boolean(paragraph));

      if (selectedParagraphs.length === 0) return null;

      return {
        text: selectedParagraphs.map(paragraph => paragraph.text).join('\n\n'),
        label: selectedParagraphs.length > 1
          ? `${selectedParagraphs.length} paragraphes sélectionnés`
          : 'Paragraphe sélectionné',
        paragraphIndex: selectedParagraphs.length === 1 ? selectedParagraphs[0].globalIndex : null,
        paragraphIndexes: selectedParagraphs.map(paragraph => paragraph.globalIndex),
      };
    },
    [epub]
  );

  const handleClearCache = useCallback(() => {
    const deletedCount = clearExplanationCache();
    resetExplanation();
    setExplainedParagraphIndexes([]);
    setIsSettingsOpen(false);
    setCacheClearMessage(
      deletedCount > 0
        ? `${deletedCount} explication${deletedCount > 1 ? 's' : ''} supprimée${deletedCount > 1 ? 's' : ''}.`
        : 'Le cache était déjà vide.'
    );
  }, [resetExplanation]);

  useEffect(() => {
    if (!cacheClearMessage) return;

    const timeout = window.setTimeout(() => setCacheClearMessage(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [cacheClearMessage]);

  const selectParagraph = useCallback(
    (
      index: number,
      options: { additive?: boolean; range?: boolean } = {}
    ) => {
      if (!epub?.paragraphs[index]) return;

      let nextIndexes: number[];
      if (options.range && selectionAnchorIndex !== null) {
        const start = Math.min(selectionAnchorIndex, index);
        const end = Math.max(selectionAnchorIndex, index);
        nextIndexes = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
      } else if (options.additive) {
        nextIndexes = selectedParagraphIndexes.includes(index)
          ? selectedParagraphIndexes.filter(selectedIndex => selectedIndex !== index)
          : [...selectedParagraphIndexes, index];
      } else {
        nextIndexes = [index];
      }

      if (nextIndexes.length === 0) {
        resetExplanation();
        return;
      }

      const nextPassage = buildParagraphPassage(nextIndexes);
      if (!nextPassage) return;

      abortRef.current?.abort();
      setExplanation(null);
      setExplainedParagraphIndex(null);
      setIsLoading(false);
      setLoadError(null);
      setSelectedParagraphIndexes(Array.from(new Set(nextIndexes)).sort((a, b) => a - b));
      setSelectedParagraphIndex(nextPassage.paragraphIndex);
      setSelectedPassage(nextPassage);
      setSelectionAnchorIndex(index);
      setIsExplanationOpen(true);
      const cachedExplanation = getCachedExplanation(epub.title, nextPassage.text);
      if (cachedExplanation) {
        setExplanation(cachedExplanation);
        setExplainedParagraphIndex(nextPassage.paragraphIndex);
        rememberExplainedParagraphs(nextPassage.paragraphIndexes);
      }
      navigate(index);
    },
    [
      buildParagraphPassage,
      epub,
      navigate,
      rememberExplainedParagraphs,
      selectedParagraphIndexes,
      selectionAnchorIndex,
    ]
  );

  const explainPassage = useCallback(
    (passage: SelectedPassage) => {
      if (!epub) return;

      setSelectedPassage(passage);
      setSelectedParagraphIndex(passage.paragraphIndex);
      setSelectedParagraphIndexes(passage.paragraphIndexes);
      setSelectionAnchorIndex(passage.paragraphIndexes[passage.paragraphIndexes.length - 1] ?? null);
      setIsExplanationOpen(true);
      if (passage.paragraphIndex !== null) navigate(passage.paragraphIndex);
      loadExplanation(
        passage.text,
        epub.title,
        epub.author,
        passage.paragraphIndex,
        passage.paragraphIndexes
      );
    },
    [epub, loadExplanation, navigate]
  );

  const explainParagraph = useCallback(
    (paragraph: Paragraph) => {
      explainPassage({
        text: paragraph.text,
        label: 'Paragraphe sélectionné',
        paragraphIndex: paragraph.globalIndex,
        paragraphIndexes: [paragraph.globalIndex],
      });
    },
    [explainPassage]
  );

  const captureTextSelection = useCallback(() => {
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const selectedText = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const bookPane = bookPaneRef.current;

      if (!selection || selection.isCollapsed || selectedText.length < 2 || !range || !bookPane) return;

      const selectionNode = range.commonAncestorContainer;
      const selectionElement = selectionNode.nodeType === Node.ELEMENT_NODE
        ? selectionNode
        : selectionNode.parentElement;

      if (!(selectionElement instanceof Element) || !bookPane.contains(selectionElement)) return;

      abortRef.current?.abort();
      setSelectedParagraphIndex(null);
      setSelectedParagraphIndexes([]);
      setSelectionAnchorIndex(null);
      setSelectedPassage({
        text: selectedText,
        label: 'Sélection libre',
        paragraphIndex: null,
        paragraphIndexes: [],
      });
      setExplanation(null);
      setExplainedParagraphIndex(null);
      setIsLoading(false);
      setLoadError(null);
      setIsExplanationOpen(true);
    });
  }, []);

  // Cancel in-flight generation when leaving the reader
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (readingMode !== 'pages') return;

      const currentPageIndex = getPageIndexForParagraph(paginatedPages, currentIndex);

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        const nextPage = paginatedPages[currentPageIndex + 1];
        if (!nextPage) return;

        resetExplanation();
        navigate(nextPage[0].globalIndex);
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        const previousPage = paginatedPages[currentPageIndex - 1];
        if (!previousPage) return;

        resetExplanation();
        navigate(previousPage[0].globalIndex);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIndex, navigate, paginatedPages, readingMode, resetExplanation]);

  useEffect(() => {
    const previousReadingMode = previousReadingModeRef.current;
    previousReadingModeRef.current = readingMode;

    if (readingMode !== 'scroll' || previousReadingMode === 'scroll') return;

    const animationFrame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-paragraph-index="${currentIndex}"]`)
        ?.scrollIntoView({ block: 'center' });
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [currentIndex, readingMode]);

  if (!epub) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Chargement…
      </div>
    );
  }

  const fallbackPages = [epub.paragraphs.slice(0, PARAGRAPHS_PER_PAGE)];
  const pages = paginatedPages.length > 0 ? paginatedPages : fallbackPages;
  const currentPage = getPageIndexForParagraph(pages, currentIndex);
  const pageParagraphs = pages[currentPage] ?? pages[0] ?? [];
  const displayedParagraphs = readingMode === 'pages' ? pageParagraphs : epub.paragraphs;
  const currentParagraph = epub.paragraphs[currentIndex];
  const chapterOptions = epub.paragraphs.reduce<ChapterOption[]>((chapters, item) => {
    const previousChapter = chapters[chapters.length - 1];
    if (previousChapter?.title === item.chapterTitle) return chapters;

    chapters.push({
      title: item.chapterTitle,
      firstIndex: item.globalIndex,
    });
    return chapters;
  }, []);
  const currentChapterStartIndex = [...chapterOptions]
    .reverse()
    .find(chapter => chapter.firstIndex <= currentIndex)?.firstIndex ?? chapterOptions[0]?.firstIndex ?? 0;
  const totalPages = pages.length;
  const isFirst = currentPage === 0;
  const isLast = currentPage === totalPages - 1;
  const pageChapterTitles = Array.from(new Set(pageParagraphs.map(item => item.chapterTitle)));
  const chapterLabel = pageChapterTitles.length > 1
    ? `${pageChapterTitles[0]} - ${pageChapterTitles[pageChapterTitles.length - 1]}`
    : pageChapterTitles[0];
  const headerChapterLabel = readingMode === 'pages' ? chapterLabel : currentParagraph?.chapterTitle;
  const bookHeaderLabel = readingMode === 'pages' ? chapterLabel : null;

  const jumpToParagraph = (index: number) => {
    resetExplanation();
    setIsTocOpen(false);
    navigate(index);

    if (readingMode === 'scroll') {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-paragraph-index="${index}"]`)
          ?.scrollIntoView({ block: 'start' });
      });
    }
  };

  return (
    <div className="flex flex-col h-screen bg-stone-50 overflow-hidden">
      {/* ── Header ── */}
      <header className="flex-none border-b border-stone-200 bg-white px-3 py-2 shadow-sm md:flex md:items-center md:justify-between md:px-5 md:py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-base md:text-lg">📖</span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-stone-900 md:text-base">
              {epub.title}
            </h1>
              <p className="hidden truncate text-[11px] text-stone-400 sm:block md:text-xs">{epub.author}</p>
            </div>
          </div>
          <button
            onClick={() => router.push('/')}
            className="flex-none rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200 md:hidden"
          >
            Accueil
          </button>
        </div>
        <div className="mt-2 flex w-full items-center gap-2 md:mt-0 md:w-auto md:flex-none md:gap-3">
          <div className="relative min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                setIsTocOpen(isOpen => !isOpen);
                setIsSettingsOpen(false);
              }}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-3 text-left text-xs font-medium text-stone-600 shadow-sm transition-colors hover:bg-white hover:text-stone-800 md:h-auto md:max-w-64 md:rounded-full md:py-1.5"
              aria-expanded={isTocOpen}
              aria-haspopup="dialog"
            >
              <span className="text-stone-400">Chapitres</span>
              <span className="truncate text-stone-800">{headerChapterLabel}</span>
            </button>
            {isTocOpen && (
              <div
                role="dialog"
                aria-label="Liste des chapitres"
                className="fixed inset-x-0 bottom-0 top-auto z-40 max-h-[82dvh] overflow-hidden rounded-t-[1.75rem] border border-stone-200 bg-white shadow-2xl md:absolute md:bottom-auto md:left-0 md:right-auto md:top-auto md:mt-2 md:max-h-none md:w-[26rem] md:rounded-2xl"
              >
                <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-stone-200 md:hidden" />
                <div className="border-b border-stone-100 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">Chapitres</p>
                      <p className="text-xs text-stone-400">
                        {chapterOptions.length} chapitre{chapterOptions.length > 1 ? 's' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsTocOpen(false)}
                      className="rounded-full px-2 py-1 text-xs font-medium text-stone-400 transition-colors hover:bg-stone-50 hover:text-stone-700"
                    >
                      Fermer
                    </button>
                  </div>
                </div>
                <div className="max-h-[68dvh] overflow-y-auto p-2 md:max-h-[min(70vh,30rem)]">
                  {chapterOptions.map((chapter, index) => {
                    const isCurrentChapter = chapter.firstIndex === currentChapterStartIndex;
                    const chapterPage = getPageIndexForParagraph(pages, chapter.firstIndex) + 1;

                    return (
                      <button
                        key={chapter.firstIndex}
                        type="button"
                        onClick={() => jumpToParagraph(chapter.firstIndex)}
                        className={[
                          'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                          isCurrentChapter
                            ? 'bg-violet-50 text-violet-900'
                            : 'text-stone-700 hover:bg-stone-50',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold',
                            isCurrentChapter
                              ? 'bg-violet-600 text-white'
                              : 'bg-stone-100 text-stone-400',
                          ].join(' ')}
                        >
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-400">
                            Chapitre {index + 1}
                          </span>
                          <span className="mt-0.5 block text-sm font-medium leading-snug">
                            {chapter.title}
                          </span>
                          <span className="mt-1 block text-xs text-stone-400">
                            {readingMode === 'pages'
                              ? `Page ${chapterPage}`
                              : `Début au paragraphe ${chapter.firstIndex + 1}`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div
            className="flex h-9 flex-none items-center rounded-2xl border border-stone-200 bg-stone-50 p-1 text-xs font-medium shadow-sm md:h-auto md:rounded-full"
            aria-label="Mode de lecture"
          >
            <button
              type="button"
              onClick={() => updateReadingMode('pages')}
              className={[
                'rounded-xl px-3 py-1.5 transition-colors md:rounded-full md:py-1',
                readingMode === 'pages'
                  ? 'bg-white text-violet-700 shadow-sm'
                  : 'text-stone-500 hover:bg-white/70',
              ].join(' ')}
            >
              Pages
            </button>
            <button
              type="button"
              onClick={() => updateReadingMode('scroll')}
              className={[
                'rounded-xl px-3 py-1.5 transition-colors md:rounded-full md:py-1',
                readingMode === 'scroll'
                  ? 'bg-white text-violet-700 shadow-sm'
                  : 'text-stone-500 hover:bg-white/70',
              ].join(' ')}
            >
              Continu
            </button>
          </div>
          <div
            className="hidden items-center justify-center rounded-full border border-stone-200 bg-stone-50 p-1 shadow-sm md:flex"
            aria-label="Réglage de la taille du texte"
          >
            <button
              type="button"
              onClick={() => updateBookFontSize(bookFontSize - BOOK_FONT_SIZE_STEP)}
              disabled={bookFontSize <= MIN_BOOK_FONT_SIZE}
              aria-label="Réduire la taille du texte"
              className="rounded-xl px-3 py-1.5 text-xs font-semibold text-stone-500 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35 md:rounded-full md:py-1"
            >
              A−
            </button>
            <span className="px-2 font-serif text-sm text-stone-700" aria-hidden="true">
              Options
            </span>
            <button
              type="button"
              onClick={() => updateBookFontSize(bookFontSize + BOOK_FONT_SIZE_STEP)}
              disabled={bookFontSize >= MAX_BOOK_FONT_SIZE}
              aria-label="Augmenter la taille du texte"
              className="rounded-xl px-3 py-1.5 text-base font-semibold text-stone-700 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35 md:rounded-full md:py-1"
            >
              A+
            </button>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsSettingsOpen(isOpen => !isOpen)}
              className={[
                'h-9 flex-none rounded-2xl border px-3 text-xs font-medium shadow-sm transition-colors hover:bg-white md:h-auto md:rounded-full md:py-1.5',
                anthropicApiKey.trim()
                  ? 'border-stone-200 bg-stone-50 text-stone-600 hover:text-stone-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800 hover:text-amber-950',
              ].join(' ')}
              aria-expanded={isSettingsOpen}
              aria-haspopup="menu"
            >
              Aa
            </button>
            {isSettingsOpen && (
              <div
                role="menu"
                className="fixed inset-x-0 bottom-0 z-40 max-h-[86dvh] overflow-y-auto rounded-t-[1.75rem] border border-stone-200 bg-white p-4 text-sm shadow-2xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-auto md:mt-2 md:w-80 md:rounded-2xl md:p-3"
              >
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-200 md:hidden" />
                <div className="space-y-3 border-b border-stone-100 pb-3">
                  <div className="md:hidden">
                    <p className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Taille du texte
                    </p>
                    <div
                      className="mt-2 flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-50 p-1 shadow-sm"
                      aria-label="Réglage de la taille du texte"
                    >
                      <button
                        type="button"
                        onClick={() => updateBookFontSize(bookFontSize - BOOK_FONT_SIZE_STEP)}
                        disabled={bookFontSize <= MIN_BOOK_FONT_SIZE}
                        aria-label="Réduire la taille du texte"
                        className="rounded-xl px-4 py-2 text-sm font-semibold text-stone-500 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        A−
                      </button>
                      <span className="px-2 font-serif text-base text-stone-700" aria-hidden="true">
                        Aa
                      </span>
                      <button
                        type="button"
                        onClick={() => updateBookFontSize(bookFontSize + BOOK_FONT_SIZE_STEP)}
                        disabled={bookFontSize >= MAX_BOOK_FONT_SIZE}
                        aria-label="Augmenter la taille du texte"
                        className="rounded-xl px-4 py-2 text-lg font-semibold text-stone-700 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        A+
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Clé Anthropic locale
                    </label>
                    <input
                      type="password"
                      value={anthropicApiKey}
                      onChange={event => updateAnthropicApiKey(event.target.value)}
                      placeholder="sk-ant-..."
                      className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-3 text-base text-stone-800 outline-none transition-colors focus:border-violet-300 md:py-2 md:text-sm"
                    />
                    <p className="mt-1 text-xs leading-relaxed text-stone-400">
                      Stockée dans ce navigateur. Nécessaire sur GitHub Pages.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Modèle
                    </label>
                    <input
                      type="text"
                      value={anthropicModel}
                      onChange={event => updateAnthropicModel(event.target.value)}
                      className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-3 text-base text-stone-800 outline-none transition-colors focus:border-violet-300 md:py-2 md:text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => updateAnthropicApiKey('')}
                    className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-700"
                  >
                  Supprimer la clé
                  </button>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleClearCache}
                  className="mt-2 w-full rounded-xl px-3 py-2 text-left text-stone-700 transition-colors hover:bg-stone-50"
                >
                  <span className="block font-medium">Supprimer les commentaires enregistrés</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-stone-400">
                    Les commentaires IA seront régénérés à la demande.
                  </span>
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => router.push('/')}
            className="hidden text-xs text-slate-400 transition-colors hover:text-slate-700 md:block"
          >
            ← Accueil
          </button>
        </div>
      </header>

      {/* ── Chapter label ── */}
      {headerChapterLabel && (
        <div className="hidden flex-none border-b border-stone-200 bg-stone-100 px-5 py-2 text-xs font-medium uppercase tracking-wide text-stone-500 md:block">
          {headerChapterLabel}
        </div>
      )}
      {cacheClearMessage && (
        <div className="flex-none border-b border-violet-100 bg-violet-50 px-5 py-2 text-xs font-medium text-violet-700">
          {cacheClearMessage}
        </div>
      )}
      {areAiSettingsLoaded && !anthropicApiKey.trim() && (
        <div className="flex flex-none items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 md:px-5">
          <span className="min-w-0">
            IA non configurée.
            <span className="hidden sm:inline"> Renseignez une clé Anthropic locale dans les réglages.</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setIsSettingsOpen(true);
              setIsTocOpen(false);
            }}
            className="flex-none rounded-full bg-white px-3 py-1.5 font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100"
          >
            Configurer
          </button>
        </div>
      )}

      {/* ── Main panels ── */}
      <main
        ref={mainRef}
        className={[
          'relative flex-1 overflow-hidden md:flex md:flex-row',
          isResizingSplit ? 'select-none cursor-col-resize' : '',
        ].join(' ')}
        style={{ '--reader-split-percent': `${splitPercent}%` } as CSSProperties}
      >
        {isExplanationOpen && (
          <button
            type="button"
            aria-label="Fermer l'explication"
            onClick={() => setIsExplanationOpen(false)}
            className="fixed inset-0 z-20 bg-stone-950/25 md:hidden"
          />
        )}
        {/* Left: AI explanation (appears bottom on mobile, left on desktop) */}
        <section
          aria-label="Commentaire IA"
          className={[
            'reader-explanation-pane fixed inset-x-0 bottom-0 z-30 max-h-[62dvh] overflow-y-auto rounded-t-[1.35rem] border-t border-stone-200 bg-stone-100 px-3 py-2 shadow-2xl transition-transform duration-200 md:relative md:inset-auto md:z-auto md:max-h-none md:flex-none md:translate-y-0 md:rounded-none md:border-t-0 md:px-10 md:py-8 md:shadow-none',
            isExplanationOpen ? 'translate-y-0' : 'translate-y-full',
          ].join(' ')}
        >
          <div className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-stone-300 md:hidden" />
          <div className="mx-auto max-w-prose">
            <div className="sticky -top-2 z-10 -mx-3 mb-2 flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-100/95 px-3 py-2 backdrop-blur md:static md:mx-0 md:mb-5 md:border-b-0 md:bg-transparent md:p-0 md:backdrop-blur-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-violet-500 md:text-lg">✨</span>
                <div>
                  <h2 className="text-sm font-semibold leading-tight text-stone-900 md:text-xs md:uppercase md:tracking-widest md:text-violet-500">
                    Commentaire
                  </h2>
                  <p className="text-[11px] text-stone-400 md:hidden">
                    {selectedPassage?.label ?? 'Aucune sélection'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsExplanationOpen(false)}
                className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-stone-500 shadow-sm md:hidden"
              >
                Fermer
              </button>
            </div>

            <div className="mb-2 rounded-2xl border border-violet-100 bg-white p-3 shadow-sm md:mb-5 md:p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="hidden text-xs font-semibold uppercase tracking-widest text-violet-500 md:block">
                    {selectedPassage?.label ?? 'Sélection'}
                  </p>
                  <p className="line-clamp-1 font-serif text-sm leading-relaxed text-stone-600 md:mt-2 md:line-clamp-4">
                    {selectedPassage?.text ?? 'Sélectionnez un passage du livre.'}
                  </p>
                </div>
                {selectedPassage && (
                  <button
                    type="button"
                    onClick={() => resetExplanation()}
                    className="flex-none rounded-full bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    Désélectionner
                  </button>
                )}
              </div>
              {selectedPassage ? (
                <button
                  type="button"
                  onClick={() => explainPassage(selectedPassage)}
                  disabled={isLoading}
                  className="mt-2 flex w-full items-center justify-center rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-wait disabled:bg-violet-300 md:mt-3 md:inline-flex md:w-auto md:rounded-full md:py-2"
                >
                  {isLoading
                    ? 'Génération...'
                    : selectedPassage.paragraphIndex === null
                      ? 'Commenter la sélection'
                      : 'Commenter ce paragraphe'}
                </button>
              ) : (
                <p className="mt-2 rounded-xl bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500">
                  Touchez un paragraphe, ou sélectionnez quelques lignes.
                </p>
              )}
            </div>

            {isLoading && !explanation && <ExplanationSkeleton />}

            {loadError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 md:p-4">
                {loadError}
                <button
                  onClick={() => selectedPassage && explainPassage(selectedPassage)}
                  className="mt-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-100"
                >
                  Réessayer
                </button>
              </div>
            )}

            {explanation && (
              <div className="analysis-markdown rounded-2xl bg-white p-4 text-stone-700 shadow-sm md:p-5">
                <ReactMarkdown>{explanation}</ReactMarkdown>
                {isLoading && (
                  <span className="inline-block w-0.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                )}
              </div>
            )}

            {!isLoading && !loadError && !explanation && (
              <div className="hidden rounded-xl border border-dashed border-stone-200 bg-white/70 p-3 text-sm leading-relaxed text-stone-500 md:block md:p-5">
                Astuce : Cmd/Ctrl+clic ajoute un paragraphe, Shift+clic sélectionne une plage.
              </div>
            )}
          </div>
        </section>

        <button
          type="button"
          role="separator"
          title="Ajuster la largeur des panneaux"
          aria-label="Ajuster la largeur des panneaux"
          aria-orientation="vertical"
          aria-valuemin={MIN_SPLIT_PERCENT}
          aria-valuemax={MAX_SPLIT_PERCENT}
          aria-valuenow={Math.round(splitPercent)}
          onPointerDown={handleSplitResizeStart}
          onKeyDown={handleSplitKeyDown}
          className="reader-splitter group hidden flex-none items-center justify-center bg-stone-300/80 transition-colors hover:bg-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 md:flex"
        >
          <span className="flex h-12 w-2 flex-col items-center justify-center gap-1 rounded-full bg-white/70 shadow-sm group-hover:bg-white">
            <span className="h-1 w-1 rounded-full bg-stone-400" />
            <span className="h-1 w-1 rounded-full bg-stone-400" />
            <span className="h-1 w-1 rounded-full bg-stone-400" />
          </span>
        </button>

        {/* Right: Book text */}
        <section
          ref={bookPaneRef}
          aria-label="Texte du livre"
          onScroll={updateCurrentParagraphFromScroll}
          onMouseUp={captureTextSelection}
          onTouchEnd={captureTextSelection}
          className="reader-book-pane relative h-full overflow-y-auto bg-[#fffdf7] px-0 py-0 md:flex-none md:bg-stone-200/70 md:px-8 md:py-10"
        >
          <div className="mx-auto max-w-3xl md:h-auto">
            {displayedParagraphs.length > 0 ? (
              <div
                className="book-page min-h-full rounded-none px-5 py-6 md:rounded-sm md:px-16 md:py-16"
                style={{ '--book-font-size': `${bookFontSize}px` } as CSSProperties}
              >
                {bookHeaderLabel && (
                  <div className="mb-6 border-b border-stone-200 pb-3 text-center md:mb-10 md:pb-4">
                    <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400 md:text-[11px] md:tracking-[0.35em]">
                      {bookHeaderLabel}
                    </p>
                  </div>
                )}
                <div className="space-y-0">
                  {displayedParagraphs.map((item, index) => {
                    const isSelected = selectedParagraphIndexes.includes(item.globalIndex);
                    const isExplaining = isLoading && explainedParagraphIndex === item.globalIndex;
                    const hasExplanation = explainedParagraphIndexes.includes(item.globalIndex);
                    const previousParagraph = displayedParagraphs[index - 1];
                    const shouldShowChapterSeparator =
                      readingMode === 'scroll' && item.chapterTitle !== previousParagraph?.chapterTitle;

                    return (
                      <Fragment key={item.globalIndex}>
                        {shouldShowChapterSeparator && (
                          <div className="my-10 flex items-center gap-4 first:mt-0">
                            <div className="h-px flex-1 bg-stone-200" />
                            <p className="max-w-[70%] text-center text-[11px] font-medium uppercase tracking-[0.3em] text-stone-400">
                              {item.chapterTitle}
                            </p>
                            <div className="h-px flex-1 bg-stone-200" />
                          </div>
                        )}
                        <article
                          data-paragraph-index={item.globalIndex}
                          role="button"
                          tabIndex={0}
                          onClick={event => {
                            const selectedText = window.getSelection()?.toString().trim() ?? '';
                            if (selectedText.length > 0) return;
                            selectParagraph(item.globalIndex, {
                              additive: event.metaKey || event.ctrlKey,
                              range: event.shiftKey,
                            });
                          }}
                          onKeyDown={event => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            selectParagraph(item.globalIndex);
                          }}
                          className={[
                            'book-paragraph-block relative rounded-lg px-0 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300 md:px-4',
                            isSelected
                              ? 'book-paragraph-active'
                              : '',
                            hasExplanation
                              ? 'book-paragraph-explained'
                              : '',
                          ].join(' ')}
                        >
                          <p className="book-paragraph block w-full text-left">
                            {item.text}
                          </p>
                          {hasExplanation && (
                            <div className="book-explained-badge">
                              Commenté
                            </div>
                          )}
                          <div className="book-explain-action transition-opacity">
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation();
                                explainParagraph(item);
                              }}
                              disabled={isExplaining}
                              className="rounded-full border border-stone-300 bg-[#fffdf7]/95 px-4 py-2 text-xs font-medium text-violet-700 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:cursor-wait disabled:text-violet-300 md:px-3 md:py-1.5"
                            >
                              {isExplaining
                                ? 'Génération...'
                                : hasExplanation
                                  ? 'Ouvrir'
                                  : 'Commenter'}
                            </button>
                          </div>
                        </article>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-slate-400 italic">Fin du livre.</p>
            )}
          </div>
          <div
            ref={paginationMeasureRef}
            aria-hidden="true"
            className="pagination-measure mx-auto max-w-3xl"
          >
            <div
              className="book-page min-h-full rounded-sm px-8 py-10 md:px-16 md:py-16"
              style={{ '--book-font-size': `${bookFontSize}px` } as CSSProperties}
            >
              <div className="mb-10 border-b border-stone-200 pb-4 text-center">
                <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-stone-400">
                  Mesure
                </p>
              </div>
              <div data-pagination-measure-content>
                {epub.paragraphs.map(item => (
                  <article
                    key={item.globalIndex}
                    data-measure-paragraph-index={item.globalIndex}
                    className="book-paragraph-block relative rounded-lg px-4 py-2"
                  >
                    <div className="book-paragraph block w-full text-left">
                      {item.text}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      {selectedPassage && !isExplanationOpen && (
        <button
          type="button"
          onClick={() => setIsExplanationOpen(true)}
          className={[
            'fixed right-3 z-20 rounded-full bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-xl shadow-violet-900/20 md:hidden',
            readingMode === 'pages' ? 'bottom-16' : 'bottom-4',
          ].join(' ')}
        >
          Commentaire
        </button>
      )}

      {/* ── Navigation footer ── */}
      {readingMode === 'pages' && (
        <footer className="flex-none flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-2 md:gap-4 md:px-5 md:py-3">
          <button
            onClick={() => {
              const previousPage = pages[currentPage - 1];
              if (!previousPage) return;

              resetExplanation();
              navigate(previousPage[0].globalIndex);
            }}
            disabled={isFirst}
            aria-label="Page précédente"
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all md:px-4
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:text-slate-700 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
          >
            ← <span className="hidden sm:inline">Précédent</span>
          </button>

          <span className="text-xs text-slate-400 tabular-nums">
            Page {currentPage + 1} / {totalPages}
          </span>

          <button
            onClick={() => {
              const nextPage = pages[currentPage + 1];
              if (!nextPage) return;

              resetExplanation();
              navigate(nextPage[0].globalIndex);
            }}
            disabled={isLast}
            aria-label="Page suivante"
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all md:px-4
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:text-slate-700 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
          >
            <span className="hidden sm:inline">Suivant</span> →
          </button>
        </footer>
      )}
    </div>
  );
}
