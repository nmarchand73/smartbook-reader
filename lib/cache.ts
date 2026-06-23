const PREFIX = 'sbr_expl_';
const CHAT_PREFIX = 'sbr_chat_';

export interface CachedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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

export function clearExplanationCache(): number {
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey?.startsWith(PREFIX) || storageKey?.startsWith(CHAT_PREFIX)) {
        keysToDelete.push(storageKey);
      }
    }

    keysToDelete.forEach(storageKey => localStorage.removeItem(storageKey));
    return keysToDelete.length;
  } catch {
    return 0;
  }
}
