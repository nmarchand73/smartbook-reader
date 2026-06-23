'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  Fragment,
  useCallback,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { useRouter } from 'next/navigation';
import { useEpub } from '@/context/EpubContext';
import {
  downloadLocalDataBackup,
  importLocalData,
  readBackupFile,
} from '@/lib/backup';
import {
  clearExplanationCache,
  getCachedCommentIndex,
  getCachedCommentChat,
  getCachedExplanation,
  rememberCachedComment,
  setCachedCommentChat,
  setCachedExplanation,
  type CachedCommentIndexItem,
} from '@/lib/cache';
import { COMMENT_CHAT_SYSTEM_PROMPT, EXPLANATION_SYSTEM_PROMPT } from '@/config/prompts';
import { APP_VERSION } from '@/config/version';
import type { Paragraph } from '@/lib/epub-parser';

const PARAGRAPHS_PER_PAGE = 5;
const FONT_SIZE_STORAGE_KEY = 'sbr_reader_font_size';
const DEFAULT_BOOK_FONT_SIZE = 16;
const MIN_BOOK_FONT_SIZE = 8;
const MAX_BOOK_FONT_SIZE = 24;
const BOOK_FONT_SIZE_STEP = 1;
const SPLIT_STORAGE_KEY = 'sbr_reader_split_percent';
const DEFAULT_SPLIT_PERCENT = 30;
const MIN_SPLIT_PERCENT = 24;
const MAX_SPLIT_PERCENT = 64;
const READING_MODE_STORAGE_KEY = 'sbr_reader_mode';
const ANTHROPIC_API_KEY_STORAGE_KEY = 'sbr_anthropic_api_key';
const ANTHROPIC_MODEL_STORAGE_KEY = 'sbr_anthropic_model';
const SPEECH_RATE_STORAGE_KEY = 'sbr_speech_rate';
const SPEECH_LANGUAGE_STORAGE_KEY = 'sbr_speech_language';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SPEECH_RATE = 0.9;
const MAX_OUTPUT_TOKENS = 900;
const MAX_CHAT_OUTPUT_TOKENS = 700;
const COMMENT_DRAWER_DRAG_THRESHOLD = 40;

type ReadingMode = 'pages' | 'scroll';
type SpeechStatus = 'idle' | 'speaking' | 'paused';
type SpeechLanguageMode = 'auto' | 'fr-FR' | 'en-US';
type ChatRole = 'user' | 'assistant';
type NotesTab = 'search' | 'comments';
interface ChapterOption {
  title: string;
  firstIndex: number;
  chapterIndex: number;
  paragraphCount: number;
  preview: string;
  isSynthetic: boolean;
}
interface SelectedPassage {
  text: string;
  label: string;
  paragraphIndex: number | null;
  paragraphIndexes: number[];
}
interface SpeechSegment {
  text: string;
  paragraphIndex: number | null;
  sentenceIndex: number | null;
}
interface SearchResult {
  paragraph: Paragraph;
  chapterTitle: string;
  excerpt: string;
}
interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

const MARKDOWN_COMPONENTS: Components = {
  a: props => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredNumber(storageKey: string, min: number, max: number): number | null {
  const storedValue = localStorage.getItem(storageKey);
  if (storedValue === null || storedValue.trim() === '') return null;

  const parsedValue = Number(storedValue);
  if (!Number.isFinite(parsedValue)) return null;

  return clampNumber(parsedValue, min, max);
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

function buildCommentChatPrompt(options: {
  passage: string;
  explanation: string;
  question: string;
  bookTitle: string;
  author: string;
  messages: ChatMessage[];
}): string {
  const contextLines = [
    options.bookTitle ? `- Titre du livre : ${options.bookTitle}` : null,
    options.author ? `- Auteur : ${options.author}` : null,
  ].filter((line): line is string => line !== null);
  const recentMessages = options.messages.slice(-6);
  const conversation = recentMessages.length > 0
    ? recentMessages
      .map(message => `${message.role === 'user' ? 'Lecteur' : 'Assistant'} : ${message.content}`)
      .join('\n\n')
    : 'Aucun échange précédent.';

  return `## Contexte du livre
${contextLines.length > 0 ? contextLines.join('\n') : '- Métadonnées indisponibles'}

## Passage sélectionné
${options.passage.slice(0, 2200)}

## Commentaire initial
${options.explanation.slice(0, 2400)}

## Conversation récente
${conversation}

## Nouvelle question du lecteur
${options.question.slice(0, 1000)}`;
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

function detectSpeechLanguage(text: string): string {
  const sample = text.slice(0, 1200).toLowerCase();
  const frenchMatches = (
    sample.match(/\b(le|la|les|des|une|dans|avec|pour|que|qui|est|pas|plus|vous|nous|sur)\b/g) ?? []
  ).length;
  const englishMatches = (
    sample.match(/\b(the|and|that|with|for|you|not|this|from|have|are|was|were|his|her)\b/g) ?? []
  ).length;

  return englishMatches > frenchMatches ? 'en-US' : 'fr-FR';
}

function findSpeechVoice(language: string): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;

  const voices = window.speechSynthesis.getVoices();
  const languagePrefix = language.split('-')[0];

  return (
    voices.find(voice => voice.lang === language) ??
    voices.find(voice => voice.lang.startsWith(`${languagePrefix}-`)) ??
    null
  );
}

function splitIntoSentences(text: string): string[] {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) return [];

  try {
    if ('Segmenter' in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(normalizedText), segment =>
        segment.segment.trim()
      ).filter(Boolean);
      if (segments.length > 0) return segments;
    }
  } catch {
    // Fall through to regex segmentation.
  }

  return normalizedText
    .split(/(?<=[.!?…])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getSearchExcerpt(text: string, query: string): string {
  const exactMatchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  const start = exactMatchIndex >= 0 ? Math.max(0, exactMatchIndex - 70) : 0;
  const excerpt = text.slice(start, start + 190).trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + 190 < text.length ? '…' : '';

  return `${prefix}${excerpt}${suffix}`;
}

function getCommentExcerpt(text: string): string {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  return normalizedText.length > 180
    ? `${normalizedText.slice(0, 180).trim()}…`
    : normalizedText;
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

async function fetchFollowUpAnswer(
  params: {
    passage: string;
    explanation: string;
    question: string;
    bookTitle: string;
    author: string;
    messages: ChatMessage[];
  },
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
        max_tokens: MAX_CHAT_OUTPUT_TOKENS,
        system: COMMENT_CHAT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildCommentChatPrompt(params),
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
    return full;
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      model: options.model.trim() || DEFAULT_ANTHROPIC_MODEL,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Erreur API : ${response.status}`);
  }

  const responseBody = await response.json();
  if (
    typeof responseBody !== 'object' ||
    responseBody === null ||
    !('answer' in responseBody) ||
    typeof responseBody.answer !== 'string' ||
    responseBody.answer.trim().length === 0
  ) {
    throw new Error('Réponse vide.');
  }

  return responseBody.answer;
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function ExplanationSkeleton() {
  return (
    <div
      className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm"
      aria-busy="true"
      aria-live="polite"
      aria-label="Génération du commentaire en cours"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-900">Génération du commentaire</p>
          <p className="mt-0.5 text-xs text-stone-400">Analyse du passage sélectionné</p>
        </div>
        <div className="flex gap-1" aria-hidden="true">
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
        </div>
      </div>
      <div className="space-y-2.5" aria-hidden="true">
        <div className="loading-shimmer h-3.5 w-full rounded-full" />
        <div className="loading-shimmer h-3.5 w-11/12 rounded-full" />
        <div className="loading-shimmer h-3.5 w-4/5 rounded-full" />
      </div>
      <div className="mt-4 space-y-2" aria-hidden="true">
        <div className="loading-shimmer h-3 w-2/3 rounded-full" />
        <div className="loading-shimmer h-3 w-5/6 rounded-full" />
      </div>
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
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
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [activeNotesTab, setActiveNotesTab] = useState<NotesTab>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchParagraphIndex, setActiveSearchParagraphIndex] = useState<number | null>(null);
  const [commentIndexItems, setCommentIndexItems] = useState<CachedCommentIndexItem[]>([]);
  const [isExplanationOpen, setIsExplanationOpen] = useState(false);
  const [isExplanationExpanded, setIsExplanationExpanded] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('idle');
  const [activeSpeechSegment, setActiveSpeechSegment] = useState<SpeechSegment | null>(null);
  const [speechRate, setSpeechRate] = useState(DEFAULT_SPEECH_RATE);
  const [speechLanguageMode, setSpeechLanguageMode] = useState<SpeechLanguageMode>('auto');
  const [cacheClearMessage, setCacheClearMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [includeApiKeyInBackup, setIncludeApiKeyInBackup] = useState(false);
  const [isImportingBackup, setIsImportingBackup] = useState(false);
  const [paginatedPages, setPaginatedPages] = useState<Paragraph[][]>([]);
  const [paginationLayoutVersion, setPaginationLayoutVersion] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const bookPaneRef = useRef<HTMLElement | null>(null);
  const paginationMeasureRef = useRef<HTMLDivElement | null>(null);
  const previousReadingModeRef = useRef<ReadingMode>('pages');
  const currentChapterButtonRef = useRef<HTMLButtonElement | null>(null);
  const explanationDrawerDragStartYRef = useRef<number | null>(null);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechSegmentsRef = useRef<SpeechSegment[]>([]);
  const speechSegmentIndexRef = useRef(0);
  const speechGenerationRef = useRef(0);
  const speechRateRef = useRef(DEFAULT_SPEECH_RATE);
  const speechLanguageModeRef = useRef<SpeechLanguageMode>('auto');

  const rememberExplainedParagraphs = useCallback((paragraphIndexes: number[]) => {
    if (paragraphIndexes.length === 0) return;

    setExplainedParagraphIndexes(currentIndexes =>
      Array.from(new Set([...currentIndexes, ...paragraphIndexes])).sort((a, b) => a - b)
    );
  }, []);

  const resetCommentChat = useCallback(() => {
    chatAbortRef.current?.abort();
    setChatMessages([]);
    setChatInput('');
    setIsChatLoading(false);
    setChatError(null);
  }, []);

  const rememberCommentIndexItem = useCallback((
    passageText: string,
    paragraphIndex: number | null,
    paragraphIndexes: number[]
  ) => {
    if (!epub) return;

    const firstParagraphIndex = paragraphIndexes[0] ?? paragraphIndex ?? 0;
    const paragraph = epub.paragraphs[firstParagraphIndex] ?? epub.paragraphs[0];
    const tocTitle = [...(epub.toc ?? [])]
      .reverse()
      .find(item => item.firstIndex <= firstParagraphIndex)?.title;
    const item: CachedCommentIndexItem = {
      paragraphIndex,
      paragraphIndexes,
      chapterTitle: tocTitle ?? paragraph?.chapterTitle ?? 'Section',
      excerpt: getCommentExcerpt(passageText),
      text: passageText,
      updatedAt: Date.now(),
    };

    setCommentIndexItems(rememberCachedComment(epub.title, item));
  }, [epub]);

  const loadCommentIndexItems = useCallback((): CachedCommentIndexItem[] => {
    if (!epub) return [];

    const existingItems = getCachedCommentIndex(epub.title);
    const existingTexts = new Set(existingItems.map(item => item.text));
    const missingParagraphItems = epub.paragraphs
      .filter(paragraph => !existingTexts.has(paragraph.text))
      .filter(paragraph => Boolean(getCachedExplanation(epub.title, paragraph.text)))
      .map((paragraph): CachedCommentIndexItem => {
        const tocTitle = [...(epub.toc ?? [])]
          .reverse()
          .find(item => item.firstIndex <= paragraph.globalIndex)?.title;

        return {
          paragraphIndex: paragraph.globalIndex,
          paragraphIndexes: [paragraph.globalIndex],
          chapterTitle: tocTitle ?? paragraph.chapterTitle,
          excerpt: getCommentExcerpt(paragraph.text),
          text: paragraph.text,
          updatedAt: Date.now(),
        };
      });

    if (missingParagraphItems.length === 0) return existingItems;

    let nextItems = existingItems;
    missingParagraphItems.forEach(item => {
      nextItems = rememberCachedComment(epub.title, item);
    });
    return nextItems;
  }, [epub]);

  const clearSavedCommentChat = useCallback(() => {
    if (epub && selectedPassage) {
      setCachedCommentChat(epub.title, selectedPassage.text, []);
    }
    resetCommentChat();
  }, [epub, resetCommentChat, selectedPassage]);

  const stopSpeech = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    speechGenerationRef.current += 1;
    window.speechSynthesis.cancel();
    speechUtteranceRef.current = null;
    speechSegmentsRef.current = [];
    speechSegmentIndexRef.current = 0;
    setActiveSpeechSegment(null);
    setSpeechStatus('idle');
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
      const storedFontSize = readStoredNumber(
        FONT_SIZE_STORAGE_KEY,
        MIN_BOOK_FONT_SIZE,
        MAX_BOOK_FONT_SIZE
      );
      if (storedFontSize === null) return;

      setBookFontSize(storedFontSize);
      setPaginationLayoutVersion(version => version + 1);
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
      const storedSplitPercent = readStoredNumber(
        SPLIT_STORAGE_KEY,
        MIN_SPLIT_PERCENT,
        MAX_SPLIT_PERCENT
      );
      if (storedSplitPercent === null) return;

      setSplitPercent(storedSplitPercent);
      setPaginationLayoutVersion(version => version + 1);
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
      const storedSpeechRate = readStoredNumber(SPEECH_RATE_STORAGE_KEY, 0.7, 1.4);
      if (storedSpeechRate !== null) {
        speechRateRef.current = storedSpeechRate;
        setSpeechRate(storedSpeechRate);
      }

      const storedSpeechLanguage = localStorage.getItem(SPEECH_LANGUAGE_STORAGE_KEY);
      if (
        storedSpeechLanguage === 'auto' ||
        storedSpeechLanguage === 'fr-FR' ||
        storedSpeechLanguage === 'en-US'
      ) {
        speechLanguageModeRef.current = storedSpeechLanguage;
        setSpeechLanguageMode(storedSpeechLanguage);
      }
    } catch {
      // Keep default speech settings when localStorage is unavailable.
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
    setCommentIndexItems(loadCommentIndexItems());
  }, [epub, loadCommentIndexItems]);

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

  const speakSpeechSegment = (segmentIndex: number) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const segment = speechSegmentsRef.current[segmentIndex];
    if (!segment) {
      speechUtteranceRef.current = null;
      setActiveSpeechSegment(null);
      setSpeechStatus('idle');
      return;
    }

    const speechGeneration = speechGenerationRef.current;
    const utterance = new SpeechSynthesisUtterance(segment.text);
    const speechLanguage = speechLanguageModeRef.current === 'auto'
      ? detectSpeechLanguage(segment.text)
      : speechLanguageModeRef.current;
    const speechVoice = findSpeechVoice(speechLanguage);

    speechSegmentIndexRef.current = segmentIndex;
    utterance.lang = speechVoice?.lang ?? speechLanguage;
    if (speechVoice) utterance.voice = speechVoice;
    utterance.rate = speechRateRef.current;
    utterance.onstart = () => setActiveSpeechSegment(segment);
    utterance.onend = () => {
      if (speechGeneration !== speechGenerationRef.current) return;
      speakSpeechSegment(segmentIndex + 1);
    };
    utterance.onerror = () => {
      if (speechGeneration !== speechGenerationRef.current) return;
      speechUtteranceRef.current = null;
      setActiveSpeechSegment(null);
      setSpeechStatus('idle');
    };
    speechUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  const restartCurrentSpeechSegment = (keepPaused: boolean) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const segment = speechSegmentsRef.current[speechSegmentIndexRef.current];
    if (!segment) return;

    speechGenerationRef.current += 1;
    window.speechSynthesis.cancel();
    speechUtteranceRef.current = null;
    setActiveSpeechSegment(segment);

    if (keepPaused) {
      setSpeechStatus('paused');
      return;
    }

    setSpeechStatus('speaking');
    speakSpeechSegment(speechSegmentIndexRef.current);
  };

  const updateSpeechRate = (nextRate: number) => {
    const clampedRate = clampNumber(nextRate, 0.7, 1.4);
    speechRateRef.current = clampedRate;
    setSpeechRate(clampedRate);
    try {
      localStorage.setItem(SPEECH_RATE_STORAGE_KEY, clampedRate.toString());
    } catch {
      // Speech rate still updates for the current session.
    }

    if (speechStatus === 'speaking') {
      restartCurrentSpeechSegment(false);
    } else if (speechStatus === 'paused') {
      restartCurrentSpeechSegment(true);
    }
  };

  const updateSpeechLanguageMode = (nextMode: SpeechLanguageMode) => {
    speechLanguageModeRef.current = nextMode;
    setSpeechLanguageMode(nextMode);
    try {
      localStorage.setItem(SPEECH_LANGUAGE_STORAGE_KEY, nextMode);
    } catch {
      // Speech language still updates for the current session.
    }

    if (speechStatus === 'speaking') {
      restartCurrentSpeechSegment(false);
    } else if (speechStatus === 'paused') {
      restartCurrentSpeechSegment(true);
    }
  };

  const getVisibleParagraphIndex = useCallback(() => {
    const bookPane = bookPaneRef.current;
    if (!bookPane) return currentIndex;

    const paneBounds = bookPane.getBoundingClientRect();
    const paragraphElements = Array.from(
      bookPane.querySelectorAll<HTMLElement>('[data-paragraph-index]')
    );
    const visibleParagraph = paragraphElements.find(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom >= paneBounds.top + 96;
    }) ?? paragraphElements[0];

    const paragraphIndex = Number(visibleParagraph?.dataset.paragraphIndex);
    return Number.isFinite(paragraphIndex) ? paragraphIndex : currentIndex;
  }, [currentIndex]);

  const updateReadingMode = useCallback((nextMode: ReadingMode) => {
    if (nextMode === readingMode) return;

    stopSpeech();
    const anchorIndex = readingMode === 'scroll'
      ? getVisibleParagraphIndex()
      : currentIndex;

    navigate(anchorIndex);
    setReadingMode(nextMode);
    setPaginationLayoutVersion(version => version + 1);

    try {
      localStorage.setItem(READING_MODE_STORAGE_KEY, nextMode);
    } catch {
      // Reading mode still updates for the current session.
    }
  }, [currentIndex, getVisibleParagraphIndex, navigate, readingMode, stopSpeech]);

  const refreshSettingsFromStorage = useCallback(() => {
    try {
      const storedApiKey = localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) ?? '';
      const storedModel = localStorage.getItem(ANTHROPIC_MODEL_STORAGE_KEY) ?? DEFAULT_ANTHROPIC_MODEL;
      const storedFontSize = readStoredNumber(
        FONT_SIZE_STORAGE_KEY,
        MIN_BOOK_FONT_SIZE,
        MAX_BOOK_FONT_SIZE
      );
      const storedSplitPercent = readStoredNumber(
        SPLIT_STORAGE_KEY,
        MIN_SPLIT_PERCENT,
        MAX_SPLIT_PERCENT
      );
      const storedSpeechRate = readStoredNumber(SPEECH_RATE_STORAGE_KEY, 0.7, 1.4);
      const storedSpeechLanguage = localStorage.getItem(SPEECH_LANGUAGE_STORAGE_KEY);
      const storedReadingMode = localStorage.getItem(READING_MODE_STORAGE_KEY);

      setAnthropicApiKey(storedApiKey);
      setAnthropicModel(storedModel);
      if (storedFontSize !== null) {
        setBookFontSize(storedFontSize);
      }
      if (storedSplitPercent !== null) {
        setSplitPercent(storedSplitPercent);
      }
      if (storedSpeechRate !== null) {
        speechRateRef.current = storedSpeechRate;
        setSpeechRate(storedSpeechRate);
      }
      if (
        storedSpeechLanguage === 'auto' ||
        storedSpeechLanguage === 'fr-FR' ||
        storedSpeechLanguage === 'en-US'
      ) {
        speechLanguageModeRef.current = storedSpeechLanguage;
        setSpeechLanguageMode(storedSpeechLanguage);
      }
      if (storedReadingMode === 'pages' || storedReadingMode === 'scroll') {
        setReadingMode(storedReadingMode);
      }
      setPaginationLayoutVersion(version => version + 1);
    } catch {
      // Imported data remains in storage even if live settings cannot refresh.
    }
  }, []);

  const handleExportBackup = useCallback(() => {
    try {
      downloadLocalDataBackup(includeApiKeyInBackup);
      setBackupMessage(
        includeApiKeyInBackup
          ? 'Sauvegarde exportée avec la clé IA.'
          : 'Sauvegarde exportée sans la clé IA.'
      );
    } catch {
      setBackupMessage('Impossible de créer la sauvegarde.');
    }
  }, [includeApiKeyInBackup]);

  const handleBackupFileChange = useCallback(
    async (event: ReactChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      const shouldImport = window.confirm(
        'Importer cette sauvegarde va remplacer les données SmartBook Reader correspondantes dans ce navigateur. Continuer ?'
      );
      if (!shouldImport) return;

      setIsImportingBackup(true);
      setBackupMessage(null);
      try {
        const backup = await readBackupFile(file);
        const result = importLocalData(backup, { includeApiKey: includeApiKeyInBackup });
        refreshSettingsFromStorage();
        if (epub && selectedPassage) {
          setChatMessages(getCachedCommentChat(epub.title, selectedPassage.text));
        }
        setCommentIndexItems(loadCommentIndexItems());
        setBackupMessage(
          `${result.importedCount} élément${result.importedCount > 1 ? 's' : ''} importé${result.importedCount > 1 ? 's' : ''}.` +
          (result.skippedCount > 0 ? ` ${result.skippedCount} ignoré${result.skippedCount > 1 ? 's' : ''}.` : '') +
          (!includeApiKeyInBackup && backup.includesApiKey ? ' Clé IA ignorée.' : '')
        );
      } catch (error) {
        setBackupMessage(error instanceof Error ? error.message : 'Import impossible.');
      } finally {
        setIsImportingBackup(false);
      }
    },
    [epub, includeApiKeyInBackup, loadCommentIndexItems, refreshSettingsFromStorage, selectedPassage]
  );

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
        setChatMessages(getCachedCommentChat(epubTitle, passageText));
        setIsLoading(false);
        setLoadError(null);
        rememberExplainedParagraphs(paragraphIndexes);
        rememberCommentIndexItem(passageText, paragraphIndex, paragraphIndexes);
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
        rememberCommentIndexItem(passageText, paragraphIndex, paragraphIndexes);
        setIsLoading(false);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setLoadError('Impossible de générer l\'explication. Vérifiez votre connexion.');
        setIsLoading(false);
      }
    },
    [anthropicApiKey, anthropicModel, rememberCommentIndexItem, rememberExplainedParagraphs]
  );

  const resetExplanation = useCallback(() => {
    abortRef.current?.abort();
    resetCommentChat();
    setSelectedParagraphIndex(null);
    setSelectedParagraphIndexes([]);
    setSelectionAnchorIndex(null);
    setSelectedPassage(null);
    setExplanation(null);
    setExplainedParagraphIndex(null);
    setIsLoading(false);
    setLoadError(null);
    setIsExplanationOpen(false);
    setIsExplanationExpanded(false);
  }, [resetCommentChat]);

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
    setCommentIndexItems([]);
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
        stopSpeech();
        resetExplanation();
        return;
      }

      const nextPassage = buildParagraphPassage(nextIndexes);
      if (!nextPassage) return;

      stopSpeech();
      abortRef.current?.abort();
      resetCommentChat();
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
        setChatMessages(getCachedCommentChat(epub.title, nextPassage.text));
        setExplainedParagraphIndex(nextPassage.paragraphIndex);
        rememberExplainedParagraphs(nextPassage.paragraphIndexes);
        rememberCommentIndexItem(
          nextPassage.text,
          nextPassage.paragraphIndex,
          nextPassage.paragraphIndexes
        );
      }
      navigate(index);
    },
    [
      buildParagraphPassage,
      epub,
      navigate,
      rememberExplainedParagraphs,
      rememberCommentIndexItem,
      resetCommentChat,
      selectedParagraphIndexes,
      selectionAnchorIndex,
      stopSpeech,
    ]
  );

  const explainPassage = useCallback(
    (passage: SelectedPassage) => {
      if (!epub) return;

      stopSpeech();
      setSelectedPassage(passage);
      setSelectedParagraphIndex(passage.paragraphIndex);
      setSelectedParagraphIndexes(passage.paragraphIndexes);
      setSelectionAnchorIndex(passage.paragraphIndexes[passage.paragraphIndexes.length - 1] ?? null);
      setIsExplanationOpen(true);
      resetCommentChat();
      if (passage.paragraphIndex !== null) navigate(passage.paragraphIndex);
      loadExplanation(
        passage.text,
        epub.title,
        epub.author,
        passage.paragraphIndex,
        passage.paragraphIndexes
      );
    },
    [epub, loadExplanation, navigate, resetCommentChat, stopSpeech]
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

      stopSpeech();
      abortRef.current?.abort();
      resetCommentChat();
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
  }, [resetCommentChat, stopSpeech]);

  const askFollowUpQuestion = useCallback(
    async (question: string) => {
      const trimmedQuestion = question.replace(/\s+/g, ' ').trim();
      if (!epub || !selectedPassage || !explanation || !trimmedQuestion || isChatLoading) return;

      chatAbortRef.current?.abort();
      const controller = new AbortController();
      chatAbortRef.current = controller;
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmedQuestion,
      };
      const previousMessages = chatMessages;
      const messagesWithQuestion = [...previousMessages, userMessage];
      setChatMessages(messagesWithQuestion);
      setCachedCommentChat(epub.title, selectedPassage.text, messagesWithQuestion);
      setChatInput('');
      setIsChatLoading(true);
      setChatError(null);

      try {
        const answer = await fetchFollowUpAnswer(
          {
            passage: selectedPassage.text,
            explanation,
            question: trimmedQuestion,
            bookTitle: epub.title,
            author: epub.author,
            messages: previousMessages,
          },
          {
            apiKey: anthropicApiKey,
            model: anthropicModel,
          },
          controller.signal
        );
        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: answer,
        };
        const nextMessages = [...messagesWithQuestion, assistantMessage];
        setChatMessages(nextMessages);
        setCachedCommentChat(epub.title, selectedPassage.text, nextMessages);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setChatError('Impossible de répondre pour le moment. Vérifiez la connexion ou la clé IA.');
      } finally {
        setIsChatLoading(false);
      }
    },
    [
      anthropicApiKey,
      anthropicModel,
      chatMessages,
      epub,
      explanation,
      isChatLoading,
      selectedPassage,
    ]
  );

  // Cancel in-flight generation when leaving the reader
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      chatAbortRef.current?.abort();
      stopSpeech();
    };
  }, [stopSpeech]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (readingMode !== 'pages') return;

      const currentPageIndex = getPageIndexForParagraph(paginatedPages, currentIndex);

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        const nextPage = paginatedPages[currentPageIndex + 1];
        if (!nextPage) return;

        resetExplanation();
        stopSpeech();
        navigate(nextPage[0].globalIndex);
        requestAnimationFrame(() => {
          bookPaneRef.current?.scrollTo({ top: 0 });
        });
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        const previousPage = paginatedPages[currentPageIndex - 1];
        if (!previousPage) return;

        resetExplanation();
        stopSpeech();
        navigate(previousPage[0].globalIndex);
        requestAnimationFrame(() => {
          bookPaneRef.current?.scrollTo({ top: 0 });
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIndex, navigate, paginatedPages, readingMode, resetExplanation, stopSpeech]);

  useEffect(() => {
    const previousReadingMode = previousReadingModeRef.current;
    previousReadingModeRef.current = readingMode;

    if (previousReadingMode === readingMode) return;

    const animationFrame = requestAnimationFrame(() => {
      if (readingMode === 'pages') {
        bookPaneRef.current?.scrollTo({ top: 0 });
        return;
      }

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
  const allChapterOptions = epub.paragraphs.reduce<ChapterOption[]>((chapters, item) => {
    const existingChapter = chapters.find(chapter => chapter.chapterIndex === item.chapterIndex);
    if (existingChapter) {
      existingChapter.paragraphCount += 1;
      return chapters;
    }

    chapters.push({
      title: item.chapterTitle,
      firstIndex: item.globalIndex,
      chapterIndex: item.chapterIndex,
      paragraphCount: 1,
      preview: item.text,
      isSynthetic: item.isSyntheticChapterTitle === true,
    });
    return chapters;
  }, []);
  const tocChapterOptions = (epub.toc ?? []).map((item, index, tocItems): ChapterOption => {
    const paragraph = epub.paragraphs[item.firstIndex] ?? epub.paragraphs[0];
    const nextItem = tocItems[index + 1];
    const nextIndex = nextItem?.firstIndex ?? epub.paragraphs.length;

    return {
      title: item.title,
      firstIndex: item.firstIndex,
      chapterIndex: paragraph?.chapterIndex ?? index,
      paragraphCount: Math.max(1, nextIndex - item.firstIndex),
      preview: paragraph?.text ?? '',
      isSynthetic: false,
    };
  });
  const chapterOptions = tocChapterOptions.length > 0
    ? tocChapterOptions
    : allChapterOptions.filter(chapter => !chapter.isSynthetic);
  const reversedChapterOptions = [...chapterOptions].reverse();
  const getChapterOptionForParagraph = (paragraphIndex: number): ChapterOption | undefined =>
    reversedChapterOptions.find(chapter => chapter.firstIndex <= paragraphIndex);
  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const searchResults: SearchResult[] = normalizedSearchQuery.length >= 2
    ? epub.paragraphs
      .filter(paragraph => normalizeSearchText(paragraph.text).includes(normalizedSearchQuery))
      .map(paragraph => ({
        paragraph,
        chapterTitle: getChapterOptionForParagraph(paragraph.globalIndex)?.title ?? paragraph.chapterTitle,
        excerpt: getSearchExcerpt(paragraph.text, searchQuery.trim()),
      }))
    : [];
  const visibleSearchResults = searchResults.slice(0, 40);
  const currentChapterStartIndex = reversedChapterOptions
    .find(chapter => chapter.firstIndex <= currentIndex)?.firstIndex ??
    [...allChapterOptions]
      .reverse()
      .find(chapter => chapter.firstIndex <= currentIndex)?.firstIndex ??
    allChapterOptions[0]?.firstIndex ??
    0;
  const currentChapterOption =
    chapterOptions.find(chapter => chapter.firstIndex === currentChapterStartIndex) ??
    allChapterOptions.find(chapter => chapter.firstIndex === currentChapterStartIndex);
  const totalPages = pages.length;
  const isFirst = currentPage === 0;
  const isLast = currentPage === totalPages - 1;
  const canNavigatePages = readingMode === 'pages' && totalPages > 0;
  const pageChapterTitles = Array.from(
    new Set(
      pageParagraphs.map(item =>
        getChapterOptionForParagraph(item.globalIndex)?.title ??
        item.chapterTitle
      )
    )
  );
  const chapterLabel = pageChapterTitles.length > 1
    ? `${pageChapterTitles[0]} - ${pageChapterTitles[pageChapterTitles.length - 1]}`
    : pageChapterTitles[0];
  const headerChapterLabel = readingMode === 'pages'
    ? chapterLabel
    : currentChapterOption?.title ?? currentParagraph?.chapterTitle;
  const bookHeaderLabel = readingMode === 'pages' ? chapterLabel : null;
  const speechButtonLabel = speechStatus === 'speaking'
    ? 'Pause'
    : speechStatus === 'paused'
      ? 'Reprendre'
      : 'Écouter';

  const buildSpeechSegments = (): SpeechSegment[] => {
    const paragraphSources = selectedPassage?.paragraphIndexes.length
      ? selectedPassage.paragraphIndexes
        .map(index => epub.paragraphs[index])
        .filter((paragraph): paragraph is Paragraph => Boolean(paragraph))
      : readingMode === 'pages'
        ? pageParagraphs
        : currentParagraph
          ? [currentParagraph]
          : [];

    if (paragraphSources.length > 0) {
      return paragraphSources.flatMap(paragraph =>
        splitIntoSentences(paragraph.text).map((sentence, sentenceIndex) => ({
          text: sentence,
          paragraphIndex: paragraph.globalIndex,
          sentenceIndex,
        }))
      );
    }

    return splitIntoSentences(selectedPassage?.text ?? '').map((sentence, sentenceIndex) => ({
      text: sentence,
      paragraphIndex: null,
      sentenceIndex,
    }));
  };

  const toggleSpeech = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setCacheClearMessage('Lecture vocale non disponible dans ce navigateur.');
      return;
    }

    if (speechStatus === 'speaking') {
      window.speechSynthesis.pause();
      setSpeechStatus('paused');
      return;
    }

    if (speechStatus === 'paused') {
      if (speechUtteranceRef.current && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else {
        speakSpeechSegment(speechSegmentIndexRef.current);
      }
      setSpeechStatus('speaking');
      return;
    }

    const segments = buildSpeechSegments();
    if (segments.length === 0) return;

    window.speechSynthesis.cancel();
    speechGenerationRef.current += 1;
    speechSegmentsRef.current = segments;
    speechSegmentIndexRef.current = 0;
    setActiveSpeechSegment(null);
    setSpeechStatus('speaking');
    speakSpeechSegment(0);
  };

  const jumpToParagraph = (index: number) => {
    resetExplanation();
    stopSpeech();
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

  const goToPage = (direction: -1 | 1) => {
    if (!canNavigatePages) return;

    const liveCurrentPage = getPageIndexForParagraph(pages, currentIndex);
    const targetPage = pages[liveCurrentPage + direction];
    if (!targetPage?.[0]) return;

    resetExplanation();
    stopSpeech();
    navigate(targetPage[0].globalIndex);
    requestAnimationFrame(() => {
      bookPaneRef.current?.scrollTo({ top: 0 });
    });
  };

  const goToSearchResult = (result: SearchResult) => {
    const paragraphIndex = result.paragraph.globalIndex;

    resetExplanation();
    stopSpeech();
    setActiveSearchParagraphIndex(paragraphIndex);
    setIsNotesOpen(false);
    navigate(paragraphIndex);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-paragraph-index="${paragraphIndex}"]`)
          ?.scrollIntoView({ block: 'center' });
      });
    });
  };

  const openCommentIndexItem = (item: CachedCommentIndexItem) => {
    const paragraphIndex = item.paragraphIndexes[0] ?? item.paragraphIndex ?? 0;
    const cachedExplanation = getCachedExplanation(epub.title, item.text);

    stopSpeech();
    abortRef.current?.abort();
    setIsNotesOpen(false);
    setIsExplanationOpen(true);
    setSelectedPassage({
      text: item.text,
      label: item.paragraphIndexes.length > 1
        ? `${item.paragraphIndexes.length} paragraphes sélectionnés`
        : 'Paragraphe sélectionné',
      paragraphIndex: item.paragraphIndex,
      paragraphIndexes: item.paragraphIndexes,
    });
    setSelectedParagraphIndex(item.paragraphIndex);
    setSelectedParagraphIndexes(item.paragraphIndexes);
    setSelectionAnchorIndex(item.paragraphIndexes[item.paragraphIndexes.length - 1] ?? null);
    setExplainedParagraphIndex(item.paragraphIndex);
    setExplanation(cachedExplanation);
    setChatMessages(getCachedCommentChat(epub.title, item.text));
    setIsLoading(false);
    setLoadError(null);
    navigate(paragraphIndex);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-paragraph-index="${paragraphIndex}"]`)
          ?.scrollIntoView({ block: 'center' });
      });
    });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-stone-50">
      {/* ── Header ── */}
      <header className="flex-none border-b border-stone-200 bg-white px-3 py-2 shadow-sm md:flex md:items-center md:justify-between md:px-4">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-xl bg-stone-50 text-[10px] font-bold uppercase tracking-tight text-violet-700 ring-1 ring-stone-200">
              SB
            </span>
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
            Livres
          </button>
        </div>
        <div className="mt-2 grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 md:mt-0 md:flex md:w-auto md:flex-none md:gap-2">
          <div className="relative order-1 min-w-0 md:order-none md:flex-1">
            <button
              type="button"
              onClick={() => {
                setIsTocOpen(isOpen => {
                  const nextIsOpen = !isOpen;
                  if (nextIsOpen) {
                    window.setTimeout(() => {
                      currentChapterButtonRef.current?.scrollIntoView({ block: 'center' });
                    }, 0);
                  }
                  return nextIsOpen;
                });
                setIsSettingsOpen(false);
                setIsNotesOpen(false);
              }}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-3 text-left text-xs font-medium text-stone-600 shadow-sm transition-colors hover:bg-white hover:text-stone-800 md:h-8 md:max-w-56 md:rounded-full"
              aria-expanded={isTocOpen}
              aria-haspopup="dialog"
            >
              <span className="flex-none text-stone-400">Sommaire</span>
              <span className="truncate text-stone-800">{headerChapterLabel}</span>
            </button>
            {isTocOpen && (
              <div
                role="dialog"
                aria-label="Sommaire du livre"
                className="fixed inset-x-0 bottom-0 top-auto z-40 max-h-[82dvh] overflow-hidden rounded-t-[1.75rem] border border-stone-200 bg-white shadow-2xl md:absolute md:bottom-auto md:left-0 md:right-auto md:top-auto md:mt-2 md:max-h-none md:w-[26rem] md:rounded-2xl"
              >
                <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-stone-200 md:hidden" />
                <div className="border-b border-stone-100 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">Sommaire</p>
                      <p className="text-xs text-stone-400">
                        {chapterOptions.length} entrée{chapterOptions.length > 1 ? 's' : ''}
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
                  {chapterOptions.length === 0 && (
                    <div className="rounded-2xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-500">
                      Aucun sommaire exploitable n’a été trouvé dans cet ePub.
                    </div>
                  )}
                  {chapterOptions.map((chapter) => {
                    const isCurrentChapter = chapter.firstIndex === currentChapterStartIndex;
                    const chapterPage = getPageIndexForParagraph(pages, chapter.firstIndex) + 1;

                    return (
                      <button
                        ref={isCurrentChapter ? currentChapterButtonRef : null}
                        key={chapter.firstIndex}
                        type="button"
                        onClick={() => jumpToParagraph(chapter.firstIndex)}
                        className={[
                          'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                          isCurrentChapter
                            ? 'bg-violet-50 text-violet-900 ring-1 ring-violet-100'
                            : 'text-stone-700 hover:bg-stone-50',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium leading-snug">
                            {chapter.title}
                          </span>
                          <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-400">
                            {chapter.preview}
                          </span>
                          <span className="mt-1 block text-[11px] text-stone-400">
                            {readingMode === 'pages'
                              ? `Page ${chapterPage}`
                              : `Paragraphe ${chapter.firstIndex + 1}`}
                            {' · '}
                            {chapter.paragraphCount} paragraphe{chapter.paragraphCount > 1 ? 's' : ''}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="relative order-2 flex-none md:order-none">
            <button
              type="button"
              onClick={() => {
                setIsNotesOpen(isOpen => !isOpen);
                setIsTocOpen(false);
                setIsSettingsOpen(false);
              }}
              className={[
                'h-9 rounded-2xl border px-3 text-xs font-medium shadow-sm transition-colors hover:bg-white md:h-8 md:rounded-full',
                searchQuery.trim()
                  ? 'border-violet-200 bg-violet-50 text-violet-800 hover:text-violet-950'
                  : 'border-stone-200 bg-stone-50 text-stone-600 hover:text-stone-800',
              ].join(' ')}
              aria-expanded={isNotesOpen}
              aria-haspopup="dialog"
            >
              Notes
            </button>
            {isNotesOpen && (
              <div
                role="dialog"
                aria-label="Notes et recherche"
                className="fixed inset-x-0 bottom-0 top-auto z-40 max-h-[82dvh] overflow-hidden rounded-t-[1.75rem] border border-stone-200 bg-white shadow-2xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-auto md:mt-2 md:w-[24rem] md:rounded-2xl"
              >
                <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-stone-200 md:hidden" />
                <div className="border-b border-stone-100 px-4 py-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">Notes</p>
                      <p className="text-xs text-stone-400">
                        {activeNotesTab === 'comments'
                          ? `${commentIndexItems.length} commentaire${commentIndexItems.length > 1 ? 's' : ''}`
                          : normalizedSearchQuery.length >= 2
                            ? `${searchResults.length} résultat${searchResults.length > 1 ? 's' : ''}`
                            : 'Recherche dans le livre'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsNotesOpen(false)}
                      className="rounded-full px-2 py-1 text-xs font-medium text-stone-400 transition-colors hover:bg-stone-50 hover:text-stone-700"
                    >
                      Fermer
                    </button>
                  </div>
                  <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl border border-stone-200 bg-stone-50 p-1 text-xs font-medium shadow-sm">
                    {[
                      ['search', 'Chercher'],
                      ['comments', 'Commentaires'],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setActiveNotesTab(value as NotesTab)}
                        className={[
                          'rounded-xl px-2 py-1.5 transition-colors',
                          activeNotesTab === value
                            ? 'bg-white text-violet-700 shadow-sm'
                            : 'text-stone-500 hover:bg-white/70',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {activeNotesTab === 'search' && (
                  <div className="flex items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 shadow-sm">
                    <input
                      type="search"
                      autoFocus
                      value={searchQuery}
                      onChange={event => setSearchQuery(event.target.value)}
                      placeholder="Mot, phrase, nom..."
                      className="min-w-0 flex-1 bg-transparent text-sm text-stone-800 outline-none placeholder:text-stone-400"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setActiveSearchParagraphIndex(null);
                        }}
                        className="rounded-full px-2 py-1 text-xs font-medium text-stone-400 transition-colors hover:bg-white hover:text-stone-700"
                      >
                        Effacer
                      </button>
                    )}
                  </div>
                  )}
                </div>
                <div className="max-h-[58dvh] overflow-y-auto p-2 md:max-h-[min(68vh,26rem)]">
                  {activeNotesTab === 'search' && normalizedSearchQuery.length < 2 && (
                    <div className="rounded-2xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-500">
                      Saisissez au moins deux caractères pour trouver un passage.
                    </div>
                  )}
                  {activeNotesTab === 'search' && normalizedSearchQuery.length >= 2 && searchResults.length === 0 && (
                    <div className="rounded-2xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-500">
                      Aucun passage trouvé.
                    </div>
                  )}
                  {activeNotesTab === 'search' && visibleSearchResults.map((result, index) => (
                    <button
                      key={result.paragraph.globalIndex}
                      type="button"
                      onClick={() => goToSearchResult(result)}
                      className={[
                        'w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                        activeSearchParagraphIndex === result.paragraph.globalIndex
                          ? 'bg-violet-50 text-violet-900 ring-1 ring-violet-100'
                          : 'text-stone-700 hover:bg-stone-50',
                      ].join(' ')}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate text-xs font-semibold text-violet-500">
                          {result.chapterTitle}
                        </span>
                        <span className="flex-none text-[11px] text-stone-400">
                          #{index + 1}
                        </span>
                      </span>
                      <span className="mt-1 line-clamp-3 block text-sm leading-relaxed text-stone-600">
                        {result.excerpt}
                      </span>
                    </button>
                  ))}
                  {activeNotesTab === 'search' && searchResults.length > visibleSearchResults.length && (
                    <p className="px-3 py-2 text-xs leading-relaxed text-stone-400">
                      Affichage des 40 premiers résultats. Affinez la recherche pour réduire la liste.
                    </p>
                  )}
                  {activeNotesTab === 'comments' && commentIndexItems.length === 0 && (
                    <div className="rounded-2xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-500">
                      Aucun commentaire enregistré. Commentez un paragraphe pour le retrouver ici.
                    </div>
                  )}
                  {activeNotesTab === 'comments' && commentIndexItems.map(item => {
                    const firstIndex = item.paragraphIndexes[0] ?? item.paragraphIndex ?? 0;
                    const hasChat = getCachedCommentChat(epub.title, item.text).length > 0;

                    return (
                      <button
                        key={`${firstIndex}-${item.updatedAt}`}
                        type="button"
                        onClick={() => openCommentIndexItem(item)}
                        className={[
                          'w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                          selectedPassage?.text === item.text
                            ? 'bg-violet-50 text-violet-900 ring-1 ring-violet-100'
                            : 'text-stone-700 hover:bg-stone-50',
                        ].join(' ')}
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="truncate text-xs font-semibold text-violet-500">
                            {item.chapterTitle}
                          </span>
                          {hasChat && (
                            <span className="flex-none rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
                              Chat
                            </span>
                          )}
                        </span>
                        <span className="mt-1 line-clamp-3 block text-sm leading-relaxed text-stone-600">
                          {item.excerpt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div
            className="order-4 col-span-2 flex h-9 items-center rounded-2xl border border-stone-200 bg-stone-50 p-1 text-xs font-medium shadow-sm md:order-none md:col-span-1 md:flex-none md:rounded-full"
            aria-label="Mode de lecture"
          >
            <button
              type="button"
              onClick={() => updateReadingMode('pages')}
              className={[
                'flex-1 rounded-xl px-3 py-1.5 transition-colors md:flex-none md:rounded-full md:py-1',
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
                'flex-1 rounded-xl px-3 py-1.5 transition-colors md:flex-none md:rounded-full md:py-1',
                readingMode === 'scroll'
                  ? 'bg-white text-violet-700 shadow-sm'
                  : 'text-stone-500 hover:bg-white/70',
              ].join(' ')}
            >
              Continu
            </button>
          </div>
          <button
            type="button"
            onClick={toggleSpeech}
            className={[
              'order-5 h-9 flex-none rounded-2xl border px-3 text-xs font-medium shadow-sm transition-colors hover:bg-white md:order-none md:h-8 md:rounded-full',
              speechStatus === 'idle'
                ? 'border-stone-200 bg-stone-50 text-stone-600 hover:text-stone-800'
                : 'border-violet-200 bg-violet-50 text-violet-800 hover:text-violet-950',
            ].join(' ')}
            aria-label="Écouter le texte à voix haute"
          >
            {speechButtonLabel}
          </button>
          <div
            className="hidden items-center justify-center rounded-full border border-stone-200 bg-stone-50 p-1 shadow-sm md:order-none xl:flex"
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
              Aa
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
          <div className="relative order-3 md:order-none">
            <button
              type="button"
              onClick={() => {
                setIsSettingsOpen(isOpen => !isOpen);
                setIsTocOpen(false);
                setIsNotesOpen(false);
              }}
              className={[
                'h-9 flex-none rounded-2xl border px-3 text-xs font-medium shadow-sm transition-colors hover:bg-white md:h-8 md:rounded-full',
                anthropicApiKey.trim()
                  ? 'border-stone-200 bg-stone-50 text-stone-600 hover:text-stone-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800 hover:text-amber-950',
              ].join(' ')}
              aria-expanded={isSettingsOpen}
              aria-haspopup="menu"
            >
              Réglages
            </button>
            {isSettingsOpen && (
              <>
                <button
                  type="button"
                  aria-label="Fermer les options"
                  onClick={() => setIsSettingsOpen(false)}
                  className="fixed inset-0 z-30 bg-transparent md:hidden"
                />
                <div
                  role="menu"
                  className="fixed inset-x-0 bottom-0 z-40 max-h-[86dvh] overflow-y-auto rounded-t-[1.75rem] border border-stone-200 bg-white p-4 text-sm shadow-2xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-auto md:mt-2 md:w-80 md:rounded-2xl md:p-3"
                >
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-200 md:hidden" />
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-stone-900">Réglages de lecture</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-stone-400">
                      Sauvegarde automatique · v{APP_VERSION}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200"
                  >
                    Terminé
                  </button>
                </div>
                <div className="space-y-3 border-b border-stone-100 pb-3">
                  <div>
                    <p className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Taille du texte · {bookFontSize}px
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
                    <p className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Lecture vocale
                    </p>
                    <div className="mt-2 grid grid-cols-3 gap-1 rounded-2xl border border-stone-200 bg-stone-50 p-1 text-xs font-medium shadow-sm">
                      {[
                        ['auto', 'Auto'],
                        ['fr-FR', 'Français'],
                        ['en-US', 'English'],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateSpeechLanguageMode(value as SpeechLanguageMode)}
                          className={[
                            'rounded-xl px-2 py-1.5 transition-colors',
                            speechLanguageMode === value
                              ? 'bg-white text-violet-700 shadow-sm'
                              : 'text-stone-500 hover:bg-white/70',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="mt-3 block text-xs font-medium text-stone-500">
                      Vitesse : {speechRate.toFixed(1)}x
                    </label>
                    <input
                      type="range"
                      min="0.7"
                      max="1.4"
                      step="0.1"
                      value={speechRate}
                      onChange={event => updateSpeechRate(Number(event.target.value))}
                      className="mt-2 w-full accent-violet-600"
                    />
                    <p className="mt-1 text-xs leading-relaxed text-stone-400">
                      Utilise les voix installées sur l’appareil.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Clé IA
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
                      Modèle IA
                    </label>
                    <input
                      type="text"
                      value={anthropicModel}
                      onChange={event => updateAnthropicModel(event.target.value)}
                      className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-3 text-base text-stone-800 outline-none transition-colors focus:border-violet-300 md:py-2 md:text-sm"
                    />
                  </div>
                  <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3">
                    <p className="block text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Sauvegarde locale
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-stone-500">
                      Exporte ou restaure commentaires, chats, positions, dernières lectures et préférences.
                    </p>
                    <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-stone-500">
                      <input
                        type="checkbox"
                        checked={includeApiKeyInBackup}
                        onChange={event => setIncludeApiKeyInBackup(event.target.checked)}
                        className="mt-0.5 accent-violet-600"
                      />
                      <span>
                        Inclure la clé IA dans le fichier. À utiliser seulement pour une sauvegarde privée.
                      </span>
                    </label>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={handleExportBackup}
                        className="rounded-full bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:bg-violet-50 hover:text-violet-700"
                      >
                        Exporter
                      </button>
                      <button
                        type="button"
                        onClick={() => backupInputRef.current?.click()}
                        disabled={isImportingBackup}
                        className="rounded-full bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:cursor-wait disabled:opacity-60"
                      >
                        {isImportingBackup ? 'Import...' : 'Importer'}
                      </button>
                    </div>
                    <input
                      ref={backupInputRef}
                      type="file"
                      accept="application/json,.json"
                      onChange={handleBackupFileChange}
                      className="hidden"
                    />
                    {backupMessage && (
                      <p className="mt-2 rounded-xl bg-white px-3 py-2 text-xs leading-relaxed text-stone-500">
                        {backupMessage}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => updateAnthropicApiKey('')}
                    className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-700"
                  >
                  Supprimer la clé
                  </button>
                  <p className="text-xs leading-relaxed text-stone-400">
                    Les changements sont enregistrés dès la saisie.
                  </p>
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
              </>
            )}
          </div>
          <button
            onClick={() => router.push('/')}
            className="hidden text-xs text-slate-400 transition-colors hover:text-slate-700 md:block"
          >
            ← Livres
          </button>
        </div>
      </header>

      {/* ── Chapter label ── */}
      {headerChapterLabel && (
        <div className="flex flex-none border-b border-stone-200 bg-stone-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500 md:hidden">
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
              setIsNotesOpen(false);
            }}
            className="flex-none rounded-full bg-white px-3 py-1.5 font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100"
          >
            Réglages
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
            'reader-explanation-pane fixed inset-x-0 bottom-0 z-30 overflow-y-auto rounded-t-[1.35rem] border-t border-stone-200 bg-stone-100 px-3 py-2 shadow-2xl transition-[max-height,transform] duration-200 md:relative md:inset-auto md:z-auto md:max-h-none md:flex-none md:translate-y-0 md:rounded-none md:border-t-0 md:px-5 md:py-6 md:shadow-none',
            isExplanationExpanded ? 'max-h-[92dvh]' : 'max-h-[62dvh]',
            isExplanationOpen ? 'translate-y-0' : 'translate-y-full',
          ].join(' ')}
        >
          <button
            type="button"
            aria-label={isExplanationExpanded ? 'Réduire le commentaire' : 'Agrandir le commentaire'}
            onClick={() => setIsExplanationExpanded(isExpanded => !isExpanded)}
            onPointerDown={event => {
              explanationDrawerDragStartYRef.current = event.clientY;
            }}
            onPointerUp={event => {
              const startY = explanationDrawerDragStartYRef.current;
              explanationDrawerDragStartYRef.current = null;
              if (startY === null) return;

              const deltaY = event.clientY - startY;
              if (deltaY < -COMMENT_DRAWER_DRAG_THRESHOLD) setIsExplanationExpanded(true);
              if (deltaY > COMMENT_DRAWER_DRAG_THRESHOLD) setIsExplanationExpanded(false);
            }}
            className="mx-auto mb-1.5 flex w-full touch-none justify-center py-1 md:hidden"
          >
            <span className="h-1 w-10 rounded-full bg-stone-300" />
          </button>
          <div className="mx-auto max-w-prose">
            <div className="sticky -top-2 z-10 -mx-3 mb-2 flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-100/95 px-3 py-2 backdrop-blur md:static md:mx-0 md:mb-5 md:border-b-0 md:bg-transparent md:p-0 md:backdrop-blur-0">
              <div className="flex items-center gap-2">
                <span className="hidden h-6 w-6 items-center justify-center rounded-full bg-violet-50 text-[10px] font-bold uppercase text-violet-600 md:flex">
                  IA
                </span>
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
            <button
              type="button"
              onClick={() => setIsExplanationExpanded(isExpanded => !isExpanded)}
              className="mb-2 w-full rounded-xl bg-white px-3 py-2 text-xs font-medium text-stone-500 shadow-sm md:hidden"
            >
              {isExplanationExpanded ? 'Réduire le panneau' : 'Agrandir le panneau'}
            </button>

            <div className="mb-2 rounded-2xl border border-violet-100 bg-white p-3 shadow-sm md:mb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="hidden text-xs font-semibold uppercase tracking-widest text-violet-500 md:block">
                    {selectedPassage?.label ?? 'Sélection'}
                  </p>
                  <p className="line-clamp-1 font-serif text-sm leading-relaxed text-stone-600 md:mt-2 md:line-clamp-3">
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
                  Cliquez un paragraphe pour le commenter.
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
              <>
                <div className="analysis-markdown rounded-2xl bg-white p-4 text-stone-700 shadow-sm md:p-5">
                  <ReactMarkdown components={MARKDOWN_COMPONENTS}>{explanation}</ReactMarkdown>
                  {isLoading && (
                    <span className="inline-block w-0.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                  )}
                </div>
                <div className="mt-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm md:mt-4 md:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-stone-900">Approfondir</h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-stone-400">
                        Posez une question sur ce commentaire.
                      </p>
                    </div>
                    {chatMessages.length > 0 && (
                      <button
                        type="button"
                        onClick={clearSavedCommentChat}
                        className="rounded-full px-2 py-1 text-xs font-medium text-stone-400 transition-colors hover:bg-stone-50 hover:text-stone-700"
                      >
                        Effacer
                      </button>
                    )}
                  </div>

                  {chatMessages.length === 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {[
                        'Explique plus simplement',
                        'Donne le contexte',
                        'Pourquoi c’est important ?',
                      ].map(suggestion => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => askFollowUpQuestion(suggestion)}
                          disabled={isChatLoading}
                          className="rounded-full bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:cursor-wait disabled:opacity-60"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}

                  {chatMessages.length > 0 && (
                    <div className="mt-3 space-y-2.5">
                      {chatMessages.map(message => (
                        <div
                          key={message.id}
                          className={[
                            'rounded-2xl px-3 py-2 text-sm leading-relaxed',
                            message.role === 'user'
                              ? 'bg-violet-50 text-violet-950'
                              : 'analysis-markdown bg-stone-50 text-stone-700',
                          ].join(' ')}
                        >
                          {message.role === 'user' ? (
                            <p className="font-medium">{message.content}</p>
                          ) : (
                            <ReactMarkdown components={MARKDOWN_COMPONENTS}>
                              {message.content}
                            </ReactMarkdown>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {isChatLoading && (
                    <div
                      className="mt-3 flex items-center gap-2 rounded-2xl bg-stone-50 px-3 py-2 text-xs font-medium text-stone-400"
                      aria-live="polite"
                    >
                      <span>Réponse en cours</span>
                      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                    </div>
                  )}

                  {chatError && (
                    <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
                      {chatError}
                    </p>
                  )}

                  <form
                    className="mt-3 flex items-end gap-2 rounded-2xl border border-stone-200 bg-stone-50 p-2 shadow-sm"
                    onSubmit={event => {
                      event.preventDefault();
                      askFollowUpQuestion(chatInput);
                    }}
                  >
                    <textarea
                      value={chatInput}
                      onChange={event => setChatInput(event.target.value)}
                      placeholder="Poser une question sur ce commentaire..."
                      rows={1}
                      className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-stone-800 outline-none placeholder:text-stone-400"
                    />
                    <button
                      type="submit"
                      disabled={!chatInput.trim() || isChatLoading}
                      className="flex-none rounded-full bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-stone-300"
                    >
                      Envoyer
                    </button>
                  </form>
                </div>
              </>
            )}

            {!isLoading && !loadError && !explanation && (
              <div className="hidden rounded-2xl border border-dashed border-stone-200 bg-white/70 p-3 text-xs leading-relaxed text-stone-400 md:block">
                Cmd/Ctrl+clic ajoute un paragraphe. Shift+clic sélectionne une plage.
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
          className="reader-book-pane relative h-full overflow-y-auto bg-[#fffdf7] px-0 py-0 md:flex-none md:bg-stone-200/70 md:px-6 md:py-8"
        >
          <div className="mx-auto max-w-4xl md:h-auto">
            {displayedParagraphs.length > 0 ? (
              <div
                className="book-page min-h-full rounded-none px-5 py-6 md:rounded-sm md:px-20 md:py-14"
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
                    const isSearchActive = activeSearchParagraphIndex === item.globalIndex;
                    const isExplaining = isLoading && explainedParagraphIndex === item.globalIndex;
                    const hasExplanation = explainedParagraphIndexes.includes(item.globalIndex);
                    const previousParagraph = displayedParagraphs[index - 1];
                    const itemChapterTitle =
                      getChapterOptionForParagraph(item.globalIndex)?.title ?? item.chapterTitle;
                    const previousChapterTitle = previousParagraph
                      ? getChapterOptionForParagraph(previousParagraph.globalIndex)?.title ??
                        previousParagraph.chapterTitle
                      : null;
                    const shouldShowChapterSeparator =
                      readingMode === 'scroll' && itemChapterTitle !== previousChapterTitle;

                    return (
                      <Fragment key={item.globalIndex}>
                        {shouldShowChapterSeparator && (
                          <div className="my-10 flex items-center gap-4 first:mt-0">
                            <div className="h-px flex-1 bg-stone-200" />
                            <p className="max-w-[70%] text-center text-[11px] font-medium uppercase tracking-[0.3em] text-stone-400">
                              {itemChapterTitle}
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
                            isSearchActive
                              ? 'ring-2 ring-amber-200 bg-amber-50/45'
                              : '',
                            hasExplanation
                              ? 'book-paragraph-explained'
                              : '',
                          ].join(' ')}
                        >
                          <p className="book-paragraph block w-full text-left">
                            {splitIntoSentences(item.text).map((sentence, sentenceIndex) => (
                              <Fragment key={`${item.globalIndex}-${sentenceIndex}`}>
                                <span
                                  className={[
                                    activeSpeechSegment?.paragraphIndex === item.globalIndex &&
                                    activeSpeechSegment.sentenceIndex === sentenceIndex
                                      ? 'book-sentence-speaking'
                                      : '',
                                  ].join(' ')}
                                >
                                  {sentence}
                                </span>
                                {' '}
                              </Fragment>
                            ))}
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
            className="pagination-measure mx-auto max-w-4xl"
          >
            <div
              className="book-page min-h-full rounded-sm px-8 py-10 md:px-20 md:py-14"
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
        <footer className="flex-none border-t border-slate-200 bg-white px-3 py-2 md:px-5 md:py-3">
          <div className="mx-auto grid max-w-3xl grid-cols-[1fr_auto_1fr] items-center gap-2">
          <button
            type="button"
            onClick={() => goToPage(-1)}
            disabled={isFirst || !canNavigatePages}
            aria-label="Page précédente"
            className="flex min-h-11 items-center justify-start gap-2 rounded-2xl px-3 py-2 text-sm font-semibold transition-all md:px-4
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:text-stone-700 enabled:hover:bg-stone-100 enabled:active:bg-stone-200"
          >
            <span className="text-lg leading-none">←</span>
            <span className="hidden sm:inline">Page précédente</span>
          </button>

          <div className="rounded-full bg-stone-50 px-3 py-1.5 text-center text-xs font-medium tabular-nums text-stone-500 ring-1 ring-stone-200">
            {canNavigatePages ? `${currentPage + 1} / ${totalPages}` : '...'}
          </div>

          <button
            type="button"
            onClick={() => goToPage(1)}
            disabled={isLast || !canNavigatePages}
            aria-label="Page suivante"
            className="flex min-h-11 items-center justify-end gap-2 rounded-2xl px-3 py-2 text-sm font-semibold transition-all md:px-4
              disabled:opacity-30 disabled:cursor-not-allowed
              enabled:text-stone-700 enabled:hover:bg-stone-100 enabled:active:bg-stone-200"
          >
            <span className="hidden sm:inline">Page suivante</span>
            <span className="text-lg leading-none">→</span>
          </button>
          </div>
        </footer>
      )}
    </div>
  );
}
