import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { EXPLANATION_SYSTEM_PROMPT } from '@/config/prompts';

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { passage, bookTitle, author } = body as {
      passage?: string;
      bookTitle?: string;
      author?: string;
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

    const userContent = [
      bookTitle && author ? `Livre : « ${bookTitle} » — ${author}\n\n` : '',
      `Passage :\n${passage.slice(0, 2000)}`,
    ].join('');

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 350,
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
