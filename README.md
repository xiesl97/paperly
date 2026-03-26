# Paperly

A self-hosted arXiv paper discovery and reading platform — zero infrastructure, fully automated, AI-powered. Every day, new papers are crawled, summarized, and served through GitHub Pages. No server, no database, no cost beyond your LLM API calls.

**Live demo:** [Paperly](https://li-suju.github.io/paperly/index.html)
<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/bb2aae5e-1722-45ca-a0e0-6689306fffc2" />

<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/e1e9e2fa-55fb-411f-91bd-de36c21c77fe" />

<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/ea9f9d85-d619-4098-a0ff-da9fd790b1e4" />

<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/9ef8b2bf-021e-4a27-82c1-56d2a9b15bcf" />


<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/8776584d-5e2a-4ace-a35f-fde2c46b0d38" />

<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/e1145cdd-26ff-47c0-94d1-242c934b609b" />


<img width="1352" height="759" alt="image" src="https://github.com/user-attachments/assets/70499110-8e45-4023-a1d3-1f4a17bff250" />

---

## Acknowledgement

This project is forked from [dw-dengwei/daily-arXiv-ai-enhanced](https://github.com/dw-dengwei/daily-arXiv-ai-enhanced), which provides the original Scrapy-based crawling pipeline, AI summarization, and GitHub Actions deployment architecture. Many thanks to [@dw-dengwei](https://github.com/dw-dengwei) and [all contributors](https://github.com/dw-dengwei/daily-arXiv-ai-enhanced#contributors) of the upstream project.

This fork adds substantial frontend features on top of the original foundation: a full AI Digest system, topic subscriptions with server-side generation, multi-select prompt presets, interactive paper modals with clickable citations, a slide-in settings panel, and various UX improvements described below.

> [!CAUTION]
> If your jurisdiction has censorship or data-compliance requirements for academic content, run this code with care. Any redistribution must fulfill applicable content-review obligations. See the [upstream project's caution notice](https://github.com/dw-dengwei/daily-arXiv-ai-enhanced#readme) for details.

---

## How It Works (Architecture Overview)

```
GitHub Actions (1:30 AM UTC)          GitHub Actions (7:00 AM UTC)
┌─────────────────────────────┐       ┌──────────────────────────────┐
│  run.yml                    │       │  generate-digests.yml        │
│  1. Scrape arXiv (Scrapy)   │       │  1. Load subscription topics │
│  2. Deduplicate vs 7 days   │       │  2. Fetch today's papers     │
│  3. AI-enrich each paper    │       │  3. Match papers by keywords │
│  4. Convert to Markdown     │       │  4. Call LLM → digest JSON   │
│  5. Inject repo config      │       │  5. Write to data branch     │
│  6. Push code → main        │       └──────────────────────────────┘
│  7. Push data → data branch │
└─────────────────────────────┘
         │                                       │
         ▼                                       ▼
   main branch                           data branch
   (code + config)                  (JSONL files + digests)
         │
         ▼
   GitHub Pages → Browser
   (static site, all logic client-side)
```

Data and code are stored in **two separate branches**:
- `main` — HTML, CSS, JavaScript, workflow definitions, and configuration files served by GitHub Pages
- `data` — Paper JSONL files (`data/YYYY-MM-DD.jsonl`), file index (`assets/file-list.txt`), and server-generated digests (`daily-digests/YYYY-MM-DD.json`)

The browser fetches paper data directly from the `data` branch via raw GitHub URLs, keeping the Pages-served code clean and small.

---

## Features

### Automated Daily Paper Pipeline

The `run.yml` workflow runs every day at 1:30 AM UTC:

1. **Scrapes arXiv** using Scrapy, pulling from whichever categories you configure (default: `cs.CV, cs.GR, cs.CL, cs.AI`).
2. **Intelligent deduplication** — compares today's crawl against the past 7 days of stored papers. If all papers have already been seen, the rest of the workflow is skipped entirely, avoiding redundant AI calls and commits.
3. **AI enrichment** — each new paper is sent to your configured LLM (DeepSeek, GPT-4o-mini, or any OpenAI-compatible API) for structured summarization: TL;DR, Motivation, Method, Result, and Conclusion.
4. **Markdown conversion** — JSONL is converted to formatted Markdown files alongside the raw data.
5. **Config injection** — the workflow dynamically injects your repo owner and name into `data-config.js` and your password SHA-256 hash into `auth-config.js`, so forked copies work without any manual code edits.
6. **Dual-branch commit** — code changes go to `main`; paper data goes to the `data` branch. Each push retries up to 3 times with automatic pull-and-rebase to handle concurrent runs gracefully.

### Server-Generated Topic Digests

The `generate-digests.yml` workflow runs every day at 7:00 AM UTC:

1. Reads your subscribed topics from `subscription-topics.json` on the data branch.
2. Fetches the latest papers and keyword-matches them against each topic.
3. Calls the LLM with a journalist-style prompt to generate a thematic digest with named sections, inline paper citations (`[1]`, `[2]`, ...), and a Key Takeaways section.
4. Writes the result as `daily-digests/YYYY-MM-DD.json` to the data branch via the GitHub Contents API.

Server-generated digests are available to all visitors without requiring them to configure their own API key.

### Paper Discovery and Filtering

- **Date navigation** — use the arrow buttons in the navbar or click the date to open a calendar. Supports single date, date range, and multi-date selection.
- **Category filter** — filter papers by arXiv category tabs.
- **Full-text search** — client-side search with Lunr.js, indexed across titles, abstracts, and AI summaries. Results update as you type.
- **Custom topic tags** — define your own research interests (e.g. "diffusion models", "RLHF"). Papers matching each topic are highlighted and can be filtered.
- **Topic word refinement** — drill into any topic tag to see which keywords matched, and toggle individual words on/off with AND/OR logic between them.
- **Grid / List view** — toggle between a card grid and compact list layout.

### Paper Modal

Click any paper to open a full-detail modal:

- AI-generated sections: TL;DR, Motivation, Method, Result, Conclusion
- Full abstract with keyword highlights
- Links to the arXiv abstract page and PDF
- Inline PDF preview (expandable)
- Left/Right arrow key navigation between papers in the current filtered list
- **Clickable citations** — references shown in AI digest text are links that open the corresponding paper in the modal, fetching the full paper object from the data branch if needed

### AI Analysis with Custom Prompt Presets

Each paper has a "Generate AI Analysis" button that calls your configured LLM directly from the browser. The prompt is customizable:

- **Save as preset** — type an additional instruction and save it. Saved presets persist across sessions in `localStorage`.
- **Multi-select** — multiple presets can be active at once; they are combined and appended to the base prompt. Toggle presets on/off by clicking their chips.
- **One-off instructions** — type in the textarea without saving for a one-time custom request.
- **Delete presets** — remove any saved preset with the × button on its chip.

The same preset system is available in both the paper modal and the on-demand AI Digest modal.

### AI Digest (Browser-Side, On Demand)

In addition to server-generated digests, you can generate a digest on demand directly from the browser:

- Click the star button (bottom-right corner) to open the digest modal
- All currently filtered papers are shown as cards; individual papers can be excluded by clicking the exclude toggle
- The fixed base prompt (journalist-style, technically detailed) is shown for reference
- Add your own additional instructions via the preset system or the textarea
- Click **Generate Digest** — the LLM generates a full markdown digest with thematic sections and inline citations
- The result renders as formatted HTML with clickable `[1]`, `[2]` references that open individual paper modals
- Digests can be saved and renamed; the Saved Digests panel lists them all

### Settings Panel

A slide-in panel (gear icon, top-right) lets you configure everything without leaving the page:

- **AI API** — base URL, API key, and model name (any OpenAI-compatible endpoint)
- **GitHub Token** — a personal access token with write access to your repository. Required for saving AI-generated summaries back to the data branch and for managing topic subscriptions. Without it, AI analysis is generated but not persisted — it will be lost on page reload.
- **Topics** — add, rename, or delete research topic tags and manage their keyword sets

All settings are stored in `localStorage` in your browser. Nothing is transmitted except to your AI endpoint and the GitHub API.

### Optional Password Protection

Set `ACCESS_PASSWORD` in your repository Secrets. The workflow hashes it with SHA-256 and injects it into `auth-config.js` at build time. Visitors must enter the correct password to access the site. The check happens entirely in the browser.

---

## Quick Start

### 1. Fork and enable Actions

1. Fork this repository to your own GitHub account.
2. Go to your fork → **Settings** → **Actions** → **General** → set **Workflow permissions** to "Read and write permissions".

### 2. Set repository Secrets

Go to **Settings** → **Secrets and variables** → **Actions** → **Secrets** and add:

| Secret | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | API key for paper summarization |
| `OPENAI_BASE_URL` | Yes | Base URL for paper summarization (e.g. `https://api.deepseek.com/v1`) |
| `AI_API_KEY` | Yes | API key for digest generation (can be the same value) |
| `AI_BASE_URL` | Yes | Base URL for digest generation (can be the same value) |
| `AI_MODEL` | Yes | Model name for digest generation (e.g. `deepseek-chat`) |
| `ACCESS_PASSWORD` | No | Password to protect your site. Omit for public access. |

### 3. Set repository Variables

Go to **Settings** → **Secrets and variables** → **Actions** → **Variables** and add:

| Variable | Example | Description |
|---|---|---|
| `CATEGORIES` | `cs.CV, cs.CL, cs.AI` | Comma-separated arXiv categories to crawl |
| `LANGUAGE` | `English` | Language for AI summaries |
| `MODEL_NAME` | `deepseek-chat` | LLM model for paper summarization |
| `EMAIL` | `you@example.com` | Git author email for workflow commits |
| `NAME` | `Your Name` | Git author name for workflow commits |

### 4. Run the workflow manually

Go to **Actions** → **arXiv-daily-ai-enhanced** → **Run workflow**. The first run crawls today's papers, summarizes them with your LLM, and pushes everything to the `main` and `data` branches. Expect 30–60 minutes depending on paper count and API latency.

### 5. Enable GitHub Pages

Go to **Settings** → **Pages** and set:
- **Source**: Deploy from a branch
- **Branch**: `main`, `/ (root)`

After a few minutes your site will be live at `https://<your-username>.github.io/daily-arXiv-ai-enhanced/`.

### 6. Configure topic subscriptions (optional)

To enable server-generated daily digests:

1. Switch to your `data` branch and create `subscription-topics.json`:
   ```json
   ["diffusion models", "large language models", "3D gaussian splatting"]
   ```
2. Commit and push it to the `data` branch.
3. The digest workflow will run at 7 AM UTC and generate a digest for each topic that has matching papers today.

You can also manage topics from the Settings panel in the UI, which saves your topic list to the data branch automatically.

---

## User Guide

### Browsing Papers

- Use the **← →** buttons in the navbar to step through dates, or click the date to open the calendar picker. Click for a single day, drag for a range, or Ctrl/Cmd-click for multiple dates.
- Click a **category chip** to show only papers from that arXiv category.
- Type in the **search box** to filter by keyword across titles, abstracts, and AI summaries.
- Click a **topic tag** to filter papers matching your research interest. Click the tag again to expand its keyword list and toggle individual words on or off.
- Toggle between **grid** and **list** layouts with the view button in the toolbar.

### Reading a Paper

- Click any paper card to open the detail modal.
- If the paper has been AI-summarized, the sections (TL;DR, Motivation, Method, Result, Conclusion) appear immediately.
- If not, click **Generate AI Analysis** — enter your API key in Settings first (one-time setup).
- Click **Edit prompt** to customize the generation. Type a new instruction and click **Save as preset** to reuse it later, or just type and generate without saving.
- Use **← →** arrow keys to navigate to adjacent papers in the current filtered list.

### Using the AI Digest

**Server-generated digest (requires topic subscriptions):**

A "Today's Digest" section appears at the top when server-generated digests are available. Click a topic to read the full digest. Paper references `[1]`, `[2]`, etc. are clickable — they open the corresponding paper detail modal.

**On-demand digest from the browser:**

1. Filter the paper list to the papers you want to digest.
2. Click the **star button** (bottom-right corner).
3. Exclude any papers you don't want included by toggling them off in the modal.
4. Select prompt presets or type a one-off instruction to guide the style or focus.
5. Click **Generate Digest**. The result streams in as formatted markdown.
6. Click **Save digest** to store it. Access saved digests from the bookmarks icon in the navbar.

### First-Time Setup in the Browser

1. Click the **gear icon** (top-right) to open Settings.
2. Under **AI Settings**, enter your API base URL, API key, and model name.
3. Add a **GitHub Token** with write access to your repository (see [GitHub Token](#github-token) below). This is needed to save AI summaries and topic subscriptions back to the data branch.
4. Under **Topics**, add research topics like "vision transformer" or "protein folding". The system will highlight matching papers and enable per-topic filtering.

---

## GitHub Token

A GitHub personal access token is required for any operation that writes to your repository from the browser:

- **Saving AI-generated summaries** — when you click "Generate AI Analysis" on a paper, the result is written back to the JSONL file on the `data` branch so it is available to all visitors and persists across page reloads.
- **Managing topic subscriptions** — adding or removing topics in the Settings panel writes `subscription-topics.json` to the `data` branch.
- **Deleting saved digests** — removing a server-generated digest from the UI sends a delete request to the GitHub Contents API.

Without a token these actions still work locally in your session, but nothing is persisted to the repository.

### How to create a fine-grained personal access token (recommended)

Fine-grained tokens give the minimum required permissions:

1. Go to **GitHub** → your avatar (top-right) → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**.
2. Click **Generate new token**.
3. Set a **Token name** (e.g. `daily-arxiv-browser`).
4. Under **Expiration**, choose a duration or select "No expiration".
5. Under **Repository access**, select **Only select repositories** and choose your fork of this repo.
6. Under **Permissions** → **Repository permissions**, set **Contents** to **Read and write**.
7. Click **Generate token** and copy the token immediately (it is only shown once).
8. Paste it into the **GitHub Token** field in the site's Settings panel.

### How to create a classic personal access token (alternative)

1. Go to **GitHub** → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Set a note (e.g. `daily-arxiv-browser`) and an expiration.
4. Under **Select scopes**, check **`public_repo`** (for a public repository) or **`repo`** (for a private repository).
5. Click **Generate token** and copy it.
6. Paste it into the **GitHub Token** field in the site's Settings panel.

> The token is stored only in your browser's `localStorage` and is sent only to the GitHub API (`api.github.com`). It is never sent to your AI provider or anywhere else.

---

## Supported LLM Providers

Any OpenAI-compatible API works:

| Provider | Base URL | Recommended Model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Other compatible | your endpoint | your model |

DeepSeek is recommended for cost — paper summarization costs roughly 0.2 CNY/day.

---

## Tech Stack

**Backend (GitHub Actions)**
- Python + Scrapy — arXiv crawling
- LangChain + OpenAI-compatible API — paper AI enrichment
- `requests` — digest generation and GitHub API writes

**Frontend (static, no framework)**
- Vanilla JavaScript
- [Lunr.js](https://lunrjs.com/) — client-side full-text search
- [flatpickr](https://flatpickr.js.org/) — date picker
- CSS3 with custom properties — theming and layout

**Infrastructure**
- GitHub Actions — free-tier scheduled execution
- GitHub Pages — free static hosting
- `data` branch — paper and digest persistence
- `localStorage` / `sessionStorage` — user preferences and session state

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
