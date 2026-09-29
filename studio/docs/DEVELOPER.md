# Ootto Studio: developer guide

How the studio is built, how data moves through it, and how to change it. For setup and day-to-day use, see the [README](../README.md).

## At a glance

- **Runtime:** Node.js 20+, ES modules, one dependency besides Express: `ffmpeg-static` (ffmpeg 7 with libass, libx264, libvpx, libmp3lame).
- **No build step.** The web app in `public/` is plain HTML, CSS and a single ES module. The server serves it as is.
- **No database server.** Everything lives in `data/` (see [Data](#data)).
- **AI services** are called over plain REST with `fetch`, so there are no SDK versions to track: OpenAI (`src/openai.js`) and Anthropic Claude (`src/anthropic.js`).
- **Optional tools:** `yt-dlp` on the PATH (or `YTDLP_PATH`) to download reels from links.

```
public/            web app: index.html, studio.css, studio.js (tabs: Plan & review, Watch & remake, Settings)
src/server.js      Express app: auth, JSON API, static files, /media; createApp() is what tests use
src/config.js      environment -> config object; .env loader; WATCH_DEFAULTS
src/settings.js    data/settings.json (keys, choices, caps), meter() usage wrapper
src/providers.js   createProvider(): routes each AI job to OpenAI, Claude, text cards or mock
src/openai.js      OpenAI client: chat JSON (text or images), images, speech, transcription, key check
src/anthropic.js   Claude client: messages with a forced tool for JSON, image blocks, key check
src/planner.js     week plans, rewrites, reel schema, normalizeReel(), patterns -> prompt
src/render.js      plan -> MP4: images, voice, Ken Burns clips, captions (libass), thumbnail
src/jobs.js        render queue, watch queue, posting scheduler
src/instagram.js   Graph API: REELS container -> poll -> media_publish
src/brief.js       reads a business website for facts
src/fetchvideo.js  yt-dlp downloads, uploads, post metadata
src/measure.js     ffmpeg: scene cuts, key frames, speech track; caption (VTT/SRT) parsing
src/analyze.js     reel breakdown schema + prompt; patterns across reels
src/remake.js      format remakes and exact remakes
src/watch.js       watch pipeline: download -> measure -> transcribe -> analyse
src/selftest.js    system check: ffmpeg test render, data folder, yt-dlp, keys, Instagram, access
src/store.js       db.json store (atomic, serialised writes), usage counters
src/ffmpeg.js      ffmpeg runner and probe (no ffprobe needed)
scripts/           build-demo.mjs (static demo), demo-shim.js (in-browser API for the demo), check.mjs (npm run check)
test/              node:test suites with stand-in OpenAI, Claude, Instagram and yt-dlp
```

## Request flows

### Plan a week
1. `POST /api/brands` stores the brief. If a website is given, `brief.js` fetches it once (max 1.5 MB) and keeps the text for facts.
2. `POST /api/brands/:id/week` calls `planWeek()` with `WEEK_SCHEMA`. Patterns from watched reels (`profileId`) are added to the prompt by `profileBlock()`.
3. The provider's `json()` sends the request to OpenAI (`response_format: json_schema`, strict) or Claude (a forced tool whose `input_schema` is the same schema).
4. `normalizeReel()` clamps everything (scene count, lengths, word counts, hashtags, time format), so a slightly off answer from either model still gives a valid plan.
5. Each reel is saved with `status: queued` and handed to the render queue.

### Render a reel (`render.js`)
For each scene:
1. **Image.** `provider.image()` is called unless the file is cached. The cache key is `sha1(visual | style | imageId)`.
2. **Voice.** `provider.speech()` is called unless cached (`sha1(voiceover | voiceId)`).
3. **Scene length.** Normal plans: the longest of the planned seconds, the voice length + 0.35 s, and 2 s (at most 15 s). Plans with `timing: 'exact'` (remakes) keep the planned length; a voice line that runs long is sped up with `atempo` (at most 1.3×) before the scene may grow.
4. **Clip.** A zoompan clip (push in, pull out, pan right or pan up), 1080×1920 at 30 fps.

Then the clips and audio are joined. `buildAss()` writes the boxed headline (top, middle or bottom from `plan.layout.text_position`) and word-by-word captions in 3–5 word groups with the spoken word in the accent colour; libass burns them in. Output is H.264 high profile, AAC 160k, `+faststart`, plus a thumbnail.

### Watch a reel (`watch.js`)
`POST /api/sources` (links) or `/api/sources/upload` (raw bytes), then the watch queue runs:
1. **Download.** `fetchvideo.js` runs yt-dlp with `--` before the URL (no option injection), `--ffmpeg-location` set to the bundled ffmpeg, info JSON, captions, a duration filter and a size cap. Login and rate-limit errors are turned into advice about cookies.
2. **Measure.** `measure.js` finds the cuts from ffmpeg's per-frame scene score. A frame counts as a cut when its score passes `WATCH_SCENE_THRESHOLD`, or when it is a sharp spike: at least a third of the threshold and 10× the median score within ±1 s. Key frames are an even spread plus the first frame after each cut (15–40 frames, 512 px wide), and the speech track is mono 16 kHz MP3.
3. **Transcribe.** OpenAI `whisper-1` (`verbose_json`, segment and word timings) when an OpenAI key exists; otherwise the site's captions (VTT/SRT, rolling duplicates removed).
4. **Analyse.** `analyzeReel()` sends a text header (duration, cuts, metadata, timed transcript) and each frame (`detail: low` for OpenAI, a base64 image block for Claude) with `BREAKDOWN_SCHEMA`. `normalizeBreakdown()` sorts the beats, removes gaps and overlaps, folds slivers under 0.2 s into the neighbouring beat, stretches the beats to cover 0 to the video's length, and computes pacing from the measured cuts. In mock mode the beats come from the cuts alone.

### Remake (`remake.js`)
- **format:** `remakePlan()` merges beats down to 12 or fewer (`compactBeats`), sends the brief and the beat list (including the original's lines, for style only), and asks for exactly N scenes. The scene lengths are then set back to the original beat lengths, and the plan gets `timing: 'exact'` and the source's text position.
- **exact:** `exactPlan()` needs no AI call. It uses the original's words, timing, caption and hashtags, with new visuals and voice. The API refuses it unless `rightsConfirmed: true`.

### Patterns (`analyze.js`)
`findPatterns()` sends compact breakdowns (with views and likes) and returns `PROFILE_SCHEMA`. `normalizeProfile()` removes duplicate lists and adds measured averages (length, beat length, cuts per 10 s, total views).

### Post (`jobs.js`, `instagram.js`)
Once a minute the scheduler posts approved reels whose time has come. It creates a REELS container from `PUBLIC_BASE_URL/media/<id>/reel.mp4`, polls until `FINISHED`, then calls `media_publish`.

## Providers

`createProvider(cfg)` returns one object with the same interface whichever services are behind it:

```js
{
  name, mode,            // name = service doing scripts ('openai' | 'anthropic' | 'mock'); mode = 'live' | 'mock'
  parts: { text, vision, image, voice, transcribe },   // which service does each job
  models: { text, vision, image, voice, transcribe },  // display names
  imageId, voiceId,      // cache keys for rendered media
  json(req),             // { system, user, schemaName, schema, mock } -> object
  vision(req),           // same, `user` is an array of text/image_url parts
  image(prompt, outFile, { index }),
  speech(text, outFile, { instructions }),
  transcribe(file) | null,   // -> { language, text, segments[], words[] }
}
```

- **Routing** (`route()`): `AI_TEXT_PROVIDER` / `AI_VISION_PROVIDER` (or the Settings choices) pick `openai` or `anthropic`. If that key is missing, the other service is used; `auto` means OpenAI when its key exists.
- **Without an OpenAI key:** `image` renders a text card (accent-tinted gradient, grain, vignette), `speech` writes a silent track as long as the line would take to say so captions keep their pace, and `transcribe` is `null`.
- **Mock** (no key, or `MOCK=1`): `json` and `vision` call `req.mock()`, so every AI caller supplies an offline answer.
- **Metering:** `meter()` in `settings.js` wraps the provider. It counts each paid call per month and stops image generation at the monthly cap.
- **Live switching:** the server keeps a proxy (`swappable`) and swaps the implementation when Settings change. The job queues keep their reference.

### Adding a provider
1. Write a client with `json({ system, user, schemaName, schema, model })` that returns the parsed object. Accept `user` as a string or as OpenAI-style parts, and convert images as `toClaudePart()` does.
2. Add it in `createProvider()`: extend `route()` and the settings choices (`CHOICES` in `settings.js`, the selects in `renderSettings()`), and set `parts` and `models`.
3. Add its key to `config.js`, `Settings.apply()`, `keyView()` and the Settings key cards; add a `check()` for the Test button.
4. Add a test with a stand-in server, like `test/anthropic.test.js`.

## Data

Everything is under `DATA_DIR` (default `studio/data`, git-ignored):

```
data/db.json           brands, reels, sources (watched reels), profiles (patterns), usage
data/settings.json     saved API keys and choices, mode 0600; never in db.json
data/media/<reel_id>/  img-<hash>.png, voice-<hash>.mp3, assets.json, reel.mp4, thumb.jpg
data/media/<src_id>/   video.<ext>, video.info.json, video.*.vtt, speech.mp3, frames/f000.jpg…
```

**Brand:** `{ id, name, website, description, audience, offer, tone, language, site: { url, title, description, text }, siteError, createdAt }`

**Reel:**
```
{ id, brandId, day, status: queued|rendering|ready|approved|posting|posted|failed, progress, error,
  plan: { title, format, hook, scenes: [{ seconds, visual, on_screen_text, voiceover }], caption, hashtags,
          cta, best_time, timing?: 'exact', layout?: { text_position } },
  media: { video, thumb, duration, scenes: [{ image, start, duration }], renderedAt },
  scheduledAt, approvedFor, history: [{ at, feedback, previous }], ig: { mediaId, containerId, postedAt },
  origin?: { type: 'remake', mode, sourceId, label } | { type: 'patterns', profileId, label } }
```

**Source** (watched reel):
```
{ id, url | null, name, file, status: queued|watching|ready|failed, progress, error, warnings[],
  meta: { url, platform, title, uploader, caption, views, likes, comments, uploadDate },
  video: { duration, width, height, audio }, cuts: [s…], frames: [{ t, file }],
  transcript: { source: openai|captions|none, language, text, segments[], words[] },
  breakdown: BREAKDOWN_SCHEMA (normalised, plus pacing.seconds/beats/avg_beat_seconds/cuts/cuts_per_10s),
  analyzedWith, analyzedAt }
```

**Profile** (patterns): `{ id, name, sourceIds, profile: PROFILE_SCHEMA + measured, createdAt }`

**Usage:** `usage["YYYY-MM"]` holds counters such as `text.openai`, `text.anthropic`, `vision.anthropic`, `images.openai`, `voice.openai`, `transcribe.openai`, `rendered`, `watched` and `posted`.

The store writes the whole file atomically (write to a temp file, then rename). Writes are serialised on one promise chain; `flush()` waits for them.

## API

All JSON. Errors are `{ "error": "message" }` with a 4xx/5xx status. With `STUDIO_PASSWORD`, every route except `/media/*` needs HTTP Basic auth (any user name).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/status` | | `{ mode, providers, models, instagram, watch: { downloader, maxSeconds, uploadLimitMb }, queue, watchQueue }` |
| GET | `/api/brands` | | brands |
| POST | `/api/brands` | `{ name?, website?, description?, audience?, offer?, tone?, language? }` (website or description required) | brand |
| POST | `/api/brands/:id/week` | `{ count 1–7, startDate YYYY-MM-DD, profileId? }` | new reels (rendering starts) |
| GET | `/api/reels?brandId=` | | reels with `captionText`, `videoUrl`, `thumbUrl` |
| GET | `/api/reels/:id` | | reel |
| POST | `/api/reels/:id/approve` | `{ scheduledAt? }` | reel |
| POST | `/api/reels/:id/unapprove` | | reel |
| POST | `/api/reels/:id/revise` | `{ feedback }` | reel (re-render queued) |
| POST | `/api/reels/:id/render` | `{ regenerateMedia? }` | reel |
| POST | `/api/reels/:id/publish` | | reel (posted) |
| GET | `/api/reels/:id/download` | | MP4 file |
| GET | `/api/sources` | | watched reels (with frame URLs) |
| GET | `/api/sources/:id` | | watched reel |
| POST | `/api/sources` | `{ urls: [...] }` or `{ url }` (max 50) | `{ added, skipped }` |
| POST | `/api/sources/upload?name=` | raw video bytes | watched reel |
| POST | `/api/sources/:id/watch` | | watch again |
| DELETE | `/api/sources/:id` | | `{ ok }` |
| POST | `/api/sources/:id/remake` | `{ brandId, mode: format\|exact, rightsConfirmed?, scheduledAt? }` | new reel |
| GET | `/api/patterns` | | profiles |
| POST | `/api/patterns` | `{ sourceIds: [2+], name? }` | profile |
| DELETE | `/api/patterns/:id` | | `{ ok }` |
| GET | `/api/settings` | | `{ keys: { openai, anthropic: { configured, source, hint } }, text, vision, anthropicModel, claudeModels, active, limits, usage, canEdit, exposed }` |
| PUT | `/api/settings` | any of `{ openaiKey, anthropicKey, clearOpenaiKey, clearAnthropicKey, text, vision, anthropicModel, imagesPerMonth, watchesPerMonth }` | settings view |
| POST | `/api/settings/test` | `{ service: openai\|anthropic, key? }` | `{ ok, models }` or `{ ok: false, error }` |
| POST | `/api/selftest` | | `{ ok, checks: [{ id, label, status: ok\|warn\|fail\|skip, detail }], at }` |
| GET | `/media/<id>/<file>` | | rendered and watched media (public, for Instagram) |

`PUT /api/settings` and `/api/settings/test` return 403 unless the request is local or a password is set. A request counts as local when it comes from loopback with no `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `CF-Connecting-IP` header, because a tunnel also connects from 127.0.0.1.

## Configuration

All variables are in [`.env.example`](../.env.example) with comments. The groups:
- **AI:** `OPENAI_*`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `AI_TEXT_PROVIDER`, `AI_VISION_PROVIDER`, `MOCK`.
- **Watching:** `YTDLP_PATH`, `YTDLP_COOKIES`, `YTDLP_COOKIES_FROM_BROWSER`, `WATCH_*`.
- **Instagram:** `IG_USER_ID`, `IG_ACCESS_TOKEN`, `PUBLIC_BASE_URL`, `GRAPH_API_VERSION`.
- **Server:** `PORT`, `HOST` (default `127.0.0.1`), `STUDIO_PASSWORD`, `DATA_DIR`, `ACCENT_COLOR`.

Values saved in Settings (keys, choices, Claude model, caps) take priority over `.env`.

## Security notes

- Keys never reach the browser. `GET /api/settings` returns only `configured`, `source` and the last four characters, and tests check that no response contains a saved key.
- `data/settings.json` is written with mode 0600 and kept out of `db.json`, so the library can be shared or backed up without secrets.
- The server binds to 127.0.0.1 by default. Anyone who can reach it can spend your credits, so set `STUDIO_PASSWORD` before exposing it (a tunnel for Instagram, `HOST=0.0.0.0`, or a server).
- yt-dlp gets the link after `--`, and only http(s) links are accepted. Uploads keep only a safe extension (`video.mp4|mov|m4v|webm|mkv`); the user's file name is stored as text only.
- The web app builds all data-driven DOM with `textContent` or attributes (no `innerHTML` with data).
- The online demo (`demo-shim.js`) answers the API in the browser and refuses to take keys; its inputs are disabled.

## Tests

```
npm test        # node --test, one file at a time
```

The tests use no network and no keys. `test/helpers.js` provides `fakeServer()` (records requests and answers from a handler), sample media made with ffmpeg, and `waitFor()`.

| File | Covers |
| --- | --- |
| `openai.test.js` | OpenAI requests, render output (1080×1920 H.264/AAC), caching, retries and errors |
| `anthropic.test.js` | Claude headers and body, forced tool output, image blocks, 529 retry, errors, routing, Claude-only reel |
| `api.test.js` | the whole plan → render → approve → revise → post flow in mock mode, the scheduler |
| `watch.test.js` | cuts, frames, audio and captions on a real clip; stand-in yt-dlp; vision and transcription requests; remakes; patterns |
| `selftest.test.js` | system check results and next steps, read-only calls, the API route |
| `settings.test.js` | key storage and masking, live switching, key tests, remote-edit protection, password, usage, caps |
| `instagram.test.js`, `brief.test.js` | Graph API sequence; website text extraction |

Add a test with each change. A stand-in server beats mocking `fetch`, because it checks the real request bytes.

## Demo build

`npm run demo:build` starts the app in mock mode on a temporary data folder and drives it through the API. It plans a week, approves and revises reels, uploads three renders back as watched reels, finds patterns, makes a remake and a pattern-based reel, then writes `demo-dist/`. The output is one HTML page with CSS, JS and data inlined, plus the media files, with WebM copies for browsers without H.264. `demo-shim.js` replaces `fetch('/api/…')` in the page. It simulates every flow in the browser: planning for any brand, rewriting, watching links or uploads, remaking, finding patterns and planning from them. It reuses the sample renders and analyses, labels the results as simulated, and never accepts keys. Its system check reports what the browser can do (video playback, storage) and points to `npm run check` for the rest.

## In-app test guide

`GUIDE` in `public/studio.js` lists the 10 test steps. The code for each feature calls `markDone(id)` once that action succeeds (for example after an approve returns). Progress is saved in `localStorage` when it is available. To add a step, add it to `GUIDE` and call `markDone` where the action succeeds.

## Conventions

- One job per module. Functions that call AI take the provider as their first argument and a `mock` fallback.
- Every model answer goes through a `normalize*()` function before it is stored.
- UI text is plain and short. Errors say what to do next.
- Tabs for indentation, single quotes, semicolons; match the file you are in.
