// Records the SiteVocal demo video's frames with Chrome's DevTools protocol (Node 22+, no dependencies).
//
//   python -m http.server 8765 --bind 127.0.0.1      (from the repository root, in another terminal)
//   node store-assets/shots/record-demo.mjs <out-dir>
//   python store-assets/shots/make-demo.py <out-dir> media/sitevocal-demo.mp4
//
// It opens frame.html (the real studio as a side panel beside a sample page) in a fresh Chrome profile, plays the
// scenes below, and saves every screencast frame plus meta.json: the kept time ranges and each utterance's text and
// start/end time, which make-demo.py turns into the narration track. Speech plays at volume 0 while recording.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node record-demo.mjs <out-dir>');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8765/store-assets/shots/';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(OUT, 'frames'), { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'sv-demo-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1320,860', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
if (!target) throw new Error('Chrome did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const waiting = new Map();
const frames = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Page.screencastFrame') {
    const { data: jpeg, metadata, sessionId } = msg.params;
    const ms = Math.round(metadata.timestamp * 1000);
    const name = `${ms}.jpg`;
    writeFileSync(join(OUT, 'frames', name), Buffer.from(jpeg, 'base64'));
    frames.push(ms);
    send('Page.screencastFrameAck', { sessionId });
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function until(expression, timeout = 15000) {
  const t0 = Date.now();
  while (!(await js(expression))) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${expression}`);
    await sleep(100);
  }
}
async function open(url) {
  await js('window.__stale = true'); // so the wait below cannot pass on the page being left
  await send('Page.navigate', { url });
  await until(`!window.__stale && document.readyState === 'complete'`);
  // Chrome may stop sending frames for a new, still page: restart the screencast on every page.
  await send('Page.stopScreencast');
  await send('Page.startScreencast', SCREENCAST);
  await sleep(400);
}
const SCREENCAST = { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 };
// The on-device Windows voice, so nothing is sent to an online voice and make-demo.py can narrate with the same one.
const VOICE = process.env.VOICE || 'Microsoft David - English (United States)';
const frameUrl = (p) => `${BASE}frame.html?${new URLSearchParams({ h: 720, voice: VOICE, ...p })}`;
const segments = [];
const utterances = [];
const keep = async (fn) => {
  const seg = { start: Date.now(), end: 0 };
  await fn();
  seg.end = Date.now();
  segments.push(seg);
};
const collect = async () => utterances.push(...(await js('JSON.stringify(window.__utt || [])').then(JSON.parse)));
const studioScrollTop = `(() => { const sc = demo.studio().querySelector('.sv-main.sv-scroll'); sc.scrollTo({ top: 0, behavior: 'smooth' }); return true; })()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
await send('Page.startScreencast', SCREENCAST);

// Scene 1: an article, the icon, the side panel reading it, then the summary.
await open(frameUrl({ page: 'article.html', url: 'https://fieldnotes.example/the-commute-is-the-new-library', panel: '0', head: 'Hear any web page', sub: 'Click the SiteVocal icon on any article.' }));
await until(`document.getElementById('page').contentDocument.readyState === 'complete'`);
await keep(async () => {
  await js('demo.point(700, 470)');
  await sleep(1300);
  await js(`demo.pointAt('.ext')`);
  await sleep(1000);
  await js('demo.tap(); demo.openPanel()');
  await sleep(700);
  await js('demo.hide()');
  await until('demo.ready()');
  await js(`demo.caption('It reads the story, not the ads', 'Banners, pop-ups and sign-up boxes are skipped. Follow along sentence by sentence.')`);
  // Tap the article's first sentence: reading starts there (past SiteVocal's spoken intro).
  await js(`(() => { const s = [...demo.studio().querySelectorAll('.sv-seg')].find((e) => /For most of history/.test(e.textContent)); s.dataset.demo = 'first'; return true; })()`);
  await sleep(600);
  await js(`demo.pointInStudio('[data-demo="first"] .sv-seg-text')`);
  await sleep(900);
  await js(`demo.tap(); demo.studio().querySelector('[data-demo="first"] .sv-seg-text').click()`);
  await sleep(500);
  await js('demo.hide()');
  await sleep(11000);
  await js(studioScrollTop);
  await sleep(800);
  await js(`demo.pointInStudio('[data-mode="summary"]')`);
  await sleep(1000);
  await js(`demo.tap(); demo.studio().querySelector('[data-mode="summary"]').click()`);
  await js(`demo.caption('Short on time? Hear the summary first', 'The key points of any article, in under a minute.')`);
  await sleep(500);
  await js('demo.hide()');
  await until(`!!demo.studio().querySelector('.sv-summary')`);
  // The offer to download Chrome's on-device AI model (a toast) would cover the summary: close it as it appears.
  await js(`(async () => { for (let i = 0; i < 30; i++) { const x = demo.studio().querySelector('.sv-toast-x'); if (x) { x.click(); return true; } await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  await sleep(9000);
});
await collect();

// Scene 2: a company homepage as a Site Briefing, then the privacy panel.
await open(frameUrl({ page: 'company.html', url: 'https://harborandpine.example/', head: 'Know any company in a minute', sub: 'Site Briefing: who they are, what they sell, what it costs, and the top FAQs.', bg: '#4a2410', bg2: '#7a3e1d' }));
await until('demo.ready()');
if (!(await js(`!!demo.studio().querySelector('.sv-dossier')`))) {
  await js(`demo.studio().querySelector('[data-mode="briefing"]').click()`);
  await until(`!!demo.studio().querySelector('.sv-dossier')`);
}
await sleep(300);
await keep(async () => {
  await sleep(10500);
  await js(`demo.pointInStudio('[data-action="toggle"]')`);
  await sleep(900);
  await js(`demo.tap(); demo.studio().querySelector('[data-action="toggle"]').click()`);
  await sleep(500);
  await js(`demo.pointInStudio('#btnPrivacy')`);
  await sleep(900);
  await js(`demo.tap(); demo.studio().getElementById('btnPrivacy').click()`);
  await js(`demo.caption('Private by design', 'No account. No analytics. No SiteVocal servers. It shows you when a voice runs online.')`);
  await sleep(500);
  await js('demo.hide()');
  await sleep(4200);
});
await collect();

// Scene 3: the end card.
await open(`${BASE}promo.html?size=video`);
await sleep(300);
await keep(() => sleep(3500));

await send('Page.stopScreencast');
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ segments, utterances, frames: frames.length }, null, 2));
console.log(`${frames.length} frames, ${segments.length} segments, ${utterances.length} utterances`);
ws.close();
chrome.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
