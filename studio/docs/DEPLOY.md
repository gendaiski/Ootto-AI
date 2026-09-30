# Deploying Ootto Studio to a server

Ootto Studio is one Node.js process with its data in one folder. It runs on any Linux server with Docker, or with Node.js 20+. Plan for about 2 vCPUs, 2 GB RAM and 10 GB+ disk (rendered reels and watched videos add up; ffmpeg rendering is the CPU-heavy part).

## 1. Docker (recommended)

```
git clone https://github.com/gendaiski/Ootto-AI.git && cd Ootto-AI/studio
cp .env.example .env
nano .env                         # set STUDIO_PASSWORD (required); keys are optional here
docker compose up -d --build
docker compose exec studio node scripts/check.mjs     # system check
```

What the image contains:
- Node 22.
- The bundled ffmpeg.
- yt-dlp (the official single-file build, for amd64 or arm64).

The compose file:
- Keeps all data in the `studio-data` volume (`/data`).
- Restarts the container automatically.
- Publishes the port on `127.0.0.1:3000` only, so HTTPS goes in front of it (step 3).

Docker checks `GET /healthz` every 30 s.

## 2. Without Docker (Node + systemd)

```
git clone https://github.com/gendaiski/Ootto-AI.git /opt/ootto && cd /opt/ootto/studio
npm ci --omit=dev
cp .env.example .env && nano .env    # STUDIO_PASSWORD, and keep HOST=127.0.0.1 behind a proxy
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
npm run check
```

`/etc/systemd/system/ootto-studio.service`:

```
[Unit]
Description=Ootto Studio
After=network-online.target

[Service]
WorkingDirectory=/opt/ootto/studio
ExecStart=/usr/bin/node src/server.js
Restart=always
User=ootto
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now ootto-studio`. The `.env` file in `studio/` is read at start.

## 3. HTTPS in front (Caddy, automatic certificates)

Point a domain (for example `studio.example.com`) at the server, install [Caddy](https://caddyserver.com/docs/install), and use this `/etc/caddy/Caddyfile`:

```
studio.example.com {
	reverse_proxy 127.0.0.1:3000
	request_body {
		max_size 300MB
	}
}
```

Then run `sudo systemctl reload caddy`. nginx works too; set `client_max_body_size 300m;` so video uploads fit.

## 4. Settings on a server

| Setting | Why |
| --- | --- |
| `STUDIO_PASSWORD` | **Required** whenever the studio can be reached from other machines. Every page and API call asks for it, except `/media` (Instagram downloads videos from there) and `/healthz`. With `HOST` other than 127.0.0.1 and no password, the studio refuses to start. |
| `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` | Optional in `.env`: you can paste them in **Settings** instead (they are then saved in `data/settings.json`, readable only by the studio's user). |
| `PUBLIC_BASE_URL` | Your https address, for example `https://studio.example.com`. Needed only for automatic Instagram posting. |
| `IG_USER_ID`, `IG_ACCESS_TOKEN` | Instagram auto-posting (see the README). |
| `YTDLP_COOKIES` | Instagram often blocks downloads from server IP addresses. Export `cookies.txt` from a browser logged in to Instagram, copy it to the server (Docker: into the volume, for example `/data/cookies.txt`) and set `YTDLP_COOKIES=/data/cookies.txt`. Uploading the video always works. |

## 5. After it is up

1. Open `https://studio.example.com` and sign in with the password (any user name).
2. **Settings:** paste your OpenAI and/or Claude key, press **Test**, then **Save**. Then press **Run system check**: every line should be ✓, or – for things you chose not to set up.
3. **Start:** paste a reel link (or upload a video) and press **Start**. Watch every step reach **Ready for review**.

## Updating, backups, logs

- **Update:** run `git pull` then `docker compose up -d --build`. Rebuild about monthly anyway, because yt-dlp needs updates when Instagram changes; `docker compose build --pull --no-cache` forces it.
- **Back up:** the `/data` volume holds everything (library, reels, saved keys): `docker run --rm -v studio_studio-data:/data -v $PWD:/b alpine tar czf /b/ootto-data.tgz -C /data .`
- **Logs:** `docker compose logs -f studio`, or `journalctl -u ootto-studio -f`.

## What "one user" means

The studio is built for one business owner or team sharing one password. There are no separate user accounts. The data store is a JSON file, which suits hundreds of reels. For a multi-customer service with sign-ups and billing, those parts would be a separate project.
