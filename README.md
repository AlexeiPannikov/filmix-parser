# filmix-ts

TypeScript port of [`n0madic/go-filmix`](https://github.com/n0madic/go-filmix) — a library and
CLI for resolving Filmix content metadata and streaming MP4 files to disk.

Zero runtime dependencies: the global `fetch`, `node:fs`, `node:crypto` and `node:util` cover
everything the Go version got from the standard library.

```bash
npm install          # dev dependencies only
npm run build        # tsc → dist/
npm run check        # typecheck + lint + tests
```

## Library

```ts
import { Client, consoleLogger } from 'filmix-ts';

const client = new Client({ logger: consoleLogger('info') });

await client.loginByPassword('user', 'pass');          // website session (preferred)
const results = await client.search('Inception');
const post = await client.getPost(results[0]!.id);

await client.download({
  post,
  destination: '/tmp/',                                 // trailing slash → CDN filename in dir
  progress: (done, total) => process.stdout.write(`\r${done}/${total}`),
});
```

Device-token flow (when password login is not desired):

```ts
const pending = await client.authenticate();            // show pending.userCode to the user
await client.waitForActivation(pending, 5000);          // polls until activated
```

Every method takes an optional `{ signal }` — the `context.Context` equivalent.

## CLI

```bash
filmix login --user X --password Y        # or bare `filmix login` for the device flow
filmix search "query"
filmix info <id|url>
filmix download [flags] <id|url>
FILMIX_DEBUG=1 filmix ...                 # verbose logging
```

The session is persisted in `<config dir>/filmix/config.json` (mode 0600), using the same JSON
field names as the Go CLI, so the two can share a config file. Delete it to start fresh.

## Two paths to the content

The repository implements **two parallel paths** to a downloadable MP4 URL. `Client.download`
calls them in priority order.

### Path A — website session (`src/site/`)

Preferred. Driven by `loginByPassword` → password POST → cookie jar.

1. POST `/api/movies/player-data` → JSON with `translations.video` = `{name: "#2..."}` per dub.
2. **Decode `#2` locally** (`site/decoder.ts`) → URL of a `.txt` manifest on `filmix.my/pl/...`.
3. GET that manifest with the same session → another `#2`-encoded blob.
4. Decode → JSON playlist (`parsePlaylist`) → per episode a `file` field shaped
   `[480p]URL,[720p]URL,[1080p]URL`.
5. Pick season/episode/quality → direct CDN URL → `Downloader.do`.

### Path B — mobile API (`src/client/`)

Fallback, used when there is no site session or the site path fails.

1. `discover` probes the fallback list concurrently.
2. `ApiClient.getPost` → `Post` with `player_links`.
3. Substitute the quality into the embedded URL (`_[1080,720,480].mp4` or `_%s.mp4` — both
   supported by `applyQuality`).
4. Optional livehash refresh, then `Downloader.do`.

## Critical non-obvious knowledge

Carried over from the Go implementation; these reflect empirical findings, not things derivable
from the code.

### `#2` decoder

`site/decoder.ts` removes **five fixed 24-char base64 garbage chunks** (constants in the file)
interleaved into the real payload, then base64-decodes. A chunk may be **split** (prefix in one
place, suffix later, real text between) — `removeChunk` handles both layouts. If
`CannotDecodeError` starts firing, the server rotated its garbage chunks; recover them by
comparing common substrings across the four `video` entries of one `player-data` response (they
share garbage and differ in real content).

Decoded output is validated with `looksLikeText`: the split-chunk fallback can spuriously match
real base64 noise, and the resulting payload decodes "successfully" into bytes containing
control characters. Any control byte outside `\t\n\r` means corruption, so the decode fails and
the caller falls back to the mobile API instead of forwarding a mangled URL.

### Warm-up before `player-data`

The site answers `/api/movies/player-data` with **HTTP 403** unless the session has GET'd a page
that mentions the post. `SiteClient` does this first; pass the post URL when known, otherwise
`/play/{id}` works. The final URL after redirects becomes the `Referer` of the POST — which is
why the cookie session follows redirects manually.

### URL-host preference for the site path

When `DownloadRequest.sourceUrl` is set and its host differs from the configured mirror, the
warm-up and player-data POST go to the **URL's host** first; session cookies are mirrored across
hosts on a best-effort basis. On any failure the call is retried against the configured mirror.
`PasswordAuthenticator.mirrorCookiesTo` refuses hosts that do not look like a Filmix mirror
(`ForeignMirrorHostError`), and the CLI's `parseIdArgWithUrl` rejects them even earlier.

### `player_links` dual shapes

`parsePlayerLinks` handles:

- **Movie**: `{"movie": [{"translation": "...", "link": "..."}]}`.
- **Series**: `{"playlist": {"<season>": {"<translation>": <episodes>}}}` where `<episodes>` is
  **either an array or a dict keyed by stringified episode number** — both occur.
- **Movie posts** return `playlist` as `[]` (empty array, not `{}`); that is tolerated.

The API returns `id`/`year`/`section` as JSON **numbers**, though some endpoints use strings; the
decoders accept either.

### Quality cap policy

Lives in `Client.download` / `Client['qualityCap']`, not in `maxQualityFor`:

- Active site session → cap 720p (Free tier). Pass an explicit `quality` to override.
- Site session failed → cap 480p (guest), because the mobile-API path without a device token
  serves only ~10-second previews at higher qualities.
- No site session → cap `maxQualityFor(currentPlan())`.

`pickBest` enforces the cap strictly, so the site path falls back to a **different translation**
rather than downloading an over-cap preview clip. With an empty `translation`, candidates are
tried alphabetically; one whose manifest offers nothing under the cap (e.g. an alphabetically
first "HEVC 4K" dub with only `[4K UHD]`) is skipped and logged as
`filmix.site_translation_skip`. An explicit `translation` disables the loop.

### Download timeout

`Downloader` **drops** the configured `timeoutMs`, because it applies to the whole request
lifecycle, body included — a 30 s timeout cuts 100+ MB streams. Per-call cancellation goes
through `signal`.

### Destination derivation and partial files

`deriveDestination` resolves the output path from the CDN URL after path selection: empty hint →
URL basename in the CWD; trailing `/` or platform separator → URL basename inside that
directory; anything else → used verbatim.

The partial file is `<dest>.part[_<variant>][_<quality>p]`. `quality` is the picked pixel height
(so a 480p partial is never resumed against a 720p URL) and `variant` is `translationKey(name)`
— the translation name with non-alphanumerics stripped, bounded to 16 characters, Unicode-aware.
The same translation across runs yields the same key and resumes the same partial; different
translations get distinct partials that coexist on disk.

### Direct file-field shortcut

Most posts follow the two-layer flow, but **4K HEVC movies break it**: the encoded video link
decodes straight to a bracketed file field (`[4K UHD]https://cdn/...mp4,...`) instead of a
manifest URL. `SiteClient.fetchPlaylist` detects the leading `[` and builds a single-entry movie
playlist without the second HTTP round-trip.

### Non-numeric quality labels

`labelToQuality` maps any `[label]` to a pixel height: anything containing `4K` or `UHD` → 2160;
otherwise the first numeric run (`1080p` → 1080, `720` → 720). Needed for 4K posts whose file
field reads `[4K UHD]URL`.

### Login success detection

`PasswordAuthenticator.login` does **not** check `Set-Cookie`: the DLE-style cookies are not set
on AJAX login. Success is signalled by the body containing the literal string `AUTHORIZED`; the
binding is server-side, keyed by the cookies set during the priming GET.

## Differences from the Go implementation

Behavioural parity was the goal; these are the deliberate deviations.

| Area | Go | TypeScript |
| --- | --- | --- |
| Configuration | functional `With*` options | a `ClientOptions` object |
| Cancellation | `context.Context` | `AbortSignal` via `{ signal }` |
| Errors | sentinel values + `errors.Is` | error classes + `isErrorOfType` (walks `cause`) |
| Logging | `log/slog` | a four-method `Logger` interface (`consoleLogger`, `discardLogger`) |
| HTTP | `*http.Client` | `HttpClient` wrapper over `fetch` (injectable for tests) |
| Cookies | `net/http/cookiejar` | host-scoped `CookieJar` + manual redirect following |
| Failure signalling | `(value, error)` tuples | thrown errors |
| Maps | `map[int]Season` etc. | `Map<number, Season>` |
| `Plan` | `int` iota with `String()` | string union (`'guest' | 'free' | 'pro' | 'pro_plus'`) |
| CLI flags | stdlib `flag`: flags must precede positionals | `node:util.parseArgs`: order-independent, plus `--no-progress` |
| JSON decoding | struct tags, strict types | explicit decoders that also accept numeric strings |
| `DeviceInfo` | duplicated public/internal structs | one exported interface |
| Concurrency | mutexes and `sync.Once` | memoised promises (single-threaded runtime) |
| Token redaction | `user_dev_token=%2A%2A%2A` | `user_dev_token=***` (URLSearchParams does not escape `*`) |
| String sorting | UTF-8 byte order | UTF-16 code-unit order (identical for all BMP text) |

Not ported: `WithHTTPClient`-style transport sharing with a pre-built client (pass `fetch`
instead), and the Go module's `golang.org/x/term` dependency (the password prompt is implemented
on `node:readline` and raw-mode stdin).

## Layout

```
src/
  index.ts          public surface
  filmix.ts         Client facade: bootstrap, auth, search, download orchestration
  options.ts        ClientOptions / defaults
  errors.ts         error classes + isErrorOfType
  logger.ts         Logger interface
  models/           Post, Profile, SearchResult, quality helpers, loose JSON readers
  client/           ApiClient, host discovery, livehash cache
  auth/             device-token flow, password flow, token stores
  site/             website path: player-data, #2 decoder, manifest playlist
  download/         resumable streaming downloader
  internal/         HTTP plumbing, cookie jar, device id, timers
  cli/              the `filmix` command
test/               vitest suites, fixtures shared with the Go repo's client/testdata
```
