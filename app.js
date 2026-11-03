(() => {
  'use strict';

  /* ==========================================================================
   * SiteVocal — Website-to-Speech Studio
   * Zero API keys, zero remote code. index.html + app.js + vendor/ run as a web
   * app (double-click index.html) and, unchanged, as the sandboxed UI of the
   * SiteVocal Chrome extension (panel.html hosts this page and bridges tab
   * access + storage) under the MV3 sandbox policy script-src 'self'.
   * ======================================================================== */

  const VERSION = '2.8.0';
  const DEFAULT_TITLE = document.title;
  const KEYS = {
    library: 'sitevocal_library',
    settings: 'sitevocal_settings',
    doc: 'sitevocal_doc_',
    lexicon: 'sitevocal_lexicon',
    clips: 'sitevocal_clips',
    queue: 'sitevocal_queue',
    stats: 'sitevocal_stats',
    turbo: 'sitevocal_turbo',
  };
  const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const DEFAULT_ACCENT = [122, 28, 36]; // SiteVocal burgundy: used until a website's own brand colour is known
  const FALLBACK_ACCENT = [16, 185, 129]; // SiteVocal emerald: a page that shows no brand colour of its own
  // Browser defaults (link blue, visited purple, active red): what an unstyled page shows, not the site's brand.
  const UA_COLORS = new Set(['0,0,238', '85,26,139', '238,0,0']);
  const MAX_ENTRIES = 60;
  const MAX_CLIPS = 200;
  const MAX_QUEUE = 50;
  const DOC_BUDGET = 2400000; // characters of article text kept for instant, offline resume
  const CHUNK_MAX = 150; // ≈10 s of speech: safely under Chrome's ~15 s utterance cut-off
  const CHUNK_MIN = 40;
  const DEFAULT_CPS = 14.5; // characters per second at 1× (≈155 words per minute)

  const DEMOS = {
    wikipedia: 'https://en.wikipedia.org/wiki/Speech_synthesis',
    paulgraham: 'https://paulgraham.com/greatwork.html',
    hackernews: 'https://news.ycombinator.com/',
    company: 'https://hotragn.github.io/sitevocal/', // SiteVocal's own product homepage → a Site Briefing
  };

  // Free public CORS proxies, tried in order after a direct fetch.
  const PROXIES = [
    { name: 'allorigins.win', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'corsproxy.io', build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
    { name: 'codetabs.com', build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  ];

  /* ------------------------------------------------------------------ utils */
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /**
   * Let the browser paint (a new loading stage) before a long synchronous task: at most one frame. A hidden page
   * paints nothing and its timers run at most once a second, so there it does not wait (an Up Next page that loads
   * while you listen from another tab).
   */
  const yieldFrame = () =>
    document.hidden
      ? Promise.resolve()
      : new Promise((resolve) => {
          let done = false;
          const go = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
          setTimeout(go, 32);
        });
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const countWords = (text) => (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const trimText = (text, max) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
  };
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function safeHttpUrl(value, base) {
    if (!value || typeof value !== 'string') return '';
    try {
      const url = base ? new URL(value.trim(), base) : new URL(value.trim());
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function safeImageUrl(value, base) {
    if (typeof value === 'string' && /^data:image\/[a-z0-9.+-]+[;,]/i.test(value.trim())) return value.trim();
    return safeHttpUrl(value, base);
  }

  function normalizeUrl(input) {
    let text = String(input || '').trim();
    if (!text || /\s/.test(text)) return '';
    if (!/^[a-z][a-z\d+.-]*:/i.test(text)) {
      if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(text)) return '';
      text = `https://${text}`;
    }
    try {
      const url = new URL(text);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid)$/i.test(key)) url.searchParams.delete(key);
      }
      return url.href;
    } catch {
      return '';
    }
  }

  const bareHost = (host) => String(host || '').toLowerCase().replace(/^(www\d?|m|mobile|amp)\./, '');
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  // The last-resort logo: Google's favicon service, which learns the domain. Never in the extension, whose
  // Chrome Web Store disclosures list no such service: there a missing logo is a letter tile.
  const s2Favicon = (host) => (Host.mode === 'extension' ? '' : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);

  function siteLabel(host) {
    const parts = bareHost(host).split('.').filter(Boolean);
    if (parts.length < 2) return parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : 'Website';
    const secondLevel = parts.length > 2 && /^(co|com|org|net|gov|ac|edu|ne|or)$/.test(parts[parts.length - 2]);
    const label = parts[parts.length - (secondLevel ? 3 : 2)];
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function normLang(code) {
    const c = String(code || '').trim().replace('_', '-');
    if (!c || c === 'simple') return c ? 'en' : '';
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(c) ? c : '';
  }

  function langName(code) {
    try {
      return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(String(code).split('-')[0]) || code;
    } catch {
      return code;
    }
  }

  const fmtNumber = (n) => new Intl.NumberFormat().format(n);

  function fmtClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function fmtListen(minutes) {
    if (minutes < 0.75) return 'less than a minute';
    const m = Math.max(1, Math.round(minutes));
    if (m < 60) return plural(m, 'minute');
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return `${plural(h, 'hour')}${rest ? ` and ${plural(rest, 'minute')}` : ''}`;
  }

  function fmtAgo(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 45) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    if (d < 604800) return `${Math.round(d / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function agoSpoken(unixSeconds) {
    const d = Math.max(0, Date.now() / 1000 - unixSeconds);
    if (d < 3600) return `${plural(Math.max(1, Math.round(d / 60)), 'minute')} ago`;
    if (d < 86400) return `${plural(Math.round(d / 3600), 'hour')} ago`;
    return `${plural(Math.round(d / 86400), 'day')} ago`;
  }

  /* ------------------------------------------------------------------ icons
   * Lucide icons (ISC licence, https://lucide.dev), embedded as inline SVG so
   * they render offline and inside the extension sandbox.                   */
  const ICONS = {
    'app-window': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    'audio-lines': '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
    'building-2': '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
    'book-open': '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
    'clipboard-paste': '<path d="M11 14h10"/><path d="M16 4h2a2 2 0 0 1 2 2v1.344"/><path d="m17 18 4-4-4-4"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'cloud': '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    'code': '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    'cpu': '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'download': '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'file-text': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    'filter': '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
    'gauge': '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    'globe': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    'headphones': '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    'history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    'keyboard': '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    'languages': '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    'layers': '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    'library-big': '<rect width="8" height="18" x="3" y="3" rx="1"/><path d="M7 3v18"/><path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>',
    'link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'list-checks': '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
    'list-music': '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
    'list-plus': '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
    'list-tree': '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'locate-fixed': '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'mic': '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
    'mouse-pointer-click': '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    'palette': '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
    'panel-left': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    'pause': '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    'pen-line': '<path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    'play': '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'podcast': '<path d="M12 17v4"/><path d="M18 11a6 6 0 00-3-5.197"/><path d="M2 11a10 10 0 015-8.662"/><path d="M22 11a10 10 0 00-5-8.662"/><path d="M6 11a6 6 0 013-5.197"/><path d="M9 21h6"/><rect x="10" y="9" width="4" height="8" rx="2"/>',
    'puzzle': '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
    'quote': '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
    'radio': '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'rocket': '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'scissors': '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    'scroll-text': '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    'search': '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    'skip-back': '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"/><path d="M3 20V4"/>',
    'skip-forward': '<path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/>',
    'sparkles': '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
    'square-arrow-out-up-right': '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>',
    'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    'table': '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
    'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'volume-2': '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'zap': '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
  };
  const GITHUB_PATH = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

  function icon(name, cls = 'size-5') {
    if (name === 'github') return `<svg class="${cls}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="${GITHUB_PATH}"/></svg>`;
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }

  function hydrateIcons(root = document) {
    for (const el of root.querySelectorAll('i[data-icon]')) el.outerHTML = icon(el.dataset.icon, el.getAttribute('class') || 'size-5');
  }

  /* ------------------------------------------------------- extension bridge
   * In the extension, panel.html embeds this page as a sandboxed iframe and
   * hands it a MessageChannel port: tab extraction, privileged fetch and
   * storage go through it. On the open web it simply stays in "web" mode.  */
  const Host = {
    mode: 'web',
    surface: 'web',
    port: null,
    seq: 0,
    waiting: new Map(),
    handlers: {},
    init: null,

    connect(timeoutMs = 3500) {
      const wanted = new URLSearchParams(location.search).get('host') === 'extension' && window.parent !== window;
      if (!wanted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const nonce = Math.random().toString(36).slice(2);
        let settled = false;
        let hello = 0;
        const finish = (init) => {
          if (settled) return;
          settled = true;
          clearInterval(hello);
          window.removeEventListener('message', onMessage);
          resolve(init);
        };
        const onMessage = (event) => {
          const data = event.data;
          if (event.source !== window.parent || !data || data.sv !== 1 || data.type !== 'connect' || data.nonce !== nonce || !event.ports || !event.ports[0]) return;
          clearInterval(hello);
          this.port = event.ports[0];
          this.onInit = finish;
          this.port.onmessage = (e) => this.dispatch(e.data);
        };
        window.addEventListener('message', onMessage);
        const sayHello = () => window.parent.postMessage({ sv: 1, type: 'hello', nonce }, '*');
        sayHello();
        hello = setInterval(sayHello, 300);
        setTimeout(() => finish(null), timeoutMs);
      });
    },

    dispatch(msg) {
      if (!msg || msg.sv !== 1) return;
      if (msg.type === 'init') {
        this.mode = 'extension';
        this.surface = msg.surface || 'sidepanel';
        this.init = msg;
        if (this.onInit) {
          const done = this.onInit;
          this.onInit = null;
          done(msg);
        }
        return;
      }
      if (msg.type === 'reply') {
        const pending = this.waiting.get(msg.id);
        if (!pending) return;
        this.waiting.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(Object.assign(new Error(msg.error || 'The extension could not complete that request.'), msg.code ? { code: msg.code } : {}));
        return;
      }
      const handler = this.handlers[msg.type];
      if (handler) handler(msg);
    },

    request(type, data = {}, timeoutMs = 30000) {
      if (!this.port) return Promise.reject(new Error('Extension bridge unavailable'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error(`The extension did not answer (${type}).`));
        }, timeoutMs);
        this.waiting.set(id, { resolve, reject, timer });
        this.port.postMessage({ sv: 1, id, type, ...data });
      });
    },

    send(type, data = {}) {
      if (this.port) this.port.postMessage({ sv: 1, type, ...data });
    },

    on(type, handler) {
      this.handlers[type] = handler;
    },
  };

  /* ---------------------------------------------------------------- storage */
  const Store = {
    backend: 'memory',
    mem: new Map(),
    frozen: false, // after Clear everything, or "forget" on close: nothing is written again in this page's life

    init(snapshot) {
      if (Host.mode === 'extension') {
        this.backend = 'bridge';
        for (const [k, v] of Object.entries(snapshot || {})) if (typeof v === 'string') this.mem.set(k, v);
        return;
      }
      try {
        localStorage.setItem('sitevocal_probe', '1');
        localStorage.removeItem('sitevocal_probe');
        this.backend = 'local';
      } catch {
        this.backend = 'memory';
      }
    },
    get(key) {
      if (this.backend === 'local') {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      }
      return this.mem.has(key) ? this.mem.get(key) : null;
    },
    freeze() {
      this.frozen = true;
    },
    set(key, value) {
      if (this.frozen) return false;
      if (this.backend === 'local') {
        try {
          localStorage.setItem(key, value);
          return true;
        } catch {
          return false;
        }
      }
      this.mem.set(key, value);
      if (this.backend === 'bridge') {
        Host.request('storage:set', { key, value }, 15000).catch((err) => {
          if (/quota/i.test(err.message) && key.startsWith(KEYS.doc)) {
            this.mem.delete(key);
            Library.markDocMissing(key.slice(KEYS.doc.length));
          }
        });
      }
      return true;
    },
    remove(key) {
      if (this.frozen) return;
      if (this.backend === 'local') {
        try {
          localStorage.removeItem(key);
        } catch {
          /* storage unavailable */
        }
        return;
      }
      this.mem.delete(key);
      if (this.backend === 'bridge') Host.send('storage:remove', { key });
    },
    keys() {
      if (this.backend !== 'local') return [...this.mem.keys()];
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
      } catch {
        /* storage unavailable */
      }
      return out;
    },
    getJSON(key, fallback) {
      const raw = this.get(key);
      if (raw == null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    setJSON(key, value) {
      return this.set(key, JSON.stringify(value));
    },
  };

  const FILTERS = { code: true, tables: true, citations: true, lexicon: true };

  const Settings = {
    data: { voiceURI: 'auto', rate: 1, libOpen: null, filters: { ...FILTERS }, outlineOpen: null, autoAdvance: true, forgetOnClose: false, dataNoticeSeen: false, pageServicesOk: false },
    load() {
      const saved = Store.getJSON(KEYS.settings, {});
      if (saved && typeof saved === 'object') {
        if (typeof saved.voiceURI === 'string') this.data.voiceURI = saved.voiceURI;
        if (RATES.includes(Number(saved.rate))) this.data.rate = Number(saved.rate);
        if (typeof saved.libOpen === 'boolean') this.data.libOpen = saved.libOpen;
        if (typeof saved.outlineOpen === 'boolean') this.data.outlineOpen = saved.outlineOpen;
        if (typeof saved.autoAdvance === 'boolean') this.data.autoAdvance = saved.autoAdvance;
        if (typeof saved.forgetOnClose === 'boolean') this.data.forgetOnClose = saved.forgetOnClose;
        if (typeof saved.dataNoticeSeen === 'boolean') this.data.dataNoticeSeen = saved.dataNoticeSeen;
        if (typeof saved.pageServicesOk === 'boolean') this.data.pageServicesOk = saved.pageServicesOk;
        if (saved.filters && typeof saved.filters === 'object') {
          for (const key of Object.keys(FILTERS)) if (typeof saved.filters[key] === 'boolean') this.data.filters[key] = saved.filters[key];
        }
      }
    },
    set(patch) {
      Object.assign(this.data, patch);
      Store.setJSON(KEYS.settings, this.data);
    },
    setFilter(key, on) {
      if (!(key in FILTERS)) return;
      this.set({ filters: { ...this.data.filters, [key]: Boolean(on) } });
    },
  };

  /* ------------------------------------------------- small persistent lists
   * Clipped quotes, the "Up Next" queue and lifetime telemetry live in their
   * own keys so other tabs and extension surfaces can merge them cheaply.  */
  const Clips = {
    list() {
      const list = Store.getJSON(KEYS.clips, []);
      return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string') : [];
    },
    add(clip) {
      const list = this.list().filter((c) => !(c.text === clip.text && c.url === clip.url));
      list.unshift(clip);
      Store.setJSON(KEYS.clips, list.slice(0, MAX_CLIPS));
      return clip;
    },
    remove(id) {
      Store.setJSON(KEYS.clips, this.list().filter((c) => c.id !== id));
    },
    clear() {
      Store.setJSON(KEYS.clips, []);
    },
  };

  const Queue = {
    list() {
      const list = Store.getJSON(KEYS.queue, []);
      return Array.isArray(list) ? list.filter((q) => q && typeof q.key === 'string' && (q.id || q.url)) : [];
    },
    save(list) {
      Store.setJSON(KEYS.queue, list.slice(0, MAX_QUEUE));
    },
    keyOf(item) {
      return item.id ? `id:${item.id}` : `url:${item.url}`;
    },
    has(id) {
      return this.list().some((q) => q.id === id);
    },
    add(item) {
      const entry = { ...item, key: '', addedAt: Date.now() };
      entry.key = this.keyOf(entry);
      const list = this.list();
      if (list.some((q) => q.key === entry.key || (entry.url && q.url === entry.url))) return false;
      list.push(entry);
      this.save(list);
      return true;
    },
    remove(key) {
      this.save(this.list().filter((q) => q.key !== key));
    },
    /** Drop whatever is now playing from the queue (by library id or URL). */
    removeEntry(id, url) {
      const list = this.list();
      const next = list.filter((q) => q.id !== id && !(url && q.url && normalizeUrl(q.url) === normalizeUrl(url)));
      if (next.length !== list.length) this.save(next);
    },
    move(key, dir) {
      const list = this.list();
      const i = list.findIndex((q) => q.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      this.save(list);
    },
    shift() {
      const list = this.list();
      const first = list.shift() || null;
      this.save(list);
      return first;
    },
    clear() {
      this.save([]);
    },
  };

  /** Lifetime telemetry for the privacy panel: words actually spoken, ads and clutter stripped. */
  const Stats = {
    get() {
      const s = Store.getJSON(KEYS.stats, {});
      return {
        words: Number(s && s.words) || 0,
        ads: Number(s && s.ads) || 0,
        clutter: Number(s && s.clutter) || 0,
        pages: Number(s && s.pages) || 0,
      };
    },
    add(patch) {
      const s = this.get();
      for (const [k, v] of Object.entries(patch)) s[k] = (s[k] || 0) + (Number(v) || 0);
      Store.setJSON(KEYS.stats, s);
      return s;
    },
  };

  /* ---------------------------------------------------------------- library
   * sitevocal_library  → list of saved websites (logo, title, accent, progress)
   * sitevocal_doc_<id> → the cleaned article, so a card resumes instantly.  */
  const Library = {
    entries: [],
    removed: new Set(), // ids deleted in this tab: never resurrect them while merging

    load() {
      const list = Store.getJSON(KEYS.library, []);
      this.entries = Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && e.title) : [];
      this.sort();
    },
    sort() {
      this.entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    persist() {
      this.merge();
      if (Store.setJSON(KEYS.library, this.entries)) return;
      this.evictDocs(2);
      Store.setJSON(KEYS.library, this.entries);
    },
    /** Fold in entries another tab or extension surface wrote since we loaded; the newest updatedAt wins. */
    merge() {
      const stored = Store.getJSON(KEYS.library, []);
      if (!Array.isArray(stored) || !stored.length) return;
      const mine = new Map(this.entries.map((e) => [e.id, e]));
      let changed = false;
      for (const s of stored) {
        if (!s || typeof s.id !== 'string' || !s.title || this.removed.has(s.id)) continue;
        const m = mine.get(s.id);
        if (!m) {
          this.entries.push(s);
          changed = true;
        } else if ((s.updatedAt || 0) > (m.updatedAt || 0)) {
          Object.assign(m, s);
          changed = true;
        }
      }
      if (changed) {
        this.sort();
        for (const old of this.entries.splice(MAX_ENTRIES)) Store.remove(KEYS.doc + old.id);
      }
    },
    get(id) {
      return this.entries.find((e) => e.id === id) || null;
    },
    upsert(entry) {
      this.removed.delete(entry.id);
      const i = this.entries.findIndex((e) => e.id === entry.id);
      if (i >= 0) this.entries[i] = { ...this.entries[i], ...entry };
      else this.entries.unshift(entry);
      this.sort();
      for (const old of this.entries.splice(MAX_ENTRIES)) Store.remove(KEYS.doc + old.id);
      this.persist();
      return this.get(entry.id);
    },
    patch(id, patch, persist = true) {
      const e = this.get(id);
      if (!e) return null;
      Object.assign(e, patch);
      if (persist) this.persist();
      return e;
    },
    remove(id) {
      this.removed.add(id);
      this.entries = this.entries.filter((e) => e.id !== id);
      Store.remove(KEYS.doc + id);
      this.persist();
    },
    clear() {
      for (const e of this.entries) {
        this.removed.add(e.id);
        Store.remove(KEYS.doc + e.id);
      }
      this.entries = [];
      this.persist();
    },
    getDoc(id) {
      const doc = Store.getJSON(KEYS.doc + id, null);
      return doc && Array.isArray(doc.blocks) ? doc : null;
    },
    putDoc(id, doc) {
      const json = JSON.stringify(doc);
      if (json.length > DOC_BUDGET * 0.6) return false;
      this.trimDocs(json.length, id);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (Store.set(KEYS.doc + id, json)) return true;
        if (!this.evictDocs(1, id)) break;
      }
      return false;
    },
    markDocMissing(id) {
      const e = this.get(id);
      if (e && e.hasDoc) {
        e.hasDoc = false;
        this.persist();
      }
    },
    trimDocs(incoming, keepId) {
      let total = incoming;
      const sizes = new Map();
      for (const key of Store.keys()) {
        if (!key || !key.startsWith(KEYS.doc)) continue;
        const size = (Store.get(key) || '').length;
        sizes.set(key.slice(KEYS.doc.length), size);
        total += size;
      }
      for (let i = this.entries.length - 1; i >= 0 && total > DOC_BUDGET; i--) {
        const e = this.entries[i];
        if (e.id === keepId || !sizes.has(e.id)) continue;
        total -= sizes.get(e.id);
        Store.remove(KEYS.doc + e.id);
        e.hasDoc = false;
      }
    },
    evictDocs(count, keepId) {
      let n = 0;
      for (let i = this.entries.length - 1; i >= 0 && n < count; i--) {
        const e = this.entries[i];
        if (e.id === keepId || !e.hasDoc) continue;
        Store.remove(KEYS.doc + e.id);
        e.hasDoc = false;
        n++;
      }
      return n > 0;
    },
  };

  /* ---------------------------------------------------------- colour engine */
  const Color = {
    ctx: null,
    parse(input) {
      if (!input) return null;
      if (Array.isArray(input)) return input.length >= 3 ? input.slice(0, 3).map((n) => clamp(Math.round(Number(n) || 0), 0, 255)) : null;
      const s = String(input).trim();
      let m = s.match(/^#([0-9a-f]{3,8})$/i);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
        if (h.length !== 6 && h.length !== 8) return null;
        if (h.length === 8 && parseInt(h.slice(6, 8), 16) < 128) return null;
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      }
      m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
      if (m) {
        if (m[4] !== undefined) {
          const alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          if (alpha < 0.5) return null;
        }
        return [m[1], m[2], m[3]].map((n) => clamp(Math.round(Number(n)), 0, 255));
      }
      if (!this.ctx) this.ctx = document.createElement('canvas').getContext('2d');
      if (!this.ctx) return null;
      this.ctx.fillStyle = '#010203';
      this.ctx.fillStyle = s;
      const out = this.ctx.fillStyle;
      if (out === '#010203' && s.toLowerCase() !== '#010203') return null;
      return /^#[0-9a-f]{6}$/i.test(out) || /^rgba?\(/i.test(out) ? this.parse(out) : null;
    },
    toHsl([r, g, b]) {
      const R = r / 255;
      const G = g / 255;
      const B = b / 255;
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const l = (max + min) / 2;
      let h = 0;
      let s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
        else if (max === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
      }
      return [h, s, l];
    },
    fromHsl([h, s, l]) {
      const hue = ((h % 360) + 360) % 360;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
      const m = l - c / 2;
      let rgb;
      if (hue < 60) rgb = [c, x, 0];
      else if (hue < 120) rgb = [x, c, 0];
      else if (hue < 180) rgb = [0, c, x];
      else if (hue < 240) rgb = [0, x, c];
      else if (hue < 300) rgb = [x, 0, c];
      else rgb = [c, 0, x];
      return rgb.map((v) => Math.round((v + m) * 255));
    },
    isColorful(rgb) {
      if (!rgb) return false;
      const [, s, l] = this.toHsl(rgb);
      return s >= 0.22 && l >= 0.12 && l <= 0.92;
    },
    hex(rgb) {
      return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    },
    /** WCAG relative luminance and contrast ratio. */
    luminance(rgb) {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    },
    contrast(a, b) {
      const [hi, lo] = [this.luminance(a), this.luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    /** The brand hue at the lightest shade that still reads as text on white (≥ 4.6:1). */
    inkOnWhite(h, s) {
      const white = [255, 255, 255];
      for (let l = 0.42; l > 0.12; l -= 0.02) {
        const rgb = this.fromHsl([h, s, l]);
        if (this.contrast(rgb, white) >= 4.6) return rgb;
      }
      return this.fromHsl([h, s, 0.12]);
    },
    /** Dominant saturated colour of an image (favicon/logo). Null if tainted or monochrome. */
    dominant(src, timeout = 4000) {
      return new Promise((resolve) => {
        if (!src) return resolve(null);
        const img = new Image();
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeout);
        if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.onload = () => {
          clearTimeout(timer);
          try {
            const size = 40;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, size, size);
            const { data } = ctx.getImageData(0, 0, size, size);
            const buckets = new Map();
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] < 160) continue;
              const rgb = [data[i], data[i + 1], data[i + 2]];
              const [h, s, l] = this.toHsl(rgb);
              if (s < 0.25 || l < 0.12 || l > 0.9) continue;
              const key = Math.round(h / 20) % 18;
              const w = s * (1 - Math.abs(l - 0.5));
              const b = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
              b.w += w;
              b.r += rgb[0] * w;
              b.g += rgb[1] * w;
              b.b += rgb[2] * w;
              buckets.set(key, b);
            }
            let best = null;
            for (const b of buckets.values()) if (!best || b.w > best.w) best = b;
            finish(best && best.w > 2 ? [best.r / best.w, best.g / best.w, best.b / best.w].map(Math.round) : null);
          } catch {
            finish(null);
          }
        };
        img.onerror = () => {
          clearTimeout(timer);
          finish(null);
        };
        img.src = src;
      });
    },
  };

  const Theme = {
    accent: DEFAULT_ACCENT,
    /**
     * Chameleon identity: the website's own brand colour, used only where that site is shown
     * (identity ribbon, site label, logo glow, its library card). SiteVocal's chrome keeps its fixed palette.
     */
    apply(rgb, mono = false) {
      let accent;
      let accent2;
      let ink;
      const [h0, s0, l0] = Color.toHsl(rgb || DEFAULT_ACCENT);
      if (mono || s0 < 0.12) {
        accent = [71, 85, 105];
        accent2 = [100, 116, 139];
        ink = [51, 65, 85];
      } else {
        const s = clamp(s0, 0.55, 0.95);
        accent = Color.fromHsl([h0, s, clamp(l0, 0.52, 0.66)]);
        accent2 = Color.fromHsl([h0 + 38, clamp(s, 0.6, 0.9), 0.6]);
        ink = Color.inkOnWhite(h0, clamp(s, 0.55, 0.9));
      }
      this.set(accent, accent2, ink);
      this.accent = accent;
      return accent;
    },
    set(accent, accent2, ink) {
      const root = document.documentElement.style;
      root.setProperty('--sv-accent', accent.join(' '));
      root.setProperty('--sv-accent-2', accent2.join(' '));
      root.setProperty('--sv-accent-ink', ink.join(' '));
      const label = document.getElementById('dossierAccent'); // the Site Briefing sheet names the brand colour
      if (label) label.textContent = Color.hex(accent).toUpperCase();
    },
    reset() {
      this.set(DEFAULT_ACCENT, [158, 54, 62], DEFAULT_ACCENT);
      this.accent = DEFAULT_ACCENT;
      return DEFAULT_ACCENT;
    },
  };

  // Brand names & colours for popular sites that ship no <meta name="theme-color">.
  const KNOWN = [
    [/(^|\.)wikipedia\.org$/, { name: 'Wikipedia', color: '#3366cc', author: 'Wikipedia contributors' }],
    [/(^|\.)paulgraham\.com$/, { name: 'Paul Graham', author: 'Paul Graham' }],
    [/^news\.ycombinator\.com$/, { name: 'Hacker News', color: '#ff6600' }],
    [/(^|\.)bbc\.(co\.uk|com)$/, { name: 'BBC', color: '#bb1919' }],
    [/(^|\.)theverge\.com$/, { name: 'The Verge', color: '#5200ff' }],
    [/(^|\.)theguardian\.com$/, { name: 'The Guardian', color: '#052962' }],
    [/(^|\.)arstechnica\.com$/, { name: 'Ars Technica', color: '#ff4e00' }],
    [/(^|\.)reuters\.com$/, { name: 'Reuters', color: '#ff8000' }],
    [/(^|\.)cnn\.com$/, { name: 'CNN', color: '#cc0000' }],
    [/(^|\.)economist\.com$/, { name: 'The Economist', color: '#e3120b' }],
    [/(^|\.)arxiv\.org$/, { name: 'arXiv', color: '#b31b1b' }],
    [/(^|\.)stackoverflow\.com$/, { name: 'Stack Overflow', color: '#f48024' }],
    [/(^|\.)substack\.com$/, { color: '#ff6719' }],
    [/(^|\.)nytimes\.com$/, { name: 'The New York Times' }],
    [/(^|\.)medium\.com$/, { name: 'Medium' }],
    [/(^|\.)github\.(com|blog)$/, { name: 'GitHub' }],
    [/^developer\.mozilla\.org$/, { name: 'MDN Web Docs' }],
    [/(^|\.)techcrunch\.com$/, { name: 'TechCrunch' }],
    [/(^|\.)wired\.com$/, { name: 'WIRED' }],
  ];
  const knownSite = (host) => {
    const h = bareHost(host);
    for (const [re, info] of KNOWN) if (re.test(h)) return info;
    return null;
  };

  /* --------------------------------------------------------------- fetching */
  function abortError() {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }

  async function fetchWithTimeout(url, { timeout = 15000, signal, ...options } = {}) {
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw abortError();
      signal.addEventListener('abort', relay, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }

  const looksLikeHtml = (text) => typeof text === 'string' && text.length > 200 && /<(html|head|body|article|main|p|div|br|font|table)[\s>/]/i.test(text);
  const BOT_TITLE = /^\s*(?:just a moment|attention required|access denied|request unsuccessful|are you a robot|security check|pardon our interruption|verify you are human|checking your browser|ddos-guard)/i;
  const BOT_MARKERS = /(cf-browser-verification|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com\/turnstile|captcha-delivery\.com|px-captcha|_Incapsula_Resource|cf_chl_opt)/i;
  const looksBlocked = (text) => {
    if (typeof text !== 'string' || text.length > 150000) return false;
    const title = ((text.match(/<title[^>]*>([^<]{0,200})<\/title>/i) || [])[1] || '').trim();
    return (title.length < 45 && BOT_TITLE.test(title)) || (text.length < 60000 && BOT_MARKERS.test(text));
  };

  /** <meta http-equiv="refresh" content="0; url=…"> on a page with (almost) no text of its own → the target URL. */
  function metaRefreshTarget(html, base) {
    if (typeof html !== 'string' || html.length > 250000 || !/http-equiv\s*=\s*["']?refresh/i.test(html)) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tag = [...doc.querySelectorAll('meta[http-equiv]')].find((m) => /^\s*refresh\s*$/i.test(m.getAttribute('http-equiv') || ''));
    const m = tag && String(tag.getAttribute('content') || '').match(/^\s*(\d+(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"\s]+)/i);
    if (!m || Number(m[1]) > 10) return '';
    doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
    if ((doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim().length > 400) return '';
    const target = safeHttpUrl(m[2], base);
    return target && normalizeUrl(target) !== normalizeUrl(base) ? target : '';
  }

  /** Readable characters in an HTML string. An app shell (<div id="__next"></div> and a script) has almost none. */
  function proseChars(html) {
    if (typeof html !== 'string') return 0;
    return html
      .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, 'x')
      .replace(/\s+/g, ' ')
      .trim().length;
  }
  const RICH_CHARS = 200; // fewer readable characters than this: an app shell that builds itself with JavaScript
  // A link-shortener stub can be tiny: it is still usable when all it carries is a meta refresh.
  const usablePage = (text) => (looksLikeHtml(text) || (typeof text === 'string' && /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(text))) && !looksBlocked(text);

  /** A route's failure, worded for the error card ("allorigins.win: HTTP 502"). */
  function routeError(message) {
    const err = new Error(message);
    err.route = true;
    return err;
  }

  /** GET a URL as text: the direct fetch and the raw-HTML proxies. */
  async function getText(target, signal, timeout, { direct = false } = {}) {
    let res;
    try {
      res = await fetchWithTimeout(target, { timeout, signal, credentials: 'omit' });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw routeError(err && err.name === 'AbortError' ? 'timed out' : direct ? 'blocked by the browser (no CORS headers)' : 'network error');
    }
    if (!res.ok) throw routeError(`HTTP ${res.status}`);
    // A proxy's own address is never the page's: only the direct fetch knows where redirects ended.
    return { html: await res.text(), finalUrl: direct ? res.url || '' : '' };
  }

  /* ------------------------------------------------------- page readers
   * r.jina.ai renders a page in a real browser (JavaScript included) and returns it as Markdown: free, no key,
   * about 20 pages a minute. With your own key (Docs & Lexicon › Turbo Engine) it allows more, and TinyFish Fetch
   * can be used instead. Only the page address is sent. */
  const JINA = 'https://r.jina.ai/';
  const TINYFISH = 'https://api.fetch.tinyfish.ai';
  const Reader = {
    /** Keyless r.jina.ai. `Accept: application/json` is a simple header, so a browser sends it without a preflight. */
    async jina(url, signal) {
      let res;
      try {
        res = await fetchWithTimeout(`${JINA}${url.replace(/#.*$/, '')}`, { timeout: 15000, signal, credentials: 'omit', headers: { Accept: 'application/json' } });
      } catch (err) {
        if (signal && signal.aborted) throw err;
        throw routeError(err && err.name === 'AbortError' ? 'timed out' : 'network error');
      }
      if (res.status === 429) throw routeError('busy (20 pages a minute without a key)');
      if (!res.ok) throw routeError(`HTTP ${res.status}`);
      return this.page(this.parseJina(await res.text(), url), 'r.jina.ai');
    },

    /** r.jina.ai or TinyFish with your own key, through the Turbo Engine gate (never without a key). */
    async keyed(kind, url, signal) {
      const data = await Turbo.reader(kind, url, signal).catch((err) => {
        if (signal && signal.aborted) throw err;
        // In the extension, your key's service may need your OK first: offered once; the keyless reader carries on.
        const allow = !this.asked && Ext.reachAction(err);
        if (allow) {
          this.asked = true;
          UI.toast(`Your ${kind === 'tinyfish' ? 'TinyFish' : 'r.jina.ai'} key is not used yet: SiteVocal needs your OK to reach that service.`, { type: 'info', timeout: 6000, action: allow });
        }
        throw routeError((err && err.message) || 'request failed');
      });
      if (kind === 'tinyfish') {
        const hit = data && Array.isArray(data.results) ? data.results.find((r) => r && typeof r.text === 'string') : null;
        if (!hit) throw routeError((data && data.errors && data.errors[0] && (data.errors[0].error || data.errors[0].message)) || 'no content');
        return this.page({ title: String(hit.title || ''), description: String(hit.description || ''), url: safeHttpUrl(hit.final_url || hit.url) || url, markdown: hit.text, published: '' }, 'TinyFish Fetch');
      }
      return this.page(this.parseJina(data, url), 'r.jina.ai');
    },

    /** Both of r.jina.ai's answers: JSON ({ data: { title, description, url, content } }, or the same fields at
     *  the top level) and text ("Title: …", "URL Source: …", "Markdown Content:" then the page). */
    parseJina(body, url) {
      const str = (v) => (typeof v === 'string' ? v : '');
      let j = body && typeof body === 'object' ? body : null;
      const text = j ? '' : String(body || '');
      if (!j && /^\s*\{/.test(text)) {
        try {
          j = JSON.parse(text);
        } catch {
          j = null;
        }
      }
      if (j) {
        const d = j.data && typeof j.data === 'object' ? j.data : j;
        if (!str(d.content) && typeof j.code === 'number' && j.code >= 400) throw routeError(str(j.message) || str(j.readableMessage) || `HTTP ${j.code}`);
        return { title: str(d.title), description: str(d.description), url: safeHttpUrl(str(d.url)) || url, markdown: str(d.content), published: str(d.publishedTime) };
      }
      const m = text.match(/^([\s\S]*?)\n[ \t]*Markdown Content:[ \t]*\n([\s\S]*)$/);
      const head = m ? m[1] : '';
      const field = (name) => ((head.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'm')) || [])[1] || '').trim();
      return { title: field('Title'), description: '', url: safeHttpUrl(field('URL Source')) || url, markdown: m ? m[2] : text, published: field('Published Time') };
    },

    /** Lines a rendered page carries that the site's own markup would have marked as chrome (banners, footers). */
    tidy(md) {
      return String(md || '')
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          if (!t || t.length > 400) return true;
          if (/^\[?skip to (?:main )?content\b/i.test(t)) return false;
          if (/\b(?:we|this (?:site|website)|our (?:site|website)) uses? cookies\b|\bcookie (?:settings|preferences|policy)\b.*\baccept\b/i.test(t)) return false;
          if ((/^(?:©|\(c\)|copyright\b)/i.test(t.replace(/^[*_]+/, '')) || /\ball rights reserved\b/i.test(t)) && t.length < 200) return false;
          return true;
        })
        .join('\n');
    },

    /** The reader's Markdown as an ordinary HTML page, so every mode reads it like the site itself. */
    page(r, via) {
      const head = [
        '<meta charset="utf-8">',
        `<title>${esc(r.title)}</title>`,
        r.description ? `<meta name="description" content="${esc(r.description)}">` : '',
        r.published ? `<meta property="article:published_time" content="${esc(r.published)}">` : '',
        `<link rel="canonical" href="${esc(r.url)}">`,
      ].join('');
      return { html: `<!DOCTYPE html><html><head>${head}</head><body><main>${Markdown.toHtml(this.tidy(r.markdown))}</main></body></html>`, finalUrl: r.url, via, reader: true };
    },
  };

  const READER_AT = 220; // ms: when the page reader joins, unless an app shell or tier 1's failures call it sooner

  /**
   * The page reader, which renders a page before reading it: r.jina.ai (keyless, or with your key), or TinyFish
   * with your key. TinyFish has keyless r.jina.ai only as its fallback (`after`), never beside it.
   */
  function readerRoutes(url, at) {
    const kind = Turbo.readerKind();
    const keyless = { name: 'r.jina.ai', at, reader: true, run: (signal) => Reader.jina(url, signal) };
    if (kind === 'jina') return [{ name: 'r.jina.ai', label: 'r.jina.ai (your key)', at, reader: true, run: (signal) => Reader.keyed('jina', url, signal) }];
    if (kind === 'tinyfish') return [{ name: 'TinyFish Fetch', label: 'TinyFish Fetch (your key)', at, reader: true, run: (signal) => Reader.keyed('tinyfish', url, signal) }, { ...keyless, at: Infinity, after: 'TinyFish Fetch' }];
    return [keyless];
  }

  /**
   * Every route to a pasted page, in two tiers (see Fetcher.race); `at` is when a route starts (ms). Tier 1, at
   * once: the direct fetch and both allorigins.win endpoints, which return the site's own HTML. Tier 2, the page
   * reader, starts only when tier 1 cannot do the job: an app shell arrives, every tier-1 route has failed, or
   * nothing readable has come back within 220 ms. A server-rendered page that arrives first never reaches the
   * reader, so its address stays private and the reader's quota (20 pages a minute without a key) is kept for
   * the pages that need it. codetabs joins at 350 ms and corsproxy.io (often 401 now) at 2.5 s; a route also
   * starts early when every route already started has failed.
   */
  function fetchRoutes(url) {
    const enc = encodeURIComponent(url);
    return [
      { name: 'direct fetch', label: 'Direct', at: 0, run: (signal) => getText(url, signal, 1800, { direct: true }) },
      { name: 'allorigins.win', at: 0, run: (signal) => getText(PROXIES[0].build(url), signal, 9000) },
      {
        name: 'allorigins.win',
        label: 'allorigins.win (JSON)',
        at: 0,
        // /get wraps the page in JSON, which gets past sites that block the /raw endpoint's headers.
        run: async (signal) => {
          const r = await getText(`https://api.allorigins.win/get?url=${enc}`, signal, 9000);
          let data = null;
          try {
            data = JSON.parse(r.html);
          } catch {
            return r;
          }
          const status = (data && data.status) || {};
          if (status.http_code >= 400) throw routeError(`HTTP ${status.http_code}`);
          return { html: data && typeof data.contents === 'string' ? data.contents : '', finalUrl: safeHttpUrl(status.url) || '' };
        },
      },
      ...readerRoutes(url, READER_AT),
      { name: 'codetabs.com', at: 350, run: (signal) => getText(PROXIES[2].build(url), signal, 9000) },
      { name: 'corsproxy.io', at: 2500, run: (signal) => getText(PROXIES[1].build(url), signal, 9000) },
    ];
  }

  const Fetcher = {
    /**
     * The page's HTML, fast: in the extension the privileged fetch comes first (your cookies, no third party).
     * When it returns only an app shell, the page reader is asked at once, in one hop: the proxies would return
     * the same shell. Otherwise (the web app, or a failed fetch) every route races and the first readable page wins.
     */
    async html(url, { signal, onStatus } = {}) {
      const attempts = [];
      if (Host.mode === 'extension') {
        onStatus?.('Fetching with the extension’s permissions…');
        try {
          const r = await Host.request('fetch', { url, as: 'text' }, 25000);
          if (usablePage(r.text)) {
            const page = { html: r.text, finalUrl: r.url || url, via: 'SiteVocal extension' };
            if (proseChars(r.text) >= RICH_CHARS || !looksLikeHtml(r.text)) return page;
            // Only an app shell: the reader renders the real page. The shell stays the fallback.
            attempts.push('Extension fetch: only an app shell (the page builds itself with JavaScript)');
            const routes = readerRoutes(url, 0);
            const pending = this.race(url, { signal, onStatus, attempts, fallback: page, routes });
            onStatus?.(`Only an app shell — ${routes[0].name} is rendering the page…`);
            return pending;
          }
          attempts.push('Extension fetch: the response was not a readable page');
        } catch (err) {
          if (signal?.aborted) throw abortError();
          attempts.push(err.code === 'needs-access' ? 'Extension fetch: no access to this site yet (Allow all sites to load pages straight from your browser)' : `Extension fetch: ${err.message}`);
        }
      }
      try {
        return await this.race(url, { signal, onStatus, attempts });
      } catch (err) {
        // You allowed all sites instead of the page services: the page now loads straight from your browser.
        if (err && err.code === 'access-granted' && Ext.access) return this.html(url, { signal, onStatus });
        throw err;
      }
    },

    /**
     * Parallel, staggered race (Promise.any with a twist): the first readable, content-rich page wins and every
     * other request is aborted at once. An app shell (< 200 readable characters) never wins on its own: it calls
     * the page reader in at once, is kept while the reader works, and is used only if nothing better arrives. A
     * rendered page that wins while raw-HTML routes are still on their way waits 300 ms for them (they carry the
     * site's logo, colours and JSON-LD). A route with `after` starts only once that route has failed, and one
     * with `accept` wins only with a page that passes it (a raw-HTML page that fails it counts as a shell).
     */
    race(url, { signal, onStatus, attempts = [], fallback = null, routes = fetchRoutes(url) } = {}) {
      if (signal && signal.aborted) return Promise.reject(abortError());
      // In the extension without site access, the first link asks before any page service sees an address.
      if (PageServices.needed()) return PageServices.ask(url, signal).then(() => this.race(url, { signal, onStatus, attempts, fallback, routes }));
      const lose = new AbortController();
      const t0 = performance.now();
      let best = fallback;
      let bestChars = fallback ? proseChars(fallback.html) : -1;
      let held = null;
      let sawShell = Boolean(fallback); // a raw route returned an app shell: the raw HTML will not get better
      let launched = 0;
      let settled = 0;
      const timers = [];
      return new Promise((resolve, reject) => {
        let done = false;
        const onAbort = () => end(reject, abortError());
        const end = (fn, value) => {
          if (done) return;
          done = true;
          timers.forEach(clearTimeout);
          lose.abort();
          if (signal) signal.removeEventListener('abort', onAbort);
          fn(value);
        };
        const win = (page) => end(resolve, { ...page, ms: Math.round(performance.now() - t0) });
        const rawPending = () => !sawShell && routes.some((r) => !r.reader && r.started && !r.done);
        const settle = () => {
          settled++;
          if (done) return;
          if (held && !rawPending()) return win(held);
          if (settled === routes.length) {
            if (held || best) return win(held || best);
            const err = new Error('SiteVocal could not fetch this page through any route.');
            err.attempts = attempts;
            return end(reject, err);
          }
          if (settled === launched) {
            // Everything started so far has failed: start the next route now instead of at its slot.
            const next = routes.find((r) => !r.started);
            if (next) start(next);
          }
        };
        const start = (route) => {
          if (done || route.started) return;
          route.started = true;
          launched++;
          Promise.resolve()
            .then(() => route.run(lose.signal))
            .then(
              (page) => {
                if (done) return;
                const html = page && page.html;
                if (!usablePage(html)) {
                  attempts.push(`${route.label || route.name}: ${looksBlocked(html) ? 'the site served a bot check' : 'empty or non-HTML response'}`);
                  return;
                }
                const found = { html, finalUrl: page.finalUrl || url, via: page.via || route.name, reader: Boolean(route.reader) };
                const fit = !route.accept || route.accept(html);
                if (!fit) attempts.push(`${route.label || route.name}: ${route.unfit || 'not the page that was asked for'}`);
                const chars = fit ? proseChars(html) : 0;
                if (chars >= RICH_CHARS || (fit && !looksLikeHtml(html))) {
                  route.ok = true;
                  if (!route.reader || !rawPending()) return win(found);
                  if (!held) {
                    held = found;
                    timers.push(setTimeout(() => !done && win(held), 300));
                  }
                  return;
                }
                if (fit && chars > bestChars) {
                  best = found;
                  bestChars = chars;
                }
                if (route.reader) return;
                sawShell = true;
                // The site builds itself with JavaScript: the raw HTML will not get better, so the reader starts now.
                const readers = routes.filter((r) => r.reader && r.at !== Infinity && !r.started);
                readers.forEach(start);
                const reader = routes.find((r) => r.reader && r.started && !r.done);
                onStatus?.(`Only an app shell from ${route.name} — waiting for ${reader ? reader.name : 'a page reader'} to render the page…`);
              },
              (err) => {
                if (done || lose.signal.aborted) return;
                attempts.push(`${route.label || route.name}: ${(err && err.message) || 'network error'}`);
              },
            )
            .finally(() => {
              route.done = true;
              if (!done && !route.ok) routes.filter((r) => r.after === route.name).forEach(start);
              settle();
            });
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        onStatus?.(`Connecting · ${[...new Set(routes.filter((r) => r.at <= 0).map((r) => r.name))].join(', ')}…`);
        for (const r of routes) {
          if (r.at <= 0) start(r);
          else if (Number.isFinite(r.at)) timers.push(setTimeout(() => start(r), r.at));
        }
      });
    },

    async json(url, { signal, timeout = 12000 } = {}) {
      const res = await fetchWithTimeout(url, { timeout, signal, credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },

    /** An image as a data: URL (so the canvas can read it) — via the extension or a proxy. */
    async imageData(url) {
      if (!url || url.startsWith('data:')) return url;
      if (Host.mode === 'extension') {
        try {
          const r = await Host.request('fetch', { url, as: 'dataurl' }, 9000);
          return r && r.dataUrl ? r.dataUrl : null;
        } catch (err) {
          if (!err || err.code !== 'needs-access') return null; // no access to that site: fetched the website's way
        }
      }
      try {
        const res = await fetchWithTimeout(PROXIES[0].build(url), { timeout: 6000, credentials: 'omit' });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (!/^image\//.test(blob.type) || blob.size > 1500000) return null;
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    },
  };

  /* ---------------------------------------------------------- Markdown → HTML
   * READMEs (GitHub's raw fallback, file views) and r.jina.ai's rendered pages arrive as Markdown. Headings,
   * paragraphs, nested lists, pipe tables, code fences, block quotes and rules become real elements, so the
   * Ad-Shield, Readability, Site Briefing and Summarize Page read them like any page. Menus (lists and lines
   * that are only links) become <nav>, which every mode skips. The result is parsed inertly (DOMParser) and
   * only its text is ever shown or spoken, so inline HTML in a README is kept as it is. */
  const MD_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const MD_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const MD_RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const MD_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
  const MD_TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
  const MD_HTML_BLOCK = /^ {0,3}<(?:!--|\/?(?:address|article|aside|blockquote|br|center|details|dialog|div|dl|figure|figcaption|footer|h[1-6]|header|hr|img|li|main|nav|ol|p|picture|pre|section|summary|table|tbody|td|th|thead|tr|ul|video|a|kbd|sup|sub)\b)/i;
  const MD_INLINE_TAG = /^<\/?(?:a|abbr|b|br|code|del|em|i|img|kbd|mark|picture|s|samp|small|source|span|strong|sub|sup|u|var)\b[^<>]*>/i;

  const Markdown = {
    toHtml(src) {
      const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
      return this.blocks(lines).join('\n');
    },

    /** Plain text (a .txt file, reStructuredText): paragraphs only, nothing interpreted. */
    paragraphs(src) {
      return String(src || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map((p) => `<p>${esc(p)}</p>`)
        .join('\n');
    },

    blocks(lines) {
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // Blank lines, and link reference definitions ("[1]: https://…"), which are never read.
        if (!line.trim() || /^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) {
          i++;
          continue;
        }
        const fence = line.match(MD_FENCE);
        if (fence) {
          const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
          const code = [];
          i++;
          while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
          i++;
          const lang = fence[2] ? ` class="language-${esc(fence[2].toLowerCase())}"` : '';
          out.push(`<pre><code${lang}>${esc(code.join('\n'))}</code></pre>`);
          continue;
        }
        const heading = line.match(MD_HEADING);
        if (heading) {
          const n = heading[1].length;
          const text = (heading[2] || '').trim();
          if (text) out.push(`<h${n}>${this.inline(text)}</h${n}>`);
          i++;
          continue;
        }
        if (MD_RULE.test(line)) {
          out.push('<hr>');
          i++;
          continue;
        }
        if (/^ {0,3}>/.test(line)) {
          const quote = [];
          while (i < lines.length && lines[i].trim() && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
          // GitHub alerts: "> [!NOTE]" is said "Note:".
          if (quote.length) quote[0] = quote[0].replace(/^\[!(note|tip|important|warning|caution)\]\s*/i, (m, kind) => `**${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}:** `);
          out.push(`<blockquote>${this.blocks(quote).join('\n')}</blockquote>`);
          continue;
        }
        if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-') && MD_TABLE_SEP.test(lines[i + 1])) {
          const head = this.cells(line);
          const align = this.cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(this.cells(lines[i++]));
          const th = head.map((c, j) => `<th${align[j] ? ` align="${align[j]}"` : ''}>${this.inline(c)}</th>`).join('');
          const body = rows.map((r) => `<tr>${head.map((_, j) => `<td>${this.inline(r[j] || '')}</td>`).join('')}</tr>`).join('');
          out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
          continue;
        }
        if (MD_ITEM.test(line) && !MD_RULE.test(line)) {
          const start = i;
          i = this.listEnd(lines, i);
          out.push(this.list(lines.slice(start, i)));
          continue;
        }
        if (MD_HTML_BLOCK.test(line)) {
          const html = [];
          while (i < lines.length && lines[i].trim()) html.push(lines[i++]);
          out.push(html.join('\n'));
          continue;
        }
        // A paragraph: lines up to a blank line or the start of another block (a setext underline makes it a heading).
        const para = [];
        while (i < lines.length && lines[i].trim()) {
          const l = lines[i];
          if (para.length && /^ {0,3}(=+|-+)\s*$/.test(l)) {
            const n = l.trim()[0] === '=' ? 1 : 2;
            out.push(`<h${n}>${this.inline(para.join(' ').trim())}</h${n}>`);
            para.length = 0;
            i++;
            break;
          }
          if (para.length && (MD_FENCE.test(l) || MD_HEADING.test(l) || /^ {0,3}>/.test(l) || (MD_ITEM.test(l) && !/^ {4,}/.test(l)) || MD_HTML_BLOCK.test(l))) break;
          para.push(l);
          i++;
        }
        if (para.length) out.push(this.paragraph(para));
      }
      return out;
    },

    paragraph(lines) {
      const html = lines.map((l, k) => this.inline(l.trim().replace(/\\$/, '')) + (k < lines.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l)) ? '<br>' : '')).join(' ');
      return this.linksOnly(html) ? `<nav><p>${html}</p></nav>` : `<p>${html}</p>`;
    },

    /** "| a | b |" → ["a", "b"], keeping escaped pipes and pipes inside `code`. */
    cells(line) {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
      const out = [];
      let cur = '';
      let code = false;
      for (let k = 0; k < s.length; k++) {
        const ch = s[k];
        if (ch === '\\' && s[k + 1] === '|') {
          cur += '|';
          k++;
        } else if (ch === '`') {
          code = !code;
          cur += ch;
        } else if (ch === '|' && !code) {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    },

    /** Where a list ends: list items, their indented continuation lines, and blank lines between them. */
    listEnd(lines, i) {
      let k = i + 1;
      while (k < lines.length) {
        const l = lines[k];
        if (!l.trim()) {
          let n = k + 1;
          while (n < lines.length && !lines[n].trim()) n++;
          if (n < lines.length && (MD_ITEM.test(lines[n]) || /^ {2,}\S/.test(lines[n]))) {
            k = n;
            continue;
          }
          break;
        }
        if (MD_ITEM.test(l) || /^ {2,}\S/.test(l)) {
          k++;
          continue;
        }
        if (MD_HEADING.test(l) || MD_FENCE.test(l) || MD_RULE.test(l) || /^ {0,3}>/.test(l)) break;
        k++; // a lazy continuation line of the last item
      }
      return k;
    },

    /** Nested lists by indentation. Task-list boxes are dropped; a list of nothing but links becomes a <nav>. */
    list(lines) {
      const root = { items: [], indent: -1 };
      const stack = [root];
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = l.match(MD_ITEM);
        if (m && !MD_RULE.test(l)) {
          const indent = m[1].length;
          const ordered = /\d/.test(m[2]);
          while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
          const parent = stack[stack.length - 1];
          const holder = parent === root ? root : parent.item;
          if (!holder.lists) holder.lists = [];
          let target = holder.lists[holder.lists.length - 1];
          if (!target || target.ordered !== ordered) {
            target = { ordered, items: [] };
            holder.lists.push(target);
          }
          const item = { text: (m[3] || '').replace(/^\[[ xX]\]\s+/, ''), lists: null };
          target.items.push(item);
          stack.push({ indent, item });
        } else {
          const top = stack[stack.length - 1];
          if (top.item) top.item.text += ` ${l.trim()}`;
        }
      }
      const render = (list) => {
        const tag = list.ordered ? 'ol' : 'ul';
        const items = list.items.map((it) => `<li>${this.inline(it.text.trim())}${(it.lists || []).map(render).join('')}</li>`);
        const html = `<${tag}>${items.join('')}</${tag}>`;
        const flat = list.items.every((it) => !it.lists);
        return flat && list.items.length >= 3 && list.items.every((it) => this.linksOnly(this.inline(it.text.trim()))) ? `<nav>${html}</nav>` : html;
      };
      return (root.lists || []).map(render).join('\n');
    },

    /** True when a fragment is links and nothing else (a menu, a breadcrumb, a footer row). */
    linksOnly(html) {
      if (!/<a\s/i.test(html)) return false;
      const rest = html.replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[\s|·•,/–—-]+/g, '');
      return rest.length <= 2;
    },

    /** Inline Markdown: code, images, links, emphasis. Known inline tags pass through; any other < or & is escaped. */
    inline(text) {
      let s = String(text || '');
      const keep = [];
      const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
      s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => hold(`<code>${esc(code.trim())}</code>`));
      s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (m, alt, src) => {
        const url = safeHttpUrl(src);
        return hold(url ? `<img src="${esc(url)}" alt="${esc(alt.replace(/^Image \d+:\s*/i, ''))}">` : '');
      });
      s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (m, label, href) => {
        const url = safeHttpUrl(href);
        return hold(url ? `<a href="${esc(url)}">` : '<a>') + label + hold('</a>');
      });
      s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (m, url) => hold(`<a href="${esc(url)}">${esc(url)}</a>`));
      s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
      s = s.replace(/<[^<>]*>/g, (tag) => (MD_INLINE_TAG.test(tag) || /^<!--[\s\S]*-->$/.test(tag) ? hold(tag) : tag));
      s = s.replace(/&(?![a-z][a-z0-9]{1,31};|#\d{1,7};|#x[0-9a-f]{1,6};)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      s = s
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, '$1<em>$2</em>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
      return s.replace(/\u0000(\d+)\u0000/g, (m, n) => keep[Number(n)]);
    },
  };
  /* ---------------------------------------------------------------- cleaning */
  // Citation markers: [12], [3–5], [a], [iv], [note 2] and Wikipedia's "[citation needed]" family.
  const CITE_MARK = /\[(?:\d{1,4}(?:\s*[,–—-]\s*\d{1,4})*|[a-z]|[ivx]{1,6}|(?:note|nb|n|lower-alpha)\s*\d{1,3})\]/gi;
  const CITE_TAG = /\[((?:citation|clarification|better source|verification|page|according to whom|by whom|who|when|where|which|dubious|vague|unreliable source|full citation|needs update|original research|failed verification)[^\]]{0,40})\]/gi;
  const EMOJI_RUN = /(?:[\p{Extended_Pictographic}\p{Regional_Indicator}](?:\uFE0F|⃣|[\u{1F3FB}-\u{1F3FF}]|\u200D[\p{Extended_Pictographic}\p{Regional_Indicator}])*\s*)+/gu;
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Shared whitespace and punctuation-spacing tidy-up. */
  const tidy = (text) =>
    text
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/[ \t\f\v\r\n\u00A0\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, ' ')
      .replace(/\s+([,.;:!?%)\]])/g, '$1')
      .replace(/([([])\s+/g, '$1')
      .trim();

  const Clean = {
    /** What the teleprompter shows: no raw URLs, edit links, invisible characters or stray whitespace. */
    display(text) {
      return tidy(
        String(text || '')
          .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
          .replace(/\[(?:edit|update)\]/gi, '')
          .replace(/\bhttps?:\/\/[^\s<>"'()[\]]+[^\s<>"'()[\].,;:!?]/gi, '')
          .replace(/\bwww\.[a-z\d-]+(?:\.[a-z\d-]+)+[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?]/gi, ''),
      );
    },

    /** Skip Citations: drop citation brackets from the screen and the voice. */
    citations(text) {
      return tidy(String(text || '').replace(CITE_MARK, '').replace(CITE_TAG, ''));
    },

    /** Markdown and chat-style noise that a voice would otherwise read out. */
    markdown(text) {
      return text
        .replace(/\[([^\]\n]{1,200})\]\((?:[^)\s]{1,500})\)/g, '$1')
        .replace(/(\*\*|__)(?=\S)([^*_\n]{1,300}?\S)\1/g, '$2')
        .replace(/~~(?=\S)([^~\n]{1,300}?\S)~~/g, '$1')
        .replace(/`([^`\n]{1,200})`/g, '$1')
        .replace(/(^|[\s(])\*(?=[^\s*])([^*\n]{1,200}?[^\s*])\*(?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/^\s*(?:#{1,6}|>|[-*+])\s+/, '')
        .replace(/(^|\s)#{1,6}\s+(?=\S)/g, '$1');
    },

    /**
     * What the voice hears. Citations left on screen are announced rather than mumbled as bare numbers;
     * with Smart Lexicon on, the pronunciation dictionary, abbreviation expansions, emoji and markdown
     * clean-up apply. With it off the voice reads the text exactly as shown.
     */
    speech(text, { lexicon = true } = {}) {
      let s = String(text || '')
        .replace(/\[(\d{1,4}(?:\s*[,–—-]\s*\d{1,4})*)\]/g, (m, n) => ` citation ${n.replace(/\s*[–—-]\s*/g, ' to ').replace(/\s*,\s*/g, ', ')},`)
        .replace(CITE_TAG, (m, inner) => ` ${inner},`);
      if (!lexicon) return s.replace(/\s{2,}/g, ' ').replace(/,(\s*[.!?])/g, '$1').replace(/^[\s,]+|[\s,]+$/g, '');
      s = Lexicon.apply(this.markdown(s));
      return s
        .replace(EMOJI_RUN, ' ')
        .replace(/\be\.g\.,?(?=\s|$)/gi, 'for example,')
        .replace(/\bi\.e\.,?(?=\s|$)/gi, 'that is,')
        .replace(/\bet\s+al\.(?=\s+\p{Lu}|\s*$)/gu, 'and colleagues.')
        .replace(/\bet\s+al\.?(?=[\s,;:)]|$)/gi, 'and colleagues')
        .replace(/\b(f)igs\.\s*(?=\d)/gi, (m, f) => `${f === 'F' ? 'F' : 'f'}igures `)
        .replace(/\b(f)ig\.\s*(?=\d)/gi, (m, f) => `${f === 'F' ? 'F' : 'f'}igure `)
        .replace(/\bcf\.(?=\s)/gi, 'compare')
        .replace(/\bpp\.\s*(?=\d)/g, 'pages ')
        .replace(/\bp\.\s*(?=\d)/g, 'page ')
        .replace(/\b(v)ol\.\s*(?=\d)/gi, (m, v) => `${v === 'V' ? 'V' : 'v'}olume `)
        .replace(/\b(c)h\.\s*(?=\d)/gi, (m, c) => `${c === 'C' ? 'C' : 'c'}hapter `)
        .replace(/\b(e)q\.\s*(?=\d)/gi, (m, e) => `${e === 'E' ? 'E' : 'e'}quation `)
        .replace(/\b(n)o\.\s*(?=\d)/gi, (m, n) => `${n === 'N' ? 'N' : 'n'}umber `)
        .replace(/\betc\.(?=\s+[A-Z])/g, 'et cetera.')
        .replace(/\betc\./gi, 'et cetera')
        .replace(/\bvs\.?(?=\s)/gi, 'versus')
        .replace(/\bapprox\.(?=\s)/gi, 'approximately')
        // Prices per period: "$7.90/yr" → "$7.90 a year" (never "24/7", which has a number after the slash).
        .replace(/(\d)\s?\/\s?(?:yr|year)\b\.?/gi, '$1 a year')
        .replace(/(\d)\s?\/\s?(?:mo|mon|month)\b\.?/gi, '$1 a month')
        .replace(/(\d)\s?\/\s?(?:wk|week)\b\.?/gi, '$1 a week')
        .replace(/(\d)\s?\/\s?(?:day)\b/gi, '$1 a day')
        .replace(/(\d)\s?\/\s?(?:hr|hour)\b\.?/gi, '$1 an hour')
        .replace(/\bw\/o\b/gi, 'without')
        .replace(/\bw\/(?=\s)/gi, 'with')
        .replace(/\band\/or\b/gi, 'and or')
        .replace(/(\d)\s?[–—]\s?(\d)/g, '$1 to $2')
        .replace(/\s[–—]\s|—/g, ', ')
        .replace(/\s*&\s*/g, ' and ')
        .replace(/[•·▪●◦‣∙|]+/g, ', ')
        .replace(/([!?.])\1{2,}/g, '$1')
        .replace(/\s+,/g, ',')
        .replace(/,(\s*,)+/g, ',')
        .replace(/,(\s*[.!?])/g, '$1')
        .replace(/^[\s,]+/, '')
        .replace(/[\s,]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    },

    sentences(text, lang) {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        try {
          const out = [];
          for (const s of new Intl.Segmenter(lang || 'en', { granularity: 'sentence' }).segment(text)) out.push([s.index, s.index + s.segment.length]);
          if (out.length) return this.keepBrackets(text, out);
        } catch {
          /* unsupported locale — fall back to the regex splitter */
        }
      }
      const out = [];
      const re = /[.!?…。！？]+["'”’)\]]*\s+/g;
      let start = 0;
      let m;
      while ((m = re.exec(text))) {
        const end = m.index + m[0].length;
        out.push([start, end]);
        start = end;
      }
      if (start < text.length) out.push([start, text.length]);
      return out;
    },

    /** ICU breaks "speech.[1] A" inside the marker ("speech.[" | "1] A"): move such a break past the "]". */
    keepBrackets(text, ranges) {
      const out = [];
      for (const r of ranges) {
        const last = out[out.length - 1];
        if (last && r[0] < last[1]) {
          if (r[1] > last[1]) out.push([last[1], r[1]]);
          continue;
        }
        out.push([r[0], r[1]]);
        const end = r[1];
        const open = text.lastIndexOf('[', end - 1);
        if (open < 0 || end - open > 16 || text.lastIndexOf(']', end - 1) > open) continue;
        const close = text.indexOf(']', end);
        if (close < 0 || close - end > 16) continue;
        let cut = close + 1;
        while (cut < text.length && /\s/.test(text[cut])) cut++;
        out[out.length - 1][1] = cut;
      }
      return out.filter(([s, e]) => e > s);
    },

    /** Sentence-sized chunks (≤ CHUNK_MAX chars): the fix for Chrome's 15-second cut-off. */
    chunks(text, lang) {
      const pieces = [];
      for (const [s, e] of this.sentences(text, lang)) {
        if (e - s <= CHUNK_MAX) {
          pieces.push([s, e]);
          continue;
        }
        let a = s;
        while (e - a > CHUNK_MAX) {
          const win = text.slice(a, a + CHUNK_MAX);
          let cut = -1;
          const clause = /[,;:)\]–—](?=\s)/g;
          let m;
          while ((m = clause.exec(win))) if (m.index >= CHUNK_MAX * 0.35) cut = m.index + 1;
          if (cut < 0) {
            const space = win.lastIndexOf(' ');
            cut = space > CHUNK_MAX * 0.35 ? space : CHUNK_MAX;
          }
          let b = a + cut;
          while (b < e && /\s/.test(text[b])) b++;
          pieces.push([a, b]);
          a = b;
        }
        if (a < e) pieces.push([a, e]);
      }
      const merged = [];
      for (const p of pieces) {
        const last = merged[merged.length - 1];
        if (last && (p[1] - p[0] < CHUNK_MIN || last[1] - last[0] < CHUNK_MIN) && p[1] - last[0] <= CHUNK_MAX) last[1] = p[1];
        else merged.push([p[0], p[1]]);
      }
      return merged.filter(([s, e]) => text.slice(s, e).trim());
    },
  };

  /* ------------------------------------------------- pronunciation dictionary
   * sitevocal_lexicon → [{ from, to }]: whole-word, case-sensitive replacements
   * applied to speech only (the teleprompter keeps the original spelling).  */
  const LEXICON_SEED = [
    { from: 'SQL', to: 'Sequel' },
    { from: 'arXiv', to: 'archive' },
    { from: 'CLI', to: 'C L I' },
    { from: 'WCAG', to: 'W C A G' },
    { from: 'iOS', to: 'i O S' },
  ];

  const Lexicon = {
    entries: [],
    re: null,
    map: new Map(),

    load() {
      const saved = Store.getJSON(KEYS.lexicon, null);
      const list = Array.isArray(saved) ? saved : LEXICON_SEED;
      this.entries = list.map((e) => this.clean(e)).filter(Boolean);
      this.compile();
    },
    clean(e) {
      if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') return null;
      const from = e.from.replace(/\s+/g, ' ').trim().slice(0, 60);
      const to = e.to.replace(/\s+/g, ' ').trim().slice(0, 120);
      return from && /[\p{L}\p{N}]/u.test(from) ? { from, to } : null;
    },
    save() {
      Store.setJSON(KEYS.lexicon, this.entries);
      this.compile();
    },
    add(from, to) {
      const entry = this.clean({ from, to });
      if (!entry) return null;
      this.entries = [entry, ...this.entries.filter((e) => e.from !== entry.from)];
      this.save();
      return entry;
    },
    remove(from) {
      this.entries = this.entries.filter((e) => e.from !== from);
      this.save();
    },
    reset() {
      this.entries = LEXICON_SEED.map((e) => ({ ...e }));
      this.save();
    },
    compile() {
      // Longest first, so "SQL Server" wins over "SQL".
      const list = [...this.entries].sort((a, b) => b.from.length - a.from.length);
      this.map = new Map(list.map((e) => [e.from, e.to]));
      this.re = list.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${list.map((e) => escapeRe(e.from)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null;
    },
    apply(text) {
      if (!this.re) return text;
      return text.replace(this.re, (m) => (this.map.has(m) ? this.map.get(m) : m));
    },
  };

  function cleanSiteName(name) {
    return trimText(String(name || '').replace(/^(www\.)/i, '').replace(/\s*[|·•–—-]\s*.*$/, ''), 48);
  }

  function cleanTitle(title, siteName) {
    let t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    // "(3) Inbox" / "(1) Ada on X: …": a notification count is not part of the title.
    t = t.replace(/^\(\d{1,4}\+?\)\s+/, '');
    // Social posts: "Ada Lovelace on X: "The post's own words" / X" → the post's words (not whoever posted it).
    const post = t.match(/^.{1,60}? on (?:X|Twitter|Threads|Bluesky|LinkedIn|Instagram|Facebook)\s*:\s*["“](.+?)["”]\s*(?:\/\s*(?:X|Twitter)|[|·•–—-]\s*\S.*)?$/);
    if (post) t = post[1].trim();
    const site = norm(siteName);
    const matches = (part) => {
      const p = norm(part);
      return Boolean(site) && Boolean(p) && (p === site || (p.length > 2 && (site.includes(p) || p.includes(site))));
    };
    const parts = t.split(/\s+[|–—·•]\s+|\s+-\s+|\s+::\s+/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (matches(last)) t = t.slice(0, t.lastIndexOf(last)).replace(/\s+(?:[|–—·•-]|::)\s*$/, '').trim();
      else if (matches(parts[0])) t = t.slice(parts[0].length).replace(/^\s*(?:[|–—·•-]|::)\s+/, '').trim();
    }
    return trimText(t, 200);
  }

  function cleanAuthor(raw, siteName) {
    let a = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!a || /https?:|www\.|@|\{|\}/.test(a) || a.length > 140) return '';
    a = a
      .replace(/^(?:(?:written|posted|published|reported|words)\s+)?by\s*:?\s+/i, '')
      // "Autori:", "Autor:", "Auteur :", "Author:", "Автор:", "著者：" — and "Von / Por / Par / Door Firstname Lastname".
      .replace(/^(?:autor(?:e[sn]?|i|s|y|zy|ka)?|auteurs?|authors?|автор(?:ы)?|作者|著者|記者)\s*[:：]\s*/iu, '')
      .replace(/^(?:[Vv]on|[Pp]or|[Pp]ar|[Dd]oor|[Aa][vf])\s+(?=\p{Lu}[\p{L}'’.-]*\s+\p{Lu})/u, '')
      .replace(/\s*[|·•,]\s*(?:updated|published|posted)\b.*$/i, '')
      .replace(/\s+(?:on|at)\s+\w+\.?\s+\d{1,2},?\s+\d{4}.*$/i, '');
    a = a.split(/\s*[|·•]\s*/)[0].trim();
    // A trailing role in brackets — "Anna Ūdre (LTV foreign news editor)" — when a full name remains.
    const role = a.match(/\s*\([^()]{3,90}\)$/);
    if (role && a.slice(0, role.index).trim().split(/\s+/).length >= 2) a = a.slice(0, role.index).trim();
    if (a.length > 80) a = a.slice(0, 80).replace(/\s+\S*$/, '');
    if (!/\p{L}/u.test(a) || norm(a) === 'admin') return '';
    return a;
  }

  /**
   * The first usable author from candidates in priority order. A candidate that is just the site or the
   * publisher ("Condé Nast" on WIRED) only wins when nothing better exists; organisation-only fallbacks
   * (a JSON-LD Organization "author") are used only when they are not the publisher itself.
   */
  function pickAuthor(candidates, publishers = [], fallbacks = []) {
    // Whole words only: "Wikipedia contributors" contains the site, "Vicente García" does not contain "Vice".
    const words = (t) => ` ${String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
    const pubs = publishers.map(words).filter((p) => p.trim());
    const isPublisher = (a) => pubs.some((p) => words(a).includes(p) || p.includes(words(a)));
    const clean = candidates.map((c) => cleanAuthor(c || '')).filter(Boolean);
    const extra = fallbacks.map((c) => cleanAuthor(c || '')).filter((a) => a && !isPublisher(a));
    return clean.find((a) => !isPublisher(a)) || extra[0] || clean[0] || '';
  }

  /* -------------------------------------------------------------- extractor */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'NAV', 'IMG', 'PICTURE', 'SOURCE', 'MATH', 'FIGURE', 'ASIDE', 'FOOTER', 'HEAD', 'LINK', 'META', 'TITLE', 'MAP', 'DIALOG']);
  const BLOCK_TAGS = ['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'];
  const BLOCK_SET = new Set(BLOCK_TAGS);
  const BLOCK_QUERY = BLOCK_TAGS.map((t) => t.toLowerCase()).join(',');
  const JUNK_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'form', 'button', 'input', 'select', 'textarea',
    'nav', '[role="navigation"]', '[role="search"]', '[hidden]',
    '.sr-only', '.visually-hidden', '.screen-reader-text', '.mw-editsection', '.mw-references-wrap', 'ol.references', '.reflist',
    '.navbox', '.vertical-navbox', '.sidebar', '.hatnote', '.metadata', '.ambox', '.mbox-small', '.noprint', '.mw-empty-elt', '.mwe-math-element', '.mw-jump-link',
    '#toc', '.toc', '.infobox', '.shortdescription', '.portalbox', '.sistersitebox', '#siteSub', '#contentSub', '.printfooter', '#catlinks', '.catlinks',
    '#onetrust-consent-sdk', '.cookie-banner', '#cookie-banner', '.cookie-consent', '.social-share', '.share-buttons', '.sharing',
  ].join(',');
  const JUNK_SECTION = /^(references|notes|citations|footnotes|external links|see also|further reading|bibliography|sources|works cited|related (articles|posts|stories|reading)|read (more|next)|more (from|stories|on this)|recommended( for you)?|you (may|might) also like|popular( posts| stories)?|trending|comments?|leave a (comment|reply)|share( this)?|newsletter|subscribe|about the author|tags|categories)\s*:?$/i;
  // Lines that are nothing but UI chrome ("Advertisement", "Share this article", "Loading…")…
  const BOILERPLATE_LINE = /^(?:[←‹<]?\s*back|go back|back to (?:top|results|search|home)|show (?:more|all)(?: results)?|advertisement|sponsored(?: content)?|ad|related(?: articles| stories| posts)?|read more|continue reading|share(?: this(?: article| story| post)?)?|share on (?:facebook|twitter|x|linkedin|whatsapp|email)|follow us(?: on \w+)?|subscribe(?: now| today)?|sign up(?: now| for free)?|log ?in|sign in|click here|skip to (?:main )?content|jump to (?:navigation|search)|loading(?:…|\.\.\.)?|we use cookies|all rights reserved)[\s.!:…]*$/i;
  // …and short credit / caption / "Read more:" lines.
  const BOILERPLATE_PREFIX = /^(?:(?:image|photo|photograph|credit|illustration|caption)s?\s*:\s|(?:read (?:more|next|also)|related|see also|watch|listen)\s*:\s|getty images\b|©|\(c\)\s|copyright\s+(?:©\s*)?\d{4})/i;
  const BYLINE_NAME = /^(?:(?:[Ww]ritten|[Pp]osted|[Ww]ords|[Rr]eported)\s+)?[Bb][Yy]\s+\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}(?:\s*$|\s*[,|·•—–-]|\s+and\s)/u;
  const BYLINE_STAMP = /^(?:published|updated|posted|last (?:updated|modified))(?:\s+on)?\s*:?\s+(?:\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b)/i;
  const DATE_HINT = /\b(?:\d{1,2}[:/.-]\d{1,2}|\d{4}|(?:jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})\b/i;

  const imageFrom = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return imageFrom(value[0]);
    return typeof value === 'object' ? value.url || value.contentUrl || '' : '';
  };

  // vendor/readability.min.js is a classic script just before app.js: by now it has either run or failed to load.
  if (window.__svReadability === undefined) window.__svReadability = window.Readability ? 1 : -1;

  const Deps = {
    readability() {
      if (window.Readability) return Promise.resolve(true);
      if (window.__svReadability === -1) return Promise.resolve(false);
      return new Promise((resolve) => {
        const el = document.getElementById('sv-readability');
        const done = () => resolve(Boolean(window.Readability));
        if (!el) return done();
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    },
  };

  function isLayoutTable(table) {
    if (table.getAttribute('role') === 'presentation' || table.querySelector('table')) return true;
    const cells = table.querySelectorAll('td, th').length;
    const text = (table.textContent || '').length;
    return cells <= 2 || text / Math.max(1, cells) > 160;
  }

  /* ------------------------------------------------------ 3-stage Ad-Shield
   * Runs on the parsed page before Readability ever sees it.
   *   Stage 1  ad slots: explicit ad selectors, plus class/id tokens matched on word boundaries only,
   *            so "header", "read", "load", "shadow" or "badge" are never mistaken for ads.
   *   Stage 2  clutter: short "Read more:" / "Related:" link boxes, affiliate disclaimers, newsletter sign-ups.
   *   Stage 3  telemetry: every node removed is counted → "DOM Cleaned · X removed" in the filter bar.
   * A node that holds the article (an <article>, <main>, the <h1>, or lots of non-link text) is never removed. */
  const AD_SELECTOR = [
    '[data-ad]', '[data-ad-unit]', '[data-ad-slot]', '[aria-label*="advertisement" i]', '[aria-label*="sponsored" i]',
    '.ad-slot', '.ad-container', '.outbrain', '.OUTBRAIN', '.taboola', '[id^="taboola-"]', '.trc_related_container',
    '.newsletter-signup', '.inline-related', '.affiliate-disclaimer',
    '.advertisement', '.adsbygoogle', 'ins.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]',
  ].join(',');
  const AD_TOKEN = /(^|[-_\s])(ad|ads|advert|sponsor|promo)([-_\s]|$)/i;
  const SHIELD_KEEP = 'html, body, main, article, h1, [role="main"], [itemprop="articleBody"]';
  const SHIELD_KEEP_INSIDE = 'h1, main, article, [role="main"], [itemprop="articleBody"]';
  const RELATED_LEAD = /^(?:read (?:more|next|also)|related(?: (?:articles?|stories|story|coverage|content|posts?|reading|links?))?|see also|more (?:from|on|about) [^:]{1,40}|recommended(?: for you)?|don[’']t miss|must[- ]read|you (?:may|might) also like|also read|further reading)\s*[:\-–—|»›]/i;
  const AFFILIATE = /(?:we (?:may )?(?:earn|receive|get|make) (?:a )?(?:small )?(?:commission|compensation|fee|share)|as an amazon associate|(?:this|the|our) (?:post|article|page|story|site|content) (?:may )?(?:contains?|includes?) affiliate|affiliate (?:commission|disclosure)|^disclosure\s*:)/i;
  const NEWSLETTER = /(?:sign up for (?:our|the|my) (?:[\w-]+ )?newsletter|subscribe to (?:our|the|my) (?:[\w-]+ )?newsletter|get (?:our|the) (?:[\w-]+ )?newsletter|join (?:our|the) (?:[\w-]+ )?(?:newsletter|mailing list)|newsletter sign[- ]?up|enter your e-?mail(?: address)?(?: to| below| and)|delivered (?:straight )?to your inbox)/i;

  const Shield = {
    /** True when a class or id string contains an ad token on a word boundary ("ad-slot", "top_ads", "promo"). */
    tokenMatch(value) {
      return Boolean(value) && AD_TOKEN.test(String(value));
    },
    textOf(el) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    },
    linkRatio(el, length) {
      let links = 0;
      for (const a of el.querySelectorAll('a')) links += this.textOf(a).length;
      return length ? links / length : 0;
    },
    /** Small boxes go; big ones only when they are mostly links (Taboola / Outbrain grids). */
    strippable(el) {
      if (el.matches(SHIELD_KEEP) || el.querySelector(SHIELD_KEEP_INSIDE)) return false;
      const length = this.textOf(el).length;
      return length < 400 || this.linkRatio(el, length) > 0.5;
    },
    stage1(root) {
      let n = 0;
      const kill = (el) => {
        if (el.isConnected && this.strippable(el)) {
          el.remove();
          n++;
        }
      };
      root.querySelectorAll(AD_SELECTOR).forEach(kill);
      for (const el of root.querySelectorAll('[class], [id]')) {
        if (el.isConnected && (this.tokenMatch(el.getAttribute('class')) || this.tokenMatch(el.id))) kill(el);
      }
      return n;
    },
    stage2(root) {
      let n = 0;
      for (const el of root.querySelectorAll('p, li, div, section, aside, ul, ol, form, figure')) {
        if (!el.isConnected || el.matches(SHIELD_KEEP) || el.querySelector(SHIELD_KEEP_INSIDE)) continue;
        const text = this.textOf(el);
        if (!text || text.length > 600) continue;
        const paragraphs = el.querySelectorAll('p, li').length;
        const links = el.querySelector('a') ? this.linkRatio(el, text.length) : 0;
        const related = RELATED_LEAD.test(text) && ((text.length < 240 && links >= 0.35) || links > 0.6);
        const affiliate = text.length < 420 && paragraphs <= 1 && AFFILIATE.test(text);
        const form = el.matches('form') || Boolean(el.querySelector('input, button, form, [type="submit"]'));
        const newsletter = paragraphs <= 2 && NEWSLETTER.test(text) && ((form && text.length < 500) || (text.length < 160 && text.search(NEWSLETTER) < 24));
        if (related || affiliate || newsletter) {
          el.remove();
          n++;
        }
      }
      return n;
    },
    run(doc) {
      const root = doc.body || doc.documentElement;
      if (!root) return { ads: 0, clutter: 0 };
      const ads = this.stage1(root);
      const clutter = this.stage2(root);
      return { ads, clutter };
    },
  };

  const Extractor = {
    async fromHtml(html, pageUrl, hints = {}) {
      if (hints.source !== 'tab' && looksBlocked(html)) throw new Error('The site returned a bot-check page instead of the article. Try the Chrome extension on that tab.');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const meta = this.meta(doc, pageUrl);
      // A GitHub profile: the person's name and bio, not "Hotragn - Overview" and "has 145 repositories available".
      if (/(?:^|\.)github\.com$/i.test(hostOf(pageUrl)) && doc.querySelector('meta[property="og:type"][content="profile"]')) {
        const name = ((doc.querySelector('.vcard-fullname') || {}).textContent || '').trim();
        const bio = (doc.querySelector('[data-bio-text]') || {}).getAttribute?.('data-bio-text') || ((doc.querySelector('.user-profile-bio') || {}).textContent || '').trim();
        if (name) meta.title = name;
        if (bio) meta.description = bio;
      }
      const finalUrl = meta.canonical && bareHost(hostOf(meta.canonical)) === bareHost(hostOf(pageUrl)) ? meta.canonical : pageUrl;
      const hostname = hostOf(finalUrl) || hostOf(pageUrl);
      // Site Briefing reads the page's identity, offerings, pricing and FAQ before anything is stripped.
      let scan = null;
      try {
        scan = Briefing.scan(doc, this.jsonLd(doc));
      } catch (err) {
        console.warn('[SiteVocal] Site Briefing scan failed; the page is still read in full.', err);
      }
      // ✨ Summarize Page reads every table, definition list and caption right after the Ad-Shield (stages 1–2).
      let structure = null;
      const shield = this.preClean(doc, (shielded) => {
        try {
          structure = Summary.scan(shielded, { pricing: scan && scan.pricing });
        } catch (err) {
          console.warn('[SiteVocal] Summary scan failed; the page is still read in full.', err);
        }
      });
      let article = null;
      // hints.clean: the page is already its article (an API's rendered README), so Readability has nothing to remove.
      if (!hints.clean && (await Deps.readability())) {
        try {
          const parsed = new window.Readability(doc.cloneNode(true), { charThreshold: 250, keepClasses: false }).parse();
          if (parsed && parsed.content && (parsed.textContent || '').trim().length > 140) article = parsed;
        } catch (err) {
          console.warn('[SiteVocal] Readability failed; using the built-in extractor.', err);
        }
      }
      const root = article ? new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${article.content}</body></html>`, 'text/html').body : hints.clean ? doc.querySelector('article') || doc.querySelector('main') || doc.body : this.fallbackRoot(doc);
      const known = knownSite(hostname);
      const siteName = cleanSiteName(meta.siteName || (article && article.siteName) || (known && known.name) || siteLabel(hostname));
      const title = cleanTitle(meta.title || (article && article.title) || hints.title || '', siteName) || siteName;
      const author = pickAuthor([meta.ldPerson, meta.articleAuthor, article && article.byline, meta.metaAuthor, hints.author, meta.domAuthor, known && known.author], [siteName, meta.publisher], [meta.ldOrg]);
      let blocks = this.filter(this.blocks(root), title, author);
      if (article && blocks.filter((b) => b.t !== 'h').length < 2) {
        const fallback = this.filter(this.blocks(this.fallbackRoot(doc)), title, author);
        if (fallback.length > blocks.length) blocks = fallback;
      }
      const raw = {
        url: finalUrl,
        hostname,
        siteName,
        title,
        author,
        excerpt: trimText(Clean.citations(meta.description || (article && article.excerpt) || ''), 220),
        lang: normLang(meta.lang || (article && article.lang) || hints.lang || ''),
        heroImage: meta.heroImage || safeImageUrl(hints.largestImage, finalUrl) || '',
        logos: this.finalLogos(meta.logos, hints.logos, hostname, hints.favIconUrl),
        themeColor: meta.themeColor || hints.themeColor || '',
        tileColor: meta.tileColor || '',
        knownColor: (known && known.color) || '',
        brandColors: Array.isArray(hints.brandColors) ? hints.brandColors.slice(0, 12) : [],
        blocks,
        via: hints.via || '',
        extractor: article ? 'Mozilla Readability' : hints.clean ? 'SiteVocal parser' : 'SiteVocal heuristics',
        source: hints.source || 'url',
        kind: 'article',
        shield: { ...shield, hidden: Math.max(0, Number(hints.hiddenPruned) || 0) },
      };
      if (structure) raw.structure = structure;
      if (hints.pageType) raw.pageType = hints.pageType;
      try {
        raw.briefing = Briefing.finish(scan, raw);
      } catch (err) {
        console.warn('[SiteVocal] Site Briefing failed; the page is still read in full.', err);
      }
      return raw;
    },

    meta(doc, pageUrl) {
      const val = (selectors, attr = 'content') => {
        for (const sel of [].concat(selectors)) {
          const el = doc.querySelector(sel);
          const v = el && (el.getAttribute(attr) || '').trim();
          if (v) return v;
        }
        return '';
      };
      const ld = this.jsonLd(doc);
      const types = (n) => [].concat(n['@type'] || []).join(' ');
      const article = ld.find((n) => /(Article|BlogPosting|NewsArticle|Report|Posting|WebPage)\b/.test(types(n)) && (n.headline || n.name));
      const org = ld.find((n) => /(Organization|NewsMediaOrganization|Corporation)\b/.test(types(n)) && typeof n.name === 'string');
      const publisher = article && article.publisher && typeof article.publisher === 'object' ? [].concat(article.publisher)[0] : org;
      // People named in the article's JSON-LD outrank any byline; an Organization "author" is usually the publisher.
      const ldAuthors = article ? [].concat(article.author || []).filter((a) => typeof a === 'string' || (a && typeof a.name === 'string')) : [];
      const isOrg = (a) => typeof a === 'object' && /Organization|Corporation/.test([].concat(a['@type'] || []).join(' '));
      const names = (list) => {
        const n = list.map((a) => (typeof a === 'string' ? a : a.name).trim()).filter(Boolean).slice(0, 3);
        return n.length > 2 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n.join(' and ');
      };
      const ldPerson = names(ldAuthors.filter((a) => !isOrg(a)));
      const ldOrg = names(ldAuthors.filter(isOrg));
      const themes = Array.from(doc.querySelectorAll('meta[name="theme-color"]'));
      const theme = (themes.find((m) => /dark/.test(m.getAttribute('media') || '')) || themes.find((m) => !m.getAttribute('media')) || themes[0]);
      const authorEl = doc.querySelector('a[rel="author"], [itemprop="author"] [itemprop="name"], .byline .author, .author-name, .byline__name, .c-byline__author');
      return {
        title: val(['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]']) || (article && typeof article.headline === 'string' ? article.headline : '') || ((doc.querySelector('title') || {}).textContent || '').trim(),
        siteName: val(['meta[property="og:site_name"]', 'meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]']) || (publisher && typeof publisher.name === 'string' ? publisher.name : ''),
        ldPerson,
        ldOrg,
        articleAuthor: val('meta[property="article:author"]'),
        metaAuthor: val(['meta[name="author"]', 'meta[name="byl"]', 'meta[name="parsely-author"]', 'meta[name="sailthru.author"]', 'meta[name="dc.creator"]', 'meta[name="DC.creator"]']),
        domAuthor: authorEl ? authorEl.textContent.trim() : '',
        publisher: publisher && typeof publisher.name === 'string' ? publisher.name : '',
        description: val(['meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]']) || (article && typeof article.description === 'string' ? article.description : ''),
        heroImage: safeImageUrl(val(['meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'meta[property="twitter:image"]']) || (article ? imageFrom(article.image) : '') || val('link[rel="image_src"]', 'href'), pageUrl),
        themeColor: theme ? (theme.getAttribute('content') || '').trim() : '',
        tileColor: val('meta[name="msapplication-TileColor"]'),
        lang: doc.documentElement.getAttribute('lang') || val('meta[http-equiv="content-language"]') || val('meta[property="og:locale"]'),
        canonical: safeHttpUrl(val('link[rel="canonical"]', 'href') || val('meta[property="og:url"]'), pageUrl),
        logos: this.logos(doc, pageUrl, publisher ? imageFrom(publisher.logo) : ''),
      };
    },

    jsonLd(doc) {
      const out = [];
      const visit = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 4 || out.length > 60) return;
        if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
        if (node['@type']) out.push(node);
        if (node['@graph']) visit(node['@graph'], depth + 1);
      };
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          visit(JSON.parse(script.textContent || 'null'), 0);
        } catch {
          /* ignore malformed JSON-LD */
        }
      }
      return out;
    },

    logos(doc, pageUrl, ldLogo) {
      const found = [];
      for (const link of doc.querySelectorAll('link[rel][href]')) {
        const rel = (link.getAttribute('rel') || '').toLowerCase();
        if (!/(^|\s)(apple-touch-icon(-precomposed)?|icon|fluid-icon)(\s|$)/.test(rel)) continue;
        const href = safeImageUrl(link.getAttribute('href'), pageUrl);
        if (!href) continue;
        const sizes = (link.getAttribute('sizes') || '').match(/(\d+)\s*x\s*\d+/i);
        const svg = /svg/i.test(link.getAttribute('type') || '') || /\.svg(\?|$)/i.test(href);
        const size = sizes ? Number(sizes[1]) : svg ? 256 : /apple/.test(rel) ? 180 : 32;
        found.push({ href, score: Math.min(size, 512) + (/apple/.test(rel) ? 40 : 0) + (svg ? 30 : 0) });
      }
      const ld = safeImageUrl(ldLogo, pageUrl);
      if (ld) found.push({ href: ld, score: 120 });
      const og = safeImageUrl(doc.querySelector('meta[property="og:logo"]')?.getAttribute('content') || '', pageUrl);
      if (og) found.push({ href: og, score: 150 });
      return found;
    },

    finalLogos(found = [], extra = [], hostname, favIconUrl) {
      const list = [...found];
      for (const e of extra || []) {
        const href = safeImageUrl(typeof e === 'string' ? e : e && e.href, `https://${hostname}/`);
        if (href) list.push({ href, score: typeof e === 'object' && e.score ? e.score : 60 });
      }
      const fav = safeImageUrl(favIconUrl);
      if (fav) list.push({ href: fav, score: 55 });
      if (hostname) {
        if (s2Favicon(hostname)) list.push({ href: s2Favicon(hostname), score: 20 });
        list.push({ href: `https://${hostname}/favicon.ico`, score: 10 });
      }
      list.sort((a, b) => b.score - a.score);
      return [...new Set(list.map((l) => l.href))].slice(0, 6);
    },

    /** Ad-Shield first (counted), then the generic chrome clean-up (not counted). Returns the shield telemetry.
     *  onShielded(doc) sees the page with the ads gone but infoboxes and spec tables still in place. */
    preClean(doc, onShielded = null) {
      doc.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove());
      // GitHub's rendered Markdown wraps each heading with a permalink in a <div>, which Readability turns into a
      // paragraph and so loses the heading: unwrap it, and drop the permalink.
      doc.querySelectorAll('a.anchor[aria-label^="Permalink" i]').forEach((node) => node.remove());
      doc.querySelectorAll('div.markdown-heading').forEach((node) => node.replaceWith(...node.childNodes));
      const shield = Shield.run(doc);
      if (onShielded) onShielded(doc);
      doc.querySelectorAll(JUNK_SELECTOR).forEach((node) => node.remove());
      // Dialogs and aria-hidden nodes are junk only when small: modal libraries set aria-hidden="true" on the
      // whole app root while a dialog is open, and some sites render the article itself inside a dialog.
      doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [aria-hidden="true"]').forEach((node) => {
        if (node.isConnected && (node.textContent || '').trim().length < 400) node.remove();
      });
      return shield;
    },

    /** Built-in fallback when Readability is unavailable: score containers by paragraph text. */
    fallbackRoot(doc) {
      const body = doc.body || doc.documentElement;
      const direct = doc.querySelector('[itemprop="articleBody"], .article-body, .story-body, .post-content, .entry-content, .article-content, article');
      if (direct && (direct.textContent || '').trim().length > 700) return direct;
      const scores = new Map();
      for (const p of body.querySelectorAll('p')) {
        const text = (p.textContent || '').trim();
        if (text.length < 30) continue;
        const score = 1 + Math.min(3, text.length / 120) + (text.match(/,/g) || []).length * 0.1;
        let node = p.parentElement;
        let weight = 1;
        for (let depth = 0; node && depth < 3; depth++, weight /= 2, node = node.parentElement) scores.set(node, (scores.get(node) || 0) + score * weight);
      }
      let best = null;
      let bestScore = 0;
      for (const [node, score] of scores) {
        const total = (node.textContent || '').length || 1;
        let links = 0;
        for (const a of node.querySelectorAll('a')) links += (a.textContent || '').length;
        const adjusted = score * (1 - Math.min(0.9, links / total));
        if (adjusted > bestScore) {
          best = node;
          bestScore = adjusted;
        }
      }
      return best && bestScore > 4 ? best : body;
    },

    /** Walk any DOM into ordered blocks: headings, paragraphs, list items, quotes, code, tables. */
    blocks(root) {
      const out = [];
      if (!root) return out;
      this.tidyDom(root);
      const BR = '\u2028';
      let buf = '';
      // Two elements side by side ("<span>$0.00/yr</span><span>Free for 1 year</span>") are two words, not "yrFree".
      const join = (a, b) => (b && /[\p{Ll}\p{N}%)\]]$/u.test(a) && /^\p{Lu}/u.test(b) ? `${a} ${b}` : a + b);
      const flush = () => {
        if (!buf) return;
        for (const part of buf.split(/\u2028\s*\u2028+/)) {
          const text = Clean.display(part.replace(/\u2028/g, ' '));
          if (text) out.push({ t: 'p', text });
        }
        buf = '';
      };
      const inline = (node) => {
        if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toUpperCase();
        if (tag === 'BR') return BR;
        if (SKIP_TAGS.has(tag)) return '';
        if (tag === 'SUP' && node.querySelector('a[href*="#"]')) {
          // A linked footnote marker ("¹", "[3]") becomes a citation the Skip Citations filter understands.
          const mark = (node.textContent || '').trim().match(/^\[?(\d{1,3}|[a-z]{1,2}|[ivx]{1,5})\]?$/i);
          if (mark) return `[${mark[1]}]`;
        }
        let s = '';
        for (const child of node.childNodes) s = child.nodeType === 1 ? join(s, inline(child)) : s + inline(child);
        return s;
      };
      const words = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’./+-]*/gu) || []).length;
      /** A card or a strip of labels ("Best Match | site-vocal.com | $0.00/yr (was $7.90/yr) | Free for 1 year"): one line. */
      const card = (el) => {
        const tag = el.tagName.toUpperCase();
        if (!/^(DIV|SECTION|ARTICLE|HEADER)$/.test(tag) || el.querySelector('h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote')) return null;
        const kids = Array.from(el.children).filter((c) => !SKIP_TAGS.has(c.tagName.toUpperCase()));
        if (kids.length < 3 || kids.length > 24 || el.childNodes.length - kids.length > kids.length + 2) return null;
        if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim())) return null;
        const parts = [];
        for (const k of kids) {
          const t = Clean.display(inline(k).replace(/\u2028/g, ' '));
          if (!t) continue;
          if (words(t) > 7 || t.length > 60 || /[.!?…:]$/.test(t)) return null;
          if (!parts.some((p) => norm(p) === norm(t))) parts.push(t);
        }
        if (parts.length < 2 || parts.length > 10 || parts.reduce((n, p) => n + words(p), 0) > 32) return null;
        return parts.join(', ');
      };
      const isBlock = (el) => BLOCK_SET.has(el.tagName.toUpperCase()) || Boolean(el.querySelector(BLOCK_QUERY));
      const list = (el, ordered) => {
        let n = (Number(el.getAttribute('start')) || 1) - 1;
        for (const li of el.children) {
          if (li.tagName.toUpperCase() !== 'LI') {
            walk(li);
            flush();
            continue;
          }
          n++;
          let own = '';
          const nested = [];
          for (const child of li.childNodes) {
            const tag = child.nodeType === 1 ? child.tagName.toUpperCase() : '';
            if (/^(UL|OL|PRE|TABLE|BLOCKQUOTE)$/.test(tag)) nested.push(child);
            else if (!SKIP_TAGS.has(tag)) {
              const piece = inline(child);
              // Separate short block pieces of a result row ("sitevocal.net" | "$0.00/yr (was $11.90/yr)") with commas.
              if (tag && BLOCK_SET.has(tag) && piece.trim() && own.trim() && !/[.!?,:;]\s*$/.test(own) && words(piece) <= 8) own = `${own.replace(/\s+$/, '')}, ${piece} `;
              else own = `${join(own, piece)} `;
            }
          }
          const text = Clean.display(own.replace(/\u2028/g, ' '));
          if (text) out.push({ t: 'li', text, ordered, n });
          for (const child of nested) {
            const holder = child.ownerDocument.createElement('div');
            holder.appendChild(child.cloneNode(true));
            walk(holder);
            flush();
          }
        }
      };
      const walk = (el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === 3) {
            buf += node.nodeValue.replace(/\s+/g, ' ');
            continue;
          }
          if (node.nodeType !== 1) continue;
          const tag = node.tagName.toUpperCase();
          if (SKIP_TAGS.has(tag)) continue;
          if (tag === 'BR') {
            buf += BR;
            continue;
          }
          if (!isBlock(node)) {
            buf = join(buf, inline(node));
            continue;
          }
          flush();
          const line = card(node);
          if (line) {
            out.push({ t: 'p', text: line, card: true });
            continue;
          }
          if (/^H[1-6]$/.test(tag)) {
            const text = Clean.display(inline(node).replace(/\u2028/g, ' '));
            if (text) out.push({ t: 'h', level: Number(tag[1]), text });
          } else if (tag === 'PRE') {
            const text = (node.textContent || '').replace(/^\n+/, '').replace(/\s+$/, '');
            if (text.trim()) out.push({ t: 'code', text: text.slice(0, 8000) });
          } else if (tag === 'TABLE') {
            const rows = node.querySelectorAll('tr').length;
            if (rows > 1 && !isLayoutTable(node)) out.push({ t: 'table', rows, text: '', ...this.tableCells(node) });
            else walk(node);
          } else if (tag === 'UL' || tag === 'OL') {
            list(node, tag === 'OL');
          } else if (tag === 'BLOCKQUOTE') {
            const start = out.length;
            walk(node);
            flush();
            for (let i = start; i < out.length; i++) if (out[i].t === 'p') out[i].t = 'quote';
          } else if (tag !== 'HR') {
            const start = out.length;
            walk(node);
            flush();
            if (node.hasAttribute('data-sv-tags')) for (let i = start; i < out.length; i++) out[i].tags = true;
            if (node.hasAttribute('data-sv-fine')) for (let i = start; i < out.length; i++) out[i].fine = true;
          }
          flush();
        }
      };
      walk(root);
      flush();
      return out;
    },

    /**
     * What a listener should hear differently from what the page shows: a struck-out price is the old one
     * ("$0.00/yr (was $7.90/yr)"); a row of tech tags at the start of a paragraph (GitHub READMEs:
     * `Next.js 15` `three.js` …) is its own line, not the start of the next sentence; rows of links
     * ("Live demo · Repo", "Portfolio · Resume · GitHub") and captions under images are not read.
     */
    tidyDom(root) {
      const doc = root.ownerDocument;
      const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
      const PRICE = /^(?:[$€£¥₹]\s?\d|\d[\d,.]*\s?(?:[$€£¥₹]|usd|eur|gbp|%))[\d,.]*(?:\s?\/\s?[a-z]{1,6}|\s?(?:per|a|an)\s\w+)?$/i;
      const blank = (n) => n && n.nodeType === 3 && !n.nodeValue.trim();
      for (const el of Array.from(root.querySelectorAll('s, del, strike'))) {
        const old = text(el);
        if (!PRICE.test(old) || old.length > 32) continue;
        let next = el.nextSibling;
        while (blank(next)) next = next.nextSibling;
        // The new price: the first words of the next node's first text ("$0.00/yr" of "<span>$0.00/yr</span><span>Free…").
        let tn = next && next.nodeType === 3 ? next : null;
        if (next && next.nodeType === 1) {
          const walker = doc.createTreeWalker(next, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) { tn = n; break; }
        }
        const price = tn && tn.nodeValue.match(/^(\s*(?:[$€£¥₹]\s?\d|\d)[\d,.]*(?:\s?\/\s?[a-z]{1,6}\b)?)/i);
        if (price) {
          // "<s>$7.90/yr</s> <span>$0.00/yr</span>": the new price first, then what it was.
          tn.nodeValue = `${price[1]} (was ${old})${tn.nodeValue.slice(price[1].length)}`;
          el.remove();
        } else el.replaceWith(doc.createTextNode(`was ${old}`));
      }
      const SEP = /^[\s·•|/,–—-]*$/;
      for (const p of Array.from(root.querySelectorAll('p'))) {
        // A leading run of tags: two or more short <code> spans, then a line break or the end.
        const nodes = Array.from(p.childNodes);
        const tags = [];
        let i = 0;
        for (; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.nodeType === 3 && SEP.test(n.nodeValue) && !/\n/.test(n.nodeValue)) continue;
          if (n.nodeType === 1 && n.tagName === 'CODE' && text(n).length <= 32 && text(n).split(' ').length <= 4) {
            tags.push(n);
            continue;
          }
          break;
        }
        const rest = nodes[i];
        if (tags.length >= 2 && (!rest || (rest.nodeType === 3 && /^\s*\n/.test(rest.nodeValue)) || (rest.nodeType === 1 && rest.tagName === 'BR'))) {
          const names = tags.map(text);
          const line = doc.createElement('p');
          line.setAttribute('data-sv-tags', '1');
          line.textContent = `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}.`;
          for (const n of nodes.slice(0, i)) n.remove();
          if (rest && rest.nodeType === 1) rest.remove();
          p.before(line);
          if (!text(p)) p.remove();
        }
        if (!p.isConnected) continue;
        // A trailing row of links after a line break ("… winner.\nRepo", "…\nLive demo · Repo").
        const kids = Array.from(p.childNodes);
        let j = kids.length - 1;
        let links = 0;
        for (; j >= 0; j--) {
          const n = kids[j];
          if (n.nodeType === 3 && SEP.test(n.nodeValue) && !/\n/.test(n.nodeValue)) continue;
          if (n.nodeType === 1 && n.tagName === 'A' && text(n) && text(n).split(' ').length <= 4) {
            links++;
            continue;
          }
          break;
        }
        const cut = kids[j];
        if (links && j >= 0 && ((cut.nodeType === 3 && /\n\s*$/.test(cut.nodeValue)) || (cut.nodeType === 1 && cut.tagName === 'BR'))) for (const n of kids.slice(j + 1)) n.remove();
        // A lone link that points onwards ("Full experience & education →", "All posts »").
        const only = Array.from(p.childNodes).filter((n) => !(n.nodeType === 3 && !n.nodeValue.trim()));
        if (only.length === 1 && only[0].nodeType === 1 && only[0].tagName === 'A' && /[→»›↗]\s*$/.test(text(p)) && text(p).split(' ').length <= 8) {
          p.remove();
          continue;
        }
        // A paragraph that is only a row of links ("Portfolio · Resume · GitHub · LinkedIn").
        const all = Array.from(p.childNodes);
        const anchors = all.filter((n) => n.nodeType === 1 && n.tagName === 'A');
        if (anchors.length >= 2 && all.every((n) => (n.nodeType === 3 && SEP.test(n.nodeValue.replace(/[→←↗»›]/g, ''))) || (n.nodeType === 1 && n.tagName === 'A' && text(n).replace(/[→←↗»›]/g, '').trim().split(/\s+/).length <= 5))) {
          p.remove();
          continue;
        }
        // Fine print (all of it in <sub> or <small>), and a caption right under an image, are not read as content.
        const small = Array.from(p.querySelectorAll('sub, small')).filter((x) => !x.parentElement.closest('sub, small'));
        if (small.length && small.map(text).join(' ').length >= text(p).length - 2 && text(p)) {
          let prev = p.previousElementSibling;
          const imageOnly = prev && prev.querySelector('img, picture, svg, video') && !text(prev);
          if (imageOnly || /^(?:sub)$/i.test(small[0].tagName)) p.remove();
          else p.setAttribute('data-sv-fine', '1');
        }
      }
    },

    /** Up to 40 rows × 8 columns of a data table: drawn on screen, and read aloud when Skip Tables is off. */
    tableCells(table) {
      const cells = [];
      for (const tr of Array.from(table.querySelectorAll('tr')).slice(0, 40)) {
        const row = Array.from(tr.children)
          .filter((c) => /^(TD|TH)$/i.test(c.tagName))
          .slice(0, 8)
          .map((c) => trimText(Clean.citations(Clean.display(c.textContent || '')), 120));
        if (row.some(Boolean)) cells.push(row);
      }
      const first = table.querySelector('tr');
      const head = Boolean(first && first.querySelector('th') && !first.querySelector('td'));
      const cap = table.querySelector('caption');
      return { cells, head, caption: cap ? trimText(Clean.display(cap.textContent || ''), 160) : '' };
    },

    /** Drop boilerplate, duplicate titles and trailing "References / See also" sections. */
    filter(blocks, title, author = '') {
      const normTitle = norm(title);
      // Bylines and timestamps near the top: the spoken intro already announces the author.
      // Only byline-shaped lines ("By Ada Lovelace · March 3", "Updated 3 hours ago"), never prose like "By 2030, …".
      const isByline = (t) => {
        if (t.length > 120) return false;
        if (BYLINE_NAME.test(t)) return !/[.!?]$/.test(t) || DATE_HINT.test(t);
        if (BYLINE_STAMP.test(t)) return t.length < 80;
        if (author.length > 3 && t.toLowerCase().startsWith(author.toLowerCase())) {
          const rest = t.slice(author.length);
          return t.length < author.length + 50 && /^\s*(?:$|[,|·•—–-])/.test(rest) && !/[.!?]$/.test(t);
        }
        return false;
      };
      const kept = [];
      const seen = new Set();
      let skipLevel = 0;
      let chars = 0;
      for (const b of blocks) {
        if (b.t === 'h') {
          if (skipLevel && b.level > skipLevel) continue;
          skipLevel = 0;
          if (JUNK_SECTION.test(b.text.trim())) {
            skipLevel = b.level;
            continue;
          }
          if (norm(b.text) === normTitle && (b.level === 1 || kept.length < 3)) continue;
        } else if (skipLevel) {
          continue;
        }
        if (b.t === 'p' || b.t === 'li' || b.t === 'quote') {
          const t = b.text.trim();
          if (t.length < 2 || !/[\p{L}\p{N}]/u.test(t)) continue;
          if (t.length < 90 && (BOILERPLATE_LINE.test(t) || (t.length < 70 && BOILERPLATE_PREFIX.test(t)))) continue;
          if (kept.length < 3 && norm(t) === normTitle) continue;
          if (kept.length < 4 && b.t === 'p' && isByline(t)) continue;
        }
        const prev = kept[kept.length - 1];
        if (prev && prev.t === b.t && prev.text === b.text) continue;
        // A sentence cut in two by the page's layout ("@Anthropic" | "just announced …"): one line again.
        if (b.t === 'p' && prev && prev.t === 'p' && /^\p{Ll}/u.test(b.text) && countWords(prev.text) <= 6 && !/[.!?:;…]$/.test(prev.text)) {
          prev.text = `${prev.text} ${b.text}`;
          continue;
        }
        // The same short line again (a scrolling banner's copies, a pull quote): heard once.
        if ((b.t === 'p' || b.t === 'quote' || (b.t === 'li' && !b.ordered)) && countWords(b.text) <= 40) {
          const key = norm(b.text);
          if (key.length >= 6 && seen.has(key)) continue;
          seen.add(key);
        }
        kept.push(b);
        chars += (b.text || '').length;
        if (chars > 400000) break;
      }
      // Remove headings left without any content beneath them.
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].t !== 'h') continue;
        const next = kept[i + 1];
        if (!next || (next.t === 'h' && next.level <= kept[i].level)) kept.splice(i, 1);
      }
      return kept;
    },

    fromText(text, title = '') {
      const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
      let parts = normalized.split(/\n\s*\n+/);
      if (parts.length === 1 && normalized.split('\n').length > 2) parts = normalized.split('\n');
      const blocks = parts.map((p) => Clean.display(p)).filter(Boolean).map((p) => ({ t: 'p', text: p }));
      const first = blocks.length ? blocks[0].text : 'Pasted text';
      return {
        url: '',
        hostname: '',
        siteName: 'Pasted Text',
        title: trimText(Clean.display(title) || first, 90),
        author: '',
        excerpt: '',
        lang: normLang(navigator.language) || 'en',
        heroImage: '',
        logos: [],
        themeColor: '',
        tileColor: '',
        knownColor: '',
        brandColors: [],
        blocks,
        via: '',
        extractor: 'your pasted text',
        source: 'text',
        kind: 'text',
        shield: { ads: 0, clutter: 0, hidden: 0 },
      };
    },

    htmlToBlocks(html) {
      const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
      return this.blocks(doc.body).filter((b) => b.text || b.t === 'code');
    },
  };

  /* ---------------------------------------------- Site Briefing extractor
   * Deterministic, zero-API "what this website / company does" dossier. It reads the raw page before the
   * Ad-Shield and Readability strip everything that is not an article:
   *   1  Who they are        JSON-LD Organization / WebSite / SoftwareApplication / Product / LocalBusiness,
   *                          the meta and Open Graph descriptions, the hero <h1> and its lead paragraph
   *   2  What they provide   feature cards and sections: an h2/h3 with its own <p> or <li> items
   *   3  Pricing & audience  plan cards ("Pro · $12 per user per month"), free tiers, open source, "Built for …"
   *   4  Key takeaways       JSON-LD FAQPage and <details> FAQs, otherwise the page's section takeaways
   * Navigation, page headers, footers, forms, buttons, cookie banners, testimonials and call-to-action lines
   * ("Sign up", "Book a demo", "Start free trial", "Learn more") never get in.                         */
  const BRIEF_V = 1;
  const BRIEF_TYPES = {
    home: 'company homepage',
    pricing: 'pricing page',
    about: 'about page',
    product: 'product page',
    landing: 'landing page',
    article: 'article',
    feed: 'news feed',
    text: 'text',
  };
  const BRIEF_JUNK = [
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'img', 'picture', 'source', 'map',
    'form', 'button', 'input', 'select', 'textarea', 'label', 'dialog', 'nav', 'footer', 'menu', 'blockquote', 'q', 'figure', 'figcaption',
    '[role="navigation"]', '[role="contentinfo"]', '[role="search"]', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="menubar"]', '[role="button"]',
    '[hidden]', '[aria-hidden="true"]', '[style*="display:none" i]', '[style*="display: none" i]', '[style*="visibility:hidden" i]', '[style*="visibility: hidden" i]',
    '.sr-only', '.visually-hidden', '.screen-reader-text', '.skip-link', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.cc-window',
    '[class*="testimonial" i]', '[itemprop="review"]', '[class*="logo-wall" i]', '[class*="marquee" i]',
  ].join(',');
  // Call-to-action and menu lines: "Sign up", "Book a demo", "Start free trial", "Learn more →".
  const CTA_LINE = /^(?:(?:sign|log)\s?(?:up|in|out)(?: free| for free| now| today)?|register(?: now)?|get started(?: free| for free| now| today)?|start(?: now| today| here| for free| free| building| selling| your free trial| a free trial| trial)?|try(?: it)?(?: now| today| free| for free)?|try [\p{L}\p{N}.-]+(?: for)? free|(?:start )?free trial|book(?: a| your)? (?:demo|call|meeting|consultation)|request(?: a| an)? (?:demo|quote|access|invite)|schedule(?: a)? (?:demo|call)|get(?: a)? (?:demo|quote)|get in touch|(?:contact|talk to|chat with)(?: sales| us| an expert| our team)?|learn more|read more|see (?:more|all|how|pricing|plans|details|it in action)|view (?:all|more|pricing|plans|demo|details)|find out more|explore(?: more| all| now| plans| pricing)?|discover more|watch(?: the)? (?:demo|video|now)|play video|download(?: now| free| the app| for (?:free|mac|windows|linux|ios|android))?|install(?: now| free| for free)?|buy(?: now)?|shop(?: now)?|order(?: now)?|subscribe(?: now)?|join(?: now| today| free| the waitlist| the beta| us)?|create(?: a| an| your)?(?: free)? account|open(?: an)? account|upgrade(?: now)?|(?:go to|open|launch) (?:app|the app|dashboard)|apply(?: now)?|more|menu|close|skip|accept(?: all)?|reject(?: all)?|got it|ok(?:ay)?|continue|submit|send)[\s.!:→›»>-]*$/iu;
  // The same phrases inside a short line: "Start your free trial today — no credit card needed".
  const CTA_INLINE = /\b(?:sign up|log in|get started|book a demo|request a demo|schedule a demo|get a demo|talk to (?:sales|an expert|our team)|contact (?:sales|us)|start (?:for free|your free trial|a free trial|building today)|try (?:it )?(?:for )?free|learn more|read more|create (?:a |an |your )?(?:free )?account)\b/i;
  // Section labels that introduce content but are not an offering themselves.
  const SECTION_LABEL = /^(?:(?:key |core |main |product |our |all )?features?|products?|(?:our )?solutions?|platform|(?:our )?services|overview|how it works|how [\p{L}\p{N}-]+ works|why [\p{L}\p{N} .&'’-]{1,40}|benefits|use cases?|integrations?|(?:plans|pricing)(?: (?:and|&) (?:pricing|plans))?|compare plans|choose (?:a|your) plan|faqs?|frequently asked questions|questions\??|got questions\??|testimonials?|reviews|(?:our )?customers?|customer stories|case studies|success stories|(?:trusted|loved|used|backed) by\b.*|what (?:our )?(?:customers|people|users|clients) (?:say|are saying)\b.*|in the (?:news|press)|press|resources|blog|latest(?: news| posts| articles| updates)?|news(?:room)?|careers|jobs|(?:our )?team|leadership|about(?: us)?|company|contact(?: us)?|get in touch|support|help(?: center)?|newsletter|subscribe|stay (?:in touch|updated|in the loop)|get started\b.*|ready to\b.*|start\b.*\btoday\b.*|join\b.*|sign up\b.*|try\b.*\bfree\b.*|download\b.*|partners|investors|security|legal|privacy|terms|cookies?|social|follow us|menu|navigation|search|language|more|related\b.*|explore\b.*|discover\b.*)$/iu;
  const PRICE_RE = /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kKmM](?![a-z]))?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|CAD|AUD|INR)\b)/;
  const PERIOD_RE = /^\s*(?:[A-Z]{3}\s*)?(?:(?:\/|per|a|an|each)\s*)(?:(?:active\s+)?(?:user|seat|member|editor|agent|host|month|mo|year|yr|annum|week|day|hour|license|site|project|team|workspace|creator)s?)\b(?:\s*,?\s*(?:\/|per)\s*(?:month|mo|year|yr|annum))?/i;
  const PLAN_NAME = /^(?:free|hobby|starter|basic|lite|personal|individual|plus|pro|professional|premium|team|teams|business|growth|scale|standard|advanced|ultimate|enterprise|custom|startup|agency|developer|essentials?|core|max|unlimited)\b/i;
  const AUDIENCE_WHO = '(?:(?:the\\s+)?(?:world[\'’]s\\s+)?(?:modern|growing|small|large|leading|best|top|global|busy|ambitious|high-growth|fast-moving|remote|distributed|creative|technical|innovative|every|all|your|data|product|support|sales|engineering|design|marketing|finance|security|it|ops|devops|platform)\\s+){0,3}(?:teams?|developers?|engineers?|designers?|creators?|businesses|startups?|enterprises?|individuals?|marketers?|students?|agencies|freelancers?|founders?|companies|organi[sz]ations?|professionals?|families|everyone|makers?|writers?|researchers?|educators?|nonprofits?|people|users?|customers?|merchants?|sellers?|brands?|small businesses|you)\\b';
  // The audience is written once, after the three ways in (V8 compiles each copy of it: one copy is ~40% quicker).
  const AUDIENCE_RE = new RegExp(`(?:\\b(?:(?:built|made|designed|crafted|tailored|perfect|ideal|engineered|optimi[sz]ed)\\s+(?:specifically\\s+|especially\\s+)?for\\s+|(?:trusted|used|loved)\\s+by\\s+(?:over\\s+|more than\\s+)?(?:[\\d,.]+\\s*(?:k|m|million|thousand)?\\+?\\s+)?)|^for\\s+)${AUDIENCE_WHO}`, 'i');
  const PRICING_PATH = /^(?:pricing|plans|plans-pricing|plans-and-pricing|price|prices|tarifs?|preise|precios|prezzi|precos|subscribe|buy|upgrade|compare-plans)$/i;
  const ABOUT_PATH = /^(?:about|about-us|aboutus|company|our-company|who-we-are|our-story|our-mission|why-us)$/i;
  const PRODUCT_PATH = /^(?:product|products|features?|solutions?|platform|services?|overview|tour|enterprise|teams|use-cases?|integrations|why-[\w-]+)$/i;
  const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];

  const briefText = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const ldTypes = (n) => [].concat((n && n['@type']) || []).map(String).join(' ');
  const isCtaLine = (t) => {
    const s = String(t || '').trim();
    return Boolean(s) && s.length <= 64 && (CTA_LINE.test(s) || (CTA_INLINE.test(s) && countWords(s) <= 9));
  };
  const listJoin = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '');

  const Briefing = {
    TYPES: BRIEF_TYPES,

    /** One display line: no URLs, citation brackets, zero-width characters or stray whitespace. */
    clean(text) {
      return Clean.display(Clean.citations(String(text || '').replace(/[→›»]+\s*$/, ''))).replace(/\s*[|·•]\s*$/, '').trim();
    },

    /** The first sentence(s) of a text, up to max characters, never ending mid-word; CTA sentences dropped. */
    summary(text, max = 170) {
      const t = this.clean(text);
      if (!t) return '';
      const out = [];
      for (const [s, e] of Clean.sentences(t, 'en')) {
        const sentence = t.slice(s, e).trim();
        if (!sentence || isCtaLine(sentence) || (CTA_INLINE.test(sentence) && countWords(sentence) <= 12)) continue;
        if (out.length && out.join(' ').length + sentence.length + 1 > max) break;
        out.push(sentence);
        if (out.join(' ').length >= max * 0.6) break;
      }
      const joined = out.join(' ');
      if (!joined) return '';
      if (joined.length <= max) return joined;
      // Too long: end on a clause ("…instead of every word…"), else on a whole word.
      const cut = joined.slice(0, max - 1);
      const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(': '), cut.lastIndexOf(' — '));
      const base = clause >= max * 0.55 ? cut.slice(0, clause) : cut.replace(/[\s,;:–—-]+\S*$/, '');
      return `${base.replace(/[\s,;:–—-]+$/, '')}…`;
    },

    /** Pass 1, on the raw page (before the Ad-Shield and Readability): every briefing candidate plus page signals. */
    scan(doc, ld = []) {
      const body = doc && doc.body;
      if (!body) return null;
      const signals = this.signals(doc, ld);
      const root = this.cleanClone(body);
      const hero = this.hero(root);
      const heads = this.headings(root);
      // Priced cards are a plan table ("Free · Pro · Enterprise") or priced items (a menu, a shop's products).
      const priced = this.plans(heads);
      const plans = priced.filter((p) => p.kind === 'plans');
      const items = priced.filter((p) => p.kind === 'items').flatMap((p) => p.list);
      const planEls = new Set(plans.flatMap((p) => p.els));
      const faq = this.faq(ld, root, heads);
      const faqTitles = new Set(faq.map((f) => norm(f.q)));
      const prices = new Map(items.map((p) => [norm(p.name), p.price]));
      const offerings = this.offerings(heads.filter((h) => !planEls.has(h.h) && !faqTitles.has(norm(h.title))), ld, { prices, lists: this.featureLists(root) });
      const used = new Set(offerings.map((o) => norm(o.title)));
      const sections = heads
        .filter((h) => h.level === 2 && !h.card && !used.has(norm(h.title)) && !planEls.has(h.h) && !faqTitles.has(norm(h.title)) && h.desc.length >= 40 && !SECTION_LABEL.test(h.title) && !isCtaLine(h.title) && !/\?$/.test(h.title))
        .slice(0, 4)
        .map((h) => ({ title: h.title, text: this.summary(h.desc, 170) }));
      const text = briefText(root);
      return {
        v: BRIEF_V,
        signals: { ...signals, cards: offerings.filter((o) => o.card).length, pitch: this.pitched(doc, hero) },
        identity: this.identity(doc, ld, hero),
        offerings: offerings.map(({ title, text: t }) => ({ title, text: t })),
        sections,
        faq,
        pricing: this.pricing(plans, ld, text, items),
        audience: this.audience(root, ld),
      };
    },

    /** Page-type signals read from the untouched page. */
    signals(doc, ld) {
      const types = new Set(ld.flatMap((n) => [].concat(n['@type'] || [])).map(String));
      const has = (re) => [...types].some((t) => re.test(t));
      const ogType = ((doc.querySelector('meta[property="og:type"]') || { getAttribute: () => '' }).getAttribute('content') || '').trim().toLowerCase();
      let ctas = 0;
      for (const el of Array.from(doc.querySelectorAll('a, button, [role="button"]')).slice(0, 800)) {
        const t = briefText(el);
        if (t && t.length <= 40 && isCtaLine(t) && /\b(?:sign|start|try|get|book|request|demo|trial|contact|talk|join|download|install|buy|subscribe|create|register)\b/i.test(t)) ctas++;
      }
      return {
        articleLd: has(/^(?:Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle|AnalysisNewsArticle|OpinionNewsArticle|ReportageNewsArticle|LiveBlogPosting|Recipe|HowTo)$/),
        companyLd: has(/^(?:Organization|Corporation|LocalBusiness|SoftwareApplication|WebApplication|MobileApplication|Product|Service|Brand|Store|OnlineStore|OnlineBusiness|ProfessionalService|Restaurant|FAQPage)$/),
        og: ogType,
        published: Boolean(doc.querySelector('meta[property="article:published_time"], meta[name="article:published_time"], meta[itemprop="datePublished"], [itemprop="datePublished"], meta[name="pubdate"], meta[name="publish-date"]')),
        byline: Boolean(doc.querySelector('meta[property="article:author"], a[rel="author"], [itemprop="author"], .byline')),
        ctas,
        sections: doc.querySelectorAll('section').length,
      };
    },

    /** Marketing copy up front: an audience line ("the only browser made for developers") in the description or hero. */
    pitched(doc, hero) {
      const metas = Array.from(doc.querySelectorAll('meta[name="description"], meta[property="og:description"]')).map((m) => m.getAttribute('content') || '');
      return [...metas, hero.title, hero.lead].some((t) => t && AUDIENCE_RE.test(t));
    },

    /** A copy of the page without chrome: menus, page headers, footers, forms, buttons, banners, quotes. */
    cleanClone(body) {
      const root = body.cloneNode(true);
      root.querySelectorAll(BRIEF_JUNK).forEach((n) => n.remove());
      const linkShare = (el, length) => {
        let n = 0;
        for (const a of el.querySelectorAll('a')) n += briefText(a).length;
        return length ? n / length : 0;
      };
      // Small cookie, consent and announcement boxes.
      for (const n of root.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [class*="gdpr" i], [class*="announcement" i]')) {
        if (n.isConnected && briefText(n).length < 700) n.remove();
      }
      // A page header that is only the logo and the menu (a hero inside <header> keeps its <h1>).
      for (const n of root.querySelectorAll('header, [role="banner"]')) {
        if (!n.isConnected || n.querySelector('h1')) continue;
        const length = briefText(n).length;
        if (length < 260 || linkShare(n, length) > 0.5) n.remove();
      }
      // Link farms: logo walls, sitemaps and tag clouds (a feature card wrapped in a link has a heading or text).
      for (const n of root.querySelectorAll('ul, ol, div')) {
        if (!n.isConnected || n.children.length < 4 || n.querySelector('h1, h2, h3, h4, p')) continue;
        const length = briefText(n).length;
        if (length && length < 1500 && linkShare(n, length) > 0.75) n.remove();
      }
      return root;
    },

    /** The hero: the page's <h1> and the first real sentence right after it. */
    hero(root) {
      const h1 = root.querySelector('h1');
      if (!h1) return { title: '', lead: '' };
      const title = this.clean(briefText(h1));
      const scope = h1.closest('section, header, main, article') || h1.parentElement || root;
      let lead = '';
      for (const el of scope.querySelectorAll('p, div, span, h2')) {
        if (!(h1.compareDocumentPosition(el) & 4) || h1.contains(el)) continue; // only what follows the heading
        if (el.tagName === 'H2') break;
        if (el.tagName !== 'P' && el.querySelector('p, div, h1, h2, h3, ul, ol')) continue;
        const t = this.clean(briefText(el));
        if (t.length >= 30 && t.length <= 480 && !isCtaLine(t) && countWords(t) >= 6) {
          lead = t;
          break;
        }
      }
      return { title, lead };
    },

    /** Every h2–h4 with its card (the largest ancestor holding no other heading) and its own text. */
    headings(root) {
      const doc = root.ownerDocument;
      const list = Array.from(root.querySelectorAll('h2, h3, h4')).slice(0, 320);
      const out = [];
      list.forEach((h, k) => {
        const title = this.clean(briefText(h));
        if (!title || title.length > 160) return;
        let card = null;
        for (let el = h.parentElement; el && el !== root; el = el.parentElement) {
          if (el.querySelectorAll('h1, h2, h3, h4, h5, h6').length > 1 || (el.textContent || '').length > 1400) break;
          card = el;
        }
        // Only what follows the heading belongs to it: eyebrow labels above the heading are ignored.
        let lines = card ? this.linesAfter(doc, h, card, null, root) : [];
        if (!lines.some((b) => b.text.length >= 15)) {
          lines = this.linesAfter(doc, card || h, null, list[k + 1] || null, root);
          card = null;
        }
        const all = lines.map((b) => b.text).join(' ');
        const paras = lines.filter((b) => b.t === 'p' && !PRICE_RE.test(b.text.slice(0, 14)));
        const items = lines.filter((b) => b.t === 'li').map((b) => b.text.replace(/[.;,]+$/, ''));
        let desc = paras.length ? paras.slice(0, 2).map((b) => b.text).join(' ') : '';
        if (!desc && items.length) desc = `${listJoin(items.slice(0, 3))}.`;
        out.push({ h, level: Number(h.tagName[1]), title, card, group: card ? card.parentElement : null, desc, all });
      });
      return out;
    },

    /** The text blocks after a node: to the end of its card, or up to the next heading. */
    linesAfter(doc, start, container, next, root) {
      const range = doc.createRange();
      const box = doc.createElement('div');
      try {
        range.setStartAfter(start);
        if (container) range.setEnd(container, container.childNodes.length);
        else if (next && start.compareDocumentPosition(next) & 4) range.setEndBefore(next);
        else range.setEnd(root, root.childNodes.length);
        box.appendChild(range.cloneContents());
      } catch {
        return [];
      }
      return Extractor.blocks(box)
        .filter((b) => (b.t === 'p' || b.t === 'li') && b.text)
        .slice(0, 12)
        .map((b) => ({ t: b.t, text: this.clean(b.text) }))
        .filter((b) => b.text.length > 2 && !isCtaLine(b.text));
    },

    /** "What they provide": the best feature grid(s), else the page's sections, else JSON-LD featureList. */
    offerings(heads, ld, { prices = new Map(), lists = [] } = {}) {
      const usable = heads.filter((c) => c.title.length <= 80 && countWords(c.title) <= 12 && !SECTION_LABEL.test(c.title) && !isCtaLine(c.title) && !/\?$/.test(c.title) && !PRICE_RE.test(c.title));
      const groups = new Map();
      for (const c of usable) {
        if (!c.card || !c.group) continue;
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
      }
      const grids = [...groups.values()]
        .map((g) => ({ g, described: g.filter((c) => c.desc.length >= 15).length, level: g[0].level }))
        .filter((x) => x.described >= 2)
        .map((x) => ({ ...x, score: x.described * 2 + (x.g.length >= 3 ? 2 : 0) + (x.level === 3 ? 1 : 0) }));
      const seen = new Set();
      const out = [];
      const push = (title, text, card) => {
        const key = norm(title);
        if (!key || seen.has(key) || out.length >= 6) return;
        seen.add(key);
        const price = prices.get(key);
        out.push({ title: trimText(price ? `${title} · ${price}` : title, 80), text: this.summary(text, 120), card });
      };
      if (grids.length) {
        // The strongest grid first, then the others in page order.
        const best = grids.reduce((a, b) => (b.score > a.score ? b : a));
        for (const c of best.g) if (c.desc.length >= 15) push(c.title, c.desc, true);
        for (const x of grids) if (x !== best) for (const c of x.g) if (c.desc.length >= 15) push(c.title, c.desc, true);
      }
      // A feature list (<li><strong>Title</strong> description</li>) before loose sections and lone cards.
      if (out.length < 3) for (const f of lists) push(f.title, f.text, false);
      if (out.length < 3) for (const c of usable) if (c.level <= 3 && c.desc.length >= 30) push(c.title, c.desc, Boolean(c.card));
      if (out.length < 2) {
        const app = ld.find((n) => Array.isArray(n.featureList) || typeof n.featureList === 'string');
        const features = app ? [].concat(app.featureList).filter((f) => typeof f === 'string') : [];
        for (const f of features) {
          const t = this.clean(f);
          const cut = t.search(/[:—–]\s/);
          if (cut > 2 && cut <= 60) push(t.slice(0, cut), t.slice(cut + 1).trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase()), false);
          else push(trimText(t, 70), '', false);
        }
      }
      return out;
    },

    /** Feature lists: three or more <li><strong>Instant builds</strong> — Rebuilds a site in a second.</li>. */
    featureLists(root) {
      for (const list of root.querySelectorAll('ul, ol')) {
        const items = Array.from(list.children).filter((li) => li.tagName === 'LI');
        if (items.length < 3 || items.length > 12) continue;
        const parsed = [];
        for (const li of items) {
          const head = li.firstElementChild;
          const all = briefText(li);
          const lead = briefText(head);
          if (!head || !/^(?:STRONG|B|H3|H4|H5)$/.test(head.tagName) || !lead || !all.startsWith(lead)) break;
          const title = this.clean(lead).replace(/[\s:.–—-]+$/, '');
          const rest = this.clean(all.slice(lead.length).replace(/^[\s:.–—-]+/, ''));
          if (!title || title.length > 60 || rest.length < 15 || isCtaLine(title)) break;
          parsed.push({ title, text: rest.charAt(0).toUpperCase() + rest.slice(1) });
        }
        if (parsed.length === items.length) return parsed;
      }
      return [];
    },

    /** Plan cards: a short plan name with a price, "Free", or "Custom" — from the biggest pricing table. */
    plans(heads) {
      const found = [];
      for (const c of heads) {
        if (!c.card || c.title.length > 32 || countWords(c.title) > 4) continue;
        const text = `${c.title} ${c.all}`;
        const m = text.match(PRICE_RE);
        let price = '';
        if (m && (PLAN_NAME.test(c.title) || countWords(c.title) <= 2)) price = this.priceLabel(text, m);
        else if (PLAN_NAME.test(c.title) && /\bfree\b|\$0\b/i.test(text)) price = 'Free';
        else if (PLAN_NAME.test(c.title) && /\b(?:custom|contact (?:us|sales)|talk to (?:us|sales)|let['’]s talk|get a quote|on request|tailored)\b/i.test(text)) price = 'Custom pricing';
        if (price) found.push({ name: c.title, price, desc: this.planDesc(c.all), group: c.group, el: c.h });
      }
      const byGroup = new Map();
      for (const p of found) {
        if (!byGroup.has(p.group)) byGroup.set(p.group, []);
        byGroup.get(p.group).push(p);
      }
      let best = [];
      for (const list of byGroup.values()) if (list.length > best.length) best = list;
      if (!best.length || (best.length < 2 && !PLAN_NAME.test(best[0].name))) return [];
      // Mostly plan names (Free, Pro, Team, Enterprise …) → a plan table; otherwise priced items, like a menu.
      const kind = best.filter((p) => PLAN_NAME.test(p.name)).length * 2 >= best.length ? 'plans' : 'items';
      return [{ kind, els: best.map((p) => p.el), list: best.slice(0, kind === 'plans' ? 5 : 8).map(({ name, price, desc }) => ({ name, price, desc })) }];
    },

    /** A plan card's own words without its price lines: "Sync on every device and offline mode." */
    planDesc(text) {
      const t = String(text || '')
        .replace(new RegExp(`${PRICE_RE.source}[^.]{0,28}(?:month|mo|year|yr|annum|user|seat)s?\\b\\.?`, 'gi'), ' ')
        .replace(new RegExp(PRICE_RE.source, 'g'), ' ')
        .replace(/\b(?:free|custom pricing|billed (?:annually|yearly|monthly))\b\.?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return this.summary(t.replace(/^[\s,.;:–—-]+/, ''), 90);
    },

    /** "$12" + "/user/mo" → "$12 per user per month" (billed annually when the card says so). */
    priceLabel(text, m) {
      const amount = m[0].replace(/\s+/g, '');
      const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const per = rest.match(PERIOD_RE);
      let label = amount;
      if (per) {
        const words = per[0].toLowerCase().match(/[a-z]+/g) || [];
        const units = words
          .filter((w) => !/^(?:per|a|an|each|active)$/.test(w))
          .map((w) => ({ mo: 'month', months: 'month', yr: 'year', yrs: 'year', annum: 'year' })[w] || w.replace(/s$/, ''));
        if (units.length) label += ` ${units.map((u) => `per ${u}`).join(' ')}`;
      }
      if (/\bbilled (?:annually|yearly)\b/i.test(text)) label += ', billed annually';
      return label;
    },

    /** Pricing & access: plans, a free tier or trial, open source, JSON-LD offers. */
    pricing(plans, ld, text, items = []) {
      const list = plans.length ? plans[0].list : [];
      const notes = [];
      const freePlan = list.some((p) => p.price === 'Free' || /^[$€£¥₹]0(?:\.0+)?(?!\d)/.test(p.price));
      const offers = ld.flatMap((n) => [].concat(n.offers || [])).filter((o) => o && typeof o === 'object');
      const ldFree = offers.some((o) => Number(o.price) === 0 || Number(o.lowPrice) === 0) || ld.some((n) => n.isAccessibleForFree === true || n.isAccessibleForFree === 'true');
      const paid = list.some((p) => p.price !== 'Free' && !/^[$€£¥₹]0(?:\.0+)?(?!\d)/.test(p.price)) || offers.some((o) => Number(o.price) > 0 || Number(o.lowPrice) > 0);
      if (freePlan || ldFree || /\bfree (?:and|&) open[- ]source\b|\bfree (?:plan|tier|forever|version|account)\b|\bfree for (?:individuals|personal use|small teams|ever)\b|\bfree to (?:use|start|get started)\b|\bfreemium\b|\bstart for free\b|\bget started for free\b|\$0\b/i.test(text)) notes.push(paid || list.length ? 'a free plan is available' : 'free to use');
      const trial = text.match(/\b(\d{1,3})[- ]day (?:free )?trial\b/i);
      if (trial) notes.push(`a ${trial[1]}-day free trial`);
      else if (/\bfree trial\b/i.test(text)) notes.push('a free trial');
      if (/\b(?:is|are|fully|completely|100%|proudly|and|,)\s+open[- ]source\b|\bopen[- ]source\s+(?:and|&)\s+free\b|\bfree\s+(?:and|&)\s+open[- ]source\b|\b(?:MIT|Apache(?:[- ]2\.0)?|GPL(?:v[23])?|BSD|MPL)[- ]licen[cs]ed?\b/i.test(text) || ld.some((n) => /SoftwareSourceCode/.test(ldTypes(n)) || typeof n.codeRepository === 'string')) notes.push('open source');
      if (/\bno credit card (?:required|needed)\b/i.test(text)) notes.push('no credit card required');
      const range = ld.map((n) => n.priceRange).find((r) => typeof r === 'string' && r.trim());
      if (range) notes.push(/^\s*[$€£¥₹]{1,4}\s*$/.test(range) ? ['inexpensive', 'moderately priced', 'upscale', 'fine dining'][Math.min(3, range.trim().length - 1)] : `prices ${range.trim()}`);
      const amounts = items.map((p) => p.price.match(/^([$€£¥₹]?)\s?(\d[\d,]*(?:\.\d+)?)/)).filter(Boolean);
      if (!list.length && amounts.length >= 2 && amounts.every((a) => a[1] === amounts[0][1])) {
        const nums = amounts.map((a) => Number(a[2].replace(/,/g, '')));
        const low = Math.min(...nums);
        const high = Math.max(...nums);
        const cur = amounts[0][1];
        notes.push(high > low ? `prices from ${cur}${low} to ${cur}${high}` : `prices around ${cur}${low}`);
      }
      if (!list.length) {
        const priced = offers.find((o) => Number(o.price) > 0 || Number(o.lowPrice) > 0);
        if (priced) {
          const cur = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' }[String(priced.priceCurrency || '').toUpperCase()] || '';
          const low = Number(priced.lowPrice) || Number(priced.price);
          const high = Number(priced.highPrice);
          notes.push(high > low ? `from ${cur}${low} to ${cur}${high}` : `from ${cur}${low}${cur ? '' : ` ${priced.priceCurrency || ''}`}`.trim());
        }
        if (/\benterprise\b[^.]{0,80}\b(?:custom|contact|on request|quote)\b/i.test(text)) notes.push('enterprise plans on request');
      }
      if (!list.length && !notes.length) return null;
      let parts = notes;
      if (parts[0] === 'free to use' && parts.includes('open source')) parts = ['free and open source', ...parts.slice(1).filter((p) => p !== 'open source')];
      const summary = parts.length ? `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, with ${listJoin(parts.slice(1))}` : ''}.` : '';
      return { summary, plans: list };
    },

    /** Who it's for: "Built for …", "Designed for …", "Trusted by 15,000 teams". */
    audience(root, ld) {
      const out = [];
      const add = (t) => {
        const s = this.clean(t).replace(/\s*[.!]*$/, '.');
        if (s.length < 12 || s.length > 180 || isCtaLine(s) || out.some((x) => norm(x) === norm(s))) return;
        out.push(s.charAt(0).toUpperCase() + s.slice(1));
      };
      for (const n of ld) {
        const a = n.audience && typeof n.audience === 'object' ? n.audience.audienceType : '';
        if (typeof a === 'string' && a.trim()) add(`Built for ${a.trim()}`);
      }
      for (const el of root.querySelectorAll('h1, h2, h3, h4, p, li')) {
        if (out.length >= 3) break;
        const t = briefText(el);
        if (t.length > 220 || !AUDIENCE_RE.test(t)) continue;
        // The sentence that carries the statement, not the whole paragraph.
        const sentence = Clean.sentences(t, 'en').map(([s, e]) => t.slice(s, e).trim()).find((x) => AUDIENCE_RE.test(x)) || t;
        add(sentence);
      }
      const proof = (s) => (/^(?:trusted|used|loved)\b/i.test(s) ? 1 : 0);
      return out.sort((a, b) => proof(a) - proof(b)).slice(0, 2);
    },

    /** JSON-LD FAQPage, <details>/<summary>, question headings and <dt>/<dd> pairs. */
    faq(ld, root, heads) {
      const out = [];
      const add = (q, a) => {
        const question = this.clean(q);
        const answer = this.summary(a, 160);
        if (!question || !answer || question.length > 160 || isCtaLine(question) || SECTION_LABEL.test(question) || (/^(?:ready|want|need|looking)\b.*\?$/i.test(question) && countWords(question) <= 6)) return;
        if (out.some((x) => norm(x.q) === norm(question))) return;
        out.push({ q: question, a: answer });
      };
      const plain = (html) => {
        const s = String(html || '');
        return /[<&]/.test(s) ? briefText(new DOMParser().parseFromString(`<!DOCTYPE html><body>${s}`, 'text/html').body) : s;
      };
      for (const n of ld) {
        if (!/\bFAQPage\b/.test(ldTypes(n))) continue;
        for (const e of [].concat(n.mainEntity || [])) {
          if (!e || typeof e.name !== 'string') continue;
          const answer = [].concat(e.acceptedAnswer || e.suggestedAnswer || [])[0];
          add(e.name, plain(answer && typeof answer === 'object' ? answer.text : answer));
        }
      }
      for (const d of root.querySelectorAll('details')) {
        const s = d.querySelector('summary');
        if (!s) continue;
        const copy = d.cloneNode(true);
        const sum = copy.querySelector('summary');
        if (sum) sum.remove();
        add(briefText(s), briefText(copy));
      }
      for (const c of heads) if (/\?$/.test(c.title) && c.desc) add(c.title, c.desc);
      for (const dt of root.querySelectorAll('dt')) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD' && /\?\s*$/.test(briefText(dt))) add(briefText(dt), briefText(dd));
      }
      return out.slice(0, 8);
    },

    /** Who they are: the organisation's name, descriptions, the hero line and a few JSON-LD facts. */
    identity(doc, ld, hero) {
      const pick = (re) => ld.find((n) => re.test(ldTypes(n)) && typeof n.name === 'string' && n.name.trim());
      const org = pick(/\b(?:Organization|Corporation|LocalBusiness|Store|Restaurant|ProfessionalService|NGO|EducationalOrganization|GovernmentOrganization|MedicalOrganization|SportsOrganization|NewsMediaOrganization|OnlineBusiness|OnlineStore|Brand)\b/);
      const app = pick(/\b(?:SoftwareApplication|WebApplication|MobileApplication|Product|Service|FinancialProduct|Course|VideoGame)\b/);
      const site = pick(/\bWebSite\b/);
      const metaOf = (sel) => {
        const el = doc.querySelector(sel);
        return el ? (el.getAttribute('content') || '').trim() : '';
      };
      const descriptions = [];
      for (const n of [app, org, site]) if (n && typeof n.description === 'string') descriptions.push({ text: n.description, from: 'ld' });
      for (const sel of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
        const v = metaOf(sel);
        if (v) descriptions.push({ text: v, from: 'meta' });
      }
      if (hero.lead) descriptions.push({ text: hero.lead, from: 'hero' });
      const facts = [];
      const year = String((org && org.foundingDate) || '').match(/\b(1[6-9]\d\d|20\d\d)\b/);
      if (year) facts.push({ label: `Founded ${year[1]}`, speech: `Founded in ${year[1]}` });
      const addr = [].concat((org && org.address) || (app && app.address) || [])[0];
      if (addr && typeof addr === 'object') {
        let country = addr.addressCountry && typeof addr.addressCountry === 'object' ? addr.addressCountry.name : addr.addressCountry;
        if (typeof country === 'string' && /^[A-Z]{2}$/.test(country.trim())) {
          try {
            country = new Intl.DisplayNames(['en'], { type: 'region' }).of(country.trim()) || country;
          } catch {
            /* keep the code */
          }
        }
        const place = [addr.addressLocality, addr.addressRegion, country].filter((x) => typeof x === 'string' && x.trim()).slice(0, 2).join(', ');
        if (place) facts.push({ label: place, speech: `Based in ${place}` });
      }
      const rating = [app, org].map((n) => n && n.aggregateRating).find((r) => r && Number(r.ratingValue) > 0);
      if (rating) {
        const value = Math.round(Number(rating.ratingValue) * 10) / 10;
        const best = Number(rating.bestRating) || 5;
        const count = Number(rating.ratingCount || rating.reviewCount) || 0;
        facts.push({ label: `Rated ${value}/${best}${count ? ` · ${fmtNumber(count)} ratings` : ''}`, speech: `Rated ${value} out of ${best}${count ? ` from ${fmtNumber(count)} ratings` : ''}` });
      }
      return {
        name: (org && org.name) || (site && site.name) || '',
        product: app ? app.name : '',
        descriptions: descriptions.map((d) => ({ text: this.clean(d.text), from: d.from })).filter((d) => d.text.length >= 20),
        headline: hero.title,
        facts: facts.slice(0, 3),
      };
    },

    /** The page type, and whether the briefing should be the default way to hear it. */
    classify(raw, signals = {}, counts = {}) {
      if (raw.kind === 'broadcast') return { type: 'feed', auto: false };
      if (raw.kind === 'text' || raw.kind === 'selection') return { type: 'text', auto: false };
      // A code repository (GitHub): briefed like a product — what it is, what it provides, its licence — but its README opens in full.
      if (raw.pageType === 'repository') return { type: 'product', auto: false };
      // A person's profile (og:type profile: GitHub, social sites): about someone, so briefed like a page, never as a company.
      if (signals.og === 'profile') return { type: 'article', auto: false };
      let path = '/';
      let host = '';
      try {
        const u = new URL(raw.url);
        path = u.pathname;
        host = u.hostname;
      } catch {
        /* no address: classify on the content alone */
      }
      const segs = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
      const projectSite = /\.(?:github|gitlab)\.io$|\.(?:netlify|vercel)\.app$|\.pages\.dev$/i.test(host);
      const LOCALE = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|index\.(?:html?|php|aspx?)|home|default\.aspx?)$/i;
      const root = segs.length === 0 || (segs.length === 1 && (LOCALE.test(segs[0]) || projectSite)) || (segs.length === 2 && projectSite && LOCALE.test(segs[1]));
      const bare = segs.map((s) => s.replace(/\.(?:html?|php|aspx?)$/, ''));
      const any = (re) => bare.some((s) => re.test(s));
      const tail = bare.filter((s, i) => !(i === 0 && LOCALE.test(s) && bare.length > 1)); // "/en-gb/pricing" → ["pricing"]
      // A pricing or about page sits near the top of the site ("/pricing", "/en/about", "/pricing/teams").
      const near = (re) => tail.length > 0 && tail.length <= 2 && re.test(tail[0]);
      const narrative = counts.paragraphs >= 6 && counts.avgPara >= 160 && counts.chars >= 2500;
      const article = Boolean(signals.articleLd || signals.og === 'article' || (signals.published && narrative));
      if (root && !(article && !signals.companyLd)) return { type: 'home', auto: true };
      if (!article && near(PRICING_PATH)) return { type: 'pricing', auto: true };
      if (!article && near(ABOUT_PATH) && tail.length === 1) return { type: 'about', auto: true };
      if (article) return { type: 'article', auto: false };
      let score = 0;
      if (signals.companyLd) score += 2;
      score += Math.min(3, signals.ctas || 0);
      if ((signals.cards || 0) >= 3) score += 2;
      if (counts.plans >= 2 || counts.pricing) score += 1;
      if (counts.faq >= 2) score += 1;
      if ((signals.sections || 0) >= 4) score += 1;
      if (signals.og === 'website') score += 1;
      if (signals.pitch) score += 1;
      if (counts.paragraphs && counts.avgPara < 130 && counts.headRatio >= 0.3) score += 2;
      if (narrative) score -= 3;
      if (signals.byline && signals.published) score -= 2;
      if (score >= 4) return { type: any(PRODUCT_PATH) ? 'product' : 'landing', auto: true };
      return { type: 'article', auto: false };
    },

    /** Shape of the readable text Readability found: long narrative paragraphs, or scattered marketing lines. */
    counts(blocks = []) {
      const paras = blocks.filter((b) => b.t === 'p');
      const chars = paras.reduce((n, b) => n + (b.text || '').length, 0);
      const heads = blocks.filter((b) => b.t === 'h').length;
      return { paragraphs: paras.length, chars, avgPara: paras.length ? chars / paras.length : 0, headRatio: paras.length ? heads / paras.length : heads ? 1 : 0 };
    },

    /** Section takeaways from the readable text: each h2/h3 with the first sentence under it. */
    takeaways(blocks = [], max = 4, { labels = true, captions = [], said = [] } = {}) {
      const out = [];
      // Never a photo caption, a reader call-out, a dangling "…include:" lead-in, or what card 1 already says.
      const unit = (x) => ({ text: x, words: new Set(sumWords(x, 'en')) });
      const saidUnits = said.filter(Boolean).flatMap((x) => Clean.sentences(x, 'en').map(([a, b]) => x.slice(a, b).trim()).filter(Boolean)).map(unit);
      const skip = (t) => !t || Summary.junk(t, captions) || saidUnits.some((x) => Summary.similar(x, unit(t)));
      for (let i = 0; i < blocks.length && out.length < max; i++) {
        const b = blocks[i];
        if (b.t !== 'h' || b.level < 2 || b.level > 3 || JUNK_SECTION.test(b.text || '') || (!labels && (SECTION_LABEL.test(b.text) || isCtaLine(b.text)))) continue;
        let next = null;
        for (let j = i + 1; j < blocks.length && j < i + 8; j++) {
          if (blocks[j].t === 'h') break;
          if ((blocks[j].t === 'p' || blocks[j].t === 'li') && countWords(blocks[j].text) >= 5 && !skip(this.summary(blocks[j].text, 170))) {
            next = blocks[j];
            break;
          }
        }
        const text = next ? this.summary(next.text, 170) : '';
        if (text) out.push({ title: this.clean(b.text), text });
      }
      if (!out.length) {
        for (const b of blocks) {
          if (out.length >= 3) break;
          if (b.t !== 'p' || countWords(b.text) < 6) continue;
          const text = this.summary(Summary.tidy(b.text, { connective: false }), 170);
          if (!skip(text) && !out.some((t) => Summary.similar({ text: t.text, words: new Set(sumWords(t.text, 'en')) }, { text, words: new Set(sumWords(text, 'en')) }))) out.push({ title: '', text });
        }
      }
      return out.filter((t) => t.text);
    },

    /** Pass 2: the final, storable dossier for a raw document (with or without a pass-1 scan of its page). */
    finish(scan, raw) {
      const s = scan || { signals: {}, identity: { descriptions: [], facts: [] }, offerings: [], sections: [], faq: [], pricing: null, audience: [] };
      const counts = this.counts(raw.blocks);
      const { type, auto } = this.classify(raw, s.signals, { ...counts, plans: s.pricing ? s.pricing.plans.length : 0, pricing: Boolean(s.pricing), faq: s.faq.length });
      const known = knownSite(raw.hostname);
      const name = cleanSiteName(s.identity.name || (known && known.name) || raw.siteName || siteLabel(raw.hostname)) || 'This website';
      const domain = bareHost(raw.hostname || '');
      const page = type === 'article' || type === 'feed' || type === 'text';
      const brief = { v: BRIEF_V, type, auto, name, domain, what: null, tagline: '', facts: [], offerings: [], pricing: null, audience: [], faq: [], takeaways: [] };
      if (page) {
        const lede = (raw.blocks || []).find((b) => b.t === 'p' && countWords(b.text) >= 6);
        // Whole sentences of the description (a site's own "…" cut is dropped), without a byline or dateline.
        const lead = Summary.tidy(raw.excerpt || (lede && lede.text) || '', { connective: false });
        const text = this.summary(Summary.opening(lead, raw.lang || 'en') || lead, 220);
        brief.what = { title: this.clean(Summary.bareTitle(raw.title, name)), text, author: raw.author && norm(raw.author) !== norm(name) ? raw.author : '' };
        brief.takeaways = this.takeaways(raw.blocks, 4, { captions: (raw.structure && raw.structure.captions) || [], said: [text] }).filter((t) => norm(t.text) !== norm(text));
        brief.faq = s.faq.slice(0, 3);
      } else {
        brief.what = { title: '', text: this.valueProp(s.identity, name, raw) };
        const headline = s.identity.headline;
        if (headline && countWords(headline) >= 3 && headline.length <= 140 && norm(headline) !== norm(name) && !norm(brief.what.text).includes(norm(headline)) && !isCtaLine(headline)) brief.tagline = headline;
        brief.facts = s.identity.facts || [];
        brief.offerings = s.offerings.slice(0, 6);
        if (brief.offerings.length < 2 && s.sections.length) brief.offerings = [...brief.offerings, ...s.sections].slice(0, 6);
        brief.pricing = s.pricing;
        brief.audience = s.audience;
        brief.faq = s.faq.slice(0, 3);
        const usedTitles = new Set(brief.offerings.map((o) => norm(o.title)));
        brief.takeaways = brief.faq.length ? [] : s.sections.filter((x) => !usedTitles.has(norm(x.title))).slice(0, 3);
        const planNames = new Set((brief.pricing ? brief.pricing.plans : []).map((p) => norm(p.name)));
        if (!brief.offerings.length && !brief.faq.length && !brief.takeaways.length) brief.takeaways = this.takeaways(raw.blocks, 3, { labels: false }).filter((t) => !planNames.has(norm(t.title)));
        // Never repeat what card 1 already says.
        const said = [brief.what && brief.what.text, brief.tagline].filter(Boolean).map(norm);
        brief.takeaways = brief.takeaways.filter((t) => !said.some((x) => x && (x.includes(norm(t.text)) || norm(t.text).includes(x) || x === norm(t.title))));
      }
      brief.data = this.dataItems(raw.structure, brief);
      if (!brief.what.text && !brief.what.title) brief.what = null;
      // A page with almost nothing to brief on stays a full read by default.
      const parts = (brief.what && brief.what.text ? 1 : 0) + Math.min(2, brief.offerings.length) + (brief.pricing ? 1 : 0) + Math.min(2, brief.faq.length + brief.takeaways.length);
      brief.auto = auto && parts >= 2;
      brief.parts = parts;
      return brief;
    },

    /**
     * The page's tables, spec lists and comparison grids for the briefing (at most two): a pricing table first
     * (unless the plan cards already gave the prices), then key–value specs, then the largest data table.
     */
    dataItems(structure, brief) {
      if (!structure || structure.v !== Summary.V) return [];
      const grids = [...(structure.tables || []), ...(structure.dls || []).map((d) => ({ kind: 'kv', title: d.title, pairs: d.pairs, total: d.pairs.length }))];
      const text = (g) => `${g.title || ''} ${g.heading || ''} ${(g.headers || []).join(' ')} ${g.kind === 'kv' ? g.pairs.flat().join(' ') : (g.rows || []).slice(0, 4).flat().join(' ')}`;
      const priced = (g) => /\b(?:pric|plans?\b|cost|per (?:month|user|seat|year))/i.test(`${g.title || ''} ${g.heading || ''} ${(g.headers || []).join(' ')}`) || (text(g).match(new RegExp(PRICE_RE.source, 'g')) || []).length >= 2;
      const size = (g) => (g.kind === 'kv' ? g.pairs.length * 2 : (g.total || 0) * (g.cols || 1));
      const out = [];
      const pricing = grids.filter(priced).sort((a, b) => size(b) - size(a))[0];
      if (pricing && !(brief.pricing && brief.pricing.plans && brief.pricing.plans.length)) out.push({ ...pricing, pricing: true });
      const rest = grids.filter((g) => g !== pricing).sort((a, b) => (b.kind === 'kv') - (a.kind === 'kv') || size(b) - size(a));
      for (const g of rest) if (out.length < 2) out.push(g);
      return out;
    },

    /** The one-sentence value proposition: a definition ("X is a …") beats a slogan; CTAs are cut. */
    valueProp(identity, name, raw) {
      const n = norm(name);
      const scored = (identity.descriptions || []).concat(raw.excerpt ? [{ text: raw.excerpt, from: 'meta' }] : []).map((d, i) => {
        const text = this.summary(d.text, 260);
        const lower = text.toLowerCase();
        // The site's own description (JSON-LD, then meta) is written to say what it is; a hero line is a pitch.
        let score = d.from === 'ld' ? 1.5 : d.from === 'meta' ? 1 : 0;
        if (/\b(?:is|are)\s+(?:a|an|the|your)\b/i.test(text)) score += 3;
        if (n && norm(text.split(/\s+/).slice(0, 4).join(' ')).includes(n)) score += 2;
        if (text.length >= 60 && text.length <= 260) score += 1;
        if (/\b(?:helps?|lets?|enables?|provides?|offers?|makes?|powers?)\b/.test(lower)) score += 0.5;
        return { text, score: text ? score - i * 0.01 : -9 };
      });
      const best = scored.sort((a, b) => b.score - a.score)[0];
      return best && best.score > -9 ? best.text : '';
    },

    /** The dossier for a raw document: the stored pass-2 result, or one derived from its text alone. */
    of(raw) {
      if (!raw) return null;
      if (raw.briefing && raw.briefing.v === BRIEF_V && raw.briefing.what !== undefined) return raw.briefing;
      return this.finish(null, raw);
    },

    /** True when this document can be heard as a Site Briefing at all. */
    available(raw) {
      return Boolean(raw) && raw.kind !== 'text' && raw.kind !== 'selection';
    },
  };

  /* ======================================================== ✨ Summarize Page
   * A summary of the whole page, top to bottom: the page's own description, then every section (h1 → each
   * h2 / h3, or the beginning, middle and end of a page without headings), plus every meaningful table,
   * definition list, key list and pricing grid turned into spoken prose. It runs after the Ad-Shield, so ads,
   * pop-ups and promo blocks never reach it, and it never skips a table (Skip Tables is for the full read).
   *
   * Deterministic, offline, zero API: each sentence is scored by TextRank centrality over TF-IDF vectors,
   * closeness to its own section, position, numbers and names, and the title's keywords; captions, calls to
   * action, reader call-outs, datelines and repeats are dropped. Chrome's on-device Summarizer (or an LLM
   * you configured in the Turbo Engine) can rewrite the section text instead; tables are always synthesised
   * here, so their numbers are exact. */
  const SUMMARY_V = 1;
  // What a site says about every page it serves (GitHub profile and repository descriptions).
  const SITE_BOILERPLATE = /\bhas \d[\d,]* repositor(?:y|ies) available\b|\bfollow (?:their|his|her|our|my) (?:code|work)\b|development by creating an account on GitHub/i;
  const SUM_STOP = new Set(
    `a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also just like one two said says say new many much may might must us via per etc yet still even well get got make made way use used using within without however although though since whether either neither every`.split(/\s+/),
  );
  // Containers a summary never reads: navigation, page chrome, sidebars, banners, dialogs, hidden and screen-reader-only nodes.
  const SUM_SKIP = [
    'nav', 'footer', 'aside', 'form', 'header[role="banner"]', 'body > header', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
    '[role="complementary"]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog', '[hidden]', '[aria-hidden="true"]', '.sr-only', '.visually-hidden',
    '.navbox', '.vertical-navbox', '.sidebar', '.metadata', '.ambox', '.mbox-small', '.toc', '#toc', '.reflist', '.mw-references-wrap', '.noprint', '.cookie-banner', '#onetrust-consent-sdk',
  ].join(',');
  const SUM_CAPTION = 'figcaption, cite, [class*="caption" i], [id*="caption" i], [class*="credit" i], [itemprop="caption"], .wp-caption-text';
  const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  const CAPTION_LEAD = /^(?:\((?:l|r|c|left|right|centre|center|top|bottom|above|below|from left|l\s*[-–to]+\s*r|r\s*[-–to]+\s*l)\b[^)]{0,30}\)|(?:photo|photograph|image|picture|illustration|video|graphic|chart|map|credit|source|caption)s?\s*(?:[:|]|by\b)|getty images|ap photo|afp via|reuters\/)/i;
  const READER_PROMPT = /\b(?:share your (?:videos?|photos?|pictures|images|stories|story|thoughts|experiences?|views)|send (?:us|in) your (?:photos?|videos?|tips?|stories)|tell us (?:what|about|in the comments|your)|let us know (?:in the comments|what you think|your)|leave (?:a|your) comment|comment below|join the (?:conversation|discussion)|follow (?:us|@\w+) on|download (?:our|the) (?:free )?app|click here|tap here|(?:watch|see) the (?:full )?video|listen to (?:the|our) (?:podcast|episode)|read the full (?:story|article|report|interview)|ireport|for more (?:news|stories|information|updates)\b[^.]{0,30}\b(?:visit|go to|see|follow)|this (?:article|story|post|report) (?:was|has been) (?:updated|corrected|originally published|amended)|contributed to this (?:report|story|article)|(?:is|are) available (?:on|at) (?:www\.|https?:)|sign up for (?:our|the) [\w ]{0,30}newsletter|subscribe (?:now|today|here|to (?:our|the))|support (?:our|independent) journalism|become a (?:member|subscriber|patron))/i;
  const SUM_DATELINE = /^(?:\([A-Z][A-Za-z.&]{1,14}\)\s*(?:[—–-]{1,2}|:)\s+|[A-Z][A-Z.'’-]{2,}(?:[ ,]+[A-Z][A-Za-z.'’-]+){0,3}\s*\((?:[A-Z][A-Za-z.&]{1,14})(?:\/[A-Z][A-Za-z.&]{1,14})?\)\s*(?:[—–-]{1,2}|:|,)?\s*|[A-Z][A-Z.'’-]{2,}(?: [A-Z][A-Z.'’-]{2,}){0,2},\s+[A-Z][a-z]{1,5}\.?\s+[—–-]{1,2}\s+)/;
  const SUM_BYLINE = /^(?:[Bb]y|[Ff]rom)\s+\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*){0,3}(?:,?\s+(?:CNN|Reuters|AP|AFP|BBC|NPR|Bloomberg|[A-Z]{2,6}))?\s+(?=\p{Lu})/u;
  const SUM_CONNECTIVE = /^(?:but|and|or|so|yet|also|however|meanwhile|still|instead|moreover|furthermore|additionally|in addition|similarly|likewise|then|thus|therefore|indeed|nonetheless|nevertheless|besides)\b,?\s+/i;
  const SUM_PRONOUN = /^(?:he|she|it|they|this|these|those|that|his|her|its|their|there|such|both|another)\b/i;
  const SUM_NUM = /[$€£¥₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:%|percent|per cent|million|billion|trillion|thousand|bn)?/gi;
  const SUM_NAME = /(?<=\s)\p{Lu}[\p{Ll}\p{Lu}'’.-]+(?:\s+\p{Lu}[\p{Ll}\p{Lu}'’.-]+)*/gu;
  const CELL_YES = /^(?:✓|✔|✔\uFE0F|☑|☑\uFE0F|✅|yes|y|included|available|supported|true|●|◉)$/i;
  const CELL_NO = /^(?:✗|✕|✖|✖\uFE0F|❌|×|x|no|n|not included|unavailable|unsupported|false|○)$/i;
  const CELL_NONE = /^(?:—|–|-|−|n\/a|na|none|null|tbd|tba|\?)$/i;
  // Product boxes and affiliate widgets laid out as tables ("ADD TO CART: US$25 gift card", "VIEW PRICE").
  const PROMO_TABLE = /\b(?:add to (?:cart|basket|bag)|buy (?:it )?now|shop (?:now|the)|view (?:price|deal|offer)s?|check (?:the )?price|see (?:the )?(?:price|deal)s?|get (?:the |this )?deal|order now|affiliate|sponsored|advertisement|promo code|coupon code|% off\b)/i;
  const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)[a-z]*\.?$/i;
  const summaryCache = new WeakMap();
  // Word count, or for Chinese, Japanese and Thai (no spaces) about one word per two characters.
  const sumLength = (text) => (NO_SPACE_SCRIPT.test(text) ? Math.round(String(text).replace(/\s+/g, '').length / 2) : countWords(text));

  const sumWords = (text, lang) => {
    const t = String(text || '').toLowerCase();
    const out = [];
    if (NO_SPACE_SCRIPT.test(t) && typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        for (const s of new Intl.Segmenter(lang || 'zh', { granularity: 'word' }).segment(t)) if (s.isWordLike) out.push(s.segment);
        return out.filter((w) => !SUM_STOP.has(w));
      } catch {
        /* fall through to the letter-run tokenizer */
      }
    }
    for (const m of t.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)) {
      let w = m[0].replace(/['’]s$/, '');
      if (w.length < 2 || SUM_STOP.has(w)) continue;
      // A light English stemmer: "markets" / "market", "voices" / "voice", "rated" / "rate" share a term.
      if (w.length > 5) w = w.replace(/(?:ing|ed|es|s)$/, '');
      else if (w.length > 3 && /[^s]s$/.test(w)) w = w.slice(0, -1);
      out.push(w);
    }
    return out;
  };

  // Units a column may mix and still compare: sizes (5 GB vs 1 TB) and durations (90 min vs 2 h).
  const UNIT_SCALE = { b: ['size', 1 / 1e9], kb: ['size', 1e-6], mb: ['size', 1e-3], gb: ['size', 1], tb: ['size', 1e3], pb: ['size', 1e6], ms: ['time', 0.001], s: ['time', 1], sec: ['time', 1], secs: ['time', 1], second: ['time', 1], seconds: ['time', 1], min: ['time', 60], mins: ['time', 60], minute: ['time', 60], minutes: ['time', 60], h: ['time', 3600], hr: ['time', 3600], hrs: ['time', 3600], hour: ['time', 3600], hours: ['time', 3600] };

  /** "Highest Price: Pro ($24)": a cell as { n, unit } (currency, %, k / M / B, units), or null for text. */
  const cellValue = (text) => {
    const t = String(text || '').trim();
    const m = t.match(/^([-+−]?)\s*([$€£¥₹])?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d+))?\s*(%|[kKmMbB]n?(?![A-Za-z])|bn|million|billion|thousand)?\s*([A-Za-z°/]{0,7})?$/);
    if (!m || (m[6] && m[6].length > 4 && !/^(?:hours?|hrs?|mins?|minutes?|secs?|seconds?|days?|years?|months?)$/i.test(m[6]))) return null;
    let n = Number(`${m[3].replace(/[,\s]/g, '')}.${m[4] || '0'}`);
    const mult = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, million: 1e6, billion: 1e9, thousand: 1e3 }[String(m[5] || '').toLowerCase()];
    if (mult && m[5] !== '%') n *= mult;
    let unit = `${m[2] || ''}${m[5] === '%' ? '%' : ''}${String(m[6] || '').toLowerCase()}`;
    const scale = UNIT_SCALE[String(m[6] || '').toLowerCase()];
    if (scale) {
      n *= scale[1];
      unit = scale[0];
    }
    return Number.isFinite(n) ? { n: m[1] === '-' || m[1] === '−' ? -n : n, unit } : null;
  };
  const cellNumber = (text) => {
    const v = cellValue(text);
    return v ? v.n : null;
  };

  const Summary = {
    V: SUMMARY_V,

    /* --------------------------------------- pass 1: the page after the Ad-Shield (stages 1 and 2) */
    /** Every meaningful table and definition list on the page, photo captions, and the pricing grid the
     *  Site Briefing scan found — including those Readability leaves out (spec sidebars, infoboxes). */
    scan(doc, { pricing = null } = {}) {
      const body = doc && doc.body;
      if (!body) return null;
      const heads = Array.from(body.querySelectorAll('h1, h2, h3, h4')).filter((h) => !h.closest(SUM_SKIP));
      const before = (el) => {
        let best = null;
        for (const h of heads) {
          if (h.compareDocumentPosition(el) & 4) best = h; // 4 = Node.DOCUMENT_POSITION_FOLLOWING
          else break;
        }
        return best ? Briefing.clean(briefText(best)) : '';
      };
      const tables = [];
      for (const table of body.querySelectorAll('table')) {
        if (tables.length >= 16) break; // the saved copy of a page stays small
        if (table.querySelector('table') || table.closest(SUM_SKIP)) continue;
        const t = this.gridFromTable(table);
        if (!t) continue;
        t.heading = before(table);
        if (!t.title) t.title = t.heading;
        tables.push(t);
      }
      const dls = [];
      for (const dl of body.querySelectorAll('dl')) {
        if (dls.length >= 12) break;
        if (dl.closest(SUM_SKIP) || dl.closest('table') || dl.parentElement.closest('dl')) continue;
        const pairs = this.pairsFromDl(dl);
        if (pairs.length < 2) continue;
        const heading = before(dl);
        dls.push({ kind: 'dl', title: heading, heading, pairs, sig: norm(pairs.slice(0, 3).flat().join(' ')).slice(0, 120) });
      }
      const captions = [];
      for (const el of body.querySelectorAll(SUM_CAPTION)) {
        if (captions.length >= 60) break;
        const text = briefText(el);
        if (text.length < 16 || text.length > 360 || (el.tagName !== 'FIGCAPTION' && el.querySelector('p, li, h1, h2, h3, table'))) continue;
        captions.push(norm(text).slice(0, 220));
      }
      // Many sites repeat a photo's caption as its alt text.
      for (const img of body.querySelectorAll('img[alt]')) {
        if (captions.length >= 90) break;
        const alt = (img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
        if (alt.length >= 30 && alt.length <= 360 && countWords(alt) >= 6) captions.push(norm(alt).slice(0, 220));
      }
      const plans = pricing && Array.isArray(pricing.plans) ? pricing.plans.filter((p) => p && p.name && p.price).slice(0, 8) : [];
      return { v: SUMMARY_V, tables, dls, captions, pricing: plans.length >= 2 ? { summary: pricing.summary || '', plans: plans.map((p) => ({ name: p.name, price: p.price })) } : null };
    },

    /** A <table> as a grid of cells (rowspan / colspan resolved), or null when it is layout or navigation. */
    gridFromTable(table) {
      if (table.getAttribute('role') === 'presentation' || table.getAttribute('role') === 'none') return null;
      const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table).slice(0, 80);
      if (trs.length < 2) return null;
      const rows = [];
      const spans = [];
      let headRows = 0;
      trs.forEach((tr, r) => {
        const out = [];
        let col = 0;
        const fill = () => {
          while (spans[col] && spans[col].left > 0) {
            out[col] = spans[col].cell;
            spans[col].left--;
            col++;
          }
        };
        fill();
        for (const td of tr.children) {
          if (!/^T[DH]$/.test(td.tagName)) continue;
          fill();
          const cell = { text: trimText(Clean.citations(Clean.display(td.textContent || '')), 120), th: td.tagName === 'TH', scope: (td.getAttribute('scope') || '').toLowerCase() };
          const cs = clamp(Number(td.getAttribute('colspan')) || 1, 1, 8);
          const rs = clamp(Number(td.getAttribute('rowspan')) || 1, 1, 40);
          for (let k = 0; k < cs && col < 12; k++) {
            out[col] = cell;
            if (rs > 1) spans[col] = { left: rs - 1, cell };
            col++;
          }
        }
        fill();
        const group = tr.parentElement && tr.parentElement.tagName;
        if (group === 'THEAD') headRows = r + 1;
        rows.push(out);
      });
      const text = briefText(table);
      if (PROMO_TABLE.test(text)) return null;
      let links = 0;
      for (const a of table.querySelectorAll('a')) links += briefText(a).length;
      if (text.length < 12 || (text.length && links / text.length > 0.7 && !table.querySelector('th'))) return null;
      const cap = table.querySelector('caption');
      const title = Briefing.clean((cap && briefText(cap)) || table.getAttribute('aria-label') || table.getAttribute('summary') || '');
      const grid = this.analyse(rows, { headRows, title: title.length <= 140 ? title : trimText(title, 140), infobox: /\binfobox\b/.test(table.className || '') });
      return grid;
    },

    /** A block table (cells only, as the full read keeps it) as a grid. */
    gridFromBlock(block) {
      const rows = (block.cells || []).map((r, i) => r.map((text) => ({ text: text || '', th: Boolean(block.head && i === 0), scope: '' })));
      return this.analyse(rows, { headRows: block.head ? 1 : 0, title: block.caption || '' });
    },

    /**
     * Header row, row labels, key–value shape and size of a grid; null for layout, calendars and grids with
     * fewer than two data rows or columns. Rows are { text, th } cells.
     */
    analyse(input, { headRows = 0, title = '', infobox = false } = {}) {
      const width = Math.min(12, Math.max(0, ...input.map((r) => r.length)));
      if (width < 2) return null;
      const rows = input.map((r) => Array.from({ length: width }, (_, j) => r[j] || { text: '', th: false, scope: '' })).filter((r) => r.some((c) => c.text));
      if (rows.length < 2) return null;
      const cells = rows.flat().filter((c) => c.text);
      const avg = cells.reduce((n, c) => n + c.text.length, 0) / Math.max(1, cells.length);
      if (avg > 160) return null;
      const isNum = (c) => cellNumber(c.text) !== null;
      // Header: the last <thead> row, a row of <th>, or a text row above numeric columns.
      let head = headRows > 0 ? Math.min(headRows, rows.length) - 1 : -1;
      if (head < 0 && rows[0].every((c) => c.th || !c.text)) head = 0;
      if (head < 0 && rows.length >= 3 && rows[0].every((c) => c.text && !isNum(c))) {
        const numericCols = Array.from({ length: width }, (_, j) => rows.slice(1).filter((r) => isNum(r[j])).length / (rows.length - 1)).filter((x) => x >= 0.6).length;
        if (numericCols >= 1) head = 0;
      }
      let headers = head >= 0 ? rows[head].map((c) => c.text) : [];
      let body = rows.slice(head + 1).filter((r) => !(r.every((c) => c.th) && new Set(r.map((c) => c.text)).size === 1) && r.map((c) => c.text).join('|') !== headers.join('|'));
      // A two-column list of labels and values (spec sheets, infoboxes): spoken as "Label: value".
      const labelled = body.filter((r) => r[0].th || r[0].scope === 'row').length / Math.max(1, body.length);
      const kv =
        width === 2 &&
        head < 0 &&
        body.length >= 2 &&
        (labelled >= 0.5 || infobox || (body.every((r) => r[0].text && r[0].text.length <= 48) && body.filter((r) => r[1].text.length > r[0].text.length).length >= body.length * 0.5));
      if (infobox && !kv) {
        // An infobox mixes full-width title rows with label / value rows: keep the pairs.
        const pairs = rows.filter((r) => r[0].text && r[1] && r[1].text && r[0] !== r[1]).map((r) => [r[0].text, r[1].text]);
        if (pairs.length >= 2) return { kind: 'kv', title: title || (rows[0][0].text.length <= 80 ? rows[0][0].text : ''), pairs: pairs.slice(0, 24), total: pairs.length, sig: norm(pairs.slice(0, 3).flat().join(' ')).slice(0, 120) };
      }
      if (kv) {
        const pairs = body.filter((r) => r[0].text && r[1].text).map((r) => [r[0].text, r[1].text]);
        if (pairs.length < 2) return null;
        return { kind: 'kv', title, pairs: pairs.slice(0, 24), total: pairs.length, sig: norm(pairs.slice(0, 3).flat().join(' ')).slice(0, 120) };
      }
      if (body.length < 2 && !(body.length === 1 && headers.length >= 2)) return null;
      if (headers.length && headers.filter((h) => WEEKDAY.test(h)).length >= 5) return null; // a calendar widget
      // Columns that are empty in every data row go; so does a header that repeats the caption.
      const keep = Array.from({ length: width }, (_, j) => j).filter((j) => body.some((r) => r[j].text) || (headers[j] && j === 0));
      headers = headers.length ? keep.map((j) => headers[j]) : [];
      body = body.map((r) => keep.map((j) => r[j]));
      const cols = keep.length;
      if (cols < 2) return null;
      // Row labels: <th scope="row">, or a first column of distinct words beside data.
      const firstText = body.filter((r) => r[0].text && !isNum(r[0]));
      const distinct = new Set(body.map((r) => norm(r[0].text))).size;
      const rowHead = body.filter((r) => r[0].th).length >= body.length * 0.6 || (firstText.length >= body.length * 0.8 && distinct >= body.length * 0.8);
      return {
        kind: 'table',
        title,
        headers,
        rows: body.slice(0, 40).map((r) => r.map((c) => c.text)),
        total: body.length,
        cols,
        rowHead,
        sig: norm(rows.slice(0, 3).map((r) => r.map((c) => c.text).join(' ')).join(' ')).slice(0, 120),
      };
    },

    /** <dt> / <dd> pairs (several <dd> for one term are joined); <div> wrappers are allowed. */
    pairsFromDl(dl) {
      const pairs = [];
      let term = '';
      const visit = (el) => {
        for (const child of el.children) {
          const tag = child.tagName;
          if (tag === 'DIV') visit(child);
          else if (tag === 'DT') term = trimText(Briefing.clean(briefText(child)), 80);
          else if (tag === 'DD' && term) {
            const value = trimText(Briefing.clean(briefText(child)), 200);
            if (!value) continue;
            const last = pairs[pairs.length - 1];
            if (last && last[0] === term) last[1] = `${last[1]}, ${value}`;
            else pairs.push([term, value]);
          }
        }
      };
      visit(dl);
      return pairs.slice(0, 24);
    },

    /** Every word in a grid's cells: the same table seen by Readability and in the raw page shares most of them. */
    gridWords(g) {
      const cells = g.kind === 'kv' ? g.pairs.flat() : [...(g.headers || []), ...(g.rows || []).slice(0, 20).flat()];
      return new Set(cells.flatMap((c) => sumWords(c, 'en')));
    },

    sameGrid(a, b) {
      const x = this.gridWords(a);
      const y = this.gridWords(b);
      if (!x.size || !y.size) return false;
      let shared = 0;
      for (const w of x) if (y.has(w)) shared++;
      return shared / (x.size + y.size - shared) >= 0.6;
    },

    /* ------------------------------------------------------------- spoken prose for structured data */
    cell(text) {
      const t = String(text || '').trim();
      if (CELL_YES.test(t)) return 'yes';
      if (CELL_NO.test(t)) return 'no';
      if (CELL_NONE.test(t)) return 'none';
      return trimText(t.replace(/\s*\n\s*/g, ', '), 60);
    },

    /** "Table Summary for Plans: Compares 3 items across Price, Storage and Seats. Key highlights: …" */
    tableProse(t, { brief = false } = {}) {
      if (t.kind === 'kv') return this.pairsProse(t.title, brief ? t.pairs.slice(0, 4) : t.pairs, t.total);
      const title = t.title || '';
      const lead = title ? `Table Summary for ${title}` : 'Table Summary';
      const label = t.rowHead || (t.headers.length && t.headers[0] !== undefined && t.rows.every((r) => r[0] && cellNumber(r[0]) === null)) ? 0 : -1;
      const valueCols = Array.from({ length: t.cols }, (_, j) => j).filter((j) => j !== label);
      const named = valueCols.map((j) => t.headers[j]).filter(Boolean);
      const n = t.total;
      const parts = [];
      const cols = named.length > 6 ? `${named.slice(0, 6).join(', ')} and ${plural(named.length - 6, 'more column')}` : listJoin(named);
      if (named.length) parts.push(`${lead}: Compares ${plural(n, 'item')} across ${cols}.`);
      else parts.push(`${lead}: ${plural(n, 'row')} of ${plural(t.cols, 'column')}.`);
      const shown = brief ? t.rows.slice(0, 2) : n <= 4 ? t.rows.slice(0, 4) : t.rows.slice(0, 3);
      const rowText = (r, i) => {
        // No label column ("Year | System"): the first cell names the row ("Year 1961 has System: IBM 704").
        const head = label === 0 ? this.cell(r[0]) : t.headers[0] && r[0] ? `${t.headers[0]} ${this.cell(r[0])}` : '';
        const values = valueCols
          .filter((j) => r[j] && !(label < 0 && head && j === 0))
          .slice(0, 4)
          .map((j) => (t.headers[j] ? `${t.headers[j]}: ${this.cell(r[j])}` : this.cell(r[j])));
        if (!values.length) return '';
        return head ? `${head} has ${values.join(', ')}` : `row ${i + 1} has ${values.join(', ')}`;
      };
      const rows = shown.map(rowText).filter(Boolean);
      if (rows.length) parts.push(`Key highlights: ${rows.join('; ')}.`);
      // The extremes of up to two numeric columns, when there are enough rows to compare.
      if (n >= 3 && label === 0) {
        const insights = [];
        for (const j of valueCols) {
          if (insights.length >= (brief ? 1 : 2) || !t.headers[j]) continue;
          const parsed = t.rows.map((r, i) => ({ i, c: cellValue(r[j]) })).filter((x) => x.c);
          // Only numbers that mean the same thing: one currency, one unit family (5 GB and 1 TB compare; $ and € do not).
          if (new Set(parsed.map((x) => x.c.unit)).size > 1) continue;
          const vals = parsed.map((x) => ({ i: x.i, v: x.c.n }));
          if (vals.length < Math.max(3, t.rows.length * 0.6)) continue;
          const hi = vals.reduce((a, b) => (b.v > a.v ? b : a));
          const lo = vals.reduce((a, b) => (b.v < a.v ? b : a));
          if (hi.v === lo.v) continue;
          insights.push(`highest ${t.headers[j]}: ${this.cell(t.rows[hi.i][0])} (${this.cell(t.rows[hi.i][j])}), lowest: ${this.cell(t.rows[lo.i][0])} (${this.cell(t.rows[lo.i][j])})`);
        }
        if (insights.length) parts.push(`${insights.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('. ')}.`);
      }
      if (n > shown.length) parts.push(`Plus ${plural(n - shown.length, 'more row')} on screen.`);
      return parts.join(' ');
    },

    /** "Key details for Specifications: Weight: 1.2 kg; Battery: up to 18 hours; and 4 more." */
    /** One plain sentence for a summary: "In the Benchmarks table, Vertex Pro has the highest Score (9,120) and Quill 13 the lowest (6,300)." */
    tableGist(t) {
      if (!t || t.kind === 'kv') return t ? this.pairsProse(t.title, t.pairs.slice(0, 3), t.total) : '';
      const label = t.rowHead || (t.headers.length && t.rows.every((r) => r[0] && cellNumber(r[0]) === null)) ? 0 : -1;
      const where = t.title ? `In the ${t.title.replace(/[\s:.]+$/, '')} table` : 'In the table';
      if (label === 0 && t.rows.length >= 3) {
        for (let j = 1; j < t.cols; j++) {
          if (!t.headers[j]) continue;
          const parsed = t.rows.map((r, i) => ({ i, c: cellValue(r[j]) })).filter((x) => x.c);
          if (new Set(parsed.map((x) => x.c.unit)).size > 1 || parsed.length < Math.max(3, t.rows.length * 0.6)) continue;
          const hi = parsed.reduce((a, b) => (b.c.n > a.c.n ? b : a));
          const lo = parsed.reduce((a, b) => (b.c.n < a.c.n ? b : a));
          if (hi.c.n === lo.c.n) continue;
          const name = (i) => this.cell(t.rows[i][0]);
          return `${where}, ${name(hi.i)} has the highest ${t.headers[j]} (${this.cell(t.rows[hi.i][j])}) and ${name(lo.i)} the lowest (${this.cell(t.rows[lo.i][j])}).`;
        }
      }
      // Rows with words in them ("Starter: Transaction fee 5% + 50¢"): the first value of the first rows.
      if (label === 0 && t.headers[1] && t.rows.length >= 2) {
        const rows = t.rows.slice(0, 3).filter((r) => r[0] && r[1]).map((r) => `${this.cell(r[0])}, ${t.headers[1]} ${this.cell(r[1])}`);
        if (rows.length >= 2) return `${where}: ${rows.join('; ')}${t.total > rows.length ? `; and ${plural(t.total - rows.length, 'more row')}` : ''}.`;
      }
      const names = label === 0 ? t.rows.slice(0, 3).map((r) => this.cell(r[0])).filter(Boolean) : [];
      return names.length >= 2 ? `${where}: ${listJoin(names)}${t.total > names.length ? `, and ${plural(t.total - names.length, 'more row')}` : ''}.` : this.tableProse(t, { brief: true });
    },

    pairsProse(title, pairs, total = pairs.length) {
      const shown = pairs.slice(0, 6).map(([k, v]) => `${k.replace(/[:\s]+$/, '')}: ${this.cell(v)}`);
      const head = title && !/^(?:details|specs|specifications)$/i.test(title) ? `Key details for ${title}` : 'Key details';
      return `${head}: ${shown.join('; ')}${total > shown.length ? `; and ${total - shown.length} more` : ''}.`;
    },

    /** A key list: "In 3 steps: first, …; then …; and finally …." or "Key points: …; …; and 4 more." */
    listProse(items, { ordered = false, lead = '' } = {}) {
      const max = items.every((x) => countWords(x) <= 6) ? 8 : 5;
      const shown = items.slice(0, max).map((x) => trimText(x.replace(/[.;,:]+$/, ''), 110));
      const more = items.length - shown.length;
      let body;
      if (ordered && !lead) {
        const steps = shown.map((x, i) => (i === 0 ? `first, ${x}` : i === shown.length - 1 && !more ? `and finally, ${x}` : `then ${x}`));
        body = `In ${plural(items.length, 'step')}: ${steps.join('; ')}${more ? `; and ${plural(more, 'more step')}` : ''}.`;
      } else {
        const opener = lead ? lead.replace(/[\s:–—-]+$/, '') : 'Highlights';
        body = `${opener}: ${shown.join('; ')}${more ? `; and ${more} more` : ''}.`;
      }
      return body;
    },

    /* --------------------------------------------------------- the narrative: sentences of each section */
    /** "WASHINGTON (CNN) —", "By Ada Lovelace CNN", leading "But" / "However,": cut so a sentence stands alone. */
    tidy(sentence, { connective = true, lead = true } = {}) {
      let s = String(sentence || '').trim();
      if (lead) for (let i = 0; i < 2; i++) s = s.replace(SUM_BYLINE, '').replace(SUM_DATELINE, '').trim();
      if (connective) {
        const cut = s.replace(SUM_CONNECTIVE, '');
        if (cut !== s && cut.length > 20) s = cut.charAt(0).toUpperCase() + cut.slice(1);
      }
      return s;
    },

    /** Why a sentence can never be part of a summary (caption, call to action, reader call-out, boilerplate). */
    junk(s, captions, { item = false } = {}) {
      const t = s.trim();
      if (!t || (!item && (sumLength(t) < 5 || /[:：]$/.test(t)))) return true;
      if (SITE_BOILERPLATE.test(t)) return true;
      if (BOILERPLATE_LINE.test(t) || BOILERPLATE_PREFIX.test(t) || AFFILIATE.test(t) || NEWSLETTER.test(t) || CAPTION_LEAD.test(t) || READER_PROMPT.test(t) || isCtaLine(t)) return true;
      if (CTA_INLINE.test(t) && countWords(t) <= 14) return true;
      if (/https?:\/\/|www\.\S|\S+@\S+\.\w/.test(t)) return true;
      if (!item) {
        const words = t.match(/[\p{L}\p{N}]+/gu) || [];
        if (!NO_SPACE_SCRIPT.test(t) && words.filter((w) => w.length >= 3).length < words.length * 0.5) return true;
        if ((t.match(/["“'‘][^\s"“”'‘’]{1,2}["”'’]/g) || []).length >= 3) return true; // a legend: "_" Waiting, "S" Starting…
        if (((t.match(/"/g) || []).length % 2 === 1) || (t.match(/“/g) || []).length !== (t.match(/”/g) || []).length) return true; // half a quote
      }
      const n = norm(t);
      if (n.length >= 18 && captions.some((c) => c.includes(n) || (c.length >= 18 && n.includes(c)))) return true;
      return false;
    },

    /**
     * The page as sections of units in document order. Each unit is a sentence, a key list, a table, a
     * definition list or the pricing grid. A page without h2 / h3 headings is split into its beginning,
     * middle and end so the summary reaches the last paragraph too.
     */
    sections(raw, structure) {
      const blocks = raw.blocks || [];
      const lang = raw.lang || 'en';
      const title = norm(raw.title);
      const captions = (structure && structure.captions) || [];
      const dlText = new Set(((structure && structure.dls) || []).flatMap((d) => d.pairs.flat()).map(norm));
      const out = [{ heading: '', level: 1, units: [], chars: 0 }];
      let sec = out[0];
      let para = 0;
      for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        if (block.t === 'h') {
          const text = Briefing.clean(block.text);
          if (!text || norm(text) === title) continue;
          if (block.level <= 3 && !JUNK_SECTION.test(text)) {
            sec = { heading: text, level: Math.max(2, block.level), units: [], chars: 0 };
            out.push(sec);
          }
          continue;
        }
        if (block.t === 'code' || block.tags || block.fine) continue;
        if (block.t === 'table') {
          if (PROMO_TABLE.test((block.cells || []).flat().join(' '))) continue; // a product box laid out as a table
          let g = this.gridFromBlock(block);
          // The raw page's copy of the same table knows its <th> cells, spans, caption and heading: prefer it.
          const twin = structure && (structure.tables || []).find((t) => !t.used && (g ? this.sameGrid(t, g) : false));
          if (twin) {
            twin.used = true;
            g = twin;
          }
          if (g) {
            if (!g.title && sec.heading) g = { ...g, title: sec.heading };
            sec.units.push({ kind: g.kind, grid: g, b });
          }
          continue;
        }
        if (block.t === 'li') {
          // Consecutive items form one list; a sentence just before it ending in ":" is its lead.
          const items = [];
          const start = b;
          let j = b;
          while (j < blocks.length && blocks[j].t === 'li') {
            const t = Briefing.clean(blocks[j].text).replace(/^(?:new|update|updated|breaking|live|exclusive|watch|video|photos?)\s*:\s*/i, '');
            if (t && !dlText.has(norm(t)) && !this.junk(t, captions, { item: true })) items.push(t);
            j++;
          }
          const ordered = Boolean(block.ordered);
          b = j - 1;
          if (!items.length) continue;
          const long = items.reduce((n, x) => n + countWords(x), 0) / items.length >= 16;
          if (items.length >= 3 && !long) {
            const prev = sec.units[sec.units.length - 1];
            const lead = prev && prev.kind === 'sent' && prev.colon && prev.b === start - 1 ? prev.raw : '';
            if (lead) prev.dropped = true;
            sec.units.push({ kind: 'list', items, ordered, lead, b, chars: items.join(' ').length });
            sec.chars += items.join(' ').length;
            continue;
          }
          for (const t of items) this.addSentences(sec, t, { b, para: ++para, lang, captions, list: true });
          continue;
        }
        const text = Briefing.clean(block.text);
        if (!text || dlText.has(norm(text))) continue;
        // A card's line ("Best Match, site-vocal.com, $0.00/yr") is a label, not a sentence a summary quotes.
        if (block.card) continue;
        this.addSentences(sec, text, { b, para: ++para, lang, captions, quote: block.t === 'quote' });
      }
      // Tables and definition lists that only the raw page has (sidebars, spec boxes, infoboxes).
      if (structure) {
        const placed = out.flatMap((s) => s.units.filter((u) => u.grid).map((u) => u.grid));
        const extra = [...(structure.tables || []), ...(structure.dls || [])].filter((g) => !g.used && !placed.some((p) => p === g || this.sameGrid(p, g.kind === 'dl' ? { kind: 'kv', pairs: g.pairs } : g)));
        for (const g of extra) {
          const home = out.find((s) => s.heading && g.heading && norm(s.heading) === norm(g.heading)) || null;
          const unit = { kind: g.kind === 'dl' ? 'kv' : g.kind, grid: g.kind === 'dl' ? { kind: 'kv', title: g.title, pairs: g.pairs, total: g.pairs.length, sig: g.sig } : g, b: Infinity };
          if (home) home.units.push(unit);
          else {
            let tail = out.find((s) => s.extra);
            if (!tail) {
              tail = { heading: 'Data on this page', level: 2, units: [], chars: 0, extra: true };
              out.push(tail);
            }
            tail.units.push(unit);
          }
        }
        if (structure.pricing && !out.some((s) => s.units.some((u) => u.grid && /price|pric|plan|\$|€|£/i.test(`${u.grid.title} ${(u.grid.headers || []).join(' ')}`)))) {
          const home = out.find((s) => s.heading && /pric|plan/i.test(s.heading)) || out[out.length - 1];
          home.units.push({ kind: 'price', plans: structure.pricing.plans, summary: structure.pricing.summary, b: Infinity });
        }
      }
      const filled = out.filter((s) => s.units.some((u) => !u.dropped));
      // No h2 / h3 at all: the beginning, middle and end of the page become their own parts.
      if (filled.length === 1 && !filled[0].heading) {
        const all = filled[0].units;
        const paras = [...new Set(all.map((u) => u.para).filter(Boolean))];
        const parts = clamp(Math.round(paras.length / 5), 1, 5);
        if (parts > 1) {
          const total = all.reduce((n, u) => n + (u.chars || 0), 0);
          const pieces = Array.from({ length: parts }, () => ({ heading: '', level: 2, units: [], chars: 0, part: true }));
          let acc = 0;
          for (const u of all) {
            const k = Math.min(parts - 1, Math.floor((acc / Math.max(1, total)) * parts));
            pieces[k].units.push(u);
            pieces[k].chars += u.chars || 0;
            acc += u.chars || 0;
          }
          return pieces.filter((p) => p.units.length);
        }
      }
      return filled;
    },

    addSentences(sec, text, { b, para, lang, captions, quote = false, list = false }) {
      let first = true;
      const ranges = [];
      for (const [s, e] of Clean.sentences(text, lang)) {
        const last = ranges[ranges.length - 1];
        // "John F." | "Kennedy airport", "(d. | 1003 AD)": an initial, an abbreviation or an open bracket does not end a sentence.
        const prev = last ? text.slice(last[0], last[1]) : '';
        const next = text.slice(s, e);
        const open = (prev.match(/\(/g) || []).length > (prev.match(/\)/g) || []).length;
        if (last && (open || /^\s*\p{Ll}/u.test(next) || /(?:\b\p{Lu}|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Gen|Gov|Sen|Rep|Lt|Col|Capt|No|vs|Inc|Ltd|Co|Corp|Ave|Mt|Ft|U\.S|U\.K|[bcdr]|ca|fl|approx|e\.g|i\.e|cf|al))\.["'”’)]*\s*$/u.test(prev))) last[1] = e;
        else ranges.push([s, e]);
      }
      for (const [s, e] of ranges) {
        const raw = text.slice(s, e).trim();
        if (!raw) continue;
        const colon = /[:：]$/.test(raw);
        const tidied = this.tidy(raw, { connective: false, lead: first });
        const unit = { kind: 'sent', raw, text: tidied, b, para, lead: first, colon, quote, list, chars: tidied.length };
        first = false;
        sec.chars += tidied.length;
        if (colon) {
          unit.junk = true;
          sec.units.push(unit);
          continue;
        }
        unit.junk = this.junk(tidied, captions) || (/\?$/.test(tidied) && !quote);
        sec.units.push(unit);
      }
    },

    /** TF-IDF vectors, TextRank over sentence similarity, and each sentence's closeness to its section. */
    score(sections, raw) {
      const lang = raw.lang || 'en';
      const sents = [];
      sections.forEach((sec, k) => sec.units.forEach((u) => {
        if (u.kind === 'sent' && !u.junk && !u.dropped) {
          u.sec = k;
          sents.push(u);
        }
      }));
      if (!sents.length) return sents;
      const docs = sents.map((u) => sumWords(u.text, lang));
      const df = new Map();
      for (const words of docs) for (const w of new Set(words)) df.set(w, (df.get(w) || 0) + 1);
      const N = sents.length;
      const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;
      const vecs = docs.map((words) => {
        const tf = new Map();
        for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
        const v = new Map();
        let len = 0;
        for (const [w, c] of tf) {
          const x = (1 + Math.log(c)) * idf(w);
          v.set(w, x);
          len += x * x;
        }
        len = Math.sqrt(len) || 1;
        for (const [w, x] of v) v.set(w, x / len);
        return v;
      });
      // TextRank: PageRank over cosine similarity, edges found through an inverted index (very common terms skipped).
      const rank = new Float64Array(N).fill(1 / N);
      if (N > 2 && N <= 2500) {
        const index = new Map();
        vecs.forEach((v, i) => {
          for (const w of v.keys()) {
            let list = index.get(w);
            if (!list) index.set(w, (list = []));
            list.push(i);
          }
        });
        const edges = Array.from({ length: N }, () => new Map());
        const cap = Math.max(40, Math.round(N * 0.35));
        for (const [w, list] of index) {
          if (list.length < 2 || list.length > cap) continue;
          for (let a = 0; a < list.length; a++) {
            const i = list[a];
            const wi = vecs[i].get(w);
            for (let c = a + 1; c < list.length; c++) {
              const j = list[c];
              const x = wi * vecs[j].get(w);
              edges[i].set(j, (edges[i].get(j) || 0) + x);
              edges[j].set(i, (edges[j].get(i) || 0) + x);
            }
          }
        }
        const out = edges.map((m) => {
          let s = 0;
          for (const x of m.values()) s += x;
          return s;
        });
        let r = rank;
        for (let it = 0; it < 30; it++) {
          const next = new Float64Array(N).fill(0.15 / N);
          let dangling = 0;
          for (let j = 0; j < N; j++) {
            if (!out[j]) {
              dangling += r[j];
              continue;
            }
            const share = (0.85 * r[j]) / out[j];
            for (const [i, x] of edges[j]) next[i] += share * x;
          }
          if (dangling) for (let i = 0; i < N; i++) next[i] += (0.85 * dangling) / N;
          r = next;
        }
        rank.set(r);
      }
      const maxRank = Math.max(...rank) || 1;
      // Section centroids: what each section is about.
      const centroids = sections.map(() => new Map());
      sents.forEach((u, i) => {
        const c = centroids[u.sec];
        for (const [w, x] of vecs[i]) c.set(w, (c.get(w) || 0) + x);
      });
      const cos = (v, c) => {
        let dot = 0;
        let len = 0;
        for (const x of c.values()) len += x * x;
        for (const [w, x] of v) dot += x * (c.get(w) || 0);
        return len ? dot / Math.sqrt(len) : 0;
      };
      const keys = new Set(sumWords(`${raw.title || ''} ${raw.excerpt || ''}`, lang));
      sents.forEach((u, i) => {
        const v = vecs[i];
        const words = sumLength(u.text);
        const heads = new Set(sumWords(sections[u.sec].heading, lang));
        let kw = 0;
        for (const w of v.keys()) if (keys.has(w) || heads.has(w)) kw++;
        const nums = (u.text.match(SUM_NUM) || []).length;
        const names = NO_SPACE_SCRIPT.test(u.text) ? 0 : (` ${u.text}`.match(SUM_NAME) || []).length;
        let s = 0.38 * (rank[i] / maxRank) + 0.22 * cos(v, centroids[u.sec]) + 0.12 * Math.min(1, kw / Math.sqrt(Math.max(1, v.size))) + 0.1 * Math.min(1, (nums + 0.5 * names) / 3);
        if (u.lead) s += sections[u.sec].units.find((x) => x.kind === 'sent' && !x.junk) === u ? 0.15 : 0.06;
        if (words < 7) s -= 0.25;
        else if (words < 9) s -= 0.12;
        if (/(?:^|\s)[#@]\w/.test(u.text)) s -= 0.2;
        // A line that never ends like a sentence ("Server Built: Sep 18 2017", "2018年6月18日 10:01 発信地") is page metadata.
        if (!/[.!?。！？…"”'’)\]]\s*$/.test(u.text)) s -= /\d/.test(u.text) ? 0.3 : 0.12;
        if (words > 48) s -= words > 70 ? 0.25 : 0.1;
        if (SUM_PRONOUN.test(u.text) || SUM_CONNECTIVE.test(u.text)) s -= 0.1;
        if (u.quote) s -= 0.05;
        if (u.list) s += 0.03;
        u.score = s;
        u.vec = v;
        u.words = new Set(v.keys());
      });
      return sents;
    },

    /** Near-duplicates: the same claim twice (description and first paragraph, or a repeated line). */
    similar(a, b) {
      if (!a.words || !b.words || !a.words.size || !b.words.size) return norm(a.text) === norm(b.text);
      let shared = 0;
      for (const w of a.words) if (b.words.has(w)) shared++;
      return shared / Math.min(a.words.size, b.words.size) >= 0.6 || shared / (a.words.size + b.words.size - shared) >= 0.45;
    },

    /** How long the summary may be: a few key points, more for a long page, never a walk through every section. */
    budget(sections, cps = DEFAULT_CPS) {
      const chars = sections.reduce((n, s) => n + s.chars, 0);
      const full = chars / cps;
      const words = chars / 6;
      const points = words < 250 ? 2 : words < 700 ? 3 : words < 1600 ? 4 : 5;
      return { fullSeconds: full, seconds: Math.min(60, Math.max(15, points * 9 + 8)), points };
    },

    /** Share of a sentence's words that are code, versions, acronyms or numbers ("Next.js 15 three.js NASA GIBS"). */
    jargon(text) {
      const words = String(text || '').match(/[^\s,;:()]+/g) || [];
      if (words.length < 4) return 0;
      const tech = words.filter((w) => /\d/.test(w) || /[a-z][A-Z]|[A-Z]{2,}|\w\.\w|[/_#+@]|^[A-Z]\w*-[A-Z]/.test(w.replace(/[.,!?]+$/, ''))).length;
      return tech / words.length;
    },

    /** "TravelGraph-AI — Graph-RAG travel intelligence" → "TravelGraph-AI": who or what a section is about. */
    subject(heading) {
      const m = String(heading || '').replace(/^[^\p{L}\p{N}]+/u, '').match(/^(.{2,40}?)\s+[—–-]\s+\S/u);
      return m && countWords(m[1]) <= 4 ? m[1] : '';
    },

    /** The summary: what the page is (one line), its few strongest points in page order, and at most one table's gist. */
    plan(raw, { cps = DEFAULT_CPS, ai = raw.summaryAi } = {}) {
      const stamp = `${cps}|${ai ? ai.at || 1 : 0}|${(raw.blocks || []).length}`;
      const hit = summaryCache.get(raw);
      if (hit && hit.stamp === stamp) return hit.plan;
      const structure = raw.structure && raw.structure.v === SUMMARY_V ? raw.structure : null;
      const sections = this.sections(raw, structure);
      const sents = this.score(sections, raw);
      const { fullSeconds, seconds, points: want } = this.budget(sections, cps);
      const site = raw.siteName || siteLabel(raw.hostname);
      // AI points: one list for the whole page (older saved summaries kept them per section).
      const aiPoints = ai ? (Array.isArray(ai.points) ? ai.points : Object.values(ai.sections || {}).flat()).filter(Boolean) : [];
      const useAi = aiPoints.length > 0;
      // 1 · the overview: the page's own description, else its strongest opening sentence.
      const desc = this.tidy(Briefing.clean(raw.excerpt || ''), { connective: false });
      const captions = (structure && structure.captions) || [];
      let overview = null;
      if (useAi && ai.overview) overview = { text: ai.overview, from: 'ai' };
      else if (desc && sumLength(desc) >= 7 && !this.junk(desc, captions) && norm(desc) !== norm(raw.title)) overview = { text: this.opening(desc, raw.lang) || desc, from: 'description' };
      else {
        const lead = sents.filter((u) => (u.sec === 0 || u.sec === 1) && this.jargon(u.text) <= 0.3 && !/^\p{Ll}/u.test(u.text)).sort((a, b) => b.score - a.score)[0] || sents[0];
        if (lead) {
          overview = { text: this.tidy(lead.text), from: 'lead' };
          lead.used = true;
        }
      }
      const overUnits = overview ? Clean.sentences(overview.text, raw.lang || 'en').map(([s, e]) => overview.text.slice(s, e)).map((t) => ({ text: t, words: new Set(sumWords(t, raw.lang)) })) : [];
      // 2 · the strongest points across the whole page: plain sentences, each saying something new.
      const picked = [];
      if (!useAi) {
        // Never a line about the page's layout ("every number below…", "scroll down", "see above").
        const LAYOUT = /\b(?:below|above|scroll (?:down|up)|on the (?:left|right))\b/i;
        // The page's title as a sentence ("Anthropic's Model Hardware Standard: AI Agents Take…") is not a point:
        // a line made mostly of the title's own words.
        const titleWords = new Set(sumWords(raw.title || '', raw.lang));
        const isTitle = (u) => {
          const w = u.words ? [...u.words] : [];
          return Boolean(raw.title) && (norm(u.text).includes(norm(raw.title)) || (w.length > 0 && w.filter((x) => titleWords.has(x)).length / w.length >= 0.75));
        };
        const pool = sents.filter((u) => !u.used && !isTitle(u) && !/^\p{Ll}/u.test(u.text) && sumLength(u.text) >= 7 && sumLength(u.text) <= 55 && this.jargon(u.text) <= 0.3 && !LAYOUT.test(u.text) && !overUnits.some((o) => this.similar(o, u)));
        const perSec = new Map();
        for (let k = 0; k < want; k++) {
          let top = null;
          let best = -Infinity;
          for (const u of pool) {
            if (u.used || picked.some((p) => this.similar(p, u))) continue;
            // How a page opens says most about it: earlier sentences weigh a little more.
            const v = u.score + 0.16 * (1 - sents.indexOf(u) / sents.length) - 0.18 * (perSec.get(u.sec) || 0);
            if (v > best) {
              best = v;
              top = u;
            }
          }
          if (!top || (picked.length >= 2 && best < 0.12)) break;
          top.used = true;
          picked.push(top);
          perSec.set(top.sec, (perSec.get(top.sec) || 0) + 1);
        }
        picked.sort((a, b) => a.b - b.b || sents.indexOf(a) - sents.indexOf(b));
      }
      const pointItems = useAi
        ? aiPoints.slice(0, Math.max(3, want)).map((p) => ({ kind: 'sent', text: p, role: 'ai', b: -1 }))
        : picked.map((u) => {
            let text = this.tidy(u.text, { lead: false });
            // A project's line under its "Name — tagline" heading says whose it is: "SprintMind AI: Four agents …".
            const name = u.lead ? this.subject(sections[u.sec].heading) : '';
            if (name && !norm(text).includes(norm(name))) text = `${name}: ${text}`;
            return { kind: 'sent', text, role: 'sent', b: u.b };
          });
      // 3 · numbers worth hearing: the pricing grid, else the page's main data table, as one line.
      const data = [];
      const units = sections.flatMap((sec) => sec.units);
      const price = units.find((u) => u.kind === 'price');
      const priced = (g) => /\b(?:pric|plan|fee|cost|tier)/i.test(`${g.title || ''} ${(g.headers || []).join(' ')}`);
      const grids = units.filter((u) => u.kind === 'table' && u.grid && u.grid.rows && (priced(u.grid) || u.grid.rows.some((r) => r.some((c) => cellNumber(c) !== null))));
      let tables = 0;
      if (price) data.push({ kind: 'price', text: `Pricing: ${price.plans.map((p) => (/^free$/i.test(p.price) ? `${p.name}, free` : `${p.name} at ${p.price}`)).join('; ')}.`, plans: price.plans, b: price.b });
      else if (grids.length) {
        // A pricing table first, else the biggest table of numbers.
        const g = grids.slice().sort((a, b) => Number(priced(b.grid)) - Number(priced(a.grid)) || (b.grid.total || 0) * (b.grid.cols || 1) - (a.grid.total || 0) * (a.grid.cols || 1))[0];
        data.push({ kind: 'table', text: this.tableGist(g.grid), grid: g.grid, b: g.b });
        tables = 1;
      }
      // A page that is mostly a list (search results, a top-ten) and has little prose: its first items.
      let lists = 0;
      if (!useAi && picked.length < 2) {
        const list = units.filter((u) => u.kind === 'list').sort((a, b) => b.items.length - a.items.length)[0];
        if (list) {
          const shown = list.items.slice(0, 3).map((x) => trimText(x.replace(/[.;,:]+$/, ''), 90));
          const more = list.items.length - shown.length;
          pointItems.push({ kind: 'list', text: `${list.lead ? list.lead.replace(/[\s:–—-]+$/, '') : 'It lists'}: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`, items: list.items.slice(0, 8), ordered: list.ordered, total: list.items.length, b: list.b });
          lists = 1;
        }
      }
      const cards = [];
      if (overview) cards.push({ key: 'overview', label: 'In short', items: [{ kind: 'sent', text: overview.text, role: 'overview' }] });
      if (pointItems.length) cards.push({ key: 'points', label: 'Key points', items: pointItems });
      if (data.length) cards.push({ key: 'data', label: 'In numbers', items: data });
      const plan = {
        v: SUMMARY_V,
        engine: useAi ? ai.engine || 'chrome-ai' : 'textrank',
        model: useAi ? ai.model || '' : '',
        title: raw.title || '',
        site,
        domain: bareHost(raw.hostname || ''),
        overview,
        cards,
        stats: { sections: sections.filter((s) => s.heading).length, parts: sections.length, points: pointItems.length, tables, lists, sentences: picked.length, candidates: sents.length, fullSeconds, targetSeconds: seconds, covered: new Set(picked.map((u) => u.sec)).size },
      };
      summaryCache.set(raw, { stamp, plan });
      return plan;
    },

    /** A page title without a trailing site name or domain ("… -- Sott.net", "… | The Daily Star"). */
    bareTitle(title, site = '') {
      let t = String(title || '').trim();
      t = t.replace(/\s+(?:[|·•–—-]{1,2}|::)\s+[\p{L}\p{N}.-]+\.(?:com|net|org|io|co|news|uk|de|fr|in|au|ca)\s*$/iu, '');
      if (site) {
        const esc = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`\\s+(?:[|·•–—-]{1,2}|::)\\s+${esc}\\s*$`, 'i'), '');
      }
      return t || String(title || '').trim();
    },

    /** The first whole sentences of a description, up to ~320 characters (one sentence is never cut short). */
    opening(text, lang = 'en') {
      const out = [];
      for (const [s, e] of Clean.sentences(text, lang)) {
        const sentence = text.slice(s, e).trim();
        if (!sentence || isCtaLine(sentence) || READER_PROMPT.test(sentence)) continue;
        if (out.length && (out.length >= 2 || out.join(' ').length + sentence.length > 320 || /(?:…|\.\.\.)$/.test(sentence))) break;
        out.push(sentence);
      }
      const joined = out.join(' ');
      return joined.length > 420 ? trimText(joined, 420) : joined;
    },

    /** The page as plain text for a model to clean and summarize: after the Ad-Shield, captions, tag rows and repeats
     *  already gone; headings as "## …", list items as "- …", a table's first rows; cut at max characters. */
    modelInput(raw, max = 12000) {
      const lines = [`Page title: ${raw.title || ''}`, `Website: ${raw.siteName || raw.hostname || ''}`];
      if (raw.excerpt) lines.push(`Page description: ${raw.excerpt}`);
      lines.push('', 'Page text:');
      let used = lines.join('\n').length;
      for (const b of raw.blocks || []) {
        if (b.t === 'code' || b.tags || b.fine) continue;
        let line = '';
        if (b.t === 'h') line = `\n## ${b.text}`;
        else if (b.t === 'li') line = `- ${b.text}`;
        else if (b.t === 'table') line = (b.cells || []).slice(0, 8).map((r) => r.filter(Boolean).join(' | ')).join('\n');
        else line = b.text || '';
        if (!line.trim()) continue;
        if (used + line.length + 1 > max) {
          lines.push(line.slice(0, Math.max(0, max - used - 1)));
          break;
        }
        lines.push(line);
        used += line.length + 1;
      }
      return lines.join('\n');
    },

    /** The narrative text of each section, for an on-device or cloud summarizer (tables stay with SiteVocal). */
    aiInput(raw, { max = 3600 } = {}) {
      const structure = raw.structure && raw.structure.v === SUMMARY_V ? raw.structure : null;
      const sections = this.sections(raw, structure);
      return sections
        .map((sec, k) => {
          const lines = [];
          for (const u of sec.units) {
            if (u.kind === 'sent' && !u.junk && !u.dropped) lines.push(u.text);
            else if (u.kind === 'list') lines.push(...u.items.map((x) => `- ${x}`));
          }
          const text = lines.join(' ').replace(/ - /g, '\n- ');
          return { key: `${k}:${norm(sec.heading).slice(0, 24)}`, heading: sec.heading, text: text.length > max ? text.slice(0, max) : text };
        })
        .filter((s) => s.text.length >= 120);
    },

    /** Bullet points from a summarizer ("* one\n* two" or prose) as clean spoken sentences. */
    points(text) {
      return String(text || '')
        .split(/\n+|(?:^|\s)[•*]\s+/)
        .map((l) => Briefing.clean(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '')))
        .filter((l) => countWords(l) >= 3)
        .map((l) => (/[.!?…]$/.test(l) ? l : `${l}.`))
        .slice(0, 6);
    },
  };
  /* --------------------------------------------------------- site adapters
   * Official CORS-enabled APIs (GitHub, Wikipedia, Hacker News): these work even when every public
   * proxy is down. Anything else goes through Fetcher's race + Readability.  */
  const Adapters = [
    {
      // GitHub repositories, files, issues and pull requests: GitHub's REST API, no proxy (see GitHub below).
      id: 'github',
      test: (u) => Boolean(GitHub.parse(u)),
      load: (u, ctx) => GitHub.load(GitHub.parse(u), u, ctx),
    },
    {
      id: 'wikipedia',
      test: (u) =>
        /(^|\.)wikipedia\.org$/i.test(u.hostname) &&
        /^\/wiki\/[^/]+/.test(u.pathname) &&
        !/^\/wiki\/(Special|File|Talk|User|Wikipedia|Help|Template|Category|Portal|Draft|Module|MediaWiki)(_talk)?:/i.test(u.pathname),
      async load(u, { signal, status }) {
        const sub = u.hostname.toLowerCase().split('.')[0];
        const site = /^(www|m)$/.test(sub) ? 'en' : sub;
        const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
        const hostname = `${site}.wikipedia.org`;
        const api = `https://${hostname}/w/api.php?format=json&formatversion=2&origin=*&redirects=1`;
        status('Fetching from the Wikipedia API (CORS-enabled, no proxy needed)…');
        const [parsed, info] = await Promise.all([
          Fetcher.json(`${api}&action=parse&prop=text%7Cdisplaytitle&disableeditsection=1&disabletoc=1&page=${encodeURIComponent(title)}`, { signal }),
          Fetcher.json(`${api}&action=query&prop=pageimages%7Cdescription%7Cinfo&inprop=url&piprop=original%7Cthumbnail&pithumbsize=1280&titles=${encodeURIComponent(title)}`, { signal }).catch(() => null),
        ]);
        if (!parsed || parsed.error || !parsed.parse || typeof parsed.parse.text !== 'string') throw new Error((parsed && parsed.error && parsed.error.info) || 'Wikipedia article not found');
        const page = (info && info.query && info.query.pages && info.query.pages[0]) || {};
        status('Cleaning citations and reference sections…');
        const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body><main>${parsed.parse.text}</main></body></html>`, 'text/html');
        let structure = null;
        const shield = Extractor.preClean(doc, (shielded) => {
          try {
            structure = Summary.scan(shielded);
          } catch (err) {
            console.warn('[SiteVocal] Summary scan failed; the article is still read in full.', err);
          }
        });
        const articleTitle = parsed.parse.title || title;
        const description = typeof page.description === 'string' ? page.description : '';
        return {
          url: safeHttpUrl(page.fullurl) || `https://${hostname}/wiki/${encodeURIComponent(articleTitle.replace(/ /g, '_'))}`,
          hostname,
          siteName: 'Wikipedia',
          title: articleTitle,
          author: 'Wikipedia contributors',
          excerpt: description ? description.charAt(0).toUpperCase() + description.slice(1) : '',
          lang: normLang(site) || 'en',
          heroImage: safeImageUrl((page.original && page.original.source) || (page.thumbnail && page.thumbnail.source) || ''),
          logos: [`https://${hostname}/static/apple-touch/wikipedia.png`, `https://${hostname}/static/favicon/wikipedia.ico`, s2Favicon(hostname)].filter(Boolean),
          themeColor: '',
          tileColor: '',
          knownColor: '#3366cc',
          brandColors: [],
          blocks: Extractor.filter(Extractor.blocks(doc.querySelector('main')), articleTitle),
          via: 'Wikipedia API',
          extractor: 'SiteVocal parser',
          source: 'url',
          kind: 'article',
          shield: { ...shield, hidden: 0 },
          ...(structure ? { structure } : {}),
        };
      },
    },
    {
      id: 'hackernews',
      test: (u) =>
        u.hostname === 'news.ycombinator.com' &&
        (/^\/(news|best|newest|ask|show|front)?$/.test(u.pathname) || (u.pathname === '/item' && /^\d+$/.test(u.searchParams.get('id') || ''))),
      async load(u, { signal, status }) {
        const api = 'https://hacker-news.firebaseio.com/v0';
        const item = (id) => Fetcher.json(`${api}/item/${id}.json`, { signal, timeout: 9000 }).catch(() => null);
        const base = {
          hostname: 'news.ycombinator.com',
          siteName: 'Hacker News',
          lang: 'en',
          heroImage: '',
          logos: ['https://news.ycombinator.com/y18.svg', 'https://news.ycombinator.com/favicon.ico', s2Favicon('news.ycombinator.com')].filter(Boolean),
          themeColor: '',
          tileColor: '',
          knownColor: '#ff6600',
          brandColors: [],
          via: 'Hacker News API',
          extractor: 'SiteVocal parser',
          source: 'url',
          shield: { ads: 0, clutter: 0, hidden: 0 },
        };
        const host = (url) => bareHost(hostOf(url));
        if (u.pathname === '/item') {
          status('Fetching the discussion from the Hacker News API…');
          const story = await item(u.searchParams.get('id'));
          if (!story || story.deleted || story.dead) throw new Error('Hacker News item not found');
          const domain = story.url ? host(story.url) : '';
          const blocks = [];
          if (story.title) {
            blocks.push({ t: 'p', text: `${story.title}${domain ? `, from ${domain}` : ''}. ${plural(story.score || 0, 'point')} and ${plural(story.descendants || 0, 'comment')}, posted by ${story.by} ${agoSpoken(story.time)}.` });
          }
          if (story.text) blocks.push(...Extractor.htmlToBlocks(story.text));
          const kids = (await Promise.all((story.kids || []).slice(0, 12).map(item))).filter((c) => c && !c.deleted && !c.dead && c.text).slice(0, 10);
          if (kids.length) blocks.push({ t: 'h', level: 2, text: 'Top comments' });
          for (const c of kids) {
            const parts = Extractor.htmlToBlocks(c.text);
            if (!parts.length) continue;
            if (parts[0].t === 'p') parts[0] = { ...parts[0], text: `${c.by} writes: ${parts[0].text}` };
            blocks.push(...parts);
          }
          return {
            ...base,
            url: `https://news.ycombinator.com/item?id=${story.id}`,
            title: story.title || `Comment by ${story.by}`,
            author: story.by || '',
            excerpt: domain ? `Hacker News discussion of ${domain}` : 'Hacker News discussion',
            blocks,
            kind: 'article',
          };
        }
        const feeds = { '/': 'topstories', '/news': 'topstories', '/front': 'topstories', '/best': 'beststories', '/newest': 'newstories', '/ask': 'askstories', '/show': 'showstories' };
        const names = { topstories: 'Top Stories', beststories: 'Best Stories', newstories: 'New Stories', askstories: 'Ask HN', showstories: 'Show HN' };
        const feed = feeds[u.pathname] || 'topstories';
        status(`Fetching ${names[feed]} from the Hacker News API…`);
        const ids = await Fetcher.json(`${api}/${feed}.json`, { signal });
        const stories = (await Promise.all((Array.isArray(ids) ? ids : []).slice(0, 15).map(item))).filter((s) => s && s.title && !s.deleted && !s.dead);
        if (!stories.length) throw new Error('Hacker News returned no stories');
        return {
          ...base,
          url: `https://news.ycombinator.com${u.pathname}`,
          title: names[feed],
          author: '',
          excerpt: `The ${stories.length} highest-ranked stories on Hacker News right now, read as a news bulletin.`,
          blocks: stories.map((s, i) => {
            const domain = s.url ? host(s.url) : '';
            return { t: 'p', text: `Story ${i + 1}: ${s.title}${domain ? `, from ${domain}` : ''}. ${plural(s.score || 0, 'point')} and ${plural(s.descendants || 0, 'comment')}, posted by ${s.by} ${agoSpoken(s.time)}.` };
          }),
          kind: 'broadcast',
        };
      },
    },
    {
      // Quick Try → Company Homepage: SiteVocal's own product homepage, heard as a Site Briefing. Live when the
      // network allows; otherwise (offline, file://, the extension sandbox) a built-in snapshot of this very page:
      // its JSON-LD, hero, features and FAQ. The demo always works.
      id: 'sitevocal-home',
      test: (u) => u.hostname === 'hotragn.github.io' && /^\/sitevocal\/?(?:index\.html)?$/i.test(u.pathname),
      async load(u, { signal, status }) {
        let html = '';
        let via = 'built-in snapshot';
        if (navigator.onLine !== false) {
          status('Fetching the SiteVocal homepage…');
          try {
            if (Host.mode === 'extension') {
              const r = await Host.request('fetch', { url: u.href, as: 'text' }, 9000);
              if (looksLikeHtml(r.text)) {
                html = r.text;
                via = 'SiteVocal extension';
              }
            } else {
              const res = await fetchWithTimeout(u.href, { timeout: 6000, signal, credentials: 'omit' });
              const text = res.ok ? await res.text() : '';
              if (looksLikeHtml(text)) {
                html = text;
                via = 'direct fetch';
              }
            }
          } catch {
            if (signal && signal.aborted) throw abortError();
          }
        }
        if (!html) {
          status('Using the built-in snapshot of the SiteVocal homepage…');
          html = selfSnapshot();
        }
        const raw = await Extractor.fromHtml(html, u.href, { via, source: 'url' });
        raw.knownColor = '#7A1C24';
        return raw;
      },
    },
  ];

  /** The Company Homepage demo's offline snapshot: SiteVocal's own homepage, taken from this page itself. */
  function selfSnapshot() {
    const keep = 'title, meta[name="description"], meta[property^="og:"], meta[name="application-name"], meta[name="theme-color"], link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="canonical"], script[type="application/ld+json"]';
    const head = Array.from(document.head.querySelectorAll(keep)).map((n) => n.outerHTML).join('\n');
    const landing = document.getElementById('landing');
    const main = landing ? landing.cloneNode(true) : document.createElement('main');
    main.querySelectorAll('#recentWrap, #tabCard, canvas, form, script, style, [data-demo]').forEach((n) => n.remove());
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}</head><body><main>${main.innerHTML}</main></body></html>`;
  }

  /* ------------------------------------------------------------- GitHub adapter
   * Repositories, files, issues and pull requests through GitHub's CORS-enabled REST API: no proxy, two requests
   * in parallel. The anonymous API allows 60 requests an hour per network; past that, README and files come from
   * raw.githubusercontent.com (not counted), rendered by SiteVocal's own Markdown reader, and issues, pull
   * requests and discussions from the page itself (GitHub's HTML or r.jina.ai's rendering of it). Each becomes a
   * small HTML page (identity, JSON-LD, then the README or the thread) read by the same pipeline as any site, so
   * Site Briefing, Summarize Page and Full Page Read all work on it. */
  const GH_RESERVED = new Set(['about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories', 'dashboard', 'discussions', 'enterprise', 'events', 'explore', 'features', 'github-copilot', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'partners', 'premium-support', 'pricing', 'pulls', 'readme', 'resources', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'solutions', 'sponsors', 'stars', 'team', 'topics', 'trending', 'users', 'watching']);
  const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
  const GH_MARKDOWN = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
  const GH_TEXT = /(?:\.(?:txt|text|rst|adoc|asciidoc|org)|^(?:readme|license|licence|copying|authors|notice|changelog|contributing)[^/]*)$/i;
  const GH_LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'PowerShell', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', lua: 'Lua', r: 'R', dart: 'Dart', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', hs: 'Haskell', vue: 'Vue', svelte: 'Svelte', dockerfile: 'Dockerfile' };
  const ghEnc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  // GitHub's HTML carries a thread in this markup; a page built with JavaScript (React) arrives without it.
  const GH_THREAD = /class="[^"]*\b(?:comment-body|js-comment-body|markdown-body)\b/;
  const GH_SIDEBAR = /^(?:assignees|labels|projects|milestones?|development|participants|notifications|type|relationships|reviewers|linked (?:issues|pull requests)|metadata|issue actions|category)$/i;
  const GH_CHROME = /^(?:sign in|sign up|toggle navigation|reload to refresh your session\.?|you (?:must be signed in|signed (?:in|out) with another tab|switched accounts)\b.*|you can[’']t perform that action at this time\.?|sign up for free to join this conversation on github\b.*|already have an account\?.*|copy link|jump to bottom|new issue)$/i;
  const GH_STATE = /^(open|closed|merged|draft|answered|unanswered)$/i;

  const GitHub = {
    /** github.com/{owner}/{repo}[/tree/{ref}|/blob/{ref}/{path}|/issues/{n}|/pull/{n}] and raw.githubusercontent.com. */
    parse(u) {
      const host = u.hostname.toLowerCase();
      let seg;
      try {
        seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return null;
      }
      if (host === 'raw.githubusercontent.com') {
        if (seg[2] === 'refs' && seg[3] === 'heads') seg.splice(2, 2);
        if (seg.length < 4 || !GH_OWNER.test(seg[0]) || !GH_REPO.test(seg[1])) return null;
        return { kind: 'file', owner: seg[0], repo: seg[1], ref: seg[2], path: seg.slice(3).join('/') };
      }
      if (host !== 'github.com' && host !== 'www.github.com') return null;
      if (seg.length < 2 || GH_RESERVED.has(seg[0].toLowerCase())) return null;
      const owner = seg[0];
      const repo = seg[1].replace(/\.git$/i, '');
      if (!GH_OWNER.test(owner) || !GH_REPO.test(repo)) return null;
      if (seg.length === 2) return { kind: 'repo', owner, repo };
      const [what, ...rest] = seg.slice(2);
      if (what === 'tree' && rest.length === 1) return { kind: 'repo', owner, repo, ref: rest[0] };
      if (what === 'blob' && rest.length >= 2) return { kind: 'file', owner, repo, ref: rest[0], path: rest.slice(1).join('/') };
      if ((what === 'issues' || what === 'pull') && /^\d{1,9}$/.test(rest[0] || '')) return { kind: 'issue', owner, repo, number: Number(rest[0]), pull: what === 'pull' };
      if (what === 'discussions' && /^\d{1,9}$/.test(rest[0] || '')) return { kind: 'discussion', owner, repo, number: Number(rest[0]) };
      return null;
    },

    async load(p, u, ctx) {
      if (p.kind === 'repo') return this.repo(p, u, ctx);
      if (p.kind === 'file') return this.file(p, ctx);
      if (p.kind === 'discussion') return this.viaPage(p, u, ctx); // the REST API does not serve discussions
      return this.issue(p, u, ctx);
    },

    /** One api.github.com GET. The Accept header is a simple header: no CORS preflight, one round trip. */
    async api(path, { signal, html = false, timeout = 8000 } = {}) {
      const res = await fetchWithTimeout(`https://api.github.com${path}`, { timeout, signal, credentials: 'omit', headers: { Accept: html ? 'application/vnd.github.html+json' : 'application/vnd.github+json' } });
      if (!res.ok) {
        const err = new Error(res.status === 403 || res.status === 429 ? 'GitHub API limit reached (60 requests an hour without signing in)' : `GitHub API: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res;
    },

    async raw(p, path, { signal, timeout = 8000, ref = p.ref || 'HEAD' } = {}) {
      const res = await fetchWithTimeout(`https://raw.githubusercontent.com/${ghEnc(p.owner)}/${ghEnc(p.repo)}/${ghEnc(ref)}/${ghEnc(path)}`, { timeout, signal, credentials: 'omit' });
      if (!res.ok) {
        const err = new Error(`GitHub file: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res;
    },

    avatar(owner) {
      return `https://github.com/${encodeURIComponent(owner)}.png?size=256`;
    },

    async repo(p, u, { signal, status }) {
      status('Fetching the repository from the GitHub API (CORS-enabled, no proxy needed)…');
      const base = `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
      const [infoRes, readmeRes] = await Promise.allSettled([this.api(base, { signal }).then((r) => r.json()), this.api(`${base}/readme${p.ref ? `?ref=${encodeURIComponent(p.ref)}` : ''}`, { signal, html: true }).then((r) => r.text())]);
      if (signal && signal.aborted) throw abortError();
      const info = infoRes.status === 'fulfilled' && infoRes.value && typeof infoRes.value === 'object' ? infoRes.value : null;
      let readme = readmeRes.status === 'fulfilled' ? this.tidyHtml(this.readmeHtml(readmeRes.value)) : '';
      let via = 'GitHub API';
      const noReadme = readmeRes.status === 'rejected' && readmeRes.reason && readmeRes.reason.status === 404 && info;
      if (!readme && !noReadme) {
        // The API's anonymous limit (or an outage): the README straight from raw.githubusercontent.com, on the
        // default branch (HEAD), then on main and master.
        status('Reading the README from raw.githubusercontent.com…');
        const refs = p.ref ? [p.ref] : ['HEAD', 'main', 'master'];
        let gone = false;
        for (const name of ['README.md', 'readme.md', 'README.markdown', 'README.rst', 'README']) {
          for (const ref of refs) {
            try {
              const md = await (await this.raw(p, name, { signal, ref })).text();
              readme = /\.rst$|^README$/.test(name) ? Markdown.paragraphs(md) : this.tidyHtml(Markdown.toHtml(md));
              via = 'GitHub (raw README)';
              break;
            } catch (err) {
              if (signal && signal.aborted) throw abortError();
              if (err.status !== 404) gone = true;
              if (gone) break;
            }
          }
          if (readme || gone) break;
        }
      }
      if (!info && !readme) {
        // No API and no README file: the repository page itself, like any site.
        const limited = infoRes.reason && (infoRes.reason.status === 403 || infoRes.reason.status === 429 || !infoRes.reason.status);
        if (limited) return this.viaPage(p, u, { signal, status });
        throw (infoRes.reason && infoRes.reason.message ? infoRes.reason : new Error('GitHub repository not found'));
      }
      const owner = (info && info.owner && info.owner.login) || p.owner;
      const name = (info && info.name) || p.repo;
      const full = (info && info.full_name) || `${owner}/${name}`;
      const description = (info && typeof info.description === 'string' && info.description.trim()) || '';
      const license = info && info.license && info.license.spdx_id && info.license.spdx_id !== 'NOASSERTION' ? info.license : null;
      const topics = info && Array.isArray(info.topics) ? info.topics.filter((t) => typeof t === 'string').slice(0, 12) : [];
      const homepage = info ? safeHttpUrl(info.homepage) : '';
      const html_url = (info && safeHttpUrl(info.html_url)) || `https://github.com/${p.owner}/${p.repo}`;
      const avatar = (info && info.owner && safeImageUrl(info.owner.avatar_url)) || this.avatar(owner);
      const facts = [];
      if (info) {
        const lang = info.language ? `${/^[AEIOU]/i.test(info.language) ? 'an' : 'a'} ${info.language} project` : 'a project';
        const count = (n, word) => `${Number(n || 0).toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
        facts.push(`${full} is ${lang} on GitHub with ${count(info.stargazers_count, 'star')} and ${count(info.forks_count, 'fork')}${license ? `, licensed under the ${license.name || license.spdx_id}` : ''}.`);
        if (topics.length) facts.push(`Topics: ${topics.map((t) => t.replace(/-/g, ' ')).join(', ')}.`);
        if (homepage && bareHost(hostOf(homepage)) !== 'github.com') facts.push(`Website: ${bareHost(hostOf(homepage))}.`);
        if (info.archived) facts.push('The repository is archived and read-only.');
      }
      const ld = {
        '@context': 'https://schema.org',
        '@type': license ? ['SoftwareSourceCode', 'SoftwareApplication'] : 'SoftwareApplication',
        name,
        description: description || undefined,
        url: homepage || html_url,
        applicationCategory: 'DeveloperApplication',
        author: { '@type': info && info.owner && info.owner.type === 'User' ? 'Person' : 'Organization', name: owner },
        ...(license ? { codeRepository: html_url, license: license.spdx_id } : {}),
        ...(info && info.language ? { programmingLanguage: info.language } : {}),
        ...(topics.length ? { keywords: topics.join(', ') } : {}),
      };
      const body = `${description ? `<p>${esc(description)}</p>` : ''}${facts.length ? `<p>${esc(facts.join(' '))}</p>` : ''}${readme}`;
      const html = this.page({ title: full, description, canonical: html_url, image: `https://opengraph.githubassets.com/1/${ghEnc(owner)}/${ghEnc(name)}`, logo: avatar, ld, body });
      const raw = await Extractor.fromHtml(html, html_url, { via, source: 'url', clean: true, pageType: 'repository' });
      if (raw.briefing) raw.briefing.name = full;
      return this.finish(raw, { title: full, excerpt: description, author: '', avatar, kind: 'article' });
    },

    /** The README endpoint's HTML; or, should the API answer with JSON, its base64 Markdown rendered here. */
    readmeHtml(text) {
      const t = String(text || '');
      if (!/^\s*\{/.test(t)) return t;
      try {
        const j = JSON.parse(t);
        if (j && typeof j.content === 'string' && j.encoding === 'base64') {
          const bytes = Uint8Array.from(window.atob(j.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
          return Markdown.toHtml(new window.TextDecoder().decode(bytes));
        }
      } catch {
        /* not the JSON shape we know */
      }
      return '';
    },

    async file(p, { signal, status }) {
      status('Fetching the file from raw.githubusercontent.com (CORS-enabled, no proxy needed)…');
      const res = await this.raw(p, p.path, { signal, timeout: 10000 });
      const type = res.headers.get('content-type') || '';
      if (/^(?:image|audio|video|font)\/|application\/(?:octet-stream|zip|pdf)/i.test(type)) throw new Error('That GitHub file is not text');
      const text = (await res.text()).slice(0, 600000);
      if (/\u0000/.test(text.slice(0, 4000))) throw new Error('That GitHub file is not text');
      const name = p.path.split('/').pop() || p.path;
      const repo = `${p.owner}/${p.repo}`;
      const canonical = `https://github.com/${ghEnc(p.owner)}/${ghEnc(p.repo)}/blob/${ghEnc(p.ref)}/${ghEnc(p.path)}`;
      let body;
      if (GH_MARKDOWN.test(name)) body = this.tidyHtml(Markdown.toHtml(text));
      else if (GH_TEXT.test(name) || !/\.[a-z0-9]+$/i.test(name)) body = Markdown.paragraphs(text);
      else {
        const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
        const lines = text.split('\n').length;
        body = `<p>${esc(`${name} is a ${plural(lines, 'line')} ${GH_LANG[ext] || ext.toUpperCase()} file in ${repo}. The code is shown below; turn Skip Code off to hear it line by line.`)}</p><pre><code>${esc(text)}</code></pre>`;
      }
      const avatar = this.avatar(p.owner);
      const html = this.page({ title: `${name} · ${repo}`, description: `${p.path} in ${repo}`, canonical, logo: avatar, body });
      const raw = await Extractor.fromHtml(html, canonical, { via: 'GitHub (raw file)', source: 'url', clean: true });
      return this.finish(raw, { title: `${name} · ${repo}`, excerpt: `${p.path} in ${repo}`, author: '', avatar, kind: 'article' });
    },

    async issue(p, u, { signal, status }) {
      const noun = p.pull ? 'pull request' : 'issue';
      status(`Fetching the ${noun} from the GitHub API (CORS-enabled, no proxy needed)…`);
      const base = `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/issues/${p.number}`;
      const [issueRes, commentsRes] = await Promise.allSettled([this.api(base, { signal, html: true }).then((r) => r.json()), this.api(`${base}/comments?per_page=30`, { signal, html: true }).then((r) => r.json())]);
      if (signal && signal.aborted) throw abortError();
      if (issueRes.status !== 'fulfilled' || !issueRes.value || typeof issueRes.value !== 'object') {
        // Past the API's limit (or an outage), the page itself still has the thread. A 404 is a real "not found".
        if (issueRes.status === 'rejected' && issueRes.reason && issueRes.reason.status !== 404) return this.viaPage(p, u, { signal, status });
        throw (issueRes.reason || new Error(`GitHub ${noun} not found`));
      }
      const issue = issueRes.value;
      const comments = commentsRes.status === 'fulfilled' && Array.isArray(commentsRes.value) ? commentsRes.value.slice(0, 30) : [];
      const isPr = Boolean(issue.pull_request) || p.pull;
      const kind = isPr ? 'Pull request' : 'Issue';
      const state = isPr && issue.pull_request && issue.pull_request.merged_at ? 'merged' : issue.state === 'closed' ? 'closed' : 'open';
      const by = (issue.user && issue.user.login) || 'someone';
      const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean).slice(0, 8);
      const repo = `${p.owner}/${p.repo}`;
      const when = issue.created_at ? agoSpoken(Date.parse(issue.created_at) / 1000) : '';
      const intro = `${kind} ${p.number} in ${repo}, ${state}, opened by ${by}${when ? ` ${when}` : ''}. ${plural(issue.comments || comments.length, 'comment')}${labels.length ? `. Labels: ${labels.join(', ')}` : ''}.`;
      const thread = comments
        .filter((c) => c && c.user && c.body_html)
        .map((c) => `<section>${this.credit(c.user.login, c.body_html)}</section>`)
        .join('');
      const body = `<p>${esc(intro)}</p>${this.tidyHtml(issue.body_html || (issue.body ? Markdown.toHtml(issue.body) : ''))}${thread ? `<h2>Discussion</h2>${this.tidyHtml(thread)}` : ''}`; // ("Comments" is a junk section on news pages)
      const canonical = safeHttpUrl(issue.html_url) || `https://github.com/${p.owner}/${p.repo}/${isPr ? 'pull' : 'issues'}/${p.number}`;
      const avatar = this.avatar(p.owner);
      const title = String(issue.title || `${kind} ${p.number}`);
      const html = this.page({ title, description: `${kind} #${p.number} in ${repo} · ${state}`, canonical, logo: avatar, body });
      const raw = await Extractor.fromHtml(html, canonical, { via: 'GitHub API', source: 'url', clean: true });
      return this.finish(raw, { title, excerpt: `${kind} #${p.number} in ${repo} · ${state}`, author: by, avatar, kind: 'article' });
    },

    /**
     * The page itself, when the API cannot help: past its limit of 60 requests an hour, or for discussions (which
     * the REST API does not serve). GitHub's own HTML (through allorigins.win) and r.jina.ai's rendering of the
     * page race; the HTML wins only when it carries the thread, since GitHub builds newer pages with JavaScript.
     * Either way the menus, repository tabs, sign-in prompts and footer go, each comment is credited to its
     * author, and the title loses GitHub's "· Issue #42 · owner/repo".
     */
    async viaPage(p, u, { signal, status }) {
      const noun = { repo: 'repository', discussion: 'discussion' }[p.kind] || (p.pull ? 'pull request' : 'issue');
      const url = u.href.replace(/#.*$/, '');
      status(p.kind === 'discussion' ? `Reading the ${noun} page…` : `GitHub API limit reached — reading the ${noun} page itself…`);
      const thread = p.kind !== 'repo';
      const accept = thread ? (html) => GH_THREAD.test(html) : (html) => /class="[^"]*\bmarkdown-body\b|<article\b/i.test(html);
      const unfit = thread ? 'GitHub’s page without the thread (it builds itself with JavaScript)' : 'GitHub’s page without the README';
      const routes = [...fetchRoutes(url).filter((r) => r.name === 'allorigins.win').map((r) => ({ ...r, accept, unfit })), ...readerRoutes(url, 0)];
      const res = await Fetcher.race(url, { signal, onStatus: status, routes });
      const repo = `${p.owner}/${p.repo}`;
      const canonical = url.replace(/[?].*$/, '');
      const avatar = this.avatar(p.owner);
      const part = thread ? (res.reader ? this.readerThread(res.html, p) : this.htmlThread(res.html, p)) : null;
      if (part) {
        const html = this.page({ title: part.title, description: part.excerpt, canonical, logo: avatar, body: part.body });
        const raw = await Extractor.fromHtml(html, canonical, { via: res.via, source: 'url', clean: true });
        return this.finish(raw, { title: part.title, excerpt: part.excerpt, author: part.by, avatar, kind: 'article' });
      }
      // The repository page (or a thread page that could not be taken apart): the ordinary reader, GitHub's identity.
      const raw = await Extractor.fromHtml(res.html, res.finalUrl || url, { via: res.via, source: 'url', pageType: thread ? undefined : 'repository' });
      const title = this.cleanTitle(raw.title, p);
      if (!thread && raw.briefing) raw.briefing.name = repo;
      return this.finish(raw, { title, excerpt: raw.excerpt, author: thread ? raw.author : '', avatar, kind: 'article' });
    },

    /** "Fix it · Issue #42 · owner/repo", "Fix it by ada · Pull Request #7 · owner/repo", "GitHub - owner/repo: …" → the title. */
    cleanTitle(title, p) {
      let t = String(title || '').trim().replace(/^GitHub\s*-\s*/i, '');
      t = t.replace(/\s+·\s+(?:Issue|Pull Request|Discussion)\s+#\d+\s+·\s+[\w.-]+\/[\w.-]+\s*$/i, '').replace(/\s+·\s+[\w.-]+\/[\w.-]+\s+·\s+Discussion\s+#\d+\s*$/i, '');
      if (p.pull) t = t.replace(/\s+by\s+[\w-]+\s*$/i, '');
      if (p.kind === 'repo') t = (t.match(/^([\w.-]+\/[\w.-]+)(?::\s|$)/) || [])[1] || t;
      return t || `${p.owner}/${p.repo}`;
    },

    /** The thread's opening line, as the API path writes it: "Issue 42 in owner/repo, closed, opened by ada-l …". */
    threadIntro(p, { state = '', by = '', when = '', count = 0, labels = [] }) {
      const kind = p.kind === 'discussion' ? 'Discussion' : p.pull ? 'Pull request' : 'Issue';
      const parts = [`${kind} ${p.number} in ${p.owner}/${p.repo}`];
      if (state) parts.push(state);
      if (by) parts.push(`${p.kind === 'discussion' ? 'started' : 'opened'} by ${by}${when ? ` ${when}` : ''}`);
      return `${parts.join(', ')}.${count ? ` ${plural(count, 'comment')}.` : ''}${labels.length ? ` Labels: ${labels.join(', ')}.` : ''}`;
    },

    /**
     * r.jina.ai's rendering of an issue, pull request or discussion, as a clean thread: GitHub's menus and the
     * repository's tabs (everything above the title) and the footer go, and so does the sidebar (assignees,
     * projects, milestone…). "grace-h commented on Oct 2" becomes "grace-h writes: …" on the comment itself.
     */
    readerThread(html, p) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const main = doc.querySelector('main') || doc.body;
      const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
      const isHeading = (n) => /^H[1-6]$/.test(n.tagName);
      const h1 = main.querySelector(':scope > h1');
      if (h1) {
        for (const n of Array.from(main.children)) {
          if (n === h1) break;
          n.remove();
        }
      }
      const foot = Array.from(main.children).find((n) => isHeading(n) && /^footer\b/i.test(text(n)));
      for (let n = foot; n; ) {
        const next = n.nextElementSibling;
        n.remove();
        n = next;
      }
      const meta = { state: '', by: '', when: '', count: 0, labels: [] };
      let comments = 0;
      let first = '';
      for (const n of Array.from(main.children)) {
        if (!n.isConnected || n === h1) continue;
        const t = text(n);
        if (isHeading(n) && GH_SIDEBAR.test(t)) {
          // A sidebar block: its heading and what follows, up to the next heading. Labels are kept for the intro.
          for (let m = n.nextElementSibling; m && !isHeading(m); ) {
            const next = m.nextElementSibling;
            if (/^labels$/i.test(t)) meta.labels.push(...Array.from(m.querySelectorAll('li, a')).map(text).filter((x) => x && x.length < 40));
            m.remove();
            m = next;
          }
          n.remove();
          continue;
        }
        if (isHeading(n)) {
          const who = t.match(/^([\w-]{1,39})\s+(?:commented|replied|answered|asked|started this conversation)\b/i) || t.match(/^([\w-]{1,39})\s+on\s+[A-Z][a-z]{2,8}\.?\s+\d{1,2}\b/);
          if (who) {
            // "ada-l commented on Oct 1, 2026": credit the comment to its author, as the API path does.
            let body = n.nextElementSibling;
            while (body && !isHeading(body) && body.tagName !== 'P') body = body.nextElementSibling;
            if (body && body.tagName === 'P') body.insertAdjacentText('afterbegin', `${who[1]} writes: `);
            n.remove();
            comments++;
            first = first || who[1];
            continue;
          }
          if (/^(?:comments?|activity|\d+\s+comments?)$/i.test(t)) {
            const h = doc.createElement('h2');
            h.textContent = 'Discussion'; // ("Comments" is a junk section on news pages)
            n.replaceWith(h);
          }
          continue;
        }
        if (GH_STATE.test(t)) {
          meta.state = meta.state || t.toLowerCase();
          n.remove();
          continue;
        }
        const opened = t.match(/^([\w-]{1,39})\s+(?:opened this (?:issue|pull request)|opened|started this conversation in [^·]+?|asked this question in [^·]+?)(\s+(?:on\s+)?[^·]*?)?\s*(?:·\s*(\d+)\s+comments?)?$/i);
        if (opened && !meta.by && t.length < 160) {
          meta.by = opened[1];
          meta.when = (opened[2] || '').trim();
          meta.count = Number(opened[3] || 0);
          n.remove();
          continue;
        }
        if (GH_CHROME.test(t)) n.remove();
      }
      // Avatars, icons and rows of links (repository tabs, label chips) are never read.
      main.querySelectorAll('img, svg, nav').forEach((n) => n.remove());
      meta.by = meta.by || first;
      const title = String(h1 ? text(h1) : this.cleanTitle((doc.querySelector('title') || {}).textContent, p)).replace(/\s*#\d+\s*$/, '').trim();
      if (!title || (!comments && !meta.by && main.textContent.trim().length < 80)) return null;
      if (h1) h1.remove();
      const intro = this.threadIntro(p, meta);
      return { title, excerpt: intro, by: meta.by, body: `<p>${esc(intro)}</p>${main.innerHTML}` };
    },

    /** GitHub's own HTML for a thread (pull requests and older pages): the title, then each comment by its author. */
    htmlThread(html, p) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const text = (n) => (n ? n.textContent || '' : '').replace(/\s+/g, ' ').trim();
      const comments = Array.from(doc.querySelectorAll('.js-comment-container, .timeline-comment'))
        .map((c) => ({ by: text(c.querySelector('a.author')), html: (c.querySelector('.comment-body, .js-comment-body') || {}).innerHTML || '' }))
        .filter((c, i, all) => c.html && all.findIndex((x) => x.html === c.html) === i);
      const title = this.cleanTitle(text(doc.querySelector('.js-issue-title, bdi.markdown-title, .gh-header-title')) || text(doc.querySelector('title')), p).replace(/\s*#\d+\s*$/, '');
      if (!comments.length || !title) return null;
      const state = (text(doc.querySelector('.State, [data-testid="header-state"]')).match(/open|closed|merged|draft/i) || [''])[0].toLowerCase();
      const meta = { state, by: comments[0].by, count: comments.length - 1, labels: Array.from(doc.querySelectorAll('.js-issue-labels .IssueLabel, .sidebar-labels .IssueLabel')).map(text).filter(Boolean).slice(0, 8) };
      const [first, ...rest] = comments;
      const thread = rest.map((c) => `<section>${c.by ? this.credit(c.by, c.html) : c.html}</section>`).join('');
      const intro = this.threadIntro(p, meta);
      return { title, excerpt: intro, by: meta.by, body: `<p>${esc(intro)}</p>${this.tidyHtml(first.html)}${thread ? `<h2>Discussion</h2>${this.tidyHtml(thread)}` : ''}` };
    },

    /** A comment credited to its author: "grace-h writes: …" at the start of its first paragraph. */
    credit(login, html) {
      const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html || ''}</body></html>`, 'text/html');
      const first = doc.body.querySelector('p');
      if (first) first.insertAdjacentText('afterbegin', `${login} writes: `);
      else doc.body.insertAdjacentHTML('afterbegin', `<p>${esc(login)} writes:</p>`);
      return doc.body.innerHTML;
    },

    /**
     * GitHub's rendered Markdown without its page furniture: heading permalinks and their icons, copy buttons and
     * the table wrapper go; rows of links or badges (Website · Docs · PyPI) become a <nav>, which is never read.
     */
    tidyHtml(html) {
      if (!html) return '';
      const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
      doc.querySelectorAll('a.anchor, .zeroclipboard-container, clipboard-copy, svg.octicon').forEach((n) => n.remove());
      doc.querySelectorAll('.markdown-heading, markdown-accessiblity-table, markdown-accessibility-table').forEach((n) => n.replaceWith(...n.childNodes));
      doc.querySelectorAll('p').forEach((p) => {
        if (p.closest('nav') || !p.querySelector('a') || !Markdown.linksOnly(p.innerHTML)) return;
        const nav = doc.createElement('nav');
        p.replaceWith(nav);
        nav.appendChild(p);
      });
      return doc.body.innerHTML;
    },

    page({ title, description = '', canonical, image = '', logo = '', ld = null, body }) {
      const json = ld ? JSON.stringify(ld).replace(/</g, '\\u003c') : '';
      return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}<meta property="og:site_name" content="GitHub"><meta property="og:type" content="object">${image ? `<meta property="og:image" content="${esc(image)}">` : ''}${logo ? `<link rel="apple-touch-icon" href="${esc(logo)}">` : ''}<link rel="canonical" href="${esc(canonical)}">${json ? `<script type="application/ld+json">${json}</script>` : ''}</head><body><main><article>${body}</article></main></body></html>`;
    },

    /** The identity GitHub pages share: the title as GitHub shows it, the owner's avatar as the logo. */
    finish(raw, { title, excerpt, author, avatar, kind }) {
      raw.siteName = 'GitHub';
      raw.title = title;
      if (excerpt) raw.excerpt = trimText(excerpt, 220);
      raw.author = author;
      raw.logos = [avatar, ...(raw.logos || []).filter((l) => l !== avatar)].slice(0, 4);
      raw.knownColor = raw.knownColor || '#1f2328';
      raw.kind = kind;
      return raw;
    },
  };
  /* ------------------------------------------- smart broadcast synthesiser
   * Deterministic, no LLM: raw blocks → an ordered broadcast script with a
   * spoken intro, section announcements, quote markers, code/tables skipped
   * or read (sanitizer pills) and a sign-off. Every segment is split into
   * ≤10 s chunks and remembers its source block (b) so a rebuild with other
   * filters lands on the same paragraph.                                   */
  const HEADING_PHRASES = ['Next section: ', 'Moving on to: ', 'Now, '];

  const Synth = {
    opts: { lexicon: true },

    build(raw, { rate = 1, cps = DEFAULT_CPS, filters = FILTERS } = {}) {
      const f = { ...FILTERS, ...(filters || {}) };
      this.opts = { lexicon: f.lexicon };
      const lang = raw.lang || 'en';
      const body = [];
      const blocks = raw.blocks || [];
      const shown = (text) => (f.citations ? Clean.citations(text || '') : String(text || ''));
      let para = 0;
      let sections = 0;
      let wordCount = 0;
      for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        if (block.t === 'h') {
          const text = shown(block.text);
          if (!text) continue;
          const phrase = block.level <= 2 ? HEADING_PHRASES[sections++ % HEADING_PHRASES.length] : '';
          const core = Clean.speech(text, this.opts);
          const stop = /[.!?:]$/.test(core) ? '' : '.';
          body.push(this.segment('h', text, [{ start: 0, end: text.length, speech: phrase + core + stop, cs: phrase.length, ce: phrase.length + core.length }], { level: block.level, pauseBefore: 650, pauseAfter: 420, para: para + 1, b }));
          continue;
        }
        if (block.t === 'code') {
          para++;
          const read = !f.code && this.codeSpeech(block.text || '');
          const chunks = read ? this.rawChunks(read, lang) : [];
          body.push(this.segment('code', block.text || '', chunks.length ? chunks : [this.fixed('Skipping code block, see screen for details.')], { pauseBefore: 250, pauseAfter: 300, para, b, read: Boolean(chunks.length) }));
          continue;
        }
        if (block.t === 'table') {
          para++;
          const read = !f.tables && this.tableSpeech(block);
          const chunks = read ? this.rawChunks(read, lang) : [];
          body.push(this.segment('table', '', chunks.length ? chunks : [this.fixed('Skipping a table, see screen for details.')], { rows: block.rows || 0, cells: block.cells || null, head: Boolean(block.head), caption: block.caption || '', pauseBefore: 250, pauseAfter: 300, para, b, read: Boolean(chunks.length) }));
          continue;
        }
        const text = shown(block.text);
        const chunks = this.chunksFor(text, lang);
        if (!chunks.length) continue;
        para++;
        wordCount += countWords(text);
        const kind = block.t === 'li' || block.t === 'quote' ? block.t : 'p';
        if (kind === 'quote') {
          if (!blocks[b - 1] || blocks[b - 1].t !== 'quote') this.wrap(chunks[0], 'Quote: ', '');
          if (!blocks[b + 1] || blocks[b + 1].t !== 'quote') this.wrap(chunks[chunks.length - 1], '', ' End quote.');
        }
        body.push(this.segment(kind, text, chunks, { para, b, pauseAfter: kind === 'li' ? 160 : 280, marker: kind === 'li' ? (block.ordered ? `${block.n}.` : '•') : '' }));
      }
      const bodyChars = body.reduce((n, s) => n + s.chars, 0);
      const pauseMs = body.reduce((n, s) => n + s.pauseBefore + s.pauseAfter, 0);
      const minutes = (bodyChars / (cps * rate) + pauseMs / 1000 / rate) / 60;
      const site = raw.siteName || siteLabel(raw.hostname);
      const introText = this.intro(raw, site, minutes);
      // Only a page that reads like an article is called one: a list of search results or a product grid is "this page".
      const prose = blocks.filter((x) => (x.t === 'p' || x.t === 'quote') && !x.card && countWords(x.text) >= 22).length;
      const article = Boolean(raw.author) || prose >= 3 || raw.pageType === 'repository';
      const noun = raw.kind === 'broadcast' ? 'broadcast' : raw.kind === 'text' ? 'reading' : raw.kind === 'selection' ? 'selection' : article ? 'article' : 'page';
      const outroText = raw.kind === 'text' ? 'That concludes your reading, brought to you by SiteVocal.' : `That concludes this ${noun} from ${site}, brought to you by SiteVocal.`;
      const announcer = { lexicon: true };
      const segments = [
        this.segment('intro', introText, this.chunksFor(introText, 'en', announcer), { pauseAfter: 700, announcer: true, para: 0, b: -1 }),
        ...body,
        this.segment('outro', outroText, this.chunksFor(outroText, 'en', announcer), { pauseBefore: 650, announcer: true, para: para + 1, b: blocks.length }),
      ];
      const totalChars = this.layout(segments);
      return { segments, totalChars, bodyCount: body.length, paragraphs: para, words: wordCount, minutes, lang, pauseMs, filters: f, sections: this.outline(segments), mode: 'read' };
    },

    /** Number the segments and their chunks; returns the total spoken characters. */
    layout(segments) {
      let char = 0;
      segments.forEach((s, i) => {
        s.i = i;
        s.startChar = char;
        let c = 0;
        for (const ch of s.chunks) {
          ch.startChar = c;
          c += ch.speech.length;
        }
        s.chars = c;
        char += c;
      });
      return char;
    },

    /**
     * Site Briefing: the 4-part dossier (who they are, what they provide, pricing & audience, key takeaways)
     * as a short spoken script. It has the same shape as an article script (intro, body, sign-off, ≤10 s
     * chunks), so the engine, outline, progress, resume and library work unchanged. Item titles and chips
     * are spoken as their own chunk ("Second, Billing."), so no chunk grows past the 15-second limit.
     */
    briefing(raw, { rate = 1, cps = DEFAULT_CPS, filters = FILTERS } = {}) {
      const f = { ...FILTERS, ...(filters || {}) };
      this.opts = { lexicon: f.lexicon };
      const B = Briefing.of(raw);
      const lang = raw.lang || 'en';
      const announcer = { lexicon: true };
      const shown = (text) => Clean.display(f.citations ? Clean.citations(text || '') : String(text || ''));
      const page = B.type === 'article' || B.type === 'feed' || B.type === 'text';
      const groups = { what: [], offer: [], price: [], take: [] };
      const add = (key, role, text, opts = {}) => groups[key].push({ role, text, ...opts });
      const ord = (i, n) => (n > 1 ? `${ORDINALS[i]}, ` : '');
      // 1 · who they are
      if (B.what && page) add('what', 'page', B.what.text, { title: B.what.title, lead: 'This page: ', after: B.what.author ? `, by ${B.what.author}` : '' });
      else if (B.what && B.what.text) add('what', 'what', B.what.text, { lead: 'What they are: ' });
      if (B.tagline) add('what', 'tagline', B.tagline, { lead: 'Their headline: ' });
      if (B.facts && B.facts.length) add('what', 'facts', '', { chips: B.facts.map((x) => ({ name: x.label })), speech: `${B.facts.map((x) => x.speech).join('. ')}.` });
      // 2 · what they provide
      const offers = (B.offerings || []).slice(0, 6);
      offers.forEach((o, i) => add('offer', 'offer', o.text, { title: o.title, lead: `${i === 0 ? 'What they provide and key capabilities: ' : ''}${ord(i, offers.length)}`, marker: String(i + 1).padStart(2, '0') }));
      // 3 · pricing & audience
      const P = B.pricing;
      if (P && P.summary) add('price', 'price', P.summary, { lead: 'Pricing and access: ' });
      if (P && P.plans && P.plans.length) {
        // A pricing page is all about the plans: each one also gets its one-line description.
        const detail = B.type === 'pricing' || !(B.offerings || []).length;
        const plan = (p) => {
          const head = p.price === 'Free' ? `${p.name}, free` : p.price === 'Custom pricing' ? `${p.name}, custom pricing` : `${p.name} at ${p.price}`;
          return detail && p.desc ? `${head}: ${p.desc.replace(/[.!]+$/, '')}` : head;
        };
        add('price', 'plans', '', { chips: P.plans.map((p) => ({ name: p.name, price: p.price })), speech: `${P.summary ? '' : 'Pricing and access: '}Plans: ${P.plans.map(plan).join('. ')}.` });
      }
      const aud = B.audience || [];
      if (aud.length) add('price', 'aud', aud.slice(0, 2).join(' '), { lead: 'Who it’s for: ', short: aud[0] });
      // 4 · key takeaways: an article's sections first; a company's FAQ first
      const faq = B.faq || [];
      const takes = B.takeaways || [];
      if (faq.length && !(page && takes.length)) faq.slice(0, 3).forEach((q, i) => add('take', 'faq', q.a, { title: q.q, lead: i === 0 ? 'Key takeaways. Common questions: ' : '' }));
      else takes.slice(0, 4).forEach((t, i, all) => add('take', 'take', t.text, { title: t.title, lead: `${i === 0 ? 'Key takeaways: ' : ''}${ord(i, all.length)}` }));
      // Tables, spec lists and pricing / comparison grids are always briefed (Skip Tables is for the full read).
      for (const d of B.data || []) {
        const key = d.pricing ? 'price' : 'take';
        add(key, 'table', Summary.tableProse(d, { brief: true }), { grid: d, data: true, lead: groups[key].length ? '' : key === 'price' ? 'Pricing and access: ' : 'Key takeaways: ' });
      }

      // A briefing, not a reading: about a minute at 1× (45 s for an article). Drop the least important lines first.
      const budget = page ? 620 : 1000;
      const size = (it) => (it.data ? 0 : `${it.lead || ''}${it.title || ''}${it.after || ''}${it.speech || it.text || ''}`.length);
      const total = () => Object.values(groups).reduce((n, list) => n + list.reduce((m, it) => m + size(it), 0), 0);
      const role = (key, r) => groups[key].findIndex((it) => it.role === r);
      // Table summaries are outside the budget and never dropped: trimming takes the last line that is not one.
      const lines = (key) => groups[key].filter((it) => !it.data).length;
      const drop = (key) => {
        const list = groups[key];
        for (let i = list.length - 1; i >= 0; i--) {
          if (!list[i].data) return list.splice(i, 1).length > 0;
        }
        return false;
      };
      const steps = [
        () => lines('take') > 2 && drop('take'),
        () => groups.offer.length > 5 && groups.offer.pop(),
        () => groups.offer.length > 4 && groups.offer.pop(),
        () => {
          const i = role('price', 'aud');
          return i >= 0 && groups.price[i].short && groups.price[i].text !== groups.price[i].short && (groups.price[i].text = groups.price[i].short);
        },
        () => role('what', 'tagline') >= 0 && groups.what.splice(role('what', 'tagline'), 1),
        () => role('what', 'facts') >= 0 && groups.what.splice(role('what', 'facts'), 1),
        () => groups.offer.length > 3 && groups.offer.pop(),
        () => lines('take') > 1 && !page && drop('take'),
        () => lines('take') > 2 && page && drop('take'),
      ];
      for (const step of steps) if (total() > budget) step();

      const DEFS = [
        { key: 'what', label: page ? 'What This Page Covers' : 'What They Do' },
        { key: 'offer', label: 'What They Provide', sub: '(Key Offerings)' },
        { key: 'price', label: 'Pricing & Audience' },
        { key: 'take', label: 'Key Takeaways' },
      ];
      const body = [];
      const cards = [];
      let b = 0;
      for (const def of DEFS) {
        const segs = groups[def.key].map((it) => (it.data ? this.sumSegment({ kind: 'table', text: it.text, grid: it.grid }, lang, shown, { lead: it.lead || '' }) : this.briefSegment(it, lang, shown))).filter(Boolean);
        if (!segs.length) continue;
        const n = cards.length + 1;
        cards.push({ n, num: String(n).padStart(2, '0'), key: def.key, label: def.label, sub: def.sub || '' });
        segs.forEach((s, i) => {
          Object.assign(s, { card: n, para: n, b: b++, pauseBefore: i === 0 && n > 1 ? 560 : 0, pauseAfter: 300 });
          body.push(s);
        });
      }
      const site = B.name;
      const introText = B.domain ? `Site Briefing for ${site} (${B.domain}).` : `Site Briefing for ${site}.`;
      const full = (raw.blocks || []).length > 0;
      const outroText = `That concludes this Site Briefing on ${site}${norm(site) === 'sitevocal' ? '' : ', from SiteVocal'}.${full ? ' For every word, choose Full Page Read.' : ''}`;
      const segments = [
        this.segment('intro', introText, this.chunksFor(introText, 'en', announcer), { pauseAfter: 420, announcer: true, para: 0, b: -1, onair: 'On air · Site Briefing' }),
        ...body,
        this.segment('outro', outroText, this.chunksFor(outroText, 'en', announcer), { pauseBefore: 600, announcer: true, para: cards.length + 1, b }),
      ];
      const totalChars = this.layout(segments);
      const bodyChars = body.reduce((n, s) => n + s.chars, 0);
      const pauseMs = body.reduce((n, s) => n + s.pauseBefore + s.pauseAfter, 0);
      const minutes = (bodyChars / (cps * rate) + pauseMs / 1000 / rate) / 60;
      const words = body.reduce((n, s) => n + countWords(s.text) + countWords(s.title || ''), 0);
      const sections = cards.map((c, k) => {
        const seg = segments.findIndex((s) => s.card === c.n);
        const end = k + 1 < cards.length ? segments.findIndex((s) => s.card === cards[k + 1].n) : segments.length - 1;
        let chars = 0;
        let pause = 0;
        for (let i = seg; i < end; i++) {
          chars += segments[i].chars;
          pause += segments[i].pauseBefore + segments[i].pauseAfter;
        }
        return { seg, level: 2, title: `${c.num} · ${c.label}`, end, chars, pauseMs: pause };
      });
      return { segments, totalChars, bodyCount: body.length, paragraphs: cards.length, words, minutes, lang, pauseMs, filters: f, sections, mode: 'briefing', cards, briefing: B };
    },

    /** One dossier line: an optional spoken title ("Second, Billing.") then its text, or chips spoken as a sentence. */
    briefSegment(it, lang, shown) {
      const text = shown(it.text);
      const title = it.title ? shown(it.title) : '';
      let chunks = it.speech ? this.rawChunks(it.speech, lang) : text ? this.chunksFor(text, lang) : [];
      if (title) {
        const head = `${it.lead || ''}${title}${it.after || ''}`;
        chunks = [...this.rawChunks(/[.!?:…]$/.test(head) ? head : `${head}.`, lang), ...chunks];
      } else if (it.lead && chunks.length && !it.speech) {
        // A long first sentence gets its lead ("Key takeaways: First,") as its own short chunk instead.
        if (chunks[0].speech.length + it.lead.length > CHUNK_MAX + 10) chunks.unshift(this.fixed(Clean.speech(it.lead.replace(/[\s,:]+$/, ':'), this.opts)));
        else this.wrap(chunks[0], it.lead, '');
      }
      if (!chunks.length) return null;
      return this.segment('brief', text, chunks, { role: it.role, title, marker: it.marker || '', chips: it.chips || null });
    },

    /**
     * ✨ Summarize Page: what the page is, its few strongest points and at most one table's gist, as a short
     * spoken script — no section headings read out. Same shape as a full read (intro, body, sign-off,
     * ≤10 s chunks), so the engine, outline, progress, resume and library work unchanged. Tables are always
     * summarised here, even with Skip Tables on: that filter is for the word-for-word read.
     */
    summary(raw, { rate = 1, cps = DEFAULT_CPS, filters = FILTERS } = {}) {
      const f = { ...FILTERS, ...(filters || {}) };
      this.opts = { lexicon: f.lexicon };
      const S = Summary.plan(raw, { cps, ai: AiSummary.allowed(raw.summaryAi) ? raw.summaryAi : null });
      const lang = raw.lang || 'en';
      const announcer = { lexicon: true };
      // A summary never reads citation marks ("[12]"), whatever the Skip Citations pill says.
      const shown = (text) => Clean.display(Clean.citations(String(text || '')));
      const body = [];
      const cards = [];
      let b = 0;
      for (const card of S.cards) {
        const segs = [];
        card.items.forEach((it, i) => {
          const lead = '';
          const seg = this.sumSegment(it, lang, shown, { lead, head: i === 0 && card.heading ? card.label : '' });
          if (seg) segs.push(seg);
        });
        if (!segs.length) continue;
        const n = cards.length + 1;
        cards.push({ n, num: String(n).padStart(2, '0'), key: card.key, label: card.label, level: card.level || 2 });
        segs.forEach((s, i) => {
          Object.assign(s, { card: n, para: n, b: b++, pauseBefore: i === 0 && n > 1 ? 520 : 0, pauseAfter: s.kind === 'sum' ? 300 : 420 });
          body.push(s);
        });
      }
      const site = S.site || 'this website';
      const title = Summary.bareTitle(raw.title || site, site).replace(/[\s.!?…:;,]+$/, '');
      const introText = norm(title) === norm(site) ? `Page Summary of ${site}.` : `Page Summary of ${trimText(title, 140)}, from ${site}.`;
      const by = S.engine === 'chrome-ai' ? ' Summarized on this device by Chrome’s built-in AI.' : S.engine === 'cloud' ? ` Summarized by your Turbo Engine${S.model ? `, ${S.model}` : ''}.` : '';
      const full = (raw.blocks || []).length > 0;
      const outroText = `That’s the summary${norm(site) === 'sitevocal' ? '' : ` of ${site}`}.${by}${full ? ' For every word, choose Full Page Read.' : ''}`;
      const segments = [
        this.segment('intro', introText, this.chunksFor(introText, 'en', announcer), { pauseAfter: 420, announcer: true, para: 0, b: -1, onair: 'On air · Page Summary' }),
        ...body,
        this.segment('outro', outroText, this.chunksFor(outroText, 'en', announcer), { pauseBefore: 600, announcer: true, para: cards.length + 1, b }),
      ];
      const totalChars = this.layout(segments);
      const bodyChars = body.reduce((n, s) => n + s.chars, 0);
      const pauseMs = body.reduce((n, s) => n + s.pauseBefore + s.pauseAfter, 0);
      const minutes = (bodyChars / (cps * rate) + pauseMs / 1000 / rate) / 60;
      const words = body.reduce((n, s) => n + countWords(s.text), 0);
      const sections = cards.map((c, k) => {
        const seg = segments.findIndex((s) => s.card === c.n);
        const end = k + 1 < cards.length ? segments.findIndex((s) => s.card === cards[k + 1].n) : segments.length - 1;
        let chars = 0;
        let pause = 0;
        for (let i = seg; i < end; i++) {
          chars += segments[i].chars;
          pause += segments[i].pauseBefore + segments[i].pauseAfter;
        }
        return { seg, level: 2, title: `${c.num} · ${c.label}`, end, chars, pauseMs: pause };
      });
      return { segments, totalChars, bodyCount: body.length, paragraphs: cards.length, words, minutes, lang, pauseMs, filters: f, sections, mode: 'summary', cards, summary: S };
    },

    /** One summary line: a sentence, a key list, a table or a pricing grid; a section's first line speaks its heading. */
    sumSegment(it, lang, shown, { lead = '', head = '' } = {}) {
      const text = shown(it.text);
      let chunks = text ? this.chunksFor(text, lang) : [];
      if (!chunks.length) return null;
      if (lead) {
        if (chunks[0].speech.length + lead.length > CHUNK_MAX + 10) chunks.unshift(this.fixed(Clean.speech(lead.trim().replace(/[\s,:.]+$/, ':'), this.opts)));
        else this.wrap(chunks[0], lead, '');
      }
      if (head) chunks = [...this.rawChunks(/[.!?:…]$/.test(head) ? head : `${head}.`, lang), ...chunks];
      const kind = it.kind === 'table' ? 'sumtable' : it.kind === 'list' ? 'sumlist' : it.kind === 'price' ? 'sumprice' : 'sum';
      const extra = kind === 'sumtable' ? { grid: it.grid } : kind === 'sumlist' ? { items: it.items, ordered: Boolean(it.ordered), total: it.total || it.items.length } : kind === 'sumprice' ? { plans: it.plans } : {};
      return this.segment(kind, text, chunks, { role: it.role || it.kind, ...extra });
    },

    intro(raw, site, minutes) {
      const title = String(raw.title || 'Untitled page').replace(/[\s.]+$/, '');
      // A title that already ends a sentence ("…champion!", "Why now?") gets no extra full stop or comma.
      const ended = /[!?…]["'”’»)\]]*$/.test(title);
      let s = 'Welcome to SiteVocal. ';
      if (raw.kind === 'text') s += `Now reading your pasted text: ${title}${ended ? '' : '.'}`;
      else {
        s += raw.kind === 'selection' ? `Now reading a selection from ${site}: ${title}` : `Now reading from ${site}: ${title}`;
        const author = raw.author && norm(raw.author) !== norm(site) ? raw.author : '';
        if (author) s += ended ? ` Written by ${author}.` : `, written by ${author}.`;
        else if (!ended) s += '.';
      }
      return `${s} Estimated listening time: ${fmtListen(minutes)}.`.replace(/\s+/g, ' ');
    },

    /** Section Outline: h2/h3 headings (plus the opening) with the characters and pauses each one spans. */
    outline(segments) {
      const heads = segments.filter((s) => s.kind === 'h' && s.level <= 3);
      if (!heads.length) return [];
      const outroAt = segments.length - 1;
      const marks = [];
      if (heads[0].i > 1) marks.push({ seg: 0, level: 2, title: 'Introduction' });
      for (const h of heads) marks.push({ seg: h.i, level: h.level <= 2 ? 2 : 3, title: h.text });
      return marks.map((m, k) => {
        let end = outroAt;
        for (let j = k + 1; j < marks.length; j++) {
          if (marks[j].level <= m.level) {
            end = marks[j].seg;
            break;
          }
        }
        let chars = 0;
        let pauseMs = 0;
        for (let i = m.seg; i < end; i++) {
          chars += segments[i].chars;
          pauseMs += segments[i].pauseBefore + segments[i].pauseAfter;
        }
        return { ...m, end, chars, pauseMs };
      });
    },

    chunksFor(text, lang, opts = this.opts) {
      return Clean.chunks(text, lang)
        .map(([start, end]) => {
          const speech = Clean.speech(text.slice(start, end), opts);
          return { start, end, speech, cs: 0, ce: speech.length };
        })
        .filter((c) => c.speech && /[\p{L}\p{N}]/u.test(c.speech));
    },

    /** Spoken-only chunks (code or a table read aloud): nothing on screen to highlight word by word. */
    rawChunks(text, lang) {
      return Clean.chunks(text, lang)
        .map(([start, end]) => this.fixed(Clean.speech(text.slice(start, end), this.opts)))
        .filter((c) => c.speech && /[\p{L}\p{N}]/u.test(c.speech));
    },

    fixed(speech) {
      return { start: 0, end: 0, speech, cs: 0, ce: 0 };
    },

    codeSpeech(code) {
      const lines = String(code)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /[\p{L}\p{N}]/u.test(l))
        .slice(0, 60);
      if (!lines.length) return '';
      return `Code block. ${lines.map((l) => (/[.!?;:]$/.test(l) ? l : `${l}.`)).join(' ')} End of code block.`;
    },

    tableSpeech(block) {
      const rows = (block.cells || []).filter((r) => r.some(Boolean));
      if (!rows.length) return '';
      const header = block.head ? rows[0] : null;
      const body = header ? rows.slice(1) : rows;
      if (!body.length) return '';
      const lines = [`${block.caption ? `${block.caption}. ` : ''}Table with ${plural(body.length, 'row')}.`];
      body.slice(0, 20).forEach((r, i) => {
        const cells = r.map((c, j) => (c && header && header[j] ? `${header[j]} ${c}` : c)).filter(Boolean);
        lines.push(`Row ${i + 1}: ${cells.join(', ')}.`);
      });
      if (body.length > 20) lines.push(`And ${plural(body.length - 20, 'more row')}.`);
      return lines.join(' ');
    },

    wrap(chunk, before, after) {
      chunk.speech = before + chunk.speech + after;
      chunk.cs += before.length;
      chunk.ce += before.length;
    },

    segment(kind, text, chunks, opts = {}) {
      return { kind, text, chunks, pauseBefore: 0, pauseAfter: 0, para: 0, level: 0, marker: '', rows: 0, announcer: false, b: 0, ...opts, chars: chunks.reduce((n, c) => n + c.speech.length, 0) };
    },
  };

  /* ----------------------------------------------------------------- voices */
  const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|princess|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;

  const Voices = {
    list: [],
    loaded: false,
    onChange: null,
    load() {
      const synth = window.speechSynthesis;
      if (!synth) return Promise.resolve([]);
      const refresh = () => {
        const voices = synth.getVoices() || [];
        if (voices.length) this.list = voices;
        return voices.length > 0;
      };
      const changed = () => {
        if (refresh() && this.onChange) this.onChange();
      };
      if (synth.addEventListener) synth.addEventListener('voiceschanged', changed);
      else synth.onvoiceschanged = changed;
      return new Promise((resolve) => {
        const done = () => {
          this.loaded = true;
          resolve(this.list);
        };
        if (refresh()) return done();
        let tries = 0;
        const timer = setInterval(() => {
          if (refresh() || ++tries > 40) {
            clearInterval(timer);
            done();
          }
        }, 100);
      });
    },
    /** Rank voices: language match first, then "Natural / Neural / Online / Premium / Siri / Google" quality cues. */
    score(v, lang) {
      const name = String(v.name || '').toLowerCase();
      const vl = String(v.lang || '').toLowerCase().replace('_', '-');
      const want = String(lang || 'en').toLowerCase();
      let s = 0;
      if (vl === want) s += 120;
      else if (vl.split('-')[0] === want.split('-')[0]) s += 90;
      else s -= 200;
      if (vl === String(navigator.language || '').toLowerCase()) s += 8;
      if (/natural/.test(name)) s += 60;
      if (/neural/.test(name)) s += 50;
      if (/premium/.test(name)) s += 45;
      if (/online/.test(name)) s += 40;
      if (/siri/.test(name)) s += 38;
      if (/enhanced/.test(name)) s += 35;
      if (/google/.test(name)) s += 34;
      if (/\b(samantha|alex|daniel|karen|moira|tessa|ava|allison|susan|zoe|evan|nathan|serena|aria|jenny|guy|libby|sonia|ryan|emma|brian|andrew)\b/.test(name)) s += 12;
      if (NOVELTY.test(name)) s -= 300;
      if (/espeak|compact|robot/.test(name)) s -= 40;
      if (v.default) s += 5;
      if (v.localService === false) s += 6;
      return s;
    },
    ranked(lang) {
      return [...this.list].sort((a, b) => this.score(b, lang) - this.score(a, lang));
    },
    best(lang) {
      return this.ranked(lang)[0] || null;
    },
    find(uri) {
      return this.list.find((v) => v.voiceURI === uri) || this.list.find((v) => v.name === uri) || null;
    },
    resolve(pref, lang) {
      return (pref && pref !== 'auto' && this.find(pref)) || this.best(lang);
    },
    matches(v, lang) {
      return String(v.lang || '').toLowerCase().split(/[-_]/)[0] === String(lang || 'en').toLowerCase().split(/[-_]/)[0];
    },
    short(v) {
      if (!v) return 'Default voice';
      return String(v.name)
        .replace(/^Microsoft\s+/i, '')
        .replace(/\s+Online\s+\(Natural\)/i, ' (Natural)')
        .replace(/\s+-\s+.*$/, '')
        .trim();
    },
    /** On-device voice: the text never leaves this computer. Network voices send each sentence to the vendor. */
    isLocal(v) {
      return Boolean(v) && v.localService !== false;
    },
    vendor(v) {
      const name = String((v && v.name) || '');
      if (/google/i.test(name)) return 'Google';
      if (/microsoft|edge/i.test(name)) return 'Microsoft';
      if (/apple|siri/i.test(name)) return 'Apple';
      if (/amazon|polly/i.test(name)) return 'Amazon';
      return 'the voice provider';
    },
    bestLocal(lang) {
      return this.ranked(lang).find((v) => this.isLocal(v) && this.matches(v, lang)) || this.ranked(lang).find((v) => this.isLocal(v)) || null;
    },
  };

  /* ---------------------------------------------------------- speech engine
   * One utterance in flight at a time. Every start/jump/rate change bumps a
   * token, cancels the engine and ignores late events from old utterances —
   * so voices never overlap, and ≤10 s chunks dodge Chrome's 15 s cut-off. */
  const Engine = {
    synth: window.speechSynthesis || null,
    script: null,
    voice: null,
    rate: 1,
    seg: 0,
    chunk: 0,
    offset: 0, // resume point inside the current chunk (last real word boundary)
    cursor: 0, // estimated characters spoken in the current chunk (progress only)
    state: 'idle',
    token: 0,
    utter: null,
    timers: {},
    cps: DEFAULT_CPS,
    failures: 0,
    stalls: 0,
    chunkRetries: 0,
    lastCancelAt: 0,
    startedAt: 0,
    segStartedAt: 0,
    boundaryVoices: new Set(),
    handlers: {},
    pickFallback: null,
    audio: null, // Turbo Engine voice: one <audio> element, a sentence at a time
    cloudResume: null,

    on(evt, fn) {
      (this.handlers[evt] || (this.handlers[evt] = [])).push(fn);
    },
    emit(evt, ...args) {
      for (const fn of this.handlers[evt] || []) {
        try {
          fn(...args);
        } catch (err) {
          console.error('[SiteVocal]', err);
        }
      }
    },
    setState(state) {
      if (this.state === state) return;
      this.state = state;
      this.emit('state', state);
    },
    clearTimers() {
      for (const id of Object.values(this.timers)) {
        clearTimeout(id);
        clearInterval(id);
      }
      this.timers = {};
    },
    detach() {
      if (this.utter) {
        this.utter.onstart = null;
        this.utter.onend = null;
        this.utter.onerror = null;
        this.utter.onboundary = null;
      }
      this.utter = null;
    },
    invalidate() {
      this.token++;
      this.clearTimers();
      this.detach();
      this.haltCloud(false);
    },
    /** Stop the Turbo voice's audio; keep = remember where, so Play continues mid-sentence. */
    haltCloud(keep) {
      const a = this.audio;
      if (!a) return;
      if (keep && !a.paused && a.dataset.text) this.cloudResume = { text: a.dataset.text, time: a.currentTime };
      a.onplaying = null;
      a.onended = null;
      a.onerror = null;
      a.ontimeupdate = null;
      if (!a.paused) a.pause();
    },
    cancelSynth() {
      if (!this.synth) return;
      // Nothing speaking or queued: no cancel, so the next speak() needs no settle delay and the first word comes at once.
      if (!this.synth.speaking && !this.synth.pending && !this.synth.paused) return;
      this.lastCancelAt = performance.now();
      try {
        this.synth.cancel();
      } catch {
        /* engine already idle */
      }
    },

    load(script, { seg = 0, chunk = 0 } = {}) {
      this.stop();
      this.script = script;
      this.seg = clamp(seg, 0, script.segments.length - 1);
      this.chunk = clamp(chunk, 0, Math.max(0, script.segments[this.seg].chunks.length - 1));
      this.offset = 0;
      this.cursor = 0;
      this.setState('ready');
      this.emit('position', this.position());
    },
    stop() {
      this.invalidate();
      this.cancelSynth();
      this.script = null;
      this.setState('idle');
    },
    position() {
      return { seg: this.seg, chunk: this.chunk };
    },

    play() {
      if (!this.script) return;
      if (!this.synth && !Turbo.voiceActive()) {
        this.emit('error', 'This browser has no built-in speech engine (Web Speech API). Try Chrome, Edge or Safari.');
        return;
      }
      if (this.state === 'playing') return;
      if (this.state === 'ended') {
        this.seg = 0;
        this.chunk = 0;
        this.offset = 0;
        this.emit('position', this.position());
      }
      this.failures = 0;
      this.stalls = 0;
      this.setState('playing');
      this.speak();
    },
    pause() {
      if (this.state !== 'playing' && this.state !== 'blocked') return;
      this.haltCloud(true);
      this.invalidate();
      this.cancelSynth();
      this.setState('paused');
    },
    toggle() {
      if (this.state === 'playing') this.pause();
      else this.play();
    },
    jump(seg, chunk = 0, { play = false } = {}) {
      if (!this.script) return;
      const resume = this.state === 'playing' || play;
      this.invalidate();
      this.cancelSynth();
      this.cloudResume = null;
      this.seg = clamp(seg, 0, this.script.segments.length - 1);
      this.chunk = clamp(chunk, 0, Math.max(0, this.script.segments[this.seg].chunks.length - 1));
      this.offset = 0;
      this.cursor = 0;
      this.emit('position', this.position());
      if (resume) {
        this.failures = 0;
        this.stalls = 0;
        this.setState('playing');
        this.speak();
      } else if (this.state === 'ended' || this.state === 'blocked') {
        this.setState('paused');
      }
    },
    next() {
      if (this.script && this.seg < this.script.segments.length - 1) this.jump(this.seg + 1);
    },
    prev() {
      if (!this.script) return;
      const replay = this.chunk > 0 || (this.state === 'playing' && performance.now() - this.segStartedAt > 2500);
      this.jump(replay ? this.seg : Math.max(0, this.seg - 1));
    },
    nextSentence() {
      const s = this.script && this.script.segments[this.seg];
      if (!s) return;
      if (this.chunk + 1 < s.chunks.length) this.jump(this.seg, this.chunk + 1);
      else this.next();
    },
    prevSentence() {
      if (!this.script) return;
      if (this.chunk > 0) this.jump(this.seg, this.chunk - 1);
      else if (this.seg > 0) this.jump(this.seg - 1, this.script.segments[this.seg - 1].chunks.length - 1);
    },
    seekFraction(f) {
      const script = this.script;
      if (!script || !script.totalChars) return;
      const target = clamp(f, 0, 0.9999) * script.totalChars;
      let seg = script.segments.findIndex((s) => s.startChar + s.chars > target);
      if (seg < 0) seg = script.segments.length - 1;
      const s = script.segments[seg];
      let chunk = 0;
      for (let c = 0; c < s.chunks.length; c++) if (s.startChar + s.chunks[c].startChar <= target) chunk = c;
      this.jump(seg, chunk);
    },
    setRate(rate) {
      if (rate === this.rate) return;
      this.rate = rate;
      if (this.state === 'playing') this.restart();
    },
    setVoice(voice) {
      if (voice === this.voice) return;
      this.voice = voice;
      if (this.state === 'playing') this.restart();
    },
    restart() {
      this.haltCloud(true);
      this.invalidate();
      this.cancelSynth();
      this.speak();
    },

    voiceFor(seg) {
      // The station announcer (intro/outro) speaks English even when the article does not.
      if (seg.announcer && this.voice && !/^en\b/i.test(this.voice.lang || '')) return Voices.best('en') || this.voice;
      return this.voice;
    },

    /** Speak the current chunk. `natural` = the previous chunk just ended on its own (no cancel needed). */
    async speak(natural = false) {
      const token = ++this.token;
      this.clearTimers();
      const script = this.script;
      if (!script) return;
      const seg = script.segments[this.seg];
      if (!seg) return this.finish();
      const chunk = seg.chunks[this.chunk];
      if (!chunk) return this.advance(token);
      if (Turbo.voiceActive()) return this.speakCloud(token, chunk);
      if (!this.synth) return;
      const synth = this.synth;
      if (synth.pending || (synth.speaking && !natural)) this.cancelSynth();
      // Chrome can drop a speak() issued right after cancel(), and callers usually cancel before calling speak().
      const settle = 80 - (performance.now() - this.lastCancelAt);
      if (settle > 0) {
        await sleep(settle);
        if (token !== this.token) return;
      }
      if (synth.paused) {
        try {
          synth.resume();
        } catch {
          /* not paused */
        }
      }
      let base = 0;
      let text = chunk.speech;
      if (this.offset > 0 && this.offset < text.length - 3) {
        base = this.offset;
        text = text.slice(base);
      }
      const voice = this.voiceFor(seg);
      const key = voice ? voice.voiceURI || voice.name : 'default';
      // The utterance prepared while the previous sentence was speaking, when it still fits; else a new one.
      const ready = this.prepared;
      this.prepared = null;
      const u = ready && base === 0 && ready.script === script && ready.seg === this.seg && ready.chunk === this.chunk && ready.rate === this.rate && ready.key === key ? ready.u : this.utterance(script, seg, text, voice);
      let started = false;
      u.onstart = () => {
        if (token !== this.token) return;
        started = true;
        this.failures = 0;
        this.startedAt = performance.now();
        if (this.chunk === 0 && base === 0) this.segStartedAt = this.startedAt;
        this.armWatchdog(token, text.length);
        if (!this.boundaryVoices.has(key)) this.estimate(token, text, base, key);
      };
      u.onboundary = (e) => {
        if (token !== this.token || (e.name && e.name !== 'word')) return;
        started = true;
        if (!this.boundaryVoices.has(key)) {
          this.boundaryVoices.add(key);
          clearInterval(this.timers.estimate);
        }
        const at = base + (e.charIndex || 0);
        this.offset = at;
        this.cursor = at;
        this.emit('word', this.seg, this.chunk, at);
        this.armWatchdog(token, Math.max(1, text.length - (e.charIndex || 0)));
      };
      u.onend = () => {
        if (token !== this.token) return;
        if (started) {
          this.calibrate(text.length, performance.now() - this.startedAt);
          this.emit('spoken', text);
        }
        this.stalls = 0;
        this.chunkRetries = 0;
        this.advance(token);
      };
      u.onerror = (e) => {
        if (token !== this.token) return;
        const err = (e && e.error) || 'unknown';
        if (err === 'interrupted' || err === 'canceled') {
          // SiteVocal bumps the token before every cancel it issues, so this came from outside
          // (another tab, the OS or a screen reader): pause cleanly instead of waiting on a watchdog.
          this.invalidate();
          this.setState('paused');
          this.emit('error', 'Speech was interrupted by another app or tab — press play to continue.');
          return;
        }
        if (err === 'not-allowed') {
          this.invalidate();
          this.setState('blocked');
          return;
        }
        this.fail(token, err);
      };
      this.utter = u;
      window.__siteVocalUtterance = u; // strong reference: Chrome drops onend for garbage-collected utterances
      try {
        synth.speak(u);
      } catch (err) {
        this.fail(token, (err && err.message) || 'speak-failed');
        return;
      }
      this.timers.start = setTimeout(() => {
        if (token === this.token && !started) this.noStart(token);
      }, 8000);
      this.prepareNext();
    },

    /** One utterance: the text, the voice (or the language when there is none), the speed. */
    utterance(script, seg, text, voice) {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = (seg.announcer ? 'en' : script.lang) || 'en';
      }
      u.rate = this.rate;
      u.pitch = 1;
      u.volume = 1;
      return u;
    },

    /**
     * While a sentence speaks, the next one is made ready: its text (normalized when the script was built), its
     * voice and its utterance. The hand-over then does no work at all; a change of speed, voice or script since
     * simply means a fresh utterance.
     */
    prepareNext() {
      this.prepared = null;
      const script = this.script;
      if (!script) return;
      let seg = this.seg;
      let chunk = this.chunk + 1;
      if (!script.segments[seg] || chunk >= script.segments[seg].chunks.length) {
        seg++;
        chunk = 0;
      }
      const s = script.segments[seg];
      const c = s && s.chunks[chunk];
      if (!c) return;
      const voice = this.voiceFor(s);
      this.prepared = { script, seg, chunk, rate: this.rate, key: voice ? voice.voiceURI || voice.name : 'default', u: this.utterance(script, s, c.speech, voice) };
    },

    /**
     * The Turbo Engine voice (your own Fish Audio / OpenAI-compatible key): the sentence as audio, the next two
     * fetched ahead, the word highlight following the audio's clock. Any failure → the local voice, same sentence.
     */
    async speakCloud(token, chunk) {
      this.cancelSynth();
      const text = chunk.speech;
      if (!this.audio) {
        this.audio = new Audio();
        this.audio.preload = 'auto';
      }
      const a = this.audio;
      let url;
      try {
        url = await Turbo.audioUrl(text);
      } catch (err) {
        if (token !== this.token) return;
        Turbo.voiceFailed(err);
        this.speak();
        return;
      }
      if (token !== this.token) return;
      Turbo.prefetch(this.upcoming(2));
      const resume = this.cloudResume && this.cloudResume.text === text ? this.cloudResume.time : 0;
      this.cloudResume = null;
      a.dataset.text = text;
      if (a.src !== url) a.src = url;
      a.playbackRate = clamp(this.rate, 0.5, 4);
      const starts = [];
      for (const m of text.matchAll(/\S+/g)) starts.push(m.index);
      let last = -1;
      a.onplaying = () => {
        if (token !== this.token) return;
        this.failures = 0;
        this.startedAt = performance.now();
        if (this.chunk === 0 && !resume) this.segStartedAt = this.startedAt;
      };
      a.ontimeupdate = () => {
        if (token !== this.token || !a.duration || !Number.isFinite(a.duration)) return;
        const at = Math.floor((a.currentTime / a.duration) * text.length);
        let w = 0;
        while (w + 1 < starts.length && starts[w + 1] <= at) w++;
        if (starts.length && w !== last) {
          last = w;
          this.offset = 0;
          this.cursor = starts[w];
          this.emit('word', this.seg, this.chunk, starts[w]);
        }
      };
      a.onended = () => {
        if (token !== this.token) return;
        this.emit('spoken', text);
        this.advance(token);
      };
      a.onerror = () => {
        if (token !== this.token) return;
        Turbo.voiceFailed(new Error('the audio could not be played'));
        this.speak();
      };
      try {
        a.currentTime = resume;
        await a.play();
      } catch (err) {
        if (token !== this.token) return;
        if (err && err.name === 'NotAllowedError') {
          this.invalidate();
          this.setState('blocked');
          return;
        }
        Turbo.voiceFailed(err);
        this.speak();
      }
    },

    /** The speech text of the next n chunks (for the Turbo voice to fetch ahead). */
    upcoming(n) {
      const out = [];
      let s = this.seg;
      let c = this.chunk + 1;
      while (this.script && out.length < n && s < this.script.segments.length) {
        const seg = this.script.segments[s];
        if (c < seg.chunks.length) out.push(seg.chunks[c++].speech);
        else {
          s++;
          c = 0;
        }
      }
      return out;
    },

    advance(token) {
      const script = this.script;
      if (!script || token !== this.token) return;
      this.detach();
      this.offset = 0;
      this.cursor = 0;
      this.chunkRetries = 0;
      const seg = script.segments[this.seg];
      if (seg && this.chunk + 1 < seg.chunks.length) {
        this.chunk++;
        // The next sentence first (its utterance is ready); the highlight and the saved place follow in this task.
        this.speak(true);
        this.emit('position', this.position());
        return;
      }
      if (this.seg + 1 >= script.segments.length) return this.finish();
      const next = script.segments[this.seg + 1];
      const gap = ((seg ? seg.pauseAfter : 0) + next.pauseBefore) / Math.max(0.5, this.rate);
      this.seg++;
      this.chunk = 0;
      this.emit('position', this.position());
      this.clearTimers();
      this.timers.gap = setTimeout(() => {
        if (token === this.token) this.speak(true);
      }, gap);
    },

    finish() {
      this.invalidate();
      if (!this.script) return;
      this.seg = this.script.segments.length - 1;
      this.chunk = Math.max(0, this.script.segments[this.seg].chunks.length - 1);
      this.offset = 0;
      this.cursor = 0;
      this.setState('ended');
      this.emit('end');
    },

    fail(token, err) {
      this.failures++;
      console.warn('[SiteVocal] speech error:', err);
      this.detach();
      if (this.failures >= 6) {
        this.invalidate();
        this.cancelSynth();
        this.setState('paused');
        this.emit('error', `The speech engine keeps failing (${err}). Try another voice from the voice menu.`);
        return;
      }
      let action = this.failures === 1 ? 'retry' : 'skip';
      if (this.failures === 2 && this.voice && this.voice.localService === false && this.pickFallback) {
        const local = this.pickFallback();
        if (local && local !== this.voice) {
          this.voice = local;
          this.emit('fallback', local, err);
          action = 'retry';
        }
      }
      this.clearTimers();
      this.timers.retry = setTimeout(() => {
        if (token !== this.token) return;
        if (action === 'retry') this.speak();
        else this.advance(token);
      }, 350);
    },

    noStart(token) {
      // onstart never fired. Blink reports `speaking` even for an utterance that is merely queued, so it proves
      // nothing: retry the same sentence (from the last word boundary) and give up only after repeated failures.
      if (token !== this.token) return;
      this.stalls++;
      this.detach();
      this.cancelSynth();
      if (this.stalls >= 3) {
        this.invalidate();
        this.setState('paused');
        this.emit('error', 'No speech engine responded. Your system may have no text-to-speech voices installed — try another browser or voice.');
        return;
      }
      this.speak();
    },

    armWatchdog(token, chars) {
      clearTimeout(this.timers.watchdog);
      const ms = (chars / (this.cps * this.rate)) * 1000 * 2.2 + 5000;
      this.timers.watchdog = setTimeout(() => {
        if (token !== this.token) return;
        this.stalls++;
        this.detach();
        this.cancelSynth();
        if (this.stalls > 4) {
          this.invalidate();
          this.setState('paused');
          this.emit('error', 'Speech stalled repeatedly. Press play to try again, or pick another voice.');
          return;
        }
        if (this.offset > 0 && this.chunkRetries < 1) {
          // We know the last word that was spoken: pick the sentence up from there once.
          this.chunkRetries++;
          console.warn('[SiteVocal] utterance stalled — resuming from the last word');
          this.speak();
          return;
        }
        console.warn('[SiteVocal] utterance stalled — moving on to the next sentence');
        this.advance(token);
      }, ms);
    },

    /** Word timing for voices that never fire boundary events (e.g. Chrome's Google voices). */
    estimate(token, text, base, key) {
      clearInterval(this.timers.estimate);
      const starts = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) starts.push(m.index);
      if (!starts.length) return;
      const t0 = performance.now();
      let last = -1;
      this.timers.estimate = setInterval(() => {
        if (token !== this.token || this.boundaryVoices.has(key)) {
          clearInterval(this.timers.estimate);
          return;
        }
        const pos = ((performance.now() - t0) / 1000) * this.cps * this.rate;
        let i = Math.max(0, last);
        while (i + 1 < starts.length && starts[i + 1] <= pos) i++;
        this.cursor = base + Math.min(pos, text.length);
        if (i !== last) {
          last = i;
          this.emit('word', this.seg, this.chunk, base + starts[i]);
        }
      }, 90);
    },

    calibrate(chars, ms) {
      if (chars < 40 || ms < 900) return;
      const measured = chars / (ms / 1000) / this.rate;
      if (measured > 4 && measured < 40) this.cps = clamp(this.cps * 0.75 + measured * 0.25, 8, 26);
    },

    fraction() {
      const script = this.script;
      if (!script || !script.totalChars) return 0;
      if (this.state === 'ended') return 1;
      const s = script.segments[this.seg];
      if (!s) return 0;
      const ch = s.chunks[this.chunk];
      const within = ch ? Math.min(this.cursor || 0, ch.speech.length) : 0;
      return clamp((s.startChar + (ch ? ch.startChar : 0) + within) / script.totalChars, 0, 1);
    },
    totalSeconds() {
      const script = this.script;
      if (!script) return 0;
      return script.totalChars / (this.cps * this.rate) + script.pauseMs / 1000 / this.rate;
    },
  };

  /* ======================================================= ⚡ Turbo Engine (optional)
   * SiteVocal needs no API key: the browser's own voices speak and the built-in summarizer writes the
   * summary. Advanced listeners can add their own key in Docs & Lexicon → Turbo Engine:
   *   • Voice      Fish Audio (api.fish.audio/v1/tts) or any OpenAI-compatible /v1/audio/speech endpoint
   *   • Summarizer any OpenAI-compatible /v1/chat/completions endpoint
   *   • Reader     a Jina (r.jina.ai) or TinyFish Fetch key, for more pages a minute than the keyless reader
   * The gate is strict: with no key entered, Turbo makes no request at all — "0 bytes sent to the cloud".
   * Keys stay on this device (localStorage, or the extension's own storage) and go only to the endpoint
   * you typed. Inside the extension the request is made by panel.js (extension origin, no CORS, no cookies).
   * Any error drops back to the local voice / built-in summary for the rest of the session. */
  /* What every model is asked for ✨ Summarize Page — the browser's own on-device model or your Turbo LLM: clean the
   * page (the text of a browser tab carries menus, the poster's name, counts and captions), then summarize it. */
  const PAGE_PROMPT = 'You turn a web page into a short summary that someone will listen to. The text was copied from a browser tab, so it can include menus, buttons, sign-in prompts, the name and handle of whoever posted or shared the page, follower, like and view counts, image captions, ads, cookie notices, repeated banners and lists of technologies. Ignore all of that and summarize only what the page is about. "overview": one sentence saying what the page is about. "points": 3 to 5 key points, the most important first, each one complete sentence in plain spoken English that makes sense on its own. No headings, markdown, URLs, hashtags, @handles, emojis or calls to action. Do not mention who posted or shared the page unless the page is about that person. Never invent facts. Reply with JSON only: {"overview": "...", "points": ["...", "..."]}.';
  const PAGE_SCHEMA = { type: 'object', properties: { overview: { type: 'string' }, points: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } }, required: ['overview', 'points'], additionalProperties: false };
  const LANG_NAMES = { en: 'English', es: 'Spanish', ja: 'Japanese', de: 'German', fr: 'French', it: 'Italian', pt: 'Portuguese' };
  /** A model's JSON answer ({"overview", "points"}, possibly wrapped in prose or ```json) → clean spoken lines. */
  const pageAnswer = (content) => {
    const t = String(content || '');
    const data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const list = data && Array.isArray(data.points) ? data.points : Object.values((data && data.sections) || {}).flat();
    return { overview: data && typeof data.overview === 'string' ? Briefing.clean(data.overview) : '', points: Summary.points(list.filter((x) => typeof x === 'string').join('\n')).slice(0, 5) };
  };

  const TURBO_DEFAULTS = {
    voice: 'off', // 'off' | 'fish' | 'openai'
    fishKey: '',
    fishVoice: '',
    fishModel: 's2-pro',
    ttsUrl: 'https://api.openai.com/v1/audio/speech',
    ttsKey: '',
    ttsModel: 'gpt-4o-mini-tts',
    ttsVoice: 'alloy',
    llm: 'off', // 'off' | 'openai'
    llmUrl: 'https://api.openai.com/v1/chat/completions',
    llmKey: '',
    llmModel: 'gpt-4o-mini',
    onDevice: true, // Chrome's built-in Summarizer when it is already on this device
    reader: 'off', // 'off' (the keyless race) | 'jina' | 'tinyfish'
    jinaKey: '',
    tinyfishKey: '',
  };
  const FISH_TTS = 'https://api.fish.audio/v1/tts';

  /** Where a key and its text may go: https, or plain http only to a server on this computer or your own network
   *  (Chrome Web Store policy: user data travels encrypted; a local server keeps it on your network). */
  function privateHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
    if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
    return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  function secureEndpoint(value) {
    try {
      const u = new URL(String(value || '').trim());
      return u.protocol === 'https:' || (u.protocol === 'http:' && privateHost(u.hostname));
    } catch {
      return false;
    }
  }
  const fmtBytes = (n) => (n < 1024 ? plural(n, 'byte') : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  const Turbo = {
    cfg: { ...TURBO_DEFAULTS },
    bytes: 0, // sent to a Turbo endpoint this session (0 unless you entered a key)
    requests: 0,
    voiceOff: false, // a failed request turns the Turbo voice off until the next reload
    llmOff: false,
    cache: new Map(),

    load() {
      const saved = Store.getJSON(KEYS.turbo, {});
      const out = { ...TURBO_DEFAULTS };
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(TURBO_DEFAULTS)) if (typeof saved[k] === typeof TURBO_DEFAULTS[k]) out[k] = saved[k];
      }
      if (!['off', 'fish', 'openai'].includes(out.voice)) out.voice = 'off';
      if (!['off', 'openai'].includes(out.llm)) out.llm = 'off';
      if (!['off', 'jina', 'tinyfish'].includes(out.reader)) out.reader = 'off';
      this.cfg = out;
    },
    save(patch) {
      this.cfg = { ...this.cfg, ...patch };
      Store.setJSON(KEYS.turbo, this.cfg);
      this.voiceOff = false;
      this.llmOff = false;
      this.clearCache();
    },
    clearKeys() {
      this.save({ voice: 'off', llm: 'off', reader: 'off', fishKey: '', ttsKey: '', llmKey: '', jinaKey: '', tinyfishKey: '' });
    },

    /** The strict gate: a provider chosen AND a key typed AND a secure endpoint (https, or http on your own network). */
    voiceReady() {
      const c = this.cfg;
      if (c.voice === 'fish') return Boolean(c.fishKey.trim());
      if (c.voice === 'openai') return Boolean(c.ttsKey.trim() && secureEndpoint(c.ttsUrl));
      return false;
    },
    voiceActive() {
      return !this.voiceOff && this.voiceReady();
    },
    llmReady() {
      const c = this.cfg;
      return c.llm === 'openai' && Boolean(c.llmKey.trim() && secureEndpoint(c.llmUrl));
    },
    llmActive() {
      return !this.llmOff && this.llmReady();
    },
    anyKey() {
      return this.voiceReady() || this.llmReady();
    },
    /** A page-reader key in use: 'jina' or 'tinyfish' (the page address goes there, with your key), else ''. */
    readerKind() {
      const c = this.cfg;
      if (c.reader === 'jina' && c.jinaKey.trim()) return 'jina';
      if (c.reader === 'tinyfish' && c.tinyfishKey.trim()) return 'tinyfish';
      return '';
    },
    readerHost() {
      const k = this.readerKind();
      return k === 'jina' ? 'r.jina.ai' : k === 'tinyfish' ? 'api.fetch.tinyfish.ai' : '';
    },
    /** One page through your reader key: r.jina.ai (POST { url }) or TinyFish Fetch (POST { urls, format }). */
    reader(kind, url, signal) {
      const c = this.cfg;
      if (kind === 'jina') return this.post(JINA, { headers: { Authorization: `Bearer ${c.jinaKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: { url }, as: 'json', kind: 'reader', signal, timeout: 20000 });
      return this.post(TINYFISH, { headers: { 'X-API-Key': c.tinyfishKey.trim(), 'Content-Type': 'application/json' }, body: { urls: [url], format: 'markdown' }, as: 'json', kind: 'reader', signal, timeout: 25000 });
    },
    voiceHost() {
      return this.cfg.voice === 'fish' ? 'api.fish.audio' : hostOf(this.cfg.ttsUrl) || 'your endpoint';
    },
    llmHost() {
      return hostOf(this.cfg.llmUrl) || 'your endpoint';
    },
    voiceName() {
      const c = this.cfg;
      return c.voice === 'fish' ? `Fish Audio${c.fishModel ? ` ${c.fishModel}` : ''}` : `${c.ttsModel || 'TTS'} · ${c.ttsVoice || 'voice'}`;
    },

    /** One POST to a configured Turbo endpoint — never anywhere else, never without a key. */
    async post(url, { headers = {}, body, as = 'json', kind = 'voice', signal = null, timeout = 30000 } = {}) {
      const reader = this.readerKind();
      const allowed =
        kind === 'voice'
          ? this.voiceActive() && (url === FISH_TTS ? this.cfg.voice === 'fish' : url === this.cfg.ttsUrl.trim())
          : kind === 'reader'
            ? (url === JINA && reader === 'jina') || (url === TINYFISH && reader === 'tinyfish')
            : this.llmActive() && url === this.cfg.llmUrl.trim();
      if (!allowed) throw new Error('Turbo Engine is off (no key entered)');
      const payload = JSON.stringify(body);
      // A reader request carries only the page address: the privacy panel counts the page text sent to a cloud voice or LLM.
      if (kind !== 'reader') {
        this.bytes += payload.length;
        this.requests++;
        UI.renderStatus();
      }
      if (Host.mode === 'extension') {
        const r = await Host.request('turbo', { url, headers, body: payload, as }, timeout + 2000);
        if (!r || !r.ok) throw Object.assign(new Error(r && r.error ? r.error : 'request failed'), r && r.code ? { code: r.code, origins: r.origins || [] } : {});
        return as === 'audio' ? new Blob([r.data], { type: r.type || 'audio/mpeg' }) : r.data;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      try {
        let res;
        try {
          res = await fetch(url, { method: 'POST', headers, body: payload, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
        } catch (err) {
          if (err && err.name === 'AbortError') throw new Error('timed out');
          // A network-level failure from a web page is almost always CORS: the service does not accept browser calls.
          throw new Error(`${hostOf(url)} refused a browser request (CORS) — use the SiteVocal extension, or an endpoint that allows browsers`);
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${detail ? `: ${trimText(detail.replace(/\s+/g, ' '), 120)}` : ''}`);
        }
        return as === 'audio' ? await res.blob() : await res.json();
      } finally {
        clearTimeout(timer);
      }
    },

    /* --------------------------------------------------------------- voice */
    request(text, signal) {
      const c = this.cfg;
      if (c.voice === 'fish') {
        const body = { text, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'balanced' };
        if (c.fishVoice.trim()) body.reference_id = c.fishVoice.trim();
        return this.post(FISH_TTS, { headers: { Authorization: `Bearer ${c.fishKey.trim()}`, 'Content-Type': 'application/json', model: c.fishModel.trim() || 's2-pro' }, body, as: 'audio', signal });
      }
      const body = { model: c.ttsModel.trim() || 'gpt-4o-mini-tts', voice: c.ttsVoice.trim() || 'alloy', input: text, response_format: 'mp3' };
      return this.post(c.ttsUrl.trim(), { headers: { Authorization: `Bearer ${c.ttsKey.trim()}`, 'Content-Type': 'application/json' }, body, as: 'audio', signal });
    },
    /** An object URL with this sentence's audio; the last dozen are kept, so prefetch and replays cost nothing. */
    audioUrl(text) {
      const key = `${this.cfg.voice}|${this.cfg.fishVoice}|${this.cfg.ttsVoice}|${text}`;
      let hit = this.cache.get(key);
      if (!hit) {
        hit = this.request(text).then((blob) => {
          if (!blob || !blob.size) throw new Error('empty audio');
          return URL.createObjectURL(blob);
        });
        hit.catch(() => this.cache.delete(key));
        this.cache.set(key, hit);
        while (this.cache.size > 12) {
          const [old, p] = this.cache.entries().next().value;
          this.cache.delete(old);
          p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
        }
      }
      return hit;
    },
    prefetch(texts) {
      for (const t of texts) if (t) this.audioUrl(t).catch(() => {});
    },
    clearCache() {
      for (const p of this.cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      this.cache.clear();
    },
    /** A failed voice request: back to the on-device voice for this session, and say why. */
    voiceFailed(err) {
      this.voiceOff = true;
      this.clearCache();
      const allow = Ext.reachAction(err, () => {
        this.voiceOff = false; // allowed: the next play uses your Turbo voice again
        TurboUI.sync();
        UI.renderStatus();
      });
      UI.toast(`Turbo voice failed (${(err && err.message) || err}) — switched back to your local voice.`, { type: 'info', timeout: 6000, action: allow });
      UI.renderStatus();
    },

    /* ------------------------------------------------------------ summarizer */
    async summarize(raw) {
      const c = this.cfg;
      const lang = LANG_NAMES[String(raw.lang || 'en').slice(0, 2)] || 'the page’s language';
      const user = `${Summary.modelInput(raw, 24000)}\n\nWrite the summary in ${lang}.`;
      const reply = await this.post(c.llmUrl.trim(), { headers: { Authorization: `Bearer ${c.llmKey.trim()}`, 'Content-Type': 'application/json' }, body: { model: c.llmModel.trim() || 'gpt-4o-mini', temperature: 0.2, messages: [{ role: 'system', content: PAGE_PROMPT }, { role: 'user', content: user }] }, as: 'json', kind: 'llm', timeout: 45000 });
      const content = reply && reply.choices && reply.choices[0] && reply.choices[0].message ? String(reply.choices[0].message.content || '') : '';
      const out = pageAnswer(content);
      return out;
    },
  };

  /* -------------------------------------- ✨ Summarize Page: which summarizer writes the points
   * Order: your Turbo LLM (only with a key) → Chrome's built-in Summarizer (Gemini Nano, on this device,
   * only when already downloaded: SiteVocal never starts a multi-gigabyte download by itself) → the
   * built-in TextRank + structural summary, which is instant and always there. */
  const AiSummary = {
    state: 'unknown', // on-device: 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown'
    kind: '', // 'prompt': the browser's general model (Prompt API), told to clean the page first; 'summarizer': its Summarizer API
    via: '', // 'page' (this window) or 'extension' (panel.js, an extension page)
    timeoutMs: 30000, // the whole on-device / Turbo run; after it, the built-in summary plays

    /** A summary an engine wrote earlier is used only while that engine is still switched on. */
    allowed(ai) {
      if (!ai) return false;
      return ai.engine === 'cloud' ? Turbo.llmReady() : Turbo.cfg.onDevice;
    },

    /** The browser's general on-device model (the Prompt API: Gemini Nano in Chrome; Edge and others where they ship it). */
    lm() {
      const g = typeof self !== 'undefined' ? self : window;
      return g.LanguageModel && typeof g.LanguageModel.create === 'function' ? g.LanguageModel : null;
    },
    lmOptions(lang = 'en') {
      const l = this.LANGS.includes(lang) ? lang : 'en';
      return { expectedInputs: [{ type: 'text', languages: [l] }], expectedOutputs: [{ type: 'text', languages: [l] }] };
    },

    /** The page's own Summarizer: the standard global, or the earlier window.ai.summarizer shape. */
    api() {
      const g = typeof self !== 'undefined' ? self : window;
      if (g.Summarizer && typeof g.Summarizer.create === 'function') return { kind: 'modern', S: g.Summarizer };
      if (g.ai && g.ai.summarizer && typeof g.ai.summarizer.create === 'function') return { kind: 'legacy', S: g.ai.summarizer };
      return null;
    },
    // Languages Chrome's Summarizer reads and writes; other pages keep the built-in summary.
    LANGS: ['en', 'es', 'ja', 'de', 'fr'],
    options(lang = 'en') {
      const l = this.LANGS.includes(lang) ? lang : 'en';
      return { type: 'key-points', format: 'plain-text', length: 'medium', expectedInputLanguages: [l], outputLanguage: l };
    },
    async probe() {
      const usable = (s) => ['available', 'downloadable', 'downloading'].includes(s);
      let state = 'unavailable';
      let via = '';
      let kind = '';
      const rank = (x) => ['unavailable', 'downloadable', 'downloading', 'available'].indexOf(x);
      // The general model first: it can be told to ignore menus, names and counts before it summarizes.
      const lm = this.lm();
      if (lm) {
        try {
          state = String(await lm.availability(this.lmOptions()));
          if (usable(state)) {
            via = 'page';
            kind = 'prompt';
          } else state = 'unavailable';
        } catch {
          state = 'unavailable';
        }
      }
      const api = state === 'available' ? null : this.api();
      if (api) {
        const before = state;
        try {
          if (api.kind === 'modern') state = String(await api.S.availability(this.options()));
          else {
            const caps = await api.S.capabilities();
            state = caps && caps.available === 'readily' ? 'available' : caps && caps.available === 'after-download' ? 'downloadable' : 'unavailable';
          }
          if (rank(state) > rank(before)) {
            via = 'page';
            kind = 'summarizer';
          } else state = before;
        } catch {
          state = before;
        }
      }
      // In the extension the sandboxed studio may not reach the model itself: panel.js (an extension page) can.
      if (state !== 'available' && Host.mode === 'extension') {
        try {
          const r = await Host.request('ai:availability', { options: this.options() }, 4000);
          if (r && (r.state === 'available' || (usable(r.state) && !usable(state)))) {
            state = r.state;
            via = 'extension';
            kind = r.kind || 'summarizer';
          }
        } catch {
          /* no bridge answer: keep what the page found */
        }
      }
      this.state = usable(state) ? state : 'unavailable';
      this.kind = this.state === 'unavailable' ? '' : kind;
      this.via = this.state === 'unavailable' ? via || (Host.mode === 'extension' ? 'extension' : '') : via;
      return this.state;
    },
    /** Which engine ✨ Summarize uses right now: 'cloud', 'chrome-ai', or null for the built-in summary. */
    ready(raw = App.raw) {
      if (Turbo.llmActive()) return 'cloud';
      const lang = String((raw && raw.lang) || 'en').slice(0, 2).toLowerCase();
      if (Turbo.cfg.onDevice && this.state === 'available' && this.LANGS.includes(lang)) return 'chrome-ai';
      return null;
    },
    label(engine) {
      return engine === 'cloud' ? `Your Turbo summarizer (${Turbo.llmHost()})` : engine === 'chrome-ai' ? 'Chrome’s on-device AI' : 'The built-in summarizer';
    },
    engineName(S) {
      if (!S || S.engine === 'textrank') return 'Built-in · TextRank';
      return S.engine === 'cloud' ? `Turbo · ${S.model || 'LLM'}` : 'Chrome on-device AI';
    },
    timeout(promise, ms, what = 'summarizer') {
      return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), Math.max(1, ms)))]);
    },

    /** A few key points for the whole page from the chosen engine; null when nothing useful came back (→ built-in summary). */
    async run(raw, engine, { timeout = 30000 } = {}) {
      const sections = Summary.aiInput(raw).slice(0, 12);
      if (!sections.length) return null;
      const out = { v: 2, engine, model: '', at: Date.now(), overview: '', points: [] };
      if (engine === 'cloud') {
        try {
          const r = await this.timeout(Turbo.summarize(raw, sections), timeout + 15000, 'the Turbo summarizer');
          out.model = Turbo.cfg.llmModel;
          out.overview = r.overview;
          out.points = r.points;
        } catch (err) {
          Turbo.llmOff = true;
          throw err;
        }
      } else {
        const lang = String(raw.lang || 'en').slice(0, 2).toLowerCase();
        if (this.kind === 'prompt') {
          // The general model: the whole page as the tab shows it, cleaned and summarized in one answer.
          const text = `${Summary.modelInput(raw, 12000)}\n\nWrite the summary in ${LANG_NAMES[lang] || 'English'}.`;
          const content = this.via === 'extension' ? await Host.request('ai:prompt', { system: PAGE_PROMPT, text, schema: PAGE_SCHEMA, lang, timeout }, timeout + 3000) : await this.prompt(text, lang, timeout);
          const a = pageAnswer(content);
          out.overview = a.overview;
          out.points = a.points;
          return out.points.length ? out : null;
        }
        // One request for the whole page (its opening first), so the points summarize the page, not each section.
        const context = `The web page "${raw.title || ''}" from ${raw.siteName || raw.hostname || 'a website'}.`;
        let whole = '';
        for (const s of sections) {
          if (whole.length >= 6000) break;
          whole += `${whole ? '\n\n' : ''}${s.text.slice(0, 6000 - whole.length)}`;
        }
        let results;
        if (this.via === 'extension') results = await Host.request('ai:summarize', { options: { ...this.options(lang), sharedContext: context }, texts: [whole], contexts: [context], timeout }, timeout + 3000);
        else results = await this.local([whole], [context], context, timeout, lang);
        out.points = typeof (results || [])[0] === 'string' ? Summary.points(results[0]).slice(0, 5) : [];
      }
      return out.points.length ? out : null;
    },

    /** One answer from the general model in this window (the web app). */
    async prompt(text, lang, timeout) {
      const lm = this.lm();
      if (!lm) throw new Error('no on-device model');
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), Math.max(1000, timeout));
      const session = await this.timeout(lm.create({ ...this.lmOptions(lang), initialPrompts: [{ role: 'system', content: PAGE_PROMPT }], ...(ctrl ? { signal: ctrl.signal } : {}) }), 8000, 'starting the on-device model');
      try {
        let input = text;
        // Keep within what the model can read at once (its input quota), cutting from the end of the page.
        if (typeof session.measureInputUsage === 'function' && session.inputQuota) {
          for (let i = 0; i < 6 && (await session.measureInputUsage(input)) > (session.inputQuota - (session.inputUsage || 0)) * 0.9; i++) input = input.slice(0, Math.floor(input.length * 0.7));
        }
        return await this.timeout(session.prompt(input, { responseConstraint: PAGE_SCHEMA, ...(ctrl ? { signal: ctrl.signal } : {}) }), timeout, 'the on-device model');
      } finally {
        clearTimeout(timer);
        if (typeof session.destroy === 'function') session.destroy();
      }
    },

    async local(texts, contexts, sharedContext, timeout, lang = 'en') {
      const api = this.api();
      if (!api) throw new Error('no on-device summarizer');
      const started = performance.now();
      const summarizer = await this.timeout(api.S.create({ ...this.options(lang), sharedContext }), 8000, 'starting the on-device model');
      const out = [];
      try {
        for (let i = 0; i < texts.length; i++) {
          const left = timeout - (performance.now() - started);
          if (left <= 0) break;
          try {
            out.push(await this.timeout(summarizer.summarize(texts[i], { context: contexts[i] }), left));
          } catch (err) {
            if (!out.length) throw err;
            break; // keep what is done; the rest falls back to the built-in summary
          }
        }
      } finally {
        if (summarizer && typeof summarizer.destroy === 'function') summarizer.destroy();
      }
      return out;
    },

    /** Docs → "Download Chrome's on-device summarizer": only on a click (Chrome requires the gesture). */
    async download(onProgress) {
      // In the extension the side panel's page downloads it (a click in the studio counts as the gesture there).
      if (Host.mode === 'extension' && (this.via === 'extension' || !this.lm())) {
        await Host.request('ai:download', { lang: 'en' }, 45 * 60 * 1000);
        return this.probe();
      }
      const lm = this.lm();
      if (lm) {
        const session = await lm.create({ ...this.lmOptions(), monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.loaded)) });
        if (session && typeof session.destroy === 'function') session.destroy();
        return this.probe();
      }
      const api = this.api();
      if (!api || api.kind !== 'modern') throw new Error('this browser has no built-in AI model');
      const s = await api.S.create({ ...this.options(), monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.loaded)) });
      if (s && typeof s.destroy === 'function') s.destroy();
      return this.probe();
    },
  };
  /* --------------------------------------------- media keys / media session */
  const MediaKeys = {
    audio: null,
    actions: {},
    supported: 'mediaSession' in navigator,
    keepAlive: !/iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    setup(actions) {
      this.actions = actions;
      if (!this.supported) return;
      for (const [action, fn] of Object.entries(actions)) {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch {
          /* action unsupported in this browser */
        }
      }
    },
    /** Lock screen / media hub: article title, the site's name and its logo (SiteVocal's own mark as a fallback). */
    metadata(raw) {
      if (!this.supported || typeof window.MediaMetadata !== 'function') return;
      try {
        const art = (raw.logos || [])
          .filter((u) => /^https?:/.test(u))
          .slice(0, 2)
          .map((src, i) => ({ src, sizes: i ? '128x128' : '192x192' }));
        if (/^https?:/.test(location.href)) art.push({ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' });
        navigator.mediaSession.metadata = new MediaMetadata({ title: raw.title, artist: raw.siteName || siteLabel(raw.hostname), album: `SiteVocal · ${raw.hostname ? bareHost(raw.hostname) : 'Pasted text'}`, artwork: art });
      } catch {
        /* invalid artwork */
      }
    },
    /** Position on the lock-screen scrubber. */
    position(duration, position) {
      if (!this.supported || typeof navigator.mediaSession.setPositionState !== 'function') return;
      try {
        if (duration > 0 && Number.isFinite(duration)) navigator.mediaSession.setPositionState({ duration, position: clamp(position, 0, duration), playbackRate: 1 });
      } catch {
        /* unsupported values */
      }
    },
    /** A silent ≥5 s loop keeps an active media session so keyboard media keys and headset buttons reach SiteVocal. */
    state(playing) {
      if (!this.supported) return;
      try {
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      } catch {
        /* read-only in this browser */
      }
      if (!this.keepAlive) return;
      if (playing) {
        if (!this.audio) {
          this.audio = new Audio(this.silence());
          this.audio.loop = true;
        }
        this.audio.play().catch(() => {});
      } else if (this.audio) {
        this.audio.pause();
      }
    },
    silence(seconds = 6, rate = 8000) {
      const n = seconds * rate;
      const buf = new ArrayBuffer(44 + n);
      const v = new DataView(buf);
      const str = (o, s) => {
        for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      v.setUint32(4, 36 + n, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint32(28, rate, true);
      v.setUint16(32, 1, true);
      v.setUint16(34, 8, true);
      str(36, 'data');
      v.setUint32(40, n, true);
      new Uint8Array(buf, 44).fill(128);
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    },
  };

  /* ------------------------------------------------------------- rendering */
  // Direction of a run of text: right-to-left when most of its letters are from an RTL script.
  const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/gu;
  function textDir(s) {
    const t = String(s || '');
    const letters = (t.match(/\p{L}/gu) || []).length;
    return letters && (t.match(RTL_LETTER) || []).length / letters >= 0.4 ? 'rtl' : 'ltr';
  }

  function logoMarkup(logos, label, cls = '') {
    const list = (logos || []).map((u) => safeImageUrl(u)).filter(Boolean);
    const letter = esc(String(label || '?').trim().charAt(0).toUpperCase() || '?');
    if (!list.length) return `<span class="sv-logo is-letter ${cls}" data-letter="${letter}"></span>`;
    return `<span class="sv-logo ${cls}" data-letter="${letter}"><img src="${esc(list[0])}" data-fallbacks="${esc(JSON.stringify(list.slice(1)))}" alt="" referrerpolicy="no-referrer" decoding="async"></span>`;
  }

  function nextLogo(img) {
    let rest = [];
    try {
      rest = JSON.parse(img.dataset.fallbacks || '[]');
    } catch {
      rest = [];
    }
    if (rest.length) {
      img.dataset.fallbacks = JSON.stringify(rest.slice(1));
      img.src = rest[0];
    } else {
      const holder = img.parentElement;
      img.remove();
      if (holder) holder.classList.add('is-letter');
    }
  }

  /** Copy text: the async Clipboard API first, then the legacy path that also works inside sandboxed frames. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* blocked: fall back below */
    }
    const prev = document.activeElement;
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    } finally {
      if (prev && typeof prev.focus === 'function' && prev !== document.body) prev.focus({ preventScroll: true });
    }
  }

  /** A clipped quote as plain text with its source, ready to paste anywhere. */
  function clipCitation(c) {
    const source = [c.title, c.site && c.site !== c.title ? c.site : ''].filter(Boolean).join(', ');
    return `${quoted(c.text)}\n— ${source}${c.url ? `\n${c.url}` : ''}`;
  }

  /** A sentence in display quotes, once: “…” — unless it already carries its own quotation marks. */
  function quoted(text) {
    const t = String(text || '').trim();
    const pair = t.match(/^["“„«]([\s\S]*)["”»]$/);
    if (pair && !/["“”„«»]/.test(pair[1])) return `“${pair[1].trim()}”`;
    if (/^["“”„«»]|["“”„«»]$/.test(t)) return t;
    return `“${t}”`;
  }

  /** "65% listened — Paragraph 12" for a library entry. */
  function progressLabel(e) {
    if (e.completed) return 'Finished · listen again';
    const progress = e.progress || 0;
    if (progress <= 0) return 'Not started yet';
    const pct = Math.round(progress * 100);
    const where = e.mode === 'briefing' ? (e.paragraph > 0 ? `Briefing · Part ${e.paragraph}` : 'Briefing intro') : e.mode === 'summary' ? (e.paragraph > 0 ? `Summary · Part ${e.paragraph}` : 'Summary intro') : e.paragraph > 0 ? `Paragraph ${e.paragraph}` : 'Intro';
    return `${pct < 1 ? '<1' : pct}% listened — ${where}`;
  }

  /** Map a speech character index back onto the displayed sentence (expansions shift it slightly). */
  function mapWord(text, ch, speechIndex) {
    if (ch.ce <= ch.cs || ch.end <= ch.start) return null;
    const rel = speechIndex - ch.cs;
    if (rel < 0 || speechIndex >= ch.ce) return null;
    const sentence = text.slice(ch.start, ch.end);
    let pos = Math.round((rel * sentence.length) / (ch.ce - ch.cs));
    pos = clamp(pos, 0, sentence.length - 1);
    while (pos < sentence.length && /\s/.test(sentence[pos])) pos++;
    while (pos > 0 && /\S/.test(sentence[pos - 1])) pos--;
    let end = pos;
    while (end < sentence.length && /\S/.test(sentence[end])) end++;
    while (end > pos && /[.,;:!?)"'”’\]]/.test(sentence[end - 1])) end--;
    while (pos < end && /["'“‘(\[]/.test(sentence[pos])) pos++;
    return end > pos ? [pos, end] : null;
  }

  /* --------------------------------------------- landing: the sound-ripple field
   * Behind the hero sits a page of text seen out of focus — rows of faint dots. Rings ripple out from the
   * pointer (and, when you are idle, from the command bar) and, as each one passes, the dots resolve into
   * emerald letters: text turning into sound. One canvas at ~30 fps, glyphs blitted from a pre-rendered
   * atlas, kept clear behind the headline. It stops whenever the landing is hidden, scrolled away or the
   * tab is in the background, and paints one still frame under prefers-reduced-motion. */
  const FIELD_TEXT = 'siteVocal strips the ads and clutter out of any article then reads it aloud with the most natural voice on your device · zero api keys · no account · no server · ';
  const FIELD_SCRAMBLE = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const FIELD_INK = ['4, 120, 87', '122, 28, 36', '11, 13, 14'];

  const Field = {
    canvas: null,
    ctx: null,
    host: null,
    stage: null,
    ready: false,
    running: false,
    inView: true,
    raf: 0,
    last: 0,
    w: 0,
    h: 0,
    dpr: 1,
    cw: 7,
    ch: 15,
    cols: 0,
    rows: 0,
    glyphs: '',
    cells: null,
    tint: null,
    atlas: null,
    base: null,
    rings: [],
    shape: 0,
    solid: [],
    lastSpawn: -1e9,
    lastPointer: -1e9,
    lastX: -1e4,
    lastY: -1e4,
    spawnX: 0,
    spawnY: 0,
    quiet: null,
    tick: 0,

    init(canvas, host) {
      if (!canvas || !canvas.getContext || typeof ResizeObserver === 'undefined') return;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) return;
      this.canvas = canvas;
      this.host = host;
      this.stage = canvas.parentElement;
      this.stage.addEventListener('pointermove', (ev) => this.pointer(ev, false), { passive: true });
      this.stage.addEventListener('pointerdown', (ev) => this.pointer(ev, true), { passive: true });
      new ResizeObserver(() => this.layout()).observe(this.stage);
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((list) => {
          this.inView = list.some((x) => x.isIntersecting);
          this.sync();
        }).observe(this.stage);
      }
      document.addEventListener('visibilitychange', () => this.sync());
      const go = () => {
        this.ready = true;
        this.layout();
        this.sync();
      };
      const font = document.fonts && document.fonts.load ? document.fonts.load('500 11px "JetBrains Mono"').catch(() => null) : null;
      Promise.race([font, new Promise((r) => setTimeout(r, 1200))]).then(go, go);
    },

    /** Grid of glyph cells sized to the stage: the field reads like rows of real text. */
    layout() {
      if (!this.ready) return;
      const rect = this.stage.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.measure();
      if (w === this.w && h === this.h && dpr === this.dpr && this.base) return;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      const size = w < 640 ? 10 : 11;
      this.font = `500 ${size}px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace`;
      this.bold = `700 ${size}px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace`;
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = this.font;
      this.cw = Math.max(5.5, Math.round((ctx.measureText('M').width + 1.1) * 10) / 10);
      this.ch = Math.round(size * 1.3);
      this.cols = Math.ceil(w / this.cw) + 1;
      this.rows = Math.ceil(h / this.ch) + 1;
      this.glyphs = [...new Set(`${FIELD_TEXT}${FIELD_SCRAMBLE}•`)].join('');
      this.dot = this.glyphs.indexOf('•');
      const index = new Map([...this.glyphs].map((c, i) => [c, i]));
      this.solid = [...this.glyphs].map((c, i) => (c === ' ' || c === '•' || c === '·' ? -1 : i)).filter((i) => i >= 0);
      const n = this.cols * this.rows;
      this.cells = new Uint8Array(n);
      this.tint = new Uint8Array(n);
      for (let y = 0; y < this.rows; y++) {
        const off = (y * 41) % FIELD_TEXT.length;
        for (let x = 0; x < this.cols; x++) {
          const k = y * this.cols + x;
          this.cells[k] = index.get(FIELD_TEXT[(off + x) % FIELD_TEXT.length]);
          // ~4% of the field answers in burgundy — the brand's 3% accent, scattered.
          this.tint[k] = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) % 97 < 4 ? 1 : 0;
        }
      }
      this.buildAtlas();
      this.buildBase();
      if (reducedMotion()) this.still();
    },

    /** Where the idle pulse starts (the command bar) and where rings dim (behind the headline). */
    measure() {
      if (!this.stage) return;
      const s = this.stage.getBoundingClientRect();
      const bar = this.stage.querySelector('.sv-command');
      const title = this.stage.querySelector('.sv-hero-title');
      const sub = this.stage.querySelector('.sv-hero-sub');
      if (bar) {
        const b = bar.getBoundingClientRect();
        this.spawnX = b.left - s.left + b.width / 2;
        this.spawnY = b.top - s.top + b.height / 2;
      }
      if (title && sub) {
        const t = title.getBoundingClientRect();
        const u = sub.getBoundingClientRect();
        const c = bar ? bar.getBoundingClientRect() : u;
        this.quiet = { x0: Math.min(t.left, u.left, c.left) - s.left - 8, x1: Math.max(t.right, u.right, c.right) - s.left + 8, y0: t.top - s.top - 6, y1: c.bottom - s.top + 4 };
      }
    },

    buildAtlas() {
      const { dpr, cw, ch } = this;
      const atlas = document.createElement('canvas');
      atlas.width = Math.ceil(this.glyphs.length * cw * dpr);
      atlas.height = Math.ceil(FIELD_INK.length * ch * dpr);
      const a = atlas.getContext('2d');
      a.scale(dpr, dpr);
      a.font = this.font;
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      FIELD_INK.forEach((rgb, row) => {
        a.font = row < 2 ? this.bold : this.font;
        a.fillStyle = `rgb(${rgb})`;
        for (let i = 0; i < this.glyphs.length; i++) a.fillText(this.glyphs[i], i * cw + cw / 2, row * ch + ch / 2 + 0.5);
      });
      this.atlas = atlas;
    },

    blit(ctx, glyph, row, x, y, scale = 1) {
      const { dpr, cw, ch } = this;
      const w = cw * scale;
      const h = ch * scale;
      ctx.drawImage(this.atlas, glyph * cw * dpr, row * ch * dpr, cw * dpr, ch * dpr, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
    },

    /** 1 outside the headline block, easing to 0 inside it — nothing ripples behind the words. */
    clear(cx, cy, soft) {
      const q = this.quiet;
      if (!q) return 1;
      const dx = Math.max(q.x0 - cx, 0, cx - q.x1);
      const dy = Math.max(q.y0 - cy, 0, cy - q.y1);
      return Math.min(1, Math.hypot(dx, dy) / soft);
    },

    /** The resting page of faint letters, rendered once per size — and kept clear behind the headline. */
    buildBase() {
      const base = document.createElement('canvas');
      base.width = this.canvas.width;
      base.height = this.canvas.height;
      const b = base.getContext('2d');
      b.scale(this.dpr, this.dpr);
      const space = this.glyphs.indexOf(' ');
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          const g = this.cells[y * this.cols + x];
          if (g === space) continue;
          const a = 0.14 * this.clear(x * this.cw + this.cw / 2, y * this.ch + this.ch / 2, 140);
          if (a < 0.01) continue;
          b.globalAlpha = a;
          this.blit(b, this.dot, 2, x * this.cw, y * this.ch, 0.9);
        }
      }
      this.base = base;
    },

    pointer(ev, strong) {
      if (!this.running) return;
      const s = this.stage.getBoundingClientRect();
      const x = ev.clientX - s.left;
      const y = ev.clientY - s.top;
      const now = performance.now();
      this.lastPointer = now;
      const moved = Math.hypot(x - this.lastX, y - this.lastY);
      if (!strong && (now - this.lastSpawn < 560 || moved < 36)) return;
      this.spawn(x, y, strong ? 1 : 0.85, now);
    },

    spawn(x, y, amp, now) {
      // Mostly circles; every third ripple is a rounded square, the shape of the logo's frame.
      this.shape = (this.shape + 1) % 3;
      const shape = this.shape === 2 ? 1 : 0;
      this.lastSpawn = now;
      this.lastX = x;
      this.lastY = y;
      this.rings.push({ x, y, born: now, amp, shape, band: 38, speed: 0.27, life: 3400 });
      this.rings.push({ x, y, born: now + 300, amp: amp * 0.6, shape, band: 20, speed: 0.27, life: 2900 });
      while (this.rings.length > 8) this.rings.shift();
    },

    sync() {
      const show = this.ready && !document.hidden && this.inView && this.host && !this.host.hidden && UI.tab === 'studio';
      const want = show && !reducedMotion();
      if (show && !want) this.still();
      if (want && !this.running) {
        this.running = true;
        this.last = 0;
        if (!this.rings.length) this.spawn(this.spawnX || this.w / 2, this.spawnY || this.h / 2, 0.8, performance.now() + 350);
        this.raf = requestAnimationFrame((t) => this.frame(t));
      } else if (!want && this.running) {
        this.running = false;
        cancelAnimationFrame(this.raf);
      }
    },

    frame(now) {
      if (!this.running) return;
      this.raf = requestAnimationFrame((t) => this.frame(t));
      if (now - this.last < 32) return;
      this.last = now;
      if (now - this.lastPointer > 2600 && now - this.lastSpawn > 3400) this.spawn(this.spawnX, this.spawnY, 0.75, now);
      this.paint(now);
    },

    /** Brightness of one cell: the strongest ring passing through it (circle or rounded square). */
    paint(now) {
      const { ctx, cw, ch, cols, rows, dpr } = this;
      if (!this.base) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const maxR = Math.hypot(this.w, this.h);
      const live = [];
      this.rings = this.rings.filter((ring) => {
        const age = now - ring.born;
        const r = age * ring.speed;
        if (age > ring.life || r - ring.band > maxR) return false;
        if (age > 0) live.push({ ...ring, r, a: ring.amp * Math.min(1, age / 140) * (1 - age / ring.life) ** 1.35 });
        return true;
      });
      if (!live.length) return;
      const space = this.glyphs.indexOf(' ');
      const tickNo = ++this.tick;
      for (let y = 0; y < rows; y++) {
        const cy = y * ch + ch / 2;
        for (let x = 0; x < cols; x++) {
          const cx = x * cw + cw / 2;
          let v = 0;
          for (let i = 0; i < live.length; i++) {
            const L = live[i];
            const dx = cx - L.x;
            const dy = cy - L.y;
            const d = L.shape ? Math.sqrt(Math.sqrt(dx * dx * dx * dx + dy * dy * dy * dy)) * 1.08 : Math.sqrt(dx * dx + dy * dy);
            const off = Math.abs(d - L.r);
            if (off >= L.band) continue;
            const c = Math.cos((off / L.band) * 1.5708);
            const val = Math.min(1, c * c * 1.25) * L.a;
            if (val > v) v = val;
          }
          if (v < 0.05) continue;
          v *= this.clear(cx, cy, 90);
          if (v < 0.05) continue;
          const k = y * cols + x;
          if (v < 0.32) {
            // The wave front: dots swell and turn emerald before they resolve into letters.
            ctx.globalAlpha = 0.2 + 1.4 * v;
            this.blit(ctx, this.dot, this.tint[k], x * cw, y * ch, 0.9 + v * 1.6);
            continue;
          }
          let g = this.cells[k];
          if (g === space || (v > 0.75 && (k + tickNo) % 31 === 0)) g = this.solid[(k * 7 + (tickNo >> 2)) % this.solid.length];
          ctx.globalAlpha = Math.min(0.92, 0.18 + 0.8 * v);
          this.blit(ctx, g, this.tint[k], x * cw, y * ch);
        }
      }
      ctx.globalAlpha = 1;
    },

    /** prefers-reduced-motion: one calm, frozen ripple around the command bar. */
    still() {
      if (!this.base) return;
      const t = performance.now();
      this.rings = [{ x: this.spawnX, y: this.spawnY, born: t - 1000, amp: 0.75, shape: 1, band: 24, speed: 0.3, life: 1e9 }];
      this.paint(t);
      this.rings = [];
    },
  };

  /* --------------------------------- landing: "What users reported" switchboard */
  // Six reported pain points as tabs; the stage shows what other readers speak (raw DOM) and what SiteVocal
  // speaks (cleaned locally). The active switch's hairline is a 6 s CSS animation: hover, focus, scrolling
  // away or a hidden tab pause it, and when it completes the board moves on. A click takes manual control.
  const Switchboard = {
    root: null,
    tabs: [],
    panels: [],
    index: 0,
    auto: true,
    utter: null,

    init() {
      const root = document.getElementById('switchboard');
      if (!root) return;
      this.root = root;
      this.tabs = Array.from(root.querySelectorAll('[role="tab"]'));
      this.panels = Array.from(root.querySelectorAll('[role="tabpanel"]'));
      this.autoBtn = document.getElementById('sbAuto');
      if (reducedMotion()) {
        this.autoBtn.hidden = true;
        this.setAuto(false);
      }
      root.addEventListener('click', (ev) => {
        const tab = ev.target.closest('[role="tab"]');
        if (tab) {
          this.setAuto(false);
          this.select(this.tabs.indexOf(tab));
        } else if (ev.target.closest('[data-sb-hear]')) this.hear();
      });
      root.querySelector('[role="tablist"]').addEventListener('keydown', (ev) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
        let i = null;
        if (step) i = (this.index + step + this.tabs.length) % this.tabs.length;
        else if (ev.key === 'Home') i = 0;
        else if (ev.key === 'End') i = this.tabs.length - 1;
        if (i === null) return;
        ev.preventDefault();
        this.setAuto(false);
        this.select(i);
        this.tabs[i].focus();
      });
      root.addEventListener('animationend', (ev) => {
        if (ev.target.classList.contains('sv-sb-timer') && this.auto && !reducedMotion()) this.select((this.index + 1) % this.tabs.length);
      });
      this.autoBtn.addEventListener('click', () => this.setAuto(!this.auto));
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(([entry]) => root.classList.toggle('is-away', !entry.isIntersecting), { threshold: 0.25 }).observe(root);
      }
      document.addEventListener('visibilitychange', () => root.classList.toggle('is-tab-hidden', document.hidden));
    },

    select(i) {
      if (i < 0 || i >= this.tabs.length) return;
      this.stop();
      this.index = i;
      this.tabs.forEach((tab, k) => {
        tab.setAttribute('aria-selected', String(k === i));
        tab.tabIndex = k === i ? 0 : -1;
      });
      this.panels.forEach((panel, k) => {
        panel.hidden = k !== i;
        panel.classList.remove('is-scanning');
      });
      const panel = this.panels[i];
      void panel.offsetWidth; // restart the strike-and-scan animation
      panel.classList.add('is-scanning');
      // Narrow screens: the switches are one scrolling row; keep the active one in view (never the page).
      const strip = this.tabs[i].parentElement;
      if (strip.scrollWidth > strip.clientWidth + 2) strip.scrollTo({ left: this.tabs[i].offsetLeft - strip.offsetLeft, behavior: reducedMotion() ? 'auto' : 'smooth' });
    },

    setAuto(on) {
      this.auto = on;
      this.root.dataset.auto = on ? 'on' : 'off';
      this.autoBtn.setAttribute('aria-pressed', String(on));
    },

    /** "Hear SiteVocal's Fix": speak the cleaned sample with the reader's own voice and speed. */
    hear() {
      if (this.utter) {
        this.stop();
        return;
      }
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
        UI.toast('This browser has no speech engine, so SiteVocal can’t speak here.', { type: 'error' });
        return;
      }
      if (Engine.state === 'playing') Engine.pause();
      synth.cancel();
      const text = this.panels[this.index].querySelector('.sv-sb-clean-text').textContent.replace(/\s+/g, ' ').trim();
      const u = new SpeechSynthesisUtterance(text);
      const voice = Engine.voice || Voices.resolve(Settings.data.voiceURI, 'en');
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = Settings.data.rate || 1;
      const done = () => {
        if (this.utter !== u) return;
        this.utter = null;
        this.paint();
      };
      u.onend = done;
      u.onerror = done;
      this.utter = u;
      this.setAuto(false);
      this.paint();
      synth.speak(u);
    },

    stop() {
      if (!this.utter) return;
      this.utter = null;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      this.paint();
    },

    paint() {
      const speaking = Boolean(this.utter);
      for (const btn of this.root.querySelectorAll('[data-sb-hear]')) {
        btn.innerHTML = speaking ? `${icon('pause', 'sv-filled size-4')}<span>Stop</span>` : `${icon('play', 'sv-filled size-4')}<span>Hear SiteVocal’s Fix</span>`;
      }
    },
  };

  const UI = {
    els: {},
    segEls: [],
    activeSeg: -1,
    activeChunk: -1,
    wordKey: '',
    follow: true,
    userScrollAt: 0,
    lastPulse: 0,
    tabInfo: null,
    clearArmed: 0,
    tab: 'studio',
    tabScroll: {},
    outlineEls: [],
    activeSection: -1,
    outlineOpenSet: null,
    wordsShown: -1,

    init() {
      const ids = [
        'scroller', 'landing', 'studio', 'identity', 'prompter', 'loadingCard', 'errorCard', 'tapToPlay', 'btnTap', 'statusRow', 'statusPara', 'statusPct', 'statusSaved',
        'btnFollow', 'transport', 'progress', 'progressFill', 'progressThumb', 'progressTip', 'tElapsed', 'tRemain', 'npInfo', 'npLogo', 'npTitle', 'npSite',
        'btnPrev', 'btnPlay', 'btnNext', 'wave', 'rateSel', 'voiceSel', 'library', 'libList', 'libEmpty', 'libEmptyText', 'libSearch', 'libCount', 'btnLibrary',
        'btnLibClose', 'btnLibClear', 'libOverlay', 'heroForm', 'heroUrl', 'heroSubmit', 'navForm', 'navUrl', 'btnNew', 'btnReread', 'navStage', 'btnHelp', 'btnHelpClose', 'helpDialog',
        'btnPasteToggle', 'pasteForm', 'pasteText', 'pasteTitle', 'toasts', 'tabCard', 'recentWrap', 'recentList', 'btnRecentAll', 'btnPopout', 'brandHome',
        'versionTag', 'modeTag',
        'tabStudio', 'tabSaved', 'tabDocs', 'panelStudio', 'panelSaved', 'panelDocs', 'queueCount', 'devtools', 'devBadges', 'domChanged', 'outline', 'outlineList',
        'outlineMeta', 'clipBtn', 'savedGrid', 'savedEmpty', 'savedSearch', 'savedCount', 'queueList', 'queueEmpty', 'queueForm', 'queueUrl', 'autoAdvance',
        'btnQueueClear', 'clipList', 'clipEmpty', 'btnClipsCopy', 'btnClipsClear', 'lexForm', 'lexFrom', 'lexTo', 'lexList', 'lexCount', 'btnLexReset', 'lexTest',
        'lexPreview', 'lexState', 'btnLexHear', 'btnCopyExt', 'statusBar', 'stCloud', 'stWords', 'stAds', 'stEngine', 'stAccess', 'btnPrivacy', 'heroField',
        'filterMore',
      ];
      for (const id of ids) this.els[id] = document.getElementById(id);
      const e = this.els;
      e.versionTag.textContent = VERSION;
      e.modeTag.textContent = Host.mode === 'extension' ? `Chrome extension · ${Host.surface}` : 'web app';
      e.stEngine.textContent = `Web Speech API · SiteVocal ${VERSION}`;
      e.rateSel.innerHTML = RATES.map((r) => `<option value="${r}">${r}×</option>`).join('');
      e.rateSel.value = String(Settings.data.rate);
      e.wave.innerHTML = Array.from({ length: 18 }, (_, i) => `<span style="--d:${(-((i * 0.137) % 1)).toFixed(3)}s;--dur:${(0.7 + ((i * 37) % 23) / 40).toFixed(2)}s;--h:${(0.45 + ((i * 53) % 47) / 90).toFixed(2)}"></span>`).join('');
      e.autoAdvance.checked = Settings.data.autoAdvance;
      this.syncSidebar();
      this.syncFilters();

      const submit = (value) => {
        const text = String(value || '').trim();
        if (!text) {
          this.toast('Paste a website URL first — or try one of the quick demos.', { type: 'info' });
          return;
        }
        if (document.activeElement) document.activeElement.blur();
        if (normalizeUrl(text)) {
          App.openUrl(text);
        } else if (text.split(/\s+/).length > 12) {
          App.openText(text, '');
        } else {
          this.toast('That doesn’t look like a web address. Try something like en.wikipedia.org/wiki/Radio', { type: 'error' });
        }
      };
      e.heroForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        submit(e.heroUrl.value);
      });
      e.navForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        submit(e.navUrl.value);
      });
      document.querySelectorAll('[data-demo]').forEach((btn) =>
        btn.addEventListener('click', () => {
          btn.blur();
          App.openUrl(DEMOS[btn.dataset.demo], { mode: btn.dataset.demo === 'company' ? 'briefing' : null });
        }),
      );
      this.wirePrefetch();
      e.btnPasteToggle.addEventListener('click', () => {
        e.pasteForm.hidden = !e.pasteForm.hidden;
        e.btnPasteToggle.setAttribute('aria-expanded', String(!e.pasteForm.hidden));
        if (!e.pasteForm.hidden) e.pasteText.focus();
      });
      e.pasteForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const text = e.pasteText.value.trim();
        if (countWords(text) < 3) {
          this.toast('Paste a few sentences to read aloud.', { type: 'info' });
          return;
        }
        if (document.activeElement) document.activeElement.blur();
        App.openText(text, e.pasteTitle.value);
      });

      /* ------------------------------------------------ tabs */
      const tabs = [e.tabStudio, e.tabSaved, e.tabDocs];
      for (const t of tabs) t.addEventListener('click', () => this.setTab(t.dataset.tab));
      e.tabStudio.parentElement.addEventListener('keydown', (ev) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const j = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[ev.key];
        if (j === undefined) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.setTab(tabs[j].dataset.tab, { focus: true });
      });

      /* ------------------------------------------- saved sites */
      e.btnLibrary.addEventListener('click', () => this.toggleLibrary());
      e.btnLibClose.addEventListener('click', () => this.toggleLibrary(false));
      e.libOverlay.addEventListener('click', () => this.toggleLibrary(false));
      e.btnRecentAll.addEventListener('click', () => this.setTab('saved'));
      e.libSearch.addEventListener('input', () => this.renderLibrary());
      e.savedSearch.addEventListener('input', () => this.renderSaved());
      this.armed(e.btnLibClear, 'Clear all', () => {
        if (!Library.entries.length) return false;
        Library.clear();
        this.renderLibrary();
        this.toast('Library cleared.', { type: 'success' });
        return true;
      });
      const openCard = (target) => {
        const del = target.closest('[data-del]');
        if (del) {
          const entry = Library.get(del.dataset.del);
          Library.remove(del.dataset.del);
          this.renderLibrary();
          if (entry) this.toast(`Removed “${trimText(entry.title, 40)}”.`, { type: 'info' });
          return true;
        }
        const queue = target.closest('[data-queue]');
        if (queue) {
          App.toggleQueue(queue.dataset.queue);
          return true;
        }
        const card = target.closest('[data-id]');
        if (!card) return false;
        if (window.matchMedia && !window.matchMedia('(min-width: 1024px)').matches) this.toggleLibrary(false);
        App.openEntry(card.dataset.id);
        return true;
      };
      for (const list of [e.libList, e.recentList, e.savedGrid]) {
        list.addEventListener('click', (ev) => openCard(ev.target));
        list.addEventListener('keydown', (ev) => {
          if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-id]')) {
            ev.preventDefault();
            openCard(ev.target);
          }
        });
      }
      e.queueList.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-qact]');
        const row = ev.target.closest('[data-key]');
        if (!btn || !row) return;
        const { key } = row.dataset;
        const act = btn.dataset.qact;
        if (act === 'play') App.playQueued(key);
        else if (act === 'up' || act === 'down') Queue.move(key, act === 'up' ? -1 : 1);
        else if (act === 'remove') Queue.remove(key);
        this.renderQueue();
        this.renderSavedGrid();
      });
      e.queueForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const url = normalizeUrl(e.queueUrl.value);
        if (!url) {
          this.toast('Enter a valid http(s) address to add to Up Next.', { type: 'error' });
          return;
        }
        App.queueUrl(url);
        e.queueUrl.value = '';
      });
      e.autoAdvance.addEventListener('change', () => Settings.set({ autoAdvance: e.autoAdvance.checked }));
      this.armed(e.btnQueueClear, 'Clear', () => {
        if (!Queue.list().length) return false;
        Queue.clear();
        this.renderQueue();
        this.renderSavedGrid();
        return true;
      });
      e.clipList.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-cact]');
        const row = ev.target.closest('[data-clip]');
        if (!btn || !row) return;
        const clip = Clips.list().find((c) => c.id === row.dataset.clip);
        if (!clip) return;
        const act = btn.dataset.cact;
        if (act === 'copy') {
          const ok = await copyText(clipCitation(clip));
          this.toast(ok ? 'Quote copied with its source.' : 'Copy was blocked — select the quote and copy it manually.', { type: ok ? 'success' : 'error' });
        } else if (act === 'delete') {
          Clips.remove(clip.id);
          this.renderClips();
        } else if (act === 'listen') {
          App.openEntry(clip.entryId, { at: { seg: clip.seg, chunk: clip.chunk } });
        }
      });
      e.btnClipsCopy.addEventListener('click', async () => {
        const list = Clips.list();
        if (!list.length) return;
        const md = list.map((c) => `> ${c.text}\n>\n> — ${c.url ? `[${c.title}](${c.url})` : c.title}${c.site && c.site !== c.title ? `, ${c.site}` : ''}`).join('\n\n');
        const ok = await copyText(`${md}\n`);
        this.toast(ok ? `Copied ${plural(list.length, 'quote')} as Markdown.` : 'Copy was blocked by the browser.', { type: ok ? 'success' : 'error' });
      });
      this.armed(e.btnClipsClear, 'Clear', () => {
        if (!Clips.list().length) return false;
        Clips.clear();
        this.renderClips();
        return true;
      });

      /* ---------------------------------------------- docs & lexicon */
      e.lexForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const entry = Lexicon.add(e.lexFrom.value, e.lexTo.value);
        if (!entry) {
          this.toast('Type the word as it is written, and how it should sound.', { type: 'info' });
          return;
        }
        e.lexFrom.value = '';
        e.lexTo.value = '';
        this.renderLexicon();
        App.rebuild();
        this.toast(`“${entry.from}” will be said “${entry.to || '(silent)'}”.`, { type: 'success' });
        e.lexFrom.focus();
      });
      e.lexList.addEventListener('click', (ev) => {
        const del = ev.target.closest('[data-lexdel]');
        if (!del) return;
        Lexicon.remove(del.dataset.lexdel);
        this.renderLexicon();
        App.rebuild();
      });
      e.btnLexReset.addEventListener('click', () => {
        Lexicon.reset();
        this.renderLexicon();
        App.rebuild();
        this.toast('Pronunciation dictionary reset to the defaults.', { type: 'success' });
      });
      e.lexTest.addEventListener('input', () => this.previewLexicon());
      e.btnLexHear.addEventListener('click', () => this.hearLexicon());
      e.btnCopyExt.addEventListener('click', async () => {
        const ok = await copyText('chrome://extensions');
        this.toast(ok ? 'Copied — paste chrome://extensions into the address bar.' : 'Type chrome://extensions into the address bar.', { type: 'info' });
      });

      /* ------------------------------------------- shell & transport */
      e.btnNew.addEventListener('click', () => this.showLanding({ focus: true }));
      // Extension: read the tab you are looking at again, live (a fresh copy, whatever is playing).
      e.btnReread.addEventListener('click', () => Ext.readTab({}));
      e.brandHome.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.showLanding({ focus: false });
      });
      e.btnHelp.addEventListener('click', () => this.openHelp());
      e.btnHelpClose.addEventListener('click', () => e.helpDialog.close());
      e.helpDialog.addEventListener('click', (ev) => {
        if (ev.target === e.helpDialog) e.helpDialog.close();
      });
      e.btnPopout.addEventListener('click', () => Host.send('popout'));
      e.btnPrivacy.addEventListener('click', () => this.togglePrivacy());
      document.addEventListener('pointerdown', (ev) => {
        if (!e.statusBar.hidden && !e.statusBar.contains(ev.target) && !e.btnPrivacy.contains(ev.target)) this.togglePrivacy(false);
      });

      e.btnPlay.addEventListener('click', () => {
        if (App.script && !this.segEls.length) App.showCurrent();
        Engine.toggle();
      });
      e.btnTap.addEventListener('click', () => Engine.play());
      e.btnPrev.addEventListener('click', () => Engine.prev());
      e.btnNext.addEventListener('click', () => Engine.next());
      e.npInfo.addEventListener('click', () => {
        if (!App.script) return;
        if (!this.segEls.length) App.showCurrent();
        else this.showStudio();
        this.follow = true;
        this.userScrollAt = 0;
        this.scrollToActive(false);
      });
      e.rateSel.addEventListener('change', () => App.setRate(Number(e.rateSel.value)));
      e.voiceSel.addEventListener('change', () => App.setVoice(e.voiceSel.value));
      e.btnFollow.addEventListener('click', () => {
        this.follow = true;
        this.userScrollAt = 0;
        this.scrollToActive(false);
      });
      e.statusBar.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-action="local-voice"]')) App.useLocalVoice();
        if (ev.target.closest('[data-action="allow-access"]')) Ext.allowAllSites();
        if (ev.target.closest('[data-action="remove-access"]')) Ext.removeAccess();
        if (ev.target.closest('[data-action="turbo-off"]')) {
          // Back to this device's voice for the rest of the session; the key stays saved for next time.
          Turbo.voiceOff = true;
          Turbo.clearCache();
          if (Engine.state === 'playing') Engine.restart();
          this.renderStatus();
          TurboUI.sync();
          this.toast('Turbo voice off for this session — your on-device voice speaks now.', { type: 'info', timeout: 2600 });
        }
      });

      e.identity.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-action]');
        if (btn && btn.dataset.action === 'toggle') Engine.toggle();
        const mode = ev.target.closest('[data-mode]');
        if (mode) App.setMode(mode.dataset.mode);
      });
      // Inside the extension sandbox, links open through the extension (a real new tab, not a sandboxed popup).
      document.addEventListener('click', (ev) => {
        const link = ev.target.closest && ev.target.closest('a[data-open-original]');
        if (link && Host.mode === 'extension') {
          ev.preventDefault();
          Host.send('open', { url: link.href });
        }
      });
      e.errorCard.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'retry' && App.lastUrl) App.openUrl(App.lastUrl);
        if (btn.dataset.action === 'paste') {
          this.showLanding({ focus: false });
          e.pasteForm.hidden = false;
          e.btnPasteToggle.setAttribute('aria-expanded', 'true');
          e.pasteText.focus();
        }
        if (btn.dataset.action === 'home') this.showLanding({ focus: true });
        if (btn.dataset.action === 'current' && App.script) App.showCurrent();
        if (btn.dataset.action === 'tab') Ext.readTab({});
        if (btn.dataset.action === 'allow-access') Ext.allowAllSites();
      });
      e.loadingCard.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-action="cancel"]')) App.cancelLoad();
        const consent = ev.target.closest('[data-consent]');
        if (consent) PageServices.answer(consent.dataset.consent);
      });
      e.tabCard.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-action="read-tab"]')) Ext.readTab({});
        if (ev.target.closest('[data-action="allow-access"]')) Ext.allowAllSites();
      });

      /* ------------------------------------- devtools strip, outline, clip */
      e.devtools.addEventListener('click', (ev) => {
        const pill = ev.target.closest('[data-filter]');
        if (pill) App.setFilter(pill.dataset.filter, pill.getAttribute('aria-pressed') !== 'true');
      });
      const strip = e.devtools.querySelector('.sv-dev-filters');
      strip.addEventListener('scroll', () => this.syncFilterStrip(), { passive: true });
      window.addEventListener('resize', () => this.syncFilterStrip());
      e.filterMore.addEventListener('click', () => strip.scrollBy({ left: Math.max(96, strip.clientWidth * 0.7), behavior: reducedMotion() ? 'auto' : 'smooth' }));
      e.domChanged.addEventListener('click', () => Ext.resync());
      e.outlineList.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-seg]');
        if (!item || !App.script) return;
        this.follow = true;
        this.userScrollAt = 0;
        Engine.jump(Number(item.dataset.seg), 0, { play: true });
        App.saveProgress(true);
      });
      e.outline.addEventListener('toggle', () => {
        if (e.outline.open === this.outlineOpenSet) return;
        this.outlineOpenSet = e.outline.open;
        if (!this.wideOutline()) Settings.set({ outlineOpen: e.outline.open });
      });
      e.clipBtn.addEventListener('click', () => App.clip());

      this.initPrompter();
      this.initProgress();
      document.addEventListener('keydown', (ev) => this.onKey(ev));
      const markUser = () => {
        this.userScrollAt = Date.now();
        this.follow = false;
        this.updateFollowButton();
      };
      e.scroller.addEventListener('wheel', markUser, { passive: true });
      e.scroller.addEventListener('touchmove', markUser, { passive: true });
      e.scroller.addEventListener('scroll', () => this.updateFollowButton(), { passive: true });
      // Room for the floating dock: the page scrolls clear of it; toasts and "Back to current paragraph" float above it.
      new ResizeObserver(() => document.documentElement.style.setProperty('--sv-dock-space', `${this.dockSpace()}px`)).observe(e.transport);
      new ResizeObserver(() => this.positionClip()).observe(e.prompter);
      // A cover image that loads (or fails) late resizes the header under the intro: re-anchor the intro.
      new ResizeObserver(() => {
        if (this.activeSeg === 0 && this.follow) this.scrollToActive(true);
      }).observe(e.identity);
      new ResizeObserver(() => this.positionTabs()).observe(e.tabStudio.parentElement);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.positionTabs());
      this.positionTabs();
      let resizeFrame = 0;
      window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          this.positionClip();
          this.positionTabs();
        });
      });
      Field.init(e.heroField, e.landing);

      document.addEventListener(
        'error',
        (ev) => {
          const img = ev.target;
          if (!(img instanceof HTMLImageElement)) return;
          if (img.classList.contains('sv-hero-img')) {
            const hero = img.closest('.sv-hero');
            if (hero) hero.classList.add('is-empty');
            img.remove();
          } else if (img.dataset.fallbacks !== undefined) {
            nextLogo(img);
          }
        },
        true,
      );
      document.addEventListener(
        'load',
        (ev) => {
          const img = ev.target;
          if (!(img instanceof HTMLImageElement)) return;
          if (img.classList.contains('sv-hero-img')) img.classList.add('is-loaded');
          else if (img.dataset.fallbacks !== undefined && img.naturalWidth > 0 && img.naturalWidth < 8) nextLogo(img);
        },
        true,
      );
    },

    /** Destructive buttons ask twice: the first click arms them for 3.5 s. */
    armed(btn, label, run) {
      let at = 0;
      btn.addEventListener('click', () => {
        if (Date.now() - at > 3500) {
          at = Date.now();
          btn.textContent = 'Tap again';
          setTimeout(() => {
            btn.textContent = label;
          }, 3500);
          return;
        }
        at = 0;
        btn.textContent = label;
        run();
      });
    },

    initPrompter() {
      const p = this.els.prompter;
      p.addEventListener('click', async (ev) => {
        const copy = ev.target.closest('[data-copy]');
        if (copy) {
          const s = App.script && App.script.segments[Number(copy.dataset.copy)];
          if (!s) return;
          const ok = await copyText(s.text);
          this.toast(ok ? 'Code copied to clipboard.' : 'Copy failed — select the code manually.', { type: ok ? 'success' : 'error' });
          return;
        }
        const el = ev.target.closest('[data-i]');
        if (!el || !App.script) return;
        const selection = window.getSelection && String(window.getSelection());
        if (selection && selection.trim().length > 2) return;
        const i = Number(el.dataset.i);
        const seg = App.script.segments[i];
        if (!seg) return;
        this.follow = true;
        this.userScrollAt = 0;
        Engine.jump(i, this.chunkAtPoint(el, seg, ev.clientX, ev.clientY), { play: true });
        App.saveProgress(true);
      });
      p.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-i]')) {
          ev.preventDefault();
          Engine.jump(Number(ev.target.dataset.i), 0, { play: true });
          App.saveProgress(true);
        }
      });
    },

    /** Which sentence of a paragraph sits under the pointer — click-to-jump lands on that exact sentence. */
    chunkAtPoint(el, seg, x, y) {
      try {
        const target = el.querySelector('.sv-seg-text');
        if (!target || seg.chunks.length < 2) return 0;
        let node = null;
        let offset = 0;
        if (document.caretPositionFromPoint) {
          const pos = document.caretPositionFromPoint(x, y);
          if (pos) ({ offsetNode: node, offset } = pos);
        } else if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            node = range.startContainer;
            offset = range.startOffset;
          }
        }
        if (!node || !target.contains(node)) return 0;
        const range = document.createRange();
        range.setStart(target, 0);
        range.setEnd(node, offset);
        const at = range.toString().length;
        let idx = 0;
        seg.chunks.forEach((c, i) => {
          if (c.start <= at) idx = i;
        });
        return idx;
      } catch {
        return 0;
      }
    },

    initProgress() {
      const bar = this.els.progress;
      const tip = this.els.progressTip;
      const fractionAt = (x) => {
        const r = bar.getBoundingClientRect();
        return clamp((x - r.left) / Math.max(1, r.width), 0, 1);
      };
      const describe = (f) => {
        const script = App.script;
        if (!script) return '';
        const target = f * script.totalChars;
        const seg = script.segments.find((s) => s.startChar + s.chars > target) || script.segments[script.segments.length - 1];
        return `${this.paraLabel(seg)} · ${fmtClock(f * Engine.totalSeconds())}`;
      };
      let dragging = false;
      const preview = (x) => {
        const f = fractionAt(x);
        tip.hidden = false;
        tip.style.left = `${f * 100}%`;
        tip.textContent = describe(f);
        if (dragging) {
          this.els.progressFill.style.width = `${f * 100}%`;
          this.els.progressThumb.style.left = `${f * 100}%`;
        }
      };
      bar.addEventListener('pointerdown', (ev) => {
        if (!App.script) return;
        dragging = true;
        bar.classList.add('is-dragging');
        bar.setPointerCapture(ev.pointerId);
        preview(ev.clientX);
      });
      bar.addEventListener('pointermove', (ev) => {
        if (App.script) preview(ev.clientX);
      });
      bar.addEventListener('pointerleave', () => {
        if (!dragging) tip.hidden = true;
      });
      const end = (ev) => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('is-dragging');
        tip.hidden = true;
        this.follow = true;
        this.userScrollAt = 0;
        Engine.seekFraction(fractionAt(ev.clientX));
        App.saveProgress(true);
      };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', () => {
        dragging = false;
        bar.classList.remove('is-dragging');
        tip.hidden = true;
        this.updateProgress();
      });
      bar.addEventListener('keydown', (ev) => {
        if (!App.script) return;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          Engine.seekFraction(Engine.fraction() + 0.05);
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          Engine.seekFraction(Engine.fraction() - 0.05);
        } else if (ev.key === 'Home') {
          ev.preventDefault();
          Engine.jump(0);
        }
      });
    },

    /** Space/K play-pause, J/L sentence, ←/→ paragraph (Shift = sentence), B clip, 1–3 tabs, S sidebar. */
    onKey(ev) {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
        if (ev.key === 'Escape') t.blur();
        return;
      }
      if (this.els.helpDialog.open || document.querySelector('dialog[open]')) return;
      if ((ev.key === ' ' || ev.key === 'Enter') && t && t.closest && t.closest('button, a, summary, [role="button"], [role="slider"], [role="tab"], [data-id], [data-i]')) return;
      const has = Boolean(App.script);
      const rateStep = (dir) => {
        const i = RATES.indexOf(Engine.rate);
        const next = RATES[clamp((i < 0 ? 2 : i) + dir, 0, RATES.length - 1)];
        App.setRate(next);
        this.toast(`Speed ${next}×`, { type: 'info', timeout: 1200 });
      };
      switch (ev.key) {
        case ' ':
        case 'k':
        case 'K':
          if (!has) return;
          ev.preventDefault();
          Engine.toggle();
          break;
        case 'ArrowRight':
          if (!has) return;
          ev.preventDefault();
          if (ev.shiftKey) Engine.nextSentence();
          else Engine.next();
          break;
        case 'ArrowLeft':
          if (!has) return;
          ev.preventDefault();
          if (ev.shiftKey) Engine.prevSentence();
          else Engine.prev();
          break;
        case 'l':
        case 'L':
          if (!has) return;
          ev.preventDefault();
          Engine.nextSentence();
          break;
        case 'j':
        case 'J':
          if (!has) return;
          ev.preventDefault();
          Engine.prevSentence();
          break;
        case ']':
          if (has) rateStep(1);
          break;
        case '[':
          if (has) rateStep(-1);
          break;
        case 'b':
        case 'B':
          if (!has) return;
          ev.preventDefault();
          App.clip();
          break;
        case 's':
        case 'S':
          this.toggleLibrary();
          break;
        case '1':
        case '2':
        case '3':
          this.setTab(['studio', 'saved', 'docs'][Number(ev.key) - 1]);
          break;
        case 'f':
        case 'F':
          if (!has) return;
          this.setTab('studio');
          this.follow = true;
          this.userScrollAt = 0;
          this.scrollToActive(false);
          break;
        case '/': {
          // Exactly one address field is ever on screen: the hero command bar, or the compact pill once a page is open.
          ev.preventDefault();
          const landing = !this.els.landing.hidden;
          if (landing) this.setTab('studio');
          const input = landing ? this.els.heroUrl : this.els.navUrl;
          input.focus();
          input.select();
          break;
        }
        case '?':
          this.openHelp();
          break;
        case 'Escape':
          // Esc closes overlays (drawer, privacy panel) — never the docked desktop sidebar.
          if (!(window.matchMedia && window.matchMedia('(min-width: 1024px)').matches)) this.toggleLibrary(false);
          this.togglePrivacy(false);
          break;
        default:
      }
    },

    openHelp() {
      if (typeof this.els.helpDialog.showModal === 'function') this.els.helpDialog.showModal();
    },

    /* --------------------------------------------------------------- tabs */
    setTab(name, { focus = false } = {}) {
      const map = { studio: [this.els.tabStudio, this.els.panelStudio], saved: [this.els.tabSaved, this.els.panelSaved], docs: [this.els.tabDocs, this.els.panelDocs] };
      if (!map[name]) return;
      const changed = name !== this.tab;
      if (changed) this.tabScroll[this.tab] = this.els.scroller.scrollTop;
      this.tab = name;
      for (const [key, [tab, panel]] of Object.entries(map)) {
        const on = key === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panel.hidden = !on;
      }
      document.body.dataset.tab = name;
      this.positionTabs();
      Field.sync();
      if (focus) map[name][0].focus();
      if (!changed) return;
      const panel = map[name][1];
      panel.classList.remove('sv-enter');
      void panel.offsetWidth;
      panel.classList.add('sv-enter');
      this.els.scroller.scrollTop = this.tabScroll[name] || 0;
      if (name === 'saved') this.renderSaved();
      if (name === 'docs') this.renderLexicon();
      if (name === 'studio' && App.script && !this.els.studio.hidden && Engine.state === 'playing') {
        this.follow = true;
        this.userScrollAt = 0;
        this.scrollToActive(true);
      }
      this.updateFollowButton();
      this.positionClip();
    },

    /** The segmented control's white thumb slides under the selected tab. */
    positionTabs() {
      const nav = this.els.tabStudio.parentElement;
      const thumb = nav.querySelector('.sv-tabs-thumb');
      const tab = { studio: this.els.tabStudio, saved: this.els.tabSaved, docs: this.els.tabDocs }[this.tab];
      if (!thumb || !tab || !tab.offsetWidth) return;
      thumb.style.width = `${tab.offsetWidth}px`;
      thumb.style.transform = `translateX(${tab.offsetLeft}px)`;
      if (!nav.classList.contains('is-ready')) requestAnimationFrame(() => nav.classList.add('is-ready'));
    },

    togglePrivacy(force) {
      const panel = this.els.statusBar;
      const open = force === undefined ? panel.hidden : Boolean(force);
      if (open === !panel.hidden) return;
      panel.hidden = !open;
      this.els.btnPrivacy.setAttribute('aria-expanded', String(open));
    },

    dockSpace() {
      const dock = this.els.transport;
      if (dock.hidden || !dock.offsetHeight) return 0;
      return dock.offsetHeight + (window.matchMedia && window.matchMedia('(max-width: 639.98px)').matches ? 12 : 20) + 16;
    },

    toggleLibrary(force) {
      const wide = window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
      const body = document.body;
      if (wide) {
        const open = force === undefined ? body.classList.contains('sv-lib-collapsed') : force;
        body.classList.toggle('sv-lib-collapsed', !open);
        this.els.btnLibrary.setAttribute('aria-expanded', String(open));
        if (force === undefined) Settings.set({ libOpen: open });
        requestAnimationFrame(() => this.positionClip());
        return;
      }
      const open = force === undefined ? !body.classList.contains('sv-lib-open') : force;
      body.classList.toggle('sv-lib-open', open);
      this.els.libOverlay.hidden = !open;
      this.els.btnLibrary.setAttribute('aria-expanded', String(open));
      if (open) setTimeout(() => this.els.libSearch.focus({ preventScroll: true }), 50);
    },

    syncSidebar() {
      if (!window.matchMedia || !window.matchMedia('(min-width: 1024px)').matches) return;
      const open = Settings.data.libOpen === null ? Library.entries.length > 0 : Settings.data.libOpen;
      document.body.classList.toggle('sv-lib-collapsed', !open);
      this.els.btnLibrary.setAttribute('aria-expanded', String(open));
    },

    /** The Address bar shows the page being read, like a browser's location field. */
    setAddress(url) {
      if (document.activeElement !== this.els.navUrl) this.els.navUrl.value = url || '';
    },

    showLanding({ focus = false } = {}) {
      this.setTab('studio');
      document.body.classList.add('sv-on-landing');
      this.els.landing.hidden = false;
      this.els.studio.hidden = true;
      this.els.scroller.scrollTop = 0;
      this.setAddress('');
      this.renderTabCard();
      this.positionClip();
      if (Host.mode !== 'extension') {
        try {
          history.replaceState(null, '', location.pathname);
        } catch {
          /* file:// or sandboxed history */
        }
      }
      if (focus) setTimeout(() => this.els.heroUrl.focus(), 30);
      this.updateTitle();
      Field.sync();
    },

    showStudio() {
      this.setTab('studio');
      document.body.classList.remove('sv-on-landing');
      this.els.landing.hidden = true;
      this.els.studio.hidden = false;
      this.renderTabCard();
      Field.sync();
    },

    clearStudio() {
      this.els.identity.innerHTML = '';
      this.els.prompter.innerHTML = '';
      this.els.statusRow.hidden = true;
      this.els.devtools.hidden = true;
      this.els.outline.hidden = true;
      this.els.clipBtn.hidden = true;
      this.segEls = [];
      this.outlineEls = [];
    },

    showLoading(url) {
      this.showStudio();
      this.els.errorCard.hidden = true;
      this.els.tapToPlay.hidden = true;
      this.clearStudio();
      if (/^https?:/i.test(url || '') && !/^https:\/\/this\.tab\//.test(url)) this.setAddress(url);
      const host = bareHost(hostOf(url)) || 'this page';
      this.els.loadingCard.hidden = false;
      this.els.loadingCard.innerHTML = `
        <div class="sv-sheet-card sv-glass">
          <div class="flex items-center gap-3.5">
            <div class="sv-skel size-12 shrink-0 rounded-[0.95rem]"></div>
            <div class="flex-1 space-y-2"><div class="sv-skel h-3 w-28"></div><div class="sv-skel h-3 w-44"></div></div>
          </div>
          <div class="sv-skel mt-7 h-8 w-4/5"></div>
          <div class="sv-skel mt-3 h-8 w-3/5"></div>
          <div class="mt-7 flex items-center gap-3 text-sm text-black/65" role="status">
            ${icon('loader-circle', 'size-5 shrink-0 sv-spin text-[#047857]')}
            <span class="min-w-0"><span class="font-bold text-black">${esc(host)}</span> · <span id="loadingStatus">Resolving page…</span></span>
            <button type="button" data-action="cancel" class="sv-mini-btn ml-auto shrink-0">Cancel</button>
          </div>
          <p id="loadingStage" class="sv-loadstage" data-stage="connect"><span class="sv-loadstage-dot" aria-hidden="true"></span><span class="sv-loadstage-label">Connecting</span><span class="sv-loadstage-detail"></span></p>
          <ol class="sv-pipeline" aria-hidden="true"><li>Fetch</li><li>Ad-Shield</li><li>Readability</li><li>Broadcast script</li></ol>
          <div class="mt-9 space-y-3.5">${[92, 100, 84, 96, 70].map((w) => `<div class="sv-skel h-4" style="width:${w}%"></div>`).join('')}</div>
        </div>`;
      this.setLoadingStage('connect');
    },

    setLoadingStatus(text) {
      const el = document.getElementById('loadingStatus');
      if (el) el.textContent = text;
    },

    /**
     * Connecting → Extracting DOM → Ready, in the loading card and on the address pill (whose → turns into a
     * spinner meanwhile). "Ready · 412 ms" stays on the pill for a moment after the page opens.
     */
    setLoadingStage(stage, detail = '') {
      const label = { connect: 'Connecting', extract: 'Extracting DOM', ready: 'Ready' }[stage] || '';
      const card = document.getElementById('loadingStage');
      if (card && !this.els.loadingCard.hidden) {
        this.els.loadingCard.dataset.stage = stage;
        card.dataset.stage = stage;
        card.querySelector('.sv-loadstage-label').textContent = label;
        card.querySelector('.sv-loadstage-detail').textContent = detail;
      }
      const chip = this.els.navStage;
      clearTimeout(this.stageTimer);
      // While busy the → becomes a spinner (CSS only: the button's own icon is left untouched).
      this.els.navForm.classList.toggle('is-busy', stage === 'connect' || stage === 'extract');
      if (!label) {
        chip.hidden = true;
        return;
      }
      chip.hidden = false;
      chip.dataset.stage = stage;
      chip.textContent = stage === 'ready' && detail ? `Ready · ${detail}` : label;
      if (stage === 'ready') this.stageTimer = setTimeout(() => (chip.hidden = true), 1800);
    },

    showError(err, url) {
      this.setLoadingStage('');
      this.showStudio();
      this.els.loadingCard.hidden = true;
      this.clearStudio();
      const attempts = (err && err.attempts) || [];
      const host = bareHost(hostOf(url));
      const safe = safeHttpUrl(url);
      const extension = Host.mode === 'extension';
      // In the extension without site access: a tab it may not read yet, or a link it loaded the website's way.
      const allow = extension && !Ext.access;
      const tip = !extension
        ? 'Some sites block public CORS proxies. The <b>SiteVocal Chrome extension</b> reads the open tab directly (even pages you’re logged into), or you can paste the article text.'
        : err && err.code === 'needs-access'
          ? 'Chrome asks you first, and you can take it back any time in the privacy panel or in chrome://extensions.'
          : allow
            ? 'Without site access, a link you paste opens through a public page service only after you agree. <b>Allow all sites</b> to load pages straight from your browser (even pages you’re logged into), or open the page and click the SiteVocal icon on it.'
            : 'Open the page in a tab and press <b>Read this tab</b> — the extension reads the live page directly, with no proxies.';
      this.els.errorCard.hidden = false;
      this.els.errorCard.innerHTML = `
        <div class="sv-sheet-card sv-glass">
          <div class="flex items-start gap-4">
            <div class="grid size-12 shrink-0 place-items-center rounded-[0.95rem] bg-[#7A1C24]/[0.08] text-[#7A1C24]">${icon('triangle-alert', 'size-6')}</div>
            <div class="min-w-0">
              <h2 class="text-xl font-extrabold tracking-tight">Couldn’t read ${esc(host || 'that page')}</h2>
              <p class="mt-1.5 text-sm leading-relaxed text-black/60">${esc((err && err.message) || 'Something went wrong while fetching the page.')}</p>
            </div>
          </div>
          ${attempts.length ? `<ul class="sv-attempts">${attempts.map((a) => `<li>${icon('x', 'size-3.5 shrink-0 text-black/35')}<span>${esc(a)}</span></li>`).join('')}</ul>` : ''}
          <p class="mt-5 text-sm leading-relaxed text-black/60">${tip}</p>
          <div class="mt-6 flex flex-wrap gap-2.5">
            ${allow ? `<button type="button" class="sv-btn-primary" data-action="allow-access">${icon('shield-check', 'size-4')}Allow all sites</button>` : ''}
            <button type="button" class="${allow ? 'sv-btn-ghost' : 'sv-btn-primary'}" data-action="retry">${icon('rotate-ccw', 'size-4')}Try again</button>
            ${extension ? `<button type="button" class="sv-btn-ghost" data-action="tab">${icon('app-window', 'size-4')}Read this tab</button>` : ''}
            <button type="button" class="sv-btn-ghost" data-action="paste">${icon('clipboard-paste', 'size-4')}Paste text instead</button>
            ${App.script && App.raw ? `<button type="button" class="sv-btn-ghost" data-action="current">${icon('headphones', 'size-4')}Back to “${esc(trimText(App.raw.title, 32))}”</button>` : ''}
            ${safe ? `<a class="sv-btn-ghost no-underline" href="${esc(safe)}" target="_blank" rel="noopener noreferrer" data-open-original>${icon('external-link', 'size-4')}Open page</a>` : ''}
          </div>
        </div>`;
      this.updateTitle();
    },

    /** How long a script takes at the current speed: "6 min listen", or "75 sec briefing". */
    listenLabel(script, seconds) {
      if (script && (script.mode === 'briefing' || script.mode === 'summary')) {
        const s = Math.max(10, Math.round(seconds / 5) * 5);
        const noun = script.mode === 'summary' ? 'summary' : 'briefing';
        return s < 100 ? `${s} sec ${noun}` : `${Math.round(s / 60)} min ${noun}`;
      }
      return `${Math.max(1, Math.round(seconds / 60))} min listen`;
    },

    scriptSeconds(script) {
      const rate = Engine.rate || Settings.data.rate || 1;
      return script ? script.totalChars / (Engine.cps * rate) + script.pauseMs / 1000 / rate : 0;
    },

    /** ⚡ Site Briefing (What They Do) | 📖 Full Page Read: one click changes what you hear. */
    modeSwitch(mode, brief) {
      const page = brief.type === 'article' || brief.type === 'feed';
      const why = brief.auto ? `Recommended for this ${Briefing.TYPES[brief.type] || 'page'}: a one-minute briefing on what they do` : 'A one-minute briefing: who they are, what the page covers and the key takeaways';
      return `<div class="sv-mode${brief.auto ? ' is-auto' : ''}" role="group" aria-label="Listening mode">
              <button type="button" id="modeBriefing" class="sv-mode-btn" data-mode="briefing" aria-pressed="${mode === 'briefing'}" title="${esc(why)}">${icon('zap', 'sv-mode-ico size-3.5')}<span class="sv-mode-label"><span class="sv-mode-long">Site </span>Briefing</span><span class="sv-mode-sub">${page ? '(Overview)' : '(What They Do)'}</span>${brief.auto && mode !== 'briefing' ? '<span class="sv-mode-dot" aria-hidden="true"></span>' : ''}</button>
              <button type="button" id="modeRead" class="sv-mode-btn" data-mode="read" aria-pressed="${mode === 'read'}" title="Every word of the page, read like a radio broadcast">${icon('book-open', 'sv-mode-ico size-3.5')}<span class="sv-mode-label">Full <span class="sv-mode-long">Page </span>Read</span></button>
              ${this.summarizeButton(mode)}
            </div>`;
    },

    /** ✨ Summarize Page: the whole page — every section, table, list and pricing grid — in a minute or two. */
    summarizeButton(mode) {
      const engine = AiSummary.ready();
      const how = engine ? `${AiSummary.label(engine)} writes the section points; tables are summarised by SiteVocal` : 'Built-in TextRank summary of every section, plus every table, list and pricing grid — no API, nothing leaves this device';
      return `<button type="button" id="modeSummary" class="sv-mode-sum" data-mode="summary" aria-pressed="${mode === 'summary'}" aria-label="Summarize Page" title="${esc(`Summarize Page · ${how}`)}">${icon('sparkles', 'sv-mode-ico size-3.5')}<span class="sv-mode-label">Summarize<span class="sv-mode-long"> Page</span></span>${engine ? `<span class="sv-mode-ai" aria-hidden="true">${engine === 'cloud' ? 'Turbo' : 'AI'}</span>` : ''}</button>`;
    },

    /**
     * The Listen line never grows a second row because of the third mode segment: "✨ Summarize Page", then
     * "✨ Summarize", then ✨ alone (named for screen readers and in its tooltip); the header's own progress bar
     * steps aside rather than wrap (the dock always shows progress).
     */
    fitModeBar() {
      const row = this.els.identity && this.els.identity.querySelector('.sv-identity-actions');
      const sum = document.getElementById('modeSummary');
      const toggle = document.getElementById('idToggle');
      const pill = row && row.querySelector('.sv-mode');
      if (!row || !sum || !toggle || !pill || !row.getClientRects().length) return;
      const mid = (el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      const prog = row.querySelector('.sv-id-progress');
      const same = (el) => Math.abs(mid(el) - mid(toggle)) < 8;
      if (prog) prog.classList.remove('is-squeezed');
      toggle.classList.remove('is-compact');
      for (const fit of ['full', 'short', 'icon']) {
        sum.dataset.fit = fit;
        if (same(pill)) break;
      }
      // Still too tight (a side panel before playback starts): "Listen now" → "Listen", "Resume · Paragraph 3" → "Resume".
      if (!same(pill)) {
        toggle.classList.add('is-compact');
        if (!same(pill)) toggle.classList.remove('is-compact');
      }
      if (prog && prog.getClientRects().length && !same(prog)) prog.classList.add('is-squeezed');
    },

    /** The ✨ segment's engine badge follows the Turbo / on-device settings without re-rendering the header. */
    refreshSummarize() {
      const btn = document.getElementById('modeSummary');
      if (!btn) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = this.summarizeButton(btn.getAttribute('aria-pressed') === 'true' ? 'summary' : '');
      const fresh = wrap.firstElementChild;
      if (btn.classList.contains('is-busy')) fresh.classList.add('is-busy');
      btn.replaceWith(fresh);
      this.fitModeBar();
    },

    /** While an on-device / Turbo summarizer works: the ✨ segment spins and says so. */
    setSummaryBusy(on, engine = '') {
      const btn = document.getElementById('modeSummary');
      if (btn) {
        btn.classList.toggle('is-busy', Boolean(on));
        btn.setAttribute('aria-busy', String(Boolean(on)));
      }
      if (on) this.toast(`${AiSummary.label(engine)} is summarizing this page…`, { type: 'info', timeout: 2600 });
    },

    renderIdentity(raw, script) {
      const site = raw.siteName || siteLabel(raw.hostname);
      const hero = safeImageUrl(raw.heroImage, raw.url || undefined);
      const original = safeHttpUrl(raw.url);
      const host = raw.hostname ? `${bareHost(raw.hostname)}${raw.kind === 'selection' ? ' · your selection' : ''}` : raw.kind === 'text' ? 'Pasted text · stored on this device' : '';
      const via = [raw.extractor, raw.via].filter(Boolean).join(' via ');
      const briefing = script.mode === 'briefing';
      const summary = script.mode === 'summary';
      const brief = Briefing.available(raw) ? Briefing.of(raw) : null;
      const sections = (script.sections || []).length;
      const S = summary ? script.summary : null;
      this.els.loadingCard.hidden = true;
      this.els.errorCard.hidden = true;
      // Website identity header: cover, logo + site pill, a 36px title, byline and listening time.
      this.els.identity.innerHTML = `
        <header class="sv-identity">
          ${hero ? `<figure class="sv-hero"><img class="sv-hero-img" src="${esc(hero)}" alt="" referrerpolicy="no-referrer" decoding="async"></figure>` : ''}
          <div class="sv-id-top">
            ${logoMarkup(raw.logos, site, 'sv-logo--tile')}
            <div class="sv-id-site">
              <span class="sv-site-pill"><span class="text-accent-ink">${esc(site)}</span></span>
              ${host ? `<span class="sv-host">${esc(host)}</span>` : ''}
            </div>
            <div class="sv-id-side">
              <span class="sv-live" id="liveChip"><i></i><span>Ready</span></span>
              ${original ? `<a class="sv-chip-btn" href="${esc(original)}" target="_blank" rel="noopener noreferrer" data-open-original title="${esc(via ? `Extracted with ${via}` : 'Open the original page')}">${icon('arrow-up-right', 'size-3.5')}<span>Original</span></a>` : ''}
            </div>
          </div>
          <h2 class="sv-title" dir="auto">${esc(raw.title)}</h2>
          ${raw.excerpt ? `<p class="sv-excerpt" dir="auto">${esc(raw.excerpt)}</p>` : ''}
          <div class="sv-meta">
            ${raw.author ? `<span class="sv-meta-author">${icon('pen-line', 'size-4')}${esc(raw.author)}</span>` : ''}
            <span class="sv-meta-time">${icon(briefing ? 'zap' : summary ? 'sparkles' : 'clock', 'size-4')}<span id="idMinutes">${this.listenLabel(script, this.scriptSeconds(script))}</span></span>
            ${summary
              ? `<span class="sv-meta-extra">${icon('layers', 'size-4')}${plural(script.cards.length, 'part')}</span>${S.stats.tables ? `<span class="sv-meta-extra">${icon('table', 'size-4')}${plural(S.stats.tables, 'table')}</span>` : ''}<span class="sv-meta-extra">${icon(S.engine === 'textrank' ? 'gauge' : S.engine === 'cloud' ? 'rocket' : 'cpu', 'size-4')}${esc(AiSummary.engineName(S))}</span>`
              : briefing
              ? `<span class="sv-meta-extra">${icon('layers', 'size-4')}${plural(script.cards.length, 'part')}</span><span class="sv-meta-extra">${icon('building-2', 'size-4')}${esc(Briefing.TYPES[script.briefing.type] || 'website')}</span>`
              : `<span class="sv-meta-extra">${icon('file-text', 'size-4')}${fmtNumber(script.words)} words</span>
            ${sections ? `<span class="sv-meta-extra">${icon('list-tree', 'size-4')}${plural(sections, 'section')}</span>` : `<span class="sv-meta-extra">${icon('scroll-text', 'size-4')}${plural(script.paragraphs, 'paragraph')}</span>`}`}
          </div>
          <div class="sv-identity-actions">
            <button type="button" class="sv-btn-primary sv-btn-play" data-action="toggle" id="idToggle">${icon('play', 'sv-filled size-4')}<span>Listen<span class="sv-play-more"> now</span></span></button>
            ${brief ? this.modeSwitch(summary ? 'summary' : briefing ? 'briefing' : 'read', brief) : ''}
            <div class="sv-id-progress">
              <div class="sv-minibar flex-1"><span id="idBar"></span></div>
              <span id="idPct" class="sv-tele">0%</span>
            </div>
          </div>
        </header>`;
      this.fitModeBar();
      if (!this.fitObserver && typeof ResizeObserver === 'function') {
        let frame = 0;
        this.fitObserver = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => this.fitModeBar());
        });
      }
      const row = this.els.identity.querySelector('.sv-identity-actions');
      if (this.fitObserver && row) {
        this.fitObserver.disconnect();
        this.fitObserver.observe(row);
      }
    },

    segHtml(s) {
      const text = esc(s.text);
      // Arabic, Hebrew, Persian, Urdu…: right-to-left paragraphs (the spoken-paragraph rule moves to the right).
      // The intro and sign-off are SiteVocal's own English sentences; code stays left-to-right; tables use dir=auto.
      const rtl = !['intro', 'outro', 'code', 'table', 'brief', 'sumtable', 'sumlist', 'sumprice'].includes(s.kind) && textDir(s.text) === 'rtl';
      const attrs = `class="sv-seg sv-seg--${s.kind}" data-i="${s.i}" tabindex="-1"${rtl ? ' dir="rtl"' : ''}`;
      switch (s.kind) {
        case 'intro':
        case 'outro':
          return `<div ${attrs}><div class="sv-onair">${icon(s.kind === 'intro' ? 'radio' : 'podcast', 'size-3.5')}${esc(s.onair || (s.kind === 'intro' ? 'On air · Intro' : 'Sign-off'))}</div><p class="sv-seg-text m-0">${text}</p></div>`;
        case 'brief': {
          const chips = Array.isArray(s.chips) && s.chips.length ? `<span class="sv-brief-chips">${s.chips.map((c) => `<span class="sv-brief-chip"><b>${esc(c.name)}</b>${c.price ? `<span>${esc(c.price)}</span>` : ''}</span>`).join('')}</span>` : '';
          const title = s.title ? `<span class="sv-brief-title" dir="auto">${esc(s.title)}</span>` : '';
          const marker = s.marker ? `<span class="sv-brief-n" aria-hidden="true">${esc(s.marker)}</span>` : '';
          const body = s.text ? `<span class="sv-seg-text" dir="auto">${text}</span>` : '';
          return `<div ${attrs} data-role="${esc(s.role || '')}">${marker}<span class="sv-brief-body">${title}${body}${chips}</span></div>`;
        }
        case 'sum':
          return `<div ${attrs} data-role="${esc(s.role || '')}"><span class="sv-seg-text" dir="auto">${text}</span></div>`;
        case 'sumlist':
          return `<div ${attrs}><div class="sv-sum-head">${icon('list-checks', 'size-3.5')}<span class="sv-sum-title">${s.ordered ? 'Steps' : 'Key list'}</span><span class="sv-sum-meta">${plural(s.total || 0, 'item')}</span></div><span class="sv-seg-text" dir="auto">${text}</span></div>`;
        case 'sumprice': {
          const chips = (s.plans || []).map((p) => `<span class="sv-brief-chip"><b>${esc(p.name)}</b><span>${esc(p.price)}</span></span>`).join('');
          return `<div ${attrs}><div class="sv-sum-head">${icon('table', 'size-3.5')}<span class="sv-sum-title">Pricing grid</span><span class="sv-sum-meta">${plural((s.plans || []).length, 'plan')}</span></div><span class="sv-brief-chips">${chips}</span><span class="sv-seg-text">${text}</span></div>`;
        }
        case 'sumtable':
          return this.sumTableHtml(s, attrs, text);
        case 'h':
          return s.level <= 2 ? `<h2 ${attrs}><span class="sv-seg-text">${text}</span></h2>` : `<h3 ${attrs}><span class="sv-seg-text">${text}</span></h3>`;
        case 'li':
          return `<div ${attrs} data-marker="${esc(s.marker)}"><span class="sv-seg-text">${text}</span></div>`;
        case 'quote':
          return `<blockquote ${attrs}><span class="sv-seg-text">${text}</span></blockquote>`;
        case 'code':
          return `<div ${attrs}><div class="sv-code-head">${icon('code', 'size-3.5')}Code block · ${s.read ? 'Read aloud' : 'Skipped in audio'}<button type="button" data-copy="${s.i}">${icon('copy', 'size-3')}Copy</button></div><pre><code>${text}</code></pre></div>`;
        case 'table': {
          const rows = Array.isArray(s.cells) ? s.cells : [];
          const head = `<div class="sv-code-head">${icon('table', 'size-3.5')}Table · ${plural(s.rows, 'row')} · ${s.read ? 'Read aloud' : 'Skipped in audio'}</div>`;
          if (!rows.length) return `<div ${attrs}>${head}<span>Table with ${plural(s.rows, 'row')} · skipped in audio. Open the original page to view it.</span></div>`;
          const body = rows.map((r, i) => `<tr>${r.map((c) => (i === 0 && s.head ? `<th scope="col">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
          return `<div ${attrs}>${head}${s.caption ? `<p class="m-0 text-[0.9em] font-semibold">${esc(s.caption)}</p>` : ''}<div class="sv-table-scroll"><table dir="auto">${body}</table></div></div>`;
        }
        default:
          return `<p ${attrs}><span class="sv-seg-text">${text}</span></p>`;
      }
    },

    /** A Summarized Table Card: title, size, a preview of the key rows, and the spoken summary (highlighted as it is read). */
    sumTableHtml(s, attrs, text) {
      const g = s.grid || {};
      const kv = g.kind === 'kv';
      const total = kv ? g.total || (g.pairs || []).length : g.total || (g.rows || []).length;
      const meta = kv ? plural(total, 'detail') : `${plural(total, 'row')} · ${plural(g.cols || 0, 'column')}`;
      let preview;
      if (kv) {
        preview = `<dl class="sv-sum-kv">${(g.pairs || []).slice(0, 6).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
      } else {
        const cols = Math.min(g.cols || 0, 5);
        const head = g.headers && g.headers.length ? `<thead><tr>${g.headers.slice(0, cols).map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>` : '';
        const rows = (g.rows || []).slice(0, 4).map((r) => `<tr>${r.slice(0, cols).map((c, j) => (j === 0 && g.rowHead ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
        preview = `<div class="sv-table-scroll"><table class="sv-sum-table" dir="auto">${head}<tbody>${rows}</tbody></table></div>`;
      }
      const shown = kv ? Math.min(6, total) : Math.min(4, total);
      const more = total > shown ? `<span class="sv-sum-more">+ ${plural(total - shown, kv ? 'more detail' : 'more row')} on the page</span>` : '';
      return `<div ${attrs}><div class="sv-sum-head">${icon('table', 'size-3.5')}<span class="sv-sum-title" dir="auto">${esc(g.title || (kv ? 'Key details' : 'Table'))}</span><span class="sv-sum-meta">${meta}</span></div>${preview}${more}<p class="sv-sum-prose m-0"><span class="sv-seg-text">${text}</span></p></div>`;
    },

    /** ✨ Summarize Page: a summary sheet — the page, its overview, then every section, table and list as a spoken card. */
    summaryHtml(script) {
      const raw = App.raw || {};
      const S = script.summary;
      const segs = script.segments;
      const st = S.stats;
      const covered = [st.points ? plural(st.points, 'key point') : '', st.tables ? plural(st.tables, 'table') : ''].filter(Boolean).join(' · ');
      const head = `<header class="sv-summary-head">
          <span class="sv-summary-badge" aria-hidden="true">${icon('sparkles', 'size-5')}</span>
          <div class="sv-dossier-id">
            <p class="sv-dossier-kicker sv-summary-kicker"><span>Page Summary</span><span class="sv-dossier-type">${esc(AiSummary.engineName(S))}</span></p>
            <p class="sv-summary-name" dir="auto">${esc(raw.title || S.title)}</p>
            <p class="sv-dossier-sub">${S.domain ? `<span class="sv-dossier-domain">${icon('globe', 'size-3.5')}${esc(S.domain)}</span>` : ''}${covered ? `<span class="sv-summary-cover">${icon('layers', 'size-3.5')}${esc(covered)}</span>` : ''}</p>
          </div>
          <span class="sv-dossier-time">${esc(fmtClock(this.scriptSeconds(script)))}<small>${esc(st.fullSeconds >= 45 ? `of ${fmtClock(st.fullSeconds)} read` : plural(script.cards.length, 'part'))}</small></span>
        </header>`;
      const cards = script.cards
        .map((c) => {
          const items = segs.filter((s) => s.card === c.n).map((s) => this.segHtml(s)).join('');
          return `<section class="sv-sum-card" data-card="${c.n}" data-key="${esc(c.key)}" aria-label="${esc(`${c.num} · ${c.label}`)}">
            <h3 class="sv-dossier-label"><span class="sv-dossier-num">${c.num}</span><span class="sv-dossier-dot" aria-hidden="true">·</span><span class="sv-sum-label" dir="auto">${esc(c.label)}</span><span class="sv-dossier-live" aria-hidden="true"><i></i>Speaking</span></h3>
            ${items}
          </section>`;
        })
        .join('');
      return `<div class="sv-summary">${head}${this.segHtml(segs[0])}${cards}${this.segHtml(segs[segs.length - 1])}</div>`;
    },

    /** Site Briefing: the teleprompter becomes a company / website dossier sheet with four spoken cards. */
    dossierHtml(script) {
      const raw = App.raw || {};
      const B = script.briefing;
      const segs = script.segments;
      const label = Briefing.TYPES[B.type] || 'website';
      const head = `<header class="sv-dossier-head">
          ${logoMarkup(raw.logos, B.name, 'sv-logo--dossier')}
          <div class="sv-dossier-id">
            <p class="sv-dossier-kicker">${icon('zap', 'size-3.5')}<span>Site Briefing</span><span class="sv-dossier-type">${B.auto ? '<span class="sv-dossier-auto">Auto-detected </span>' : ''}${esc(label)}</span></p>
            <p class="sv-dossier-name" dir="auto">${esc(B.name)}</p>
            <p class="sv-dossier-sub">${B.domain ? `<span class="sv-dossier-domain">${icon('globe', 'size-3.5')}${esc(B.domain)}</span>` : ''}<span class="sv-dossier-swatch" title="Brand colour"><i aria-hidden="true"></i><span id="dossierAccent">${esc(Color.hex(Theme.accent).toUpperCase())}</span></span></p>
          </div>
          <span class="sv-dossier-time">${esc(fmtClock(this.scriptSeconds(script)))}<small>${plural(script.cards.length, 'part')}</small></span>
        </header>`;
      const cards = script.cards
        .map((c) => {
          const items = segs.filter((s) => s.card === c.n).map((s) => this.segHtml(s)).join('');
          return `<section class="sv-dossier-card" data-card="${c.n}" data-key="${esc(c.key)}" aria-label="${esc(`${c.num} · ${c.label}`)}">
            <h3 class="sv-dossier-label"><span class="sv-dossier-num">${c.num}</span><span class="sv-dossier-dot" aria-hidden="true">·</span><span>${esc(c.label)}</span>${c.sub ? `<span class="sv-dossier-labelsub">${esc(c.sub)}</span>` : ''}<span class="sv-dossier-live" aria-hidden="true"><i></i>Speaking</span></h3>
            ${items}
          </section>`;
        })
        .join('');
      return `<div class="sv-dossier">${head}${this.segHtml(segs[0])}${cards}${this.segHtml(segs[segs.length - 1])}</div>`;
    },

    renderPrompter(script) {
      this.activeSeg = -1;
      this.activeChunk = -1;
      this.wordKey = '';
      this.activeCard = null;
      this.els.prompter.classList.toggle('is-dossier', script.mode === 'briefing');
      this.els.prompter.classList.toggle('is-summary', script.mode === 'summary');
      this.els.prompter.innerHTML = script.mode === 'briefing' ? this.dossierHtml(script) : script.mode === 'summary' ? this.summaryHtml(script) : script.segments.map((s) => this.segHtml(s)).join('');
      this.segEls = Array.from(this.els.prompter.querySelectorAll('[data-i]'));
      this.els.statusRow.hidden = false;
      this.renderOutline(script);
      this.renderDevtools();
    },

    paintText(segIndex, chunkIndex, range) {
      const script = App.script;
      const s = script && script.segments[segIndex];
      const el = this.segEls[segIndex];
      if (!s || !el) return;
      const target = el.querySelector('.sv-seg-text');
      const ch = s.chunks[chunkIndex];
      if (!target || !ch || ch.end <= ch.start) return;
      const t = s.text;
      const sentence = t.slice(ch.start, ch.end);
      const inner = range ? `${esc(sentence.slice(0, range[0]))}<mark class="sv-word">${esc(sentence.slice(range[0], range[1]))}</mark>${esc(sentence.slice(range[1]))}` : esc(sentence);
      target.innerHTML = `${esc(t.slice(0, ch.start))}<span class="sv-sent">${inner}</span>${esc(t.slice(ch.end))}`;
    },

    resetText(segIndex) {
      const s = App.script && App.script.segments[segIndex];
      const target = this.segEls[segIndex] && this.segEls[segIndex].querySelector('.sv-seg-text');
      if (s && target) target.textContent = s.text;
    },

    setActive(seg, chunk, instant = false) {
      const els = this.segEls;
      if (!els.length) return;
      if (seg !== this.activeSeg) {
        const prev = this.activeSeg;
        if (els[prev]) {
          els[prev].classList.remove('is-active');
          this.resetText(prev);
        }
        if (prev < 0) els.forEach((el, i) => el.classList.toggle('is-done', i < seg));
        else for (let i = Math.min(prev, seg); i <= Math.max(prev, seg); i++) if (els[i]) els[i].classList.toggle('is-done', i < seg);
        if (els[seg]) els[seg].classList.add('is-active');
        this.activeSeg = seg;
        this.syncDossier(seg);
        this.scrollToActive(instant);
        this.updateOutline();
        this.positionClip();
      }
      this.activeChunk = chunk;
      this.wordKey = '';
      this.paintText(seg, chunk, null);
      this.updateStatus();
      this.updateProgress();
    },

    /** The dossier card being spoken glows in the site's brand colour; the cards before it are done. */
    syncDossier(seg) {
      const cards = this.els.prompter.querySelectorAll('.sv-dossier-card, .sv-sum-card');
      if (!cards.length) return;
      const s = App.script && App.script.segments[seg];
      const live = s && s.card ? s.card : 0;
      const last = App.script ? App.script.segments.length - 1 : 0;
      for (const c of cards) {
        const n = Number(c.dataset.card);
        c.classList.toggle('is-live', n === live);
        c.classList.toggle('is-done', seg >= last ? true : live ? n < live : false);
      }
    },

    setWord(seg, chunk, speechIndex) {
      if (seg !== this.activeSeg || chunk !== this.activeChunk) return;
      const s = App.script && App.script.segments[seg];
      const ch = s && s.chunks[chunk];
      if (!ch) return;
      const range = mapWord(s.text, ch, speechIndex);
      const key = range ? range.join(':') : '';
      if (key === this.wordKey) return;
      this.wordKey = key;
      this.paintText(seg, chunk, range);
      const now = performance.now();
      if (now - this.lastPulse > 70) {
        this.lastPulse = now;
        this.els.wave.style.setProperty('--energy', (0.72 + Math.random() * 0.5).toFixed(2));
      }
    },

    studioVisible() {
      return this.tab === 'studio' && !this.els.studio.hidden;
    },

    scrollToActive(instant) {
      const el = this.segEls[this.activeSeg];
      if (!el || !this.studioVisible()) return;
      if (!this.follow) {
        if (Date.now() - this.userScrollAt < 9000) {
          this.updateFollowButton();
          return;
        }
        this.follow = true;
      }
      const sc = this.els.scroller;
      const r = el.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      const dock = this.els.transport;
      const dockTop = dock.hidden || !dock.offsetHeight ? sr.bottom : dock.getBoundingClientRect().top;
      const topLine = sr.top + 16;
      const bottomLine = sr.bottom - this.dockSpace() - 24;
      const band = Math.max(80, bottomLine - topLine);
      const header = this.els.identity;
      const headerInView = !this.els.studio.hidden && header.getBoundingClientRect().bottom > topLine;
      const visible = r.top >= topLine && r.bottom <= bottomLine;
      // The station intro plays under the website header: keep as much of the header in view as the intro allows
      // (scroll back towards the top when the header shrinks, e.g. a cover image that never loads).
      if (this.activeSeg === 0 && headerInView) {
        const top = clamp(sc.scrollTop + (r.bottom - bottomLine), 0, sc.scrollTop + Math.max(0, r.top - topLine));
        if (Math.abs(top - sc.scrollTop) >= 1) sc.scrollTo({ top, behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
        this.updateFollowButton();
        return;
      }
      // Calm follow, like a reader app: while the website header is on screen, leave the page alone as long as
      // the spoken paragraph is visible; further down, glide only once it reaches the lower third.
      if (visible && (headerInView || r.top <= topLine + band * (2 / 3))) {
        this.updateFollowButton();
        return;
      }
      let delta;
      if (r.top < topLine) delta = r.top - (topLine + band * 0.2); // above the view: bring it back into the upper fifth
      else if (headerInView && r.top < dockTop) delta = r.bottom - bottomLine; // reveal it just above the dock, keep the header
      else delta = r.top - (topLine + band / 3); // glide it up to the upper third
      if (r.top >= topLine) delta = Math.min(delta, r.top - topLine); // a paragraph taller than the view starts at its top
      if (Math.abs(delta) >= 1) sc.scrollTo({ top: Math.max(0, sc.scrollTop + delta), behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
      this.updateFollowButton();
    },

    updateFollowButton() {
      const el = this.segEls[this.activeSeg];
      if (!el || !this.studioVisible()) {
        this.els.btnFollow.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      const sr = this.els.scroller.getBoundingClientRect();
      const offscreen = r.bottom < sr.top + 40 || r.top > sr.bottom - 40 - this.dockSpace();
      this.els.btnFollow.hidden = !(offscreen && !this.follow);
    },

    paraLabel(seg) {
      const script = App.script;
      if (!seg || !script) return '';
      if (seg.kind === 'intro') return 'Intro';
      if (seg.kind === 'outro') return 'Sign-off';
      if (script.mode === 'briefing' || script.mode === 'summary') {
        const card = (script.cards || []).find((c) => c.n === seg.card);
        return `Part ${seg.para} of ${script.paragraphs}${card ? ` · ${card.label}` : ''}`;
      }
      return `Paragraph ${Math.min(seg.para, script.paragraphs)} of ${script.paragraphs}`;
    },

    updateStatus() {
      const script = App.script;
      if (!script) return;
      const seg = script.segments[Engine.seg];
      this.els.statusPara.textContent = this.paraLabel(seg);
      this.els.statusPct.textContent = `${Math.round(Engine.fraction() * 100)}% listened`;
    },

    updateProgress() {
      if (!App.script) return;
      const f = Engine.fraction();
      const pct = Math.round(f * 100);
      if (!this.els.progress.classList.contains('is-dragging')) {
        this.els.progressFill.style.width = `${(f * 100).toFixed(2)}%`;
        this.els.progressThumb.style.left = `${(f * 100).toFixed(2)}%`;
      }
      this.els.progress.setAttribute('aria-valuenow', String(pct));
      this.els.progress.setAttribute('aria-valuetext', `${pct}% · ${this.paraLabel(App.script.segments[Engine.seg])}`);
      const total = Engine.totalSeconds();
      this.els.tElapsed.textContent = fmtClock(total * f);
      this.els.tRemain.textContent = `−${fmtClock(total * (1 - f))}`;
      const bar = document.getElementById('idBar');
      const label = document.getElementById('idPct');
      if (bar) bar.style.width = `${f * 100}%`;
      if (label) label.textContent = `${pct}%`;
      this.els.statusPct.textContent = `${pct}% listened`;
      this.syncActiveCard(f);
    },

    /** The article being read: its library cards show the same live progress as the reader (intro included). */
    syncActiveCard(f) {
      const script = App.script;
      const seg = script && script.segments[Engine.seg];
      if (!App.entryId || !seg) return;
      const ended = Engine.state === 'ended';
      const pct = ended ? 100 : Math.round(f * 100);
      const unit = script.mode === 'briefing' ? 'Briefing · Part' : script.mode === 'summary' ? 'Summary · Part' : 'Paragraph';
      const where = seg.kind === 'intro' ? (script.mode === 'briefing' ? 'Briefing intro' : script.mode === 'summary' ? 'Summary intro' : 'Intro') : seg.kind === 'outro' ? 'Sign-off' : `${unit} ${Math.min(Math.max(1, seg.para || 1), script.paragraphs)}`;
      const text = ended ? 'Finished · listen again' : f <= 0 ? 'Not started yet' : `${pct < 1 ? '<1' : pct}% listened — ${where}`;
      const key = `${App.entryId}|${pct}|${text}`;
      if (key === this.liveCardKey) return;
      this.liveCardKey = key;
      for (const card of document.querySelectorAll(`[data-id="${CSS.escape(App.entryId)}"]`)) {
        const bar = card.querySelector('.sv-libcard-bar span');
        const meta = card.querySelector('.sv-libcard-meta');
        if (bar) bar.style.width = `${pct}%`;
        if (meta) meta.textContent = `${text} · just now`;
      }
    },

    setState(state) {
      const playing = state === 'playing';
      document.body.classList.toggle('is-playing', playing);
      if (playing) document.body.classList.add('sv-listening');
      this.els.btnPlay.innerHTML = icon(playing ? 'pause' : 'play', 'sv-filled size-6');
      this.els.btnPlay.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
      this.els.btnPlay.classList.toggle('is-blocked', state === 'blocked');
      this.els.tapToPlay.hidden = state !== 'blocked' || this.els.studio.hidden;
      if (!playing) this.els.wave.style.setProperty('--energy', '1');
      const chip = document.getElementById('liveChip');
      if (chip) chip.lastElementChild.textContent = { playing: 'On air', paused: 'Paused', ended: 'Finished', blocked: 'Tap to play' }[state] || 'Ready';
      const toggle = document.getElementById('idToggle');
      if (toggle) {
        const seg = App.script && App.script.segments[Engine.seg];
        // [label, its optional tail]: on a tight Listen line the tail steps aside before the mode pill wraps.
        let label = ['Listen', ' now'];
        if (playing) label = ['Pause', ''];
        else if (state === 'ended') label = ['Listen', ' again'];
        else if (seg && Engine.seg > 0) label = ['Resume', ` · ${seg.kind === 'outro' ? 'Sign-off' : `${App.script.mode === 'briefing' || App.script.mode === 'summary' ? 'Part' : 'Paragraph'} ${seg.para}`}`];
        toggle.innerHTML = `${icon(playing ? 'pause' : state === 'ended' ? 'rotate-ccw' : 'play', `${state === 'ended' ? '' : 'sv-filled '}size-4`)}<span>${esc(label[0])}${label[1] ? `<span class="sv-play-more">${esc(label[1])}</span>` : ''}</span>`;
        this.fitModeBar();
      }
      this.updateTitle();
    },

    updateTitle() {
      const raw = App.raw;
      if (!raw || this.els.studio.hidden) {
        document.title = DEFAULT_TITLE;
        return;
      }
      document.title = `${Engine.state === 'playing' ? '▶ ' : ''}${raw.title} · SiteVocal`;
    },

    setNowPlaying(raw) {
      const site = raw.siteName || siteLabel(raw.hostname);
      const wrap = document.createElement('div');
      wrap.innerHTML = logoMarkup(raw.logos, site, 'size-10 rounded-xl');
      this.els.npLogo.replaceWith(wrap.firstElementChild);
      this.els.npLogo = this.els.npInfo.querySelector('.sv-logo');
      this.els.npLogo.id = 'npLogo';
      this.els.npTitle.textContent = raw.title;
      this.els.npSite.textContent = App.mode === 'briefing' ? `${site} · Site Briefing` : App.mode === 'summary' ? `${site} · Page Summary` : site;
      this.els.transport.hidden = false;
    },

    /**
     * Predictive prefetch (see Prefetch): a link starts loading when it is pasted into either address field or
     * left untyped for 250 ms, and when the pointer rests 120 ms on a Quick Try, Up Next or Library item. A click,
     * a tap or Enter goes straight to Listen, which picks up whatever the prefetch has already done.
     */
    wirePrefetch() {
      const e = this.els;
      for (const input of [e.heroUrl, e.navUrl]) {
        let timer = 0;
        input.addEventListener('paste', (ev) => {
          clearTimeout(timer);
          const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
          if (!text) {
            setTimeout(() => Prefetch.start(input.value, 'paste'), 0);
            return;
          }
          const v = input.value;
          const a = input.selectionStart == null ? v.length : input.selectionStart;
          const b = input.selectionEnd == null ? v.length : input.selectionEnd;
          Prefetch.start(`${v.slice(0, a)}${text}${v.slice(b)}`, 'paste');
        });
        input.addEventListener('input', (ev) => {
          clearTimeout(timer);
          if (ev.inputType === 'insertFromPaste') return; // the paste handler has it
          timer = setTimeout(() => Prefetch.start(input.value, 'typing'), PREFETCH_IDLE);
        });
        // Enter or Listen: the load starts now, so no prefetch should follow it.
        input.form.addEventListener('submit', () => clearTimeout(timer));
        input.addEventListener('focusout', () => clearTimeout(timer));
      }
      const hover = (root, selector, urlOf) => {
        let timer = 0;
        let over = null;
        root.addEventListener('pointerover', (ev) => {
          const el = ev.target.closest ? ev.target.closest(selector) : null;
          if (!el || el === over) return;
          over = el;
          clearTimeout(timer);
          timer = setTimeout(() => {
            const url = urlOf(el);
            if (url) Prefetch.start(url, 'hover');
          }, PREFETCH_HOVER);
        });
        root.addEventListener('pointerout', (ev) => {
          const el = ev.target.closest ? ev.target.closest(selector) : null;
          if (!el || el.contains(ev.relatedTarget)) return;
          if (over === el) over = null;
          clearTimeout(timer);
        });
        // A click or a tap is not a hover: it opens the page itself.
        root.addEventListener('pointerdown', () => clearTimeout(timer), true);
      };
      document.querySelectorAll('[data-demo]').forEach((btn) => hover(btn, '[data-demo]', (el) => DEMOS[el.dataset.demo]));
      hover(e.queueList, '[data-key]', (el) => (Queue.list().find((q) => q.key === el.dataset.key) || {}).url);
      for (const list of [e.libList, e.recentList, e.savedGrid]) hover(list, '[data-id]', (el) => (Library.get(el.dataset.id) || {}).url);
    },

    /* ------------------------------------------- filter bar: Ad-Shield status */
    renderDevtools() {
      const raw = App.raw;
      const script = App.script;
      const el = this.els.devtools;
      if (!raw || !script || !this.segEls.length) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      const sh = raw.shield || null;
      const cleaned = sh ? (sh.ads || 0) + (sh.clutter || 0) : 0;
      const via = `Extracted with ${raw.extractor || 'SiteVocal'}${raw.via ? ` via ${raw.via}` : ''}`;
      const count = sh
        ? `<span class="sv-shield-count" title="${esc(`${plural(cleaned, 'node')} removed before reading — stage 1 ad slots: ${sh.ads || 0} · stage 2 clutter: ${sh.clutter || 0}${sh.hidden ? ` · hidden nodes pruned in the live tab: ${sh.hidden}` : ''}`)}">DOM Cleaned · ${fmtNumber(cleaned)}</span>`
        : '<span class="sv-shield-count is-dim" title="Saved before SiteVocal 2.0 — open the page again to run the Ad-Shield">DOM Cleaned · n/a</span>';
      this.els.devBadges.innerHTML = `<span class="sv-shield" title="${esc(via)}"><span class="sv-shield-dot" aria-hidden="true"></span><span>Ad-Shield<span class="sv-shield-label-long"> Active</span></span></span>${count}`;
      this.syncFilters();
    },

    syncFilters() {
      for (const btn of this.els.devtools.querySelectorAll('[data-filter]')) btn.setAttribute('aria-pressed', String(Boolean(Settings.data.filters[btn.dataset.filter])));
      this.syncFilterStrip();
    },

    /** Narrow widths: the chip row scrolls; fade only the edges that hide chips, and offer a "more" cue. */
    syncFilterStrip() {
      const strip = this.els.devtools.querySelector('.sv-dev-filters');
      if (!strip || this.els.devtools.hidden) return;
      const max = strip.scrollWidth - strip.clientWidth;
      const end = max <= 2 || strip.scrollLeft >= max - 2;
      strip.classList.toggle('is-scrolled', strip.scrollLeft > 2);
      strip.classList.toggle('is-end', end);
      this.els.filterMore.hidden = end;
    },

    /** Extension: the page in the tab changed (SPA route, title, infinite scroll). Offer a re-sync; never interrupt the audio. */
    setDomChanged(info) {
      const btn = this.els.domChanged;
      if (!info) {
        btn.hidden = true;
        btn.disabled = false;
        return;
      }
      btn.hidden = false;
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh-cw', 'size-3.5')}Page changed · Re-sync`;
      btn.title = info.reason === 'route' ? 'The page navigated to a new address' : info.reason === 'title' ? 'The page title changed' : 'New content was added to the page';
    },

    /* ---------------------------------------------------- section outline */
    wideOutline() {
      return Boolean(window.matchMedia && window.matchMedia('(min-width: 1280px)').matches);
    },

    sectionTime(s) {
      return fmtClock(s.chars / (Engine.cps * Engine.rate) + s.pauseMs / 1000 / Engine.rate);
    },

    renderOutline(script) {
      const list = script.sections || [];
      const el = this.els.outline;
      this.outlineEls = [];
      this.activeSection = -1;
      if (!list.length) {
        el.hidden = true;
        this.els.outlineList.innerHTML = '';
        return;
      }
      el.hidden = false;
      const open = this.wideOutline() || Settings.data.outlineOpen === true;
      this.outlineOpenSet = open;
      el.open = open;
      this.els.outlineMeta.textContent = plural(list.length, script.mode === 'briefing' || script.mode === 'summary' ? 'part' : 'section');
      this.els.outlineList.innerHTML = list
        .map((s, k) => `<li><button type="button" class="sv-outline-item lvl-${s.level}" data-seg="${s.seg}" data-k="${k}"><span class="t" dir="auto">${esc(s.title)}</span><span class="m">${this.sectionTime(s)}</span></button></li>`)
        .join('');
      this.outlineEls = Array.from(this.els.outlineList.querySelectorAll('[data-k]'));
      this.updateOutline();
    },

    updateOutlineTimes() {
      const list = App.script && App.script.sections;
      if (!list) return;
      this.outlineEls.forEach((el, k) => {
        const m = el.querySelector('.m');
        if (m && list[k]) m.textContent = this.sectionTime(list[k]);
      });
    },

    updateOutline() {
      const list = App.script && App.script.sections;
      if (!list || !list.length || !this.outlineEls.length) return;
      let k = -1;
      for (let j = 0; j < list.length; j++) if (list[j].seg <= Engine.seg) k = j;
      if (k === this.activeSection) return;
      if (this.outlineEls[this.activeSection]) {
        this.outlineEls[this.activeSection].classList.remove('is-active');
        this.outlineEls[this.activeSection].removeAttribute('aria-current');
      }
      if (this.outlineEls[k]) {
        this.outlineEls[k].classList.add('is-active');
        this.outlineEls[k].setAttribute('aria-current', 'true');
      }
      this.activeSection = k;
    },

    /* ----------------------------------------------------- clip quote */
    clippable(seg) {
      return Boolean(seg) && (/^(p|li|quote|h)$/.test(seg.kind) || ((seg.kind === 'brief' || seg.kind === 'sum') && Boolean(seg.text)));
    },

    /** "Clip quote" rides on the active paragraph's top-right corner. */
    positionClip() {
      const btn = this.els.clipBtn;
      if (!btn) return;
      const el = this.segEls[this.activeSeg];
      const seg = App.script && App.script.segments[this.activeSeg];
      const ok = Boolean(el) && this.clippable(seg) && this.studioVisible();
      btn.hidden = !ok;
      if (!ok) return;
      // Measured against the pill's own container: a Site Briefing line sits inside a dossier card.
      const box = btn.offsetParent || btn.parentElement;
      const top = box ? el.getBoundingClientRect().top - box.getBoundingClientRect().top : el.offsetTop;
      btn.style.top = `${Math.max(0, Math.round(top) - 14)}px`;
    },

    /* ----------------------------------------------------- library cards */
    libCard(e, active, { grid = false } = {}) {
      const pct = Math.round((e.progress || 0) * 100);
      const status = progressLabel(e);
      const accent = (Array.isArray(e.accent) && e.accent.length === 3 ? e.accent : DEFAULT_ACCENT).map((n) => clamp(Math.round(Number(n) || 0), 0, 255)).join(' ');
      const queued = grid && Queue.has(e.id);
      return `<li>
        <div class="sv-libcard${active ? ' is-active' : ''}" role="button" tabindex="0" data-id="${esc(e.id)}" style="--card:${esc(accent)}" aria-label="${esc(`${e.siteName}: ${e.title}. ${status}`)}">
          ${logoMarkup(e.logos, e.siteName, 'size-11 rounded-[0.85rem]')}
          <div class="min-w-0 flex-1 pr-5">
            <div class="sv-libcard-site">${esc(e.siteName)}${e.kind === 'selection' ? ' · selection' : e.mode === 'briefing' ? ' · Site Briefing' : e.mode === 'summary' ? ' · Page Summary' : ''}${active ? '<span class="sv-eq" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</div>
            <div class="sv-libcard-title" dir="auto">${esc(e.title)}</div>
            <div class="sv-libcard-bar"><span style="width:${e.completed ? 100 : pct}%"></span></div>
            <div class="sv-libcard-meta">${esc(status)} · ${esc(fmtAgo(e.updatedAt || Date.now()))}</div>
            ${grid ? `<button type="button" class="sv-libcard-queue${queued ? ' is-queued' : ''}" data-queue="${esc(e.id)}" aria-pressed="${queued}" aria-label="${esc(`${queued ? 'Remove from' : 'Add to'} Up Next: ${e.title}`)}">${icon(queued ? 'check' : 'list-plus', 'size-3')}${queued ? 'Queued' : 'Queue'}</button>` : ''}
          </div>
          <button type="button" class="sv-libcard-del" data-del="${esc(e.id)}" aria-label="${esc(`Remove ${e.title} from the library`)}" title="Remove">${icon('x', 'size-3.5')}</button>
        </div>
      </li>`;
    },

    renderLibrary() {
      const q = (this.els.libSearch.value || '').trim().toLowerCase();
      const activeId = App.entryId;
      const list = Library.entries.filter((e) => !q || `${e.title} ${e.siteName} ${e.hostname || ''}`.toLowerCase().includes(q));
      this.els.libList.innerHTML = list.map((e) => this.libCard(e, e.id === activeId)).join('');
      this.els.libList.hidden = !list.length;
      this.els.libEmpty.hidden = list.length > 0;
      this.els.libEmptyText.textContent = Library.entries.length && q ? `No saved websites match “${q}”.` : 'Every website you listen to is saved here with its logo, brand colour and exact resume point.';
      this.els.libCount.hidden = !Library.entries.length;
      this.els.libCount.textContent = String(Library.entries.length);
      this.syncSidebar();
      const recent = Library.entries.slice(0, 4);
      this.els.recentWrap.hidden = !recent.length;
      DataUI.renderNotice();
      this.els.recentList.innerHTML = recent.map((e) => this.libCard(e, e.id === activeId)).join('');
      if (this.tab === 'saved') this.renderSavedGrid();
    },

    renderSaved() {
      this.renderSavedGrid();
      this.renderQueue();
      this.renderClips();
    },

    renderSavedGrid() {
      const q = (this.els.savedSearch.value || '').trim().toLowerCase();
      const list = Library.entries.filter((e) => !q || `${e.title} ${e.siteName} ${e.hostname || ''}`.toLowerCase().includes(q));
      this.els.savedGrid.innerHTML = list.map((e) => this.libCard(e, e.id === App.entryId, { grid: true })).join('');
      this.els.savedCount.textContent = Library.entries.length ? String(Library.entries.length) : '';
      this.els.savedEmpty.hidden = list.length > 0;
      this.els.savedEmpty.textContent = Library.entries.length && q ? `No memory cards match “${q}”.` : 'No saved sites yet. Read anything from the Studio tab and it appears here with its logo and resume point.';
    },

    renderQueue() {
      const list = Queue.list();
      this.els.queueCount.hidden = !list.length;
      this.els.queueCount.textContent = String(list.length);
      this.els.queueEmpty.hidden = list.length > 0;
      this.els.queueList.innerHTML = list
        .map((q, i) => {
          const entry = q.id ? Library.get(q.id) : null;
          const title = (entry && entry.title) || q.title || q.url;
          const site = (entry && entry.siteName) || q.site || siteLabel(hostOf(q.url));
          const logos = (entry && entry.logos) || q.logos || [];
          return `<li class="sv-queue-item" data-key="${esc(q.key)}">
            <span class="sv-queue-n">${String(i + 1).padStart(2, '0')}</span>
            ${logoMarkup(logos, site, 'size-8 rounded-lg')}
            <div class="min-w-0 flex-1"><p class="line-clamp-2 text-[0.8rem] font-bold leading-snug">${esc(title)}</p><p class="sv-mono truncate text-[0.6rem] uppercase text-black/50">${esc(site)}</p></div>
            <button type="button" class="sv-iconbtn size-7" data-qact="play" aria-label="${esc(`Play ${title} now`)}" title="Play now">${icon('play', 'sv-filled size-3.5')}</button>
            <button type="button" class="sv-iconbtn size-7" data-qact="up" aria-label="Move up" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up', 'size-3.5')}</button>
            <button type="button" class="sv-iconbtn size-7" data-qact="down" aria-label="Move down" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 'size-3.5')}</button>
            <button type="button" class="sv-iconbtn size-7" data-qact="remove" aria-label="${esc(`Remove ${title} from Up Next`)}" title="Remove">${icon('x', 'size-3.5')}</button>
          </li>`;
        })
        .join('');
    },

    renderClips() {
      const list = Clips.list();
      this.els.clipEmpty.hidden = list.length > 0;
      this.els.btnClipsCopy.disabled = !list.length;
      this.els.clipList.innerHTML = list
        .slice(0, 60)
        .map((c) => {
          const url = safeHttpUrl(c.url);
          return `<li class="sv-clip-item" data-clip="${esc(c.id)}">
            <blockquote dir="auto">${esc(quoted(c.text))}</blockquote>
            <p class="sv-clip-src">— ${esc(c.title)}${c.site && c.site !== c.title ? ` · ${esc(c.site)}` : ''} · ${esc(fmtAgo(c.at || Date.now()))}</p>
            <div class="mt-2.5 flex flex-wrap gap-1.5">
              <button type="button" class="sv-mini-btn" data-cact="copy">${icon('copy', 'size-3')}Copy</button>
              ${c.entryId && Library.get(c.entryId) ? `<button type="button" class="sv-mini-btn" data-cact="listen">${icon('play', 'sv-filled size-3')}Listen</button>` : ''}
              ${url ? `<a class="sv-mini-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-open-original>${icon('arrow-up-right', 'size-3')}Source</a>` : ''}
              <button type="button" class="sv-mini-btn" data-cact="delete">${icon('trash-2', 'size-3')}Delete</button>
            </div>
          </li>`;
        })
        .join('');
    },

    updateLibraryCard(entry) {
      for (const card of document.querySelectorAll(`[data-id="${CSS.escape(entry.id)}"]`)) {
        const pct = Math.round((entry.progress || 0) * 100);
        const bar = card.querySelector('.sv-libcard-bar span');
        const meta = card.querySelector('.sv-libcard-meta');
        if (bar) bar.style.width = `${entry.completed ? 100 : pct}%`;
        if (meta) meta.textContent = `${progressLabel(entry)} · just now`;
      }
    },

    renderTabCard() {
      const el = this.els.tabCard;
      const tab = this.tabInfo;
      if (Host.mode !== 'extension' || !tab) {
        el.hidden = true;
        return;
      }
      const reading = App.raw && App.raw.source === 'tab' && App.raw.tabUrl && App.raw.tabUrl === tab.url;
      if (reading && !this.els.studio.hidden) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      if (tab.needsAccess) {
        // No site access, and not a tab you clicked SiteVocal on: Chrome hides even its address until you allow it.
        el.innerHTML = `
        <div class="sv-glass sv-tab-access flex items-center gap-3 rounded-[1.1rem] p-3 pl-3.5">
          <span class="grid size-9 shrink-0 place-items-center rounded-[0.7rem] bg-black/[0.05] text-black/55">${icon('lock', 'size-4')}</span>
          <div class="min-w-0 flex-1">
            <p class="sv-eyebrow">SiteVocal can’t see this tab yet</p>
            <p class="text-sm font-semibold leading-snug">${esc(tab.reason || 'Click the SiteVocal icon on this tab, or allow SiteVocal on all sites.')}</p>
          </div>
          <button type="button" class="sv-btn-primary shrink-0 !px-3.5 !py-2.5 text-[0.84rem]" data-action="allow-access" title="Chrome asks you first; take it back any time">${icon('shield-check', 'size-4')}Allow all sites</button>
        </div>`;
        return;
      }
      const fav = safeImageUrl(tab.favIconUrl);
      const host = bareHost(hostOf(tab.url)) || 'This tab';
      el.innerHTML = `
        <div class="sv-glass flex items-center gap-3 rounded-[1.1rem] p-3 pl-3.5">
          ${fav ? `<span class="sv-logo size-9 rounded-[0.7rem]"><img src="${esc(fav)}" alt="" data-fallbacks="[]" referrerpolicy="no-referrer"></span>` : `<span class="sv-logo is-letter size-9 rounded-[0.7rem]" data-letter="${esc(host.charAt(0).toUpperCase())}"></span>`}
          <div class="min-w-0 flex-1">
            <p class="sv-eyebrow truncate">${tab.readable ? 'Current tab' : 'Can’t read this tab'}</p>
            <p class="truncate text-sm font-semibold" title="${esc(tab.title || host)}">${esc(tab.readable ? tab.title || host : tab.reason || 'This page is protected by the browser.')}</p>
          </div>
          <button type="button" class="sv-btn-primary shrink-0 !px-3.5 !py-2.5 text-[0.84rem]" data-action="read-tab" ${tab.readable ? '' : 'disabled'}>${icon('play', 'sv-filled size-4')}Read this tab</button>
        </div>`;
    },

    populateVoices() {
      const sel = this.els.voiceSel;
      const lang = (App.script && App.script.lang) || normLang(navigator.language) || 'en';
      const ranked = Voices.ranked(lang);
      if (!ranked.length) {
        sel.innerHTML = '<option value="auto">Default voice</option>';
        sel.title = 'No voices reported yet by this browser';
        this.renderStatus();
        return;
      }
      const best = ranked[0];
      const match = ranked.filter((v) => Voices.matches(v, lang));
      const other = ranked.filter((v) => !Voices.matches(v, lang)).sort((a, b) => String(a.lang).localeCompare(String(b.lang)) || String(a.name).localeCompare(String(b.name)));
      const opt = (v) => `<option value="${esc(v.voiceURI)}">${esc(Voices.short(v))} · ${esc(v.lang)}${v.localService === false ? ' · online' : ' · on-device'}</option>`;
      sel.innerHTML =
        `<option value="auto">Auto · ${esc(Voices.short(best))}</option>` +
        (match.length ? `<optgroup label="Best for ${esc(langName(lang))}">${match.map(opt).join('')}</optgroup>` : '') +
        (other.length ? `<optgroup label="Other languages">${other.map(opt).join('')}</optgroup>` : '');
      const pref = Settings.data.voiceURI;
      sel.value = pref !== 'auto' && Voices.find(pref) ? Voices.find(pref).voiceURI : 'auto';
      sel.title = `Voice: ${(Engine.voice && Engine.voice.name) || best.name}`;
      this.renderStatus();
    },

    /* ----------------------------------------------------- lexicon (docs) */
    renderLexicon() {
      const list = Lexicon.entries;
      this.els.lexCount.textContent = plural(list.length, 'word');
      this.els.lexList.innerHTML = list.length
        ? list.map((e) => `<tr><td>${esc(e.from)}</td><td>${e.to ? esc(e.to) : '<span class="text-black/40">(silent)</span>'}</td><td class="w-10 text-right"><button type="button" class="sv-iconbtn size-8" data-lexdel="${esc(e.from)}" aria-label="${esc(`Remove ${e.from}`)}" title="Remove">${icon('trash-2', 'size-4')}</button></td></tr>`).join('')
        : '<tr><td colspan="3" class="sv-empty !font-sans !font-normal">No custom pronunciations yet.</td></tr>';
      this.previewLexicon();
    },

    previewLexicon() {
      const text = this.els.lexTest.value.trim();
      this.els.lexPreview.textContent = text ? Clean.speech(Clean.display(text), { lexicon: true }) : '…';
      this.els.lexState.textContent = Settings.data.filters.lexicon ? 'Smart Lexicon is on' : 'Smart Lexicon is off — turn it on in the Reader’s filter bar';
    },

    /** "Hear it": one utterance with the current voice. Pauses the article first so voices never overlap. */
    hearLexicon() {
      const text = this.els.lexPreview.textContent;
      const synth = window.speechSynthesis;
      if (!synth || !text || text === '…') return;
      if (Engine.state === 'playing') Engine.pause();
      Engine.cancelSynth();
      const u = new SpeechSynthesisUtterance(text);
      const voice = Engine.voice || Voices.resolve(Settings.data.voiceURI, 'en');
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = Engine.rate || 1;
      window.__siteVocalPreview = u;
      setTimeout(() => {
        try {
          synth.speak(u);
        } catch {
          /* speech engine unavailable */
        }
      }, 90);
    },

    /* ------------------------------------- honest telemetry: the privacy panel
     * The dock's shield is green only when the voice runs on this device; an online voice turns it amber,
     * names the vendor that receives the text, and offers the on-device switch. Never "0 bytes" before
     * we know which voice the browser will use. */
    renderStatus() {
      const lang = (App.script && App.script.lang) || normLang(navigator.language) || 'en';
      const voice = Engine.voice || Voices.resolve(Settings.data.voiceURI, lang);
      const turbo = Turbo.voiceActive();
      const local = !turbo && Boolean(voice) && Voices.isLocal(voice);
      const alt = !local && Voices.bestLocal(lang);
      const state = turbo ? 'cloud' : !voice ? 'unknown' : local ? 'local' : 'cloud';
      let title;
      let desc;
      let action = '';
      if (turbo) {
        // Your own Turbo Engine key: say exactly where the text goes, and how much has gone.
        title = `Turbo Engine · text sent to ${Turbo.voiceHost()}`;
        desc = `${Turbo.voiceName()} with your own key: each sentence is sent to ${Turbo.voiceHost()} (${fmtBytes(Turbo.bytes)} so far this session).`;
        action = `<button type="button" class="sv-privacy-action" data-action="turbo-off">${icon('shield-check', 'size-3.5')}Use on-device voice</button>`;
      } else if (!voice) {
        title = !window.speechSynthesis ? 'No speech engine in this browser' : Voices.loaded ? 'Browser default voice' : 'Detecting voices…';
        desc = !window.speechSynthesis ? 'This browser has no Web Speech API, so SiteVocal can show the text but cannot speak.' : 'SiteVocal shows exactly where your text goes once the browser reports its voices.';
      } else if (local) {
        title = 'Local Engine · 0 bytes sent to the cloud';
        desc = `${voice.name} runs on this device — the article never leaves your computer.`;
      } else {
        const vendor = Voices.vendor(voice);
        title = `Cloud voice · text sent to ${vendor}`;
        desc = `${voice.name} is an online voice: your browser sends each sentence to ${vendor}’s speech service.`;
        if (alt) action = `<button type="button" class="sv-privacy-action" data-action="local-voice">${icon('shield-check', 'size-3.5')}Use on-device voice</button>`;
      }
      const glyph = state === 'cloud' ? 'cloud' : 'shield-check';
      this.els.stCloud.className = `sv-privacy-head is-${state}`;
      this.els.stCloud.innerHTML = `<span class="sv-privacy-icon">${icon(glyph, 'size-5')}</span><span class="sv-privacy-title">${esc(title)}</span><span class="sv-privacy-desc">${esc(desc)}</span>${action}`;
      const btn = this.els.btnPrivacy;
      const label = state === 'local' ? 'Local Engine: on-device voice, 0 bytes sent to the cloud' : turbo ? `Turbo Engine voice: your text is sent to ${Turbo.voiceHost()}` : state === 'cloud' ? `Cloud voice: your text is sent to ${Voices.vendor(voice)}` : 'Voice privacy';
      btn.className = `sv-privacy-btn is-${state}`;
      btn.innerHTML = `${icon(glyph, 'size-4')}<span class="sv-privacy-label">Cloud</span>`;
      btn.title = label;
      btn.setAttribute('aria-label', `${label} · privacy and listening stats`);
      const s = Stats.get();
      this.els.stAds.innerHTML = `<b>${fmtNumber(s.ads)}</b> ads stripped`;
      this.els.stAds.title = `${fmtNumber(s.clutter)} clutter nodes stripped too, across ${plural(s.pages, 'page')}`;
      this.renderWords(s.words);
      // Extension: which tabs SiteVocal may read, with the one click that changes it.
      const ext = Host.mode === 'extension';
      this.els.stAccess.hidden = !ext;
      if (ext) {
        this.els.stAccess.innerHTML = Ext.access
          ? `${icon('globe', 'size-4')}<span>Site access: <b>all sites</b></span><button type="button" class="sv-privacy-mini" data-action="remove-access">Remove</button>`
          : `${icon('globe', 'size-4')}<span>Site access: <b>only tabs you click</b></span><button type="button" class="sv-privacy-mini" data-action="allow-access">Allow all</button>`;
      }
    },

    renderWords(words = Stats.get().words) {
      if (words === this.wordsShown) return;
      this.wordsShown = words;
      this.els.stWords.innerHTML = `<b>${fmtNumber(words)}</b> words spoken · unlimited`;
    },

    toast(message, { type = 'info', action = null, timeout = 4200 } = {}) {
      const el = document.createElement('div');
      el.className = `sv-toast sv-toast--${type}`;
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      el.innerHTML = `${icon(type === 'error' ? 'triangle-alert' : type === 'success' ? 'circle-check' : 'info', 'size-4 shrink-0')}<span class="min-w-0 flex-1">${esc(message)}</span>${action ? `<button type="button" class="sv-toast-action">${esc(action.label)}</button>` : ''}<button type="button" class="sv-toast-x" aria-label="Dismiss">${icon('x', 'size-3.5')}</button>`;
      const close = () => {
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 260);
      };
      el.querySelector('.sv-toast-x').addEventListener('click', close);
      if (action) {
        el.querySelector('.sv-toast-action').addEventListener('click', () => {
          close();
          action.fn();
        });
      }
      this.els.toasts.append(el);
      while (this.els.toasts.children.length > 3) this.els.toasts.firstElementChild.remove();
      setTimeout(close, action ? timeout + 3000 : timeout);
    },
  };

  /* ------------------------------------- Docs & Lexicon → ⚡ Turbo Engine (optional keys, saved on change) */
  const TurboUI = {
    els: null,
    fields: null,

    init() {
      const $ = (id) => document.getElementById(id);
      const form = $('turboForm');
      if (!form) return;
      this.els = { form, state: $('turboState'), saved: $('turboSaved'), ai: $('turboAiState'), download: $('btnTurboDownload'), test: $('btnTurboTest'), clear: $('btnTurboClear'), onDevice: $('turboOnDevice') };
      this.fields = {
        fishKey: $('turboFishKey'),
        fishVoice: $('turboFishVoice'),
        fishModel: $('turboFishModel'),
        ttsUrl: $('turboTtsUrl'),
        ttsKey: $('turboTtsKey'),
        ttsModel: $('turboTtsModel'),
        ttsVoice: $('turboTtsVoice'),
        llmUrl: $('turboLlmUrl'),
        llmKey: $('turboLlmKey'),
        llmModel: $('turboLlmModel'),
        jinaKey: $('turboJinaKey'),
        tinyfishKey: $('turboTinyfishKey'),
      };
      this.fill();
      let timer = 0;
      form.addEventListener('input', (ev) => {
        if (ev.target.type === 'radio' || ev.target.type === 'checkbox') return;
        clearTimeout(timer);
        timer = setTimeout(() => this.commit(), 400);
      });
      form.addEventListener('change', () => {
        clearTimeout(timer);
        this.commit();
      });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        this.commit();
      });
      this.els.test.addEventListener('click', () => this.test());
      this.els.clear.addEventListener('click', () => {
        Turbo.clearKeys();
        this.fill();
        this.sync();
        UI.renderStatus();
        UI.toast('Turbo Engine keys cleared — back to 0 bytes sent to the cloud.', { type: 'success', timeout: 2600 });
      });
      this.els.download.addEventListener('click', () => this.download());
      // Chrome settles whether this device can run its on-device model a moment after launch: ask again on open.
      const details = $('turbo');
      if (details) details.addEventListener('toggle', () => details.open && AiSummary.probe().then(() => this.sync()));
      this.sync();
    },

    picked(name) {
      const r = this.els.form.querySelector(`input[name="${name}"]:checked`);
      return r ? r.value : 'off';
    },

    fill() {
      const c = Turbo.cfg;
      for (const [k, el] of Object.entries(this.fields)) if (el) el.value = c[k] || '';
      for (const r of this.els.form.querySelectorAll('input[name="turboVoice"]')) r.checked = r.value === c.voice;
      for (const r of this.els.form.querySelectorAll('input[name="turboLlm"]')) r.checked = r.value === c.llm;
      for (const r of this.els.form.querySelectorAll('input[name="turboReader"]')) r.checked = r.value === c.reader;
      this.els.onDevice.checked = c.onDevice;
      this.groups();
    },

    groups() {
      const voice = this.picked('turboVoice');
      const llm = this.picked('turboLlm');
      const reader = this.picked('turboReader');
      for (const el of this.els.form.querySelectorAll('[data-turbo]')) el.hidden = !(el.dataset.turbo === voice || (el.dataset.turbo === 'llm' && llm === 'openai') || el.dataset.turbo === reader);
    },

    commit() {
      const patch = { voice: this.picked('turboVoice'), llm: this.picked('turboLlm'), reader: this.picked('turboReader'), onDevice: this.els.onDevice.checked };
      for (const [k, el] of Object.entries(this.fields)) if (el) patch[k] = el.value.trim();
      // An empty endpoint, model or voice means the default one (the key never has a default).
      for (const k of ['fishModel', 'ttsUrl', 'ttsModel', 'ttsVoice', 'llmUrl', 'llmModel']) if (!patch[k]) patch[k] = TURBO_DEFAULTS[k];
      Turbo.save(patch);
      this.groups();
      this.sync();
      UI.renderStatus();
      // A remote endpoint over plain http would carry your key and text unencrypted: it is saved but never used.
      const insecure = [patch.voice === 'openai' && patch.ttsKey && !secureEndpoint(patch.ttsUrl) ? patch.ttsUrl : '', patch.llm === 'openai' && patch.llmKey && !secureEndpoint(patch.llmUrl) ? patch.llmUrl : ''].filter(Boolean);
      this.els.saved.textContent = insecure.length
        ? `Not used: ${insecure.map((u) => hostOf(u) || 'that address').join(' and ')} needs an https:// address (plain http:// only for a server on this computer or your network)`
        : Turbo.anyKey()
          ? 'Saved on this device · cloud on'
          : Turbo.readerKind()
            ? `Saved on this device · pages via ${Turbo.readerHost()}`
            : 'Saved · nothing is sent';
    },

    sync() {
      if (!this.els) return;
      const any = Turbo.anyKey();
      const hosts = [...new Set([Turbo.voiceReady() ? Turbo.voiceHost() : '', Turbo.llmReady() ? Turbo.llmHost() : ''].filter(Boolean))];
      this.els.state.className = `sv-turbo-state ${any ? 'is-cloud' : 'is-local'}`;
      this.els.state.innerHTML = any
        ? `${icon('cloud', 'size-3.5')}<span>Cloud · ${esc(hosts.join(' + '))}${Turbo.bytes ? ` · ${esc(fmtBytes(Turbo.bytes))} sent` : ''}</span>`
        : `${icon('shield-check', 'size-3.5')}<span>0 Bytes Sent to Cloud</span>`;
      const s = AiSummary.state;
      this.els.ai.textContent = s === 'available' ? 'ready on this device' : s === 'downloadable' ? 'not downloaded yet' : s === 'downloading' ? 'downloading…' : s === 'unknown' ? 'checking…' : 'not available in this browser';
      this.els.download.hidden = s !== 'downloadable';
      this.els.test.disabled = !Turbo.voiceReady();
      UI.refreshSummarize();
    },

    async test() {
      if (!Turbo.voiceReady()) {
        UI.toast('Choose Fish Audio or an OpenAI-compatible voice and paste a key first.', { type: 'info' });
        return;
      }
      Turbo.voiceOff = false;
      this.els.test.disabled = true;
      try {
        // In the extension Chrome asks once before SiteVocal may reach your voice service: this click is that request.
        if (Host.mode === 'extension') await Ext.allowHost(Turbo.cfg.voice === 'fish' ? FISH_TTS : Turbo.cfg.ttsUrl.trim());
        const url = await Turbo.audioUrl('This is your Turbo Engine voice, reading for SiteVocal.');
        const a = new Audio(url);
        await a.play();
        UI.toast(`Turbo voice works · ${Turbo.voiceName()}.`, { type: 'success', timeout: 2400 });
      } catch (err) {
        Turbo.voiceFailed(err);
      } finally {
        this.sync();
        UI.renderStatus();
      }
    },

    async download() {
      const btn = this.els.download;
      if (!btn) return;
      btn.disabled = true;
      try {
        await AiSummary.download((loaded) => {
          btn.textContent = `Downloading the on-device AI… ${Math.round((loaded || 0) * 100)}%`;
        });
        UI.toast('Your browser’s on-device AI is ready: ✨ Summarize Page uses it now, and nothing leaves this device.', { type: 'success' });
      } catch (err) {
        UI.toast(`The browser could not download its on-device AI: ${(err && err.message) || err}.`, { type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Download the on-device AI (free, private)';
        this.sync();
      }
    },
  };
  /* ------------------------------------------------------------ controller */
  // 📖 Full Page Read · ⚡ Site Briefing · ✨ Summarize Page
  const MODES = ['read', 'briefing', 'summary'];
  const modeOf = (m) => (MODES.includes(m) ? m : 'read');

  const App = {
    raw: null,
    script: null,
    entryId: null,
    lastUrl: '',
    loadSeq: 0,
    abort: null,
    lastPersist: 0,
    savedKey: '',
    accentSource: '',
    advanceTimer: 0,
    mode: 'read', // 'read' (📖 Full Page Read), 'briefing' (⚡ Site Briefing) or 'summary' (✨ Summarize Page)
    sumToken: null, // set while an on-device / Turbo summarizer is writing

    cancelLoad() {
      this.loadSeq++;
      if (this.abort) this.abort.abort();
      this.abort = null;
      UI.setLoadingStage('');
      if (this.script) {
        this.showCurrent();
      } else {
        UI.showLanding({ focus: true });
      }
    },

    showCurrent() {
      UI.showStudio();
      UI.els.loadingCard.hidden = true;
      UI.els.errorCard.hidden = true;
      UI.setAddress(this.raw.url || '');
      UI.renderIdentity(this.raw, this.script);
      UI.renderPrompter(this.script);
      UI.setActive(Engine.seg, Engine.chunk, true);
      UI.setState(Engine.state);
    },

    async openUrl(input, { autoplay = true, id: knownId = '', at = null, mode = null } = {}) {
      const url = normalizeUrl(input);
      if (!url) {
        UI.toast('Please enter a valid http(s) web address.', { type: 'error' });
        return;
      }
      this.lastUrl = url;
      const alias = knownId ? null : Library.entries.find((e) => e.url && normalizeUrl(e.url) === url);
      const id = knownId || (alias && alias.id) || `u_${hash(url)}`;
      const saved = Library.get(id);
      if (saved && saved.hasDoc) {
        const doc = Library.getDoc(id);
        if (doc) {
          this.present(doc, { autoplay, resume: true, at, mode });
          return;
        }
      }
      // In the extension, a page already open in a tab is read live from that tab: no fetch at all.
      if (Host.mode === 'extension') {
        const open = await Host.request('tab:match', { url }, 1500).catch(() => null);
        if (open && typeof open.id === 'number') {
          Ext.readTab({ tabId: open.id, mode, at, info: open });
          return;
        }
      }
      const seq = ++this.loadSeq;
      if (this.abort) this.abort.abort();
      const t0 = performance.now();
      // Fetched (or on its way) since the link was pasted or hovered: attach to that work instead of starting over.
      const early = Prefetch.take(url);
      const ctrl = early ? early.ctrl : new AbortController();
      this.abort = ctrl;
      Engine.pause();
      if (!(early && early.raw)) UI.showLoading(url);
      const live = () => seq === this.loadSeq && !ctrl.signal.aborted;
      const status = (text) => {
        if (seq === this.loadSeq) UI.setLoadingStatus(text);
      };
      const fetched = (res) => {
        if (seq === this.loadSeq) UI.setLoadingStage('extract', `${res.via} · ${Math.round(performance.now() - t0)} ms`);
      };
      try {
        let raw = early && early.raw;
        if (early && !raw) {
          early.watch({ status, fetched });
          raw = await early.promise;
        }
        if (!raw) raw = await this.fetchRaw(url, { signal: ctrl.signal, status, fetched, live });
        if (seq !== this.loadSeq) return;
        status('Synthesizing the broadcast script…');
        raw.id = id;
        raw.loadMs = Math.round(performance.now() - t0);
        this.present(raw, { autoplay, resume: true, at, mode });
      } catch (err) {
        if (ctrl.signal.aborted || seq !== this.loadSeq) return;
        console.warn('[SiteVocal] load failed', err);
        UI.showError(err, url);
      }
    },

    /**
     * A pasted URL as a document: a site adapter (GitHub, Wikipedia, Hacker News), else the page race, then the
     * extractor. Shared by Listen and the prefetch. `fetched` fires once the HTML is in hand; `live` turns false
     * when the load is no longer wanted.
     */
    async fetchRaw(url, { signal, status = () => {}, fetched = () => {}, live = () => !signal.aborted }) {
      const u = new URL(url);
      const adapter = Adapters.find((a) => a.test(u));
      if (adapter) {
        try {
          const raw = await adapter.load(u, { signal, status });
          if (raw) return raw;
        } catch (err) {
          if (signal.aborted) throw err;
          console.warn(`[SiteVocal] ${adapter.id} API failed, falling back to the page itself`, err);
        }
      }
      let res = await Fetcher.html(url, { signal, onStatus: status });
      // Redirect stubs (link shorteners, tracking and AMP links) that only carry a <meta http-equiv="refresh">.
      for (let hop = 0; hop < 2 && live(); hop++) {
        const next = metaRefreshTarget(res.html, res.finalUrl || url);
        if (!next) break;
        status('Following the page’s redirect…');
        res = await Fetcher.html(next, { signal, onStatus: status });
      }
      if (!live()) throw abortError();
      fetched(res);
      status('Ad-Shield, then Mozilla Readability…');
      // One frame for the stage pill to paint before the parse takes the thread.
      await yieldFrame();
      if (!live()) throw abortError();
      return Extractor.fromHtml(res.html, res.finalUrl || url, { via: res.via, source: 'url' });
    },

    openText(text, title) {
      const raw = Extractor.fromText(text, title);
      if (!raw.blocks.length) {
        UI.toast('There is no readable text there.', { type: 'error' });
        return;
      }
      raw.id = `t_${hash(raw.blocks.map((b) => b.text).join('\n'))}`;
      UI.els.pasteText.value = '';
      UI.els.pasteTitle.value = '';
      UI.els.pasteForm.hidden = true;
      this.present(raw, { autoplay: true, resume: true });
    },

    openEntry(id, { at = null, autoplay = true } = {}) {
      const entry = Library.get(id);
      if (!entry) {
        UI.toast('That saved site is no longer in your library.', { type: 'error' });
        return;
      }
      if (id === this.entryId && this.script) {
        this.showCurrent();
        if (at) Engine.jump(clamp(at.seg || 0, 0, this.script.segments.length - 1), at.chunk || 0, { play: true });
        else if (Engine.state !== 'playing' && autoplay) Engine.play();
        return;
      }
      const doc = entry.hasDoc ? Library.getDoc(id) : null;
      if (doc) {
        this.present(doc, { autoplay, resume: true, at });
        return;
      }
      if (entry.url) {
        Library.patch(id, { hasDoc: false }, false);
        this.openUrl(entry.url, { id, autoplay, at });
        return;
      }
      UI.toast('This saved text is no longer stored on this device.', { type: 'error' });
    },

    /** The segment a "start from here" anchor (or a re-synced paragraph) points at. */
    findAnchor(script, anchor) {
      const want = norm(anchor && anchor.text).slice(0, 80);
      if (want.length < 6) return null;
      const segs = script.segments;
      let seg = segs.findIndex((s) => s.kind !== 'intro' && s.kind !== 'outro' && norm(s.text).startsWith(want));
      if (seg < 0) seg = segs.findIndex((s) => s.kind !== 'intro' && s.kind !== 'outro' && norm(s.text).length > 5 && (norm(s.text).includes(want.slice(0, 40)) || want.startsWith(norm(s.text).slice(0, 40))));
      if (seg < 0) return null;
      let chunk = 0;
      const sel = norm(anchor.sel).slice(0, 20);
      if (sel) {
        const s = segs[seg];
        const i = s.chunks.findIndex((c) => c.end > c.start && norm(s.text.slice(c.start, c.end)).includes(sel));
        if (i >= 0) chunk = i;
      }
      return { seg, chunk };
    },

    buildScript(raw, mode = this.mode) {
      const opts = { rate: Settings.data.rate, cps: Engine.cps, filters: Settings.data.filters };
      if (mode === 'summary' && Briefing.available(raw)) return Synth.summary(raw, opts);
      return mode === 'briefing' && Briefing.available(raw) ? Synth.briefing(raw, opts) : Synth.build(raw, opts);
    },

    /**
     * Which way to hear a page: an explicit choice (the mode switch, the Company demo, "Start From Here"),
     * then the listener's own last choice for this page, then auto-detection (homepages, /pricing, /about
     * and marketing landing pages open as a Site Briefing). Pages saved before Site Briefing stay a full read.
     */
    pickMode(raw, prev, explicit) {
      if (!Briefing.available(raw)) return 'read';
      if (MODES.includes(explicit)) return explicit;
      if (prev) return modeOf(prev.mode);
      return Briefing.of(raw).auto ? 'briefing' : 'read';
    },

    /** Where each listening mode of a library entry left off: its own position, plus the other modes' (alts). */
    positions(entry) {
      const out = { ...((entry && entry.alts) || {}) };
      if (entry && entry.alt && MODES.includes(entry.alt.mode) && !out[entry.alt.mode]) out[entry.alt.mode] = entry.alt;
      if (entry) out[modeOf(entry.mode)] = { mode: modeOf(entry.mode), seg: entry.seg || 0, chunk: entry.chunk || 0, progress: entry.progress || 0, paragraph: entry.paragraph || 0, completed: Boolean(entry.completed) };
      return out;
    },

    /** Show a document: brand theme, identity card, teleprompter, library entry, voice — then play. */
    present(raw, { autoplay = false, resume = true, at = null, anchor = null, refreshDoc = false, mode = null } = {}) {
      // How long a fresh load took (shown once as "Ready · 412 ms"); never stored with the document.
      const loadMs = raw.loadMs;
      delete raw.loadMs;
      this.loadSeq++;
      this.sumToken = null;
      if (this.abort) this.abort.abort();
      this.abort = null;
      clearTimeout(this.advanceTimer);
      const id = raw.id || (raw.url ? `u_${hash(raw.url)}` : `t_${hash(raw.title)}`);
      const prev = Library.get(id);
      // "Start From Here" (an anchor) means the full text — unless a mode is asked for, as a re-sync does.
      let want = this.pickMode(raw, prev, mode || (anchor ? 'read' : null));
      let script = this.buildScript(raw, want);
      if (!script.bodyCount && Briefing.available(raw)) {
        // Nothing to read in full (a homepage of headlines and buttons): a substantial briefing still is.
        const other = want === 'read' ? 'briefing' : 'read';
        const alt = other === 'read' || Briefing.of(raw).parts >= 2 ? this.buildScript(raw, other) : null;
        if (alt && alt.bodyCount) {
          script = alt;
          want = other;
        }
      }
      if (!script.bodyCount) {
        // Keep the current article intact (paused) so "Back to …" and the play button still work.
        UI.showError(new Error('No readable article text was found on this page.'), raw.url || '');
        return null;
      }
      UI.setLoadingStage(loadMs != null ? 'ready' : '', loadMs != null ? `${loadMs} ms` : '');
      this.saveProgress(true);
      Engine.stop();
      raw.id = id;
      this.raw = raw;
      this.script = script;
      this.entryId = id;
      this.mode = want;

      const accent = this.brand(raw);
      // Each mode keeps its own place: the entry's position is for its mode, alts hold the others (alt: the last one left).
      const here = prev ? { mode: modeOf(prev.mode), seg: prev.seg || 0, chunk: prev.chunk || 0, progress: prev.progress || 0, paragraph: prev.paragraph || 0, completed: Boolean(prev.completed) } : null;
      const places = this.positions(prev);
      const mine = places[want] || null;
      delete places[want];
      const alt = here && here.mode !== want ? here : prev && prev.alt && prev.alt.mode !== want ? prev.alt : null;
      let seg = 0;
      let chunk = 0;
      let jumped = false;
      const target = at || (anchor && this.findAnchor(script, anchor));
      if (target) {
        seg = clamp(target.seg || 0, 0, script.segments.length - 1);
        chunk = clamp(target.chunk || 0, 0, script.segments[seg].chunks.length - 1);
        jumped = true;
      } else if (resume && mine && !mine.completed && mine.seg > 0 && mine.seg < script.segments.length) {
        seg = mine.seg;
        chunk = clamp(mine.chunk || 0, 0, script.segments[seg].chunks.length - 1);
      }
      if (raw.shield && !raw.counted) {
        // Stage 3 telemetry: count each extraction once (a saved copy re-opened later is not re-counted).
        Stats.add({ ads: raw.shield.ads || 0, clutter: raw.shield.clutter || 0, pages: 1 });
        raw.counted = true;
      }
      const now = Date.now();
      const entry = Library.upsert({
        id,
        url: raw.url || '',
        source: raw.source,
        kind: raw.kind,
        siteName: raw.siteName || siteLabel(raw.hostname),
        hostname: raw.hostname || '',
        title: raw.title,
        author: raw.author || '',
        logos: (raw.logos || []).slice(0, 4),
        heroImage: raw.heroImage || '',
        accent,
        lang: script.lang,
        words: script.words,
        minutes: Math.round(script.minutes),
        paragraphs: script.paragraphs,
        seg,
        chunk,
        progress: mine && !mine.completed ? mine.progress || 0 : 0,
        paragraph: script.segments[seg].para || 0,
        completed: false,
        mode: want,
        alt,
        alts: places,
        hasDoc: prev && !refreshDoc ? Boolean(prev.hasDoc) : false,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
      });
      if (!entry.hasDoc) {
        const stored = Library.putDoc(id, { ...raw, savedAt: now, v: 2 });
        Library.patch(id, { hasDoc: stored });
      }
      this.savedKey = `${id}|${seg}.${chunk}`;
      Queue.removeEntry(id, raw.url);

      UI.showStudio();
      // Listening layout (compact header on narrow screens) from the first frame when it will autoplay.
      document.body.classList.toggle('sv-listening', Boolean(autoplay));
      UI.liveCardKey = '';
      UI.setAddress(raw.url || '');
      UI.els.scroller.scrollTop = 0;
      UI.follow = true;
      UI.userScrollAt = 0;
      UI.setDomChanged(null);
      Engine.rate = Settings.data.rate;
      Engine.voice = Voices.resolve(Settings.data.voiceURI, script.lang);
      Engine.load(script, { seg, chunk });
      // The first word before the screen is drawn: speak() runs straight through to speechSynthesis.speak(), and
      // everything below is drawn in the same task, before the browser paints.
      if (autoplay) Engine.play();
      UI.renderIdentity(raw, script);
      UI.renderPrompter(script);
      UI.setNowPlaying(raw);
      UI.renderLibrary();
      UI.renderQueue();
      UI.populateVoices();
      UI.setActive(Engine.seg, Engine.chunk, true);
      UI.setState(Engine.state);
      UI.renderDevtools();
      UI.renderStatus();
      MediaKeys.metadata(raw);
      if (Host.mode !== 'extension' && raw.url && raw.source === 'url') {
        try {
          history.replaceState(null, '', `${location.pathname}?url=${encodeURIComponent(raw.url)}`);
        } catch {
          /* file:// or sandboxed history */
        }
      }
      if (seg > 0 && !jumped) {
        UI.toast(`Resumed at ${UI.paraLabel(script.segments[seg]).toLowerCase()}.`, { type: 'info', action: { label: 'Start over', fn: () => Engine.jump(0, 0, { play: true }) } });
      }
      this.prepareModes(raw);
      return { jumped };
    },

    /**
     * ✨ Summarize Page and ⚡ Site Briefing, scored while the browser is idle (TextRank and the table summaries are the
     * heavy part), so switching mode starts speaking at once instead of computing first.
     */
    prepareModes(raw) {
      const run = () => {
        if (this.raw !== raw) return;
        for (const m of MODES) {
          if (m === this.mode || this.raw !== raw) continue;
          try {
            if (m === 'summary' && Briefing.available(raw)) Summary.plan(raw, { cps: Engine.cps, ai: AiSummary.allowed(raw.summaryAi) ? raw.summaryAi : null });
            else if (m === 'briefing' && Briefing.available(raw)) Briefing.of(raw);
          } catch {
            /* computed again, and reported, when the mode is chosen */
          }
        }
      };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 1500 });
      else setTimeout(run, 300);
    },

    /**
     * Rebuild the script after a sanitizer pill or the dictionary changed, keeping the listener on the
     * same paragraph (segments remember their source block) and the same sentence where it still exists.
     */
    rebuild() {
      if (!this.raw || !this.script || Engine.script !== this.script) return false;
      const cur = this.script.segments[Engine.seg];
      const block = cur ? cur.b : -1;
      const chunk = Engine.chunk;
      const playing = Engine.state === 'playing';
      const ended = Engine.state === 'ended';
      const script = this.buildScript(this.raw);
      if (!script.bodyCount) return false;
      let seg = script.segments.findIndex((s) => s.b >= block);
      if (seg < 0) seg = script.segments.length - 1;
      if (ended) seg = 0;
      this.script = script;
      UI.renderPrompter(script);
      Engine.load(script, { seg, chunk: ended ? 0 : clamp(chunk, 0, script.segments[seg].chunks.length - 1) });
      const mins = document.getElementById('idMinutes');
      if (mins) mins.textContent = UI.listenLabel(script, Engine.totalSeconds());
      UI.setActive(Engine.seg, Engine.chunk, true);
      UI.setState(Engine.state);
      this.savedKey = '';
      Library.patch(this.entryId, { words: script.words, minutes: Math.round(script.minutes), paragraphs: script.paragraphs }, false);
      UI.renderDevtools();
      if (playing) Engine.play();
      return true;
    },

    /** 📖 Full Page Read ↔ ⚡ Site Briefing ↔ ✨ Summarize Page on the open page, in one click. Each mode keeps its own place. */
    setMode(mode) {
      if (!this.raw || !this.script || !MODES.includes(mode)) return false;
      if (mode === this.mode) {
        if (Engine.state !== 'playing') Engine.play();
        return true;
      }
      if (!Briefing.available(this.raw)) return false;
      if (mode === 'summary') return this.summarize();
      this.sumToken = null; // a summary still being written never switches the listener back
      UI.setSummaryBusy(false);
      return this.switchTo(mode, this.buildScript(this.raw, mode));
    },

    /**
     * ✨ Summarize Page. With an on-device summarizer (Chrome's built-in AI) or a Turbo Engine LLM ready, its
     * key points replace the narrative (tables are always summarised by SiteVocal); otherwise — and whenever it
     * fails or takes too long — the built-in TextRank + structural summary plays at once. No key, no cloud.
     */
    summarize() {
      const raw = this.raw;
      if (!raw) return false;
      if (this.sumToken) return true; // already writing one
      const engine = raw.summaryAi && AiSummary.allowed(raw.summaryAi) ? null : AiSummary.ready();
      if (!engine) {
        // The browser has an on-device AI that is not downloaded yet: offer it once a session (it writes far better summaries).
        if (!raw.summaryAi && Turbo.cfg.onDevice && AiSummary.state === 'downloadable' && !this.aiOffered) {
          this.aiOffered = true;
          UI.toast('For a smarter summary, download your browser’s free on-device AI (about 2 GB, one time). It runs on this device and sends nothing anywhere.', { type: 'info', timeout: 9000, action: { label: 'Download', fn: () => TurboUI.download() } });
        }
        return this.switchTo('summary', this.buildScript(raw, 'summary'));
      }
      const seq = this.loadSeq;
      const token = {};
      this.sumToken = token;
      UI.setSummaryBusy(true, engine);
      return AiSummary.run(raw, engine, { timeout: AiSummary.timeoutMs })
        .then((ai) => {
          if (ai) raw.summaryAi = ai;
        })
        .catch((err) => {
          console.warn('[SiteVocal] summarizer failed; using the built-in summary.', err);
          UI.toast(`${AiSummary.label(engine)} couldn’t summarize this page (${(err && err.message) || err}) — playing SiteVocal’s built-in summary.`, { type: 'info', timeout: 4200, action: Ext.reachAction(err) });
        })
        .then(() => {
          if (this.sumToken !== token) return false; // the listener picked another mode meanwhile
          this.sumToken = null;
          UI.setSummaryBusy(false);
          if (this.raw !== raw || this.loadSeq !== seq) return false; // …or another page
          if (raw.summaryAi && this.entryId) Library.putDoc(this.entryId, { ...raw, savedAt: Date.now(), v: 2 });
          return this.switchTo('summary', this.buildScript(raw, 'summary'));
        });
    },

    switchTo(mode, script) {
      if (!script.bodyCount) {
        UI.toast(mode === 'read' ? 'This page has no long-form text to read in full: the Site Briefing covers it.' : mode === 'summary' ? 'There is not enough text on this page to summarize.' : 'There is not enough on this page for a Site Briefing.', { type: 'info' });
        return false;
      }
      this.saveProgress(true);
      const entry = Library.get(this.entryId);
      const ended = Engine.state === 'ended';
      const cur = this.script.segments[Engine.seg];
      const here = { mode: this.mode, seg: ended ? 0 : Engine.seg, chunk: ended ? 0 : Engine.chunk, progress: Engine.fraction(), paragraph: cur ? Math.min(cur.para || 0, this.script.paragraphs) : 0, completed: ended };
      const places = this.positions(entry);
      const back = places[mode] && places[mode].mode === mode ? places[mode] : null;
      places[here.mode] = here;
      delete places[mode];
      let seg = 0;
      let chunk = 0;
      if (back && !back.completed && back.seg > 0 && back.seg < script.segments.length - 1) {
        seg = back.seg;
        chunk = clamp(back.chunk || 0, 0, script.segments[seg].chunks.length - 1);
      }
      this.mode = mode;
      this.script = script;
      // The new mode's first word first: load() stops the old voice, and Chrome's short settle after cancel()
      // runs while the sheet below is drawn.
      Engine.load(script, { seg, chunk });
      Engine.play();
      UI.renderIdentity(this.raw, script);
      UI.renderPrompter(script);
      UI.setNowPlaying(this.raw);
      UI.follow = true;
      UI.userScrollAt = 0;
      UI.setActive(Engine.seg, Engine.chunk, true);
      UI.setState(Engine.state);
      UI.renderDevtools();
      Library.patch(this.entryId, { mode, alt: here, alts: places, seg, chunk, progress: back && !back.completed ? back.progress || 0 : 0, paragraph: script.segments[seg].para || 0, completed: false, words: script.words, minutes: Math.round(script.minutes), paragraphs: script.paragraphs, updatedAt: Date.now() });
      this.savedKey = `${this.entryId}|${seg}.${chunk}`;
      UI.renderLibrary();
      const where = seg > 0 ? ` · back at ${UI.paraLabel(script.segments[seg]).toLowerCase()}` : '';
      const time = fmtListen(Engine.totalSeconds() / 60);
      UI.toast(mode === 'briefing' ? `Site Briefing · ${plural(script.cards.length, 'part')}, ${time}${where}.` : mode === 'summary' ? `Page Summary · ${plural(script.cards.length, 'part')}, ${time}${where}.` : `Full Page Read · ${time}${where}.`, { type: 'info', timeout: 2400 });
      return true;
    },

    setFilter(key, on) {
      if (!(key in FILTERS)) return;
      Settings.setFilter(key, on);
      UI.syncFilters();
      UI.previewLexicon();
      const names = { code: 'Skip Code', tables: 'Skip Tables', citations: 'Skip Citations', lexicon: 'Smart Lexicon' };
      const rebuilt = this.rebuild();
      UI.toast(`${names[key]} ${on ? 'on' : 'off'}${rebuilt ? ' — script rebuilt at the same paragraph.' : '.'}`, { type: 'info', timeout: 2200 });
    },

    /** Clip quote / B: save the sentence being spoken with its source, and copy it as a citation. */
    async clip() {
      const script = this.script;
      const raw = this.raw;
      if (!script || !raw) return;
      const seg = script.segments[Engine.seg];
      if (!UI.clippable(seg)) {
        UI.toast('Clip a sentence of the article — the intro, sign-off, code and tables can’t be clipped.', { type: 'info' });
        return;
      }
      const text = this.sentenceAt(seg, Engine.chunk);
      if (!text) return;
      const clip = Clips.add({
        id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text,
        title: raw.title,
        site: raw.siteName || siteLabel(raw.hostname),
        url: raw.url || '',
        entryId: this.entryId,
        seg: Engine.seg,
        chunk: Engine.chunk,
        at: Date.now(),
      });
      UI.renderClips();
      const copied = await copyText(clipCitation(clip));
      UI.toast(copied ? 'Quote clipped and copied with its source.' : 'Quote clipped to Saved Sites (the browser blocked the clipboard).', { type: 'success', action: { label: 'View clips', fn: () => UI.setTab('saved') } });
    },

    /** The whole sentence being spoken (a long sentence is spoken as several ≤10 s chunks). */
    sentenceAt(seg, chunkIndex) {
      const ch = seg.chunks[chunkIndex];
      if (!ch || ch.end <= ch.start) return seg.text.replace(/\s+/g, ' ').trim();
      let start = ch.start;
      let end = ch.end;
      for (const [s, e] of Clean.sentences(seg.text, (this.script && this.script.lang) || 'en')) {
        if (s <= ch.start && e > ch.start) start = s;
        if (s < ch.end && e >= ch.end) end = e;
      }
      return seg.text.slice(start, end).replace(/\s+/g, ' ').trim();
    },

    /* --------------------------------------------------------- Up Next */
    toggleQueue(id) {
      const entry = Library.get(id);
      if (!entry) return;
      if (Queue.has(id)) {
        Queue.remove(Queue.keyOf({ id }));
        UI.toast(`Removed from Up Next: “${trimText(entry.title, 40)}”.`, { type: 'info' });
      } else {
        Queue.add({ id, url: entry.url || '', title: entry.title, site: entry.siteName, logos: (entry.logos || []).slice(0, 2) });
        UI.toast(`Up Next: “${trimText(entry.title, 40)}”.`, { type: 'success' });
      }
      UI.renderQueue();
      UI.renderSavedGrid();
    },

    queueUrl(url) {
      const known = Library.entries.find((e) => e.url && normalizeUrl(e.url) === url);
      const added = known
        ? Queue.add({ id: known.id, url, title: known.title, site: known.siteName, logos: (known.logos || []).slice(0, 2) })
        : Queue.add({ id: '', url, title: bareHost(hostOf(url)) + new URL(url).pathname.replace(/\/$/, ''), site: siteLabel(hostOf(url)), logos: [s2Favicon(hostOf(url))].filter(Boolean) });
      UI.toast(added ? 'Added to Up Next.' : 'That page is already in Up Next.', { type: added ? 'success' : 'info' });
      UI.renderQueue();
      UI.renderSavedGrid();
    },

    playQueued(key) {
      const item = Queue.list().find((q) => q.key === key);
      if (!item) return;
      Queue.remove(key);
      UI.renderQueue();
      if (item.id && Library.get(item.id)) this.openEntry(item.id);
      else if (item.url) this.openUrl(item.url);
      else UI.toast('That queued text is no longer saved on this device.', { type: 'error' });
    },

    /** When an article ends, the first Up Next item plays after a short, cancellable countdown. */
    advanceQueue() {
      clearTimeout(this.advanceTimer);
      const next = Queue.list()[0];
      if (!next || !Settings.data.autoAdvance) return;
      const entry = next.id ? Library.get(next.id) : null;
      const title = trimText((entry && entry.title) || next.title || next.url, 48);
      let cancelled = false;
      UI.toast(`Up next: “${title}”`, { type: 'info', timeout: 2600, action: { label: 'Cancel', fn: () => {
        cancelled = true;
        clearTimeout(this.advanceTimer);
      } } });
      this.advanceTimer = setTimeout(() => {
        if (!cancelled && Engine.state === 'ended') this.playQueued(next.key);
      }, 2600);
    },

    /** Chameleon theme: theme-color → known brand → colours painted on the page → logo → SiteVocal emerald. */
    brand(raw) {
      const candidates = [raw.themeColor, raw.tileColor, raw.knownColor];
      for (const c of candidates) {
        const rgb = Color.parse(c);
        if (Color.isColorful(rgb)) {
          this.accentSource = 'theme';
          return Theme.apply(rgb);
        }
      }
      for (const c of raw.brandColors || []) {
        const rgb = Color.parse(c && typeof c === 'object' ? c.color : c);
        // A colour seen once or twice (one link, one badge) is not a brand; neither are the browser's defaults.
        const weight = c && typeof c === 'object' && Number.isFinite(c.weight) ? c.weight : Infinity;
        if (!rgb || weight < 1 || UA_COLORS.has(rgb.join(','))) continue;
        if (Color.isColorful(rgb)) {
          this.accentSource = 'page';
          return Theme.apply(rgb);
        }
      }
      if (Array.isArray(raw.accent) && raw.accent.length === 3) {
        this.accentSource = 'saved';
        return Theme.apply(raw.accent);
      }
      const mono = Color.parse(raw.themeColor);
      if (mono && !Color.isColorful(mono)) {
        this.accentSource = 'mono';
        return Theme.apply(mono, true);
      }
      // Nothing to go on yet: SiteVocal's own emerald, refined from the site's logo once one loads.
      this.accentSource = 'default';
      const id = raw.id;
      const accent = Theme.apply(FALLBACK_ACCENT);
      if (raw.kind !== 'text') this.refineBrand(raw, id);
      return accent;
    },

    /** Sample the logo's dominant colour in the background, then morph the theme. */
    async refineBrand(raw, id) {
      for (const src of (raw.logos || []).slice(0, 3)) {
        let rgb = await Color.dominant(src);
        if (!rgb) {
          const data = await Fetcher.imageData(src);
          if (data) rgb = await Color.dominant(data);
        }
        if (rgb) {
          if (this.entryId !== id) return;
          const accent = Theme.apply(rgb);
          raw.accent = accent;
          this.accentSource = 'logo';
          Library.patch(id, { accent });
          Library.putDoc(id, { ...raw, savedAt: Date.now(), v: 2 });
          UI.renderLibrary();
          return;
        }
      }
    },

    setRate(rate) {
      if (!RATES.includes(rate)) return;
      Settings.set({ rate });
      UI.els.rateSel.value = String(rate);
      Engine.setRate(rate);
      UI.updateProgress();
      UI.updateOutlineTimes();
      const mins = document.getElementById('idMinutes');
      if (mins && this.script) mins.textContent = UI.listenLabel(this.script, Engine.totalSeconds());
    },

    setVoice(value) {
      Settings.set({ voiceURI: value });
      const voice = Voices.resolve(value, this.script ? this.script.lang : normLang(navigator.language));
      Engine.setVoice(voice);
      UI.els.voiceSel.title = `Voice: ${voice ? voice.name : 'browser default'}`;
      UI.renderStatus();
      UI.renderDevtools();
      if (voice) UI.toast(`Voice: ${Voices.short(voice)}${Voices.isLocal(voice) ? ' · on-device' : ' · online'}`, { type: 'info', timeout: 1800 });
    },

    /** Status bar → [USE ON-DEVICE VOICE]: the best local voice, so nothing is sent to a cloud TTS. */
    useLocalVoice() {
      const voice = Voices.bestLocal((this.script && this.script.lang) || normLang(navigator.language) || 'en');
      if (!voice) {
        UI.toast('This browser reports no on-device voices.', { type: 'error' });
        return;
      }
      this.setVoice(voice.voiceURI);
      UI.populateVoices();
    },

    /** Another tab or extension surface wrote one of our keys: refresh what shows it. */
    storageChanged(key) {
      if (key === KEYS.library) {
        Library.load();
        UI.renderLibrary();
      } else if (key === KEYS.queue) {
        UI.renderQueue();
        if (UI.tab === 'saved') UI.renderSavedGrid();
      } else if (key === KEYS.clips) {
        UI.renderClips();
      } else if (key === KEYS.lexicon) {
        Lexicon.load();
        if (UI.tab === 'docs') UI.renderLexicon();
      } else if (key === KEYS.stats) {
        UI.renderStatus();
      } else if (key === KEYS.turbo) {
        Turbo.load();
        TurboUI.sync();
        UI.renderStatus();
      }
    },

    saveProgress(force = false) {
      // Only the engine's live position is meaningful (it may already be torn down on unload).
      if (!this.entryId || !this.script || Engine.script !== this.script) return;
      const seg = this.script.segments[Engine.seg];
      const ended = Engine.state === 'ended';
      // Nothing moved here since the last write: don't overwrite progress made in another tab or surface.
      const key = `${this.entryId}|${ended ? 'end' : `${Engine.seg}.${Engine.chunk}`}`;
      if (key === this.savedKey) return;
      const entry = Library.patch(
        this.entryId,
        {
          seg: ended ? 0 : Engine.seg,
          chunk: ended ? 0 : Engine.chunk,
          progress: Engine.fraction(),
          paragraph: seg ? Math.min(seg.para || 0, this.script.paragraphs) : 0,
          completed: ended,
          updatedAt: Date.now(),
        },
        false,
      );
      if (!entry) return;
      UI.updateLibraryCard(entry);
      if (force || Date.now() - this.lastPersist > 2500) {
        Library.persist();
        this.lastPersist = Date.now();
        this.savedKey = key;
        UI.els.statusSaved.hidden = false;
      }
    },
  };

  /* ------------------------------------------------------------- prefetch
   * A page is often ready before you ask for it. SiteVocal starts fetching and extracting a link the moment you
   * paste it (or stop typing it for 250 ms), or when the pointer rests on a Quick Try, Up Next or Library item
   * for 120 ms. Listen then attaches to that work, finished or still on its way, instead of starting over.
   * In memory only: at most 10 pages, each kept 5 minutes. */
  const PREFETCH_TTL = 5 * 60 * 1000;
  const PREFETCH_MAX = 10;
  const PREFETCH_IDLE = 250; // ms of no typing on a valid address
  const PREFETCH_HOVER = 120; // ms the pointer rests on an item

  const Prefetch = {
    entries: new Map(), // normalized URL → { url, why, at, ctrl, promise, raw, watch() }
    typing: null, // the in-flight prefetch started by typing: replaced when the address changes

    /** An address worth fetching ahead: http(s), one word, a host with a real top-level domain (or an IP). */
    url(input) {
      const text = String(input || '').trim();
      if (!text || /\s/.test(text)) return '';
      const url = normalizeUrl(text);
      if (!url) return '';
      const host = hostOf(url);
      return /\.[a-z]{2,}$/i.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? url : '';
    },

    get(url) {
      const entry = this.entries.get(url);
      if (entry && Date.now() - entry.at > PREFETCH_TTL) {
        this.drop(url);
        return null;
      }
      return entry || null;
    },

    /** Listen on this address: hand over its prefetch (finished or in flight) and forget it. */
    take(url) {
      const entry = this.get(url);
      if (!entry) return null;
      this.entries.delete(url);
      if (this.typing === entry) this.typing = null;
      return entry;
    },

    drop(url) {
      const entry = this.entries.get(url);
      if (!entry) return;
      this.entries.delete(url);
      if (this.typing === entry) this.typing = null;
      if (!entry.raw) entry.ctrl.abort();
    },

    /** Start fetching `input` ahead, unless it would open without a fetch anyway (saved, or already open). */
    start(input, why) {
      const url = this.url(input);
      if (!url) return null;
      // Extension without site access: a prefetch would go to a public page service. Only for a link you pasted or
      // typed, once you agreed to that; resting the pointer on an item never sends its address anywhere.
      if (Host.mode === 'extension' && !Ext.access && (why === 'hover' || PageServices.needed())) return null;
      const have = this.get(url);
      if (have) return have;
      if (Library.entries.some((e) => e.hasDoc && e.url && normalizeUrl(e.url) === url)) return null;
      if (App.raw && App.raw.url && normalizeUrl(App.raw.url) === url) return null;
      if (why === 'typing' && this.typing && !this.typing.raw) this.drop(this.typing.url); // the address changed
      const ctrl = new AbortController();
      const entry = { url, why, at: Date.now(), ctrl, raw: null, hooks: {}, last: '', res: null };
      // Listen pressed while it is still on its way: the loading card picks up from where the prefetch is.
      entry.watch = (hooks) => {
        entry.hooks = hooks;
        if (entry.last) hooks.status(entry.last);
        if (entry.res) hooks.fetched(entry.res);
      };
      const status = (text) => {
        entry.last = text;
        if (entry.hooks.status) entry.hooks.status(text);
      };
      const fetched = (res) => {
        entry.res = res;
        if (entry.hooks.fetched) entry.hooks.fetched(res);
      };
      entry.promise = (async () => {
        // In the extension, an address open in a tab is read from the tab when you press Listen: nothing to fetch.
        if (Host.mode === 'extension') {
          const open = await Host.request('tab:match', { url }, 1500).catch(() => null);
          if (open && typeof open.id === 'number') return null;
        }
        return App.fetchRaw(url, { signal: ctrl.signal, status, fetched });
      })().then((raw) => {
        entry.raw = raw;
        return raw;
      });
      // A failed prefetch is simply forgotten: Listen then loads the page as usual (or shows why it failed).
      entry.promise.catch(() => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        if (this.typing === entry) this.typing = null;
      });
      this.entries.set(url, entry);
      if (why === 'typing') this.typing = entry;
      while (this.entries.size > PREFETCH_MAX) this.drop(this.entries.keys().next().value);
      return entry;
    },
  };
  /* ------------------------------------------------- extension integration */
  const Ext = {
    access: false, // site access to every http(s) site; without it, only the tabs you click SiteVocal on
    asking: null, // the Allow all sites dialog while it is open

    init(init) {
      this.access = init.access === true;
      UI.tabInfo = init.tab || null;
      UI.renderTabCard();
      UI.renderStatus();
      const d = document.getElementById('accessDialog');
      document.getElementById('btnAccessContinue').addEventListener('click', () => this.confirmAccess());
      document.getElementById('btnAccessCancel').addEventListener('click', () => this.finishAsking(false));
      d.addEventListener('close', () => this.finishAsking(false));
      d.addEventListener('click', (ev) => {
        if (ev.target === d) this.finishAsking(false);
      });
      Host.on('access:changed', (msg) => {
        this.access = msg.access === true;
        UI.tabInfo = msg.tab || null;
        UI.renderTabCard();
        UI.renderStatus();
        if (DataUI.els && DataUI.els.dialog.open) DataUI.render();
      });
      Host.on('tab:changed', (msg) => {
        UI.tabInfo = msg.tab || null;
        UI.renderTabCard();
      });
      Host.on('request', (msg) => this.handle(msg.request || {}));
      Host.on('dom:changed', (msg) => this.domChanged(msg));
      Host.on('storage:changed', (msg) => {
        if (typeof msg.key !== 'string') return;
        if (msg.value == null) Store.mem.delete(msg.key);
        else Store.mem.set(msg.key, msg.value);
        App.storageChanged(msg.key);
      });
    },

    /** Ask Chrome for site access: every site, or the hosts given (https://api.fish.audio/*). Only from a click. */
    async requestAccess(origins = null) {
      try {
        return (await Host.request('access:request', origins ? { origins } : {}, 120000)) === true;
      } catch {
        return false;
      }
    },

    /** "Allow all sites": SiteVocal says what changes first, then Continue (a click, as Chrome requires) asks Chrome. */
    allowAllSites() {
      const d = document.getElementById('accessDialog');
      if (this.asking) return this.asking.promise;
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      this.asking = { promise, resolve };
      if (typeof d.showModal === 'function' && !d.open) d.showModal();
      return promise;
    },

    /** Continue in the dialog: Chrome is asked inside this click (its rule), then the dialog makes way for its prompt. */
    async confirmAccess() {
      const asking = this.asking;
      this.asking = null;
      const request = this.requestAccess();
      const d = document.getElementById('accessDialog');
      if (d.open) d.close();
      const ok = await request;
      if (asking) asking.resolve(ok);
      UI.toast(ok ? 'SiteVocal can now read the tabs you switch to, and loads links straight from your browser.' : 'Nothing changed: SiteVocal still reads only the tabs you click it on.', { type: ok ? 'success' : 'info', timeout: 3600 });
    },

    finishAsking(ok) {
      const d = document.getElementById('accessDialog');
      const asking = this.asking;
      this.asking = null;
      if (d.open) d.close();
      if (asking) asking.resolve(ok);
    },

    async removeAccess() {
      const ok = await Host.request('access:remove', {}, 10000).then((r) => r === true, () => false);
      UI.toast(ok ? 'Site access removed: SiteVocal reads only the tabs you click it on.' : 'Chrome kept SiteVocal’s site access (it may be set by your organization).', { type: ok ? 'success' : 'info', timeout: 3600 });
      return ok;
    },

    /** One service's host for a Turbo key (Chrome answers at once, without asking, when it is already allowed). */
    allowHost(url) {
      if (this.access) return Promise.resolve(true);
      try {
        const u = new URL(url);
        return /^https?:$/.test(u.protocol) ? this.requestAccess([`${u.protocol}//${u.hostname}/*`]) : Promise.resolve(false);
      } catch {
        return Promise.resolve(false);
      }
    },

    /** A toast action for a service SiteVocal may not reach yet (the error names it): one click asks Chrome. */
    reachAction(err, then = null) {
      const origins = err && err.code === 'needs-access' && Array.isArray(err.origins) ? err.origins.filter(Boolean) : [];
      if (!origins.length) return null;
      return {
        label: 'Allow',
        fn: () =>
          this.requestAccess(origins).then((ok) => {
            if (!ok) return;
            if (then) then();
            UI.toast('Allowed: SiteVocal can reach that service now.', { type: 'success', timeout: 2600 });
          }),
      };
    },

    handle(req) {
      if (req.kind === 'tab') this.readTab({ tabId: req.tabId });
      else if (req.kind === 'selection') this.readTab({ tabId: req.tabId, selection: req.text || '' });
      else if (req.kind === 'here') this.readTab({ tabId: req.tabId, here: true });
      else if (req.kind === 'url' && req.url) App.openUrl(req.url);
    },

    /** The tab we are reading changed under us (SPA route, title, infinite scroll): offer a re-sync, keep playing. */
    domChanged(msg) {
      const raw = App.raw;
      if (!raw || raw.source !== 'tab' || raw.kind === 'selection' || typeof msg.tabId !== 'number' || msg.tabId !== raw.tabId) return;
      UI.setDomChanged(msg);
    },

    /** content.js payload → raw document (Ad-Shield and Readability run here, in the studio). */
    async extract(result) {
      const { payload } = result;
      const info = result.tab || {};
      const raw = await Extractor.fromHtml(payload.html, payload.url, {
        via: 'the open tab',
        source: 'tab',
        title: payload.title,
        lang: payload.lang,
        author: payload.author,
        logos: payload.logos,
        themeColor: payload.themeColor,
        brandColors: payload.brandColors,
        largestImage: payload.largestImage,
        favIconUrl: info.favIconUrl,
        hiddenPruned: payload.hiddenPruned,
      });
      raw.tabUrl = info.url || payload.url;
      raw.tabId = typeof info.id === 'number' ? info.id : null;
      return raw;
    },

    async readTab({ tabId, selection = null, here = false, mode = null, at = null, info = null }) {
      const seq = ++App.loadSeq;
      const tab = info || UI.tabInfo; // info: a matched tab that is not the one in front
      const t0 = performance.now();
      Engine.pause();
      UI.showLoading((tab && tab.url) || 'https://this.tab/');
      UI.setLoadingStatus('Reading the live page in this tab…');
      try {
        const result = await Host.request('tab:read', { tabId }, 30000);
        if (seq !== App.loadSeq) return;
        const { payload } = result;
        UI.setLoadingStage('extract', `the open tab · ${Math.round(performance.now() - t0)} ms`);
        UI.setLoadingStatus('Ad-Shield, then Mozilla Readability…');
        const raw = await this.extract(result);
        const picked = selection !== null ? String(payload.selection || selection || '').trim() : '';
        if (selection !== null && picked) {
          raw.blocks = Extractor.fromText(picked).blocks;
          raw.kind = 'selection';
          raw.extractor = 'your selection';
          raw.excerpt = trimText(picked, 200);
        }
        if (seq !== App.loadSeq) return;
        raw.id = `${raw.kind === 'selection' ? 's' : 'u'}_${hash(raw.kind === 'selection' ? picked : normalizeUrl(payload.url) || payload.url)}`;
        raw.loadMs = Math.round(performance.now() - t0);
        const shown = App.present(raw, { autoplay: true, resume: true, at, anchor: here ? payload.anchor : null, mode: here ? 'read' : mode });
        if (here && shown) {
          let note = 'Starting from the paragraph you picked.';
          if (!shown.jumped) note = payload.anchor ? 'Couldn’t find that spot in the article text — starting from your saved place.' : this.access ? 'SiteVocal didn’t see where you right-clicked (reload tabs opened before it was installed) — starting from your saved place.' : 'Select a few words first, or allow SiteVocal on all sites so it sees where you right-click — starting from your saved place.';
          UI.toast(note, { type: shown.jumped ? 'success' : 'info', timeout: 6000 });
        }
      } catch (err) {
        if (seq !== App.loadSeq) return;
        UI.showError(err, (tab && tab.url) || '');
      }
    },

    /**
     * "Page changed · Re-sync" — re-read the live tab without stopping the audio first.
     * Same article: carry on from the sentence being spoken. New route: open the new page.
     */
    async resync() {
      const raw0 = App.raw;
      if (!raw0 || raw0.source !== 'tab' || raw0.tabId == null) return;
      const btn = UI.els.domChanged;
      btn.disabled = true;
      btn.innerHTML = `${icon('loader-circle', 'size-3.5 sv-spin')}Re-syncing…`;
      const cur = App.script && App.script.segments[Engine.seg];
      const ch = cur && cur.chunks[Engine.chunk];
      const anchor = cur && cur.kind !== 'intro' && cur.kind !== 'outro' && cur.text ? { text: cur.text, sel: ch && ch.end > ch.start ? cur.text.slice(ch.start, ch.end) : '' } : null;
      const playing = Engine.state === 'playing';
      const before = App.script ? App.script.paragraphs : 0;
      const seq = App.loadSeq;
      try {
        const result = await Host.request('tab:read', { tabId: raw0.tabId }, 30000);
        if (seq !== App.loadSeq || App.raw !== raw0) return;
        const raw = await this.extract(result);
        if (seq !== App.loadSeq || App.raw !== raw0) return;
        raw.id = `u_${hash(normalizeUrl(result.payload.url) || result.payload.url)}`;
        const same = raw.id === raw0.id;
        const shown = App.present(raw, { autoplay: playing, resume: !same, anchor: same ? anchor : null, refreshDoc: true, mode: same ? App.mode : null });
        if (!shown) return;
        const added = same ? Math.max(0, App.script.paragraphs - before) : 0;
        UI.toast(same ? `Re-synced with the live page${added ? ` · ${plural(added, 'new paragraph')}` : ''}.` : `Now reading “${trimText(raw.title, 50)}”.`, { type: 'success' });
      } catch (err) {
        UI.setDomChanged({ reason: 'retry' });
        UI.toast(`Re-sync failed: ${err.message}`, { type: 'error' });
      }
    },
  };

  /* ---------------------------------------------------------- your data
   * SiteVocal collects nothing: there is no account and no SiteVocal server. Everything it keeps is in this
   * browser (in the extension, its own storage), and "Your data" shows it, clears it, or forgets what you
   * listened to whenever SiteVocal closes. Browsers let no page ask a question as it closes, so the choice is
   * made here, ahead of time. */
  // Erased by "Forget what I listened to": settings, the dictionary and Turbo keys stay.
  const FORGET_RE = /^sitevocal_(?:library|doc_.*|clips|queue|stats)$/;

  /* ------------------------------------------- public page services, agreed to first (extension)
   * Without site access the extension opens a pasted link the way the website version does: from the site itself,
   * or through a public page service (allorigins.win, codetabs.com, corsproxy.io, r.jina.ai) that fetches it and so
   * sees the link's address. The first time, the loading card asks before any address is sent; your answer is kept
   * (Your data changes it). With all sites allowed, links load straight from your browser instead. */
  const PageServices = {
    pending: null, // { resolve, reject, url } while the loading card waits for your answer

    /** True when a link would go to a page service and you have not agreed to that yet. */
    needed() {
      return Host.mode === 'extension' && !Ext.access && !Settings.data.pageServicesOk;
    },

    ask(url, signal) {
      const card = UI.els.loadingCard;
      const host = bareHost(hostOf(url)) || 'this page';
      if (card.hidden || !card.firstElementChild) return Promise.reject(Object.assign(new Error('SiteVocal needs your OK before a public page service may fetch a link.'), { code: 'page-services' }));
      if (this.pending) this.pending.reject(abortError());
      const old = card.querySelector('.sv-consent');
      if (old) old.remove();
      card.firstElementChild.insertAdjacentHTML(
        'afterbegin',
        `<div class="sv-consent" role="group" aria-labelledby="consentTitle">
          <p id="consentTitle" class="sv-consent-title">${icon('shield-check', 'size-4')}<span>Open this link through a public page service?</span></p>
          <p class="sv-consent-text">SiteVocal has no access to <b>${esc(host)}</b>, so it can ask a public page service (allorigins.win, codetabs.com, corsproxy.io or r.jina.ai) to fetch the page. That service sees the link's address, never your library or other pages. SiteVocal itself receives nothing.</p>
          <div class="sv-consent-actions">
            <button type="button" class="sv-btn-primary" data-consent="yes">Open links this way</button>
            <button type="button" class="sv-btn-ghost" data-consent="access">${icon('shield-check', 'size-4')}Allow all sites instead</button>
            <button type="button" class="sv-mini-btn" data-consent="no">Not now</button>
          </div>
          <p class="sv-consent-foot">Asked once. Change it any time in Your data.</p>
        </div>`,
      );
      UI.setLoadingStatus('Waiting for your OK — nothing has been sent');
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject, url };
        if (signal) signal.addEventListener('abort', () => this.settle('abort'), { once: true });
      });
    },

    /** Your answer, from the loading card's buttons. */
    async answer(choice) {
      const pending = this.pending;
      if (!pending) return;
      if (choice === 'yes') {
        Settings.set({ pageServicesOk: true });
        this.settle('yes');
      } else if (choice === 'no') {
        this.settle('no');
      } else if (choice === 'access') {
        // Chrome's prompt, after SiteVocal's own explanation. Granted: the link loads straight from your browser.
        if (await Ext.allowAllSites()) this.settle('access');
      }
    },

    settle(how) {
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      const card = UI.els.loadingCard.querySelector('.sv-consent');
      if (card) card.remove();
      if (how === 'yes') {
        UI.setLoadingStatus('Fetching through a public page service…');
        pending.resolve();
      } else if (how === 'access') {
        UI.setLoadingStatus('Fetching straight from your browser…');
        pending.reject(Object.assign(new Error('Site access allowed'), { code: 'access-granted' }));
      } else if (how === 'abort') {
        pending.reject(abortError());
      } else {
        pending.reject(Object.assign(new Error('Not opened: SiteVocal sent this link nowhere.'), { code: 'page-services-declined' }));
      }
    },
  };

  const DataUI = {
    els: null,

    init() {
      const $ = (id) => document.getElementById(id);
      this.els = { dialog: $('dataDialog'), list: $('dataList'), forget: $('dataForget'), forgetSub: $('dataForgetSub'), sent: $('dataSent'), clear: $('btnDataClear'), notice: $('dataNotice') };
      const e = this.els;
      e.forgetSub.textContent = `Your library, saved pages, clips, Up Next and listening stats are erased when you close ${Host.mode === 'extension' ? 'the side panel, popup or SiteVocal tab' : 'this tab'}. Settings, your dictionary and Turbo keys stay.`;
      // Any "Your data" button or link, wherever it is: the library, the start page, the privacy panel.
      document.addEventListener('click', (ev) => {
        if (ev.target.closest && ev.target.closest('[data-open-data]')) this.open();
      });
      $('btnDataClose').addEventListener('click', () => e.dialog.close());
      $('btnDataDone').addEventListener('click', () => e.dialog.close());
      e.dialog.addEventListener('click', (ev) => {
        if (ev.target === e.dialog) e.dialog.close();
        const btn = ev.target.closest('[data-action]');
        if (btn && btn.dataset.action === 'allow-access') Ext.allowAllSites();
        if (btn && btn.dataset.action === 'remove-access') Ext.removeAccess();
        if (btn && btn.dataset.action === 'services-off') {
          Settings.set({ pageServicesOk: false });
          this.render();
          UI.toast('SiteVocal asks again before a public page service opens a link.', { type: 'success', timeout: 3200 });
        }
      });
      e.forget.addEventListener('change', () => {
        Settings.set({ forgetOnClose: e.forget.checked });
        UI.toast(e.forget.checked ? 'SiteVocal will forget what you listened to each time you close it.' : 'SiteVocal keeps your library again when you close it.', { type: 'success', timeout: 3200 });
      });
      UI.armed(e.clear, 'Clear everything', () => this.clearEverything());
      $('btnNoticeOk').addEventListener('click', () => this.seen());
      // Just cleared: the web app reloaded itself with #cleared; the extension restarted this page with ?cleared=1.
      if (location.hash === '#cleared' || new URLSearchParams(location.search).get('cleared') === '1') {
        try {
          history.replaceState(null, '', location.pathname + location.search);
        } catch {
          /* sandboxed history */
        }
        setTimeout(() => UI.toast('Cleared: SiteVocal keeps nothing in this browser now.', { type: 'success' }), 300);
      }
      this.renderNotice();
    },

    open() {
      if (Library.entries.length) this.seen(); // the note under "Continue listening" has done its job
      this.render();
      UI.togglePrivacy(false);
      if (typeof this.els.dialog.showModal === 'function' && !this.els.dialog.open) this.els.dialog.showModal();
    },

    /** The one-time note under "Continue listening": where your data lives and how to clear it. */
    renderNotice() {
      if (this.els) this.els.notice.hidden = Boolean(Settings.data.dataNoticeSeen) || !Library.entries.length;
    },

    seen() {
      if (!Settings.data.dataNoticeSeen) Settings.set({ dataNoticeSeen: true });
      this.renderNotice();
    },

    /** Every sitevocal_* key in this browser (other sites' data on the same origin is never touched). */
    keys() {
      return Store.keys().filter((k) => k && k.startsWith('sitevocal_'));
    },

    render() {
      if (!this.els) return;
      const keys = this.keys();
      const docs = keys.filter((k) => k.startsWith(KEYS.doc)).length;
      const chars = keys.reduce((n, k) => n + k.length + String(Store.get(k) || '').length, 0);
      const count = (n, one, many = `${one}s`) => (n ? `${fmtNumber(n)} ${n === 1 ? one : many}` : 'none');
      const turboKey = Turbo.anyKey() || Boolean(Turbo.readerKind());
      // Words you added: the built-in pronunciations ship with SiteVocal and are not your data.
      const seed = new Set(LEXICON_SEED.map((w) => `${w.from}→${w.to}`));
      const own = keys.includes(KEYS.lexicon) ? Lexicon.entries.filter((w) => !seed.has(`${w.from}→${w.to}`)).length : 0;
      const rows = [
        ['Saved sites, with resume points', count(Library.entries.length, 'site')],
        ['Saved pages, for listening offline', count(docs, 'page')],
        ['Clipped quotes', count(Clips.list().length, 'quote')],
        ['Up Next', count(Queue.list().length, 'link')],
        ['Your dictionary', own ? count(own, 'word') : keys.includes(KEYS.lexicon) ? 'built-in words only' : 'none'],
        ['Listening stats', count(Stats.get().words, 'word spoken', 'words spoken')],
        ['Settings', keys.includes(KEYS.settings) ? 'voice, speed and filters' : 'none'],
        ['Turbo Engine keys', turboKey ? 'saved, sent only to your service' : 'none'],
      ];
      const access =
        Host.mode === 'extension'
          ? `<li><span>Site access</span><b>${Ext.access ? `all sites <button type="button" class="sv-data-mini" data-action="remove-access">Remove</button>` : `only tabs you click SiteVocal on <button type="button" class="sv-data-mini" data-action="allow-access">Allow all sites</button>`}</b></li><li><span>Public page services</span><b>${Settings.data.pageServicesOk ? `allowed for links you open <button type="button" class="sv-data-mini" data-action="services-off">Ask again</button>` : 'asked before the first link'}</b></li>`
          : '';
      this.els.list.innerHTML = `${rows.map(([label, value]) => `<li><span>${esc(label)}</span><b>${esc(value)}</b></li>`).join('')}${access}<li class="sv-data-total"><span>In this browser</span><b>${keys.length ? `about ${esc(fmtBytes(chars * 2))}` : 'nothing'}</b></li>`;
      this.els.forget.checked = Boolean(Settings.data.forgetOnClose);
      const voices = 'An online voice, or a Turbo key you add, gets the text it reads aloud. SiteVocal itself receives nothing.';
      this.els.sent.textContent =
        Host.mode !== 'extension'
          ? `What leaves this browser: to load a link, its address goes to the public services that fetch pages for the website version (allorigins.win, codetabs.com, corsproxy.io and r.jina.ai). ${voices}`
          : Ext.access
            ? `What leaves this browser: pages load straight from your browser. Only a page that blocks that, or builds itself with JavaScript, has its address sent to a public page service (r.jina.ai, allorigins.win and others). ${voices}`
            : `What leaves this browser: tabs you click SiteVocal on are read right here. A link you paste goes through a public page service (allorigins.win, codetabs.com, corsproxy.io or r.jina.ai) only after you agree, and that service sees its address; or it loads straight from your browser once you allow all sites. ${voices}`;
    },

    /** Clear everything, then start again from a clean page (no module keeps an old copy in memory). */
    async clearEverything() {
      Engine.pause();
      for (const key of this.keys()) Store.remove(key);
      Store.freeze();
      // The extension clears its own storage too and restarts this page: a sandboxed page cannot reload itself.
      if (Host.mode === 'extension') return Host.request('storage:clear', {}, 8000).then(() => true, () => false);
      try {
        location.hash = 'cleared';
      } catch {
        /* sandboxed location */
      }
      location.reload();
      return true;
    },

    /** "Forget what I listened to when I close SiteVocal": runs as the page goes away (pagehide). */
    forget() {
      for (const key of this.keys()) if (FORGET_RE.test(key)) Store.remove(key);
      Store.freeze(); // nothing that runs after this (progress saves on unload) writes it back
    },
  };
  /* ------------------------------------------------------------------ boot */
  async function boot() {
    hydrateIcons();
    const init = await Host.connect();
    Store.init(init && init.storage);
    document.documentElement.dataset.mode = Host.mode;
    document.documentElement.dataset.surface = Host.surface;
    Settings.load();
    Library.load();
    Lexicon.load();
    Turbo.load();
    Theme.reset();
    UI.init();
    TurboUI.init();
    DataUI.init();
    // Chrome's on-device Summarizer: checked once, quietly; ✨ Summarize uses it only when it is already downloaded.
    AiSummary.probe().then(() => TurboUI.sync(), () => {});
    Switchboard.init();
    UI.renderLibrary();
    UI.renderQueue();
    UI.renderStatus();

    Engine.rate = Settings.data.rate;
    Engine.pickFallback = () => Voices.ranked((App.script && App.script.lang) || 'en').find((v) => v.localService !== false && Voices.matches(v, (App.script && App.script.lang) || 'en')) || null;
    Engine.on('position', ({ seg, chunk }) => {
      UI.setActive(seg, chunk);
      App.saveProgress();
    });
    Engine.on('word', (seg, chunk, index) => UI.setWord(seg, chunk, index));
    Engine.on('state', (state) => {
      UI.setState(state);
      MediaKeys.state(state === 'playing');
      if (state === 'paused' || state === 'ended') App.saveProgress(true);
    });
    Engine.on('spoken', (text) => UI.renderWords(Stats.add({ words: countWords(text) }).words));
    Engine.on('end', () => {
      App.saveProgress(true);
      UI.updateProgress();
      UI.renderLibrary();
      const full = (App.mode === 'briefing' || App.mode === 'summary') && App.raw && (App.raw.blocks || []).length > 0;
      UI.toast(App.mode === 'briefing' ? 'Site Briefing finished — saved to your library.' : App.mode === 'summary' ? 'Page Summary finished — saved to your library.' : 'Finished — saved to your library.', { type: 'success', action: full && !Queue.list().length ? { label: 'Full Page Read', fn: () => App.setMode('read') } : undefined });
      App.advanceQueue();
    });
    Engine.on('error', (message) => UI.toast(message, { type: 'error', timeout: 7000 }));
    Engine.on('fallback', (voice) => {
      UI.toast(`Network voice failed — switched to ${Voices.short(voice)}.`, { type: 'info' });
      UI.els.voiceSel.title = `Voice: ${voice.name}`;
      UI.renderStatus();
      UI.renderDevtools();
    });
    let ticks = 0;
    setInterval(() => {
      if (Engine.state !== 'playing') return;
      UI.updateProgress();
      App.saveProgress();
      if (++ticks % 4 === 0) {
        const total = Engine.totalSeconds();
        MediaKeys.position(total, total * Engine.fraction());
      }
    }, 500);

    // Lock screen, media keys and headsets: next / previous track step one sentence, seek steps a paragraph.
    MediaKeys.setup({
      play: () => Engine.play(),
      pause: () => Engine.pause(),
      stop: () => Engine.pause(),
      previoustrack: () => Engine.prevSentence(),
      nexttrack: () => Engine.nextSentence(),
      seekbackward: () => Engine.prev(),
      seekforward: () => Engine.next(),
      seekto: (details) => {
        const total = Engine.totalSeconds();
        if (details && total > 0 && Number.isFinite(details.seekTime)) Engine.seekFraction(details.seekTime / total);
      },
    });

    Voices.onChange = () => {
      if (App.script && !Engine.voice) Engine.voice = Voices.resolve(Settings.data.voiceURI, App.script.lang);
      UI.populateVoices();
      UI.renderDevtools();
    };
    Voices.load().then(() => Voices.onChange());

    const ua = navigator.userAgent;
    if (window.speechSynthesis && (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || /^((?!chrome|chromium|android|edg).)*safari/i.test(ua))) {
      const unlock = () => {
        document.removeEventListener('pointerdown', unlock, true);
        document.removeEventListener('keydown', unlock, true);
        if (Engine.state === 'playing') return;
        try {
          const u = new SpeechSynthesisUtterance(' ');
          u.volume = 0;
          window.speechSynthesis.speak(u);
        } catch {
          /* nothing to unlock */
        }
      };
      document.addEventListener('pointerdown', unlock, true);
      document.addEventListener('keydown', unlock, true);
    }

    if (!window.speechSynthesis) {
      setTimeout(() => UI.toast('This browser has no Web Speech API, so SiteVocal can show the teleprompter but cannot speak. Try Chrome, Edge or Safari.', { type: 'error', timeout: 9000 }), 600);
    }

    window.addEventListener('storage', (ev) => {
      if (ev.key) App.storageChanged(ev.key);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') App.saveProgress(true);
    });
    window.addEventListener('pagehide', () => {
      // "Forget what I listened to when I close SiteVocal" (Your data): erased now, and nothing below saves it again.
      if (Settings.data.forgetOnClose) DataUI.forget();
      else App.saveProgress(true);
      Engine.pause();
    });
    window.addEventListener('pageshow', (ev) => {
      // Back from the browser's page cache after a forget: start clean rather than show what was erased.
      if (ev.persisted && Store.frozen && Host.mode !== 'extension') location.reload(); // the extension's shell does it there
    });

    if (Host.mode === 'extension') Ext.init(init);

    const params = new URLSearchParams(location.search);
    let deep = params.get('url') || '';
    if (!deep && location.hash.startsWith('#url=')) {
      try {
        deep = decodeURIComponent(location.hash.slice(5));
      } catch {
        deep = location.hash.slice(5);
      }
    }
    if (deep && Host.mode !== 'extension') App.openUrl(deep);
    else UI.showLanding();

    window.SiteVocal = Object.freeze({ version: VERSION, App, Engine, Library, Synth, Extractor, Briefing, Summary, Turbo, AiSummary, Voices, Clean, Host, Shield, Lexicon, Clips, Queue, Stats, Settings, MediaKeys, UI, Field, Switchboard, Fetcher, Markdown, GitHub, Reader, Prefetch, Ext, DataUI, PageServices });

    // The first page a visitor opens would also pay V8's one-time costs (compiling the extractor's functions and
    // its large regular expressions: ~60 ms on a laptop, more on a phone). A tiny built-in page pays them while
    // the browser is idle, unless a page is already on its way (that load warms everything itself).
    const bootSeq = App.loadSeq;
    const warm = () => {
      if (App.raw || App.loadSeq !== bootSeq) return;
      Extractor.fromHtml(WARM_PAGE, 'https://warm-up.invalid/', { source: 'url' }).catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 600);
  }

  /** The warm-up page: a heading, a lead, a feature list, a priced table and an FAQ — every extractor path, no network. */
  const WARM_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Warm-up</title><meta name="description" content="Built for teams who would rather listen."></head><body><main><article><h1>Warm-up</h1>
<p>This page never appears: SiteVocal reads it once, quietly, so the first real page opens without the browser's one-time start-up work.</p>
<p>It has a lead paragraph, a list, a priced table and a question with its answer, which is enough for the full read, the briefing and the summary.</p>
<h2>Features</h2><ul><li>Reads any page aloud.</li><li>Summarizes the whole page.</li><li>Briefs you on a company.</li></ul>
<h2>Pricing</h2><table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>$0 per month</td></tr><tr><td>Pro</td><td>$9 per month</td></tr></tbody></table>
<h2>FAQ</h2><h3>Is it free?</h3><p>Yes. It is free on every page, with no account and no key.</p></article></main></body></html>`;

  // Reveal the page even if something above throws, so a bad link can never leave it blank.
  const start = () =>
    boot()
      .catch((err) => console.error('[SiteVocal] start-up failed', err))
      .finally(() => requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('sv-preload'))));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

