# filmix-parser

A Filmix client for TypeScript: searching, reading post metadata, and **resolving direct CDN
links for every translation**. Media transfer is deliberately out of scope — there is no
downloader.

Zero runtime dependencies: the global `fetch`, `node:fs`, `node:crypto` and `node:util` cover
everything the Go version got from the standard library.

```bash
npm install          # dev dependencies only
npm run build        # tsc → dist/
npm run check        # typecheck + lint + tests
```

## Library

```ts
import { Client, consoleLogger } from 'filmix-parser';

const client = new Client({ logger: consoleLogger('info') });

const results = await client.search('Матрица');
const post = await client.getPost(results[0]!.id);

const links = await client.resolveLinks({ post });   // movies
// const links = await client.resolveLinks({ post, season: 2, episode: 5 }); // series

console.log(links.source);                            // 'site' | 'mobile'
for (const t of links.translations) {
  for (const [quality, url] of t.urls) {
    console.log(t.translation, `${quality}p`, url);
  }
}
```

With a website session the URLs are decoded from the `#2` manifests; otherwise they are derived
from the mobile API's `player_links` templates:

```ts
await client.loginByPassword('user', 'pass');         // → links.source === 'site'
```

`resolveLinks` applies **no quality cap** — every advertised quality is returned and the caller
decides. Pin the path with `source`:

```ts
await client.resolveLinks({ post, source: 'site' });   // fail loudly if the website path can't be used
await client.resolveLinks({ post, source: 'mobile' }); // ignore the website session
```

With `'auto'` (the default) a website-path failure silently downgrades to the mobile API;
`'site'` raises the underlying error instead, which is what you want while debugging.

**Content gating.** Resolved URLs are always well-formed and return `200`, but without
authorization the CDN serves a placeholder clip instead of the content — at *every* quality,
480p included. Measured on 2026-11-04: three different translations of one post returned
byte-identical placeholder files whose `Content-Length` and MP4 structure look entirely
plausible, so the substitution is not detectable from the headers. The upstream Go client
behaves identically, so this is a server-side gate keyed on the device token, not a client
issue.

Every method takes an optional `{ signal }` — the `context.Context` equivalent.

## CLI

```bash
filmix search "Матрица"
filmix info <id|url>                  # metadata + CDN links
filmix links <id|url>                 # just the CDN links
filmix login --user X --password Y     # website session (or bare `login` for the device flow)
FILMIX_DEBUG=1 filmix ...              # verbose logging
```

`info` / `links` flags: `--season <n>`, `--episode <n>` (series, default S1E1),
`--translation <name>`, `--source auto|site|mobile`, `--no-links` (`info` only),
`--user` / `--password` (also `FILMIX_USER` / `FILMIX_PASS`).

```
$ filmix info 154246
ID:        154246
Title:     Матрица: Воскрешение
Original:  The Matrix: Resurrections
Year:      2021
Type:      movie
Translations:
  - Дубляж [Rus, 4K, SDR]  qualities=[2160 1440 1080 720 480]
  - HEVC 4К AC3  qualities=[2160]

CDN links (mobile: derived from the mobile API templates):
  HEVC 4К AC3
    2160p  https://chache08.werkecdn.me/s/<signature>/hevc/The.Matrix…HEVC_2160.mp4
  Дубляж [Rus, 4K, SDR]
    2160p  https://nl03.werkecdn.me/s/<signature>/uhd_018/The.Matrix…rus_2160.mp4
    1080p  https://nl03.werkecdn.me/s/<signature>/uhd_018/The.Matrix…rus_1080.mp4
```

The session is persisted in `<config dir>/filmix/config.json` (mode 0600), using the same JSON
field names as the Go CLI, so the two can share a config file. Delete it to start fresh.

## Two paths to a CDN link

`Client.resolveLinks` tries them in priority order.

### Path A — website session (`src/site/`)

Preferred, requires `loginByPassword`.

1. POST `/api/movies/player-data` → JSON with `translations.video` = `{name: "#2..."}` per dub.
2. **Decode `#2` locally** (`site/decoder.ts`) → URL of a `.txt` manifest on `filmix.my/pl/...`.
3. GET that manifest with the same session → another `#2`-encoded blob.
4. Decode → JSON playlist (`parsePlaylist`) → per episode a `file` field shaped
   `[480p]URL,[720p]URL,[1080p]URL` — those are the direct CDN URLs.

### Path B — mobile API (`src/client/`)

Fallback, needs no credentials.

1. `discover` probes the fallback list concurrently.
2. `ApiClient.getPost` → `Post` with `player_links`.
3. Substitute each quality into the embedded template (`_[1080,720,480].mp4` or `_%s.mp4` —
   both supported by `applyQuality`), optionally refreshing the livehash prefix.

## Critical non-obvious knowledge

These reflect empirical findings about how Filmix behaves, not things derivable from the code.

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
the resolver falls back to the mobile API instead of returning a mangled URL.

### Warm-up before `player-data`

The site answers `/api/movies/player-data` with **HTTP 403** unless the session has GET'd a page
that mentions the post. `SiteClient` does this first; pass the post URL when known, otherwise
`/play/{id}` works. The final URL after redirects becomes the `Referer` of the POST — which is
why the cookie session follows redirects manually.

### URL-host preference for the site path

When `ResolveRequest.sourceUrl` is set and its host differs from the configured mirror, the
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

### Per-translation resilience

A translation whose manifest cannot be fetched, decoded or matched to the requested
season/episode is **skipped** (logged as `filmix.site_translation_skip`), so one broken dub
cannot hide the rest. On the mobile path a dub that simply does not carry the requested
season/episode is skipped the same way — unless the caller pinned it with `translation`, in which
case the error surfaces.

A rights-holder takedown (`lv` flag in player-data) raises `ContentLockedError` and is **not**
retried through the mobile path: that verdict is authoritative.

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

### Mirrors go stale

The default site mirror is `https://filmix.gg`; `filmix.my`, the default the Go client shipped
with, now 301-redirects there. Override it with the `mirror` option when it moves again — and
note that a mirror serving a 301 breaks the login POST, because a redirected POST degrades to a
bodyless GET in every HTTP client.

### Livehash

`WithLivehash` is off by default (`livehash: true` to enable). It issues an extra request to
`/api/v2/post/171042` and rewrites the `/s/{hash}/` prefix of resolved URLs — only useful for the
mobile path when CDN URLs go stale.

## Design notes

Decisions worth knowing when reading the code, contrasted with the Go client this project took
its protocol knowledge from.

| Area | Go client | this project |
| --- | --- | --- |
| Download | `download/` package, `Client.Download`, CLI `download` | **removed** — `Client.resolveLinks` returns the CDN URLs instead |
| Quality cap | 720p site / 480p guest / plan cap, enforced on download | none: every advertised quality is returned |
| Configuration | functional `With*` options | a `ClientOptions` object |
| Cancellation | `context.Context` | `AbortSignal` via `{ signal }` |
| Errors | sentinel values + `errors.Is` | error classes + `isErrorOfType` (walks `cause`) |
| Logging | `log/slog` | a four-method `Logger` interface (`consoleLogger`, `discardLogger`) |
| HTTP | `*http.Client` | `HttpClient` wrapper over `fetch` (injectable for tests) |
| Cookies | `net/http/cookiejar` | host-scoped `CookieJar` + manual redirect following |
| Failure signalling | `(value, error)` tuples | thrown errors |
| Maps | `map[int]Season` etc. | `Map<number, Season>` |
| `Plan` | `int` iota with `String()` | string union (`'guest' \| 'free' \| 'pro' \| 'pro_plus'`) |
| CLI | `login`/`search`/`info`/`download`, stdlib `flag` (flags first) | `login`/`search`/`info`/`links`, `node:util.parseArgs` (order-independent) |
| JSON decoding | struct tags, strict types | explicit decoders that also accept numeric strings |
| `DeviceInfo` | duplicated public/internal structs | one exported interface |
| Concurrency | mutexes and `sync.Once` | memoised promises (single-threaded runtime) |
| Token redaction | `user_dev_token=%2A%2A%2A` | `user_dev_token=***` (URLSearchParams does not escape `*`) |
| String sorting | UTF-8 byte order | UTF-16 code-unit order (identical for all BMP text) |

Dropped along with the downloader: resumable transfers, `.part` files, progress reporting,
destination derivation and the episode-range CLI flags (`--episodes`, `--output`).

## Layout

```
src/
  index.ts          public surface
  filmix.ts         Client facade: bootstrap, auth, search, link resolution
  options.ts        ClientOptions / defaults
  errors.ts         error classes + isErrorOfType
  logger.ts         Logger interface
  models/           Post, Profile, SearchResult, quality helpers, loose JSON readers
  client/           ApiClient, host discovery, livehash cache
  auth/             device-token flow, password flow, token stores
  site/             website path: player-data, #2 decoder, manifest playlist
  internal/         HTTP plumbing, cookie jar, device id, timers
  cli/              the `filmix` command
test/               vitest suites and JSON fixtures
```

## Acknowledgements

Built under the inspiration of [`n0madic/go-filmix`](https://github.com/n0madic/go-filmix) — that
project showed how the Filmix endpoints, the `#2` payload obfuscation and the two routes to a CDN
link fit together, and this implementation grew out of studying it. Thanks to its author.
