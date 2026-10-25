import assert from 'node:assert/strict';
const port = process.env.SAST_PORT || '3000';
if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid SAST_PORT');
const base = `http://127.0.0.1:${port}`;
async function request(path, body) {
 const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
 assert.ok(r.ok, `HTTP ${r.status}`); return r.json();
}
try {
 assert.equal((await request('/health')).status, 'healthy');
 const bad = await request('/scan/code', {code:'const password = "demo-only-value";',filename:'vulnerable.js'});
 assert.ok(bad.summary.high > 0);
 const good = await request('/scan/code', {code:'export const add = (a, b) => a + b;',filename:'clean.js'});
 assert.equal(good.summary.high, 0);
 console.log('PASS: local HTTP health, vulnerable and clean scans.');
} catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
