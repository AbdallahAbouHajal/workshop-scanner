// Workshop scanner. Reads passes with the phone camera (or a USB scanner gun) and reports each scan to the Apps Script web
// app named in the staff link. The other side is doPost in apps-script/Code.gs. Built 23 Oct 2026.
// One Sheet can run several workshops (28 Oct 2026): the phone asks which workshop it is scanning for. A pass for another
// workshop is shown as such and not counted, except an exit of someone still inside their own workshop (a shared door).
// 3 Nov 2026: every scan is saved on the phone first and sent in batches by queue.js, until the Sheet has answered for it;
// Entrance and Exit only (seat check removed); visits are numbered ("Entrance 2"); each phone has a device ID.
// 5 Nov 2026: a phone can read two Sheets, its campus visitors' Sheet and the graduates' Sheet (route.js says which Sheet each
// scan goes to); each Sheet has its own queue on the phone, and the counts on screen are both Sheets added up.
(() => {
  'use strict';
  const BUILD = 9;                       // also in sw.js (cache name) and in index.html (?v=9); the server asks older pages to reload
  const $ = id => document.getElementById(id);
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };   // a missing element never stops the page
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ws.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ws.' + k, JSON.stringify(v)); } catch (e) { /* private mode: work without saving */ } },
    drop(k) { try { localStorage.removeItem('ws.' + k); } catch (e) { /* nothing saved */ } }
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const S = { api: store.get('api', ''), key: store.get('key', ''), api2: store.get('api2', ''), key2: store.get('key2', ''),
    ws2: store.get('ws2', []), has1: true, counts1: null, counts2: null, phone: store.get('phone', ''), device: store.get('device', ''),
    mode: store.get('mode', 'ENTRY') === 'EXIT' ? 'EXIT' : 'ENTRY', workshop: store.get('workshop', ''), workshops: store.get('workshops', []),
    guests: store.get('guests', {}), title: store.get('title', ''), when: store.get('when', ''), info: store.get('info', null),
    lastRead: {}, detector: null, busy: false, recent: [], update: false, counts: null };
  if (!S.device) { S.device = uuid(); store.set('device', S.device); }
  // a phone that ran the one-workshop version still holds that workshop's title and guest list: they belong to no workshop now
  if (!S.workshop) { S.guests = {}; S.title = ''; S.when = ''; S.info = null; }

  // The staff link is <page>#api=<web app URL>&key=<staff key>. The phone keeps both, and the key leaves the address bar,
  // so it is not on screen while the phone is passed around. Only a Google Apps Script web app address is accepted, so a
  // forged link cannot send scans (or a walk-in's name and email) anywhere else; a phone already set up for another address
  // asks before switching, and scans waiting on the phone are only ever sent to the address they were made for.
  // A link made for one workshop (&w=W03) opens it straight away, after asking if the phone is set to another workshop.
  // The link may also name a second Sheet (&api2=…&key2=…), the graduates' Sheet; the link always sets both.
  const WS_RE = ScanRoute.WS_RE, L = ScanRoute.parseLink(location.hash), newApi = L.api, newKey = L.key, newWs = L.w;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (L.given) {
    if (L.bad) S.badLink = true;
    else if (!S.api) adopt(newApi, newKey, L.api2, L.key2);           // a new phone
    else if (newApi === S.api && L.api2 === S.api2) { if (newKey !== S.key || L.key2 !== S.key2) adopt(newApi, newKey, L.api2, L.key2); }   // new keys only
    else S.switchTo = { api: newApi, key: newKey, api2: L.api2, key2: L.key2 };   // another Sheet, or a second Sheet added, changed or removed: confirm first
  }
  if (!S.badLink && newWs && (!S.switchTo || newApi === S.api)) {
    if (!S.workshop || S.workshop === newWs) setWorkshop(newWs); else S.askWorkshop = newWs;
  }
  function adopt(api, key, api2, key2) {
    if (api !== S.api) { setWorkshop(''); S.workshops = []; store.drop('workshops'); }
    S.api = api; S.key = key; store.set('api', api); store.set('key', key);
    S.api2 = api2 || ''; S.key2 = key2 || ''; store.set('api2', S.api2); store.set('key2', S.key2);
    if (!S.api2) { S.ws2 = []; store.drop('ws2'); }
  }
  // A new workshop starts with an empty guest list, filled by the next hello, and in Entrance mode.
  function setWorkshop(key) {
    if (key === S.workshop) return;
    S.workshop = key; S.guests = {}; S.title = ''; S.when = ''; S.info = null;
    store.set('workshop', key); ['guests', 'title', 'when', 'info'].forEach(k => store.drop(k));
    setMode('ENTRY');
  }
  function showTitle() {
    $('title').textContent = S.title || (S.workshop ? 'Workshop ' + S.workshop : 'Workshop scanner');
    $('when').textContent = S.when;
    banner();
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
  const hm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // ---- what the staff member sees and hears
  function show(kind, name, line, actions) {
    $('result').className = 'result ' + kind;
    $('r-name').textContent = name;
    $('r-line').textContent = line;
    buttons($('r-actions'), actions);
  }
  function buttons(box, actions) {
    box.textContent = '';
    (actions || []).forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
      box.appendChild(b);
    });
  }
  const MODE_LINE = { ENTRY: 'Entrance: a scan checks the person in.', EXIT: 'Exit: a scan checks the person out.' };
  function idle() { show('idle', 'Point the camera at a pass', MODE_LINE[S.mode]); }
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
  // c: the counts one Sheet sent (n: 1 the campus Sheet, 2 the graduates' Sheet); the screen shows both added up
  function counts(c, n) {
    if (!c) return;
    if (n === 2) S.counts2 = c; else S.counts1 = c;
    c = ScanRoute.sumCounts(S.counts1, S.counts2);
    S.counts = c;
    $('c-inside').textContent = c.inside; $('c-in').textContent = c.checkedIn; $('c-cert').textContent = c.certificates;
  }
  function block(title, text) { $('blocker-title').textContent = title; $('blocker-text').textContent = text; $('blocker').hidden = false; }

  // ---- talking to the web app (JSON sent as text/plain, so no preflight; Apps Script answers through a redirect). A request
  // with no answer after 40 seconds is given up and tried again (the Sheet waits at most 20 seconds for its lock).
  async function post(body, n) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), 40000) : null;
    try {
      const r = await fetch(n === 2 ? S.api2 : S.api, { method: 'POST', credentials: 'omit', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify(Object.assign({ key: n === 2 ? S.key2 : S.key, build: BUILD, device: S.device, phone: S.phone, sentAt: Date.now() }, body)) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = await r.json();
      if (res && res.update) { S.update = true; updateBar(); }
      return res;
    } finally { if (t) clearTimeout(t); }
  }
  // what one queued item is sent as: a walk-in on its own; scans together; one at a time to a server from before 3 Nov 2026
  async function sendBatch(batch, n) {
    if (batch[0].action === 'walkin') {
      const x = batch[0], res = await post(strip(x), n);
      if (res && res.ok === false && (res.error === 'key' || res.error === 'refused' || res.error === 'closed' || res.error === 'workshop')) {
        return res.error === 'key' ? res : { ok: true, results: [{ scanId: x.scanId, effect: res.error === 'refused' ? 'REFUSED' : 'CLOSED', why: res.why || '' }] };
      }
      if (!res || !res.ok) return res;
      return { ok: true, counts: res.counts, results: [Object.assign({ scanId: x.scanId }, res)] };
    }
    const res = await post({ action: 'scans', workshop: S.workshop, items: batch.map(strip) }, n);
    if (res && res.ok === false && res.error === 'unknown action') {          // the server was rolled back: the old one-scan request
      const results = [];
      for (const x of batch) {
        const one = await post(Object.assign({ action: 'scan' }, strip(x)), n);
        results.push(one.ok ? Object.assign({ scanId: x.scanId }, one) : { scanId: x.scanId, effect: one.error === 'closed' ? 'CLOSED' : one.error === 'key' ? 'RETRY' : 'ERROR' });
        if (one.counts) counts(one.counts, n);
      }
      return { ok: true, results: results };
    }
    if (res && res.counts) counts(res.counts, n);
    return res;
  }
  const strip = x => { const o = Object.assign({}, x); delete o.api; delete o.name; delete o.errors; delete o.to; delete o.auto; return Object.assign(o, x.action === 'walkin' ? { name: x.name } : {}); };

  // ---- the queues: every scan is saved first, one queue per Sheet; scans for an earlier staff link stay on the phone and are
  // never sent elsewhere
  const apis = () => [S.api, S.api2].filter(Boolean);
  const held = () => ScanRoute.heldBack(store.get('queue', []), apis());
  function makeQueue(n) {
    const mine = () => (n === 2 ? S.api2 : S.api), isMine = x => x && (x.api ? x.api === mine() : mine() === S.api);
    const q = ScanQueue.create({
      load: () => ScanRoute.forSheet(store.get('queue', []), mine(), S.api),
      save: items => store.set('queue', store.get('queue', []).filter(x => !isMine(x)).concat(items.map(x => Object.assign({}, x, { api: mine() })))),
      send: batch => sendBatch(batch, n),
      onResult: (item, r) => answered(item, r),
      onState: () => syncLine()
    });
    q.onBlocked = () => problem({ error: 'key' }, n);
    return q;
  }
  let Q1 = null, Q2 = null;              // set just below; a queue reports its state while it is being made
  // defined before the queues are made: making the second queue already reports the totals (syncLine)
  const queues = () => [Q1, Q2].filter(Boolean);
  const qsize = () => queues().reduce((a, q) => a + q.size(), 0);
  const qlist = () => queues().reduce((a, q) => a.concat(q.list()), []);
  const kickAll = () => queues().forEach(q => q.kick());
  Q1 = makeQueue(1);
  if (S.api2) Q2 = makeQueue(2);
  function syncLine() {
    const n = Q1 ? qsize() : 0, h = held().length, el = $('sync'), list = Q1 ? qlist() : [];
    const oldest = list.length ? Math.min.apply(null, list.map(x => x.at || Date.now())) : null;
    if (!el) return;
    el.textContent = (n ? n + (n === 1 ? ' scan' : ' scans') + ' waiting to send' + (oldest && Date.now() - oldest > 60000 ? ', the oldest from ' + hm(oldest) : '')
      : navigator.onLine ? 'All scans sent' : 'Offline') + (h ? '. ' + h + ' held for an earlier scanner link' : '');
    el.className = n ? 'waiting' : '';
    updateBar();
  }

  // ---- a scan: saved, shown and heard at once; the Sheet's answer follows (answered)
  function record(item, name) {
    item.scanId = item.scanId || uuid();
    if (!item.to) {
      const t = item.action === 'walkin' ? { to: 1, auto: false } : ScanRoute.target(item.hash, S.guests);
      item.to = t.to; item.auto = t.auto;
    }
    if (item.to === 1 && !S.has1 && Q2 && item.action !== 'walkin') { item.to = 2; item.auto = false; }   // only the graduates' Sheet has this workshop
    if (item.to === 2 && !Q2) item.to = 1;
    (item.to === 2 ? Q2 : Q1).add(item);
    const entry = { id: item.scanId, at: item.at, name: name || 'Pass', mode: item.mode, line: 'Saving', kind: 'pending', item: item, actions: [] };
    S.recent.unshift(entry); S.recent = S.recent.slice(0, 8);
    if (item.mode === 'ENTRY' || item.mode === 'EXIT') {
      show(item.mode === 'ENTRY' ? 'in' : 'out', entry.name, (item.mode === 'ENTRY' ? 'Entrance' : 'Exit') + '. Saving.');
      beep(item.mode === 'ENTRY' ? 'in' : 'out');
    }
    renderRecent();
  }
  function answered(item, r) {
    if (ScanRoute.forward(item, r, { has2: !!Q2, ws2: S.ws2 })) {          // the campus Sheet does not know this code: ask the graduates' Sheet
      const f = ScanRoute.passOn(item, uuid), e = S.recent.find(x => x.id === item.scanId);
      if (e) { e.id = f.scanId; e.line = 'Checking the graduates\u2019 list'; renderRecent(); }
      Q2.add(f);
      return;
    }
    const entry = S.recent.find(x => x.id === item.scanId) || { id: item.scanId, at: item.at, mode: item.mode, item: item, actions: [] };
    if (!S.recent.includes(entry)) { S.recent.unshift(entry); S.recent = S.recent.slice(0, 8); }
    entry.name = r.name || entry.name || 'Pass';
    const v = describe(item, r);
    entry.line = v.line; entry.kind = v.kind; entry.actions = v.actions || [];
    if (r.inside != null && item.hash) noteInside(item.hash, r);
    if (S.recent[0] === entry || v.kind === 'warn' || v.kind === 'error') { show(v.kind, entry.name, v.line, v.actions); if (v.kind === 'warn' || v.kind === 'error') beep(v.kind); }
    renderRecent();
  }
  // the words for one answer from the Sheet
  function describe(item, r) {
    const min = r.minMinutes || (S.info && S.info.minMinutes) || 45, n = r.visit > 1 ? ' ' + r.visit : '';
    const fix = (label, extra) => [label, () => record(Object.assign({}, item, { scanId: uuid(), at: item.at + 1, fix: true, confirmed: true }, extra), r.name)];
    switch (r.effect) {
      case 'IN': return { kind: 'in', line: 'Entrance' + n + (r.minutes > 0 ? '. ' + r.minutes + (r.minutes >= min ? '' : ' of ' + min) + ' min so far' : '') + '.' };
      case 'ALREADY_IN': return { kind: 'warn', line: 'Already inside' + (r.since ? ' since ' + hm(r.since) : '') + '. Leaving?', actions: [fix('Check out now', { mode: 'EXIT' })] };
      case 'OUT': return { kind: 'out', line: (r.cross ? 'Exit recorded for ' + r.cross.title + '. ' : 'Exit' + n + '. ') + r.minutes + (r.minutes >= min
        ? ' min. ' + (r.certificate === 'sent' ? 'Certificate already sent.' : 'The certificate is on its way by email.') : ' of ' + min + ' min.') };
      case 'EXIT_TOO_SOON': return { kind: 'warn', line: 'Checked in at ' + (r.since ? hm(r.since) : 'just now') + '. Check them out already?', actions: [fix('Yes, check out', { mode: 'EXIT' })] };
      case 'NOT_IN': return { kind: 'warn', line: 'Exit saved. Their entrance has not reached the Sheet yet.' };
      case 'OTHER_WORKSHOP': return { kind: 'warn', line: 'This pass is for ' + (r.other ? (r.other.venue ? r.other.venue + ': ' : '') + r.other.title + ', ' + r.other.day + ' at ' + r.other.start : 'another workshop') + '. Not counted here.' };
      case 'CLOSED': return { kind: 'error', line: 'Not counted: this workshop closed before this scan.' };
      case 'UNKNOWN': return { kind: 'error', line: 'Pass not found. This code is not registered for any workshop.' };
      case 'REFUSED': return { kind: 'error', line: 'Walk-in not added: ' + (r.why || 'the name or email was refused') + '.' };
      case 'ERROR': return { kind: 'error', line: 'Not saved after 5 tries. Scan again, or use Find a name.' };
      case 'REPEAT': return { kind: 'pending', line: 'Read twice, counted once.' };
      default: return { kind: 'pending', line: 'Saved.' };
    }
  }
  function renderRecent() {
    const list = $('recent');
    if (!list) return;
    list.textContent = '';
    S.recent.forEach(e => {
      const li = document.createElement('li'), top = document.createElement('div'), line = document.createElement('div'), acts = document.createElement('div');
      li.className = 'rc ' + e.kind;
      top.className = 'rc-top'; top.textContent = hm(e.at) + '  ' + e.name;
      line.className = 'rc-line'; line.textContent = e.line;
      acts.className = 'rc-actions'; buttons(acts, e.actions);
      li.append(top, line, acts); list.appendChild(li);
    });
    $('recent-wrap').hidden = !S.recent.length;
  }
  function problem(res, n) {
    if (n === 2 && (res.error === 'workshop' || res.error === 'closed')) return;   // the graduates' Sheet lacks or has closed this workshop: the campus Sheet decides
    if (n === 2 && res.error === 'key') return block('The graduates\u2019 Sheet in this scanner link no longer works', 'Scans waiting on this phone are kept. Ask the organiser for the new link: in the Sheet, Workshop > Open scanner.');
    if (res.error === 'key') return block('This scanner link no longer works', 'Scans waiting on this phone are kept. Ask the organiser for the new link: in the Sheet, Workshop > Open scanner.');
    if (res.error === 'closed') {
      S.guests = {}; store.drop('guests');
      return pick('That workshop is closed, and its guest list was removed from this phone. Choose another workshop.');
    }
    if (res.error === 'workshop') return pick('Choose the workshop this phone is scanning for.');
    show('error', 'Not saved', 'The Sheet answered: ' + (res.detail || res.error) + '. Scan again.');
    beep('error');
  }

  // ---- the list of workshops, and for the chosen one its details, guest list and counts
  // both Sheets are asked; the campus Sheet's answer leads, and a workshop only the graduates' Sheet has is taken from there
  async function hello() {
    try {
      const [r1, r2] = await Promise.all([post({ action: 'hello', workshop: S.workshop }, 1), Q2 ? post({ action: 'hello', workshop: S.workshop }, 2).catch(() => null) : null]);
      if (!r1.ok) return problem(r1, 1);
      const ok2 = !!(r2 && r2.ok);
      if (r2 && r2.ok === false) problem(r2, 2);
      if (ok2) { S.ws2 = (r2.workshops || []).map(w => w.key); store.set('ws2', S.ws2); }
      S.workshops = ScanRoute.mergeWorkshops(r1.workshops, ok2 ? r2.workshops : []);
      store.set('workshops', S.workshops);
      const has1 = !!r1.workshop, has2 = ok2 && !!r2.workshop, res = has1 ? r1 : r2;
      S.has1 = has1 || !has2;
      if (!has1 && !has2) return pick(S.workshop ? 'Workshop ' + S.workshop + ' is not in the list any more. Choose another one.' : '');
      if (res.closed) return problem({ error: 'closed' });
      S.guests = ScanRoute.mergeGuests(has1 ? r1.guests : [], has2 ? r2.guests : []);
      S.title = res.title;
      S.when = res.day + ', ' + res.start + ' to ' + res.end + (res.venue ? ', ' + res.venue : '') + (res.rehearsal ? ' (rehearsal on)' : '');
      S.info = { at: res.at, endAt: res.endAt, minMinutes: res.minMinutes };
      store.set('guests', S.guests); store.set('title', S.title); store.set('when', S.when); store.set('info', S.info);
      showTitle();
      S.counts1 = null; S.counts2 = null;
      if (has1) counts(r1.counts, 1);
      if (has2) counts(r2.counts, 2);
    } catch (e) { /* offline: the list saved on this phone is used */ }
  }
  const guestName = h => { const g = S.guests[h]; return !g ? '' : typeof g === 'string' ? g : g.name; };
  function noteInside(h, r) {
    const g = S.guests[h];
    if (g && typeof g === 'object') { g.inside = !!r.inside; g.status = r.inside && r.since ? 'Inside since ' + hm(r.since) : ''; store.set('guests', S.guests); }
  }
  // every half minute the phone reports how many scans it still holds, so the organiser can see a phone that is behind
  function heartbeat() {
    if (!S.workshop) return;
    post({ action: 'stats', pending: Q1.size(), workshop: S.workshop }, 1).then(r => r && r.ok ? counts(r.counts, 1) : r && problem(r, 1)).catch(() => {});
    if (Q2) post({ action: 'stats', pending: Q2.size(), workshop: S.workshop }, 2).then(r => r && r.ok ? counts(r.counts, 2) : r && problem(r, 2)).catch(() => {});
  }
  // the guest list every 2 minutes, and every 30 seconds in the last 15 minutes of the session (who is still inside)
  let lastHello = 0;
  function maybeHello() {
    const end = S.info && S.info.endAt, now = Date.now(), near = end && now > end - 15 * 60000 && now < end + 30 * 60000;
    if (now - lastHello >= (near ? 30000 : 120000)) { lastHello = now; hello(); }
  }

  // ---- banners: a workshop that is not today's, one that has ended while another runs, and a new scanner version
  function banner() {
    const box = $('banner');
    if (!box) return;
    const w = S.workshops.find(x => x.key === S.workshop), now = Date.now(), today = new Date().toDateString();
    let text = '', acts = [];
    if (w && !w.test && new Date(w.at).toDateString() !== today) {        // a trial (ticked Test) runs on any day
      text = 'This phone is set to ' + w.title + ', ' + w.day + '. Today is ' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '.';
      acts = [['Change workshop', () => pick('')]];
    } else if (w && w.endAt < now) {
      const running = S.workshops.filter(x => x.key !== w.key && !x.closed && x.at - 20 * 60000 <= now && x.endAt > now);
      text = w.title + ' ended at ' + w.end + '.' + (running.length ? ' Running now: ' + running.map(x => x.title + (x.venue ? ' (' + x.venue + ')' : '')).join(', ') + '.' : '');
      acts = running.length === 1 ? [['Switch to ' + running[0].key, () => choose(running[0])]] : running.length ? [['Change workshop', () => pick('')]] : [];
    }
    box.hidden = !text;
    $('banner-text').textContent = text;
    buttons($('banner-actions'), acts);
  }
  function updateBar() {
    const bar = $('update');
    if (!bar) return;
    const w = S.workshops.find(x => x.key === S.workshop), now = Date.now(), running = w && w.at - 20 * 60000 <= now && w.endAt > now;
    bar.hidden = !(S.update && Q1 && !qsize() && !running);  // never while scans are waiting or the session is on
  }
  on('update-go', 'click', () => location.reload());

  // ---- choosing the workshop: today's first, then the ones still to come, then the ones that have ended
  function pick(note) {
    const d = $('pick');
    $('pick-note').hidden = !note;
    $('pick-note').textContent = note || '';
    $('pick-cancel').hidden = !S.workshop;
    renderPick();
    if (!d.open) d.showModal();
  }
  function choose(w) { setWorkshop(w.key); if ($('pick').open) $('pick').close(); showTitle(); counts({ inside: 0, checkedIn: 0, certificates: 0 }); idle(); lastHello = Date.now(); hello(); }
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
      t.className = 'p-title'; t.textContent = (w.venue ? w.venue + ': ' : '') + w.title;
      m.className = 'p-when';
      m.textContent = w.day + ', ' + w.start + ' to ' + w.end + (w.closed ? '. Closed' : w.endAt < now ? '. Ended' : '');
      b.disabled = !!w.closed;
      b.append(t, m);
      b.addEventListener('click', () => choose(w));
      li.appendChild(b); list.appendChild(li);
    });
  }
  on('change-ws', 'click', () => pick(''));
  on('pick-cancel', 'click', () => $('pick').close());
  // the list cannot be dismissed with Escape before a workshop is chosen
  on('pick', 'cancel', e => { if (!S.workshop) e.preventDefault(); });

  // ---- who is still inside: the guest list from the Sheet, with this phone's own unsent scans on top
  function renderInside() {
    const list = $('inside-list');
    list.textContent = '';
    const mineIn = {}, mineOut = {};
    qlist().forEach(x => { if (x.hash) (x.mode === 'EXIT' ? mineOut : mineIn)[x.hash] = true; });
    const names = Object.keys(S.guests).filter(h => { const g = S.guests[h]; return !mineOut[h] && (mineIn[h] || (g && g.inside)); })
      .map(h => ({ name: guestName(h), status: mineIn[h] ? 'Entrance not sent yet' : S.guests[h].status || 'Inside' })).sort((a, b) => a.name.localeCompare(b.name));
    if (!names.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Nobody is inside, as far as this phone knows.'; list.appendChild(li); }
    names.forEach(g => { const li = document.createElement('li'), a = document.createElement('div'), b = document.createElement('div');
      a.className = 'who'; a.textContent = g.name; b.className = 'hint'; b.textContent = g.status; li.append(a, b); list.appendChild(li); });
    $('inside-note').textContent = 'Scans made on other phones in the last 2 minutes may not show yet.';
  }
  on('open-inside', 'click', () => { renderInside(); $('inside').showModal(); lastHello = 0; maybeHello(); });

  // ---- a scan, from the camera, a scanner gun or a name picked by hand
  async function onCode(raw) {
    const code = normalizeCode(raw), now = Date.now();
    if (!code) {
      if (!S.lastRead[raw] || now - S.lastRead[raw] > 3000) { S.lastRead[raw] = now; show('error', 'Not a workshop pass', 'This QR code is not an AAU workshop pass.'); beep('error'); }
      return;
    }
    if (ScanQueue.isRepeat(S.lastRead, code, S.mode, now)) return;   // the same pass, same mode, within 60 seconds
    if (!S.workshop) return pick('Choose the workshop this phone is scanning for, then scan again.');
    const hash = (await sha(code)).slice(0, 16);
    record({ action: 'scan', code: code, hash: hash, mode: S.mode, at: now, phone: S.phone, workshop: S.workshop }, guestName(hash) || 'Pass ' + code.slice(-4));
  }

  // ---- modes: Entrance and Exit, remembered on this phone (and back to Entrance when the workshop changes)
  function setMode(m) {
    S.mode = m === 'EXIT' ? 'EXIT' : 'ENTRY';
    store.set('mode', S.mode);
    document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.mode === S.mode)));
    const strip = $('mode-strip');
    if (strip) { strip.textContent = S.mode === 'ENTRY' ? 'Entrance' : 'Exit'; strip.className = 'mode-strip ' + (S.mode === 'ENTRY' ? 'is-in' : 'is-out'); }
  }
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode); idle(); }));

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
        let lit = false;
        $('torch').hidden = false;
        $('torch').onclick = () => { lit = !lit; track.applyConstraints({ advanced: [{ torch: lit }] }); $('torch').textContent = lit ? 'Torch off' : 'Torch'; };
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
    Object.keys(S.guests).filter(h => fold(guestName(h)).indexOf(f) >= 0).slice(0, 8).forEach(hash => {
      const li = document.createElement('li'), who = document.createElement('div'), row = document.createElement('div');
      who.className = 'who'; who.textContent = guestName(hash); row.className = 'row';
      [['Check in', 'ENTRY'], ['Check out', 'EXIT']].forEach(([label, mode]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.onclick = () => { $('find').close(); record({ action: 'scan', hash: hash, mode: mode, manual: true, at: Date.now(), phone: S.phone, workshop: S.workshop }, guestName(hash)); };
        row.appendChild(b);
      });
      li.appendChild(who); li.appendChild(row); list.appendChild(li);
    });
    if (!list.children.length) note('No match. For someone who did not register, use Add walk-in.');
  }
  on('open-find', 'click', () => { $('find-q').value = ''; renderFind(''); $('find').showModal(); $('find-q').focus(); });
  on('find-q', 'input', e => renderFind(e.target.value));

  // ---- walk-ins: saved and sent like scans, one at a time; the pass follows by email
  on('open-walkin', 'click', () => { $('walkin-form').reset(); $('w-error').hidden = true; $('walkin').showModal(); $('w-name').focus(); });
  on('w-cancel', 'click', () => $('walkin').close());
  on('walkin-form', 'submit', e => {
    e.preventDefault();
    const name = $('w-name').value.trim(), email = $('w-email').value.trim();
    $('walkin').close();
    record({ action: 'walkin', name: name, email: email, at: Date.now(), phone: S.phone, workshop: S.workshop, mode: 'ENTRY' }, name);
  });

  // ---- this phone's name, the screen kept awake, start-up
  on('phone-form', 'submit', e => {
    e.preventDefault();
    S.phone = $('phone-name').value.trim() || 'Phone';
    store.set('phone', S.phone);
    $('phone-label').textContent = 'This phone: ' + S.phone + ' · Scanner ' + BUILD + (S.api2 ? ' · 2 Sheets' : '');
    $('name-phone').close();
    if (!S.workshop) pick('');
    heartbeat();
  });
  async function wake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { /* allowed again after the next tap */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); kickAll(); } });

  function askSwitchWorkshop() {
    const w = S.workshops.find(x => x.key === S.askWorkshop), cur = S.workshops.find(x => x.key === S.workshop);
    $('ws-switch-text').textContent = 'This link is for ' + (w ? w.title + (w.venue ? ', ' + w.venue : '') : 'workshop ' + S.askWorkshop) +
      '. This phone is set to ' + (cur ? cur.title : 'workshop ' + S.workshop) + '. Switch?';
    $('ws-switch').showModal();
    $('ws-switch-yes').onclick = () => { const k = S.askWorkshop; S.askWorkshop = ''; $('ws-switch').close(); choose(w || { key: k }); };
    $('ws-switch-no').onclick = () => { S.askWorkshop = ''; $('ws-switch').close(); };
  }
  function start() {
    if (S.badLink) return block('This is not a valid scanner link', 'Open the scanner from the QR code the organiser shows in the Sheet, under Workshop > Open scanner.');
    if (S.switchTo) {
      $('switch-text').textContent = 'This phone is set up for another scanner link. Use the new link? ' +
        (qsize() ? 'Scans still waiting for the current link stay on this phone and are not sent to the new one.' : '');
      $('switch').showModal();
      $('switch-yes').onclick = () => { adopt(S.switchTo.api, S.switchTo.key, S.switchTo.api2, S.switchTo.key2); S.switchTo = null; if (WS_RE.test(newWs)) setWorkshop(newWs); $('switch').close(); location.reload(); };
      $('switch-no').onclick = () => { S.switchTo = null; $('switch').close(); start(); };
      return;
    }
    if (!S.api || !S.key) return block('Open the scanner from the staff link', 'The organiser shows it as a QR code in the Sheet, under Workshop > Open scanner.');
    if (S.started) return;
    S.started = true;
    setMode(S.mode);
    showTitle();
    $('phone-label').textContent = (S.phone ? 'This phone: ' + S.phone + ' · ' : '') + 'Scanner ' + BUILD + (S.api2 ? ' · 2 Sheets' : '');
    if (!S.phone) $('name-phone').showModal();
    else if (!S.workshop) pick('');
    idle(); syncLine(); camera(); wake();
    lastHello = Date.now();
    hello().then(() => {
      if (S.askWorkshop) return askSwitchWorkshop();
      const w = S.workshops.find(x => x.key === S.workshop);
      if (w && !w.test && new Date(w.at).toDateString() !== new Date().toDateString() && S.phone) pick('This phone was set to ' + w.title + ', ' + w.day + '. Choose today\'s workshop.');
    });
    setInterval(heartbeat, 30000); setInterval(maybeHello, 15000); setInterval(banner, 60000); setInterval(() => syncLine(), 20000);
    window.addEventListener('online', () => { kickAll(); syncLine(); });
    window.addEventListener('offline', () => syncLine());
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
