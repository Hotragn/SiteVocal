/*!
 * SiteVocal — panel.js (extension shell for the side panel, popup and full-tab view)
 *
 * Hosts index.html as an MV3 sandboxed iframe and gives it a private
 * MessageChannel with the capabilities the sandbox cannot have itself:
 *   1. tab:read  — inject content.js into the active tab and return the page
 *      tab:match — find an open tab already showing a pasted address (read live, no fetch)
 *   2. fetch     — fetch a URL with the extension's host permissions (no CORS proxy)
 *   3. storage   — persist sitevocal_* keys in the extension's localStorage
 *   4. open      — open links / the full-tab studio in a new browser tab
 *   5. ai:*      — the browser's on-device AI (its general model, told to clean the page first, or its Summarizer),
 *                  which sandboxed frames cannot reach, and downloading that model on a click
 *   6. turbo     — the optional Turbo Engine: a POST to the voice / LLM / page-reader endpoint the user
 *                  saved with their own key, and nowhere else (no key saved → refused, nothing is sent)
 *   7. access:*  — optional site access: whether SiteVocal may read every site, asking Chrome for it when you
 *                  click Allow (all sites, or the one Turbo service you test), and giving it back. Without it,
 *                  only the tab you click SiteVocal on is read, and links load the way the website loads them.
 *   8. storage:clear — "Clear everything" in Your data: every sitevocal_* key, the pending request, the icon mode
 * It also forwards toolbar-icon, context-menu and shortcut requests from
 * background.js, active-tab changes, and the SPA / infinite-scroll signals
 * that content.js sends from a tab being read, to the studio.
 */
'use strict';

const params = new URLSearchParams(location.search);
const surface = ['popup', 'tab'].includes(params.get('surface')) ? params.get('surface') : 'sidepanel';
document.documentElement.dataset.surface = surface;

const frame = document.getElementById('app');
const PREFIX = 'sitevocal';
const PENDING_KEY = 'sitevocal_pending';
const MODE_KEY = 'sitevocal_open_mode';
const ALL_SITES = { origins: ['http://*/*', 'https://*/*'] };
// What "Forget what I listened to when I close SiteVocal" erases: settings, the dictionary and keys stay.
const FORGET = /^sitevocal_(?:library|doc_.*|clips|queue|stats)$/;
let port = null;
let nonce = '';
let initialized = false;
let windowId = null;
let lastRequestId = '';
let lastTabJson = '';
let access = false; // optional host access to every http(s) site
let closing = false; // "forget on close" ran: nothing it erased is written again
let restarted = false; // the studio restarted after Clear everything: it starts empty, reading no tab by itself
const queued = [];

const windowReady = chrome.windows
  .getCurrent()
  .then((win) => {
    windowId = win.id;
  })
  .catch(() => {});

/* ----------------------------------------------------------- handshake */
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.sv !== 1 || data.type !== 'hello' || typeof data.nonce !== 'string') return;
  if (port && data.nonce === nonce) return; // repeated hello from the same studio instance
  connect(data.nonce);
});

async function connect(helloNonce) {
  if (port) port.close();
  initialized = false;
  const channel = new MessageChannel();
  port = channel.port1;
  nonce = helloNonce;
  const own = channel.port1;
  own.onmessage = (event) => handle(event.data, own);
  // Only the port and the studio's own nonce cross with '*'; every payload travels over the private port.
  frame.contentWindow.postMessage({ sv: 1, type: 'connect', nonce }, '*', [channel.port2]);
  await windowReady;
  access = await chrome.permissions.contains(ALL_SITES).catch(() => false);
  const tab = await targetTab().catch(() => null);
  lastTabJson = JSON.stringify(tabInfo(tab));
  post({ type: 'init', surface, version: chrome.runtime.getManifest().version, storage: snapshot(), tab: tabInfo(tab), access });
  initialized = true;
  let pending = await takePending();
  if (!pending && !queued.length && surface === 'sidepanel') {
    // A toolbar click can land a moment after the panel boots: look once more before reading the tab ourselves.
    await new Promise((r) => setTimeout(r, 250));
    if (!lastRequestId) pending = await takePending();
  }
  if (pending) forward(pending);
  else if (surface === 'popup' && !restarted) forward({ kind: 'tab', id: `popup-${Date.now()}` });
  while (queued.length) forward(queued.shift());
  if (surface === 'sidepanel' && !lastRequestId && !restarted) {
    // Opened without any request (the side panel menu, a lost click): read the page you are on, as the icon would.
    const now = await targetTab().catch(() => null);
    if (now && tabInfo(now).readable && !lastRequestId) forward({ kind: 'tab', tabId: now.id, id: `boot-${Date.now()}`, boot: true });
  }
}

function post(message) {
  if (port) port.postMessage({ sv: 1, ...message });
}

function snapshot() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) out[key] = localStorage.getItem(key);
  }
  return out;
}

/* --------------------------------------------- requests from the studio */
async function handle(message, from) {
  if (!message || message.sv !== 1) return;
  const { id, type } = message;
  // Answer on the port the request came in on: if the studio reloaded meanwhile, the stale answer is dropped.
  const reply = (ok, extra) => from.postMessage({ sv: 1, type: 'reply', id, ok, ...extra });
  try {
    switch (type) {
      case 'storage:set':
        if (typeof message.key !== 'string' || !message.key.startsWith(PREFIX)) throw new Error('Invalid storage key');
        if (closing && FORGET.test(message.key)) return reply(true, {});
        localStorage.setItem(message.key, String(message.value));
        return reply(true, {});
      case 'storage:remove':
        if (typeof message.key === 'string' && message.key.startsWith(PREFIX)) localStorage.removeItem(message.key);
        return reply(true, {});
      case 'tab:read':
        return reply(true, { result: await readTab(message.tabId) });
      case 'tab:match':
        return reply(true, { result: await matchTab(message.url) });
      case 'fetch':
        return reply(true, { result: await privilegedFetch(message.url, message.as) });
      case 'open':
        if (/^https?:\/\//i.test(String(message.url || ''))) await chrome.tabs.create({ url: message.url });
        return reply(true, {});
      case 'popout':
        await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?surface=tab') });
        return reply(true, {});
      case 'ai:availability':
        return reply(true, { result: await aiAvailability(message.options) });
      case 'ai:summarize':
        return reply(true, { result: await aiSummarize(message) });
      case 'ai:prompt':
        return reply(true, { result: await aiPrompt(message) });
      case 'ai:download':
        // From a click in the studio: that gesture reaches this page, which Chrome requires to download a model.
        return reply(true, { result: await aiDownload(message) });
      case 'turbo':
        return reply(true, { result: await turboFetch(message) });
      case 'access:request':
        // Sent from a click in the studio: the click's user activation reaches this page, as Chrome requires.
        return reply(true, { result: await chrome.permissions.request({ origins: wantedOrigins(message.origins) }) });
      case 'access:remove':
        return reply(true, { result: await chrome.permissions.remove(ALL_SITES) });
      case 'storage:clear':
        clearEverything();
        reply(true, {});
        // Restart the studio clean (a sandboxed page cannot reload itself); it says what was cleared.
        restarted = true;
        frame.src = 'index.html?host=extension&cleared=1';
        return undefined;
      default:
        return reply(false, { error: `Unknown request: ${type}` });
    }
  } catch (err) {
    return reply(false, { error: (err && err.message) || String(err), code: (err && err.code) || '' });
  }
}

/** "Clear everything": all that SiteVocal keeps in this browser, nothing else. */
function clearEverything() {
  for (const key of Object.keys(snapshot())) localStorage.removeItem(key);
  if (chrome.storage && chrome.storage.session) chrome.storage.session.remove(PENDING_KEY).catch(() => {});
  if (chrome.storage && chrome.storage.local) chrome.storage.local.remove(MODE_KEY).catch(() => {});
}

/** An error the studio answers with an Allow button: this needs access to all sites (Chrome asks you first). */
function needsAccess(message) {
  const err = new Error(message);
  err.code = 'needs-access';
  return err;
}

/** What the studio may ask Chrome for: every site, or single hosts such as a Turbo service (https://api.fish.audio/*). */
function wantedOrigins(list) {
  if (!Array.isArray(list) || !list.length) return ALL_SITES.origins;
  const ok = list.filter((o) => typeof o === 'string' && /^https?:\/\/[^/*:]+\/\*$/.test(o));
  if (!ok.length) throw new Error('Invalid site access request');
  return ok;
}

/** The host permission that covers a URL: https://example.com/page → https://example.com/* (any port). */
function originPattern(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : '';
  } catch {
    return '';
  }
}

async function canReach(url) {
  if (access) return true;
  const origin = originPattern(url);
  return Boolean(origin) && chrome.permissions.contains({ origins: [origin] }).catch(() => false);
}

/* ------------------------------------------------------------ tab access */
function unreadableReason(url, tab) {
  // Without the "tabs" permission Chrome hides the URL of pages SiteVocal may not access (chrome://, new tab…).
  if (!url) {
    return tab && tab.status === 'loading'
      ? 'This tab is still loading — try again in a moment.'
      : 'This is a browser page (like chrome:// settings or the new tab page) that extensions can’t read. Open an article and try again.';
  }
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|devtools|view-source|chrome-search|chrome-untrusted|data|blob|javascript):/i.test(url)) {
    return 'Browser pages can’t be read by extensions. Open an article and try again.';
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
    return 'Extension stores block extensions from reading them.';
  }
  if (/\.pdf(?:$|[?#])/i.test(url)) return 'PDF files aren’t supported — open an HTML article instead.';
  return '';
}

function tabInfo(tab) {
  if (!tab) return null;
  const url = tab.url || tab.pendingUrl || '';
  // Without site access Chrome shows SiteVocal no tab's address except the one you clicked SiteVocal on.
  if (!url && !access && tab.status !== 'loading') {
    return { id: tab.id, windowId: tab.windowId, title: '', url: '', favIconUrl: '', readable: false, needsAccess: true, reason: 'Click the SiteVocal icon on this tab, or allow SiteVocal on all sites.' };
  }
  const reason = unreadableReason(url, tab);
  return { id: tab.id, windowId: tab.windowId, title: tab.title || '', url, favIconUrl: tab.favIconUrl || '', readable: !reason, reason };
}

async function targetTab() {
  if (surface !== 'tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }
  // Full-tab studio: read the web page you used most recently.
  const self = await chrome.tabs.getCurrent().catch(() => null);
  const tabs = (await chrome.tabs.query({})).filter((t) => !self || t.id !== self.id).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  // Without site access Chrome hides the other tabs' addresses: the most recent one gets the Allow button.
  return tabs.find((t) => /^(https?|file):/i.test(t.url || '')) || (!access && tabs.find((t) => !t.url && !t.pendingUrl)) || null;
}

function injectionError(err, url) {
  const message = (err && err.message) || String(err);
  if (/^file:/i.test(url || '')) return 'To read local files, enable “Allow access to file URLs” for SiteVocal in chrome://extensions.';
  if (/Cannot access|cannot be scripted|Missing host permission|permission/i.test(message)) return 'Chrome blocked SiteVocal from reading this page (it is protected or owned by the browser).';
  if (/No tab with id|was removed|tab was closed/i.test(message)) return 'That tab was closed or navigated away.';
  if (/error page/i.test(message)) return 'This tab is showing an error page.';
  return `SiteVocal could not read this page: ${message}`;
}

async function readTab(tabId) {
  let tab = null;
  try {
    tab = typeof tabId === 'number' ? await chrome.tabs.get(tabId) : await targetTab();
  } catch {
    throw new Error('That tab was closed or navigated away.');
  }
  if (!tab) throw new Error('There is no browser tab to read.');
  const url = tab.url || tab.pendingUrl || '';
  if (!url && !access && tab.status !== 'loading') throw needsAccess('SiteVocal can read this tab when you click its icon on it, or after you allow it on all sites.');
  const reason = unreadableReason(url, tab);
  if (reason) throw new Error(reason);
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    if (!access && !/^file:/i.test(url) && /Cannot access|Missing host permission|permission/i.test((err && err.message) || '')) throw needsAccess('SiteVocal can read this tab when you click its icon on it, or after you allow it on all sites.');
    throw new Error(injectionError(err, tab.url));
  }
  const payload = results && results[0] && results[0].result;
  if (!payload || typeof payload.html !== 'string') throw new Error('SiteVocal could not read this page. Reload the tab and try again.');
  return { tab: tabInfo(tab), payload };
}

/** Address of a page for matching open tabs: no #hash, no trailing slash, no www., no tracking parameters. */
function pageKey(value, { query = true } = {}) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  const params = [...u.searchParams].filter(([k]) => !/^(?:utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = query && params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}${q}`;
}

/** An open, loaded, readable tab showing this address: the same page, else the same host and path when neither has a query. */
async function matchTab(url) {
  const exact = pageKey(url);
  if (!exact) return null;
  const loose = pageKey(url, { query: false });
  const tabs = await chrome.tabs.query({});
  const ok = tabs.filter((t) => t.url && t.status === 'complete' && !t.discarded && !unreadableReason(t.url, t));
  const pick = (list) => list.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  const tab = pick(ok.filter((t) => pageKey(t.url) === exact)) || (exact === loose ? pick(ok.filter((t) => pageKey(t.url) === loose)) : null);
  return tab ? tabInfo(tab) : null;
}

/* -------------------------------------------------------- privileged fetch */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

/** Loopback, link-local, private-network and *.local hosts. */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  return h === '::' || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^::ffff:/.test(h);
}

async function privilegedFetch(url, as = 'text') {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only http(s) addresses can be fetched.');
  // Images (logos for colour sampling) are chosen by the page being read, not by you: fetch them without cookies
  // and never from your local network. Pages you ask SiteVocal to open keep your cookies so logged-in sites work.
  const image = as === 'dataurl';
  if (image && isPrivateHost(new URL(url).hostname)) throw new Error('Blocked: private network address');
  // No access to this site: the browser's CORS rules apply here too, so don't send a request they would block.
  if (!(await canReach(url))) throw needsAccess('SiteVocal has no access to this site yet.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), image ? 8000 : 20000);
  try {
    const res = await fetch(url, {
      credentials: image ? 'omit' : 'include',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: image ? {} : { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (image) {
      const blob = await res.blob();
      if (!/^image\//.test(blob.type) || blob.size > 2000000) throw new Error('Not a usable image');
      return { url: res.url, dataUrl: await blobToDataUrl(blob) };
    }
    const text = await res.text();
    return { url: res.url || url, status: res.status, contentType: res.headers.get('content-type') || '', text: text.slice(0, 8000000) };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('The request timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------ Chrome's built-in Summarizer (on-device) */
const AI_OPTION_KEYS = ['type', 'format', 'length', 'sharedContext', 'expectedInputLanguages', 'outputLanguage'];

function aiOptions(options) {
  const out = {};
  for (const key of AI_OPTION_KEYS) if (options && options[key] !== undefined) out[key] = options[key];
  return out;
}

/** The browser's general on-device model (the Prompt API) for one language: Gemini Nano in Chrome. */
function lmOptions(lang) {
  const l = /^[a-z]{2}$/.test(String(lang || '')) ? lang : 'en';
  return { expectedInputs: [{ type: 'text', languages: [l] }], expectedOutputs: [{ type: 'text', languages: [l] }] };
}

/** Which on-device model is ready: the general one first ("prompt"), else the Summarizer. */
async function aiAvailability(options) {
  const usable = (s) => ['available', 'downloadable', 'downloading'].includes(s);
  let best = { state: 'unavailable', kind: '' };
  const LM = globalThis.LanguageModel;
  if (LM && typeof LM.availability === 'function') {
    try {
      const state = String(await LM.availability(lmOptions(options && options.outputLanguage)));
      if (usable(state)) best = { state, kind: 'prompt' };
    } catch {
      /* no general model here */
    }
  }
  const Summarizer = globalThis.Summarizer;
  if (best.state !== 'available' && Summarizer && typeof Summarizer.availability === 'function') {
    try {
      const state = String(await Summarizer.availability(aiOptions(options)));
      if (state === 'available' || (usable(state) && !usable(best.state))) best = { state, kind: 'summarizer' };
    } catch {
      /* no summarizer either */
    }
  }
  return best;
}

/** One answer from the general model: told (system) to clean the page text, then summarize it as JSON (schema). */
async function aiPrompt({ system, text, schema, lang, timeout }) {
  const LM = globalThis.LanguageModel;
  if (!LM || typeof LM.create !== 'function') throw new Error('the browser’s on-device model is not available');
  const opts = lmOptions(lang);
  if ((await LM.availability(opts)) !== 'available') throw new Error('the browser’s on-device model is not downloaded');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(Number(timeout) || 30000, 90000));
  const session = await LM.create({ ...opts, initialPrompts: [{ role: 'system', content: String(system || '').slice(0, 4000) }], signal: ctrl.signal });
  try {
    let input = String(text || '').slice(0, 24000);
    if (typeof session.measureInputUsage === 'function' && session.inputQuota) {
      for (let i = 0; i < 6 && (await session.measureInputUsage(input)) > (session.inputQuota - (session.inputUsage || 0)) * 0.9; i++) input = input.slice(0, Math.floor(input.length * 0.7));
    }
    const constraint = schema && typeof schema === 'object' ? { responseConstraint: JSON.parse(JSON.stringify(schema)) } : {};
    return String(await session.prompt(input, { ...constraint, signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
    if (typeof session.destroy === 'function') session.destroy();
  }
}

/** Download the on-device model (needs the click's user activation): the general model, else the Summarizer. */
async function aiDownload({ lang }) {
  const LM = globalThis.LanguageModel;
  if (LM && typeof LM.create === 'function') {
    const session = await LM.create(lmOptions(lang));
    if (typeof session.destroy === 'function') session.destroy();
    return aiAvailability({ outputLanguage: lang });
  }
  const Summarizer = globalThis.Summarizer;
  if (Summarizer && typeof Summarizer.create === 'function') {
    const s = await Summarizer.create({ type: 'key-points', format: 'plain-text', length: 'medium' });
    if (typeof s.destroy === 'function') s.destroy();
    return aiAvailability({});
  }
  throw new Error('this browser has no built-in AI model');
}

/** Key points for each section text; never starts a model download (that needs a click in a Chrome tab). */
async function aiSummarize({ options, texts, contexts, timeout }) {
  const Summarizer = globalThis.Summarizer;
  if (!Summarizer || typeof Summarizer.create !== 'function') throw new Error('Chrome’s on-device summarizer is not available');
  const opts = aiOptions(options);
  if ((await Summarizer.availability(opts)) !== 'available') throw new Error('Chrome’s on-device model is not downloaded');
  const started = Date.now();
  const limit = Math.min(Number(timeout) || 30000, 60000);
  const summarizer = await Summarizer.create(opts);
  const out = [];
  try {
    for (let i = 0; i < Math.min((texts || []).length, 12); i++) {
      if (Date.now() - started > limit) break;
      out.push(await summarizer.summarize(String(texts[i]).slice(0, 8000), { context: String((contexts && contexts[i]) || '').slice(0, 400) }));
    }
  } finally {
    if (typeof summarizer.destroy === 'function') summarizer.destroy();
  }
  return out;
}

/* ------------------------------------------- optional Turbo Engine requests */
const FISH_TTS = 'https://api.fish.audio/v1/tts';
const JINA = 'https://r.jina.ai/';
const TINYFISH = 'https://api.fetch.tinyfish.ai';
const TURBO_HEADERS = new Set(['authorization', 'content-type', 'model', 'accept', 'x-api-key']);

/** https, or plain http only to a server on this computer or your own network: keys and text travel encrypted. */
function secureEndpoint(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || (u.protocol === 'http:' && isPrivateHost(u.hostname));
  } catch {
    return false;
  }
}

/** The endpoints the user saved together with a key — the only places a Turbo request may go. */
function turboEndpoints() {
  let cfg = {};
  try {
    cfg = JSON.parse(localStorage.getItem('sitevocal_turbo') || '{}') || {};
  } catch {
    cfg = {};
  }
  const key = (k) => typeof cfg[k] === 'string' && cfg[k].trim().length > 0;
  const urls = new Set();
  if (cfg.voice === 'fish' && key('fishKey')) urls.add(FISH_TTS);
  if (cfg.voice === 'openai' && key('ttsKey') && secureEndpoint(cfg.ttsUrl)) urls.add(cfg.ttsUrl.trim());
  if (cfg.llm === 'openai' && key('llmKey') && secureEndpoint(cfg.llmUrl)) urls.add(cfg.llmUrl.trim());
  if (cfg.reader === 'jina' && key('jinaKey')) urls.add(JINA);
  if (cfg.reader === 'tinyfish' && key('tinyfishKey')) urls.add(TINYFISH);
  return urls;
}

async function turboFetch({ url, headers, body, as }) {
  if (!turboEndpoints().has(String(url || ''))) throw new Error('Turbo Engine is off (no key saved for that endpoint)');
  const clean = {};
  for (const [k, v] of Object.entries(headers || {})) if (TURBO_HEADERS.has(k.toLowerCase())) clean[k] = String(v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(url, { method: 'POST', headers: clean, body: String(body || ''), credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    if (as === 'audio') {
      const blob = await res.blob();
      if (blob.size > 12000000) return { ok: false, error: 'audio too large' };
      return { ok: true, type: blob.type || 'audio/mpeg', data: await blob.arrayBuffer() };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'timed out' };
    // Blocked before any answer: a service that refuses browser calls (CORS) until you let SiteVocal reach it.
    if (!(await canReach(url))) return { ok: false, code: 'needs-access', origins: [originPattern(url)], error: `SiteVocal needs your OK to reach ${new URL(url).hostname}` };
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------- toolbar / context-menu / shortcut */
async function takePending() {
  if (!chrome.storage || !chrome.storage.session) return null;
  const data = await chrome.storage.session.get(PENDING_KEY).catch(() => ({}));
  const request = data && data[PENDING_KEY];
  if (!request || Date.now() - (request.at || 0) > 30000) return null;
  if (surface === 'sidepanel' && request.windowId != null && windowId != null && request.windowId !== windowId) return null;
  await chrome.storage.session.remove(PENDING_KEY).catch(() => {});
  return request;
}

function forward(request) {
  if (!request || (request.id && request.id === lastRequestId)) return;
  if (!initialized) {
    queued.push(request);
    return;
  }
  lastRequestId = request.id || '';
  post({ type: 'request', request });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.type === 'sitevocal:dom-changed') {
    // From content.js in a tab SiteVocal read: the studio decides whether it is the tab now playing.
    if (initialized && sender && sender.id === chrome.runtime.id && sender.tab && typeof sender.tab.id === 'number') {
      post({ type: 'dom:changed', tabId: sender.tab.id, reason: String(message.reason || '').slice(0, 20), url: String(message.url || '').slice(0, 2000), title: String(message.title || '').slice(0, 300) });
    }
    return;
  }
  if (message.type !== 'sitevocal:request' || !message.request || surface === 'tab') return;
  const request = message.request;
  if (surface === 'sidepanel' && request.windowId != null && windowId != null && request.windowId !== windowId) return;
  if (chrome.storage && chrome.storage.session) chrome.storage.session.remove(PENDING_KEY).catch(() => {});
  forward(request);
});

/* ----------------------------------------------------- live tab tracking */
async function pushTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !initialized) return;
  if (surface === 'tab' ? !/^(https?|file):/i.test(tab.url || '') : windowId != null && tab.windowId !== windowId) return;
  const info = tabInfo(tab);
  const json = JSON.stringify(info);
  if (json === lastTabJson) return;
  lastTabJson = json;
  post({ type: 'tab:changed', tab: info });
}

chrome.tabs.onActivated.addListener(({ tabId }) => pushTab(tabId));

// Access given or taken back (here, or in chrome://extensions): the studio updates, and tab addresses appear.
async function accessChanged() {
  access = await chrome.permissions.contains(ALL_SITES).catch(() => false);
  if (!initialized) return;
  const tab = tabInfo(await targetTab().catch(() => null));
  lastTabJson = JSON.stringify(tab);
  post({ type: 'access:changed', access, tab });
}
chrome.permissions.onAdded.addListener(accessChanged);
chrome.permissions.onRemoved.addListener(accessChanged);
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && (change.status === 'complete' || change.title || change.favIconUrl || change.url)) pushTab(tabId);
});

// Another SiteVocal surface (popup, side panel in another window, full tab) changed the library.
window.addEventListener('storage', (event) => {
  if (initialized && event.key && event.key.startsWith(PREFIX)) post({ type: 'storage:changed', key: event.key, value: event.newValue });
});

// "Forget what I listened to when I close SiteVocal" (Your data): erased as this panel, tab or popup closes.
window.addEventListener('pagehide', () => {
  let settings = null;
  try {
    settings = JSON.parse(localStorage.getItem('sitevocal_settings') || 'null');
  } catch {
    settings = null;
  }
  if (!settings || settings.forgetOnClose !== true) return;
  closing = true;
  for (const key of Object.keys(snapshot())) if (FORGET.test(key)) localStorage.removeItem(key);
});
window.addEventListener('pageshow', (event) => {
  // Back from the browser's page cache after that: start again, clean, rather than show what was erased.
  if (event.persisted && closing) location.reload();
});
