import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { COMMENT_CHAT_SYSTEM_PROMPT } from '@/config/prompts';

const client = new Anthropic();
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const MAX_CHAT_OUTPUT_TOKENS = 700;

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

async function parseRequestBody(request: NextRequest): Promise<{
  passage?: string;
  explanation?: string;
  question?: string;
  bookTitle?: string;
  author?: string;
  model?: string;
  messages?: unknown;
} | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'role' in value &&
    (value.role === 'user' || value.role === 'assistant') &&
    'content' in value &&
    typeof value.content === 'string'
  );
}

function buildCommentChatPrompt(options: {
  passage: string;
  explanation: string;
  question: string;
  bookTitle?: string;
  author?: string;
  messages: ChatMessage[];
}): string {
  const contextLines = [
    options.bookTitle ? `- Titre du livre : ${options.bookTitle}` : null,
    options.author ? `- Auteur : ${options.author}` : null,
  ].filter((line): line is string => line !== null);
  const recentMessages = options.messages.slice(-6);
  const conversation = recentMessages.length > 0
    ? recentMessages
      .map(message => `${message.role === 'user' ? 'Lecteur' : 'Assistant'} : ${message.content}`)
      .join('\n\n')
    : 'Aucun échange précédent.';

  return `## Contexte du livre
${contextLines.length > 0 ? contextLines.join('\n') : '- Métadonnées indisponibles'}

## Passage sélectionné
${options.passage.slice(0, 2200)}

## Commentaire initial
${options.explanation.slice(0, 2400)}

## Conversation récente
${conversation}

## Nouvelle question du lecteur
${options.question.slice(0, 1000)}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseRequestBody(request);
    if (!body) {
      return Response.json({ error: 'Corps JSON manquant ou invalide.' }, { status: 400 });
    }

    const {
      passage,
      explanation,
      question,
      bookTitle,
      author,
      model,
      messages,
    } = body;

    if (!passage || typeof passage !== 'string' || passage.trim().length === 0) {
      return Response.json({ error: 'Paramètre "passage" manquant ou vide.' }, { status: 400 });
    }

    if (!explanation || typeof explanation !== 'string' || explanation.trim().length === 0) {
      return Response.json({ error: 'Paramètre "explanation" manquant ou vide.' }, { status: 400 });
    }

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return Response.json({ error: 'Paramètre "question" manquant ou vide.' }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: 'ANTHROPIC_API_KEY non configurée côté serveur.' },
        { status: 500 }
      );
    }

    const chatMessages = Array.isArray(messages)
      ? messages.filter(isChatMessage).slice(-6)
      : [];

    const response = await client.messages.create({
      model: typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL,
      max_tokens: MAX_CHAT_OUTPUT_TOKENS,
      system: COMMENT_CHAT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildCommentChatPrompt({
            passage,
            explanation,
            question,
            bookTitle,
            author,
            messages: chatMessages,
          }),
        },
      ],
    });

    const answer = response.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    if (!answer) {
      return Response.json({ error: 'Réponse Anthropic vide.' }, { status: 502 });
    }

    return Response.json({ answer });
  } catch (err) {
    console.error('[/api/chat]', err);
    return Response.json(
      { error: 'Erreur lors de la réponse de suivi.' },
      { status: 500 }
    );
  }
}
