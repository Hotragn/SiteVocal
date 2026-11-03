/*!
 * SiteVocal — context-hook.js (content script on http(s) pages, registered once you allow all sites)
 *
 * Remembers the element you last right-clicked, so the context-menu item
 * "Start SiteVocal From Here" knows where "here" is. It only keeps a reference
 * in this extension's isolated world: no messages, no network requests and no
 * changes to the page. content.js reads it when you pick the menu item.
 */
'use strict';

document.addEventListener(
  'contextmenu',
  (event) => {
    globalThis.__siteVocalContext = { el: event.target, at: Date.now() };
  },
  { capture: true, passive: true },
);
