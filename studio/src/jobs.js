// Background work: a single-worker render queue, a single-worker watch queue (downloading and
// analysing reels) and the posting scheduler.
import path from 'node:path';
import { renderReel } from './render.js';
import { watchSource } from './watch.js';
import { publishReel, captionFor } from './instagram.js';
import { instagramReady } from './config.js';

export class Jobs {
	constructor({ store, provider, cfg, log = console }) {
		Object.assign(this, { store, provider, cfg, log });
		this.queue = [];
		this.running = false;
		this.publishing = new Set();
		this.watchQueue = [];
		this.watching = false;
	}

	// Re-queue anything interrupted by a restart.
	resume() {
		for (const r of this.store.reels()) {
			if (r.status === 'rendering' || r.status === 'queued') this.enqueueRender(r.id);
			if (r.status === 'posting') this.store.updateReel(r.id, { status: 'approved', progress: '' });
		}
		for (const s of this.store.sources()) if (s.status === 'queued' || s.status === 'watching') this.enqueueWatch(s.id);
	}

	enqueueWatch(id) {
		if (!this.watchQueue.includes(id)) this.watchQueue.push(id);
		this.store.updateSource(id, { status: 'queued', progress: 'Waiting to watch', error: null });
		this.drainWatch();
	}

	async drainWatch() {
		if (this.watching) return;
		this.watching = true;
		try {
			while (this.watchQueue.length) {
				const id = this.watchQueue.shift();
				const source = this.store.source(id);
				if (!source) continue;
				this.store.updateSource(id, { status: 'watching', progress: 'Starting' });
				try {
					const result = await watchSource({
						source, dir: this.store.reelDir(id), provider: this.provider, cfg: this.cfg,
						onProgress: (m) => this.store.updateSource(id, { progress: m }),
					});
					this.store.bumpUsage('watched');
					if (this.store.source(id)) this.store.updateSource(id, { ...result, status: 'ready', progress: '', error: null });
				} catch (e) {
					this.log.error(`[watch ${id}]`, e.message);
					if (this.store.source(id)) this.store.updateSource(id, { status: 'failed', progress: '', error: e.message });
				}
			}
		} finally {
			this.watching = false;
		}
	}

	enqueueRender(id, { force = false } = {}) {
		if (!this.queue.some((j) => j.id === id)) this.queue.push({ id, force });
		this.store.updateReel(id, { status: 'queued', progress: 'Waiting to render', error: null });
		this.drain();
	}

	async drain() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length) {
				const { id, force } = this.queue.shift();
				const reel = this.store.reel(id);
				if (!reel) continue;
				this.store.updateReel(id, { status: 'rendering', progress: 'Starting' });
				try {
					const media = await renderReel({
						plan: reel.plan, dir: this.store.reelDir(id), provider: this.provider, cfg: this.cfg, force,
						onProgress: (m) => this.store.updateReel(id, { progress: m }),
					});
					this.store.bumpUsage('rendered');
					const keepApproved = reel.approvedFor === JSON.stringify(reel.plan);
					this.store.updateReel(id, { status: keepApproved ? 'approved' : 'ready', media, progress: '', error: null });
				} catch (e) {
					this.log.error(`[render ${id}]`, e.message);
					this.store.updateReel(id, { status: 'failed', progress: '', error: e.message });
				}
			}
		} finally {
			this.running = false;
		}
	}

	async publish(id) {
		const reel = this.store.reel(id);
		if (!reel?.media?.video) throw new Error('Render the reel before posting it.');
		if (!instagramReady(this.cfg)) throw new Error('Instagram is not connected. Set IG_USER_ID, IG_ACCESS_TOKEN and PUBLIC_BASE_URL.');
		if (this.publishing.has(id)) throw new Error('This reel is already being posted.');
		this.publishing.add(id);
		this.store.updateReel(id, { status: 'posting', progress: 'Starting', error: null });
		try {
			const videoUrl = `${this.cfg.instagram.publicBaseUrl}/media/${id}/${reel.media.video}?v=${encodeURIComponent(reel.media.renderedAt || '')}`;
			const ig = await publishReel(this.cfg, {
				videoUrl, caption: captionFor(reel.plan),
				onProgress: (m) => this.store.updateReel(id, { progress: m }),
			});
			this.store.bumpUsage('posted');
			return this.store.updateReel(id, { status: 'posted', ig, progress: '' });
		} catch (e) {
			this.store.updateReel(id, { status: 'approved', progress: '', error: e.message });
			throw e;
		} finally {
			this.publishing.delete(id);
		}
	}

	// Post approved reels whose time has come.
	async tick(now = new Date()) {
		if (!instagramReady(this.cfg)) return [];
		const due = this.store.reels().filter((r) => r.status === 'approved' && r.scheduledAt && new Date(r.scheduledAt) <= now);
		const done = [];
		for (const r of due) {
			try { done.push(await this.publish(r.id)); } catch (e) { this.log.error(`[post ${r.id}]`, e.message); }
		}
		return done;
	}

	startScheduler() {
		this.timer = setInterval(() => this.tick().catch(() => {}), this.cfg.schedulerIntervalMs);
		this.timer.unref?.();
	}

	stop() { clearInterval(this.timer); }
}
