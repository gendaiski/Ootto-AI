// Tiny JSON-file store: one db.json with brands and reels, written atomically and serially.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
	constructor(dataDir) {
		this.dir = dataDir;
		this.file = path.join(dataDir, 'db.json');
		this.mediaDir = path.join(dataDir, 'media');
		fs.mkdirSync(this.mediaDir, { recursive: true });
		this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { brands: [], reels: [] };
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

	reelDir(id) {
		const d = path.join(this.mediaDir, id);
		fs.mkdirSync(d, { recursive: true });
		return d;
	}
}
