# vendor/

Third-party code that SiteVocal ships as local files, so that `index.html` loads no remote code: no `<script src="https://…">`. This lets the Chrome extension run under the Manifest V3 policy `script-src 'self'` and the web app work from a double-click.

| File | What it is | Version | Licence | Bytes | SHA-384 |
|---|---|---|---|---|---|
| `readability.min.js` | [Mozilla Readability](https://github.com/mozilla/readability), the article extractor, minified | 0.6.0 | Apache-2.0 | 33,310 | `blIOZfp72//4u0DPm64OH7l5vvXl+G++wkZVDZwCwERrXOGZVozV3WpHJkLLeUKE` |
| `styles.css` | [Tailwind CSS](https://tailwindcss.com) utilities used by `index.html` and `app.js`, compiled ahead of time | 4.3.3 | MIT | 28,303 | `vhe2gtE7oVhtgCYLt6NesGdC8Eq1FoOQ3fdoERV3ozCRGPWPOIQ8lh1iGRNE8Jax` |
| `tailwind.input.css` | The compiler input for `styles.css`: the SiteVocal theme and the two files to scan | — | Apache-2.0 | — | — |

Check a file against its hash with `openssl dgst -sha384 -binary vendor/styles.css | openssl base64 -A`.

## `readability.min.js`

- **Source:** `Readability.js` from the npm package [`@mozilla/readability@0.6.0`](https://www.npmjs.com/package/@mozilla/readability/v/0.6.0), identical to [the 0.6.0 tag on GitHub](https://github.com/mozilla/readability/blob/0.6.0/Readability.js).
  - Source SHA-384: `e+TY0H9ZOYdOLMJKCM3iXGmTbjVVh+PJ+GTEKuGjQY0+bsSOJohq+GWUAmhGjKOi`
- **Changes:** none to the code. It is minified with terser 5.51.2, and a licence banner (copyright, Apache-2.0 notice and source link) is prepended.
- **Checked:** the minified build extracts exactly the same article text as the original on the 30 pages of SiteVocal's real-world test corpus.
- **Rebuild** (reproduces the file byte for byte):

  ```sh
  npm pack @mozilla/readability@0.6.0 && tar -xzf mozilla-readability-0.6.0.tgz
  npx terser@5.51.2 package/Readability.js --compress passes=2 --mangle --ecma 2020 --comments false --output body.js
  # banner.txt = the /*! … */ comment at the top of vendor/readability.min.js
  cat banner.txt body.js > vendor/readability.min.js && printf '\n' >> vendor/readability.min.js
  ```

`index.html` loads it with `<script id="sv-readability" src="vendor/readability.min.js">`. If it is missing, SiteVocal falls back to its own built-in extractor.

## `styles.css`

- **Source:** the Tailwind CSS 4.3.3 compiler. This is the same version the earlier builds ran in the browser through the Play CDN, so the generated rules are the same. It scans `index.html` and `app.js` for class names and adds the SiteVocal theme from `tailwind.input.css` (fonts and brand colours).
- **Rebuild** after changing class names in `index.html` or `app.js`. Run from the repository root; this reproduces the file byte for byte:

  ```sh
  npm install --no-save tailwindcss@4.3.3 @tailwindcss/cli@4.3.3
  npx @tailwindcss/cli -i vendor/tailwind.input.css -o vendor/styles.css
  ```

SiteVocal's own component styles live in the `<style>` block of `index.html`. If `styles.css` is missing, a small fallback there keeps icons at icon size and the layout readable.

## Fonts

`fonts.css` and `fonts/*.woff2` are the interface fonts (Plus Jakarta Sans, Newsreader and JetBrains Mono, all under the SIL Open Font License 1.1), unmodified as Google Fonts serves them, with every `url()` pointed at the local files. Bundling them means opening SiteVocal requests nothing from Google. To refresh them, fetch the stylesheet from `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap` with a current Chrome user agent, download each `.woff2` it lists into `fonts/`, and rewrite the URLs.

Full licence texts for everything above are in [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt).
