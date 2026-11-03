/*!
 * SiteVocal — content.js (Chrome Extension, Manifest V3)
 *
 * Injected on demand into the active tab with chrome.scripting.executeScript
 * when you click the SiteVocal icon, use the context menu or press Alt+Shift+S.
 * It reads the live, rendered DOM — so it works on pages you are logged into
 * and never touches a CORS proxy — and returns one payload:
 *
 *   • html          the page with hidden nodes, scripts and media stripped,
 *                   ready for Mozilla Readability inside the SiteVocal studio
 *   • logos         every icon candidate (apple-touch-icon, sized icons,
 *                   SVG icons, JSON-LD publisher logo) for the identity card
 *   • brandColors   colours actually painted on the page (header, nav,
 *                   buttons, links) for the Chameleon theme
 *   • themeColor, author, largestImage, selection, title, lang
 *   • anchor        the paragraph you right-clicked (see context-hook.js) or
 *                   the start of your selection, for "Start SiteVocal From Here"
 *   • hiddenPruned  how many hidden nodes were dropped (Ad-Shield telemetry)
 *
 * It also installs, once per page, a lightweight watcher that tells the
 * SiteVocal panel when a single-page app changes route or title, or infinite
 * scroll appends new content, so the panel can offer a re-sync.
 *
 * It never modifies the page. The value of the final expression below is what
 * executeScript hands back to the extension.
 */
(() => {
  'use strict';

  const MAX_HTML_CHARS = 6000000;

  const absolute = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'data:' ? url.href : '';
    } catch {
      return '';
    }
  };

  const metaContent = (...selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = el && (el.getAttribute('content') || '').trim();
      if (value) return value;
    }
    return '';
  };

  /** All JSON-LD nodes on the page (flattening @graph and arrays). */
  const jsonLd = () => {
    const out = [];
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4 || out.length > 60) return;
      if (Array.isArray(node)) {
        node.forEach((n) => visit(n, depth + 1));
        return;
      }
      if (node['@type']) out.push(node);
      if (node['@graph']) visit(node['@graph'], depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        visit(JSON.parse(script.textContent || 'null'), 0);
      } catch {
        // Invalid JSON-LD is common in the wild; skip it.
      }
    }
    return out;
  };

  const imageUrl = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return imageUrl(value[0]);
    return typeof value === 'object' ? value.url || value.contentUrl || '' : '';
  };

  /** High-resolution logo candidates, best first. */
  const logos = (ld) => {
    const found = [];
    for (const link of document.querySelectorAll('link[rel][href]')) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      if (!/(^|\s)(apple-touch-icon(-precomposed)?|icon|fluid-icon)(\s|$)/.test(rel)) continue;
      const href = absolute(link.getAttribute('href'));
      if (!href) continue;
      const sizes = (link.getAttribute('sizes') || '').match(/(\d+)\s*x\s*\d+/i);
      const svg = /svg/i.test(link.getAttribute('type') || '') || /\.svg(\?|$)/i.test(href);
      const size = sizes ? Number(sizes[1]) : svg ? 256 : /apple/.test(rel) ? 180 : 32;
      found.push({ href, score: Math.min(size, 512) + (/apple/.test(rel) ? 40 : 0) + (svg ? 30 : 0) });
    }
    const publisher = ld.map((n) => n.publisher).find((p) => p && typeof p === 'object');
    const org = ld.find((n) => /Organization/.test([].concat(n['@type'] || []).join(' ')) && n.logo);
    const ldLogo = absolute(imageUrl((publisher && publisher.logo) || (org && org.logo)));
    if (ldLogo) found.push({ href: ldLogo, score: 120 });
    const ogLogo = absolute(metaContent('meta[property="og:logo"]'));
    if (ogLogo) found.push({ href: ogLogo, score: 150 });
    return found.sort((a, b) => b.score - a.score).slice(0, 8);
  };

  /** The page's own colour for the browser UI: prefer the dark-scheme variant. */
  const themeColor = () => {
    const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    const pick = metas.find((m) => /dark/.test(m.getAttribute('media') || '')) || metas.find((m) => !m.getAttribute('media')) || metas[0];
    return pick ? (pick.getAttribute('content') || '').trim() : metaContent('meta[name="msapplication-TileColor"]');
  };

  /** Colours actually painted on the page — header/nav/button backgrounds and link colours, weighted by prominence. */
  const brandColors = () => {
    const weights = new Map();
    // The browser's own defaults (link blue, visited purple, active red) appear on unstyled pages: not a brand.
    const UA_DEFAULTS = new Set(['rgb(0, 0, 238)', 'rgb(85, 26, 139)', 'rgb(238, 0, 0)']);
    const add = (color, weight) => {
      if (!color || color === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(color) || UA_DEFAULTS.has(color)) return;
      weights.set(color, (weights.get(color) || 0) + weight);
    };
    const pick = (selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit);
    for (const el of pick('header, [role="banner"], nav, .header, #header, .navbar, .masthead, .site-header, .topbar', 30)) {
      const style = getComputedStyle(el);
      add(style.backgroundColor, 4);
      add(style.borderBottomColor, 0.5);
    }
    for (const el of pick('button, .btn, .button, [type="submit"], [role="button"]', 120)) {
      const rect = el.getBoundingClientRect();
      if (rect.width && rect.height) add(getComputedStyle(el).backgroundColor, 1.5);
    }
    for (const el of pick('main a[href], article a[href], a[href]', 300)) add(getComputedStyle(el).color, 0.35);
    return Array.from(weights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([color, weight]) => ({ color, weight: Math.round(weight * 10) / 10 }));
  };

  /** Largest meaningful image — a hero fallback for pages without og:image. */
  const largestImage = () => {
    let best = '';
    let bestArea = 0;
    for (const img of Array.from(document.images).slice(0, 400)) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < 320 || h < 160) continue;
      const ratio = w / h;
      if (ratio < 0.8 || ratio > 3.2) continue;
      const src = absolute(img.currentSrc || img.src);
      if (!src || /logo|icon|avatar|sprite|badge|emoji|pixel/i.test(src)) continue;
      if (w * h > bestArea) {
        bestArea = w * h;
        best = src;
      }
    }
    return best;
  };

  /** Remove (from the clone) every element that is not rendered in the live page: menus, modals, collapsed widgets. */
  const pruneHidden = (liveBody, cloneBody) => {
    if (!liveBody || !cloneBody || typeof liveBody.checkVisibility !== 'function') return 0;
    const live = document.createTreeWalker(liveBody, NodeFilter.SHOW_ELEMENT);
    const copy = document.createTreeWalker(cloneBody, NodeFilter.SHOW_ELEMENT);
    const skip = (walker) => {
      while (!walker.nextSibling()) {
        if (!walker.parentNode()) return null;
      }
      return walker.currentNode;
    };
    const doomed = [];
    let a = live.nextNode();
    let b = copy.nextNode();
    let guard = 0;
    while (a && b && guard++ < 60000) {
      if (a.tagName !== b.tagName) break;
      const visible = a.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
      if (!visible && getComputedStyle(a).display !== 'contents') {
        doomed.push(b);
        a = skip(live);
        b = skip(copy);
        continue;
      }
      a = live.nextNode();
      b = copy.nextNode();
    }
    doomed.forEach((node) => node.remove());
    return doomed.length;
  };

  let hiddenPruned = 0;

  /** Serialise the rendered page for Readability: absolute URLs, no scripts, styles or media. */
  const serialize = () => {
    const root = document.documentElement.cloneNode(true);
    hiddenPruned = pruneHidden(document.body, root.querySelector('body'));
    root
      .querySelectorAll('script:not([type="application/ld+json"]), style, link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], noscript, iframe, frame, object, embed, svg, canvas, video, audio, template, dialog:not([open])')
      .forEach((node) => node.remove());
    root.querySelectorAll('[src]').forEach((el) => {
      const value = absolute(el.getAttribute('src'));
      if (value) el.setAttribute('src', value);
      else el.removeAttribute('src');
    });
    root.querySelectorAll('[href]').forEach((el) => {
      const value = absolute(el.getAttribute('href'));
      if (value) el.setAttribute('href', value);
      else el.removeAttribute('href');
    });
    root.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));
    const html = `<!DOCTYPE html>\n${root.outerHTML}`;
    return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  };

  const author = (ld) => {
    const fromMeta = metaContent('meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]', 'meta[name="parsely-author"]');
    if (fromMeta && !/^https?:/i.test(fromMeta)) return fromMeta;
    const article = ld.find((n) => /Article|BlogPosting|NewsArticle/.test([].concat(n['@type'] || []).join(' ')));
    const names = article ? [].concat(article.author || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter((a) => typeof a === 'string') : [];
    if (names.length) return names.slice(0, 3).join(' and ');
    const el = document.querySelector('a[rel="author"], [itemprop="author"] [itemprop="name"], .byline .author, .author-name, .byline__name');
    return el ? el.textContent.trim().slice(0, 120) : '';
  };

  const selection = () => {
    try {
      return String(window.getSelection() || '').trim().slice(0, 200000);
    } catch {
      return '';
    }
  };

  /** "Start SiteVocal From Here": the start of your selection, else the element you last right-clicked. */
  const anchor = () => {
    let node = null;
    let sel = '';
    try {
      const s = window.getSelection();
      if (s && s.rangeCount && String(s).trim()) {
        node = s.getRangeAt(0).startContainer;
        sel = String(s).trim().slice(0, 200);
      }
    } catch {
      node = null;
    }
    const ctx = globalThis.__siteVocalContext;
    if (!node && ctx && ctx.el && ctx.el.isConnected && Date.now() - ctx.at < 5 * 60 * 1000) node = ctx.el;
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = el && (el.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, figcaption, td, th') || el);
    const text = block ? (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return text ? { text, sel, tag: block.tagName.toLowerCase() } : null;
  };

  /**
   * SPA / infinite-scroll watcher, installed once per page: route and title changes, and bursts of new text,
   * are reported to the SiteVocal panel, which offers a re-sync without interrupting the audio.
   */
  const watch = () => {
    if (globalThis.__siteVocalWatch || !document.body || typeof MutationObserver !== 'function') return;
    let lastUrl = location.href;
    let lastTitle = document.title;
    let added = 0;
    let contentAt = 0;
    let timer = 0;
    let poll = 0;
    let observer = null;
    const stop = () => {
      if (observer) observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      globalThis.__siteVocalWatch = null;
    };
    const notify = (reason) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          stop(); // the extension was reloaded or removed
          return;
        }
        chrome.runtime.sendMessage({ type: 'sitevocal:dom-changed', reason, url: location.href, title: document.title }).catch(() => {});
      } catch {
        stop();
      }
    };
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastTitle = document.title;
        added = 0;
        notify('route');
      } else if (document.title !== lastTitle) {
        lastTitle = document.title;
        notify('title');
      } else if (added >= 600 && Date.now() - contentAt > 4000) {
        contentAt = Date.now();
        notify('content');
      }
      added = 0; // a slow trickle (rotating widgets, tickers) never adds up to a "new content" signal
    };
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const n of record.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) added += (n.textContent || '').trim().length;
      }
      clearTimeout(timer);
      timer = setTimeout(check, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    poll = setInterval(check, 1500);
    globalThis.__siteVocalWatch = { stop };
  };

  const ld = jsonLd();
  const html = serialize();
  watch();
  return {
    v: 2,
    url: location.href,
    title: document.title || '',
    lang: document.documentElement.lang || '',
    html,
    hiddenPruned,
    selection: selection(),
    anchor: anchor(),
    logos: logos(ld),
    themeColor: themeColor(),
    brandColors: brandColors(),
    largestImage: largestImage(),
    author: author(ld),
    capturedAt: Date.now(),
  };
})();
