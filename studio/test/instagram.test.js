// Posting follows Instagram's container -> status poll -> publish sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers.js';
import { publishReel, captionFor } from '../src/instagram.js';

const cfgFor = (url) => ({ instagram: { userId: '17841400000000000', accessToken: 'EAAtoken', graphBaseUrl: url, graphVersion: 'v21.0', pollIntervalMs: 10, pollTimeoutMs: 2000 } });

test('publishes a reel after the container finishes processing', async () => {
	let polls = 0;
	const srv = await fakeServer(({ method, path: p }) => {
		if (method === 'POST' && p.endsWith('/media')) return { json: { id: 'container-1' } };
		if (method === 'GET' && p.endsWith('/container-1')) return { json: { status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' } };
		if (method === 'POST' && p.endsWith('/media_publish')) return { json: { id: 'media-99' } };
		return { status: 404, json: { error: { message: 'unexpected' } } };
	});
	try {
		const res = await publishReel(cfgFor(srv.url), { videoUrl: 'https://studio.example.com/media/r1/reel.mp4', caption: 'Hello' });
		assert.equal(res.mediaId, 'media-99');
		assert.equal(res.containerId, 'container-1');
		const [create] = srv.calls;
		assert.equal(create.path, '/v21.0/17841400000000000/media');
		assert.equal(create.body.media_type, 'REELS');
		assert.equal(create.body.video_url, 'https://studio.example.com/media/r1/reel.mp4');
		assert.equal(create.body.access_token, 'EAAtoken');
		assert.equal(polls, 3);
		assert.equal(srv.calls.at(-1).body.creation_id, 'container-1');
	} finally { await srv.close(); }
});

test('reports Instagram processing errors and API errors', async () => {
	const srv = await fakeServer(({ method, path: p }) => {
		if (method === 'POST' && p.endsWith('/media')) return { json: { id: 'c2' } };
		if (method === 'GET') return { json: { status_code: 'ERROR', status: 'Video too short' } };
		return { json: {} };
	});
	try { await assert.rejects(publishReel(cfgFor(srv.url), { videoUrl: 'https://x/v.mp4', caption: '' }), /Video too short/); } finally { await srv.close(); }

	const srv2 = await fakeServer(() => ({ status: 400, json: { error: { message: 'Invalid OAuth access token' } } }));
	try { await assert.rejects(publishReel(cfgFor(srv2.url), { videoUrl: 'https://x/v.mp4', caption: '' }), /Invalid OAuth access token/); } finally { await srv2.close(); }
});

test('caption joins text and hashtags within Instagram limits', () => {
	const c = captionFor({ caption: 'Fresh today.', hashtags: ['bread', 'local'] });
	assert.equal(c, 'Fresh today.\n\n#bread #local');
	assert.ok(captionFor({ caption: 'x'.repeat(3000), hashtags: [] }).length <= 2200);
});
