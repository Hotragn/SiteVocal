# SiteVocal: Chrome Web Store listing kit (version 2.8.0)

Everything the Chrome Web Store Developer Dashboard asks for, ready to paste. The upload package is `sitevocal-chrome-store.zip`. It holds only the files the extension runs: `manifest.json`, `background.js`, `content.js`, `context-hook.js`, `panel.html`, `panel.js`, `index.html`, `app.js`, `vendor/readability.min.js`, `vendor/styles.css`, `icons/`, `LICENSE` and `THIRD_PARTY_NOTICES.txt`.

To rebuild it from a clone of the repository:

```sh
zip -r -X sitevocal-chrome-store.zip manifest.json background.js content.js context-hook.js panel.html panel.js \
  index.html app.js vendor/readability.min.js vendor/styles.css icons LICENSE THIRD_PARTY_NOTICES.txt
```

---

## 1. Store listing tab

### Item name (from `manifest.json`)

```text
SiteVocal — Website to Speech Reader
```

### Summary / short description (from `manifest.json`, 126 of 132 characters)

```text
Hear any web page: a short summary of its key points, a 60-second site briefing, or every word ad-free. No API keys.
```

### Category and language

- **Category:** Make Chrome Yours › **Accessibility**. Productivity › Tools also fits.
- **Language:** English.

### Detailed description (plain text, paste as is)

```text
SiteVocal reads web pages aloud. Click the toolbar icon (or press Alt+Shift+S) and the side panel reads the tab you are on, ad-free, with a live transcript.

WHAT HAPPENS TO YOUR DATA
Nothing is collected: no account, no analytics, no tracking and no server. The pages you ask it to read are processed on your device and saved only in your browser. To open a link without site access, it asks you first; a public page service (allorigins.win, codetabs.com, corsproxy.io or r.jina.ai) then fetches it and sees its address. Online voices, marked "online", send the text they read to the voice's company, such as Google. "Your data" shows and clears everything SiteVocal keeps.

You choose how much you want to hear:

✨ SUMMARIZE PAGE: the short version of any page. One line on what it is, then its three to five strongest points from anywhere on the page, chosen by keyword importance (TF-IDF and TextRank) and the facts, figures and names they carry, and one plain sentence for its pricing or main table. No headings, captions or lists of jargon: usually under a minute.

⚡ SITE BRIEFING: what a company or website does, in about a minute. Who they are, what they offer, pricing and who it is for, and the key questions from their FAQ, read straight from the page. Menus, buttons, cookie banners and "Sign up" lines are never read.

📖 FULL PAGE READ: every word of the article, read like a radio broadcast, with ads and clutter removed first.

TABLES, PRICING GRIDS AND LISTS, READ AS SENTENCES
Most read-aloud tools skip tables or read them cell by cell. In Summarize Page and Site Briefing, they are summarized instead: "Table Summary for Plans compared: Compares 3 items across Price, Storage and Seats. Key highlights: Starter has Price: $0, Storage: 5 GB, Seats: 1; Pro has Price: $12 per month…". Comparison grids, specification lists (dl), and bulleted and numbered lists are summarized the same way, and each one appears as a Summarized Table Card in the transcript.

ANY LINK, AT ONCE
Paste a link into the side panel and it plays in moments: it starts loading the instant you paste it. A page you already have open is read straight from its tab, with nothing downloaded. GitHub repositories, files, issues and discussions come from GitHub's own API, with the project's facts and its full README, and still open past GitHub's hourly limit. Websites that build themselves with JavaScript (Next.js, React) are rendered by the r.jina.ai reader first, so their features, pricing tables and FAQ are read like any other page. The address pill shows each stage: Connecting, Extracting DOM, Ready.

AD-FREE BY DESIGN
Before anything is read, a 3-stage Ad-Shield removes ad slots, sponsored boxes, Taboola and Outbrain grids, "Read more" plugs, affiliate disclaimers and newsletter sign-ups, and shows how many elements it removed. Promotional "Add to cart" boxes are left out of table summaries.

LISTEN YOUR WAY
• Live teleprompter that highlights the sentence being spoken. Click any sentence to start there.
• Section outline with the listening time of each section. Jump anywhere.
• Right-click a paragraph and choose "Start SiteVocal From Here", or select text and choose "Speak Selection".
• "Read linked page with SiteVocal" listens to a link without opening it.
• Follows single-page apps and infinite scroll, with a one-click re-sync that keeps your place.
• A library that remembers where you stopped on every page, an Up Next queue, and quote clipping with the source link.
• Speed from 0.75× to 2×, keyboard shortcuts and media keys.
• A Smart Lexicon that says "for example" for "e.g.", and your own pronunciation dictionary.

YOUR DATA STAYS YOURS
• It collects nothing and has no server, so nothing you read or save is ever sent to its makers.
• Your library, progress, clips and settings stay in your browser. "Your data" shows exactly what is kept, clears it all in two taps, or forgets what you listened to every time you close it.
• Installs with no access to your websites. It reads a tab only when you click its icon there (or use its shortcut or right-click menu). Want the side panel to follow every tab you switch to? Press "Allow all sites": it explains what changes, Chrome asks you, and you can take it back any time.

PRIVATE AND FREE
• No account, no sign-up, no subscription and no API key.
• Uses the speech voices already in your browser and operating system, and picks the most natural one for the page's language.
• The privacy panel shows "0 Bytes Sent to Cloud" when the voice runs on your device, and tells you when a browser voice is an online voice.
• Uses Chrome's built-in on-device AI summarizer when it is already downloaded in your Chrome; otherwise its own offline summary plays instantly.
• No analytics, no ads, no tracking and no remote code. Open source under the Apache 2.0 licence.

OPTIONAL TURBO ENGINE
If you want studio-quality voices or an AI-written summary, you can paste your own Fish Audio key, or any OpenAI-compatible speech or chat endpoint and key, in Docs & Lexicon. Only then is page text sent, and only to the service you chose: the privacy panel names it and counts the bytes. Clear the key and you are back to 0 bytes sent.

SiteVocal helps with long reads, research, studying, proofreading and commutes, and anyone who would rather listen than read, including people with dyslexia, low vision or reading fatigue.

Source code, documentation and issue tracker: https://github.com/Hotragn/sitevocal
```

### Graphic assets

| Asset | Size | Source |
|---|---|---|
| Store icon (required) | 128 × 128 PNG | `icons/icon-128.png`: 96 × 96 artwork with 16 px of transparent padding, as Google's icon guide asks |
| Screenshots (1 to 5 required) | 1280 × 800, 24-bit PNG | In [`store-assets/`](store-assets/): `screenshot-1-summarize-page.png`, `screenshot-2-site-briefing.png`, `screenshot-3-ad-free-reader.png`, `screenshot-4-side-panel.png`, `screenshot-5-privacy-turbo.png` |
| Small promo tile (**required**) | 440 × 280 PNG | [`store-assets/promo-small-440x280.png`](store-assets/promo-small-440x280.png) |
| Marquee promo tile (optional, needed to be featured) | 1400 × 560 PNG | [`store-assets/promo-marquee-1400x560.png`](store-assets/promo-marquee-1400x560.png) |
| Promo video (optional) | YouTube link | Leave empty. Google's listing page names it among the assets; its image guide lists only the icon, one screenshot and the small tile as mandatory |

### Additional fields

- **Official URL / homepage:** `https://github.com/Hotragn/sitevocal`, the `homepage_url` in `manifest.json`.
- **Support URL:** `https://github.com/Hotragn/sitevocal/issues`
- **Mature content:** No.

---

## 2. Privacy practices tab

### Single purpose (paste as is)

```text
SiteVocal reads web pages aloud. For the page you choose, it builds one spoken version (a summary of the whole page, a short briefing of what a company or website does, or the full text with ads and clutter removed) and plays it with your browser's speech voices, alongside a synchronized on-screen transcript.
```

### Permission justifications (one field per permission)

**`activeTab`**

```text
SiteVocal installs with no host permissions, so activeTab is how it reads a page by default. When you click the toolbar icon, press Alt+Shift+S or choose a SiteVocal item in the right-click menu, activeTab gives SiteVocal temporary access to that one tab so it can read the page you asked to hear: its text structure, title, author, logo and theme colours. Nothing is read until you ask.
```

**`contextMenus`**

```text
Adds the right-click items "Read this page with SiteVocal", "Start SiteVocal From Here" (starts at the paragraph you right-clicked), "Speak Selection" (reads only the selected text) and "Read linked page with SiteVocal", plus two items on the toolbar icon's menu: "Open SiteVocal studio in a tab" and "Toolbar icon opens a popup instead of the side panel".
```

**`scripting`**

```text
Used with chrome.scripting.executeScript to inject the packaged content.js file into the tab you ask SiteVocal to read. content.js copies the page's visible content (scripts and hidden elements removed), its logo candidates and theme colours, and returns them to the side panel. It also watches that one tab for single-page-app route changes, so the panel can offer a re-sync. Only files inside the extension package are injected; no remote code.
```

**`sidePanel`**

```text
SiteVocal's player and live transcript run in Chrome's side panel, so you can keep listening and following the highlighted sentence while you scroll, switch tabs or keep browsing.
```

**`storage`**

```text
chrome.storage.session passes the request from the toolbar icon, keyboard shortcut or context menu to the side panel while the panel opens. chrome.storage.local remembers one preference: whether the toolbar icon opens the side panel or a popup. Your listening library, progress, settings and pronunciation dictionary stay on your device, in the extension's own local storage.
```

**Optional host permissions (`http://*/*`, `https://*/*`; nothing is granted at install)**

```text
SiteVocal requests no host permissions at install. These optional ones are requested at run time, with Chrome's own prompt, only when the user asks for what they enable:
(A) "Allow all sites" (a button in the side panel's tab card, error card, privacy panel and Your data dialog) first opens SiteVocal's own explanation of what changes, then, on Continue, requests http://*/* and https://*/*. It lets SiteVocal (1) read the tab beside the side panel after you switch tabs, without clicking the icon again; (2) read the open tab that already shows an address you paste, instead of downloading it again; (3) fetch a page you paste, or a link you pick "Read linked page" on, including sites you are signed in to, before any third-party service is tried; (4) fetch the site's logo, without cookies, to match the player to its brand colour; (5) register context-hook.js on http(s) pages, which only remembers the element you last right-clicked, for "Start SiteVocal From Here", sends nothing and does not change the page.
(B) For the optional Turbo Engine, only the one service the user saved a key for (for example https://api.fish.audio/*) is requested, when they press "Test voice" or "Allow" in its notice, so the text or page address can be sent to that endpoint, with the user's key and without cookies. Any other address is refused.
Without these permissions SiteVocal still works: it reads the tab you click it on (activeTab), and a pasted link loads through a public page service once the user agrees in the loading card. Access can be removed in the privacy panel or in chrome://extensions.
```

### Remote code

- **Are you using remote code?** **No, I am not using remote code.**
- Justification, if asked:

```text
Every script is packaged with the extension: background.js, content.js, context-hook.js, panel.js, app.js and vendor/readability.min.js (Mozilla Readability 0.6.0, minified and unmodified). Extension pages and the sandboxed page run under the CSP script-src 'self'. Nothing calls eval or new Function, and no script is loaded from the network. The optional Turbo Engine and the page readers (r.jina.ai, and TinyFish with the user's key) exchange data only: text or a page address out; audio, JSON or Markdown text back. Nothing they return runs as code: Markdown becomes inert HTML in a DOMParser document and only its text is read. Styles are compiled ahead of time (vendor/styles.css), and the interface fonts come from Google Fonts as a stylesheet.
```

### Data usage

**SiteVocal collects no user data.** The developer receives nothing: SiteVocal has no server, no analytics and no accounts. The form asks what the *extension* handles, and some page data can leave the device at your request, so these are the accurate answers:

| Data type | Tick? | Why |
|---|---|---|
| Website content | **Yes** | SiteVocal reads the text of the pages you choose. It processes them on your device and stores your library locally ("Your data" shows it and clears it; it can also be erased each time SiteVocal closes). Page text leaves the device only when you save a key for the optional Turbo Engine (sent to that endpoint). Page addresses leave it when you paste or link a URL that is not open in a tab and that the extension cannot fetch itself (without site access, only after you agree in the loading card), or that returns an empty page built by JavaScript. An empty page goes to the `r.jina.ai` reader only. Otherwise the URL goes to the public CORS proxy `api.allorigins.win`, then to `api.codetabs.com` and `corsproxy.io` if needed. `r.jina.ai` is asked only for a page built by JavaScript, or when nothing else answers within 0.22 s. The status line shows which one answered. A link starts loading as soon as you paste it, so it is ready when you press Listen. GitHub links are read from `api.github.com` and `raw.githubusercontent.com`; past GitHub's API limit, an issue or pull request is read from the page in the same way. |
| Authentication information | **Yes** | Only the optional Turbo Engine and page-reader API keys you type. They are stored on your device and sent only to the endpoint they belong to, as the `Authorization` header (`X-API-Key` for TinyFish). |
| Web history | **Yes** | Your library is a list of pages you listened to, kept only in this browser. The address of a page you ask SiteVocal to open can reach a public page service (after you agree, in the extension) or the reader, as described under Website content. Google's User Data FAQ counts any URL a browser interacts with as web browsing activity, so it is declared here. Hovering an item never sends its address in the extension. |
| User activity | No | Listening progress is stored locally only. |
| Personally identifiable, health, financial, personal communications, location | No | Not collected. |

Tick all three certifications. SiteVocal does not sell or transfer user data to third parties outside the approved use cases. It does not use or transfer user data for purposes unrelated to its single purpose. It does not use or transfer user data to determine creditworthiness or for lending.

### Privacy policy URL

```text
https://github.com/Hotragn/sitevocal/blob/main/PRIVACY.md
```

---

## 3. Notes for the reviewer (Distribution › Test instructions)

```text
No account or key is needed. SiteVocal installs with no host permissions. Open any article, for example https://en.wikipedia.org/wiki/Speech_synthesis, and click the SiteVocal toolbar icon: the side panel opens and starts reading (activeTab). Switch to another tab and the side panel says it cannot see that tab yet, with an "Allow all sites" button: SiteVocal explains what changes, and Continue shows Chrome's permission prompt. The privacy panel (shield in the player) shows the current site access and removes it. Paste a link that is not open in a tab: without site access, the loading card asks once before a public page service may fetch it, and "Not now" sends nothing. "Your data" (start page, Library footer or privacy panel) lists what is stored locally, shows those answers, and clears everything. To try a pasted link, type https://github.com/mozilla/readability into the address pill at the top of the reader and press Enter. Use the reader's mode switch to try ✨ Summarize Page (a whole-page summary; tables appear as Summarized Table Cards), ⚡ Site Briefing and 📖 Full Read. Right-click a paragraph and choose "Start SiteVocal From Here" to start there. The Turbo Engine in Docs & Lexicon is optional and off by default: with no key saved, nothing is sent to any cloud service, and the privacy panel says 0 Bytes Sent to Cloud.
```

## 4. Pre-submission checklist

In the package:

- [x] Manifest V3. `description` is 116 characters (the limit is 132). `version` is `2.8.0`.
- [x] No host permissions at install: no `host_permissions` and no `content_scripts`. `http://*/*` and `https://*/*` are `optional_host_permissions`, requested only from a user's click, after SiteVocal's own explanation. Chrome shows no permission warning at install.
- [x] No remote code: the CSP is `script-src 'self'` for `extension_pages` and `sandbox`, and both are covered by the extension test suite.
- [x] No `eval`, `new Function` or string timers in any packaged script.
- [x] Every permission in `manifest.json` is used and justified above, the optional host permissions included. There is no `tabs` permission, no `webRequest` and no `cookies`.
- [x] Disclosure and consent inside the product: the loading card asks before the first link goes to a public page service, **Allow all sites** explains before Chrome's prompt, and **Your data** shows and clears everything.
- [x] Secure transmission: every built-in service is HTTPS, and a Turbo endpoint must be HTTPS (plain `http://` only for a server on the user's own computer or network).
- [x] The privacy policy (`PRIVACY.md`) matches the data-usage answers above and carries the Limited Use statement.
- [x] Third-party licences ship in the package (`LICENSE`, `THIRD_PARTY_NOTICES.txt`).

Outside the package (these can't be checked by any tool and block submission if missing):

- [ ] **Publish the repository first.** The privacy policy URL (`https://github.com/Hotragn/sitevocal/blob/main/PRIVACY.md`) and `homepage_url` must open for the reviewer. A broken privacy policy link is a Purple Lithium rejection.
- [ ] Developer account: the one-time US$5 registration, 2-Step Verification on the Google account, a verified contact email, and the trader or non-trader declaration (EU Digital Services Act) in the account settings.
- [ ] Upload `sitevocal-chrome-store.zip`, add the store icon, 1–5 screenshots and the small promo tile, choose the category and paste the texts above.
- [ ] Optional: publish as **Unlisted** first, install it from the store and run through section 3 yourself before making it public.

## 5. Compliance check (21 October 2026, version 2.8.0)

Run on the exact files of `sitevocal-chrome-store.zip`, unpacked. A clean result is not a promise of approval: the listing and the privacy policy page are reviewed too.

| Tool (open source) | Version | Result |
|---|---|---|
| [webstore-lint](https://github.com/Circadian-agent/chrome-extension-rejection-lint) (Chrome Web Store program policies, with the 1 August 2026 updates) | 1.0.35 | **No findings**: 0 failing, 0 needing judgement, 0 informational. Permission ledger: `activeTab`, `contextMenus` (4 call sites), `scripting` (5), `sidePanel` (4), `storage` (10), all used |
| Chromium, loading the package (`chrome://extensions` and `management.getPermissionWarningsByManifest`) | Playwright's Chromium | 0 manifest errors, 0 install warnings, 0 runtime errors. **No permission warning at install.** *Allow all sites* shows "Read and change all your data on all websites"; one Turbo service shows "Read and change your data on api.fish.audio" |
| [addons-linter](https://github.com/mozilla/addons-linter) (Mozilla, the engine behind `web-ext lint`) | 10.14.0 | Its 2 errors and 6 of its warnings are Firefox-only: no Gecko add-on ID, no `background.scripts` fallback, `sidePanel` unsupported, Firefox's `data_collection_permissions`. The 38 `UNSAFE_VAR_ASSIGNMENT` warnings are HTML templates; all were reviewed (next row) |
| [eslint-plugin-no-unsanitized](https://github.com/mozilla/eslint-plugin-no-unsanitized) (Mozilla), with `esc` and `icon` as escapers | 4.1.5 | 27 HTML assignments in `app.js` call SiteVocal's own template helpers. Each was traced by hand: every value taken from a page, an API or the user passes through `esc()` (which escapes `& < > " '`), URLs through `safeHttpUrl`/`safeImageUrl`, and the rest are numbers or fixed strings. 0 in `panel.js`, `content.js`, `background.js`, `context-hook.js`. The 2 in Mozilla Readability are its own code, run on an inert `DOMParser` document |
| [retire.js](https://github.com/RetireJS/retire.js) (known-vulnerable JavaScript libraries) | 6.1.0 | 0 |
| [SchemaStore Chrome manifest schema](https://github.com/SchemaStore/schemastore/blob/master/src/schemas/json/chrome-manifest.json), with [Ajv](https://github.com/ajv-validator/ajv) | Ajv 8.20.0 | `manifest.json` is valid |
| SiteVocal's own suites (Playwright) | — | 527 web checks. Extension: 39 checks on the store package as installed (no site access), and 79 with site access allowed (the 70 earlier checks and 9 newer ones) |

Re-run webstore-lint and retire.js yourself on the unzipped package:

```sh
npx webstore-lint@1.0.35 ./sitevocal-chrome-store        # add --permissions for the ledger
npx retire@6.1.0 --path ./sitevocal-chrome-store
```

Each policy, by the notification ID Google sends with a rejection:

| ID | Policy | SiteVocal 2.8.0 |
|---|---|---|
| Blue Argon | Manifest V3: no remotely hosted code | Every script ships in the package; the CSP is `script-src 'self'`. Markdown and JSON from page services are data, turned into inert text. Google Fonts is a stylesheet, not code |
| Purple Potassium | Excessive permissions | Five permissions, each used (ledger above). Host access is optional and asked for only from a click |
| Purple Lithium | Privacy policy and disclosure | `PRIVACY.md` covers what is kept, what leaves the device and when, sharing, retention, deletion and security, with the Limited Use statement. The URL must open (see the checklist) |
| Purple Nickel | Prominent disclosure and affirmative consent (all user data since 1 August 2026) | In the product: the loading card's question before the first link goes to a page service, *Allow all sites* explained before Chrome's prompt, Turbo keys entered by the user, **Your data** and the privacy panel. In the listing: *What happens to your data*, at the top of the description |
| Purple Copper | Secure transmission | HTTPS everywhere SiteVocal sends anything. Turbo endpoints: HTTPS only, plain HTTP only on the user's own network. A page service receives the page address in its URL, which is how those services work, over HTTPS |
| Purple Magnesium | Web browsing activity only for a user-facing feature | Only the links you open. In the extension nothing is loaded ahead on hover, nothing before you agree, and no domain goes to Google's favicon service |
| Yellow Zinc | Missing or insufficient metadata | Name, summary, detailed description, icon, five screenshots, small and marquee promo tiles |
| Yellow Magnesium, Yellow Potassium | Functionality, minimum functionality | Works with no setup: the icon reads the page. Reviewer steps in section 3 |
| Red Titanium | Obfuscation | Readable source. `vendor/readability.min.js` is minified, which is allowed, and `vendor/README.md` gives its source, hash and rebuild steps |
| Red Magnesium, Red Copper, Red Lithium, Red Argon | Single purpose | Reading web pages aloud; the action icon only opens the reader |
| Yellow Argon | Keyword stuffing | No lists of sites, brands or places, and no testimonials in the description |
| Red Nickel, Red Potassium, Red Silicon | Deceptive behavior | The listing describes what the code does. "Collects nothing" is literal: there is no server |
| Yellow Lithium | Redirection | Not a launcher for another site or product |
| Malicious and Prohibited Products | Includes circumventing paywalls or logins | No bypass of either: a tab is read as the browser shows it to you, with hidden elements removed first |
| Grey Zinc to Grey Silicon, Grey Titanium, Blue Zinc to Blue Potassium, Red Zinc, Yellow Nickel, Blue Titanium | Content, gambling, mining, affiliate ads, overrides, deceptive installation, spam, enforcement circumvention | Not applicable: none of these exist in SiteVocal |
