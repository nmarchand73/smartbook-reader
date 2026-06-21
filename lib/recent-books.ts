import type { ParsedEpub } from '@/lib/epub-parser';

const RECENT_BOOKS_STORAGE_KEY = 'sbr_recent_books';
const MAX_RECENT_BOOKS = 5;

export interface RecentBook {
  key: string;
  title: string;
  author: string;
  paragraphCount: number;
  currentIndex: number;
  updatedAt: number;
}

export function getBookKey(title: string, author: string): string {
  return `${title}::${author}`;
}

export function getBookKeyFromEpub(epub: ParsedEpub): string {
  return getBookKey(epub.title, epub.author);
}

export function getRecentBooks(): RecentBook[] {
  try {
    const stored = localStorage.getItem(RECENT_BOOKS_STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((book): book is RecentBook =>
        typeof book === 'object' &&
        book !== null &&
        typeof book.key === 'string' &&
        typeof book.title === 'string' &&
        typeof book.author === 'string' &&
        typeof book.paragraphCount === 'number' &&
        typeof book.currentIndex === 'number' &&
        typeof book.updatedAt === 'number'
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_BOOKS);
  } catch {
    return [];
  }
}

export function saveRecentBook(epub: ParsedEpub, currentIndex: number): void {
  try {
    const key = getBookKeyFromEpub(epub);
    const nextBook: RecentBook = {
      key,
      title: epub.title,
      author: epub.author,
      paragraphCount: epub.paragraphs.length,
      currentIndex: Math.max(0, Math.min(currentIndex, epub.paragraphs.length - 1)),
      updatedAt: Date.now(),
    };

    const nextBooks = [
      nextBook,
      ...getRecentBooks().filter(book => book.key !== key),
    ].slice(0, MAX_RECENT_BOOKS);

    localStorage.setItem(RECENT_BOOKS_STORAGE_KEY, JSON.stringify(nextBooks));
  } catch {
    // Recent books are a convenience only.
  }
}
