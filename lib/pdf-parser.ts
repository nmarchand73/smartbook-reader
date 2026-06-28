import type { EpubTocItem, Paragraph, ParsedEpub } from '@/lib/epub-parser';

const PDF_CHUNK_TARGET_LENGTH = 900;
const MIN_POSITIONED_ITEMS_FOR_LAYOUT = 8;
const MIN_XY_CUT_LINES = 10;
const MIN_XY_CUT_GAP = 18;

type PdfTextItem = {
  str: string;
  dir?: string;
  fontName?: string;
  hasEOL?: boolean;
  width?: number;
  height?: number;
  transform?: number[];
};

type PdfTextContent = {
  items: Array<PdfTextItem | unknown>;
};

type PdfPage = {
  getTextContent(options?: {
    disableNormalization?: boolean;
    includeMarkedContent?: boolean;
  }): Promise<PdfTextContent>;
  getViewport(options: { scale: number }): PdfViewport;
};

type PdfViewport = {
  width: number;
  height: number;
  transform: number[];
};

type PdfOutlineItem = {
  title?: unknown;
  dest?: unknown;
  items?: PdfOutlineItem[];
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata?(): Promise<{
    info?: Record<string, unknown>;
    metadata?: {
      get(name: string): unknown;
    };
  }>;
  getOutline?(): Promise<PdfOutlineItem[] | null>;
  getDestination?(destinationName: string): Promise<unknown[] | null>;
  getPageIndex?(pageReference: unknown): Promise<number>;
};

type PositionedTextItem = {
  text: string;
  dir: string;
  fontName: string | null;
  hasEOL: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  originalIndex: number;
};

type PdfLine = {
  text: string;
  hasEOL: boolean;
  fontNames: string[];
  dir: string;
  xMin: number;
  xMax: number;
  y: number;
  height: number;
  column: number;
};

type ParsedPdfPage = {
  pageNumber: number;
  lines: PdfLine[];
  fallbackText: string;
};

type PdfParagraphBlock = {
  text: string;
  isHeading: boolean;
};

function getTitleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'PDF sans titre';
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePdfFragment(text: string): string {
  const normalizedText = text
    .replace(/\u00a0/g, ' ')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');

  return normalizedText.trim() ? normalizedText : normalizedText.includes(' ') ? ' ' : '';
}

function joinWrappedLine(currentText: string, nextLine: string): string {
  if (!currentText) return nextLine;
  if (currentText.endsWith('-') && /^[a-zà-ÿ]/.test(nextLine)) {
    return `${currentText.slice(0, -1)}${nextLine}`;
  }
  return `${currentText} ${nextLine}`;
}

function splitTextIntoReadableChunks(text: string): string[] {
  const normalizedText = normalizePdfText(text);
  if (!normalizedText) return [];

  const sentences = normalizedText
    .split(/(?<=[.!?…])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let currentChunk = '';

  sentences.forEach(sentence => {
    const nextChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    if (currentChunk && nextChunk.length > PDF_CHUNK_TARGET_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = sentence;
      return;
    }

    currentChunk = nextChunk;
  });

  if (currentChunk) chunks.push(currentChunk);

  if (chunks.length > 0) return chunks;

  return normalizedText.match(/.{1,900}(?:\s|$)/g)?.map(chunk => chunk.trim()).filter(Boolean) ?? [];
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof item.str === 'string'
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function multiplyTransforms(first: number[], second: number[]): number[] {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function toPositionedItems(textContent: PdfTextContent, viewport: PdfViewport): PositionedTextItem[] {
  return textContent.items
    .filter(isPdfTextItem)
    .map((item, originalIndex) => {
      const text = normalizePdfFragment(item.str);
      const transform = item.transform;
      if (!text || !transform || transform.length < 6) return null;

      const viewportTransform = multiplyTransforms(viewport.transform, transform);
      const transformHeight = Math.hypot(viewportTransform[2] ?? 0, viewportTransform[3] ?? 0);
      const height = item.height && item.height > 0 ? item.height : Math.max(1, transformHeight);
      const width = item.width && item.width > 0
        ? item.width
        : Math.max(text.length * height * 0.45, height);
      const top = viewportTransform[5] - height;

      return {
        text,
        dir: item.dir ?? 'ltr',
        fontName: item.fontName ?? null,
        hasEOL: item.hasEOL === true,
        x: viewportTransform[4],
        // Keep higher visual lines numerically larger so the rest of the
        // reading-order code can sort descending by y.
        y: -top,
        width,
        height,
        originalIndex,
      };
    })
    .filter((item): item is PositionedTextItem => item !== null);
}

function renderLine(items: PositionedTextItem[]): string {
  const rtlItems = items.filter(item => item.dir === 'rtl').length;
  const isRtl = rtlItems > items.length / 2;
  const sortedItems = [...items].sort((a, b) => isRtl ? b.x - a.x : a.x - b.x);
  const averageCharacterWidth = median(
    sortedItems.map(item => item.width / Math.max(item.text.length, 1)).filter(Number.isFinite)
  ) || 4;
  let text = '';
  let previousEndX: number | null = null;

  sortedItems.forEach(item => {
    const gap = previousEndX === null ? 0 : item.x - previousEndX;
    const shouldAddSpaceFromGap = gap > Math.max(1.25, averageCharacterWidth * 0.35);

    if (text && shouldAddSpaceFromGap && !text.endsWith(' ') && item.text !== ' ') {
      text += ' ';
    }

    text += item.text;
    previousEndX = item.x + item.width;
  });

  return normalizePdfText(text);
}

function buildLines(items: PositionedTextItem[], pageWidth: number): PdfLine[] {
  if (items.length < MIN_POSITIONED_ITEMS_FOR_LAYOUT) return [];

  const medianHeight = median(items.map(item => item.height).filter(height => height > 0)) || 10;
  const yTolerance = Math.max(2, medianHeight * 0.45);
  const lineBuckets: PositionedTextItem[][] = [];

  [...items]
    .sort((a, b) => Math.abs(b.y - a.y) > yTolerance ? b.y - a.y : a.x - b.x)
    .forEach(item => {
      const existingLine = lineBuckets.find(line => Math.abs(median(line.map(lineItem => lineItem.y)) - item.y) <= yTolerance);
      if (existingLine) {
        existingLine.push(item);
        return;
      }

      lineBuckets.push([item]);
    });

  const rawLines = lineBuckets
    .map(lineItems => {
      const text = renderLine(lineItems);
      if (!text) return null;

      const xMin = Math.min(...lineItems.map(item => item.x));
      const xMax = Math.max(...lineItems.map(item => item.x + item.width));
      const y = median(lineItems.map(item => item.y));
      const fontNames = Array.from(
        new Set(lineItems.map(item => item.fontName).filter((fontName): fontName is string => Boolean(fontName)))
      );
      const rtlItemCount = lineItems.filter(item => item.dir === 'rtl').length;

      return {
        text,
        hasEOL: lineItems.some(item => item.hasEOL),
        fontNames,
        dir: rtlItemCount > lineItems.length / 2 ? 'rtl' : 'ltr',
        xMin,
        xMax,
        y,
        height: median(lineItems.map(item => item.height)) || medianHeight,
        column: 0,
      };
    })
    .filter((line): line is PdfLine => line !== null);

  return orderLinesForReading(rawLines, pageWidth);
}

function orderLinesForReading(lines: PdfLine[], pageWidth: number): PdfLine[] {
  if (lines.length === 0) return [];

  return orderRegionsWithXyCut(lines, pageWidth)
    .flatMap((region, regionIndex) =>
      sortLinesTopToBottom(region.lines).map(line => ({ ...line, column: regionIndex }))
    );
}

function orderRegionsWithXyCut(lines: PdfLine[], pageWidth: number): ReadingRegion[] {
  return splitRegionForReading(lines, pageWidth);
}

type ReadingRegion = {
  lines: PdfLine[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

function getReadingRegion(lines: PdfLine[]): ReadingRegion {
  return {
    lines,
    xMin: Math.min(...lines.map(line => line.xMin)),
    xMax: Math.max(...lines.map(line => line.xMax)),
    yMin: Math.min(...lines.map(line => line.y)),
    yMax: Math.max(...lines.map(line => line.y)),
  };
}

function sortLinesTopToBottom(lines: PdfLine[]): PdfLine[] {
  return [...lines].sort((a, b) => {
    const yTolerance = Math.max(a.height, b.height) * 0.4;
    return Math.abs(b.y - a.y) > yTolerance ? b.y - a.y : a.xMin - b.xMin;
  });
}

function splitRegionForReading(lines: PdfLine[], pageWidth: number): ReadingRegion[] {
  if (lines.length < MIN_XY_CUT_LINES) return [getReadingRegion(lines)];

  const spanningLines = lines.filter(line => (line.xMax - line.xMin) > pageWidth * 0.62);
  const columnCandidateLines = lines.filter(line => (line.xMax - line.xMin) <= pageWidth * 0.62);
  const verticalSplit = findBestVerticalGap(columnCandidateLines);

  if (!verticalSplit) return [getReadingRegion(lines)];

  const topSpanningLines: PdfLine[] = [];
  const bottomSpanningLines: PdfLine[] = [];
  const leftLines: PdfLine[] = [];
  const rightLines: PdfLine[] = [];
  const splitX = verticalSplit.position;

  const columnTopY = Math.max(...columnCandidateLines.map(line => line.y));
  const columnBottomY = Math.min(...columnCandidateLines.map(line => line.y));

  lines.forEach(line => {
    const isSpanning = (line.xMax - line.xMin) > pageWidth * 0.62 || (line.xMin < splitX && line.xMax > splitX);
    if (isSpanning && line.y >= columnTopY) {
      topSpanningLines.push(line);
      return;
    }
    if (isSpanning && line.y <= columnBottomY) {
      bottomSpanningLines.push(line);
      return;
    }
    if (line.xMin >= splitX) {
      rightLines.push(line);
      return;
    }
    leftLines.push(line);
  });

  if (leftLines.length < 4 || rightLines.length < 4) return [getReadingRegion(lines)];

  return [
    ...(topSpanningLines.length > 0 ? [getReadingRegion(topSpanningLines)] : []),
    ...splitRegionForReading(leftLines, pageWidth),
    ...splitRegionForReading(rightLines, pageWidth),
    ...(bottomSpanningLines.length > 0 ? [getReadingRegion(bottomSpanningLines)] : []),
  ];
}

function findBestVerticalGap(lines: PdfLine[]): { position: number; size: number } | null {
  if (lines.length < MIN_XY_CUT_LINES) return null;

  const intervals = lines
    .map(line => ({ start: line.xMin, end: line.xMax }))
    .sort((a, b) => a.start - b.start);
  let currentEnd = intervals[0].end;
  let bestGap: { position: number; size: number } | null = null;

  for (let index = 1; index < intervals.length; index++) {
    const interval = intervals[index];
    const gapSize = interval.start - currentEnd;

    if (gapSize > MIN_XY_CUT_GAP && (!bestGap || gapSize > bestGap.size)) {
      bestGap = {
        position: currentEnd + gapSize / 2,
        size: gapSize,
      };
    }

    currentEnd = Math.max(currentEnd, interval.end);
  }

  return bestGap;
}

function getFallbackPageText(textContent: PdfTextContent): string {
  return normalizePdfText(
    textContent.items
      .filter(isPdfTextItem)
      .map(item => item.str)
      .join(' ')
  );
}

function getRepeatedFurnitureKeys(pages: ParsedPdfPage[]): Set<string> {
  const counts = new Map<string, number>();

  pages.forEach(page => {
    const candidateLines = [
      ...page.lines.slice(0, 3),
      ...page.lines.slice(-3),
    ];
    const pageKeys = new Set(
      candidateLines
        .map(line => getFurnitureKey(line.text))
        .filter((key): key is string => key !== null)
    );

    pageKeys.forEach(key => counts.set(key, (counts.get(key) ?? 0) + 1));
  });

  const threshold = Math.max(3, Math.ceil(pages.length * 0.35));
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([key]) => key)
  );
}

function getFurnitureKey(text: string): string | null {
  const key = normalizePdfText(text)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}# ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (key.length < 4 || key.length > 90) return null;
  return key;
}

function isPageNumberLine(text: string): boolean {
  return /^(?:page\s*)?\d{1,4}$/i.test(normalizePdfText(text));
}

function removePageFurniture(lines: PdfLine[], repeatedKeys: Set<string>): PdfLine[] {
  return lines.filter((line, index) => {
    const isEdgeLine = index < 3 || index >= lines.length - 3;
    if (!isEdgeLine) return true;
    if (isPageNumberLine(line.text)) return false;

    const key = getFurnitureKey(line.text);
    return !key || !repeatedKeys.has(key);
  });
}

function isLikelyHeadingLine(line: PdfLine, medianLineHeight: number): boolean {
  const normalizedText = normalizePdfText(line.text);
  if (!normalizedText || normalizedText.length > 140) return false;
  if (/^(?:page\s*)?\d{1,4}$/i.test(normalizedText)) return false;

  const wordCount = normalizedText.split(/\s+/).length;
  const isShortEnough = wordCount <= 14;
  const isLargeText = line.height >= medianLineHeight * 1.12;
  const hasSentenceEnding = /[.!?…]"?$/.test(normalizedText);
  const looksLikeLabel = /^[\dIVXLCDM]+[.)]\s+/i.test(normalizedText) || /^[A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9\s:,-]{5,}$/.test(normalizedText);

  return isShortEnough && (isLargeText || looksLikeLabel) && !hasSentenceEnding;
}

function splitParagraphBlock(text: string, isHeading: boolean): PdfParagraphBlock[] {
  if (isHeading) {
    return [{ text: normalizePdfText(text), isHeading: true }];
  }

  return splitTextIntoReadableChunks(text).map(chunk => ({
    text: chunk,
    isHeading: false,
  }));
}

function linesToParagraphBlocks(lines: PdfLine[]): PdfParagraphBlock[] {
  if (lines.length === 0) return [];

  const medianLineHeight = median(lines.map(line => line.height).filter(height => height > 0)) || 10;
  const paragraphBlocks: PdfParagraphBlock[] = [];
  let currentText = '';
  let currentIsHeading = false;
  let previousLine: PdfLine | null = null;

  lines.forEach(line => {
    const verticalGap = previousLine ? Math.abs(previousLine.y - line.y) : 0;
    const startsIndented = previousLine ? line.xMin > previousLine.xMin + medianLineHeight * 1.6 : false;
    const fontChanged = previousLine
      ? previousLine.fontNames.join('|') !== line.fontNames.join('|')
      : false;
    const shouldStartParagraph =
      !previousLine ||
      previousLine.column !== line.column ||
      currentIsHeading ||
      isLikelyHeadingLine(line, medianLineHeight) ||
      verticalGap > medianLineHeight * 1.7 ||
      (startsIndented && (previousLine.hasEOL || /[.!?…]"?$/.test(currentText))) ||
      (fontChanged && currentText.length > 80 && /[.!?…]"?$/.test(currentText));

    if (shouldStartParagraph && currentText) {
      paragraphBlocks.push(...splitParagraphBlock(currentText, currentIsHeading));
      currentText = '';
      currentIsHeading = false;
    }

    currentIsHeading = !currentText && isLikelyHeadingLine(line, medianLineHeight);
    currentText = joinWrappedLine(currentText, line.text);
    previousLine = line;
  });

  if (currentText) paragraphBlocks.push(...splitParagraphBlock(currentText, currentIsHeading));

  return paragraphBlocks;
}

function getMetadataValue(metadata: Awaited<ReturnType<NonNullable<PdfDocument['getMetadata']>>> | null, name: string): string | null {
  const infoValue = metadata?.info?.[name];
  const xmpValue = metadata?.metadata?.get(name);
  const value = typeof infoValue === 'string' && infoValue.trim()
    ? infoValue
    : typeof xmpValue === 'string' && xmpValue.trim()
      ? xmpValue
      : null;

  return value ? normalizePdfText(value) : null;
}

async function getPdfMetadata(pdf: PdfDocument): Promise<{ title: string | null; author: string | null }> {
  if (!pdf.getMetadata) return { title: null, author: null };

  try {
    const metadata = await pdf.getMetadata();
    return {
      title: getMetadataValue(metadata, 'Title') ?? getMetadataValue(metadata, 'dc:title'),
      author: getMetadataValue(metadata, 'Author') ?? getMetadataValue(metadata, 'dc:creator'),
    };
  } catch {
    return { title: null, author: null };
  }
}

function flattenOutlineItems(items: PdfOutlineItem[] | null | undefined): PdfOutlineItem[] {
  if (!items) return [];

  return items.flatMap(item => [
    item,
    ...flattenOutlineItems(item.items),
  ]);
}

async function getOutlinePageNumber(pdf: PdfDocument, destination: unknown): Promise<number | null> {
  if (!pdf.getPageIndex) return null;

  const destinationArray = typeof destination === 'string' && pdf.getDestination
    ? await pdf.getDestination(destination)
    : Array.isArray(destination)
      ? destination
      : null;
  const pageReference = destinationArray?.[0];
  if (!pageReference) return null;

  try {
    return (await pdf.getPageIndex(pageReference)) + 1;
  } catch {
    return null;
  }
}

async function buildPdfToc(pdf: PdfDocument, paragraphs: Paragraph[]): Promise<EpubTocItem[]> {
  const fallbackToc = Array.from({ length: pdf.numPages }, (_, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const firstParagraph = paragraphs.find(paragraph => paragraph.pageNumber === pageNumber);

    return firstParagraph
      ? {
        title: `Page ${pageNumber}`,
        path: `page-${pageNumber}`,
        firstIndex: firstParagraph.globalIndex,
      }
      : null;
  }).filter((item): item is EpubTocItem => item !== null);

  if (!pdf.getOutline) return fallbackToc;

  try {
    const outlineItems = flattenOutlineItems(await pdf.getOutline());
    const tocItems: EpubTocItem[] = [];

    for (const item of outlineItems) {
      if (typeof item.title !== 'string' || !item.title.trim()) continue;

      const pageNumber = await getOutlinePageNumber(pdf, item.dest);
      const firstParagraph = pageNumber
        ? paragraphs.find(paragraph => paragraph.pageNumber === pageNumber)
        : null;
      if (!firstParagraph) continue;

      const title = normalizePdfText(item.title);
      if (tocItems.some(tocItem => tocItem.title === title && tocItem.firstIndex === firstParagraph.globalIndex)) {
        continue;
      }

      tocItems.push({
        title,
        path: `page-${pageNumber}`,
        firstIndex: firstParagraph.globalIndex,
      });
    }

    return tocItems.length > 0 ? tocItems : fallbackToc;
  } catch {
    return fallbackToc;
  }
}

export async function parsePdf(file: File): Promise<ParsedEpub> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise as PdfDocument;
  const metadata = await getPdfMetadata(pdf);
  const title = metadata.title ?? getTitleFromFileName(file.name);
  const author = metadata.author ?? 'Document PDF';
  const paragraphs: Paragraph[] = [];
  const parsedPages: ParsedPdfPage[] = [];

  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    const pageNumber = pageIndex + 1;
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent({
      includeMarkedContent: true,
    }) as PdfTextContent;
    const viewport = page.getViewport({ scale: 1 });
    const fallbackText = getFallbackPageText(textContent);
    const lines = buildLines(toPositionedItems(textContent, viewport), viewport.width);

    parsedPages.push({
      pageNumber,
      lines,
      fallbackText,
    });
  }

  const repeatedFurnitureKeys = getRepeatedFurnitureKeys(parsedPages);

  parsedPages.forEach((page, pageIndex) => {
    const linesWithoutFurniture = removePageFurniture(page.lines, repeatedFurnitureKeys);
    const blocks = linesWithoutFurniture.length > 0
      ? linesToParagraphBlocks(linesWithoutFurniture)
      : splitTextIntoReadableChunks(page.fallbackText).map(chunk => ({
        text: chunk,
        isHeading: false,
      }));

    blocks.forEach((block, indexInChapter) => {
      paragraphs.push({
        text: block.text,
        chapterTitle: `Page ${page.pageNumber}`,
        isSyntheticChapterTitle: false,
        chapterIndex: pageIndex,
        indexInChapter,
        globalIndex: paragraphs.length,
        pageNumber: page.pageNumber,
        isHeading: block.isHeading,
      });
    });
  });

  if (paragraphs.length === 0) {
    throw new Error('Impossible d’extraire du texte de ce PDF.');
  }

  return {
    sourceType: 'pdf',
    title,
    author,
    paragraphs,
    toc: await buildPdfToc(pdf, paragraphs),
  };
}
