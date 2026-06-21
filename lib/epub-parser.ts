import JSZip from 'jszip';

export interface Paragraph {
  text: string;
  chapterTitle: string;
  isSyntheticChapterTitle: boolean;
  chapterIndex: number;
  indexInChapter: number;
  globalIndex: number;
}

export interface EpubTocItem {
  title: string;
  path: string;
  firstIndex: number;
}

export interface ParsedEpub {
  title: string;
  author: string;
  paragraphs: Paragraph[];
  toc?: EpubTocItem[];
}

async function readZipEntry(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path) ?? zip.file(path.replace(/^\//, ''));
  return entry ? entry.async('text') : null;
}

function resolvePath(base: string, relative: string): string {
  const baseDir = base.includes('/') ? base.substring(0, base.lastIndexOf('/') + 1) : '';
  return baseDir + relative;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  path.split('/').forEach(part => {
    if (!part || part === '.') return;
    if (part === '..') {
      parts.pop();
      return;
    }
    parts.push(part);
  });
  return parts.join('/');
}

function pathWithoutFragment(path: string): string {
  return path.split('#')[0];
}

function titleFromHref(href: string): string | null {
  const fileName = href.split('/').pop() ?? '';
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const readable = decodeURIComponent(withoutExtension).trim();

  // Many ePubs use internal file names like "part0007.xhtml"; never expose
  // those implementation details as reader-facing chapter names.
  if (/^(part|chapter|chap|section|text|x?html)?[-_\s]*\d+$/i.test(readable)) {
    return null;
  }

  const normalized = readable
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

function addTocItem(
  tocItems: Array<Omit<EpubTocItem, 'firstIndex'>>,
  sourcePath: string,
  rawHref: string,
  rawTitle: string
): void {
  const href = pathWithoutFragment(rawHref);
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!href || !title) return;

  const path = normalizePath(resolvePath(sourcePath, href));
  if (tocItems.some(item => item.path === path)) return;

  tocItems.push({ title, path });
}

function extractParagraphs(html: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove script, style, and nav elements
  doc.querySelectorAll('script, style, nav, aside').forEach(el => el.remove());

  const results: string[] = [];

  // Prefer explicit paragraph tags
  const pElements = doc.querySelectorAll('p');
  if (pElements.length >= 3) {
    pElements.forEach(el => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length >= 40) results.push(text);
    });
    return results;
  }

  // Fallback: any block-level element with enough text
  doc.querySelectorAll('div, section, article, blockquote').forEach(el => {
    // Only pick leaf-ish nodes (not containers with many child blocks)
    const blockChildren = el.querySelectorAll('div, section, article, p').length;
    if (blockChildren > 2) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) results.push(text);
  });

  if (results.length > 0) return results;

  // Last resort: split body text by line breaks
  const body = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (body.length >= 40) return [body];

  return [];
}

function getChapterTitle(html: string, fallback: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return (
    doc.querySelector('h1, h2, h3')?.textContent?.trim() ?? fallback
  );
}

export async function parseEpub(file: File): Promise<ParsedEpub> {
  const buffer = await file.arrayBuffer();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('Fichier ePub invalide ou corrompu.');
  }

  // Step 1: Find OPF via container.xml
  const containerXml = await readZipEntry(zip, 'META-INF/container.xml');
  if (!containerXml) throw new Error('ePub invalide : META-INF/container.xml manquant.');

  const domParser = new DOMParser();
  const container = domParser.parseFromString(containerXml, 'application/xml');
  const rootfilePath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfilePath) throw new Error('ePub invalide : chemin du fichier OPF introuvable.');

  // Step 2: Parse OPF
  const opfContent = await readZipEntry(zip, rootfilePath);
  if (!opfContent) throw new Error('ePub invalide : fichier OPF manquant.');

  const opf = domParser.parseFromString(opfContent, 'application/xml');

  const title = opf.querySelector('title')?.textContent?.trim() ?? 'Titre inconnu';
  const author = opf.querySelector('creator')?.textContent?.trim() ?? 'Auteur inconnu';

  // Build manifest (id → relative href)
  const manifest: Record<string, string> = {};
  opf.querySelectorAll('manifest item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') ?? '';
    if (id && href && (mediaType.includes('html') || mediaType.includes('xhtml'))) {
      manifest[id] = href;
    }
  });

  // Build full manifest (including non-html, for toc lookup)
  const fullManifest: Record<string, string> = {};
  opf.querySelectorAll('manifest item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) fullManifest[id] = href;
  });

  // Get reading order from spine
  const spineItems = Array.from(opf.querySelectorAll('spine itemref'))
    .map(ref => ref.getAttribute('idref'))
    .filter((id): id is string => !!id && !!manifest[id]);

  if (spineItems.length === 0) {
    throw new Error('ePub invalide : aucun chapitre trouvé dans le spine.');
  }

  // Optional: collect NCX/nav titles
  const tocTitles: Record<string, string> = {};
  const tocItems: Array<Omit<EpubTocItem, 'firstIndex'>> = [];
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  if (ncxId && fullManifest[ncxId]) {
    const ncxPath = normalizePath(resolvePath(rootfilePath, fullManifest[ncxId]));
    const ncxContent = await readZipEntry(zip, ncxPath);
    if (ncxContent) {
      const ncx = domParser.parseFromString(ncxContent, 'application/xml');
      ncx.querySelectorAll('navPoint').forEach(nav => {
        const src = pathWithoutFragment(nav.querySelector('content')?.getAttribute('src') ?? '');
        const label = nav.querySelector('navLabel text')?.textContent?.trim() ?? '';
        if (src && label) {
          const normalizedPath = normalizePath(resolvePath(ncxPath, src));
          tocTitles[src] = label;
          tocTitles[normalizedPath] = label;
          addTocItem(tocItems, ncxPath, src, label);
        }
      });
    }
  }

  // epub3 nav.xhtml
  const navItem = Array.from(opf.querySelectorAll('manifest item')).find(
    el => el.getAttribute('properties')?.includes('nav')
  );
  if (navItem) {
    const navHref = navItem.getAttribute('href') ?? '';
    const navPath = normalizePath(resolvePath(rootfilePath, navHref));
    const navContent = await readZipEntry(zip, navPath);
    if (navContent) {
      const navDoc = domParser.parseFromString(navContent, 'text/html');
      const navLinks = navDoc.querySelectorAll(
        'nav[epub\\:type="toc"] a, nav[type="toc"] a, nav a'
      );
      navLinks.forEach(a => {
        const href = pathWithoutFragment(a.getAttribute('href') ?? '');
        const label = a.textContent?.trim() ?? '';
        if (href && label) {
          const normalizedPath = normalizePath(resolvePath(navPath, href));
          tocTitles[href] = label;
          tocTitles[normalizedPath] = label;
          addTocItem(tocItems, navPath, href, label);
        }
      });
    }
  }

  // Step 3: Extract paragraphs from each spine item
  const paragraphs: Paragraph[] = [];
  const firstParagraphIndexByPath: Record<string, number> = {};
  let globalIndex = 0;

  for (let chapterIndex = 0; chapterIndex < spineItems.length; chapterIndex++) {
    const idref = spineItems[chapterIndex];
    const href = manifest[idref];
    const fullPath = normalizePath(resolvePath(rootfilePath, href));

    const htmlContent = await readZipEntry(zip, fullPath) ??
                        await readZipEntry(zip, href);
    if (!htmlContent) continue;

    const tocTitle = tocTitles[fullPath] ?? tocTitles[href] ?? '';
    const fallbackTitle = titleFromHref(href);
    const isSyntheticChapterTitle = !tocTitle && !fallbackTitle;
    const chapterTitle = tocTitle || getChapterTitle(htmlContent, fallbackTitle ?? 'Section sans titre');

    const texts = extractParagraphs(htmlContent);
    if (texts.length > 0) {
      firstParagraphIndexByPath[fullPath] = globalIndex;
      firstParagraphIndexByPath[href] = globalIndex;
    }
    texts.forEach((text, indexInChapter) => {
      paragraphs.push({
        text,
        chapterTitle,
        isSyntheticChapterTitle,
        chapterIndex,
        indexInChapter,
        globalIndex: globalIndex++,
      });
    });
  }

  if (paragraphs.length === 0) {
    throw new Error('Impossible d\'extraire du texte de ce fichier ePub.');
  }

  const toc = tocItems
    .map(item => ({
      ...item,
      firstIndex: firstParagraphIndexByPath[item.path],
    }))
    .filter((item): item is EpubTocItem => Number.isFinite(item.firstIndex));

  return { title, author, paragraphs, toc };
}
