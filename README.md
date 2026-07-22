# Game Research AI

Game Research AI is a deployable personal research copilot for game designers. It discovers current coverage with Tavily, extracts source content with Firecrawl, and uses one OpenAI strategic synthesis pass to turn the verified evidence into practical design direction.

No API key is sent to or stored in the frontend.

## Features

- Premium responsive dashboard built with plain HTML, CSS, and ES6 JavaScript.
- Research controls for categories, language (English or Vietnamese), and 8/12/20-source depth.
- Live pipeline progress over a streamed Worker response.
- Tavily discovery, URL deduplication, Firecrawl full-text extraction, and one source-grounded OpenAI synthesis.
- A concise briefing with design patterns, market signals, indie/mobile opportunities, experiments, hype risks, outlook, action plan, and verified sources.
- Safe built-in Markdown rendering, copy, Markdown download, browser PDF export, retry, errors, and persistent dark/light appearance.

## Folder structure

```text
.
├── index.html              # Static GitHub Pages frontend
├── style.css               # Responsive visual system and print styles
├── script.js               # UI state, streamed client, Markdown renderer
├── README.md
└── workers
    ├── worker.js           # Cloudflare Worker API and research orchestration
    └── wrangler.toml       # Worker deployment configuration
```

## Prerequisites

- A Cloudflare account and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
- An OpenAI API key with access to the configured model. The Worker defaults to `gpt-5.5`; change `OPENAI_MODEL` if your organization uses a different supported model.
- A Tavily API key.
- A Firecrawl API key.

## Run locally

1. Serve the static frontend from the project root:

   ```bash
   npx serve .
   ```

   The checked-in `ALLOWED_ORIGINS` already includes the standard local ports `3000` and `8000`.

2. In another terminal, authenticate Wrangler and configure the Worker secrets:

   ```bash
   cd workers
   npx wrangler login
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   npx wrangler secret put FIRECRAWL_API_KEY
   ```

3. Start the Worker:

   ```bash
   npx wrangler dev
   ```

4. Open the frontend and select **Connect Worker** in the header. Paste the URL shown by Wrangler, then select **Save and test**. The URL is saved only in that browser; no API keys are ever stored in the frontend.

## Deploy the Cloudflare Worker

1. Update `workers/wrangler.toml`:

   - Set `ALLOWED_ORIGINS` to your GitHub Pages origin, for example `https://your-account.github.io`.
   - Keep `RESEARCH_MAX_ARTICLES` at a safe usage limit for your budget. It can be lower than the UI's selected depth.
   - Optionally change `OPENAI_MODEL`.

2. Configure the three secrets (the commands only save them in Cloudflare):

   ```bash
   cd workers
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   npx wrangler secret put FIRECRAWL_API_KEY
   ```

3. Deploy:

   ```bash
   npx wrangler deploy
   ```

4. Copy the Worker URL Wrangler prints. On the deployed site, select **Connect Worker**, paste the URL, and select **Save and test**. For a shared fixed configuration, set `window.GAME_RESEARCH_API_URL` before loading `script.js`.

The `/health` endpoint confirms that the Worker is reachable. It never reveals whether individual secrets are valid.

## Deploy the frontend to GitHub Pages

1. Create a Git repository in this project and push it to GitHub.
2. In GitHub, open **Settings → Pages**.
3. Select **Deploy from a branch**, then choose the branch and `/ (root)` folder.
4. Save. GitHub publishes the static root files at `https://<account>.github.io/<repository>/`.
5. Add the exact Pages origin (normally `https://<account>.github.io`) to `ALLOWED_ORIGINS`, redeploy the Worker, and set its URL in `script.js`.

## API and execution notes

- `quick`, `normal`, and `deep` target 8, 12, and 20 articles. `RESEARCH_MAX_ARTICLES` is an intentional server-side safety limit.
- Every run uses one OpenAI synthesis request, instead of per-article OpenAI calls. Start with `quick` while validating credentials and budget.
- Individual unreadable or paywalled sources are skipped; the report is generated from successfully extracted articles only.
- The Worker uses CORS origin allowlisting. Do not use `*` for a production SaaS frontend.
- There is no user authentication, billing, durable rate limiting, persistence, or job queue in this starter. Add Cloudflare Access/auth, Durable Objects/KV/D1, and a queue before exposing the Worker publicly at scale.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Worker secret | Authorizes OpenAI analysis requests. |
| `TAVILY_API_KEY` | Worker secret | Authorizes real-time discovery searches. |
| `FIRECRAWL_API_KEY` | Worker secret | Authorizes web-page extraction. |
| `OPENAI_MODEL` | `wrangler.toml` variable | Model identifier, default `gpt-5.5`. |
| `ALLOWED_ORIGINS` | `wrangler.toml` variable | Comma-separated frontend origins permitted by CORS. |
| `RESEARCH_MAX_ARTICLES` | `wrangler.toml` variable | Server-side maximum articles per run. |

## Security checklist

- Do not commit `.dev.vars`, `.env`, or API keys.
- Use `wrangler secret put` for every key.
- Limit `ALLOWED_ORIGINS` to known HTTPS frontend domains in production.
- Set a conservative maximum research depth while estimating API spend.
- Add authentication and request-level rate limiting before using a custom public Worker URL.
