# SmartBook Reader

SmartBook Reader is a French-first ePub and PDF reader with optional AI comments. It is designed for local reading: the book is parsed in the browser, the reading position is saved locally, and comments are generated only when requested.

## What It Does

- Opens `.epub` and text-based `.pdf` files directly in the browser.
- Restores the current position per book.
- Shows recent books with progress and last-read information.
- Supports two reading modes: `Pages` and `Continu`.
- Provides a chapter picker with progress-aware navigation.
- Lets the reader select one paragraph, several paragraphs, or a free text selection.
- Generates AI comments on demand and caches them locally.
- Marks paragraphs that already have a saved comment.
- Works on desktop and mobile with a compact bottom-sheet comment panel.

## AI Configuration

AI comments can work in two ways:

- Locally during development through `/api/explain`, using `ANTHROPIC_API_KEY`.
- In a static GitHub Pages deployment through a local Anthropic key entered in the app.

The in-app key is saved only in the browser's `localStorage`. It is not committed, not bundled, and not stored on a server.

If no key is configured, the reader still works. Only AI comment generation is unavailable.

## Getting Started

Install dependencies:

```bash
npm install
```

Optionally create a local environment file for server-side AI calls:

```bash
cp .env.example .env.local
```

Then set:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
ANTHROPIC_MODEL=claude-sonnet-4-6
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), select an `.epub` or text-based `.pdf`, and start reading.

## Available Scripts

```bash
npm run dev
```

Starts the Next.js development server with Turbopack.

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

Runs the configured Next.js lint command.

## GitHub Pages

The app can be exported as a static site for GitHub Pages. The deploy workflow lives in:

```text
.github/workflows/deploy-pages.yml
```

When `GITHUB_PAGES=true`, `next.config.ts` enables static export settings and uses the `/smartbook-reader` base path.

Because GitHub Pages is static, server routes are not available there. AI comments on GitHub Pages require entering an Anthropic API key in the app's `Clé IA` panel.

## How It Works

The home page accepts `.epub` and text-based `.pdf` files. ePubs are parsed in the browser with `JSZip`: the parser reads `META-INF/container.xml`, locates the OPF package file, follows the spine reading order, resolves table-of-contents titles, and turns readable HTML blocks into paragraph records. PDFs are parsed in the browser with `pdf.js`, then converted into page-based text chunks.

Parsed book data is stored in React context and mirrored to `sessionStorage` so refreshes can restore the loaded book while the session is still available.

Reading position, recent-book metadata, AI settings, font size, reading mode, split position, and cached comments are stored in `localStorage`.

AI comments are generated on demand. Comments are cached using a hash of the book title and selected passage text. Cached paragraphs are marked in the reader and can be reopened without another AI call.

## Project Structure

```text
app/
  api/explain/route.ts       Anthropic explanation endpoint for local/server use
  globals.css                Reader, book, markdown, and loading styles
  page.tsx                   Home page, upload, recent books, AI settings
  reader/page.tsx            Reader UI, pages/continuous modes, comments
config/
  prompts.ts                 System prompt for AI comments
context/
  EpubContext.tsx            Current book, navigation, position persistence
lib/
  cache.ts                   Local AI comment cache helpers
  epub-parser.ts             Client-side ePub parsing
  pdf-parser.ts              Client-side PDF text extraction
  recent-books.ts            Recent-reading metadata in localStorage
```

## Browser Storage

SmartBook Reader stores convenience data in the browser:

- `sessionStorage`: currently loaded parsed book.
- `localStorage`: reading positions, recent books, settings, cache, AI key and model.

Browsers cannot usually reopen a local file automatically after the session is gone. If the parsed book is no longer in `sessionStorage`, the home page asks the reader to reimport the same file.
