/**
 * Game Research AI Worker
 * Uses OpenAI's hosted web search. Keep OPENAI_API_KEY as a Cloudflare secret.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin'
};

const RESEARCH_DEPTH = {
  quick: { context: 'low', label: 'nhanh' },
  normal: { context: 'medium', label: 'cân bằng' },
  deep: { context: 'high', label: 'chuyên sâu' }
};
const DEFAULT_CATEGORIES = ['Game Design', 'Steam', 'Game Industry'];
const MAX_PROMPT_LENGTH = 1200;
const DEFAULT_ALLOWED_ORIGINS = new Set(['https://quandd31112.github.io']);

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request, env);
    const pathname = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method === 'GET' && pathname === '/health') return json({ ok: true, service: 'game-research-ai' }, 200, corsHeaders);
    if (request.method !== 'POST' || pathname !== '/api/research') return json({ error: 'Không tìm thấy API này.' }, 404, corsHeaders);
    if (!isAllowedOrigin(request, env)) return json({ error: 'Domain này không được phép truy cập Worker.' }, 403, corsHeaders);
    if (!env.OPENAI_API_KEY) return json({ error: 'Worker chưa được cấu hình OPENAI_API_KEY.' }, 503, corsHeaders);

    let input;
    try { input = validateInput(await request.json()); }
    catch (error) { return json({ error: error.message || 'Yêu cầu không hợp lệ.' }, 400, corsHeaders); }

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        const emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          await runResearch(input, env, request.signal, emit);
        } catch (error) {
          console.error('Research failed:', error);
          emit({ type: 'error', message: publicError(error) });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
};

async function runResearch(input, env, signal, emit) {
  const depth = RESEARCH_DEPTH[input.depth];
  await emit({ type: 'progress', percent: 8, message: 'Đang chuẩn bị câu hỏi nghiên cứu' });
  await emit({ type: 'progress', percent: 25, message: `Đang tìm web ở chế độ ${depth.label}` });

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5',
      tools: [{ type: 'web_search', search_context_size: depth.context }],
      tool_choice: 'required',
      instructions: researchInstructions(),
      input: buildResearchRequest(input),
      max_output_tokens: 4000
    })
  });

  await emit({ type: 'progress', percent: 75, message: 'Đang tổng hợp và dịch nguồn sang tiếng Việt' });
  const data = await readApiResponse(response, 'OpenAI');
  const report = extractOutputText(data);
  if (!report) throw new Error('OpenAI không trả về báo cáo.');

  const sources = extractSources(data);
  await emit({ type: 'progress', percent: 100, message: 'Báo cáo nghiên cứu đã sẵn sàng' });
  await emit({
    type: 'complete',
    report: appendVerifiedSources(report, sources),
    metadata: {
      title: `Bản tin nghiên cứu · ${new Date().toLocaleDateString('vi-VN', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      articleCount: sources.length
    }
  });
}

function validateInput(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Cần có một yêu cầu nghiên cứu.');
  const prompt = String(payload.prompt || '').trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Câu hỏi cần dài từ 1 đến ${MAX_PROMPT_LENGTH} ký tự.`);
  const categories = Array.isArray(payload.categories)
    ? payload.categories.map((item) => String(item).trim()).filter(Boolean).slice(0, 18)
    : [];
  const depth = Object.hasOwn(RESEARCH_DEPTH, payload.depth) ? payload.depth : 'normal';
  return { prompt, categories: categories.length ? categories : DEFAULT_CATEGORIES, depth };
}

function researchInstructions() {
  return `Bạn là Lead Game Designer và research copilot với hơn 15 năm kinh nghiệm. Tìm thông tin web mới nhất về ngành game để trả lời yêu cầu của người dùng. Viết hoàn toàn bằng tiếng Việt tự nhiên. Khi nguồn là tiếng Anh, hãy dịch và diễn giải ý chính sang tiếng Việt; chỉ giữ tên game, công ty, sản phẩm hoặc thuật ngữ chuyên ngành khi hữu ích. Mọi khẳng định thực tế phải dựa trên nguồn web tìm được. Phân biệt rõ sự kiện, suy luận và dự đoán; không bịa số liệu, nguồn, ngày phát hành hay xu hướng. Dùng Markdown với đúng các mục: Tóm tắt điều hành, Tín hiệu quan trọng, Mẫu thiết kế đáng chú ý, Thị trường và kinh doanh, Cơ hội cho game indie, Cơ hội cho game mobile, Thử nghiệm nên thực hiện, Rủi ro hoặc xu hướng nhất thời, Góc nhìn chiến lược cho Game Designer, Hành động tiếp theo. Ưu tiên khuyến nghị cụ thể, khả thi và có thể kiểm chứng.`;
}

function buildResearchRequest(input) {
  return `Yêu cầu nghiên cứu: ${input.prompt}\nChủ đề ưu tiên: ${input.categories.join(', ')}\n\nHãy dùng web search để tìm nguồn gần đây và đáng tin cậy. Đưa URL nguồn cạnh những khẳng định quan trọng khi phù hợp.`;
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  return data.output
    ?.flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n') || '';
}

function extractSources(data) {
  const urls = new Map();
  for (const item of data.output || []) {
    if (item.type !== 'web_search_call') continue;
    for (const source of item.action?.sources || []) {
      if (source.type !== 'url' || !source.url) continue;
      urls.set(source.url, source.url);
    }
  }
  return [...urls.values()];
}

function appendVerifiedSources(report, sources) {
  if (!sources.length) return report;
  const sourceList = sources.map((url) => `- [${safeSourceLabel(url)}](${url})`).join('\n');
  return `${report.trim()}\n\n## Nguồn web đã kiểm chứng\n\n${sourceList}`;
}

function safeSourceLabel(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./, ''); }
  catch { return 'Nguồn web'; }
}

async function readApiResponse(response, provider) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(`${provider} request failed: ${detail}`);
  }
  return data;
}

function publicError(error) {
  if (error.name === 'AbortError') return 'Nghiên cứu đã được dừng.';
  return error.message?.replace(/sk-[\w-]+/g, '[đã ẩn]') || 'Nghiên cứu thất bại.';
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': isAllowedOrigin(request, env) && origin ? origin : 'null' };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured.includes(origin) : DEFAULT_ALLOWED_ORIGINS.has(origin);
}
