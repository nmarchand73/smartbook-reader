import type { Paragraph, ParsedEpub } from '@/lib/epub-parser';

const PDF_CHUNK_TARGET_LENGTH = 900;

type PdfTextItem = {
  str: string;
};

type PdfTextContent = {
  items: Array<PdfTextItem | unknown>;
};

function getTitleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'PDF sans titre';
}

function splitTextIntoReadableChunks(text: string): string[] {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
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

export async function parsePdf(file: File): Promise<ParsedEpub> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const title = getTitleFromFileName(file.name);
  const paragraphs: Paragraph[] = [];

  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    const pageNumber = pageIndex + 1;
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent() as PdfTextContent;
    const pageText = textContent.items
      .filter(isPdfTextItem)
      .map(item => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const chunks = splitTextIntoReadableChunks(pageText);

    chunks.forEach((chunk, indexInChapter) => {
      paragraphs.push({
        text: chunk,
        chapterTitle: `Page ${pageNumber}`,
        isSyntheticChapterTitle: false,
        chapterIndex: pageIndex,
        indexInChapter,
        globalIndex: paragraphs.length,
        pageNumber,
      });
    });
  }

  if (paragraphs.length === 0) {
    throw new Error('Impossible d’extraire du texte de ce PDF.');
  }

  return {
    sourceType: 'pdf',
    title,
    author: 'Document PDF',
    paragraphs,
    toc: Array.from({ length: pdf.numPages }, (_, pageIndex) => {
      const firstParagraph = paragraphs.find(paragraph => paragraph.pageNumber === pageIndex + 1);
      return firstParagraph
        ? {
          title: `Page ${pageIndex + 1}`,
          path: `page-${pageIndex + 1}`,
          firstIndex: firstParagraph.globalIndex,
        }
        : null;
    }).filter((item): item is NonNullable<typeof item> => item !== null),
  };
}
