// Tiny JSON-file store: one db.json with brands, reels, watched reels (sources) and pattern
// profiles, written atomically and serially.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export class Store {
	constructor(dataDir) {
		this.dir = dataDir;
		this.file = path.join(dataDir, 'db.json');
		this.mediaDir = path.join(dataDir, 'media');
		fs.mkdirSync(this.mediaDir, { recursive: true });
		this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { brands: [], reels: [] };
		this.data.sources ??= [];
		this.data.profiles ??= [];
		this.data.usage ??= {};
		this.writing = Promise.resolve();
	}

	static id(prefix) {
		return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
	}

	save() {
		const snapshot = JSON.stringify(this.data, null, 2);
		this.writing = this.writing.then(async () => {
			const tmp = `${this.file}.${process.pid}.tmp`;
			await fs.promises.writeFile(tmp, snapshot);
			await fs.promises.rename(tmp, this.file);
		});
		return this.writing;
	}

	// Resolves once every queued write has reached disk.
	async flush() {
		let last;
		do { last = this.writing; await last; } while (last !== this.writing);
	}

	brands() { return this.data.brands; }
	brand(id) { return this.data.brands.find((b) => b.id === id); }
	addBrand(brand) { this.data.brands.push(brand); this.save(); return brand; }

	reels(filter = {}) {
		return this.data.reels
			.filter((r) => !filter.brandId || r.brandId === filter.brandId)
			.sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
	}
	reel(id) { return this.data.reels.find((r) => r.id === id); }
	addReel(reel) { this.data.reels.push(reel); this.save(); return reel; }
	updateReel(id, patch) {
		const r = this.reel(id);
		if (!r) return null;
		Object.assign(r, patch, { updatedAt: new Date().toISOString() });
		this.save();
		return r;
	}

	sources() { return [...this.data.sources].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
	source(id) { return this.data.sources.find((s) => s.id === id); }
	addSource(src) { this.data.sources.push(src); this.save(); return src; }
	updateSource(id, patch) {
		const s = this.source(id);
		if (!s) return null;
		Object.assign(s, patch, { updatedAt: new Date().toISOString() });
		this.save();
		return s;
	}
	removeSource(id) {
		this.data.sources = this.data.sources.filter((s) => s.id !== id);
		fs.rmSync(path.join(this.mediaDir, id), { recursive: true, force: true });
		this.save();
	}

	profiles() { return [...this.data.profiles].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
	profile(id) { return this.data.profiles.find((p) => p.id === id); }
	addProfile(p) { this.data.profiles.push(p); this.save(); return p; }
	removeProfile(id) { this.data.profiles = this.data.profiles.filter((p) => p.id !== id); this.save(); }

	// Monthly counters: "text.openai", "images.openai", "watched", "rendered", …
	bumpUsage(key, n = 1, month = monthKey()) {
		const m = (this.data.usage[month] ??= {});
		m[key] = (m[key] || 0) + n;
		this.save();
	}
	usage(month = monthKey()) {
		const counts = { ...(this.data.usage[month] || {}) };
		return { month, counts, images: counts['images.openai'] || 0, watched: counts.watched || 0 };
	}

	// Media folder for a reel or a watched source.
	reelDir(id) {
		const d = path.join(this.mediaDir, id);
		fs.mkdirSync(d, { recursive: true });
		return d;
	}
}
