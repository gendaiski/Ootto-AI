// `npm run check`: the same system check as Settings → System check, in the terminal.
// Exits with code 1 when something is broken, so it also works in scripts and CI.
import { getConfig, WATCH_DEFAULTS } from '../src/config.js';
import { Settings } from '../src/settings.js';
import { runSelfTest } from '../src/selftest.js';

const cfg = getConfig();
cfg.watch = { ...WATCH_DEFAULTS, ...(cfg.watch || {}) };
const eff = new Settings(cfg.dataDir).apply(cfg);
const res = await runSelfTest(eff);
const icon = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
console.log('Ootto Studio system check\n');
for (const c of res.checks) console.log(`${icon[c.status]} ${c.label.padEnd(26)} ${c.detail}`);
console.log(res.ok ? '\nAll required parts work.' : '\nSomething needs fixing (✗ above).');
process.exit(res.ok ? 0 : 1);
