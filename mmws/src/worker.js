/* MMWS — Cloudflare Worker + Durable Object
   - Halaman dashboard disajikan dari folder public/ (Workers static assets)
   - /api/mmws/*  : API dashboard (state, history, days, impor, pengaturan, input, mist, CSV, simulator)
   - /api/ingest  : ESP32 mengirim data lewat HTTPS (Authorization: Bearer DEVICE_TOKEN)
   - Cron tiap menit: hitung model termal IEC 60076-7, susut umur, keputusan mist
   Mesin hitung (core.mjs) sama persis dengan versi Node-RED dan mode demo. */
import { mmwsCore, mmwsApi, mmwsSim, dtSnapshot, dtInit, dtLog, dtNum } from './core.mjs';

const DAY = 86400000;
const HIST_CHUNK = 'h:';      // riwayat per menit, dipecah per hari (UTC)
const IMP_META = 'i:';        // ringkasan & agregat harian tiap impor
const IMP_HP = 'p:';          // titik per jam tiap impor, dipecah 1500 baris

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return env.MMWS.get(env.MMWS.idFromName('trf1')).fetch(req);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.MMWS.get(env.MMWS.idFromName('trf1')).fetch('https://mmws.internal/__tick', { method: 'POST' }));
  }
};

export class MmwsDO {
  constructor(state, env) {
    this.state = state; this.env = env; this.S = null; this.sig = {};
    state.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    const st = this.state.storage, S = (await st.get('core')) || {};
    const all = await st.list();       // Map, urut berdasarkan kunci
    S.hist = []; S.imports = {};
    const hp = {};
    for (const [k, v] of all) {
      if (k.startsWith(HIST_CHUNK)) { for (const r of v) S.hist.push(r); this.sig[k] = sigRows(v); }
      else if (k.startsWith(IMP_META)) { S.imports[k.slice(2)] = v; this.sig[k] = sigImp(v, v._hpn || 0); }
      else if (k.startsWith(IMP_HP)) { const [id, j] = k.slice(2).split(':'); (hp[id] = hp[id] || [])[Number(j)] = v; this.sig[k] = 1; }
    }
    for (const id of Object.keys(S.imports)) { const parts = hp[id] || []; const rows = []; parts.forEach(p => p && p.forEach(r => rows.push(r))); if (rows.length) S.imports[id].hp = rows; delete S.imports[id]._hpn; }
    dtInit(S); this.S = S;
  }

  async save() {
    const st = this.state.storage, S = this.S, puts = {}, live = new Set(['core']);
    const { hist, imports, ...core } = S;
    puts.core = core;
    const byDay = {};
    for (const r of hist) { const k = HIST_CHUNK + String(Math.floor(r[0] / DAY)).padStart(6, '0'); (byDay[k] = byDay[k] || []).push(r); }
    for (const k of Object.keys(byDay)) { live.add(k); const s = sigRows(byDay[k]); if (this.sig[k] !== s) { puts[k] = byDay[k]; this.sig[k] = s; } }
    for (const id of Object.keys(imports || {})) {
      const { hp, ...meta } = imports[id], rows = hp || [], n = Math.ceil(rows.length / 1500), mk = IMP_META + id;
      live.add(mk); for (let j = 0; j < n; j++) live.add(IMP_HP + id + ':' + j);
      const s = sigImp(meta, rows.length);
      if (this.sig[mk] !== s) {
        puts[mk] = { ...meta, _hpn: rows.length }; this.sig[mk] = s;
        for (let j = 0; j < n; j++) { const k = IMP_HP + id + ':' + j; puts[k] = rows.slice(j * 1500, (j + 1) * 1500); this.sig[k] = 1; }
      }
    }
    const dels = Object.keys(this.sig).filter(k => !live.has(k));
    dels.forEach(k => delete this.sig[k]);
    const keys = Object.keys(puts);
    for (let i = 0; i < keys.length; i += 100) { const o = {}; keys.slice(i, i + 100).forEach(k => { o[k] = puts[k]; }); await st.put(o); }
    for (let i = 0; i < dels.length; i += 100) await st.delete(dels.slice(i, i + 100));
  }

  decorate(snap) {
    if (!snap || snap.v !== 1) return snap;
    const S = this.S, now = Date.now(), d = S.dev || {};
    snap.open = !this.env.MMWS_PIN;
    snap.src = { sim: !!(S.sim && S.sim.on), simSince: S.sim && S.sim.since || null, devAge: d.ts ? Math.round((now - d.ts) / 1000) : null, water: d.water == null ? null : d.water, relay: d.relay == null ? null : d.relay, buf: d.buf || 0 };
    if (d.water === 0 && d.ts && now - d.ts < 10 * 60000) snap.alarms = [{ key: 'air', level: 'crit', text: 'Air tangki mist habis — pompa ditahan mati' }].concat(snap.alarms || []);
    return snap;
  }

  async fetch(req) {
    const url = new URL(req.url), now = Date.now(), S = this.S;
    try {
      if (url.pathname === '/__tick') return await this.tick(now);
      if (url.pathname === '/api/ingest') return await this.ingest(req, now);
      if (!url.pathname.startsWith('/api/mmws')) return json({ error: 'Endpoint tidak dikenal' }, 404);

      const pinOk = !this.env.MMWS_PIN || req.headers.get('x-mmws-pin') === this.env.MMWS_PIN;
      let body = {};
      if (req.method === 'POST') { try { body = await req.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); } }

      if (req.method === 'POST' && url.pathname.endsWith('/sim')) {
        if (!pinOk) return json({ error: 'PIN salah atau belum diisi' }, 401);
        const on = !!body.on;
        if (on !== !!(S.sim && S.sim.on)) { S.sim = { on, since: now }; dtLog(S, now, 'mode', on ? 'Simulator ESP32 virtual DINYALAKAN — data berikutnya adalah data uji' : 'Simulator ESP32 virtual dimatikan'); await this.save(); }
        return json({ ok: true, snapshot: this.decorate(dtSnapshot(S, now)) });
      }

      const q = Object.fromEntries(url.searchParams);
      const r = mmwsApi(S, { method: req.method, path: url.pathname, query: q, body, pinOk }, now);
      if (req.method === 'POST' && r.status === 200) await this.save();
      if (r.type === 'csv') return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + r.filename + '"', 'cache-control': 'no-store' } });
      let out = r.body;
      if (r.core) out = { ok: true, snapshot: this.decorate(r.core.snapshot || dtSnapshot(S, now)) };
      else if (out && out.v === 1) out = this.decorate(out);
      else if (out && out.snapshot) out.snapshot = this.decorate(out.snapshot);
      return json(out, r.status);
    } catch (e) {
      return json({ error: 'Kesalahan server: ' + (e && e.message || e) }, 500);
    }
  }

  async tick(now) {
    const S = this.S, d = S.dev || {};
    const realFresh = d.ts && now - d.ts < 3 * 60000;
    if (S.sim && S.sim.on && !realFresh) mmwsSim(S, now).forEach(m => { m.quiet = 1; m.payload = JSON.parse(JSON.stringify(m.payload)); mmwsCore(S, m, now); });
    if (d.ts && !realFresh && !d.offLogged) { d.offLogged = true; dtLog(S, now, 'alarm', 'ESP32 tidak mengirim data lebih dari 3 menit (cek daya, WiFi, kuota 4G)'); }
    mmwsCore(S, { topic: 'tick', quiet: 1 }, now);
    await this.save();
    return json({ ok: true });
  }

  async ingest(req, now) {
    const tok = this.env.DEVICE_TOKEN;
    if (!tok) return json({ error: 'DEVICE_TOKEN belum diatur di server (wrangler secret put DEVICE_TOKEN)' }, 503);
    if ((req.headers.get('authorization') || '') !== 'Bearer ' + tok) return json({ error: 'Token perangkat salah' }, 401);
    if (req.method !== 'POST') return json({ error: 'Gunakan POST' }, 405);
    let p; try { p = await req.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
    const S = this.S, B = 'gisrgt/trf1/';
    if (S.sim && S.sim.on) { S.sim = { on: false, since: now }; dtLog(S, now, 'mode', 'ESP32 asli tersambung — simulator dimatikan otomatis. Hapus data uji di Pengaturan agar data simulasi tidak tercampur.'); }
    const prev = S.dev || {};
    if (prev.offLogged) dtLog(S, now, 'input', 'ESP32 kembali mengirim data');
    const sensor = (name, v) => { if (v == null) return; const pl = v.err ? { err: 1 } : { t: dtNum(v.t), rh: dtNum(v.rh) }; mmwsCore(S, { topic: B + 'sensor/' + name, payload: pl, quiet: 1 }, now); };
    sensor('ambien', p.ambien); sensor('udara_in', p.udara_in || p.inlet); sensor('tangki', p.tangki);
    sensor('header_atas', p.header_atas); sensor('header_bawah', p.header_bawah);
    const relay = p.relay == null ? null : Number(p.relay) ? 1 : 0;
    if (relay != null) mmwsCore(S, { topic: B + 'mist/status', payload: { on: relay, mode: String(p.mode || 'edge') }, quiet: 1 }, now);
    const water = p.float == null ? null : Number(p.float) ? 1 : 0;      // 1 = air ada, 0 = air habis
    if (water === 0 && prev.water !== 0) dtLog(S, now, 'alarm', 'Float switch: AIR TANGKI MIST HABIS — pompa ditahan mati');
    if (water === 1 && prev.water === 0) dtLog(S, now, 'input', 'Float switch: air tangki mist tersedia lagi');
    const node = String(p.node || 'esp32-sensor').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'esp32-sensor';
    mmwsCore(S, { topic: B + 'node/' + node, payload: { state: 'online', rssi: p.rssi, ip: p.ip || '' }, quiet: 1 }, now);
    let backfilled = 0;
    if (Array.isArray(p.rows) && p.rows.length) { backfilled = Math.min(120, p.rows.length); mmwsCore(S, { topic: B + 'backfill', payload: { rows: p.rows.slice(0, backfilled) }, quiet: 1 }, now); }
    const want = S.ctrl && S.ctrl.on && water !== 0 ? 1 : 0;
    S.dev = { ts: now, water, relay, buf: Math.max(0, (dtNum(p.buf) || 0) - backfilled), node };
    await this.save();
    const pending = S.dev.buf > 0, changed = relay != null && relay !== want;
    return json({ ok: true, mist: want, mode: S.cfg.ctrl.mode, t: Math.floor(now / 1000), next_s: changed ? 10 : pending ? 5 : 60, burst: changed ? 1 : 0, ack_rows: backfilled });
  }
}

function sigRows(a) { return a.length + ':' + a[0][0] + ':' + a[a.length - 1][0]; }
function sigImp(m, n) { return [m.rows, m.done ? 1 : 0, m.min, m.t1, n, m.label, m.phase].join(':'); }
