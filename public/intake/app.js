/* StorageX gate app: records deliveries offline and uploads them later.
 * Written as plain ES5 (no let/const, arrow functions, classes, Promises, fetch or async) so it runs on old
 * Android browsers. Storage is IndexedDB; photos are kept as base64 text, which old browsers can store.
 * Each saved record is sealed with SHA-256 over its fields and photo hashes, and chained to the previous record
 * on this phone, so the server can tell if anything was changed or deleted before upload. */
(function () {
  'use strict';
  var VERSION = '3.0.0';
  var $app = document.getElementById('app');
  var state = { boot: null, device: null, warehouseId: null, records: [], online: navigator.onLine !== false, syncing: false, signedOut: false, msg: null, form: null, screen: 'home' };

  // ---------- small helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    attrs = attrs || {};
    for (k in attrs) {
      if (!attrs.hasOwnProperty(k) || attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
      if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'className') el.className = attrs[k];
      else if (k === 'value') el.value = attrs[k];
      else if (k === 'checked') el.checked = !!attrs[k];
      else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    kids = kids === undefined ? [] : [].concat(kids);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === null || kids[i] === undefined || kids[i] === false) continue;
      el.appendChild(typeof kids[i] === 'string' || typeof kids[i] === 'number' ? document.createTextNode(String(kids[i])) : kids[i]);
    }
    return el;
  }
  function nn(v) { return v === undefined ? null : v; }
  function num(v) { if (v === '' || v === null || v === undefined) return null; var n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; }
  function uuid() {
    var b = new Uint8Array(16), i, s = '';
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b); else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    for (i = 0; i < 16; i++) { s += (b[i] < 16 ? '0' : '') + b[i].toString(16); if (i === 3 || i === 5 || i === 7 || i === 9) s += '-'; }
    return s;
  }
  function fmtKg(n) { return (Math.round(n * 100) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' kg'; }
  function when(iso) { var d = new Date(iso); return d.toDateString().slice(4, 10) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  // ---------- SHA-256 (works where crypto.subtle does not) ----------
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(bytes) {
    var len = bytes.length, bitLenHi = Math.floor(len / 0x20000000), bitLenLo = (len * 8) >>> 0;
    var padded = new Uint8Array(((len + 9 + 63) >> 6) << 6), i, j;
    padded.set(bytes); padded[len] = 0x80;
    var pl = padded.length;
    padded[pl - 8] = (bitLenHi >>> 24) & 255; padded[pl - 7] = (bitLenHi >>> 16) & 255; padded[pl - 6] = (bitLenHi >>> 8) & 255; padded[pl - 5] = bitLenHi & 255;
    padded[pl - 4] = (bitLenLo >>> 24) & 255; padded[pl - 3] = (bitLenLo >>> 16) & 255; padded[pl - 2] = (bitLenLo >>> 8) & 255; padded[pl - 1] = bitLenLo & 255;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Array(64);
    for (i = 0; i < pl; i += 64) {
      for (j = 0; j < 16; j++) W[j] = (padded[i + j * 4] << 24) | (padded[i + j * 4 + 1] << 16) | (padded[i + j * 4 + 2] << 8) | padded[i + j * 4 + 3];
      for (j = 16; j < 64; j++) {
        var x = W[j - 15], y = W[j - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[j] = (W[j - 16] + s0 + W[j - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[j] + W[j]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
    }
    var out = '';
    for (i = 0; i < 8; i++) out += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
    return out;
  }
  function utf8(str) {
    var s = unescape(encodeURIComponent(str)), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  function b64bytes(b64) { var s = atob(b64), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  /* Same algorithm as canonical() in src/lib/intake.ts: sorted keys, no spaces. */
  function canonical(v) {
    var i, keys, out;
    if (Object.prototype.toString.call(v) === '[object Array]') { out = []; for (i = 0; i < v.length; i++) out.push(canonical(v[i])); return '[' + out.join(',') + ']'; }
    if (v && typeof v === 'object') { keys = Object.keys(v).sort(); out = []; for (i = 0; i < keys.length; i++) out.push(JSON.stringify(keys[i]) + ':' + canonical(v[keys[i]])); return '{' + out.join(',') + '}'; }
    return JSON.stringify(v === undefined ? null : v);
  }
  window.__sx = { sha256: sha256, canonical: canonical, utf8: utf8 };   // for tests

  // ---------- storage (IndexedDB) ----------
  var idb = null;
  function openDb(cb) {
    var ix = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB;
    if (!ix) return cb(new Error('This browser cannot store records offline. Use Chrome or another up-to-date browser.'));
    var req = ix.open('storagex-intake', 1);
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'sha' });
    };
    req.onsuccess = function () { idb = req.result; cb(null); };
    req.onerror = function () { cb(req.error || new Error('Storage could not be opened.')); };
  }
  function kvGet(key, cb) { var r = idb.transaction('kv', 'readonly').objectStore('kv').get(key); r.onsuccess = function () { cb(r.result); }; r.onerror = function () { cb(undefined); }; }
  function kvSet(key, val, cb) { var t = idb.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = function () { if (cb) cb(); }; }
  function allRecords(cb) {
    var out = [], r = idb.transaction('records', 'readonly').objectStore('records').openCursor();
    r.onsuccess = function () { var c = r.result; if (c) { out.push(c.value); c['continue'](); } else { out.sort(function (a, b) { return a.record.device_seq - b.record.device_seq; }); cb(out); } };
  }
  function getPhoto(sha, cb) { var r = idb.transaction('photos', 'readonly').objectStore('photos').get(sha); r.onsuccess = function () { cb(r.result); }; }

  // ---------- network (XMLHttpRequest works everywhere) ----------
  function xhr(method, url, body, cb, headers) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    x.setRequestHeader('Accept', 'application/json');
    if (state.boot && state.boot.csrf) x.setRequestHeader('X-CSRF-Token', state.boot.csrf);
    for (var k in headers || {}) x.setRequestHeader(k, headers[k]);
    x.timeout = 120000;
    x.onload = function () {
      var json = null, ct = x.getResponseHeader('Content-Type') || '';
      if (ct.indexOf('application/json') === 0) { try { json = JSON.parse(x.responseText); } catch (e) { json = null; } }
      // A redirect to the sign-in page comes back as HTML.
      if (!json) return cb({ status: x.status, signedOut: ct.indexOf('text/html') === 0 });
      cb({ status: x.status, json: json });
    };
    x.onerror = x.ontimeout = function () { cb({ status: 0 }); };
    x.send(body || null);
  }
  function postJson(url, obj, cb) { xhr('POST', url, JSON.stringify(obj), cb, { 'Content-Type': 'application/json' }); }

  function loadBoot(cb) {
    xhr('GET', '/api/intake/bootstrap', null, function (r) {
      if (r.status === 200 && r.json) {
        state.boot = r.json; state.signedOut = false;
        kvSet('boot', r.json);
        if (state.boot.user && state.device && !state.device.user) { state.device.user = state.boot.user.id; kvSet('device', state.device); }
      } else if (r.signedOut || r.status === 401 || r.status === 403) state.signedOut = true;
      if (cb) cb(r);
    });
  }

  // ---------- photos: shrink, fingerprint, store ----------
  function takePhoto(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1280, w = img.width, hh = img.height, scale = Math.min(1, max / Math.max(w, hh));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * scale); cv.height = Math.round(hh * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        var url = cv.toDataURL('image/jpeg', 0.72), b64 = url.split(',')[1], bytes = b64bytes(b64), sha = sha256(bytes);
        var t = idb.transaction('photos', 'readwrite');
        t.objectStore('photos').put({ sha: sha, b64: b64, mime: 'image/jpeg', size: bytes.length });
        t.oncomplete = function () { cb(null, { sha: sha, thumb: url }); };
        t.onerror = function () { cb(new Error('The phone is out of storage space.')); };
      };
      img.onerror = function () { cb(new Error('That file is not a photo.')); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- the delivery form ----------
  function newForm() {
    var f = { id: uuid(), started_at: new Date().toISOString(), farmer: null, commodity: '', weighings: [{ bags: '', gross_kg: '', photo: null, thumb: null }], tare: '', moisture: '', moisture_photo: null,
      moisture_thumb: null, fm: '', damaged: '', grade: '', stack: '', notes: '', bag_photos: [], conf: 'paper_slip', slip_photo: null, slip_thumb: null, token: null, codeSent: false, gps: null, gps_note: 'Getting location…', search: '' };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (p) { f.gps = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }; f.gps_note = null; if (state.form === f) render(); },
        function (e) { f.gps_note = e && e.code === 1 ? 'Location permission refused' : 'Location not available'; if (state.form === f) render(); }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 });
    } else f.gps_note = 'This phone cannot give a location';
    return f;
  }
  function totals(f) {
    var bags = 0, gross = 0, i;
    for (i = 0; i < f.weighings.length; i++) { bags += parseInt(f.weighings[i].bags, 10) || 0; gross += num(f.weighings[i].gross_kg) || 0; }
    var net = gross - bags * (num(f.tare) || 0);
    return { bags: bags, gross: Math.round(gross * 100) / 100, net: Math.round(net * 100) / 100 };
  }
  function problems(f) {
    var p = [], i;
    if (!f.farmer) p.push('Choose the farmer.');
    if (!f.commodity) p.push('Choose the crop.');
    for (i = 0; i < f.weighings.length; i++) {
      var w = f.weighings[i];
      if (!(parseInt(w.bags, 10) > 0) || String(parseInt(w.bags, 10)) !== String(w.bags).trim()) p.push('Weighing ' + (i + 1) + ': number of bags (whole number).');
      if (!(num(w.gross_kg) > 0)) p.push('Weighing ' + (i + 1) + ': the weight on the scale.');
      if (!w.photo) p.push('Weighing ' + (i + 1) + ': photo of the scale display.');
    }
    if (num(f.tare) === null || num(f.tare) < 0 || num(f.tare) > 5) p.push('Weight of one empty bag (0–5 kg).');
    if (num(f.moisture) === null || num(f.moisture) < 0 || num(f.moisture) > 60) p.push('Moisture %.');
    if (!f.moisture_photo) p.push('Photo of the moisture meter.');
    if (!f.bag_photos.length) p.push('At least one photo of the bags.');
    if (f.conf === 'paper_slip' && !f.slip_photo) p.push('Photo of the farmer’s signed or thumb-printed slip.');
    if (f.conf === 'code' && !f.token) p.push('Confirm the farmer’s code, or use the paper slip.');
    if (totals(f).net <= 0 && !p.length) p.push('Net weight must be more than zero.');
    return p;
  }
  function commodity(code) { var c = (state.boot && state.boot.commodities) || []; for (var i = 0; i < c.length; i++) if (c[i].code === code) return c[i]; return null; }
  function warehouse() { var w = (state.boot && state.boot.warehouses) || []; for (var i = 0; i < w.length; i++) if (w[i].id === state.warehouseId) return w[i]; return null; }

  /* Seal: build the record, hash it, chain it to the previous one, and store record + device state in one transaction. */
  function seal(f, cb) {
    var dev = state.device, i, weighings = [];
    for (i = 0; i < f.weighings.length; i++) weighings.push({ bags: parseInt(f.weighings[i].bags, 10), gross_kg: num(f.weighings[i].gross_kg), photo: f.weighings[i].photo });
    var rec = {
      v: 1, id: f.id, device_id: dev.id, device_seq: dev.seq + 1, prev_hash: nn(dev.last_hash), warehouse_id: state.warehouseId, farmer_code: f.farmer.code, commodity_code: f.commodity,
      weighings: weighings, tare_per_bag_kg: num(f.tare), moisture_pct: num(f.moisture), moisture_photo: f.moisture_photo, foreign_matter_pct: num(f.fm), damaged_pct: num(f.damaged),
      grade: f.grade || null, stack_ref: f.stack || null, notes: f.notes || null, bag_photos: f.bag_photos.map(function (b) { return b.sha; }),
      farmer_confirmation: f.conf, slip_photo: f.conf === 'paper_slip' ? f.slip_photo : null, confirm_token: f.conf === 'code' ? f.token : null,
      captured_at: new Date().toISOString(), started_at: f.started_at, gps: f.gps, gps_note: f.gps ? null : nn(f.gps_note), clerk_user_id: state.boot.user.id
    };
    rec.evidence_hash = sha256(utf8(canonical(rec)));
    var t = totals(f);
    var item = { id: rec.id, record: rec, status: 'saved', farmer: f.farmer.name, commodity: (commodity(f.commodity) || {}).name, net: t.net, bags: t.bags, warehouse: (warehouse() || {}).name };
    var newDev = { id: dev.id, seq: rec.device_seq, last_hash: rec.evidence_hash, user: dev.user };
    var tr = idb.transaction(['records', 'kv'], 'readwrite');
    tr.objectStore('records').put(item);
    tr.objectStore('kv').put(newDev, 'device');
    tr.oncomplete = function () { state.device = newDev; cb(null, item); };
    tr.onerror = function () { cb(new Error('Could not save on this phone: ' + (tr.error && tr.error.message))); };
  }

  // ---------- upload ----------
  function pending() { return state.records.filter(function (r) { return r.status === 'saved' || r.status === 'retry'; }); }
  function sync(done) {
    if (state.syncing || !navigator.onLine && navigator.onLine !== undefined) return done && done();
    var queue = pending();
    if (!queue.length) return done && done();
    state.syncing = true; render();
    loadBoot(function (b) {
      if (!b.json) { state.syncing = false; render(); return done && done(); }
      next(0);
    });
    function next(i) {
      if (i >= queue.length) { state.syncing = false; refresh(); return done && done(); }
      var item = queue[i], rec = item.record, shas = photosOf(rec), fd = new FormData(), k = 0;
      if (rec.clerk_user_id !== state.boot.user.id) { item.status = 'retry'; item.error = 'Saved by another person: they must sign in to upload it.'; save(item); return next(i + 1); }
      fd.append('_csrf', state.boot.csrf); fd.append('record', JSON.stringify(rec)); fd.append('device_clock', new Date().toISOString());
      (function addPhoto() {
        if (k >= shas.length) return send();
        getPhoto(shas[k], function (p) {
          if (!p) { item.status = 'error'; item.error = 'A photo is missing from this phone.'; save(item); return next(i + 1); }
          fd.append('p_' + p.sha, new Blob([b64bytes(p.b64)], { type: p.mime }), p.sha + '.jpg');
          k++; addPhoto();
        });
      })();
      function send() {
        xhr('POST', '/api/intake', fd, function (r) {
          if (r.status === 200 && r.json) {
            item.status = 'uploaded'; item.ref = r.json.ref; item.flags = r.json.flags || []; item.error = null; item.uploaded_at = new Date().toISOString();
            save(item, function () { dropPhotos(shas); });
            return next(i + 1);
          }
          if (r.signedOut) { state.signedOut = true; state.syncing = false; render(); return done && done(); }
          if (r.status === 0 || r.status >= 500) { item.status = 'retry'; item.error = 'No connection. Will try again.'; save(item); state.syncing = false; render(); return done && done(); }
          item.status = r.status === 409 ? 'error' : 'retry'; item.error = (r.json && r.json.error) || ('Upload refused (' + r.status + ')'); save(item);
          next(i + 1);
        });
      }
    }
  }
  function photosOf(rec) {
    var s = [], i;
    for (i = 0; i < rec.weighings.length; i++) if (rec.weighings[i].photo) s.push(rec.weighings[i].photo);
    if (rec.moisture_photo) s.push(rec.moisture_photo);
    for (i = 0; i < rec.bag_photos.length; i++) s.push(rec.bag_photos[i]);
    if (rec.slip_photo) s.push(rec.slip_photo);
    return s;
  }
  function dropPhotos(shas) { var t = idb.transaction('photos', 'readwrite'), st = t.objectStore('photos'); for (var i = 0; i < shas.length; i++) st['delete'](shas[i]); }
  function save(item, cb) { var t = idb.transaction('records', 'readwrite'); t.objectStore('records').put(item); t.oncomplete = function () { if (cb) cb(); }; }
  function refresh() { allRecords(function (rs) { state.records = rs; render(); }); }

  // ---------- screens ----------
  function render() {
    var top = h('header', { className: 'bar' }, [
      h('b', null, 'StorageX gate'),
      h('span', { className: 'dot ' + (state.online ? 'on' : 'off') }, state.online ? 'Online' : 'Offline'),
      state.boot && state.boot.user ? h('span', { className: 'who' }, state.boot.user.name) : null
    ]);
    var body;
    if (state.fatal) body = h('div', { className: 'card' }, [h('h2', null, 'This phone cannot run the app'), h('p', null, state.fatal)]);
    else if (!state.boot) body = h('div', { className: 'card' }, [h('h2', null, 'Sign in first'), h('p', null, 'Open this page once with a network connection and sign in. After that it works without network.'), h('a', { className: 'btn primary', href: '/login?next=/intake/' }, 'Sign in')]);
    else if (state.screen === 'form') body = formScreen();
    else body = homeScreen();
    $app.innerHTML = '';
    $app.appendChild(top);
    if (state.msg) $app.appendChild(h('p', { className: 'msg ' + state.msg.type }, state.msg.text));
    if (!('serviceWorker' in navigator) && state.boot) $app.appendChild(h('p', { className: 'msg info' }, 'This browser cannot reopen the app without network. Keep this page open while you work offline.'));
    $app.appendChild(body);
  }

  function homeScreen() {
    var b = state.boot, whs = b.warehouses, p = pending().length;
    var list = state.records.slice().reverse().slice(0, 50).map(function (r) {
      var label = { saved: 'Waiting to upload', retry: 'Will retry', uploaded: 'Uploaded', error: 'Problem' }[r.status];
      return h('li', { className: 'rec ' + r.status }, [
        h('div', null, [h('b', null, r.farmer), ' · ', r.commodity, ' · ', fmtKg(r.net), ' (' + r.bags + ' bags)']),
        h('small', null, [when(r.record.captured_at), ' · ', label, r.ref ? ' · ' + r.ref : '', r.error ? ' · ' + r.error : '']),
        r.flags && r.flags.length ? h('small', { className: 'flags' }, 'For review: ' + r.flags.map(function (f) { return f.code.replace(/_/g, ' '); }).join(', ')) : null
      ]);
    });
    return h('div', null, [
      state.signedOut ? h('p', { className: 'msg error' }, ['Your sign-in has expired. ', h('a', { href: '/login?next=/intake/' }, 'Sign in again'), ' to upload. Saved records are safe on this phone.']) : null,
      h('div', { className: 'card' }, [
        h('label', { className: 'field' }, [h('span', null, 'Warehouse'),
          h('select', { onchange: function (e) { state.warehouseId = e.target.value; kvSet('warehouse', state.warehouseId); render(); } },
            [h('option', { value: '' }, 'Choose…')].concat(whs.map(function (w) { var o = h('option', { value: w.id }, w.name); if (w.id === state.warehouseId) o.selected = true; return o; })))]),
        h('button', { className: 'btn primary big', disabled: !state.warehouseId, onclick: function () { state.form = newForm(); state.screen = 'form'; state.msg = null; render(); window.scrollTo(0, 0); } }, 'Record a delivery')
      ]),
      h('div', { className: 'card' }, [
        h('div', { className: 'row' }, [
          h('b', null, p ? p + ' waiting to upload' : 'All uploaded'),
          h('button', { className: 'btn', disabled: !p || state.syncing || !state.online, onclick: function () { sync(); } }, state.syncing ? 'Uploading…' : 'Upload now')
        ]),
        h('p', { className: 'small' }, 'Records upload by themselves when there is network and this page is open. Do not clear the browser’s data while anything is waiting.'),
        list.length ? h('ul', { className: 'recs' }, list) : h('p', { className: 'small' }, 'No deliveries on this phone yet.')
      ]),
      h('p', { className: 'small' }, ['Farmer list updated ', b.serverTime ? when(b.serverTime) : '—', ' · app ' + VERSION + ' · ', h('a', { href: '/app' }, 'Main site')])
    ]);
  }

  function photoInput(label, onPhoto, thumb) {
    return h('div', { className: 'photo' }, [
      h('label', { className: 'btn' }, [thumb ? 'Retake: ' + label : label,
        h('input', { type: 'file', accept: 'image/*', capture: 'environment', className: 'hidden', onchange: function (e) {
          var file = e.target.files && e.target.files[0]; if (!file) return;
          takePhoto(file, function (err, p) { if (err) { state.msg = { type: 'error', text: err.message }; render(); return; } onPhoto(p); render(); });
        } })]),
      thumb ? h('img', { src: thumb, alt: label, className: 'thumb' }) : null
    ]);
  }
  function input(label, value, oninput, o) {
    o = o || {};
    return h('label', { className: 'field' + (o.wide ? ' wide' : '') }, [h('span', null, label),
      // No full re-render while typing: it would drop the keyboard and swallow the next tap on old phones.
      h('input', { type: o.type || 'text', inputmode: o.mode || null, value: value, placeholder: o.ph || null, oninput: function (e) { oninput(e.target.value); live(); } }), o.hint ? h('small', null, o.hint) : null]);
  }

  /* Updates the running total and the moisture warning in place. */
  function live() {
    var f = state.form; if (!f) return;
    var t = totals(f), el = document.getElementById('total'), mw = document.getElementById('mwarn'), com = commodity(f.commodity);
    if (el) el.textContent = t.bags + ' bags · scale total ' + fmtKg(t.gross) + ' · net ' + fmtKg(t.net);
    if (mw) mw.textContent = com && com.max_moisture && num(f.moisture) > com.max_moisture ? 'Above the ' + com.max_moisture + '% limit for ' + com.name + '. It will be held for drying.' : '';
  }

  function formScreen() {
    var f = state.form, b = state.boot, com = commodity(f.commodity), t = totals(f), probs = problems(f);
    // Farmer picker: search the list stored on the phone.
    var farmerBlock;
    if (f.farmer) farmerBlock = h('div', { className: 'chosen' }, [h('b', null, f.farmer.name), ' ' + f.farmer.code + (f.farmer.community ? ' · ' + f.farmer.community : '') + ' ',
      f.farmer.level < 1 ? h('div', { className: 'warn' }, 'Identity not checked yet: the delivery can be recorded, but no receipt until it is.') : null,
      h('button', { className: 'link', onclick: function () { f.farmer = null; f.token = null; f.conf = 'paper_slip'; render(); } }, 'Change')]);
    else {
      var q = f.search.toLowerCase(), hits = [];
      if (q.length >= 2) for (var i = 0; i < b.farmers.length && hits.length < 15; i++) {
        var fa = b.farmers[i];
        if (fa.name.toLowerCase().indexOf(q) >= 0 || fa.code.toLowerCase().indexOf(q) >= 0 || (fa.community || '').toLowerCase().indexOf(q) >= 0 || (fa.phone4 && fa.phone4 === q)) hits.push(fa);
      }
      farmerBlock = h('div', null, [
        h('input', { type: 'search', value: f.search, placeholder: 'Type name, code, village or last 4 phone digits', oninput: function (e) { f.search = e.target.value; render(); var el = document.querySelector('input[type=search]'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } } }),
        h('ul', { className: 'hits' }, hits.map(function (fa) { return h('li', null, h('button', { className: 'hit', onclick: function () { f.farmer = fa; render(); } }, [h('b', null, fa.name), ' ' + fa.code + (fa.community ? ' · ' + fa.community : '')])); })),
        q.length >= 2 && !hits.length ? h('p', { className: 'small' }, 'Not found. New farmers are registered on the main site first, then refresh the list here when online.') : null
      ]);
    }
    var weigh = f.weighings.map(function (w, i) {
      return h('div', { className: 'weigh' }, [
        h('b', null, 'Weighing ' + (i + 1)),
        h('div', { className: 'grid2' }, [
          input('Bags on the scale', w.bags, function (v) { w.bags = v; }, { mode: 'numeric' }),
          input('Scale shows (kg)', w.gross_kg, function (v) { w.gross_kg = v; }, { mode: 'decimal' })
        ]),
        photoInput('Photo of scale display', function (p) { w.photo = p.sha; w.thumb = p.thumb; }, w.thumb),
        f.weighings.length > 1 ? h('button', { className: 'link danger', onclick: function () { f.weighings.splice(i, 1); render(); } }, 'Remove this weighing') : null
      ]);
    });
    var codeOk = state.online && f.farmer && f.farmer.phone_ok && (b.codes.sms || b.codes.voice);
    return h('div', null, [
      h('div', { className: 'card' }, [h('h2', null, '1. Farmer'), farmerBlock]),
      h('div', { className: 'card' }, [h('h2', null, '2. Crop'),
        h('select', { onchange: function (e) { f.commodity = e.target.value; render(); } }, [h('option', { value: '' }, 'Choose…')].concat(b.commodities.map(function (c) { var o = h('option', { value: c.code }, c.name); if (c.code === f.commodity) o.selected = true; return o; })))]),
      h('div', { className: 'card' }, [h('h2', null, '3. Weight'), h('p', { className: 'small' }, 'Type exactly what the scale display shows, then photograph the display so the number is readable.')].concat(weigh).concat([
        h('button', { className: 'btn', onclick: function () { f.weighings.push({ bags: '', gross_kg: '', photo: null, thumb: null }); render(); } }, '+ Another weighing'),
        input('Weight of one empty bag (kg)', f.tare, function (v) { f.tare = v; }, { mode: 'decimal', hint: 'Weigh one empty bag of the type used.' }),
        h('p', { className: 'total', id: 'total' }, t.bags + ' bags · scale total ' + fmtKg(t.gross) + ' · net ' + fmtKg(t.net))
      ])),
      h('div', { className: 'card' }, [h('h2', null, '4. Quality'),
        h('div', { className: 'grid2' }, [
          input('Moisture %', f.moisture, function (v) { f.moisture = v; }, { mode: 'decimal' }),
          input('Grade (optional)', f.grade, function (v) { f.grade = v; }),
          input('Foreign matter % (optional)', f.fm, function (v) { f.fm = v; }, { mode: 'decimal' }),
          input('Damaged % (optional)', f.damaged, function (v) { f.damaged = v; }, { mode: 'decimal' })
        ]),
        h('p', { className: 'warn', id: 'mwarn' }, com && com.max_moisture && num(f.moisture) > com.max_moisture ? 'Above the ' + com.max_moisture + '% limit for ' + com.name + '. It will be held for drying.' : ''),
        photoInput('Photo of moisture meter', function (p) { f.moisture_photo = p.sha; f.moisture_thumb = p.thumb; }, f.moisture_thumb)
      ]),
      h('div', { className: 'card' }, [h('h2', null, '5. Bags and stack'),
        h('div', { className: 'thumbs' }, f.bag_photos.map(function (p, i) { return h('div', null, [h('img', { src: p.thumb, className: 'thumb', alt: 'Bags' }), h('button', { className: 'link danger', onclick: function () { f.bag_photos.splice(i, 1); render(); } }, 'Remove')]); })),
        photoInput(f.bag_photos.length ? 'Add another photo of the bags' : 'Photo of the bags', function (p) { f.bag_photos.push(p); }, null),
        input('Stack or bay (optional)', f.stack, function (v) { f.stack = v; }),
        input('Notes (optional)', f.notes, function (v) { f.notes = v; }, { wide: true })
      ]),
      h('div', { className: 'card' }, [h('h2', null, '6. Farmer confirms'),
        h('label', { className: 'check' }, [h('input', { type: 'radio', name: 'conf', checked: f.conf === 'paper_slip', onchange: function () { f.conf = 'paper_slip'; render(); } }), ' Signed or thumb-printed slip (works offline)']),
        h('label', { className: 'check' }, [h('input', { type: 'radio', name: 'conf', disabled: !codeOk, checked: f.conf === 'code', onchange: function () { f.conf = 'code'; render(); } }), ' Code sent to the farmer’s phone' + (codeOk ? '' : ' (needs network and a confirmed phone)')]),
        f.conf === 'paper_slip' ? photoInput('Photo of the signed slip', function (p) { f.slip_photo = p.sha; f.slip_thumb = p.thumb; }, f.slip_thumb) : codeBlock(f)
      ]),
      h('div', { className: 'card' }, [
        h('p', { className: 'small' }, f.gps ? 'Location recorded (±' + f.gps.acc + ' m).' : (f.gps_note || '')),
        f.showProblems && probs.length ? h('ul', { className: 'todo', id: 'todo' }, probs.map(function (p) { return h('li', null, p); })) : h('p', null, 'Check the numbers once more. After saving, the record cannot be changed.'),
        h('button', { className: 'btn primary big', onclick: function () {
          var now = problems(f);
          if (now.length) { f.showProblems = true; render(); var el = document.getElementById('todo'); if (el && el.scrollIntoView) el.scrollIntoView(); return; }
          seal(f, function (err, item) {
            if (err) { state.msg = { type: 'error', text: err.message }; render(); return; }
            state.form = null; state.screen = 'home'; state.msg = { type: 'ok', text: 'Saved ' + item.farmer + ' · ' + fmtKg(item.net) + '. It will upload when there is network.' };
            refresh(); setTimeout(function () { sync(); }, 300); window.scrollTo(0, 0);
          });
        } }, 'Save delivery'),
        h('button', { className: 'link', onclick: function () { state.form = null; state.screen = 'home'; render(); } }, 'Cancel (nothing is saved)')
      ])
    ]);
  }

  function codeBlock(f) {
    var b = state.boot;
    if (f.token) return h('p', { className: 'ok' }, 'Confirmed by the farmer’s code.');
    function send(channel) {
      postJson('/api/intake/farmer-code', { farmer_code: f.farmer.code, channel: channel }, function (r) {
        if (r.status === 200) { f.codeSent = true; state.msg = { type: 'ok', text: channel === 'voice' ? 'Calling the farmer now.' : 'Code sent to the farmer.' }; }
        else state.msg = { type: 'error', text: (r.json && r.json.error) || 'Could not send the code. Use the paper slip.' };
        render();
      });
    }
    var otp = '';
    return h('div', null, [
      h('div', { className: 'row' }, [b.codes.sms ? h('button', { className: 'btn', onclick: function () { send('sms'); } }, 'Text a code') : null, b.codes.voice ? h('button', { className: 'btn', onclick: function () { send('voice'); } }, 'Call with a code') : null]),
      f.codeSent ? h('div', { className: 'row' }, [
        h('input', { inputmode: 'numeric', placeholder: '6-digit code', oninput: function (e) { otp = e.target.value; } }),
        h('button', { className: 'btn primary', onclick: function () {
          postJson('/api/intake/farmer-code/verify', { farmer_code: f.farmer.code, intake_id: f.id, otp: otp }, function (r) {
            if (r.status === 200 && r.json && r.json.token) { f.token = r.json.token; state.msg = null; }
            else state.msg = { type: 'error', text: (r.json && r.json.error) || 'Could not check the code.' };
            render();
          });
        } }, 'Confirm')
      ]) : null
    ]);
  }

  // ---------- start ----------
  window.addEventListener('online', function () { state.online = true; render(); sync(); });
  window.addEventListener('offline', function () { state.online = false; render(); });
  setInterval(function () { if (state.online && pending().length && !state.syncing && state.screen === 'home') sync(); }, 60000);

  openDb(function (err) {
    if (err) { state.fatal = err.message; return render(); }
    kvGet('device', function (dev) {
      state.device = dev || { id: uuid(), seq: 0, last_hash: null };
      if (!dev) kvSet('device', state.device);
      kvGet('boot', function (boot) {
        state.boot = boot || null;
        kvGet('warehouse', function (w) {
          state.warehouseId = w || null;
          refresh();
          if (state.online) loadBoot(function () { render(); sync(); });
        });
      });
    });
  });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/intake/sw.js', { scope: '/intake/' }); } catch (e) { /* older browsers: page works while open */ } }
})();
