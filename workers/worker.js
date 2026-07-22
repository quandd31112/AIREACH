/**
 * Game Research AI Cloudflare Worker
 * Secrets are configured with `wrangler secret put`; they never reach the browser.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin'
};

const DEPTH_CONFIG = {
  quick: { articles: 12, queries: 3, perQuery: 4, tavilyDepth: 'basic' },
  normal: { articles: 30, queries: 5, perQuery: 6, tavilyDepth: 'advanced' },
  deep: { articles: 50, queries: 5, perQuery: 10, tavilyDepth: 'advanced' }
};

const DEFAULT_CATEGORIES = ['Game Design', 'Steam', 'Game Industry'];
const MAX_PROMPT_LENGTH = 1200;

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return json({ ok: true, service: 'game-research-ai' }, 200, corsHeaders);
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/research') {
      return json({ error: 'Not found' }, 404, corsHeaders);
    }
    if (!isAllowedOrigin(request, env)) return json({ error: 'Origin is not allowed.' }, 403, corsHeaders);
    if (!hasRequiredSecrets(env)) return json({ error: 'Worker secrets are not configured.' }, 503, corsHeaders);

    let input;
    try { input = validateInput(await request.json()); }
    catch (error) { return json({ error: error.message || 'Invalid request.' }, 400, corsHeaders); }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const emit = (event) => writer.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    const close = () => writer.close();

    ctx.waitUntil(runResearch(input, env, request.signal, emit).catch(async (error) => {
      console.error('Research pipeline failed:', error);
      await emit({ type: 'error', message: publicError(error) });
    }).finally(close));

    return new Response(readable, {
      headers: { ...corsHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff' }
    });
  }
};

async function runResearch(input, env, signal, emit) {
  const config = DEPTH_CONFIG[input.depth];
  const maxArticles = Math.min(config.articles, Number(env.RESEARCH_MAX_ARTICLES || config.articles));
  await emit({ type: 'progress', percent: 5, message: 'Building focused search queries' });
  const queries = buildQueries(input, config.queries);

  await emit({ type: 'progress', percent: 10, message: `Searching current coverage across ${queries.length} topics` });
  const searchResults = await Promise.all(queries.map((query) => tavilySearch(query, config, env, signal)));
  const sources = deduplicateSources(searchResults.flat()).slice(0, maxArticles);
  if (!sources.length) throw new Error('No relevant articles were found. Refine the prompt or try again.');

  await emit({ type: 'progress', percent: 25, message: `Reading ${sources.length} unique articles` });
  const articles = await mapWithConcurrency(sources, 3, async (source, index) => {
    const article = await scrapeArticle(source, env, signal);
    const progress = 25 + Math.round(((index + 1) / sources.length) * 28);
    await emit({ type: 'progress', percent: progress, message: `Extracted ${index + 1} of ${sources.length} articles` });
    return article;
  });
  const readableArticles = articles.filter((article) => article.content && article.content.length > 300);
  if (!readableArticles.length) throw new Error('The selected articles could not be read. Please try a different search.');

  await emit({ type: 'progress', percent: 55, message: `Analyzing ${readableArticles.length} articles as a game designer` });
  const summaries = await mapWithConcurrency(readableArticles, 3, async (article, index) => {
    const summary = await summarizeArticle(article, input.language, env, signal);
    const progress = 55 + Math.round(((index + 1) / readableArticles.length) * 25);
    await emit({ type: 'progress', percent: progress, message: `Analyzed ${index + 1} of ${readableArticles.length} articles` });
    return { ...article, summary };
  });

  await emit({ type: 'progress', percent: 82, message: 'Creating the daily industry report' });
  const dailyReport = await generateDailyReport(summaries, input, env, signal);
  await emit({ type: 'progress', percent: 91, message: "Finding cross-source patterns and strategic opportunities" });
  const strategicInsights = await generateStrategicInsights(summaries, input, env, signal);
  const report = `${dailyReport.trim()}\n\n## Game Designer's Strategic Insights\n\n${strategicInsights.trim()}\n\n## Sources\n\n${formatSources(summaries)}`;
  await emit({ type: 'progress', percent: 100, message: 'Research report is ready' });
  await emit({ type: 'complete', report, metadata: { title: `Daily Briefing · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, articleCount: summaries.length } });
}

function validateInput(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('A research request is required.');
  const prompt = String(payload.prompt || '').trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt must be between 1 and ${MAX_PROMPT_LENGTH} characters.`);
  const categories = Array.isArray(payload.categories) ? payload.categories.map((item) => String(item).trim()).filter(Boolean).slice(0, 18) : [];
  const language = payload.language === 'Vietnamese' ? 'Vietnamese' : 'English';
  const depth = Object.hasOwn(DEPTH_CONFIG, payload.depth) ? payload.depth : 'normal';
  return { prompt, categories: categories.length ? categories : DEFAULT_CATEGORIES, language, depth };
}

function buildQueries(input, count) {
  const categoryPool = [...input.categories];
  const queries = [];
  for (let index = 0; index < count; index += 1) {
    const category = categoryPool[index % categoryPool.length];
    queries.push(`${input.prompt} — latest ${category} game industry news, analysis, releases and developer insights`);
  }
  return [...new Set(queries)];
}

async function tavilySearch(query, config, env, signal) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topic: 'news', search_depth: config.tavilyDepth, max_results: config.perQuery, time_range: 'month', include_answer: false, include_raw_content: false })
  });
  const data = await readApiResponse(response, 'Tavily');
  return Array.isArray(data.results) ? data.results : [];
}

function deduplicateSources(results) {
  const seen = new Set();
  return results.filter((result) => {
    const url = canonicalizeUrl(result.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  }).map((result) => ({ title: result.title || 'Untitled article', url: result.url, snippet: result.content || '' }));
}

function canonicalizeUrl(rawUrl) {
  try { const url = new URL(rawUrl); url.hash = ''; ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => url.searchParams.delete(key)); return url.toString().replace(/\/$/, ''); }
  catch { return null; }
}

async function scrapeArticle(source, env, signal) {
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: source.url, formats: ['markdown'], onlyMainContent: true, timeout: 30000 })
    });
    const payload = await readApiResponse(response, 'Firecrawl');
    const data = payload.data || payload;
    const metadata = data.metadata || {};
    return {
      title: metadata.title || source.title,
      author: metadata.author || metadata.authors?.join(', ') || 'Not listed',
      website: metadata.sourceURL ? new URL(metadata.sourceURL).hostname : new URL(source.url).hostname,
      publishedDate: metadata.publishedTime || metadata.datePublished || metadata.modifiedTime || 'Not listed',
      url: source.url,
      content: trimContent(data.markdown || data.content || '')
    };
  } catch (error) {
    console.warn(`Skipping unreadable article: ${source.url}`, error.message);
    return { ...source, author: 'Not listed', website: new URL(source.url).hostname, publishedDate: 'Not listed', content: '' };
  }
}

function trimContent(content) {
  return String(content).replace(/\s+/g, ' ').trim().slice(0, 24000);
}

async function summarizeArticle(article, language, env, signal) {
  const instructions = `You are a Senior Game Designer. Analyze one current game-industry article. Write in ${language}. Use concise markdown with these exact headings: Summary, Key Takeaways, Game Design Lessons, Business Lessons, Monetization, Retention, LiveOps, Player Psychology, Why this matters, Should I read the full article?. If a topic is not supported by the article, say "Not addressed". Do not invent facts or numbers.`;
  const input = `ARTICLE METADATA\nTitle: ${article.title}\nAuthor: ${article.author}\nWebsite: ${article.website}\nPublished: ${article.publishedDate}\nURL: ${article.url}\n\nARTICLE\n${article.content}`;
  return openaiText(instructions, input, env, signal);
}

async function generateDailyReport(summaries, input, env, signal) {
  const digest = buildDigest(summaries, 72000);
  const instructions = `You are a Senior Game Designer preparing a decision-ready daily research briefing. Write in ${input.language}. Use only evidence from the supplied article analyses; reconcile uncertainty and avoid invented facts. Generate concise markdown using every exact section heading below, in order: Executive Summary, Top Industry News, Game Design, Programming, Unity, Steam, AI, Market Trend, Business, Important Releases, Interesting Reddit Discussions, Useful GDC Talks, Final Insights, Action Items. When evidence is absent, write "No material signal found in this research set." Link claims to the relevant source URLs when practical.`;
  return openaiText(instructions, `Research question: ${input.prompt}\nCategories: ${input.categories.join(', ')}\n\nARTICLE ANALYSES\n${digest}`, env, signal);
}

async function generateStrategicInsights(summaries, input, env, signal) {
  const digest = buildDigest(summaries, 86000);
  const instructions = `You are a Lead Game Designer with over 15 years of experience. You are performing a second, strategic analysis pass over multiple article analyses—not summarizing the news. Write in ${input.language}. Identify patterns only where evidence supports them and label speculation clearly. Return practical, concise markdown answering each exact heading: Repeated Trends, Rising Mechanics, Emerging Monetization Strategies, Companies Leading the Trend, Opportunities for Indie Developers, Opportunities for Mobile Game Developers, Experiments Worth Running, Temporary Hype to Watch, 6–12 Month Industry Outlook, Practical Recommendations. Every recommendation must be specific, testable, and relevant to game designers. Avoid invented facts.`;
  return openaiText(instructions, `Research question: ${input.prompt}\nCategories: ${input.categories.join(', ')}\n\nARTICLE ANALYSES TO CROSS-ANALYZE\n${digest}`, env, signal);
}

function buildDigest(summaries, characterLimit) {
  let used = 0;
  return summaries.map((article, index) => {
    const item = `\n--- ARTICLE ${index + 1} ---\nTitle: ${article.title}\nURL: ${article.url}\nPublished: ${article.publishedDate}\nAnalysis:\n${article.summary}\n`;
    if (used + item.length > characterLimit) return '';
    used += item.length;
    return item;
  }).filter(Boolean).join('');
}

async function openaiText(instructions, input, env, signal) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-5.5', instructions, input, temperature: 0.2, max_output_tokens: 3500 })
  });
  const data = await readApiResponse(response, 'OpenAI');
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n');
  if (!text) throw new Error('OpenAI returned no analysis.');
  return text;
}

async function readApiResponse(response, provider) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(`${provider} request failed: ${detail}`);
  }
  return data;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor++;
      result[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return result;
}

function formatSources(summaries) {
  return summaries.map((article) => `- [${article.title}](${article.url}) — ${article.website}${article.publishedDate !== 'Not listed' ? `, ${article.publishedDate}` : ''}`).join('\n');
}

function hasRequiredSecrets(env) { return Boolean(env.OPENAI_API_KEY && env.TAVILY_API_KEY && env.FIRECRAWL_API_KEY); }
function publicError(error) { return error.name === 'AbortError' ? 'Research was stopped.' : error.message?.replace(/(sk-[\w-]+|fc-[\w-]+|tvly-[\w-]+)/g, '[redacted]') || 'Research failed.'; }
function json(body, status, headers) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } }); }
function getCorsHeaders(request, env) { const origin = request.headers.get('Origin'); return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': isAllowedOrigin(request, env) && origin ? origin : 'null' }; }
function isAllowedOrigin(request, env) { const origin = request.headers.get('Origin'); if (!origin) return true; const configured = (env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean); return configured.length === 0 || configured.includes(origin); }
