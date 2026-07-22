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
  quick: { articles: 8, queries: 2, perQuery: 4, tavilyDepth: 'basic' },
  normal: { articles: 12, queries: 3, perQuery: 4, tavilyDepth: 'advanced' },
  deep: { articles: 20, queries: 4, perQuery: 5, tavilyDepth: 'advanced' }
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
    if (!hasRequiredSecrets(env)) return json({ error: 'Worker chưa được cấu hình server secret.' }, 503, corsHeaders);

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
  await emit({ type: 'progress', percent: 5, message: 'Đang tạo truy vấn tìm kiếm' });
  const queries = buildQueries(input, config.queries);

  await emit({ type: 'progress', percent: 10, message: `Đang tìm tin mới ở ${queries.length} chủ đề` });
  const searchResults = await Promise.all(queries.map((query) => tavilySearch(query, config, env, signal)));
  const sources = deduplicateSources(searchResults.flat()).slice(0, maxArticles);
  if (!sources.length) throw new Error('Không tìm thấy bài viết phù hợp. Hãy làm rõ câu hỏi và thử lại.');

  await emit({ type: 'progress', percent: 25, message: `Đang đọc ${sources.length} bài viết không trùng lặp` });
  const articles = await mapWithConcurrency(sources, 4, async (source, index) => {
    const article = await scrapeArticle(source, env, signal);
    const progress = 25 + Math.round(((index + 1) / sources.length) * 48);
    await emit({ type: 'progress', percent: progress, message: `Đã trích xuất ${index + 1}/${sources.length} bài viết` });
    return article;
  });
  const readableArticles = articles.filter((article) => article.content && article.content.length > 300);
  if (!readableArticles.length) throw new Error('Không thể đọc các bài viết đã chọn. Hãy thử một truy vấn khác.');

  await emit({ type: 'progress', percent: 78, message: 'Đang tổng hợp nguồn thành hướng thiết kế' });
  const report = await generateResearchBrief(readableArticles, input, env, signal);
  await emit({ type: 'progress', percent: 100, message: 'Báo cáo nghiên cứu đã sẵn sàng' });
  await emit({ type: 'complete', report, metadata: { title: `Bản tin nghiên cứu · ${new Date().toLocaleDateString('vi-VN', { month: 'short', day: 'numeric', year: 'numeric' })}`, articleCount: readableArticles.length } });
}

function validateInput(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('A research request is required.');
  const prompt = String(payload.prompt || '').trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt must be between 1 and ${MAX_PROMPT_LENGTH} characters.`);
  const categories = Array.isArray(payload.categories) ? payload.categories.map((item) => String(item).trim()).filter(Boolean).slice(0, 18) : [];
  const language = 'Vietnamese';
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
  return String(content).replace(/\s+/g, ' ').trim().slice(0, 10000);
}

async function generateResearchBrief(articles, input, env, signal) {
  const sourceContext = buildSourceContext(articles, 90000);
  const instructions = `Bạn là Lead Game Designer và đối tác nghiên cứu với hơn 15 năm kinh nghiệm. Viết toàn bộ báo cáo bằng tiếng Việt tự nhiên, rõ ràng và dễ hành động. Khi nguồn là tiếng Anh, hãy dịch và diễn giải các thông tin liên quan sang tiếng Việt; chỉ giữ tên sản phẩm, công ty, thuật ngữ chuyên ngành hoặc trích dẫn ngắn ở ngôn ngữ gốc khi cần. Dựa mọi khẳng định thực tế duy nhất vào các nguồn được cung cấp; đặt URL nguồn bên cạnh các khẳng định quan trọng. Phân biệt sự kiện với suy luận, và ghi "Không có tín hiệu đáng kể trong tập nguồn này." khi thiếu bằng chứng. Không bịa số liệu, ngày phát hành, công ty hay xu hướng. Dùng đúng cấu trúc Markdown sau: Tóm tắt điều hành, Điều gì đang diễn ra, Mẫu thiết kế đáng chú ý, Tín hiệu thị trường và kinh doanh, Cơ hội cho nhà phát triển indie, Cơ hội cho nhà phát triển mobile, Thử nghiệm nên thực hiện, Rủi ro và xu hướng nhất thời, Góc nhìn chiến lược cho Game Designer, 6–12 tháng tới, Kế hoạch hành động, Nguồn. Trong phần Góc nhìn chiến lược cho Game Designer, đưa ra khuyến nghị cụ thể và có thể kiểm chứng, không chỉ tóm tắt tin tức.`;
  const report = await openaiText(instructions, `Research question: ${input.prompt}\nCategories: ${input.categories.join(', ')}\n\nSOURCE MATERIAL\n${sourceContext}`, env, signal);
  return ensureSources(report, articles);
}

function buildSourceContext(articles, characterLimit) {
  let used = 0;
  return articles.map((article, index) => {
    const item = `\n--- SOURCE ${index + 1} ---\nTitle: ${article.title}\nWebsite: ${article.website}\nPublished: ${article.publishedDate}\nURL: ${article.url}\nContent:\n${article.content}\n`;
    if (used + item.length > characterLimit) return '';
    used += item.length;
    return item;
  }).filter(Boolean).join('');
}

function ensureSources(report, articles) {
  return `${report.trim()}\n\n## Verified Sources\n\n${formatSources(articles)}`;
}

async function openaiText(instructions, input, env, signal) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-5.5', instructions, input, temperature: 0.2, max_output_tokens: 4000 })
  });
  const data = await readApiResponse(response, 'OpenAI');
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n');
  if (!text) throw new Error('OpenAI không trả về nội dung phân tích.');
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

function formatSources(articles) {
  return articles.map((article) => `- [${article.title}](${article.url}) — ${article.website}${article.publishedDate !== 'Not listed' ? `, ${article.publishedDate}` : ''}`).join('\n');
}

function hasRequiredSecrets(env) { return Boolean(env.OPENAI_API_KEY && env.TAVILY_API_KEY && env.FIRECRAWL_API_KEY); }
function publicError(error) { return error.name === 'AbortError' ? 'Nghiên cứu đã được dừng.' : error.message?.replace(/(sk-[\w-]+|fc-[\w-]+|tvly-[\w-]+)/g, '[đã ẩn]') || 'Nghiên cứu thất bại.'; }
function json(body, status, headers) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } }); }
function getCorsHeaders(request, env) { const origin = request.headers.get('Origin'); return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': isAllowedOrigin(request, env) && origin ? origin : 'null' }; }
function isAllowedOrigin(request, env) { const origin = request.headers.get('Origin'); if (!origin) return true; const configured = (env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean); return configured.length === 0 || configured.includes(origin); }
