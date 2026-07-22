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
      if (!response.ok) throw new Error(`Worker health check returned ${response.status}.`);
      setStatus('Ready', false);
      elements.connectionButton.textContent = 'Worker connected';
    } catch (error) {
      setStatus('Worker setup needed', false, true);
      elements.connectionButton.textContent = 'Connect Worker';
      console.warn('Game Research AI Worker health check failed:', error);
    }
  }

  function setDate() {
    elements.today.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
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
    updateProgress(3, 'Planning your research');
    try {
      const response = await fetch(`${workerUrl}/api/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(payload), signal: state.controller.signal
      });
      if (!response.ok || !response.body) throw new Error(await responseError(response));
      await consumeStream(response.body);
    } catch (error) {
      if (error.name !== 'AbortError') showError(error.message || 'The research request failed.');
      else showError('Research was stopped. You can retry whenever you are ready.');
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
    if (event.type === 'error') throw new Error(event.message || 'Research failed.');
  }

  function showReport(markdown, metadata = {}) {
    state.reportMarkdown = markdown;
    elements.title.textContent = metadata.title || 'Research report';
    elements.report.innerHTML = renderMarkdown(markdown);
    elements.report.hidden = false;
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.progress.hidden = true;
    elements.exportActions.hidden = false;
    setStatus(`${metadata.articleCount || 0} sources analyzed`, false);
  }

  function updateProgress(percent, message) {
    elements.progress.hidden = false;
    elements.progressValue.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
    elements.progressPercent.textContent = `${Math.round(percent || 0)}%`;
    elements.progressLabel.textContent = message || 'Working';
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
    elements.title.textContent = 'Your research report'; setStatus('Ready', false);
  }

  function showError(message) {
    elements.progress.hidden = true; elements.report.hidden = true; elements.empty.hidden = true; elements.error.hidden = false;
    elements.errorMessage.textContent = friendlyError(message); setStatus('Needs attention', false, true);
    state.lastErrorIsConnection = isConnectionError(message);
    elements.retry.textContent = state.lastErrorIsConnection ? 'Configure Worker' : 'Retry research';
  }

  function setBusy(isBusy) {
    elements.start.disabled = isBusy; elements.stop.disabled = !isBusy; elements.clear.disabled = isBusy;
    setStatus(isBusy ? 'Researching' : 'Ready', isBusy);
  }

  function setStatus(message, working, error = false) {
    elements.status.innerHTML = `<i></i> ${escapeHtml(message)}`;
    elements.status.classList.toggle('is-working', working);
    elements.status.style.color = error ? 'var(--danger)' : '';
  }

  async function copyReport() {
    try { await navigator.clipboard.writeText(state.reportMarkdown); elements.copy.textContent = 'Copied'; setTimeout(() => { elements.copy.textContent = 'Copy'; }, 1600); }
    catch { elements.copy.textContent = 'Copy failed'; }
  }

  function downloadMarkdown() {
    const blob = new Blob([state.reportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `game-research-${new Date().toISOString().slice(0, 10)}.md`; link.click(); URL.revokeObjectURL(url);
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
    catch { setConnectionMessage('Enter a valid HTTPS Worker URL, or use a local HTTP URL while developing.', true); return; }
    setConnectionMessage('Testing connection…');
    try {
      const response = await fetch(`${candidate}/health`, { method: 'GET' });
      if (!response.ok) throw new Error(`Health check returned ${response.status}.`);
      workerUrl = candidate;
      localStorage.setItem('gameResearchApiUrl', workerUrl);
      setConnectionMessage('Worker connected. This browser will use this URL.', false, true);
      setStatus('Ready', false);
      elements.connectionButton.textContent = 'Worker connected';
      setTimeout(() => elements.connectionDialog.close(), 650);
    } catch (error) {
      setConnectionMessage(connectionErrorMessage(error), true);
    }
  }

  function resetConnection() {
    workerUrl = DEFAULT_WORKER_URL;
    localStorage.removeItem('gameResearchApiUrl');
    elements.workerUrl.value = workerUrl;
    setConnectionMessage('Using the local Worker URL. Start `wrangler dev` before researching.');
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
      return data.error || data.message || `Worker returned ${response.status}.`;
    }
    return (await response.text()).trim() || `Worker returned ${response.status}.`;
  }

  function resolveWorkerUrl(value) {
    const parsed = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid protocol.');
    return parsed.origin.replace(/\/$/, '');
  }

  function isConnectionError(message) { return /failed to fetch|networkerror|worker unavailable|origin is not allowed|worker health/i.test(message); }
  function connectionErrorMessage(error) { return isConnectionError(error.message) ? 'Could not reach this Worker. Check the URL and add this site to ALLOWED_ORIGINS in wrangler.toml.' : error.message; }
  function friendlyError(message) {
    if (isConnectionError(message)) return 'The browser could not reach the Worker. Open “Connect Worker” to check its URL, then add this frontend origin to ALLOWED_ORIGINS.';
    if (/secrets are not configured|OPENAI|TAVILY|FIRECRAWL/i.test(message)) return 'The Worker is reachable, but one or more server secrets are missing. Configure OPENAI_API_KEY, TAVILY_API_KEY, and FIRECRAWL_API_KEY with Wrangler.';
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
