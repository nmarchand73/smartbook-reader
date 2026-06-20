# SmartBook Reader

SmartBook Reader is a Next.js app for reading ePub books with AI explanations shown side by side. Upload an `.epub`, move through the book paragraph by paragraph, and the app streams a short contextual explanation for each passage.

The interface is currently in French.

## Features

- Drag-and-drop `.epub` upload with client-side parsing.
- Paragraph-by-paragraph reading experience with previous/next controls and arrow-key navigation.
- Split reader view: original book text on one side, AI explanation on the other.
- Streaming explanations from Anthropic through a Next.js API route.
- Background pre-generation for the next paragraph.
- Local explanation cache so the same paragraph is not requested twice.
- Reading-position persistence per book title.
- Session restore after a page refresh while the parsed ePub remains in browser session storage.

## Tech Stack

- Next.js 15 App Router
- React 19
- TypeScript
- Tailwind CSS
- Anthropic SDK
- JSZip for client-side ePub parsing

## Requirements

- Node.js 20 or newer is recommended.
- An Anthropic API key.

## Getting Started

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Then set your Anthropic API key:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), upload an `.epub`, and start reading.

## Available Scripts

```bash
npm run dev
```

Starts the development server with Turbopack.

```bash
npm run build
```

Builds the production app.

```bash
npm run start
```

Starts the production server after a build.

```bash
npm run lint
```

Runs the Next.js lint command configured for the project.

## How It Works

The home page accepts an `.epub` file and parses it in the browser with `JSZip`. The parser reads `META-INF/container.xml`, locates the OPF package file, follows the spine reading order, extracts chapter titles from the table of contents or headings, and turns readable HTML blocks into paragraph records.

Parsed book data is stored in React context and mirrored to `sessionStorage` so a refresh can restore the current book. Reading position is stored in `localStorage` by book title.

The reader page requests explanations from `/api/explain`. That route validates the request, calls Anthropic with a French reading-companion system prompt, and streams plain text back to the browser. Explanations are cached in `localStorage` using a hash of the book title and paragraph text.

## Project Structure

```text
app/
  api/explain/route.ts   Streaming Anthropic explanation endpoint
  page.tsx               ePub upload screen
  reader/page.tsx        Split reader and explanation UI
context/
  EpubContext.tsx        Current book, navigation, and persistence state
lib/
  epub-parser.ts         Client-side ePub parsing
  cache.ts               Local explanation cache helpers
```

## Notes

- ePub files are parsed locally in the browser. Passage text is sent to the server route only when an explanation is generated.
- The explanation route sends at most the first 2,000 characters of a paragraph to Anthropic.
- Cached explanations and reading positions live in the browser's `localStorage`.
- Uploaded book data is kept in `sessionStorage`, not in a database.