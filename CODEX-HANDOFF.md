# Codex handoff: Ootto Studio, landing pages and the Cloning Lab

This file is the starting point for picking up seven projects built with Claude Code. An identical copy is in both repositories:

- **gendaiski/Cloning-Lab**, branch `claude/multi-repo-ui-clone-oaio3c` (not merged; no pull request yet)
- **gendaiski/Ootto-AI**, branch `claude/reel-studio`, pull request #1 into `main` (open)

The links in the last column are private Claude previews: the owner can open them, and others only once the owner shares them.

## The projects

| # | Project | What it is | Repo and path | Built how | Done | Live preview |
|---|---|---|---|---|---|---|
| 1 | **Ootto Studio** | Web app that turns any Instagram reel link or uploaded video into the owner's own reel. It watches, transcribes, analyses, writes, renders, reviews and posts, using OpenAI, Claude or both. Also: weekly planning, patterns across reels, Settings (keys, usage, caps), system check, in-app test guide, Docker deploy. | Ootto-AI, `studio/` (branch `claude/reel-studio`) | **From scratch** (Node 20+, Express, ffmpeg-static, yt-dlp). The public repo Ootto-AI/ootto-watch was read for its approach only; no code was copied. | **95%.** Code complete, 30 tests pass, Docker image builds and runs. Remaining: one run against the real OpenAI, Anthropic and Instagram services. | https://claude.ai/artifact/2DtTFgPPBB56Ymwj2vvDEg (demo, simulated in the browser) |
| 2 | **Ootto landing page** | Concept draft of the ootto.ai home page: hero, swipe-to-approve reel queue, weekly calendar, comment-to-lead, autopilot, pricing, FAQ. Business model notes alongside. (The published preview adds links to the Studio demo; the repo file has none.) | Ootto-AI, `prototype/index.html` and `BUSINESS-MODEL.md` (canonical). A copy is in Cloning-Lab `sites/ootto-ai-clone/`. | **From scratch.** ootto.ai was blocked by the build environment's network policy, so this is an informed draft from public search snippets, not a copy. | **100% as a draft.** 0% as a faithful clone until the real site can be read. | https://claude.ai/artifact/3Q6RoT8wf52sa2gWzP3fLk |
| 3 | **Devini.io + library** | Concept draft of the studio home page, plus a `#library` view laid out like a Figma library: colour tokens (light and dark), type, spacing, radius, shadows, components in each state, section thumbnails, and "Copy tokens" (JSON). | Cloning-Lab, `sites/devini-io-clone/` | **From scratch.** The site was blocked; built from public search snippets. | **100% as a draft.** Faithful clone blocked. | https://claude.ai/artifact/N4Arv3FoG3oRjzxj5udLFd |
| 4 | **Sell The Method** | Placeholder long-form sales page: hero, problem, five-step framework, modules, who it is for, illustrative outcomes, pricing left blank, FAQ. | Cloning-Lab, `sites/sellthemethod-clone/` | **From scratch.** Almost nothing about the real site is public, so it is shaped mainly by the domain name. | **About 50%.** Placeholder-level draft. | https://claude.ai/artifact/XUUPFAozhzKKbYvucLnxFe |
| 5 | **Course Printer** | Concept draft of a $47 "topic to complete course plan" sales page, with an interactive sample-print demo (three topics) and a 14-day guarantee section. | Cloning-Lab, `sites/courseprinter-clone/` | **From scratch.** The site was blocked; built from public search snippets. | **100% as a draft.** Faithful clone blocked. | https://claude.ai/artifact/56WnHU6bTbUCGh2AKJgvXV |
| 6 | **Cloning Lab hub** | The playground repo: an index page of all clones with their status and links, plus `tools/export-site.sh`, which moves any `sites/<name>` folder into its own repo with history (used to create Ootto-AI). | Cloning-Lab, `README.md`, `hub/index.html`, `tools/export-site.sh` | **From scratch.** | **100%** | https://claude.ai/artifact/Qky7TvAy4ZrWUqRYKnDLWM |
| 7 | **NextWork.ai** | Concept draft of nextwork.ai. **Cancelled by the owner on 2026-09-29.** | Cloning-Lab, `sites/nextwork-ai-clone/` | **From scratch.** The site was blocked. | **Cancelled.** The draft page exists but is unfinished and unverified; do not ship it. | None |

Also in Cloning-Lab, outside this handoff: `sites/open-webui-clone/` (a static Open WebUI clone rebuilt from open-webui/open-webui v0.11.4) and `sites/agenthusiast-join-clone/` (cancelled).

## Ground rules

- **Branches:** work on the existing branches above or on new branches with pull requests. Do not push to `main` directly.
- **Drafts are not clones:** projects 2–5 and 7 were built without access to the real sites. Every draft page labels itself "Concept draft", and the Ootto and NextWork pages also say they are not affiliated with the real company. Keep those labels until a page is rebuilt from the real site. Never present an assumed price or claim as fact; they are marked "assumed" or "illustrative" on the pages.
- **Turning a draft into a faithful clone needs the real page.** Either allow the domain (and its asset hosts) in the network settings, or have the owner save the page ("Save as… Webpage, Complete") plus full-page desktop and mobile screenshots into that project's `reference/` folder. Then rebuild section by section.
- **Secrets:** API keys never go in a repo. Studio reads them from `studio/.env` (git-ignored) or saves them in `data/settings.json` (git-ignored, mode 0600).
- **Content rules in Studio:** "Same format" remakes reuse structure only. "Exact" remakes reuse the original words and require the user to confirm they own the reel or have the rights. Keep both rules.

## 1. Ootto Studio

**Where:** Ootto-AI `studio/`. Read these first:
- `HANDOFF.md` (repo root): run, verify, and the manual checklist.
- `studio/README.md`: features and setup.
- `studio/docs/DEVELOPER.md`: architecture, request flows, data model, full API reference, configuration, security and tests.
- `studio/docs/DEPLOY.md`: Docker, systemd, HTTPS with Caddy, and server settings.

**Run and test**
```
cd studio
npm ci
npm test               # 30 tests, about 2–3 min; no network or keys needed
npm run check          # system check: ffmpeg test render, data folder, yt-dlp, keys, Instagram
npm start              # http://localhost:3000; mock mode until a key is added in Settings
docker compose up -d --build   # needs studio/.env with STUDIO_PASSWORD
```

**Structure at a glance**
- `src/server.js`: all API routes, the password check and runs (the Start flow).
- `src/jobs.js`: the render and watch queues, the run chain and the posting scheduler.
- `src/providers.js`: sends each job to OpenAI, Claude, text cards or mock.
- `src/openai.js`, `src/anthropic.js`: the API clients.
- `src/watch.js`, `src/measure.js`, `src/analyze.js`, `src/remake.js`: the watch → analyse → remake pipeline.
- `src/render.js`: ffmpeg and libass rendering.
- `src/settings.js`: saved keys, usage and caps.
- `src/selftest.js`: the system check.
- `public/`: the web app with four tabs: Start, Plan & review, Watch & remake, Settings.
- `scripts/`: the demo build and its in-browser API shim, plus `check.mjs`.

**What is left (in order)**
1. **Real-service run** (the missing 5%):
   - Add an OpenAI key, a Claude key, or both in Settings, then press Test and Run system check.
   - On Start, run one reel link with OpenAI and one with Claude. Both should reach "Ready for review".
   - If a model name or response shape differs from the stand-ins in `test/`, fix the client (`src/openai.js` or `src/anthropic.js`) and add a test.
   - Defaults: `gpt-4o`, `gpt-image-1`, `gpt-4o-mini-tts`, `whisper-1` and `claude-opus-5-5`, all set in `.env` or Settings.
2. **Instagram:**
   - Download from a server IP with `YTDLP_COOKIES`.
   - Posting with `IG_USER_ID`, `IG_ACCESS_TOKEN` and an https `PUBLIC_BASE_URL`.
3. **Review and merge PR #1** once 1–2 pass.
4. **Out of scope unless the owner asks:** multi-user accounts and paid subscriptions (a separate project: hosting, auth, Stripe).

## 2. Ootto landing page

**Where:** Ootto-AI `prototype/index.html`, one self-contained file. Edit this copy; Cloning-Lab `sites/ootto-ai-clone/` is the older export.

**Check:**
- Open the file in a browser.
- Light and dark mode follow the system setting.
- No horizontal scroll at 390 px wide.
- The reel queue works with buttons and the arrow keys.

**What is left:**
- A faithful rebuild from the real ootto.ai, once the page is reachable or saved into `reference/`. Until then, keep the "concept draft" label and the non-affiliation footer.
- Once Studio is deployed, point the landing page's calls to action at it. The repo file has no Studio link yet.

## 3. Devini.io + library

**Where:** Cloning-Lab `sites/devini-io-clone/prototype/index.html`. The library view is at `#library`.

**Check:**
- Home sections render.
- `#library` shows the tokens, the component states and the section thumbnails.
- "Copy tokens" copies valid JSON.
- Light, dark and phone widths all work.

**What is left:**
- A faithful rebuild of devini.io and devini.io/library from the real site (see the ground rules).
- The owner described the library as "like my Figma library". Matching it exactly needs that Figma file or the real page.

## 4. Sell The Method

**Where:** Cloning-Lab `sites/sellthemethod-clone/prototype/index.html`

**Check:** every section renders; the pricing block is intentionally blank; the outcome cards are labelled illustrative.

**What is left:** the real site's content. Nothing public was found, so the owner must supply the page, screenshots or copy. Do not invent prices or testimonials.

## 5. Course Printer

**Where:** Cloning-Lab `sites/courseprinter-clone/prototype/index.html`

**Check:**
- The sample-print demo switches between its three topics.
- The pricing section shows $47 one-time and the 14-day guarantee condition.
- Light, dark and phone widths all work.

**What is left:** a faithful rebuild from the real courseprinter.com, once reachable or saved into `reference/`.

## 6. Cloning Lab hub

**Where:** Cloning-Lab `README.md` (table of all sites), `hub/index.html` (index page) and `tools/export-site.sh`.

**Export a site to its own repo:**
```
tools/export-site.sh <site-folder-name> [git-remote-url]   # e.g. tools/export-site.sh devini-io-clone
```
It splits `sites/<name>` into `../<name>` with its history and, if a remote is given, pushes it.

**What is left:**
- Keep the README table and `hub/index.html` in sync when a site changes status.
- Open a pull request for `claude/multi-repo-ui-clone-oaio3c` when the owner wants it merged.

## 7. NextWork.ai (cancelled)

**Where:** Cloning-Lab `sites/nextwork-ai-clone/`.

The owner cancelled it on 2026-09-29. The `prototype/` draft is unfinished and unverified. Do not ship it or spend time on it unless the owner restarts the project. If they do, treat it like project 3: get the real page first, then rebuild.
