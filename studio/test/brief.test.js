import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/brief.js';

test('extracts title, description and readable text from a web page', () => {
	const html = `<html><head><title> Northside Bakery </title><meta name="description" content="Sourdough &amp; pastries"><style>.x{}</style></head>
	<body><script>track()</script><nav>Home</nav><h1>Real bread</h1><p>Baked daily &amp; delivered.</p></body></html>`;
	const r = htmlToText(html);
	assert.equal(r.title, 'Northside Bakery');
	assert.equal(r.description, 'Sourdough &amp; pastries');
	assert.match(r.text, /Real bread/);
	assert.match(r.text, /Baked daily & delivered\./);
	assert.doesNotMatch(r.text, /track\(\)|\.x\{\}/);
});
