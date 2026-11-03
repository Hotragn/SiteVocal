/*!
 * SiteVocal — background.js (Manifest V3 service worker)
 *
 * • Toolbar icon / Alt+Shift+S → open the side panel and read the active tab.
 * • Context menus → read this page, Start SiteVocal From Here (the paragraph you
 *   right-clicked or selected), Speak Selection, read a linked page.
 * • Action menu → open the studio in a full tab, or make the toolbar icon open a popup.
 * Requests are handed to panel.js through chrome.storage.session (when the
 * panel is just opening) and chrome.runtime messages (when it is already open).
 * Site access is optional: clicking the icon, the shortcut or a menu item reads that one tab (activeTab). Only
 * when you allow all sites (in the side panel) does the right-click helper run on web pages.
 */
'use strict';

const PANEL = 'panel.html';
const PENDING_KEY = 'sitevocal_pending';
const MODE_KEY = 'sitevocal_open_mode';

const hasSidePanel = () => Boolean(chrome.sidePanel && chrome.sidePanel.open);
const ignoreError = () => void chrome.runtime.lastError;
let popupMode = !hasSidePanel();

async function applyActionBehavior() {
  const stored = await chrome.storage.local.get(MODE_KEY).catch(() => ({}));
  popupMode = !hasSidePanel() || stored[MODE_KEY] === 'popup';
  await chrome.action.setPopup({ popup: popupMode ? `${PANEL}?surface=popup` : '' });
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
  chrome.contextMenus.update('sv-popup-mode', { checked: popupMode }, ignoreError);
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (props) => chrome.contextMenus.create(props, ignoreError);
    add({ id: 'sv-page', title: 'Read this page with SiteVocal', contexts: ['page'] });
    add({ id: 'sv-here', title: 'Start SiteVocal From Here', contexts: ['page', 'selection'] });
    add({ id: 'sv-selection', title: 'Speak Selection', contexts: ['selection'] });
    add({ id: 'sv-link', title: 'Read linked page with SiteVocal', contexts: ['link'] });
    add({ id: 'sv-open-tab', title: 'Open SiteVocal studio in a tab', contexts: ['action'] });
    add({ id: 'sv-popup-mode', title: 'Toolbar icon opens a popup instead of the side panel', type: 'checkbox', checked: popupMode, contexts: ['action'] });
    applyActionBehavior();
  });
}

/**
 * Must run synchronously inside the user gesture — no await before sidePanel.open().
 * Menus and the shortcut always use the side panel (a just-woken worker cannot read the stored
 * popup preference in time); "popup mode" changes what the toolbar icon opens.
 */
function openSurface(tab) {
  if (hasSidePanel()) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.warn('[SiteVocal] side panel:', err && err.message));
  } else if (chrome.action.openPopup) {
    chrome.action.openPopup({ windowId: tab.windowId }).catch(() => {});
  }
}

function queue(request) {
  const req = { ...request, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() };
  if (chrome.storage.session) chrome.storage.session.set({ [PENDING_KEY]: req }).catch(() => {});
  // An already-open side panel picks this up immediately; a panel that is still opening reads storage.session instead.
  chrome.runtime.sendMessage({ type: 'sitevocal:request', request: req }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(createMenus);
// "Clear everything" (Your data) resets the toolbar icon to its default: the side panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && MODE_KEY in changes) applyActionBehavior().catch(() => {});
});

/* ------------------------------------------------ optional site access
 * With access to all sites, context-hook.js runs on web pages so "Start SiteVocal From Here" knows which
 * paragraph you right-clicked; tabs that are already open get it at once. Without access, nothing runs on any
 * page until you click SiteVocal. */
const ALL_SITES = { origins: ['http://*/*', 'https://*/*'] };
const HOOK = { id: 'sv-context-hook', js: ['context-hook.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', persistAcrossSessions: true };

async function syncHook() {
  const granted = await chrome.permissions.contains(ALL_SITES).catch(() => false);
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [HOOK.id] }).catch(() => []);
  if (!granted) {
    if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [HOOK.id] }).catch(() => {});
    return;
  }
  if (have.length) return;
  await chrome.scripting.registerContentScripts([HOOK]).catch((err) => console.warn('[SiteVocal] right-click helper:', err && err.message));
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const tab of tabs) chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['context-hook.js'] }).catch(() => {});
}
// One at a time: the worker's start-up and onInstalled can both ask at once.
let syncing = Promise.resolve();
const sync = () => {
  syncing = syncing.then(syncHook, syncHook);
  return syncing;
};
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);
sync();
chrome.runtime.onStartup.addListener(applyActionBehavior);
applyActionBehavior().catch(() => {});

// The request is queued first (both calls are synchronous), so it is waiting when the side panel boots.
chrome.action.onClicked.addListener((tab) => {
  queue({ kind: 'tab', tabId: tab.id, windowId: tab.windowId });
  openSurface(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'read-page' || !tab) return;
  queue({ kind: 'tab', tabId: tab.id, windowId: tab.windowId });
  openSurface(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'sv-page':
      if (!tab) return;
      queue({ kind: 'tab', tabId: tab.id, windowId: tab.windowId });
      openSurface(tab);
      break;
    case 'sv-here':
      if (!tab) return;
      queue({ kind: 'here', tabId: tab.id, windowId: tab.windowId });
      openSurface(tab);
      break;
    case 'sv-selection':
      if (!tab) return;
      queue({ kind: 'selection', tabId: tab.id, windowId: tab.windowId, text: info.selectionText || '' });
      openSurface(tab);
      break;
    case 'sv-link':
      if (!tab || !/^https?:/i.test(info.linkUrl || '')) return;
      queue({ kind: 'url', url: info.linkUrl, windowId: tab.windowId });
      openSurface(tab);
      break;
    case 'sv-open-tab':
      chrome.tabs.create({ url: chrome.runtime.getURL(`${PANEL}?surface=tab`) });
      break;
    case 'sv-popup-mode':
      popupMode = Boolean(info.checked) || !hasSidePanel();
      chrome.storage.local.set({ [MODE_KEY]: popupMode ? 'popup' : 'sidepanel' }).then(applyActionBehavior, applyActionBehavior);
      break;
    default:
  }
});
