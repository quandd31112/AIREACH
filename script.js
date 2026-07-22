(() => {
  'use strict';

  const DEFAULT_WORKER_URL = 'http://localhost:8787';
  let workerUrl = resolveWorkerUrl(window.GAME_RESEARCH_API_URL || localStorage.getItem('gameResearchApiUrl') || DEFAULT_WORKER_URL);
  const elements = {
    form: document.querySelector('#researchForm'), prompt: document.querySelector('#researchPrompt'), count: document.querySelector('#characterCount'),
    start: document.querySelector('#startButton'), stop: document.querySelector('#stopButton'), clear: document.querySelector('#clearButton'),
    today: document.querySelector('#todayDate'), status: document.querySelector('#connectionStatus'), progress: document.querySelector('#progressWrap'), progressValue: document.querySelector('#progressValue'),
    progressLabel: document.querySelector('#progressLabel'), progressPercent: document.querySelector('#progressPercent'), empty: document.querySelector('#emptyState'),
    report: document.querySelector('#reportContent'), error: document.querySelector('#errorState'), errorMessage: document.querySelector('#errorMessage'),
    retry: document.querySelector('#retryButton'), exportActions: document.querySelector('#exportActions'), title: document.querySelector('#reportTitle'),
    copy: document.querySelector('#copyButton'), markdown: document.querySelector('#markdownButton'), pdf: document.querySelector('#pdfButton'), theme: document.querySelector('#themeToggle'),
    connectionButton: document.querySelector('#connectionButton'), connectionDialog: document.querySelector('#connectionDialog'), connectionForm: document.querySelector('#connectionForm'),
    closeConnectionDialog: document.querySelector('#closeConnectionDialog'), workerUrl: document.querySelector('#workerUrl'), connectionMessage: document.querySelector('#connectionMessage'), resetConnection: document.querySelector('#resetConnectionButton')
  };
  const state = { controller: null, reportMarkdown: '', lastPayload: null, lastErrorIsConnection: false };

  function init() {
    setDate();
    applyTheme(localStorage.getItem('gameResearchTheme') || 'dark');
    bindEvents();
    checkHealth();
  }

  function bindEvents() {
    elements.prompt.addEventListener('input', () => { elements.count.textContent = elements.prompt.value.length; });
    elements.form.addEventListener('submit', startResearch);
    elements.stop.addEventListener('click', () => state.controller?.abort());
    elements.clear.addEventListener('click', clearResearch);
    elements.retry.addEventListener('click', () => {
      if (state.lastErrorIsConnection) openConnectionDialog();
      else if (state.lastPayload) submitResearch(state.lastPayload);
    });
    elements.copy.addEventListener('click', copyReport);
    elements.markdown.addEventListener('click', downloadMarkdown);
    elements.pdf.addEventListener('click', () => window.print());
    elements.theme.addEventListener('click', toggleTheme);
    elements.connectionButton.addEventListener('click', openConnectionDialog);
    elements.closeConnectionDialog.addEventListener('click', () => elements.connectionDialog.close());
    elements.connectionForm.addEventListener('submit', saveConnection);
    elements.resetConnection.addEventListener('click', resetConnection);
    document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
      elements.prompt.value = button.dataset.prompt;
      elements.prompt.dispatchEvent(new Event('input'));
      elements.prompt.focus();
    }));
  }

  async function checkHealth() {
    try {
      const response = await fetch(`${workerUrl}/health`, { method: 'GET' });
      if (!response.ok) throw new Error(`Worker trả về mã ${response.status}.`);
      setStatus('Sẵn sàng', false);
      elements.connectionButton.textContent = 'Worker đã kết nối';
    } catch (error) {
      setStatus('Cần kết nối Worker', false, true);
      elements.connectionButton.textContent = 'Kết nối Worker';
      console.warn('Game Research AI Worker health check failed:', error);
    }
  }

  function setDate() {
    elements.today.textContent = new Intl.DateTimeFormat('vi-VN', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
  }

  function getPayload() {
    const categories = [...elements.form.querySelectorAll('input[name="categories"]:checked')].map((input) => input.value);
    return {
      prompt: elements.prompt.value.trim(), categories,
      language: elements.form.querySelector('input[name="language"]:checked').value,
      depth: elements.form.querySelector('input[name="depth"]:checked').value
    };
  }

  function startResearch(event) {
    event.preventDefault();
    const payload = getPayload();
    if (!payload.prompt) return elements.prompt.focus();
    submitResearch(payload);
  }

  async function submitResearch(payload) {
    resetOutput();
    state.lastPayload = payload;
    state.controller = new AbortController();
    setBusy(true);
    updateProgress(3, 'Đang lập kế hoạch nghiên cứu');
    try {
      const response = await fetch(`${workerUrl}/api/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(payload), signal: state.controller.signal
      });
      if (!response.ok || !response.body) throw new Error(await responseError(response));
      await consumeStream(response.body);
    } catch (error) {
      if (error.name !== 'AbortError') showError(error.message || 'Yêu cầu nghiên cứu thất bại.');
      else showError('Nghiên cứu đã được dừng. Bạn có thể thử lại bất cứ lúc nào.');
    } finally {
      state.controller = null;
      setBusy(false);
    }
  }

  async function consumeStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.filter(Boolean).forEach(handleEvent);
    }
    if (buffer.trim()) handleEvent(buffer);
  }

  function handleEvent(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'progress') updateProgress(event.percent, event.message);
    if (event.type === 'complete') showReport(event.report, event.metadata);
    if (event.type === 'error') throw new Error(event.message || 'Nghiên cứu thất bại.');
  }

  function showReport(markdown, metadata = {}) {
    state.reportMarkdown = markdown;
    elements.title.textContent = metadata.title || 'Báo cáo nghiên cứu';
    elements.report.innerHTML = renderMarkdown(markdown);
    elements.report.hidden = false;
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.progress.hidden = true;
    elements.exportActions.hidden = false;
    setStatus(`Đã phân tích ${metadata.articleCount || 0} nguồn`, false);
  }

  function updateProgress(percent, message) {
    elements.progress.hidden = false;
    elements.progressValue.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
    elements.progressPercent.textContent = `${Math.round(percent || 0)}%`;
    elements.progressLabel.textContent = message || 'Đang xử lý';
  }

  function resetOutput() {
    state.reportMarkdown = '';
    state.lastErrorIsConnection = false;
    elements.empty.hidden = true; elements.report.hidden = true; elements.error.hidden = true; elements.exportActions.hidden = true;
  }

  function clearResearch() {
    state.controller?.abort();
    elements.form.reset(); elements.prompt.value = ''; elements.count.textContent = '0';
    state.reportMarkdown = ''; state.lastPayload = null;
    state.lastErrorIsConnection = false;
    elements.empty.hidden = false; elements.report.hidden = true; elements.error.hidden = true; elements.progress.hidden = true; elements.exportActions.hidden = true;
    elements.title.textContent = 'Báo cáo của bạn'; setStatus('Sẵn sàng', false);
  }

  function showError(message) {
    elements.progress.hidden = true; elements.report.hidden = true; elements.empty.hidden = true; elements.error.hidden = false;
    elements.errorMessage.textContent = friendlyError(message); setStatus('Needs attention', false, true);
    state.lastErrorIsConnection = isConnectionError(message);
    elements.retry.textContent = state.lastErrorIsConnection ? 'Cấu hình Worker' : 'Thử lại';
  }

  function setBusy(isBusy) {
    elements.start.disabled = isBusy; elements.stop.disabled = !isBusy; elements.clear.disabled = isBusy;
    setStatus(isBusy ? 'Đang nghiên cứu' : 'Sẵn sàng', isBusy);
  }

  function setStatus(message, working, error = false) {
    elements.status.innerHTML = `<i></i> ${escapeHtml(message)}`;
    elements.status.classList.toggle('is-working', working);
    elements.status.style.color = error ? 'var(--danger)' : '';
  }

  async function copyReport() {
    try { await navigator.clipboard.writeText(state.reportMarkdown); elements.copy.textContent = 'Đã sao chép'; setTimeout(() => { elements.copy.textContent = 'Sao chép'; }, 1600); }
    catch { elements.copy.textContent = 'Không thể sao chép'; }
  }

  function downloadMarkdown() {
    const blob = new Blob([state.reportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `nghien-cuu-game-${new Date().toISOString().slice(0, 10)}.md`; link.click(); URL.revokeObjectURL(url);
  }

  function toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
  function applyTheme(theme) { document.documentElement.dataset.theme = theme; localStorage.setItem('gameResearchTheme', theme); elements.theme.textContent = theme === 'dark' ? '◐' : '◑'; }
  function openConnectionDialog() {
    elements.workerUrl.value = workerUrl;
    setConnectionMessage('');
    elements.connectionDialog.showModal();
    elements.workerUrl.focus();
  }

  async function saveConnection(event) {
    event.preventDefault();
    let candidate;
    try { candidate = resolveWorkerUrl(elements.workerUrl.value); }
    catch { setConnectionMessage('Nhập URL Worker HTTPS hợp lệ, hoặc URL HTTP cục bộ khi phát triển.', true); return; }
    setConnectionMessage('Đang kiểm tra kết nối…');
    try {
      const response = await fetch(`${candidate}/health`, { method: 'GET' });
      if (!response.ok) throw new Error(`Kiểm tra dịch vụ trả về mã ${response.status}.`);
      workerUrl = candidate;
      localStorage.setItem('gameResearchApiUrl', workerUrl);
      setConnectionMessage('Đã kết nối Worker. Trình duyệt này sẽ dùng URL trên.', false, true);
      setStatus('Sẵn sàng', false);
      elements.connectionButton.textContent = 'Worker đã kết nối';
      setTimeout(() => elements.connectionDialog.close(), 650);
    } catch (error) {
      setConnectionMessage(connectionErrorMessage(error), true);
    }
  }

  function resetConnection() {
    workerUrl = DEFAULT_WORKER_URL;
    localStorage.removeItem('gameResearchApiUrl');
    elements.workerUrl.value = workerUrl;
    setConnectionMessage('Đang dùng URL Worker cục bộ. Hãy chạy `wrangler dev` trước khi nghiên cứu.');
    checkHealth();
  }

  function setConnectionMessage(message, isError = false, isSuccess = false) {
    elements.connectionMessage.textContent = message;
    elements.connectionMessage.classList.toggle('is-error', isError);
    elements.connectionMessage.classList.toggle('is-success', isSuccess);
  }

  async function responseError(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({}));
      return data.error || data.message || `Worker trả về mã ${response.status}.`;
    }
    return (await response.text()).trim() || `Worker trả về mã ${response.status}.`;
  }

  function resolveWorkerUrl(value) {
    const parsed = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid protocol.');
    return parsed.origin.replace(/\/$/, '');
  }

  function isConnectionError(message) { return /failed to fetch|networkerror|worker unavailable|origin is not allowed|worker health/i.test(message); }
  function connectionErrorMessage(error) { return isConnectionError(error.message) ? 'Không thể kết nối Worker. Kiểm tra URL và thêm trang này vào ALLOWED_ORIGINS trong wrangler.toml.' : error.message; }
  function friendlyError(message) {
    if (isConnectionError(message)) return 'Trình duyệt không thể kết nối Worker. Mở “Kết nối Worker” để kiểm tra URL, rồi thêm domain trang này vào ALLOWED_ORIGINS.';
    if (/secret|OPENAI/i.test(message)) return 'Worker đã kết nối nhưng đang thiếu server secret. Cấu hình OPENAI_API_KEY bằng Wrangler.';
    return message;
  }

  function renderMarkdown(markdown) {
    const escaped = escapeHtml(markdown).replace(/\r\n/g, '\n');
    const blocks = escaped.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    return blocks.map((block) => {
      if (/^```/.test(block)) {
        const code = block.replace(/^```\w*\n?/, '').replace(/```$/, '');
        return `<pre><code>${code}</code></pre>`;
      }
      if (/^###\s/.test(block)) return `<h3>${inlineMarkdown(block.replace(/^###\s/, ''))}</h3>`;
      if (/^##\s/.test(block)) return `<h2>${inlineMarkdown(block.replace(/^##\s/, ''))}</h2>`;
      if (/^#\s/.test(block)) return `<h1>${inlineMarkdown(block.replace(/^#\s/, ''))}</h1>`;
      if (/^&gt;\s/.test(block)) return `<blockquote>${inlineMarkdown(block.replace(/^&gt;\s/gm, '').replace(/\n/g, '<br>'))}</blockquote>`;
      if (/^(?:[-*+]\s|\d+\.\s)/m.test(block)) {
        const ordered = /^\d+\.\s/.test(block); const items = block.split('\n').filter(Boolean).map((line) => line.replace(ordered ? /^\d+\.\s/ : /^[-*+]\s/, ''));
        return `<${ordered ? 'ol' : 'ul'}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
      }
      return `<p>${inlineMarkdown(block.replace(/\n/g, '<br>'))}</p>`;
    }).join('');
  }

  function inlineMarkdown(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
  init();
})();
