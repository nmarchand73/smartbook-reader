import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const client = new Anthropic();

const SYSTEM_PROMPT = `Tu es un compagnon de lecture érudit et bienveillant.
Ton rôle est d'éclairer les passages d'un livre pour aider le lecteur à les comprendre en profondeur.

Pour chaque passage, fournis une explication concise (80 à 120 mots) qui couvre, selon ce qui est pertinent :
- Le contexte historique, philosophique ou culturel
- Les références, allusions ou intertextualité
- Le vocabulaire complexe ou les concepts abstraits
- Le sous-texte, les thèmes ou les implications
- La voix narrative ou la perspective de l'auteur

Réponds dans la même langue que le passage. Sois direct, informatif et accessible.
N'en fais pas un résumé — éclaire et enrichis. Ne commence pas par "Ce passage..." ou "L'auteur...".`;

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
      model: 'claude-sonnet-4-6',
      max_tokens: 350,
      system: SYSTEM_PROMPT,
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
