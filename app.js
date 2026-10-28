// Workshop scanner. Reads passes with the phone camera (or a USB scanner gun) and reports each scan to the Apps Script web
// app named in the staff link. A scan made without a connection is kept on the phone with its scan time and sent when the
// connection returns. The other side is doPost in apps-script/Code.gs. Built 23 Oct 2026.
// One Sheet can run several workshops (28 Oct 2026): the phone asks which workshop it is scanning for, and every scan, walk-in
// and search carries that workshop's key. A pass for another workshop is shown as such and not counted.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ws.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ws.' + k, JSON.stringify(v)); } catch (e) { /* private mode: work without saving */ } },
    drop(k) { try { localStorage.removeItem('ws.' + k); } catch (e) { /* nothing saved */ } }
  };
  const S = { api: store.get('api', ''), key: store.get('key', ''), phone: store.get('phone', ''), mode: 'ENTRY', once: false,
    workshop: store.get('workshop', ''), workshops: store.get('workshops', []), guests: store.get('guests', {}), title: store.get('title', ''),
    when: store.get('when', ''), queue: store.get('queue', []), lastRead: {}, detector: null, busy: false };

  // The staff link is <page>#api=<web app URL>&key=<staff key>. The phone keeps both, and the key leaves the address bar,
  // so it is not on screen while the phone is passed around. Only a Google Apps Script web app address is accepted, so a
  // forged link cannot send scans (or a walk-in's name and email) anywhere else; a phone already set up for another address
  // asks before switching, and scans waiting on the phone are only ever sent to the address they were made for.
  // The link may also name one workshop (&w=W03), which the phone then opens straight away.
  const API_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/, KEY_RE = /^[0-9a-f]{32}$/, WS_RE = /^[A-Za-z0-9]{1,12}$/;
  const link = new URLSearchParams(location.hash.slice(1)), newApi = link.get('api') || '', newKey = link.get('key') || '', newWs = link.get('w') || '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (newApi || newKey) {
    if (!API_RE.test(newApi) || !KEY_RE.test(newKey)) S.badLink = true;
    else if (!S.api || newApi === S.api) { if (newKey !== S.key) adopt(newApi, newKey); }
    else S.switchTo = { api: newApi, key: newKey };                   // another Sheet: confirm first (see start)
  }
  if (!S.badLink && WS_RE.test(newWs) && (!S.switchTo || newApi === S.api)) setWorkshop(newWs);
  function adopt(api, key) {
    if (api !== S.api) { setWorkshop(''); S.workshops = []; store.drop('workshops'); }
    S.api = api; S.key = key; store.set('api', api); store.set('key', key);
  }
  // A new workshop starts with an empty guest list, filled by the next hello.
  function setWorkshop(key) {
    if (key === S.workshop) return;
    S.workshop = key; S.guests = {}; S.title = ''; S.when = '';
    store.set('workshop', key); ['guests', 'title', 'when'].forEach(k => store.drop(k));
  }
  function showTitle() {
    $('title').textContent = S.title || (S.workshop ? 'Workshop ' + S.workshop : 'Workshop scanner');
    $('when').textContent = S.when;
  }

  // ---- pass codes: the same rule as normalizeCode in apps-script/Logic.gs (O reads as 0, I and L as 1)
  function normalizeCode(text) {
    const t = String(text || '').toUpperCase().replace(/[\s-]+/g, '');
    const m = /^AAU([0-9A-Z]{8})$/.exec(t);
    if (!m) return '';
    const c = m[1].replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(c) ? 'AAU-' + c.slice(0, 4) + '-' + c.slice(4) : '';
  }
  async function sha(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const hm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // ---- what the staff member sees and hears
  function show(kind, name, line, actions) {
    $('result').className = 'result ' + kind;
    $('r-name').textContent = name;
    $('r-line').textContent = line;
    const box = $('r-actions');
    box.textContent = '';
    (actions || []).forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
      box.appendChild(b);
    });
  }
  const MODE_LINE = { ENTRY: 'Entry mode: a scan checks the person in.', EXIT: 'Exit mode: a scan checks the person out.',
    SWEEP: 'Seat check: scan passes at the seats after minute 30.' };
  function idle() { show('idle', 'Point the camera at a pass', S.once ? 'The next scan checks the person out.' : MODE_LINE[S.mode]); }
  let audio = null;
  function beep(kind) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const tones = { in: [[880, 0.12]], out: [[660, 0.1], [880, 0.12]], warn: [[440, 0.1], [440, 0.1]], error: [[220, 0.3]] }[kind] || [];
      let t = audio.currentTime;
      tones.forEach(([f, d]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f; g.gain.value = 0.15; o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + d); t += d + 0.05;
      });
      if (navigator.vibrate) navigator.vibrate(kind === 'error' ? [200, 80, 200] : kind === 'warn' ? [80, 60, 80] : 60);
    } catch (e) { /* this phone has no sound for web pages */ }
  }
  // iPhones only allow sound after a tap, so the first tap anywhere prepares it
  document.addEventListener('pointerdown', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* no sound */ } }, { once: true });
  function counts(c) { if (!c) return; $('c-inside').textContent = c.inside; $('c-in').textContent = c.checkedIn; $('c-cert').textContent = c.certificates; }
  function block(title, text) { $('blocker-title').textContent = title; $('blocker-text').textContent = text; $('blocker').hidden = false; }
  const mine = () => S.queue.filter(x => x.api === S.api);
  function syncLine() {
    const n = mine().length, held = S.queue.length - n;
    $('sync').textContent = (n ? n + (n === 1 ? ' scan' : ' scans') + ' waiting to send' : (navigator.onLine ? 'All scans sent' : 'Offline')) +
      (held ? '. ' + held + ' held for an earlier workshop link' : '');
  }

  // ---- talking to the web app (JSON sent as text/plain, so no preflight; Apps Script answers through a redirect)
  async function post(body) {
    const r = await fetch(S.api, { method: 'POST', body: JSON.stringify(Object.assign({ key: S.key }, body)), credentials: 'omit', redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function queueItem(item) { S.queue.push(Object.assign({ api: S.api }, item)); store.set('queue', S.queue); syncLine(); }
  async function send(item, name) {
    show('pending', name || 'Checking the pass', 'Sending to the Sheet.');
    let res;
    try { res = await post(item); }
    catch (e) {
      queueItem(item);
      show('queued', name || 'Saved on this phone', 'No connection. The scan is kept with its time and sent when the connection returns.');
      beep('warn');
      return;
    }
    handle(res, item, name);
  }
  function handle(res, item, name) {
    if (!res.ok) return problem(res);
    counts(res.counts);
    const who = res.name || name || 'Pass found', since = res.since ? hm(res.since) : '';
    const again = extra => () => send(Object.assign({}, item, { scanId: uuid(), at: Date.now() }, extra), who);
    switch (res.effect) {
      case 'IN': show('in', who, 'Checked in at ' + hm(item.at) + '.'); beep('in'); break;
      case 'ALREADY_IN': show('pending', who, 'Already inside' + (since ? ' since ' + since : '') + '. Nothing changed.'); beep('warn'); break;
      case 'OUT':
        show('out', who, res.minutes + (res.minutes === 1 ? ' minute' : ' minutes') + ' counted. ' + (res.status === 'ELIGIBLE' ? 'The certificate is on its way by email.'
          : res.status === 'BORDERLINE' ? 'Borderline: the organiser decides.' : 'Under the minimum, so no certificate.'));
        beep('out'); break;
      case 'EXIT_TOO_SOON': show('warn', who, 'Checked in at ' + since + '. Check them out already?', [['Yes, check out', again({ confirmed: true })]]); beep('warn'); break;
      case 'NOT_IN': show('warn', who, 'Not checked in, so there is nothing to check out.', [['Check in now', again({ mode: 'ENTRY' })]]); beep('warn'); break;
      case 'SEEN': show('in', who, 'Seen at the seat check.'); beep('in'); break;
      case 'SEEN_NOT_IN': show('warn', who, 'Seen at a seat, but never checked in at the door.', [['Check in now', again({ mode: 'ENTRY' })]]); beep('warn'); break;
      case 'OTHER_WORKSHOP':
        show('warn', who, 'This pass is for ' + res.other.title + ', ' + res.other.day + ' at ' + res.other.start + '. Not counted here.');
        beep('warn'); break;
      case 'REPEAT': break;
      case 'UNKNOWN': show('error', 'Pass not found', 'This code is not registered for any workshop.'); beep('error'); break;
      default: show('pending', who, 'Saved.');
    }
  }
  function problem(res) {
    if (res.error === 'key') return block('This scanner link no longer works', 'Ask the organiser for the new link. It is in the Sheet under Workshop > Open scanner.');
    if (res.error === 'closed') {
      S.guests = {}; store.drop('guests');
      return pick('That workshop is closed, and its guest list was removed from this phone. Choose another workshop.');
    }
    if (res.error === 'workshop') return pick('Choose the workshop this phone is scanning for.');
    show('error', 'Not saved', 'The Sheet answered: ' + (res.detail || res.error) + '. Scan again.');
    beep('error');
  }
  async function flush() {
    if (!mine().length || S.flushing) return;
    S.flushing = true;
    try {
      for (let next = mine()[0]; next; next = mine()[0]) {
        const body = Object.assign({}, next);
        delete body.api;
        let res;
        try { res = await post(body); } catch (e) { break; }                     // still offline: try again later
        S.queue.splice(S.queue.indexOf(next), 1); store.set('queue', S.queue);
        if (res && res.counts) counts(res.counts);
        if (res && !res.ok && (res.error === 'key' || res.error === 'closed')) { problem(res); break; }
      }
    } finally { S.flushing = false; syncLine(); }
  }
  // The list of workshops, and for the chosen one its details, guest list and counts.
  async function hello() {
    try {
      const res = await post({ action: 'hello', workshop: S.workshop });
      if (!res.ok) return problem(res);
      S.workshops = res.workshops || [];
      store.set('workshops', S.workshops);
      if (!res.workshop) return pick(S.workshop ? 'Workshop ' + S.workshop + ' is not in the list any more. Choose another one.' : '');
      if (res.closed) return problem({ error: 'closed' });
      S.guests = {};
      res.guests.forEach(([h, n]) => { S.guests[h] = n; });
      S.title = res.title;
      S.when = res.day + ', ' + res.start + ' to ' + res.end + (res.venue ? ', ' + res.venue : '') + (res.rehearsal ? ' (rehearsal on)' : '');
      store.set('guests', S.guests); store.set('title', S.title); store.set('when', S.when);
      showTitle();
      counts(res.counts);
    } catch (e) { /* offline: the list saved on this phone is used */ }
  }
  // every half minute the phone reports how many scans it still holds, so Close can name a phone that is behind
  function heartbeat() {
    if (!S.workshop) return;
    post({ action: 'stats', phone: S.phone, pending: S.queue.length, workshop: S.workshop }).then(r => r && r.ok ? counts(r.counts) : r && problem(r)).catch(() => {});
  }

  // ---- choosing the workshop: today's first, then the ones still to come, then the ones that have ended
  function pick(note) {
    const d = $('pick');
    $('pick-note').hidden = !note;
    $('pick-note').textContent = note || '';
    $('pick-cancel').hidden = !S.workshop;
    renderPick();
    if (!d.open) d.showModal();
  }
  function renderPick() {
    const list = $('pick-list'), now = Date.now(), today = new Date().toDateString();
    list.textContent = '';
    const order = w => (w.endAt < now ? 2 : new Date(w.at).toDateString() === today ? 0 : 1);
    const ws = S.workshops.slice().sort((a, b) => order(a) - order(b) || a.at - b.at);
    if (!ws.length) {
      const li = document.createElement('li'); li.className = 'hint';
      li.textContent = navigator.onLine ? 'No workshops are linked in the Sheet yet.' : 'Offline. The list appears when the phone is connected.';
      list.appendChild(li);
    }
    ws.forEach(w => {
      const li = document.createElement('li'), b = document.createElement('button'), t = document.createElement('span'), m = document.createElement('span');
      b.type = 'button'; b.className = 'pick' + (w.key === S.workshop ? ' current' : '');
      t.className = 'p-title'; t.textContent = w.title;
      m.className = 'p-when';
      m.textContent = w.day + ', ' + w.start + ' to ' + w.end + (w.venue ? ', ' + w.venue : '') +
        (w.closed ? '. Closed' : w.endAt < now ? '. Ended' : '');
      b.disabled = !!w.closed;
      b.append(t, m);
      b.addEventListener('click', () => { setWorkshop(w.key); $('pick').close(); showTitle(); counts({ inside: 0, checkedIn: 0, certificates: 0 }); idle(); hello(); });
      li.appendChild(b); list.appendChild(li);
    });
  }
  $('change-ws').addEventListener('click', () => pick(''));
  $('pick-cancel').addEventListener('click', () => $('pick').close());
  // the list cannot be dismissed with Escape before a workshop is chosen
  $('pick').addEventListener('cancel', e => { if (!S.workshop) e.preventDefault(); });

  // ---- a scan, from the camera, a scanner gun or a name picked by hand
  async function onCode(raw) {
    const code = normalizeCode(raw), now = Date.now();
    if (!code) {
      if (!S.lastRead[raw] || now - S.lastRead[raw] > 3000) { S.lastRead[raw] = now; show('error', 'Not a workshop pass', 'This QR code is not an AAU workshop pass.'); beep('error'); }
      return;
    }
    if (S.lastRead[code] && now - S.lastRead[code] < 10000) return;   // the camera reads the same pass many times a second
    S.lastRead[code] = now;
    if (!S.workshop) return pick('Choose the workshop this phone is scanning for, then scan again.');
    const mode = S.once ? 'EXIT' : S.mode;
    setOnce(false);
    const name = S.guests[(await sha(code)).slice(0, 16)] || '';
    send({ action: 'scan', scanId: uuid(), code: code, mode: mode, at: now, phone: S.phone, workshop: S.workshop }, name);
  }

  // ---- modes
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
    S.mode = b.dataset.mode;
    document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    setOnce(false); idle();
  }));
  function setOnce(v) { S.once = v; $('next-exit').setAttribute('aria-pressed', String(v)); $('next-exit').textContent = v ? 'Exit is on' : 'Next scan: Exit'; }
  $('next-exit').addEventListener('click', () => { setOnce(!S.once); idle(); });

  // ---- camera: the phone's own barcode reader where there is one (Chrome on Android), else the bundled zxing reader
  async function makeDetector() {
    if ('BarcodeDetector' in window) {
      try { if ((await window.BarcodeDetector.getSupportedFormats()).indexOf('qr_code') >= 0) return new window.BarcodeDetector({ formats: ['qr_code'] }); }
      catch (e) { /* use the bundled reader */ }
    }
    BarcodeDetectionAPI.setZXingModuleOverrides({ locateFile: (path, prefix) => path.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', location.href).href : prefix + path });
    return new BarcodeDetectionAPI.BarcodeDetector({ formats: ['qr_code'] });
  }
  async function camera() {
    const note = $('camera-note');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { note.hidden = false; note.textContent = 'This browser cannot use the camera. Use Find a name, or a scanner gun.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $('video');
      v.srcObject = stream; await v.play();
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        let on = false;
        $('torch').hidden = false;
        $('torch').onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }); $('torch').textContent = on ? 'Torch off' : 'Torch'; };
      }
      S.detector = await makeDetector();
      loop();
    } catch (e) {
      note.hidden = false;
      note.textContent = e && e.name === 'NotAllowedError' ? 'The camera is blocked. Allow the camera for this page in the browser settings, then reload.'
        : 'The camera could not start (' + (e && e.message || e) + '). Use Find a name, or a scanner gun.';
    }
  }
  function loop() {
    setTimeout(async () => {
      const v = $('video');
      if (!S.busy && v.readyState >= 2 && !document.hidden && !document.querySelector('dialog[open]') && $('blocker').hidden) {
        S.busy = true;
        try { const found = await S.detector.detect(v); if (found.length) await onCode(found[0].rawValue); } catch (e) { /* this frame failed; the next one is read */ }
        S.busy = false;
      }
      loop();
    }, 150);
  }

  // ---- a USB or Bluetooth scanner gun types the code fast and ends with Enter
  let typed = '', lastKey = 0;
  document.addEventListener('keydown', e => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const now = Date.now();
    if (now - lastKey > 80) typed = '';
    lastKey = now;
    if (e.key === 'Enter') { if (typed.length >= 11) onCode(typed); typed = ''; }
    else if (e.key.length === 1) typed += e.key;
  });

  // ---- find a name (works offline: the guest list is on the phone; the pick sends the hashed code)
  const fold = s => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  function renderFind(q) {
    const list = $('find-list'), f = fold(q.trim());
    list.textContent = '';
    const note = text => { const li = document.createElement('li'); li.className = 'hint'; li.textContent = text; list.appendChild(li); };
    if (f.length < 2) return note('Type at least 2 letters of the name.');
    Object.keys(S.guests).filter(h => fold(S.guests[h]).indexOf(f) >= 0).slice(0, 8).forEach(hash => {
      const li = document.createElement('li'), who = document.createElement('div'), row = document.createElement('div');
      who.className = 'who'; who.textContent = S.guests[hash]; row.className = 'row';
      [['Check in', 'ENTRY'], ['Check out', 'EXIT']].forEach(([label, mode]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.onclick = () => { $('find').close(); send({ action: 'scan', scanId: uuid(), hash: hash, mode: mode, manual: true, at: Date.now(), phone: S.phone, workshop: S.workshop }, S.guests[hash]); };
        row.appendChild(b);
      });
      li.appendChild(who); li.appendChild(row); list.appendChild(li);
    });
    if (!list.children.length) note('No match. For someone who did not register, use Add walk-in.');
  }
  $('open-find').addEventListener('click', () => { $('find-q').value = ''; renderFind(''); $('find').showModal(); $('find-q').focus(); });
  $('find-q').addEventListener('input', e => renderFind(e.target.value));

  // ---- walk-ins
  $('open-walkin').addEventListener('click', () => { $('walkin-form').reset(); $('w-error').hidden = true; $('walkin').showModal(); $('w-name').focus(); });
  $('w-cancel').addEventListener('click', () => $('walkin').close());
  $('walkin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const item = { action: 'walkin', scanId: uuid(), name: $('w-name').value.trim(), email: $('w-email').value.trim(), at: Date.now(), phone: S.phone, workshop: S.workshop };
    let res;
    try { res = await post(item); }
    catch (err) { queueItem(item); $('walkin').close(); show('queued', item.name, 'No connection. Saved on this phone with the time; they are checked in when it is sent.'); return; }
    if (!res.ok && res.error === 'refused') { $('w-error').hidden = false; $('w-error').textContent = res.why; return; }
    $('walkin').close();
    handle(res, item, item.name);
  });

  // ---- this phone's name, the screen kept awake, start-up
  $('phone-form').addEventListener('submit', e => {
    e.preventDefault();
    S.phone = $('phone-name').value.trim() || 'Phone';
    store.set('phone', S.phone);
    $('phone-label').textContent = 'This phone: ' + S.phone;
    $('name-phone').close();
    if (!S.workshop) pick('');
    heartbeat();
  });
  async function wake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { /* allowed again after the next tap */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); flush(); } });

  function start() {
    if (S.badLink) return block('This is not a valid scanner link', 'Open the scanner from the QR code the organiser shows in the Sheet, under Workshop > Open scanner.');
    if (S.switchTo) {
      $('switch-text').textContent = 'This phone is set up for another scanner link. Use the new link? ' +
        (S.queue.length ? 'Scans still waiting for the current link stay on this phone and are not sent to the new one.' : '');
      $('switch').showModal();
      $('switch-yes').onclick = () => { adopt(S.switchTo.api, S.switchTo.key); S.switchTo = null; if (WS_RE.test(newWs)) setWorkshop(newWs); $('switch').close(); start(); };
      $('switch-no').onclick = () => { S.switchTo = null; $('switch').close(); start(); };
      return;
    }
    if (!S.api || !S.key) return block('Open the scanner from the staff link', 'The organiser shows it as a QR code in the Sheet, under Workshop > Open scanner.');
    if (S.started) return;
    S.started = true;
    showTitle();
    $('phone-label').textContent = S.phone ? 'This phone: ' + S.phone : '';
    if (!S.phone) $('name-phone').showModal();
    else if (!S.workshop) pick('');
    idle(); syncLine(); hello(); camera(); wake(); flush();
    setInterval(flush, 5000); setInterval(heartbeat, 30000); setInterval(hello, 120000);
    window.addEventListener('online', () => { flush(); syncLine(); });
    window.addEventListener('offline', syncLine);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
