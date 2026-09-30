# Handoff: Ootto

Status: **complete and ready for review.** Everything below is on branch `claude/reel-studio`.

## What is in this repo

| Part | Path | State |
| --- | --- | --- |
| Landing page concept draft for ootto.ai | `prototype/index.html` | Done. Single static file. A concept draft: the real site could not be reached when it was built. |
| Business model notes | `BUSINESS-MODEL.md` | Done. Built from public search snippets and marked as such. |
| Ootto Studio (the working app) | `studio/` | Done: plan, render, review, post; watch & remake; patterns; Settings with OpenAI and Claude keys; usage and caps. |
| Studio developer guide | `studio/docs/DEVELOPER.md` | Architecture, request flows, data model, API reference, configuration, security, tests. |
| Server deployment | `studio/Dockerfile`, `studio/docker-compose.yml`, `studio/docs/DEPLOY.md` | Done. The image builds and runs: system check passes, the password is enforced, a full upload run completes, data survives a restart, and the health check reports healthy. |
| Static demo build | `studio/scripts/build-demo.mjs` → `studio/demo-dist/` (git-ignored) | Done. Every flow works in the browser as a labelled simulation built from sample renders; no AI is called and no keys are accepted. |

## Ship it to a server

`cd studio && cp .env.example .env`, set `STUDIO_PASSWORD`, then `docker compose up -d --build`. Put HTTPS in front (Caddy, two lines) and open the site. The full guide is `studio/docs/DEPLOY.md`.

## Run and verify (for a reviewer or another coding agent)

Needs Node.js 20+ (Node 22 was used). ffmpeg comes from `ffmpeg-static` and is downloaded during `npm ci`.

```
cd studio
npm ci
npm test               # 30 tests, about 2–3 minutes; no network or API keys needed
npm run check          # system check: ffmpeg render, data folder, yt-dlp, keys, Instagram
npm start              # http://localhost:3000 (mock mode until a key is added)
```

**Is it working?** Two built-in answers:
- **System check:** Settings → Run system check, or `npm run check` in the terminal. It renders a test clip and checks the data folder, yt-dlp, each API key (by listing models, so no credits are spent), the Instagram account and the public address. Each line is ✓ ok, ! warning, ✗ broken or – not set up, with what to do next. The terminal command exits with code 1 if anything is broken.
- **How to test** (button at the bottom right of the app): a 12-step checklist covering every feature. It starts with a run from the Start tab and follows it to the end; each step ticks itself when it works. "Show me" jumps to the right place.

Optional:
```
pip install yt-dlp     # needed only to watch reels from links; uploads work without it
npm run demo:build     # about 5 minutes; writes demo-dist/ (static page + media)
```

### Manual checklist (with real keys)
0. **The main flow:** Start tab → paste an Instagram reel link (or upload a video) → pick the business, the mode and OpenAI or Claude → **Start**. Every step shows under Your runs until **Ready for review**. Try it once with OpenAI and once with Claude.
1. **Mock mode** (no keys): Plan & review → enter a business → **Plan my week** → reels render → approve with → and request changes with ←.
2. **Watch & remake:** upload any short MP4 → it is watched (cuts, frames, pacing) → **Remake for my business** → the new reel appears in Plan & review with the same rhythm.
3. **Settings:** paste a real OpenAI key and/or Claude key → **Test** → **Save**. The header shows which AI is connected. Plan a week again to see real scripts, images and voice.
4. **Claude only:** remove the OpenAI key; reels render as text cards with captions and no voice.
5. **Patterns:** watch two or more reels, tick **Compare** → **Find patterns** → **Plan new reels from these patterns**.
6. **Instagram** (optional): set `IG_USER_ID`, `IG_ACCESS_TOKEN`, `PUBLIC_BASE_URL` and `STUDIO_PASSWORD` → approve a reel → **Post now**.

## What was tested, and how

- All OpenAI, Claude, Instagram and yt-dlp traffic is tested against local stand-in servers that answer in each service's documented format. The request bytes (headers, bodies, multipart forms) are checked in the tests.
- The real OpenAI, Anthropic, Instagram and Instagram download endpoints were **not** called: the build environment blocked them. The first run with real keys is the main thing left to confirm (checklist steps 3–6).
- ffmpeg work (cut detection, frames, audio, captions, rendering to 1080×1920 H.264/AAC) runs for real in the tests.
- The web app was checked in Chromium at desktop and phone widths, in light and dark themes, with no console errors.
- The online demo was checked by completing all 10 How to test steps both directly and inside a sandboxed iframe (scripts only: storage and pop-ups blocked), as embedded pages often are. The app uses in-page dialogs instead of browser pop-ups for that reason.

## Known limits (by design, documented in studio/README.md)

- **Claude cannot make images or audio.** Those jobs need an OpenAI key; without one, reels use text cards and captions.
- **Instagram downloads** often need a login: set `YTDLP_COOKIES_FROM_BROWSER`, or upload the file instead.
- **Exact remakes** reuse a reel's words and require a rights confirmation. Format remakes reuse structure only.
- **Cut detection** can miss cuts between near-identical shots; `WATCH_SCENE_THRESHOLD` adjusts it.
- **Single user.** One local server with a JSON-file store and optional password. There are no accounts and no paid subscription billing; that would be the next project (hosting, accounts, Stripe).
- **Posting** only happens while `npm start` is running.

## Where to look first

- `studio/src/providers.js`: how each AI job is routed (OpenAI, Claude, text cards, mock).
- `studio/src/server.js`: every API route, auth and the settings API.
- `studio/src/watch.js`: the watch pipeline.
- `studio/test/`: one file per area. Start with `api.test.js`.
