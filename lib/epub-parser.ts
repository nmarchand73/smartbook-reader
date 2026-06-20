import JSZip from 'jszip';

export interface Paragraph {
  text: string;
  chapterTitle: string;
  chapterIndex: number;
  indexInChapter: number;
  globalIndex: number;
}

export interface ParsedEpub {
  title: string;
  author: string;
  paragraphs: Paragraph[];
}

async function readZipEntry(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path) ?? zip.file(path.replace(/^\//, ''));
  return entry ? entry.async('text') : null;
}

function resolvePath(base: string, relative: string): string {
  const baseDir = base.includes('/') ? base.substring(0, base.lastIndexOf('/') + 1) : '';
  return baseDir + relative;
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
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  if (ncxId && fullManifest[ncxId]) {
    const ncxPath = resolvePath(rootfilePath, fullManifest[ncxId]);
    const ncxContent = await readZipEntry(zip, ncxPath);
    if (ncxContent) {
      const ncx = domParser.parseFromString(ncxContent, 'application/xml');
      ncx.querySelectorAll('navPoint').forEach(nav => {
        const src = (nav.querySelector('content')?.getAttribute('src') ?? '').split('#')[0];
        const label = nav.querySelector('navLabel text')?.textContent?.trim() ?? '';
        if (src && label) tocTitles[src] = label;
      });
    }
  }

  // epub3 nav.xhtml
  const navItem = Array.from(opf.querySelectorAll('manifest item')).find(
    el => el.getAttribute('properties')?.includes('nav')
  );
  if (navItem) {
    const navHref = navItem.getAttribute('href') ?? '';
    const navPath = resolvePath(rootfilePath, navHref);
    const navContent = await readZipEntry(zip, navPath);
    if (navContent) {
      const navDoc = domParser.parseFromString(navContent, 'text/html');
      navDoc.querySelectorAll('nav[epub\\:type="toc"] a, nav a').forEach(a => {
        const href = (a.getAttribute('href') ?? '').split('#')[0];
        const label = a.textContent?.trim() ?? '';
        if (href && label) tocTitles[href] = label;
      });
    }
  }

  // Step 3: Extract paragraphs from each spine item
  const paragraphs: Paragraph[] = [];
  let globalIndex = 0;

  for (let chapterIndex = 0; chapterIndex < spineItems.length; chapterIndex++) {
    const idref = spineItems[chapterIndex];
    const href = manifest[idref];
    const fullPath = resolvePath(rootfilePath, href);

    const htmlContent = await readZipEntry(zip, fullPath) ??
                        await readZipEntry(zip, href);
    if (!htmlContent) continue;

    const tocTitle = tocTitles[href] ?? '';
    const chapterTitle = tocTitle || getChapterTitle(htmlContent, `Chapitre ${chapterIndex + 1}`);

    const texts = extractParagraphs(htmlContent);
    texts.forEach((text, indexInChapter) => {
      paragraphs.push({
        text,
        chapterTitle,
        chapterIndex,
        indexInChapter,
        globalIndex: globalIndex++,
      });
    });
  }

  if (paragraphs.length === 0) {
    throw new Error('Impossible d\'extraire du texte de ce fichier ePub.');
  }

  return { title, author, paragraphs };
}
