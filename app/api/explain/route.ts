import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { EXPLANATION_SYSTEM_PROMPT } from '@/config/prompts';

const client = new Anthropic();
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 900;

async function parseRequestBody(request: NextRequest): Promise<{
  passage?: string;
  bookTitle?: string;
  author?: string;
  model?: string;
} | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseRequestBody(request);
    if (!body) {
      return Response.json({ error: 'Corps JSON manquant ou invalide.' }, { status: 400 });
    }

    const { passage, bookTitle, author, model } = body as {
      passage?: string;
      bookTitle?: string;
      author?: string;
      model?: string;
    };

    if (!passage || typeof passage !== 'string' || passage.trim().length === 0) {
      return Response.json({ error: 'Paramètre "passage" manquant ou vide.' }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: 'ANTHROPIC_API_KEY non configurée côté serveur.' },
        { status: 500 }
      );
    }

    const contextLines = [
      bookTitle ? `- Titre du livre : ${bookTitle}` : null,
      author ? `- Auteur : ${author}` : null,
    ].filter((line): line is string => line !== null);

    const userContent = [
      `## Contexte du livre
${contextLines.length > 0 ? contextLines.join('\n') : '- Métadonnées indisponibles'}

Utilise ce contexte pour éclairer le passage quand il est pertinent, sans plaquer des généralités sur l'œuvre ou l'auteur.

## Passage à commenter
${passage.slice(0, 2000)}`,
    ].join('');

    const stream = client.messages.stream({
      model: typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: EXPLANATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
        } finally {
          controller.close();
        }
      },
      cancel() {
        stream.controller.abort();
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('[/api/explain]', err);
    return Response.json(
      { error: 'Erreur lors de la génération de l\'explication.' },
      { status: 500 }
    );
  }
}
