const PREFIX = 'sbr_expl_';

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

export function clearExplanationCache(): number {
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey?.startsWith(PREFIX)) keysToDelete.push(storageKey);
    }

    keysToDelete.forEach(storageKey => localStorage.removeItem(storageKey));
    return keysToDelete.length;
  } catch {
    return 0;
  }
}
