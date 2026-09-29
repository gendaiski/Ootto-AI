# Ootto Studio

Plan, generate, review and post a week of Instagram Reels for a business, using OpenAI.

1. **Brief.** Enter the business once: website (read once for facts), what it does, audience, main call to action, tone and language.
2. **Plan.** OpenAI writes up to 7 reels for the week. Each has a hook, 3 to 6 scenes (on-screen text, voiceover line and image prompt), a caption, hashtags and a posting time.
3. **Generate.** For every scene, OpenAI makes a vertical image and speaks the voiceover line.
4. **Render.** ffmpeg turns each reel into a 1080×1920, 30 fps H.264/AAC MP4. Every scene gets a slow zoom or pan, sized to its voice line. A boxed headline sits at the top and word-by-word captions sit at the bottom, both kept clear of Instagram's own buttons.
5. **Review.** Watch each reel in a phone frame. Approve with ✓ or the → key. Request changes with ✕ or the ← key and a short note. OpenAI rewrites that reel, and only the scenes that changed are regenerated.
6. **Post.** Approved reels post themselves at their scheduled time through the Instagram Graph API. Without Instagram connected, download the MP4, copy the caption and post by hand.

## Run it

Requires Node.js 20 or newer. ffmpeg comes bundled through `ffmpeg-static`, so there's nothing else to install.

```
cd studio
npm install
cp .env.example .env      # then add OPENAI_API_KEY
npm start                 # open http://localhost:3000
```

With no `OPENAI_API_KEY` the studio runs in **mock mode**. It uses template scripts, placeholder images and silent voice, so you can try the whole flow at no cost. The header shows which mode is active.

## What OpenAI is used for

| Step | Endpoint | Default model | Calls |
| --- | --- | --- | --- |
| Week plan or rewrite | `POST /v1/chat/completions` with a strict JSON schema | `gpt-4o` | 1 per week, 1 per rewrite |
| Scene images | `POST /v1/images/generations` at 1024×1536 | `gpt-image-1` | 1 per scene (3–6 per reel) |
| Voiceover | `POST /v1/audio/speech` as mp3 | `gpt-4o-mini-tts`, voice `alloy` | 1 per scene (3–6 per reel) |

A 7-reel week is 1 text call plus roughly 25–40 image calls and 25–40 speech calls. Images are the main cost, so set `OPENAI_IMAGE_QUALITY=low` while you test.

Other controls:
- **Model choice:** change models in `.env`. `dall-e-3` also works for images.
- **Caching:** images and voice lines are saved per scene. Re-rendering is free, and a rewrite only pays for scenes whose visual or voiceover changed.
- **New images & voice:** this button in the review panel forces fresh images and voice for every scene.

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

## Files

```
src/server.js      HTTP API, the studio page and rendered media
src/planner.js     prompts, JSON schema, clean-up, mock scripts
src/openai.js      OpenAI client (chat JSON, images, speech) with retries
src/providers.js   OpenAI and mock providers
src/render.js      scene clips, captions (libass), joining, thumbnail
src/jobs.js        render queue and posting scheduler
src/instagram.js   Instagram Graph API publishing
src/brief.js       website text extraction
src/store.js       JSON file store (data/db.json, data/media/<reel>/)
public/            the studio web page
assets/fonts/      DejaVu Sans for burned-in captions (see DejaVu-LICENSE.txt)
test/              tests against stand-in OpenAI and Instagram servers
```

## Static demo

`npm run demo:build` renders a sample week with the real pipeline in mock mode and writes `demo-dist/`: one self-contained page plus the videos. A small in-page stand-in answers the studio's requests, so the demo runs with no server. It adds WebM copies of the videos for browsers without H.264; the MP4 stays what Instagram gets.

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
