/* ===== MMWS core v1.0 — dipakai bersama oleh Node-RED (edge) dan mode demo dashboard =====
   Model termal dinamis IEC 60076-7:2018 (ONAF), laju penuaan relatif, susut umur,
   kendali mist (auto-prediktif / ambang / manual / off), riwayat 7 hari, agregat harian. */
var MMWS_DEFAULT_CFG = {
  gardu: 'GIS Randugarut', trafo: 'Trafo 1 150/20 kV 60 MVA',
  Sr: 60, vLV: 20, vHV: 150, pf: 0.95,
  R: 6, dor: 52, hgH: 26.5, hgL: 22.6, x: 0.8, y: 1.3, k11: 0.5, k21: 2, k22: 2, to: 150, tw: 7,
  ref: 98, life: 180000, energize: '2013-06-01', fHist: 0.25,
  load: [80, 90, 100], oti: { alarm: 85, trip: 95 }, wti: { alarm: 100, trip: 110 },
  ctrl: { mode: 'auto', sp: 92, hor: 4, rhCut: 92, ton: 70, hys: 2, minOn: 10, minOff: 10 },
  mistLpm: 0.8, pumpW: 150,
  fresh: { sensor: 5, load: 120, oti: 90 }
};
var DT_HIST_MAX = 10080; // 7 hari @ 1 menit
function dtNum(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
function dtR(v, d) { if (v === null || v === undefined || !isFinite(v)) return null; var k = Math.pow(10, d === undefined ? 1 : d); return Math.round(v * k) / k; }
function dtMerge(def, cur) {
  var o = {}; var k;
  for (k in def) {
    if (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) o[k] = dtMerge(def[k], (cur && cur[k]) || {});
    else o[k] = (cur && cur[k] !== undefined && cur[k] !== null) ? cur[k] : def[k];
  }
  return o;
}
function dtWB(T, RH) { return T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(T + RH) - Math.atan(RH - 1.676331) + 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) - 4.686035; }
function dtV(th, ref) { return ref == 110 ? Math.exp(15000 / 383 - 15000 / (th + 273)) : Math.pow(2, (th - 98) / 6); }
function dtSS(K, ta, c) { var o = ta + c.dor * Math.pow((1 + c.R * K * K) / (1 + c.R), c.x); var g = c.hgH * Math.pow(K, c.y); return { o: o, h1: c.k21 * g, h2: (c.k21 - 1) * g }; }
function dtStep(m, K, ta, c) {
  var ult = c.dor * Math.pow((1 + c.R * K * K) / (1 + c.R), c.x), g = c.hgH * Math.pow(K, c.y);
  m.o += (ult - (m.o - ta)) / (c.k11 * c.to);
  m.h1 += (c.k21 * g - m.h1) / (c.k22 * c.tw);
  m.h2 += ((c.k21 - 1) * g - m.h2) / (c.to / c.k22);
}
function dtWIB(t) { return new Date(t + 7 * 3600000); }
function dtDay(t) { return dtWIB(t).toISOString().slice(0, 10); }
function dtHour(t) { return dtWIB(t).getUTCHours(); }
function dtFresh(ts, min, now) { return !!ts && now - ts <= min * 60000; }

function dtInit(S) {
  S.cfg = dtMerge(MMWS_DEFAULT_CFG, S.cfg || {});
  S.live = S.live || {}; S.live.temps = S.live.temps || {}; S.live.nodes = S.live.nodes || {};
  S.hist = S.hist || []; S.days = S.days || {}; S.log = S.log || []; S.manualLog = S.manualLog || [];
  S.prof = S.prof || { K: [], ta: [], rh: [] };
  S.ctrl = S.ctrl || { on: false, since: 0, reason: 'Belum ada evaluasi', manualOn: false, lastEval: 0 };
  S.meta = S.meta || { first: null, lol: 0, min: 0, lastTick: 0, eta: 0.6, status: '' };
}
function dtLog(S, now, kind, text) { S.log.unshift({ t: now, kind: kind, text: text }); if (S.log.length > 300) S.log.length = 300; }

function dtForecast(S, now, withMist) {
  var c = S.cfg, L = S.live, m = { o: S.model.o, h1: S.model.h1, h2: S.model.h2 };
  var off = (S.last && S.last.to != null) ? S.last.to - S.model.o : 0;
  var H = Math.round(c.ctrl.hor * 60), mx = -1e9, series = [], i;
  var curK = S.last ? S.last.K : 0.6, curTa = L.ta != null ? L.ta : 30, curRh = L.rh != null ? L.rh : 75;
  for (i = 1; i <= H; i++) {
    var t = now + i * 60000, h = dtHour(t);
    var K = S.prof.K[h] != null ? S.prof.K[h] : curK, ta = S.prof.ta[h] != null ? S.prof.ta[h] : curTa, rh = S.prof.rh[h] != null ? S.prof.rh[h] : curRh;
    if (withMist && rh < c.ctrl.rhCut) ta = ta - S.meta.eta * (ta - dtWB(ta, rh));
    dtStep(m, K, ta, c);
    var th = m.o + off + m.h1 - m.h2; if (th > mx) mx = th;
    if (i % 10 === 0) series.push([t, dtR(th)]);
  }
  return { mx: mx, series: series };
}

function dtControl(S, now, x, force) {
  var cc = S.cfg.ctrl, C = S.ctrl, want = C.on, why = C.reason;
  if (cc.mode === 'off') { want = false; why = 'Mode OFF'; }
  else if (cc.mode === 'manual') { want = !!C.manualOn; why = 'Manual dari dashboard'; }
  else if (cc.mode === 'threshold') {
    var ref = x.tankRef;
    if (ref == null) { want = false; why = 'Tidak ada suhu acuan'; }
    else if (!C.on && ref > cc.ton) { want = true; why = 'Suhu acuan ' + dtR(ref) + ' °C > ' + cc.ton + ' °C'; }
    else if (C.on && ref < cc.ton - cc.hys) { want = false; why = 'Suhu acuan turun ke ' + dtR(ref) + ' °C'; }
  } else if (cc.mode === 'auto') {
    if (force || now - (C.lastEval || 0) >= 15 * 60000) {
      C.lastEval = now;
      var fOff = dtForecast(S, now, false), fOn = dtForecast(S, now, true);
      var dep = (x.amb != null && x.rh != null) ? x.amb - dtWB(x.amb, x.rh) : null;
      want = fOff.mx > cc.sp && (dep == null || dep > 1) && (x.rh == null || x.rh < cc.rhCut);
      if (want) why = 'Prediksi θh maks ' + dtR(fOff.mx) + ' °C > ' + cc.sp + ' °C dalam ' + cc.hor + ' jam';
      else if (fOff.mx > cc.sp) why = dep != null && dep <= 1 ? 'Udara jenuh (θa−θwb ' + dtR(dep) + ' °C), kabut tidak efektif' : 'RH ' + dtR(x.rh, 0) + '% ≥ batas ' + cc.rhCut + '%';
      else why = 'Prediksi θh maks ' + dtR(fOff.mx) + ' °C ≤ ' + cc.sp + ' °C';
      C.pred = { t: now, off: fOff.series, on: fOn.series, mxOff: dtR(fOff.mx), mxOn: dtR(fOn.mx), dep: dtR(dep) };
    }
  }
  if (want !== C.on) {
    var since = (now - (C.since || 0)) / 60000, hold = (cc.mode === 'auto' || cc.mode === 'threshold') && since < (C.on ? cc.minOn : cc.minOff);
    if (!hold) { C.on = want; C.since = now; C.reason = why; dtLog(S, now, want ? 'mist-on' : 'mist-off', 'Mist ' + (want ? 'ON' : 'OFF') + ' — ' + why); }
  } else C.reason = why;
}

function dtSetLoad(S, mva, src, now) { var L = S.live; L.K = mva / S.cfg.Sr; L.Kt = now; L.Ksrc = src; }

/* Masukan: msg.topic = 'tick' | 'gisrgt/trf1/sensor/<nama>' | 'gisrgt/trf1/kamera/<k>' | 'gisrgt/trf1/mist/status'
   | 'gisrgt/trf1/node/<id>' | 'manual' | 'mist' | 'config'.  Keluaran: {snapshot, cmd, csv, nilai[]} */
function mmwsCore(S, msg, now) {
  dtInit(S);
  var c = S.cfg, L = S.live, out = {}, topic = String(msg.topic || ''), p = msg.payload, seg = topic.split('/');
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = { state: p }; } }
  p = p || {};
  if (topic === 'tick') return dtTick(S, now, false, msg.quiet);
  if (seg[2] === 'sensor' && seg[3]) {
    var t = dtNum(p.t), rh = dtNum(p.rh), name = seg[3];
    if (p.err) { L.temps[name] = { t: null, rh: null, ts: (L.temps[name] || {}).ts || 0, err: 1, errT: now }; }
    else if (t != null) {
      L.temps[name] = { t: t, rh: rh, ts: now };
      if (name === 'ambien') { L.ta = t; L.rh = rh; L.tat = now; }
      if (name === 'udara_in') { L.tin = t; L.rhin = rh; L.tint = now; }
    }
  } else if (seg[2] === 'kamera' && seg[3]) {
    var v = dtNum(p.v), conf = dtNum(p.conf);
    if (v != null && (conf == null || conf >= 0.8)) {
      if (seg[3] === 'beban_a') dtSetLoad(S, Math.sqrt(3) * c.vLV * v / 1000, 'kamera', now);
      else if (seg[3] === 'beban_mw') dtSetLoad(S, v / c.pf, 'kamera', now);
      else if (seg[3] === 'oti') { L.oti = v; L.otit = now; L.otisrc = 'kamera'; }
      else if (seg[3] === 'wti_hv') { L.wh = v; L.wht = now; }
      else if (seg[3] === 'wti_lv') { L.wl = v; L.wlt = now; }
    }
  } else if (seg[2] === 'mist' && seg[3] === 'status') { L.mistFb = !!Number(p.on); L.mistFbMode = p.mode || ''; L.mistFbT = now; }
  else if (seg[2] === 'backfill') {
    var add = 0;
    (p.rows || []).forEach(function (r) {
      var t = dtNum(r && r[0]); if (t == null) return; if (t < 1e11) t = t * 1000;
      if (t > now + 60000 || now - t > 7 * 86400000) return;
      var lo = 0, hi = S.hist.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (S.hist[mid][0] < t) lo = mid + 1; else hi = mid; }
      if ((S.hist[lo] && Math.abs(S.hist[lo][0] - t) < 30000) || (S.hist[lo - 1] && Math.abs(S.hist[lo - 1][0] - t) < 30000)) return;
      S.hist.splice(lo, 0, [t, dtR(dtNum(r[1])), dtR(dtNum(r[2]), 0), dtR(dtNum(r[3])), dtR(dtNum(r[5])), null, null, null, null, null, null, null, null, null]); add++;
    });
    if (S.hist.length > DT_HIST_MAX) S.hist.splice(0, S.hist.length - DT_HIST_MAX);
    if (add) dtLog(S, now, 'input', 'Data cadangan dari ESP32 diterima: ' + add + ' menit (saat koneksi putus)');
  }
  else if (seg[2] === 'node' && seg[3]) { L.nodes[seg[3]] = { state: String(p.state || 'online'), rssi: dtNum(p.rssi), ip: p.ip || '', ts: now }; }
  else if (topic === 'manual') {
    var mva = dtNum(p.mva), mw = dtNum(p.mw), a = dtNum(p.a), entry = { t: now };
    if (mva != null) { dtSetLoad(S, mva, 'manual', now); entry.mva = mva; }
    else if (mw != null) { dtSetLoad(S, mw / c.pf, 'manual', now); entry.mw = mw; }
    else if (a != null) { dtSetLoad(S, Math.sqrt(3) * c.vLV * a / 1000, 'manual', now); entry.a = a; }
    if (dtNum(p.oti) != null) { L.oti = dtNum(p.oti); L.otit = now; L.otisrc = 'manual'; entry.oti = L.oti; }
    if (dtNum(p.wti_hv) != null) { L.wh = dtNum(p.wti_hv); L.wht = now; entry.wti_hv = L.wh; }
    if (dtNum(p.wti_lv) != null) { L.wl = dtNum(p.wti_lv); L.wlt = now; entry.wti_lv = L.wl; }
    S.manualLog.unshift(entry); if (S.manualLog.length > 500) S.manualLog.length = 500;
    dtLog(S, now, 'input', 'Input manual: ' + Object.keys(entry).filter(function (k) { return k !== 't'; }).map(function (k) { return k + ' ' + entry[k]; }).join(', '));
  } else if (topic === 'mist') {
    if (['auto', 'threshold', 'manual', 'off'].indexOf(p.mode) >= 0 && p.mode !== c.ctrl.mode) { c.ctrl.mode = p.mode; dtLog(S, now, 'mode', 'Mode kendali → ' + p.mode); }
    if (p.on !== undefined) S.ctrl.manualOn = !!p.on;
    return dtTick(S, now, true);
  } else if (topic === 'config') {
    S.cfg = dtMerge(MMWS_DEFAULT_CFG, dtMerge(S.cfg, p)); dtLog(S, now, 'config', 'Pengaturan diperbarui'); S.model = null;
  }
  if (!msg.quiet) out.snapshot = dtSnapshot(S, now);
  return out;
}

function dtTick(S, now, force, quiet) {
  var c = S.cfg, L = S.live, out = {};
  var dt = S.meta.lastTick ? Math.round((now - S.meta.lastTick) / 60000) : 1;
  if (!force && dt < 1) { if (!quiet) out.snapshot = dtSnapshot(S, now); return out; }
  if (dt < 1) dt = 0; if (dt > 5) dt = 5;
  if (dt > 0) S.meta.lastTick = now;
  var amb = dtFresh(L.tat, c.fresh.sensor, now) ? L.ta : null;
  var rh = dtFresh(L.tat, c.fresh.sensor, now) ? L.rh : null;
  var inlet = dtFresh(L.tint, c.fresh.sensor, now) ? L.tin : null;
  var taEff = inlet != null ? inlet : amb;
  var h = dtHour(now), K = L.K != null ? L.K : (S.prof.K[h] != null ? S.prof.K[h] : null);
  if (taEff == null || K == null) {
    S.meta.status = taEff == null ? 'Menunggu data sensor ambien / udara masuk' : 'Belum ada data beban — isi lewat Input Data';
    if (!quiet) out.snapshot = dtSnapshot(S, now); return out;
  }
  S.meta.status = '';
  if (!S.model) S.model = dtSS(K, taEff, c);
  for (var i = 0; i < dt; i++) dtStep(S.model, K, taEff, c);
  var otiF = L.oti != null && dtFresh(L.otit, c.fresh.oti, now);
  var to = otiF ? L.oti : S.model.o, dh = S.model.h1 - S.model.h2;
  var thH = to + dh, thL = to + (c.hgL / c.hgH) * dh, V = dtV(thH, c.ref);
  S.last = { t: now, K: K, Kstale: !dtFresh(L.Kt, c.fresh.load, now), to: to, toSrc: otiF ? L.otisrc : 'model', toModel: S.model.o, thH: thH, thL: thL, V: V, taEff: taEff, amb: amb, rh: rh, inlet: inlet };
  // efektivitas kabut terukur (EMA)
  if (S.ctrl.on && amb != null && rh != null && inlet != null) { var d0 = amb - dtWB(amb, rh); if (d0 > 1) { var e = (amb - inlet) / d0; if (e > -0.2 && e < 1.2) S.meta.eta = 0.95 * S.meta.eta + 0.05 * Math.max(0, Math.min(1, e)); } }
  if (dt > 0) {
    var key = dtDay(now), d = S.days[key] || { v: 0, m: 0, mx: -99, mist: 0, kmx: 0, water: 0 };
    d.v += V * dt; d.m += dt; if (thH > d.mx) d.mx = thH; if (K > d.kmx) d.kmx = K;
    if (S.ctrl.on) { d.mist += dt; d.water += c.mistLpm * dt; }
    S.days[key] = d;
    var keys = Object.keys(S.days).sort(); while (keys.length > 400) delete S.days[keys.shift()];
    S.meta.lol += V * dt / 60; S.meta.min += dt; if (!S.meta.first) S.meta.first = now;
    var a = 0.05;
    S.prof.K[h] = S.prof.K[h] == null ? K : (1 - a) * S.prof.K[h] + a * K;
    if (amb != null) S.prof.ta[h] = S.prof.ta[h] == null ? amb : (1 - a) * S.prof.ta[h] + a * amb;
    if (rh != null) S.prof.rh[h] = S.prof.rh[h] == null ? rh : (1 - a) * S.prof.rh[h] + a * rh;
  }
  var tank = L.temps.tangki && dtFresh(L.temps.tangki.ts, c.fresh.sensor, now) ? L.temps.tangki.t : null;
  dtControl(S, now, { amb: amb, rh: rh, tankRef: tank != null ? tank : to - 3 }, force);
  var wh = L.wh != null && dtFresh(L.wht, c.fresh.oti, now) ? L.wh : null, wl = L.wl != null && dtFresh(L.wlt, c.fresh.oti, now) ? L.wl : null;
  if (dt > 0) {
    S.hist.push([now, dtR(amb), dtR(rh, 0), dtR(inlet), dtR(tank), otiF ? dtR(L.oti) : null, dtR(to), dtR(thH), dtR(thL), dtR(K, 3), dtR(V, 4), S.ctrl.on ? 1 : 0, dtR(wh), dtR(wl)]);
    if (S.hist.length > DT_HIST_MAX) S.hist.splice(0, S.hist.length - DT_HIST_MAX);
    var w = dtWIB(now).toISOString().replace('T', ' ').slice(0, 16);
    out.csv = { day: dtDay(now), header: 'waktu,mva,ambien,rh,udara_masuk,tangki,oti,top_oil_dipakai,hotspot_hv,hotspot_lv,V,mist,wti_hv,wti_lv',
      line: [w, dtR(K * c.Sr, 2), dtR(amb), dtR(rh, 0), dtR(inlet), dtR(tank), otiF ? dtR(L.oti) : '', dtR(to), dtR(thH), dtR(thL), dtR(V, 4), S.ctrl.on ? 1 : 0, dtR(wh), dtR(wl)].map(function (x) { return x == null ? '' : x; }).join(',') };
  }
  out.cmd = { on: S.ctrl.on ? 1 : 0, src: c.ctrl.mode, ts: now };
  out.nilai = [
    { topic: 'gisrgt/trf1/nilai/beban_a', payload: { v: dtR(K * c.Sr * 1000 / (Math.sqrt(3) * c.vLV), 0), conf: 1 } },
    { topic: 'gisrgt/trf1/nilai/oti', payload: { v: dtR(to), conf: 1, src: otiF ? L.otisrc : 'model' } },
    { topic: 'gisrgt/trf1/nilai/wti_hv', payload: { v: dtR(wh != null ? wh : thH), conf: 1, src: wh != null ? 'ukur' : 'model' } },
    { topic: 'gisrgt/trf1/nilai/wti_lv', payload: { v: dtR(wl != null ? wl : thL), conf: 1, src: wl != null ? 'ukur' : 'model' } }
  ];
  if (!quiet) out.snapshot = dtSnapshot(S, now);
  return out;
}

function dtSnapshot(S, now) {
  var c = S.cfg, L = S.live, last = S.last || {}, key = dtDay(now), d = S.days[key];
  var f7 = 0, m7 = 0, i, ks = Object.keys(S.days).sort().slice(-7);
  for (i = 0; i < ks.length; i++) { f7 += S.days[ks[i]].v; m7 += S.days[ks[i]].m; }
  var F7 = m7 ? f7 / m7 : null;
  var en = Date.parse(c.energize + 'T00:00:00+07:00'), IA = dtImportAgg(S, null), IB = dtImportAgg(S, 'before'), IAf = dtImportAgg(S, 'after');
  var first = Math.min(S.meta.first || now, IA.t0 != null ? IA.t0 : now);
  var histH = isFinite(en) && en < first ? (first - en) / 3600000 : 0, fHistUsed = IB.feqa != null ? IB.feqa : c.fHist;
  var used = histH * fHistUsed + S.meta.lol + IA.lolH, rem = Math.max(0, c.life - used);
  var alarms = [];
  if (last.K != null) {
    var pct = last.K * 100, lv = 0; c.load.forEach(function (x, j) { if (pct >= x) lv = j + 1; });
    if (lv) alarms.push({ key: 'beban', level: lv >= 3 ? 'crit' : 'warn', text: 'Beban ' + dtR(pct, 0) + '% ≥ ' + c.load[lv - 1] + '%' });
    var chk = function (nm, val, lim, src) { if (val == null) return; if (val >= lim.trip) alarms.push({ key: nm, level: 'crit', text: nm + ' ' + dtR(val) + ' °C ≥ batas trip ' + lim.trip + ' °C' + (src ? ' (' + src + ')' : '') }); else if (val >= lim.alarm) alarms.push({ key: nm, level: 'warn', text: nm + ' ' + dtR(val) + ' °C ≥ batas alarm ' + lim.alarm + ' °C' + (src ? ' (' + src + ')' : '') }); };
    chk('OTI', last.to, c.oti, last.toSrc === 'model' ? 'estimasi model' : '');
    chk('WTI HV', L.wh != null && dtFresh(L.wht, c.fresh.oti, now) ? L.wh : last.thH, c.wti, L.wh != null && dtFresh(L.wht, c.fresh.oti, now) ? '' : 'estimasi model');
    chk('WTI LV', L.wl != null && dtFresh(L.wlt, c.fresh.oti, now) ? L.wl : last.thL, c.wti, L.wl != null && dtFresh(L.wlt, c.fresh.oti, now) ? '' : 'estimasi model');
  }
  var sensors = {};
  Object.keys(L.temps).forEach(function (k) { var s = L.temps[k]; sensors[k] = { t: s.t, rh: s.rh, age: s.ts ? Math.round((now - s.ts) / 1000) : null, err: !!s.err && (!s.ts || s.errT > s.ts) }; });
  var nodes = {}; Object.keys(L.nodes).forEach(function (k) { var n = L.nodes[k]; nodes[k] = { state: n.state, rssi: n.rssi, ip: n.ip, age: Math.round((now - n.ts) / 1000) }; });
  return {
    v: 1, t: now, liveMin: S.meta.min, gardu: c.gardu, trafo: c.trafo, status: S.meta.status,
    K: dtR(L.K != null ? L.K : last.K, 3), Kstale: !!last.Kstale, Ksrc: L.Ksrc || null, Kage: L.Kt ? Math.round((now - L.Kt) / 60000) : null, mva: (L.K != null ? L.K : last.K) != null ? dtR((L.K != null ? L.K : last.K) * c.Sr, 1) : null,
    amb: dtR(L.ta), rh: dtR(L.rh, 0), wb: L.ta != null && L.rh != null ? dtR(dtWB(L.ta, L.rh)) : null, inlet: dtR(L.tin), rhIn: dtR(L.rhin, 0),
    tank: L.temps.tangki ? dtR(L.temps.tangki.t) : null,
    to: dtR(last.to), toSrc: last.toSrc || null, toModel: dtR(last.toModel), oti: dtR(L.oti), otiAge: L.otit ? Math.round((now - L.otit) / 60000) : null,
    wh: dtR(L.wh), wl: dtR(L.wl), thH: dtR(last.thH), thL: dtR(last.thL), V: dtR(last.V, 4),
    today: d ? { feqa: dtR(d.v / d.m, 4), lol: dtR(d.v / 60, 2), mx: dtR(d.mx), mist: d.mist, water: dtR(d.water, 0), hours: dtR(d.m / 60, 1) } : null,
    F7: dtR(F7, 4), life: { used: dtR(used, 0), rem: dtR(rem, 0), pct: dtR(used / c.life * 100, 2), years: F7 ? dtR(rem / (8760 * F7), 1) : null, yearsBefore: IB.feqa ? dtR(rem / (8760 * IB.feqa), 1) : null, histH: dtR(histH, 0), fHistUsed: dtR(fHistUsed, 4), fHistSrc: IB.feqa != null ? 'impor' : 'pengaturan', dataH: dtR(S.meta.min / 60 + IA.hours, 1), lolData: dtR(S.meta.lol + IA.lolH, 1) },
    compare: { before: dtR(IB.feqa, 4), beforeH: dtR(IB.hours, 0), after: dtR(IAf.feqa, 4), afterH: dtR(IAf.hours, 0), live7: dtR(F7, 4) },
    imports: Object.keys(S.imports || {}).map(function (k) { return dtImportSummary(k, S.imports[k]); }).sort(function (a, z) { return (a.t0 || 0) - (z.t0 || 0); }),
    mist: { on: !!S.ctrl.on, mode: c.ctrl.mode, reason: S.ctrl.reason, since: S.ctrl.since, fb: L.mistFb == null ? null : L.mistFb, fbAge: L.mistFbT ? Math.round((now - L.mistFbT) / 1000) : null, eta: dtR(S.meta.eta, 2), pred: S.ctrl.pred || null, manualOn: !!S.ctrl.manualOn },
    alarms: alarms, sensors: sensors, nodes: nodes, log: S.log.slice(0, 40),
    cfg: { Sr: c.Sr, vLV: c.vLV, pf: c.pf, ref: c.ref, load: c.load, oti: c.oti, wti: c.wti, ctrl: c.ctrl, life: c.life, energize: c.energize }
  };
}


/* ===== Impor riwayat (logsheet / SCADA bulan-bulan sebelumnya) =====
   body = {batch, phase:'before'|'after'|'hist', label, taDef, rows:[[t_ms, mva, ta, rh, oti, wti_hv, wti_lv]], final}
   Dikirim bertahap (potongan ≤ 3000 baris); state model disimpan antar potongan. */
function dtImportChunk(S, b, now) {
  dtInit(S); var c = S.cfg; S.imports = S.imports || {};
  var id = String(b.batch || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!id) return { error: 'batch kosong' };
  var I = S.imports[id];
  if (!I) {
    if (Object.keys(S.imports).length >= 60) return { error: 'Maksimal 60 impor. Hapus impor lama terlebih dahulu.' };
    if (b.span && b.span.length === 2) {
      var clash = null; Object.keys(S.imports).forEach(function (k) { var J = S.imports[k]; if (J.done && J.t0 != null && b.span[0] <= J.t1 && b.span[1] >= J.t0) clash = J; });
      if (clash) return { error: 'Rentang waktu tumpang tindih dengan impor "' + clash.label + '" (' + dtDay(clash.t0) + ' s.d. ' + dtDay(clash.t1) + '). Hapus impor itu dulu atau potong datanya.' };
    }
    I = S.imports[id] = { phase: ['before', 'after', 'hist'].indexOf(b.phase) >= 0 ? b.phase : 'hist', label: String(b.label || 'Impor').slice(0, 80), t0: null, t1: null, rows: 0, days: {}, sumV: 0, min: 0, mx: -99, gaps: 0, created: now, done: false };
  }
  var taDef = dtNum(b.taDef); if (taDef == null) taDef = 29;
  var rows = (b.rows || []).filter(function (r) { return r && dtNum(r[0]) != null && dtNum(r[1]) != null; }).sort(function (a, z) { return a[0] - z[0]; });
  rows.forEach(function (r) {
    var row = { t: Number(r[0]), K: Number(r[1]) / c.Sr, ta: dtNum(r[2]) != null ? Number(r[2]) : taDef, rh: dtNum(r[3]), oti: dtNum(r[4]) };
    var a = I.last;
    if (a && row.t > a.t) {
      var gap = Math.round((row.t - a.t) / 60000);
      if (gap > 180) { I.st = null; I.gaps++; }
      else {
        if (!I.st) I.st = dtSS(a.K, a.ta, c);
        var io = a.oti != null && row.oti != null;
        for (var m = 0; m < gap; m++) {
          var fr = m / gap, K = a.K + (row.K - a.K) * fr, ta = a.ta + (row.ta - a.ta) * fr;
          dtStep(I.st, K, ta, c);
          var to = io ? a.oti + (row.oti - a.oti) * fr : I.st.o, th = to + I.st.h1 - I.st.h2, v = dtV(th, c.ref), key = dtDay(a.t + m * 60000);
          var d = I.days[key] || (I.days[key] = { v: 0, m: 0, mx: -99, kmx: 0 });
          d.v += v; d.m++; if (th > d.mx) d.mx = th; if (K > d.kmx) d.kmx = K;
          I.sumV += v; I.min++; if (th > I.mx) I.mx = th;
          if (b.keepHourly !== false) { var tt = a.t + m * 60000; if (tt % 3600000 === 0 && (!I.hp || I.hp.length < 9600)) (I.hp || (I.hp = [])).push([tt, dtR(ta), a.rh != null ? dtR(a.rh, 0) : null, null, null, io ? dtR(to) : null, dtR(to), dtR(th), dtR(to + (c.hgL / c.hgH) * (I.st.h1 - I.st.h2)), dtR(K, 3), dtR(v, 4), null, null, null]); }
        }
      }
    }
    if (!a || row.t > a.t) { I.last = row; I.rows++; if (I.t0 == null || row.t < I.t0) I.t0 = row.t; if (I.t1 == null || row.t > I.t1) I.t1 = row.t; }
  });
  if (b.final) {
    I.done = true; delete I.st; delete I.last;
    Object.keys(I.days).forEach(function (k) { var d = I.days[k]; I.days[k] = { v: dtR(d.v, 3), m: d.m, mx: dtR(d.mx), kmx: dtR(d.kmx, 3) }; });
    dtLog(S, now, 'input', 'Impor riwayat "' + I.label + '" (' + (I.phase === 'before' ? 'sebelum mist' : I.phase === 'after' ? 'sesudah mist' : 'riwayat') + '): ' + I.rows + ' baris, ' + dtDay(I.t0) + ' s.d. ' + dtDay(I.t1));
  }
  return dtImportSummary(id, I);
}
function dtImportSummary(id, I) {
  return { batch: id, phase: I.phase, label: I.label, t0: I.t0, t1: I.t1, rows: I.rows, days: Object.keys(I.days).length, feqa: I.min ? dtR(I.sumV / I.min, 4) : null, lolH: dtR(I.sumV / 60, 1), hours: dtR(I.min / 60, 1), mx: dtR(I.mx), gaps: I.gaps, done: I.done };
}
function dtImportAgg(S, phase) {
  var v = 0, m = 0, lol = 0, t0 = null; S.imports = S.imports || {};
  Object.keys(S.imports).forEach(function (k) { var I = S.imports[k]; if (!I.done) return; if (phase && I.phase !== phase) return; v += I.sumV; m += I.min; if (I.t0 != null && (t0 == null || I.t0 < t0)) t0 = I.t0; });
  return { feqa: m ? v / m : null, lolH: v / 60, hours: m / 60, t0: t0 };
}

/* HTTP API — req = {method, path, query, body, pinOk}; mengembalikan {status, type, body, core?} */
function mmwsApi(S, req, now) {
  dtInit(S);
  var q = req.query || {}, path = req.path.replace(/\/+$/, '');
  var need = function () { return req.pinOk ? null : { status: 401, type: 'json', body: { error: 'PIN salah atau belum diisi' } }; };
  if (req.method === 'GET' && path.endsWith('/state')) return { status: 200, type: 'json', body: dtSnapshot(S, now) };
  if (req.method === 'GET' && path.endsWith('/history')) {
    var hours = Math.min(168, Math.max(1, Number(q.hours) || 24)), from = now - hours * 3600000, rows = S.hist.filter(function (r) { return r[0] >= from; });
    var step = Math.max(1, Math.ceil(rows.length / 1500)), outRows = [];
    for (var i = 0; i < rows.length; i += step) outRows.push(rows[i]);
    return { status: 200, type: 'json', body: { cols: ['t', 'amb', 'rh', 'inlet', 'tank', 'oti', 'to', 'thH', 'thL', 'K', 'V', 'mist', 'wh', 'wl'], rows: outRows } };
  }
  if (req.method === 'GET' && path.endsWith('/days')) {
    var n = Math.min(800, Number(q.n) || 30), all = {};
    Object.keys(S.imports || {}).forEach(function (bk) { var I = S.imports[bk]; if (!I.done) return; Object.keys(I.days).forEach(function (k) { var d = I.days[k], e = all[k] || (all[k] = { v: 0, m: 0, mx: -99, kmx: 0, mist: 0, water: 0, src: I.phase }); e.v += d.v; e.m += d.m; if (d.mx > e.mx) e.mx = d.mx; if (d.kmx > e.kmx) e.kmx = d.kmx; }); });
    Object.keys(S.days).forEach(function (k) { var d = S.days[k]; all[k] = { v: d.v, m: d.m, mx: d.mx, kmx: d.kmx, mist: d.mist, water: d.water, src: 'live' }; });
    var ks = Object.keys(all).sort().slice(-n);
    return { status: 200, type: 'json', body: ks.map(function (k) { var d = all[k]; return { day: k, src: d.src, feqa: d.m ? dtR(d.v / d.m, 4) : null, lol: dtR(d.v / 60, 2), mx: dtR(d.mx), kmx: dtR(d.kmx, 3), mist: d.mist, water: dtR(d.water, 0), hours: dtR(d.m / 60, 1) }; }) };
  }
  if (req.method === 'GET' && path.endsWith('/export.csv')) {
    var days = Math.min(7, Math.max(1, Number(q.days) || 7)), stepMin = Math.max(1, Number(q.step) || 10), from2 = now - days * 86400000, c = S.cfg;
    var lines = ['waktu,mva,ambien,rh,oti,wti_hv,wti_lv,mist'], bucket = null, acc = null;
    var flush = function () { if (!acc) return; var avg = function (k) { return acc[k].n ? dtR(acc[k].s / acc[k].n, 2) : ''; }; lines.push([dtWIB(bucket).toISOString().replace('T', ' ').slice(0, 16), avg('mva'), avg('amb'), avg('rh'), avg('oti'), avg('wh'), avg('wl'), acc.mist.n ? (acc.mist.s / acc.mist.n >= 0.5 ? 1 : 0) : ''].join(',')); };
    S.hist.forEach(function (r) {
      if (r[0] < from2) return; var b = Math.floor(r[0] / (stepMin * 60000)) * stepMin * 60000;
      if (b !== bucket) { flush(); bucket = b; acc = { mva: { s: 0, n: 0 }, amb: { s: 0, n: 0 }, rh: { s: 0, n: 0 }, oti: { s: 0, n: 0 }, wh: { s: 0, n: 0 }, wl: { s: 0, n: 0 }, mist: { s: 0, n: 0 } }; }
      var add = function (k, v) { if (v != null) { acc[k].s += v; acc[k].n++; } };
      add('mva', r[9] != null ? r[9] * c.Sr : null); add('amb', r[1]); add('rh', r[2]); add('oti', r[5]); add('wh', r[12]); add('wl', r[13]); add('mist', r[11]);
    });
    flush();
    return { status: 200, type: 'csv', body: lines.join('\n') + '\n', filename: 'mmws-' + dtDay(now) + '.csv' };
  }
  if (req.method === 'GET' && path.endsWith('/config')) { var cfg = JSON.parse(JSON.stringify(S.cfg)); return { status: 200, type: 'json', body: cfg }; }
  var b = req.body || {};
  if (req.method === 'POST' && path.endsWith('/config')) { var e1 = need(); if (e1) return e1; return { status: 200, type: 'json', core: mmwsCore(S, { topic: 'config', payload: b }, now) }; }
  if (req.method === 'POST' && path.endsWith('/manual')) { var e2 = need(); if (e2) return e2; return { status: 200, type: 'json', core: mmwsCore(S, { topic: 'manual', payload: b }, now) }; }
  if (req.method === 'POST' && path.endsWith('/mist')) { var e3 = need(); if (e3) return e3; return { status: 200, type: 'json', core: mmwsCore(S, { topic: 'mist', payload: b }, now) }; }
  if (req.method === 'GET' && path.endsWith('/import-hourly')) { var hr = []; Object.keys(S.imports || {}).forEach(function (k) { var I = S.imports[k]; if (I.done) (I.hp || []).forEach(function (r) { hr.push(r); }); }); hr.sort(function (a, z) { return a[0] - z[0]; }); return { status: 200, type: 'json', body: { cols: ['t', 'amb', 'rh', 'inlet', 'tank', 'oti', 'to', 'thH', 'thL', 'K', 'V', 'mist', 'wh', 'wl'], rows: hr.slice(-10000) } }; }
  if (req.method === 'GET' && path.endsWith('/imports')) return { status: 200, type: 'json', body: Object.keys(S.imports || {}).map(function (k) { return dtImportSummary(k, S.imports[k]); }) };
  if (req.method === 'POST' && path.endsWith('/import')) { var e5 = need(); if (e5) return e5; var ir = dtImportChunk(S, b, now); if (ir.error) return { status: 400, type: 'json', body: ir }; return { status: 200, type: 'json', body: { ok: true, import: ir, snapshot: b.final ? dtSnapshot(S, now) : undefined } }; }
  if (req.method === 'POST' && path.endsWith('/import-delete')) { var e6 = need(); if (e6) return e6; var bid = String(b.batch || ''); if (!S.imports || !S.imports[bid]) return { status: 404, type: 'json', body: { error: 'Impor tidak ditemukan' } }; var lbl = S.imports[bid].label; delete S.imports[bid]; dtLog(S, now, 'config', 'Impor "' + lbl + '" dihapus'); return { status: 200, type: 'json', body: { ok: true, snapshot: dtSnapshot(S, now) } }; }
  if (req.method === 'POST' && path.endsWith('/reset-data')) { var e4 = need(); if (e4) return e4; if (b.confirm !== 'HAPUS') return { status: 400, type: 'json', body: { error: 'Ketik HAPUS untuk konfirmasi' } }; var keep = S.cfg, keepI = S.imports; for (var k in S) delete S[k]; S.cfg = keep; if (keepI) S.imports = keepI; dtInit(S); return { status: 200, type: 'json', body: { ok: true } }; }
  return { status: 404, type: 'json', body: { error: 'Endpoint tidak dikenal' } };
}

/* Simulator lapangan — membuat pesan sensor & beban tiruan (untuk uji tanpa hardware) */
function mmwsSim(S, now) {
  var hr = (dtWIB(now).getUTCHours() + dtWIB(now).getUTCMinutes() / 60), BASE = [0.58, 0.55, 0.53, 0.52, 0.53, 0.58, 0.62, 0.66, 0.70, 0.73, 0.76, 0.78, 0.78, 0.77, 0.76, 0.75, 0.77, 0.85, 0.97, 1.0, 0.98, 0.92, 0.80, 0.67];
  var i = Math.floor(hr) % 24, f = hr - Math.floor(hr), K = (BASE[i] * (1 - f) + BASE[(i + 1) % 24] * f) * 0.94 * (1 + 0.004 * Math.sin(now / 1500000));
  var s = Math.pow(0.5 * (1 + Math.cos(2 * Math.PI * (hr - 13.5) / 24)), 1.3), ta = 25.6 + 7 * s + 0.15 * Math.sin(now / 2400000), rh = Math.min(96, 60 + 28 * (1 - s));
  var on = S && S.ctrl && S.ctrl.on, eta = 0.68 + 0.04 * Math.sin(now / 900000), tin = on ? ta - eta * (ta - dtWB(ta, rh)) : ta + 0.4;
  var to = S && S.last ? S.last.to : 60;
  return [
    { topic: 'gisrgt/trf1/sensor/ambien', payload: { t: dtR(ta), rh: dtR(rh, 0) } },
    { topic: 'gisrgt/trf1/sensor/udara_in', payload: { t: dtR(tin), rh: dtR(on ? Math.min(95, rh + 12) : rh, 0) } },
    { topic: 'gisrgt/trf1/sensor/tangki', payload: { t: dtR(to - 3.2 + 0.2 * Math.sin(now / 11000)) } },
    { topic: 'gisrgt/trf1/kamera/beban_a', payload: { v: dtR(K * 1732, 0), conf: 0.95 } },
    { topic: 'gisrgt/trf1/mist/status', payload: { on: on ? 1 : 0, mode: 'edge' } },
    { topic: 'gisrgt/trf1/node/esp32-sensor', payload: { state: 'online', rssi: -61, ip: '192.168.10.21' } }
  ];
}
