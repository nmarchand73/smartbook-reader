const PREFIX = 'sbr_expl_';
const CHAT_PREFIX = 'sbr_chat_';
const COMMENT_INDEX_PREFIX = 'sbr_comment_index_';

export interface CachedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface CachedCommentIndexItem {
  paragraphIndex: number | null;
  paragraphIndexes: number[];
  chapterTitle: string;
  excerpt: string;
  text: string;
  updatedAt: number;
}

function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // keep as unsigned 32-bit
  }
  return h.toString(36);
}

function key(bookTitle: string, text: string): string {
  return PREFIX + hash(bookTitle + '\x00' + text);
}

function chatKey(bookTitle: string, text: string): string {
  return CHAT_PREFIX + hash(bookTitle + '\x00' + text);
}

function commentIndexKey(bookTitle: string): string {
  return COMMENT_INDEX_PREFIX + hash(bookTitle);
}

export function getCachedExplanation(bookTitle: string, text: string): string | null {
  try {
    return localStorage.getItem(key(bookTitle, text));
  } catch {
    return null;
  }
}

export function setCachedExplanation(bookTitle: string, text: string, explanation: string): void {
  try {
    localStorage.setItem(key(bookTitle, text), explanation);
  } catch {
    // Quota exceeded — silently skip caching
  }
}

export function getCachedCommentChat(bookTitle: string, text: string): CachedChatMessage[] {
  try {
    const stored = localStorage.getItem(chatKey(bookTitle, text));
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((message): message is CachedChatMessage =>
      typeof message === 'object' &&
      message !== null &&
      typeof message.id === 'string' &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string'
    );
  } catch {
    return [];
  }
}

export function setCachedCommentChat(
  bookTitle: string,
  text: string,
  messages: CachedChatMessage[]
): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(chatKey(bookTitle, text));
      return;
    }

    localStorage.setItem(chatKey(bookTitle, text), JSON.stringify(messages));
  } catch {
    // Chat history is a convenience only.
  }
}

export function getCachedCommentIndex(bookTitle: string): CachedCommentIndexItem[] {
  try {
    const stored = localStorage.getItem(commentIndexKey(bookTitle));
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is CachedCommentIndexItem =>
        typeof item === 'object' &&
        item !== null &&
        (typeof item.paragraphIndex === 'number' || item.paragraphIndex === null) &&
        Array.isArray(item.paragraphIndexes) &&
        item.paragraphIndexes.every((index: unknown) => typeof index === 'number') &&
        typeof item.chapterTitle === 'string' &&
        typeof item.excerpt === 'string' &&
        typeof item.text === 'string' &&
        typeof item.updatedAt === 'number'
      )
      .sort((a, b) => a.paragraphIndexes[0] - b.paragraphIndexes[0]);
  } catch {
    return [];
  }
}

export function rememberCachedComment(
  bookTitle: string,
  item: CachedCommentIndexItem
): CachedCommentIndexItem[] {
  try {
    const existingItems = getCachedCommentIndex(bookTitle);
    const nextItems = [
      item,
      ...existingItems.filter(existingItem => existingItem.text !== item.text),
    ].sort((a, b) => a.paragraphIndexes[0] - b.paragraphIndexes[0]);

    localStorage.setItem(commentIndexKey(bookTitle), JSON.stringify(nextItems));
    return nextItems;
  } catch {
    return getCachedCommentIndex(bookTitle);
  }
}

export function clearExplanationCache(): number {
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (
        storageKey?.startsWith(PREFIX) ||
        storageKey?.startsWith(CHAT_PREFIX) ||
        storageKey?.startsWith(COMMENT_INDEX_PREFIX)
      ) {
        keysToDelete.push(storageKey);
      }
    }

    keysToDelete.forEach(storageKey => localStorage.removeItem(storageKey));
    return keysToDelete.length;
  } catch {
    return 0;
  }
}
