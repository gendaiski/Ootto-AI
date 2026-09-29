import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from '../src/ffmpeg.js';

export function tmpDir(prefix = 'ootto-test-') {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Minimal JSON/form HTTP server that records requests and answers from a handler.
export async function fakeServer(handler) {
	const calls = [];
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks).toString();
		const ct = req.headers['content-type'] || '';
		const body = ct.includes('json') && raw ? JSON.parse(raw) : ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw;
		const url = new URL(req.url, 'http://x');
		const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
		calls.push(call);
		const out = await handler(call);
		res.writeHead(out.status || 200, { 'Content-Type': out.type || 'application/json' });
		res.end(out.buffer || JSON.stringify(out.json ?? {}));
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address();
	return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

// Real small media files for the fake OpenAI server to return.
export async function samplePng(dir) {
	const f = path.join(dir, 'sample.png');
	await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:s=256x384:d=1', '-frames:v', '1', f]);
	return fs.readFileSync(f);
}
export async function sampleMp3(dir, secs = 1.2) {
	const f = path.join(dir, 'sample.mp3');
	await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', String(secs), '-c:a', 'libmp3lame', f]);
	return fs.readFileSync(f);
}

export async function waitFor(fn, { timeoutMs = 120000, everyMs = 250 } = {}) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, everyMs));
	}
}
