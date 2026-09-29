# Ootto Studio

Plan, generate, review and post a week of Instagram Reels for a business, using OpenAI, Claude, or both. Learn from reels that already work: watch them, break them down, and remake their format for your business.

1. **Brief.** Enter the business once: website (read once for facts), what it does, audience, main call to action, tone and language.
2. **Plan.** OpenAI or Claude writes up to 7 reels for the week. Each has a hook, 3 to 6 scenes (on-screen text, voiceover line and image prompt), a caption, hashtags and a posting time.
3. **Generate.** For every scene, OpenAI makes a vertical image and speaks the voiceover line.
4. **Render.** ffmpeg turns each reel into a 1080×1920, 30 fps H.264/AAC MP4. Every scene gets a slow zoom or pan, sized to its voice line. A boxed headline sits at the top and word-by-word captions sit at the bottom, both kept clear of Instagram's own buttons.
5. **Review.** Watch each reel in a phone frame. Approve with ✓ or the → key. Request changes with ✕ or the ← key and a short note. The AI rewrites that reel, and only the scenes that changed are regenerated.
6. **Post.** Approved reels post themselves at their scheduled time through the Instagram Graph API. Without Instagram connected, download the MP4, copy the caption and post by hand.
7. **Watch & remake.** Paste reel links or upload videos. Studio watches each one frame by frame, listens to it and breaks down the hook, format, beats, pacing and layout. Then remake it for your business, or compare several to find the patterns they share and plan new reels from those patterns. See [Watch & remake](#watch--remake).

## Run it

Requires Node.js 20 or newer. ffmpeg comes bundled through `ffmpeg-static`. To watch reels from links, also install [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp` or `brew install yt-dlp`); uploading video files works without it.

```
cd studio
npm install
npm start                 # open http://localhost:3000
```

Then open **Settings** in the studio and paste an OpenAI key, a Claude key, or both. Press **Test** to check a key before you save it. Keys can also go in `.env` (`cp .env.example .env`). A key saved in Settings wins over `.env`.

With no key at all the studio runs in **mock mode**. It uses template scripts, placeholder images and silent voice, so you can try the whole flow at no cost. The header shows which mode is active; click it to open Settings.

## OpenAI, Claude, or both

| Job | OpenAI key | Claude key only | Both keys |
| --- | --- | --- | --- |
| Scripts, rewrites, remakes, patterns | OpenAI | Claude | your choice (Settings) |
| Reel analysis (reads the frames) | OpenAI | Claude | your choice (Settings) |
| Scene images | `gpt-image-1` | text-card backgrounds (no AI images) | OpenAI |
| Voiceover | `gpt-4o-mini-tts` | none, captions only | OpenAI |
| Transcribing watched reels | `whisper-1` | the site's captions only | OpenAI |

Claude writes and reads images but does not generate images or audio. With only a Claude key you still get complete reels: dark text-card backgrounds tinted with your accent colour, the boxed headline and word-by-word captions, and a silent soundtrack (add music in Instagram when you post). For AI photos and voice, add an OpenAI key too. A common setup is **Claude for writing and analysis, OpenAI for images and voice**.

Claude models: `claude-opus-5-5` (default, best quality), `claude-sonnet-5-5` (balanced), `claude-haiku-4-5-20251001` (fastest, cheapest). Pick one in Settings or set `ANTHROPIC_MODEL`.

How Claude is called: `POST https://api.anthropic.com/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`. The output schema is sent as a tool's `input_schema` with `tool_choice` forcing that tool, so the answer arrives as structured JSON. Watched-reel frames go as base64 `image` blocks. 429 and 529 (overloaded) are retried.

## Settings, usage and safety

- **Settings tab.** Save, test and remove keys; choose which AI does scripts and which does reel analysis; pick the Claude model; see what each job currently uses.
- **Where keys live.** Saved keys go to `data/settings.json` (readable only by your user), not to `db.json`. The browser never receives a saved key back, only its last four characters.
- **Usage.** Settings counts this month's paid calls (script calls, reel analyses, images, voice lines, transcriptions) and reels rendered, watched and posted. Your bill comes from OpenAI and Anthropic.
- **Monthly limits.** Cap images and watched reels per month; the studio stops before going over. For a hard cap on spend, also set limits in your [OpenAI](https://platform.openai.com/settings/organization/limits) and [Anthropic](https://console.anthropic.com/settings/limits) accounts.
- **Who can change settings.** The studio listens on `127.0.0.1` (this computer only) by default. Settings can only be changed from this computer unless `STUDIO_PASSWORD` is set.
- **Password.** Set `STUDIO_PASSWORD` whenever the studio is reachable from elsewhere (`HOST=0.0.0.0`, a tunnel for Instagram, a server). Every page and API call then asks for it, except `/media`, which Instagram needs to download videos. Settings shows a warning if `PUBLIC_BASE_URL` is set without a password.

## What OpenAI is used for

| Step | Endpoint | Default model | Calls |
| --- | --- | --- | --- |
| Week plan or rewrite | `POST /v1/chat/completions` with a strict JSON schema | `gpt-4o` | 1 per week, 1 per rewrite |
| Scene images | `POST /v1/images/generations` at 1024×1536 | `gpt-image-1` | 1 per scene (3–6 per reel) |
| Voiceover | `POST /v1/audio/speech` as mp3 | `gpt-4o-mini-tts`, voice `alloy` | 1 per scene (3–6 per reel) |
| Watch: speech | `POST /v1/audio/transcriptions` with word timings | `whisper-1` | 1 per watched reel |
| Watch: breakdown | `POST /v1/chat/completions` with key frames and a strict JSON schema | `OPENAI_VISION_MODEL` (default: the text model) | 1 per watched reel |
| Patterns / remake | `POST /v1/chat/completions` with a strict JSON schema | `gpt-4o` | 1 each |

A 7-reel week is 1 text call plus roughly 25–40 image calls and 25–40 speech calls. Images are the main cost, so set `OPENAI_IMAGE_QUALITY=low` while you test.

Other controls:
- **Model choice:** change models in `.env`. `dall-e-3` also works for images.
- **Caching:** images and voice lines are saved per scene. Re-rendering is free, and a rewrite only pays for scenes whose visual or voiceover changed.
- **New images & voice:** this button in the review panel forces fresh images and voice for every scene.

## Watch & remake

Open the **Watch & remake** tab.

1. **Add reels.** Paste links, one per line: Instagram, TikTok, YouTube Shorts, and anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports. Or upload a video file. The same link is never watched twice.
2. **Watching** runs in the background, one reel at a time:
   - **Download** with yt-dlp, including the post caption, views, likes and captions when the site gives them.
   - **Measure** with ffmpeg: the scene cuts, then 15 to 40 key frames (evenly spread, plus the first frame after every cut).
   - **Listen**: the speech track is transcribed by OpenAI (`whisper-1`, with timings). Without a key, the site's own captions are used when there are any.
   - **Analyse**: the frames (with their timestamps), the cuts and the transcript go to an OpenAI vision model. It returns a beat-by-beat breakdown: the hook and its technique, every beat's purpose, shot, overlay text, spoken words and visual, plus pacing, text placement, caption style, music, the call to action, why it works, and a reusable template. Timings are checked against the measured video, and pacing numbers come from the real cuts.
3. **Review the breakdown.** The reel plays in the phone frame. Click any beat or timeline segment to jump to it.
4. **Remake for my business.** Choose a brand and one of two modes:
   - **Same format, new content** (recommended): the same number of beats, the same length per beat, the same hook technique, shots, pacing and text placement. The script and visuals are new and about your business. None of the original's words, footage or audio is reused.
   - **Exact remake**: the original's words and timing, with new AI visuals and a new voice. Use this only for your own reels (for example to refresh an old post or re-voice it) or reels you have the rights to. The studio asks you to confirm that first.

   Remakes keep the original rhythm. If a new voice line runs long, it is sped up slightly (at most 1.3×) before the scene is allowed to grow. They land in **Plan & review** like any other reel, where you can review, change, approve and schedule them.
5. **Find patterns.** Tick **Compare** on two or more watched reels, then press **Find patterns**. OpenAI compares the breakdowns, weighting reels with more views, and lists the hooks that repeat, the beat structure, target length and beat length, text placement, calls to action, what to do and what to avoid. Press **Plan new reels from these patterns** to write new reels for your business that follow them.

**Instagram downloads.** Instagram often refuses downloads without a login. Set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or firefox, safari, edge) to use a browser where you are logged in, or `YTDLP_COOKIES` to point at a cookies.txt file. If a link still fails, download the video yourself and upload it.

**Cost.** Watching one reel is 1 vision call with 15–40 small (low-detail) frames plus about $0.006 per minute of transcription. Finding patterns is 1 text call. A format remake is 1 text call, then the usual images and voice per scene.

**Please respect creators.** Study any public reel, but use the format, not the content. Don't re-post other people's words, footage or music as your own.

## Connect Instagram (optional)

Auto-posting uses Instagram's content publishing API. You need:

1. An Instagram **professional** account (Business or Creator) linked to a Facebook Page.
2. A Meta app with the permissions `instagram_basic` and `instagram_content_publish` (plus `pages_read_engagement` and `pages_show_list` for Page-linked accounts), and a long-lived access token.
3. Your Instagram user id for `IG_USER_ID`. In the Graph API Explorer, open `me/accounts`, pick the Page, and read its `instagram_business_account` id.
4. A public **https** address for this studio in `PUBLIC_BASE_URL`, because Instagram downloads the video from a link. Either deploy the studio to a server, or run a tunnel such as `cloudflared tunnel --url http://localhost:3000` and use the address it prints.

When all three settings are filled in, the header shows "Instagram connected". Approved reels then post at their scheduled time; the scheduler checks every minute while the server runs. You can also press **Post now** on any approved reel.

Posting follows Instagram's own sequence. The studio creates a `REELS` container from the video link, waits until Instagram reports `FINISHED`, then publishes it.

## Limits

- **Visuals:** these are AI still images brought to life with motion. There is no filmed footage and no generated video clips.
- **Caption timing:** each spoken line is timed to its scene. Caption words are spread across that line, which is close but not exact word timing.
- **Posting needs the server running:** the scheduler only works while `npm start` is running.
- **Website reading:** only the page you give is read, up to 1.5 MB. Sites that build their text with JavaScript may give little, so add a description as well.
- **Watching needs a key for the words:** without `OPENAI_API_KEY`, Watch & remake still measures the cuts, pacing and frames, but cannot read overlay text, describe shots or hear speech (unless the site provides captions).
- **Cut detection:** hard cuts are found reliably. Very similar shots, slow dissolves and cuts between near-identical frames can be missed; `WATCH_SCENE_THRESHOLD` adjusts the sensitivity. The vision model still sees the frames when it sets the beats.
- **Remakes use still images:** a remake reproduces the structure and timing with AI stills and motion, not filmed footage.

## For developers

See [docs/DEVELOPER.md](docs/DEVELOPER.md) for the architecture, data model, full API reference, how a request flows through the pipeline, and how to add a provider.

## Files

```
src/server.js      HTTP API, the studio page and rendered media
src/planner.js     prompts, JSON schema, clean-up, mock scripts
src/openai.js      OpenAI client (chat JSON, images, speech, transcription) with retries
src/providers.js   routes each job to OpenAI, Claude, text cards or mock
src/render.js      scene clips, captions (libass), joining, thumbnail
src/jobs.js        render queue and posting scheduler
src/instagram.js   Instagram Graph API publishing
src/brief.js       website text extraction
src/anthropic.js   Claude client (structured output via a forced tool call, images, retries)
src/settings.js    saved keys and choices (data/settings.json), usage metering and monthly caps
src/fetchvideo.js  reel downloads (yt-dlp) and uploads
src/measure.js     cuts, key frames, speech track, caption parsing (ffmpeg)
src/analyze.js     beat-by-beat breakdown and patterns across reels
src/remake.js      format and exact remakes
src/watch.js       the watch pipeline: download, measure, transcribe, analyse
src/store.js       JSON file store (data/db.json, data/media/<reel>/)
public/            the studio web page
assets/fonts/      DejaVu Sans for burned-in captions (see DejaVu-LICENSE.txt)
test/              tests against stand-in OpenAI and Instagram servers
```

## Static demo

`npm run demo:build` renders a sample week with the real pipeline in mock mode and writes `demo-dist/`: one self-contained page plus the videos. It also watches three of those reels back in, finds their patterns, and makes a remake and a reel planned from the patterns. Mock mode cannot read video, so the demo fills the watched reels' text and speech from their own scripts; cuts, frames and pacing are measured. A small in-page stand-in answers the studio's requests, so the demo runs with no server. It adds WebM copies of the videos for browsers without H.264; the MP4 stays what Instagram gets.

## Tests

```
npm test
```

The tests never call the real OpenAI or Instagram. They run the real code against local stand-in servers that answer in the same format. They check:

- **Requests:** what is sent to OpenAI and Instagram, and how the answers are read.
- **Output:** that rendered files are 1080×1920 H.264/AAC.
- **Reliability:** caching, retries and error messages.
- **Posting:** Instagram's upload, wait and publish sequence.
- **Whole flow:** the full API in mock mode.
- **Claude:** request headers and body, forced tool output, image blocks, retries on 529, clear errors (bad key, max_tokens, refusal), OpenAI/Claude routing, and a full Claude-only reel.
- **Settings:** keys saved only on disk and masked in every response, live provider switching, key tests, remote edits refused without a password, the password gate, usage counts and monthly caps.
- **Watching:** cut detection and key frames on a real test video, caption parsing, a stand-in yt-dlp (arguments, login errors, missing install), the vision and transcription requests, remakes that keep the original timing, and patterns across reels.
