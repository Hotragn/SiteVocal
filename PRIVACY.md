# SiteVocal privacy policy

**Last updated:** 2 November 2026 · applies to the SiteVocal web app and the SiteVocal Chrome extension, version 2.8.0 and later.

SiteVocal is a free, open-source website-to-speech reader ([source code](https://github.com/Hotragn/sitevocal)). **SiteVocal collects no data.** It has no server, no accounts, no analytics, no advertising and no tracking. The people who make SiteVocal never receive your data: no page you read, no setting and no key is ever sent to us.

## In short

- Everything SiteVocal keeps stays in your browser: the pages in your library, your listening progress, clipped quotes, your pronunciation dictionary, your settings, and any Turbo Engine keys you type.
- **Your data** shows all of it, and clears it in two taps (see [Your data: see it, clear it, forget it](#your-data-see-it-clear-it-forget-it)).
- The Chrome extension installs with **no access to your websites**. It reads a tab only when you click its icon on that tab, use its shortcut, or choose one of its right-click items there. Access to all sites is optional: Chrome asks you first, and you can take it back.
- By default, page text is never sent to any cloud service. The player's privacy panel says **0 Bytes Sent to Cloud** while that is true.
- Page text leaves your device only in the cases listed below, each started by you and shown in the interface. In the extension, SiteVocal asks you in its own window before the first link goes to a public page service.
- **Limited Use:** SiteVocal's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements. Data is used only to read pages aloud for you, is never sold, never used for advertising or credit decisions, and is never read by people.

## What SiteVocal keeps on your device

| Data | Where it is kept | How to delete it |
|---|---|---|
| The text, title, author, logo and colours of pages you ask SiteVocal to read | In memory while you listen, and in your library (`sitevocal_doc_*`) so a page reopens instantly | Remove the page from the Library, or **Your data › Clear everything** |
| Library, Up Next queue, clipped quotes, listening progress, statistics (words spoken, ads removed) | Browser `localStorage` (`sitevocal_*` keys). In the extension, in the extension's own storage | Library › remove, or **Your data › Clear everything** |
| Settings and pronunciation dictionary | `localStorage` (`sitevocal_settings`, `sitevocal_lexicon`) | Docs & Lexicon, or **Your data › Clear everything** |
| Optional Turbo Engine settings and API keys | `localStorage` (`sitevocal_turbo`), on this device only | Docs & Lexicon › Turbo Engine › **Clear keys**, or **Your data › Clear everything** |
| The request from the toolbar icon, shortcut or menu (which tab, which paragraph) | `chrome.storage.session`, cleared when the side panel picks it up or the browser closes | Automatic, or **Your data › Clear everything** |
| Toolbar preference (side panel or popup) | `chrome.storage.local` | **Your data › Clear everything**, or remove the extension |

Removing the extension, or clearing the website's data in your browser, deletes all of it too. Nothing is kept anywhere else, so there is nothing for us to delete or hand over: what is stored stays until you delete it, or until SiteVocal forgets it on close if you turn that on.

## Your data: see it, clear it, forget it

Open **Your data** from the start page (*SiteVocal collects nothing … Your data*), from the Library's footer (*Stored in this browser*) or from the player's privacy panel.

- **What is kept:** how many saved sites, saved pages, clipped quotes, Up Next links and dictionary words there are, whether settings and Turbo keys are saved, and roughly how much space it all takes. In the extension it also shows the site access you gave.
- **What leaves the browser:** the services that may see a page's address or text, as described below.
- **Clear everything** (tap twice): deletes every `sitevocal_*` key, and in the extension also the pending toolbar request and the toolbar preference. Nothing else is touched, not even other data of the website that hosts SiteVocal. SiteVocal then starts again, empty.
- **Forget what I listened to when I close SiteVocal:** when this is on, your library, saved pages, clips, Up Next and listening statistics are erased each time you close SiteVocal: the tab (web app), or the side panel, popup or SiteVocal tab (extension). Settings, your dictionary and Turbo keys stay. Browsers do not let a page ask you a question as it closes, so you make this choice once, here, ahead of time.
- After your first listen, a one-time note under *Continue listening* says that everything is saved only in this browser, and links to **Your data**.

## Site access in the Chrome extension

- **At install, SiteVocal can read no website.** Chrome does not even show it the address or title of your tabs.
- **When you click SiteVocal on a tab** (the toolbar icon, Alt+Shift+S, or a right-click item), Chrome's `activeTab` permission lets it read that one tab, until the tab goes to a different site or is closed. That is all SiteVocal needs to read the page you are on.
- **Allow all sites (optional).** If you want the side panel to read any tab you switch to, and pasted links to load straight from your browser (with your sign-ins), press **Allow all sites** in the side panel. Chrome shows its own prompt first. You can remove it in the privacy panel (*Site access · Remove*) or in `chrome://extensions`.
- **With all sites allowed**, a small helper (`context-hook.js`) also runs on web pages. It only remembers which element you last right-clicked, so *Start SiteVocal From Here* knows where to begin. It sends nothing and changes nothing. Without that access it never runs, and *Start SiteVocal From Here* starts at the text you select.
- **One service at a time.** For the optional Turbo Engine, SiteVocal asks Chrome for access to only that service, for example `https://api.fish.audio/*`, when you press **Test voice** or **Allow** in its notice.
- **Before Chrome asks.** **Allow all sites** first opens SiteVocal's own explanation of what changes (including that a page which blocks direct loading, or builds itself with JavaScript, has its address sent to a public page service). Chrome's prompt follows only when you press **Continue**.

## Public page services: asked first (Chrome extension)

Without access to a site, the extension can open a pasted link only through a public page service: `api.allorigins.win`, `api.codetabs.com`, `corsproxy.io` or `r.jina.ai`. That service fetches the page and so sees its address.

- **The first time**, the loading card asks you before anything is sent: *Open links this way*, *Allow all sites instead* or *Not now*. *Not now* sends the link nowhere.
- **Your answer is kept** and shown in **Your data** (*Public page services*), where **Ask again** takes it back. **Clear everything** forgets it too.
- **Loading ahead stays private.** Without site access, the extension loads a link ahead of time only after you agreed, and only a link you pasted or typed. Resting the pointer on an item never sends its address anywhere.

## When data leaves your device

1. **Pages you ask SiteVocal to open.**
   - **The extension, reading a tab:** it reads the tab locally. No network request is needed.
   - **GitHub links** (repositories, files, issues, pull requests and discussions) are read from GitHub's own servers, `api.github.com` and `raw.githubusercontent.com`, without cookies. Past the API's limit of 60 requests an hour, and always for discussions (which the API does not serve), an issue, pull request or discussion is read from the page itself, the same way as any other pasted page (below).
   - **Wikipedia and Hacker News** pages are fetched from their official public APIs.
   - **Any other pasted URL or link** ("Read linked page with SiteVocal"):
     - **In the extension, with all sites allowed**, the page is first requested from the website itself. This request carries your browser cookies, so pages you are signed in to work. Only if that fails, or the site sends an empty page that builds itself with JavaScript, are the services below tried. For an empty page, only the reader (`r.jina.ai`, or the one you saved a key for) is asked: the public proxies would return the same empty page.
     - **In the web app, and in the extension without that access** (once you agreed, as described above), two routes start at the same moment so that the page opens quickly: the website itself and the public CORS proxy `api.allorigins.win`. The reader `r.jina.ai` (run by Jina AI), which opens the page in its own browser and returns its text, is asked only when it is needed: the page builds itself with JavaScript, the other routes fail, or none of them answers within 0.22 seconds. A page that arrives in time never reaches it. After 0.35 seconds `api.codetabs.com` joins, and after 2.5 seconds `corsproxy.io`. The first route that returns the page is used and the others are cancelled.
     - These services receive the address of the page you asked for, and fetch that page themselves. Like any web request, this tells them your IP address and browser. They never receive your library, your settings or any other page. Their own privacy policies apply. The status line and the error card name the routes that were tried.
     - **With your own reader key** (*Docs & Lexicon › Turbo Engine › Page reader*), the address is sent with your key to the reader you chose, at the moments described above. A Jina key is used in place of the keyless `r.jina.ai` request. TinyFish (`api.fetch.tinyfish.ai`) is used in place of the keyless reader too, and keyless `r.jina.ai` is asked only if TinyFish fails.
   - **When loading starts:** a link starts loading as soon as you paste it into an address field, when you stop typing a full address for a quarter of a second, or when you rest the pointer on a Quick Try, Up Next or Library item. That way it is ready when you press Listen. The loaded page is kept in memory only (at most 10 pages, for 5 minutes) and never written to disk until you listen to it.
   - **Site images:** logos and the cover image are loaded from the website to show them and to match the player to the site's colour. In the extension, logos are fetched without cookies, never from your local network and never through a public page service. When a site offers no usable logo, the web app shows the one Google's favicon service has for its domain (`www.google.com/s2/favicons`), which tells Google that domain; the extension never does, and shows a letter instead.
2. **Speech voices.** SiteVocal speaks with the voices in your browser and operating system.
   - On-device voices send nothing anywhere.
   - Some voices are online voices run by your browser's maker, for example Google voices in Chrome or Microsoft "Online (Natural)" voices in Edge. With those, the browser sends each sentence to that company under its privacy policy.
   - SiteVocal shows this in the privacy panel ("Cloud voice · text sent to …") and switches to an on-device voice in one click.
3. **Your browser's built-in AI.** When your browser has an on-device AI model (Chrome's Gemini Nano today; Edge and others where they provide one) and it is downloaded, ✨ Summarize Page gives it the page's text, told to ignore menus, names, counts and captions, and to write a short summary. It runs on your device and nothing is sent anywhere; the browser manages the model under its own terms. SiteVocal never starts the model download by itself: it happens only when you click *Download* (in the summary's notice or in Docs & Lexicon › Turbo Engine).
4. **The optional Turbo Engine.** Off by default. If you paste your own key in *Docs & Lexicon › Turbo Engine*:
   - **What is sent:** your key, plus one of these. For a Turbo voice, the sentence being spoken. For a Turbo summary, the page's title, site name and section text, up to about 24,000 characters. For a page reader, the address of the page you open. Nothing else is sent.
   - **Where it goes:** only the endpoint you saved a key for. That is Fish Audio (`api.fish.audio/v1/tts`), the OpenAI-compatible URL you typed, Jina (`r.jina.ai`) or TinyFish (`api.fetch.tinyfish.ai`). Requests to any other address are refused.
   - **How it is sent:** encrypted (HTTPS), without cookies and without a referrer. An OpenAI-compatible address with plain `http://` is used only for a server on your own computer or local network; any other `http://` address is saved but never used, and the form says so.
   - **What you see:** the privacy panel names the service and counts the bytes sent.
   - **Whose rules apply:** that provider's terms and privacy policy cover what it does with the text. **Clear keys** returns SiteVocal to 0 bytes sent.
5. **Fonts.** The interface fonts (Plus Jakarta Sans, Newsreader, JetBrains Mono) ship with SiteVocal, so no font service is contacted.

## Security

- Every service SiteVocal sends anything to on its own is reached over HTTPS: the page services, GitHub, Wikipedia, Hacker News and the Turbo Engine services (plain `http://` only for a Turbo server on your own computer or network).
- Keys are stored only in this browser and are sent only to the service they belong to, in the request header that service expects.
- Pages are parsed in an inert document and only their text is shown, escaped; SiteVocal runs no code from any page or service.

## What SiteVocal never does

- It never collects, sells, rents or shares your data. There is nothing to collect it with: no server, no account and no analytics.
- It never uses your data for advertising, profiling or credit decisions.
- It never collects analytics or crash reports.
- It never reads a tab you did not ask it to read: the tab you clicked SiteVocal on, a tab you press *Read this tab* on, or, with all sites allowed, the tab next to the side panel you opened or a tab showing an address you paste.
- It never downloads or runs remote code. Every script ships with the app.

## Chrome extension permissions

| Permission | Used for |
|---|---|
| `activeTab`, `scripting` | Reading the tab you click SiteVocal on (icon, shortcut or right-click item), with the packaged `content.js` |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | **Not granted at install.** Asked for only when you press **Allow all sites** (then: reading the tab next to the side panel, or the open tab that shows an address you paste; fetching pages you paste or link, and site logos; the right-click helper), or for one Turbo service when you press **Test voice** or **Allow** (then: sending your text or page address to that endpoint only, with your key) |
| `sidePanel` | Playing in Chrome's side panel while you browse |
| `contextMenus` | *Read this page*, *Start SiteVocal From Here*, *Speak Selection*, *Read linked page* |
| `storage` | Passing toolbar and menu requests to the side panel, and remembering side panel or popup mode |

## Children

SiteVocal is a general-purpose reading tool, not directed at children under 13. It collects no personal information from anyone.

## Changes and contact

Changes to this policy are published in this file in the [SiteVocal repository](https://github.com/Hotragn/sitevocal), with the date at the top. Questions or concerns: [open an issue](https://github.com/Hotragn/sitevocal/issues).
