const B = process.argv[2] || 'http://127.0.0.1:8787', TOK = 'uji-token-123';
const j = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b }; };
const post = (p, body, h) => j(p, { method: 'POST', body: JSON.stringify(body), headers: h });
const tick = () => fetch(B + '/__scheduled?cron=*+*+*+*+*');
const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
const mode = process.argv[3] || 'full';
if (mode === 'reload') {
  const s = (await j('/api/mmws/state')).b, im = (await j('/api/mmws/imports')).b, h = (await j('/api/mmws/import-hourly')).b, hi = (await j('/api/mmws/history?hours=24')).b;
  ok(s.cfg.Sr === 60 && s.cfg.energize === '2014-03-12', 'pengaturan bertahan setelah restart: energize ' + s.cfg.energize);
  ok(im.length === 1 && im[0].done, 'impor bertahan: ' + JSON.stringify(im.map(x => [x.label, x.rows, x.feqa])));
  ok(h.rows.length > 1400, 'titik per jam impor bertahan: ' + h.rows.length);
  ok(hi.rows.length >= 3, 'riwayat live bertahan: ' + hi.rows.length + ' baris');
  process.exit();
}
let r = await post('/api/mmws/config', { energize: '2014-03-12', Sr: 60, oti: { alarm: 85, trip: 95 } });
ok(r.s === 200 && r.b.snapshot.cfg.energize === '2014-03-12' && r.b.snapshot.open === true, 'simpan pengaturan tanpa PIN, open=' + r.b.snapshot?.open);
// impor 62 hari data per jam sebelum mist
const t0 = Date.parse('2026-07-01T00:00:00+07:00'), rows = [];
for (let i = 0; i < 62 * 24; i++) { const hr = i % 24, K = 0.55 + 0.4 * Math.max(0, Math.sin((hr - 7) / 24 * 2 * Math.PI)); rows.push([t0 + i * 3600000, +(K * 60).toFixed(1), 27 + 5 * Math.sin((hr - 8) / 24 * 2 * Math.PI), 75, null, null, null]); }
const span = [rows[0][0], rows.at(-1)[0]], CH = 1000, n = Math.ceil(rows.length / CH);
for (let i = 0; i < n; i++) { r = await post('/api/mmws/import', { batch: 'uji1', phase: 'before', label: 'Logsheet Jul–Agu 2026', taDef: 29, span, rows: rows.slice(i * CH, (i + 1) * CH), final: i === n - 1 }); if (r.s !== 200) break; }
ok(r.s === 200 && r.b.import.done, 'impor riwayat 2 bulan: ' + JSON.stringify(r.b.import || r.b));
const s1 = r.b.snapshot;
ok(s1.compare.before != null && s1.life.fHistSrc === 'impor', `F_EQA sebelum mist ${s1.compare.before}, sisa umur ${s1.life.rem} jam, sumber ${s1.life.fHistSrc}`);
r = await post('/api/mmws/import', { batch: 'uji2', phase: 'before', label: 'dobel', span, rows: rows.slice(0, 10), final: true });
ok(r.s === 400, 'impor tumpang tindih ditolak: ' + r.b.error);
r = await j('/api/mmws/days?n=800'); ok(r.b.length >= 61 && r.b[0].src === 'before', 'grafik F_EQA harian dari impor: ' + r.b.length + ' hari');
// simulator
r = await post('/api/mmws/sim', { on: true }); ok(r.b.snapshot.src.sim === true, 'simulator nyala');
for (let i = 0; i < 3; i++) { await tick(); await new Promise(z => setTimeout(z, 1200)); }
r = await j('/api/mmws/state'); ok(r.b.liveMin >= 1 && r.b.amb != null && r.b.src.sim, `cron+simulator: liveMin ${r.b.liveMin}, ambien ${r.b.amb}, beban ${r.b.mva} MVA, θh ${r.b.thH}`);
// input operator & mist
r = await post('/api/mmws/manual', { mw: 40, oti: 61 }); ok(r.s === 200 && r.b.snapshot.Ksrc === 'manual', 'input beban/OTI operator: ' + r.b.snapshot.mva + ' MVA');
r = await post('/api/mmws/mist', { mode: 'manual', on: true }); ok(r.b.snapshot.mist.mode === 'manual' && r.b.snapshot.mist.on, 'mode mist manual ON');
// ingest ESP32
r = await post('/api/ingest', { ambien: { t: 31 } }); ok(r.s === 401, 'ingest tanpa token ditolak');
const hdr = { authorization: 'Bearer ' + TOK };
r = await post('/api/ingest', { node: 'esp32-sensor', ambien: { t: 31.2, rh: 70 }, udara_in: { t: 27.4, rh: 88 }, tangki: { err: 1 }, relay: 0, float: 1, rssi: -67, ip: '192.168.1.20', buf: 2, rows: [[Math.floor(Date.now() / 1000) - 600, 30.1, 72, 27, 86, null], [Math.floor(Date.now() / 1000) - 540, 30.2, 72, 27.1, 86, null]] }, hdr);
ok(r.s === 200 && r.b.mist === 1 && r.b.next_s === 10 && r.b.burst === 1, 'ingest ESP32: ' + JSON.stringify(r.b));
r = await j('/api/mmws/state'); ok(!r.b.src.sim && r.b.amb === 31.2 && r.b.sensors.tangki.err, `simulator mati otomatis, ambien ${r.b.amb}, DS18B20 tangki err=${r.b.sensors.tangki.err}, log: ${r.b.log[0].text}`);
r = await post('/api/ingest', { ambien: { t: 31.3, rh: 70 }, udara_in: { t: 27.5, rh: 88 }, relay: 1, float: 0 }, hdr);
ok(r.b.mist === 0, 'air habis → perintah mist 0: ' + JSON.stringify(r.b));
r = await fetch(B + '/api/mmws/export.csv?days=1&step=10'); const csv = await r.text();
ok(r.headers.get('content-disposition')?.includes('mmws-') && csv.startsWith('waktu,mva'), 'unduh CSV: ' + csv.split('\n').length + ' baris');
await post('/api/mmws/mist', { mode: 'auto' });
