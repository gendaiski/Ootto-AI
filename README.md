# ootto.ai – concept draft

Target: https://ootto.ai/

**This is a concept draft, not a clone.** `ootto.ai` is blocked by the network policy of the
environment it was built in, so the real page could not be read. The layout and copy are an
informed guess built from public search snippets (see `BUSINESS-MODEL.md`). Every price or claim
that could not be confirmed is marked on the page as assumed or illustrative.

Landing page for an AI operator that runs an Instagram account.

## Ootto Studio (working app)

`studio/` is a working reel generator that runs on your own OpenAI key, Claude key, or both:

- **Plan & review:** AI writes a week of reel scripts; OpenAI makes the scene images and voiceover (or text cards with captions when only Claude is connected); ffmpeg renders 1080×1920 MP4s; you approve or request changes; approved reels post to Instagram on schedule.
- **Watch & remake:** paste reel links or upload videos; Studio measures the cuts, takes key frames, transcribes the speech and breaks each reel down (hook, beats, pacing, layout). Remake the format for your business, or find the patterns several reels share and plan new reels from them.
- **Settings:** connect and test OpenAI and Claude keys, choose which AI does which job, see monthly usage and set caps.

Run it: `studio/README.md`. Code and API: `studio/docs/DEVELOPER.md`. Handoff and verification checklist: `HANDOFF.md`.

## Open it

Open `prototype/index.html` in any browser. It is a single self-contained file; the only external
request is Google Fonts, and it falls back to system fonts offline. Light and dark themes follow the
system setting.

Live preview (private until shared): https://claude.ai/artifact/3Q6RoT8wf52sa2gWzP3fLk

## Sections

- Sticky header with mobile menu
- Hero with an interactive swipe-to-approve reel queue (buttons and arrow keys)
- "Give Ootto your website" onboarding with a live URL demo
- Weekly reel calendar
- Comment-to-lead conversation and lead card
- Autopilot trio (invoicing, follow-up, reporting)
- Open-source Claude skills
- Pricing ($1 today, then $48/month)
- FAQ, final call to action, footer

## Business model

Extracted separately in `BUSINESS-MODEL.md`.

## Turning this into a faithful clone

Either allow `ootto.ai` (and its asset hosts) in the build environment's network settings, or save the
real page ("Save as… Webpage, Complete") plus desktop and mobile full-page screenshots into
`reference/`. The draft is then rebuilt section by section from the real page.
