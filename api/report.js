// Serverless proxy: fetches Ozonetel CloudAgent "Agent State Summary" for one day
// and returns normalised rows. The API key never reaches the browser.
const savedBreakReport = require('../data/break-details.json');
const { redis } = require('./_redis');
const savedAgentNames = new Map((savedBreakReport.records || []).map(r => [r.agentId, r.agentName]));
function endpoint() {
  let b = (process.env.OZONETEL_BASE_URL || process.env.OZONETEL_DOMAIN || 'in1-ccaas-api.ozonetel.com').trim();
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/+$/, '');
  if (/\/summaryReport$/i.test(b)) return b;
  if (/\/ca_reports$/i.test(b)) return b + '/summaryReport';
  return b.replace(/\/(ca_apis|ca_reports).*$/i, '') + '/ca_reports/summaryReport';
}
function base() { return endpoint().replace(/\/ca_reports\/summaryReport$/i, ''); }


// TOKEN_AUTH: token lasts 60 min, max 10 generations/hour, a new one invalidates the old.
let tok = { value: null, at: 0 }, tokPending = null;
async function getToken(force) {
  if (!force && tok.value && Date.now() - tok.at < 50 * 60 * 1000) return tok.value;
  if (tokPending) return tokPending; // one generation at a time: a new token invalidates the previous one
  tokPending = newToken().finally(() => { tokPending = null; });
  return tokPending;
}
async function newToken() {
  if (Date.now() - tok.at < 5 * 1000 && tok.value) return tok.value; // just refreshed by another request
  const r = await fetch(base() + '/ca_reports/CAToken/generateToken', {
    method: 'POST',
    headers: { apiKey: process.env.OZONETEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: process.env.OZONETEL_USERNAME }),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = {}; }
  const value = j.token || j.data?.token;
  if (!value) throw new Error('Token generation failed: ' + (j.message || t.slice(0, 200) || 'HTTP ' + r.status));
  tok = { value, at: Date.now() };
  return value;
}


async function callSummary(body) {
  const send = (token) => fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let r = await send(await getToken(false));
  if (r.status === 401) r = await send(await getToken(true)); // token expired or replaced elsewhere
  return r;
}


function oz(method, path, body) {
  return new Promise(async (ok) => {
    const send = (token) => new Promise((done) => {
      const u = new URL(base() + path);
      const data = JSON.stringify(body);
      const rq = require('https').request({ hostname: u.hostname, path: u.pathname, method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (rs) => {
        let b = ''; rs.on('data', (c) => (b += c));
        rs.on('end', () => { let j; try { j = JSON.parse(b); } catch { j = { status: 'error', message: b.slice(0, 200) }; } done({ http: rs.statusCode, j }); });
      });
      rq.on('error', (e) => done({ http: 0, j: { status: 'error', message: e.message } }));
      rq.write(data); rq.end();
    });
    try {
      let r = await send(await getToken(false));
      if (r.http === 401) r = await send(await getToken(true));
      ok(r);
    } catch (e) { ok({ http: 0, j: { status: 'error', message: e.message } }); }
  });
}


// ---- Call records (CDR): one day per request, max 2 requests/min, last 15 days only.
const liveCache = { loginsAt: 0, logins: null, stateMap: {} };
const cdrCache = new Map(); // date -> { at, calls }
const savedCallCache = new Map();
async function savedCalls(date) {
  const hit = savedCallCache.get(date);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.calls;
  const month = date.slice(0, 7);
  const r = await fetch(`https://sunrooof-agent-calls-20260923.vercel.app/api/calls?month=${month}&date=none`);
  if (!r.ok) throw new Error('Saved call records unavailable');
  const data = await r.json();
  if (!Array.isArray(data.records)) throw new Error('Saved call records incomplete');
  const calls = data.records.filter(c => c['Call Date'] === date).map(c => ({
    AgentID: c['Agent ID'], AgentName: c.Agent, StartTime: c['Start Time'],
    TalkTime: c['Talk Time'], Status: c.Status, Type: c['Call Type'],
  }));
  savedCallCache.set(date, {at: Date.now(), calls});
  return calls;
}
async function fetchCalls(date, now) {
  const isToday = date === now.date;
  const hit = cdrCache.get(date);
  if (hit && Date.now() - hit.at < (isToday ? 35 : 300) * 1000) return hit.calls;
  const r = await oz('GET', '/ca_reports/fetchCDRDetails', { userName: process.env.OZONETEL_USERNAME,
    fromDate: `${date} 00:00:00`, toDate: isToday ? `${date} ${now.time}` : `${date} 23:59:59` });
  if (String(r.j.status).toLowerCase() === 'success') {
    const calls = Array.isArray(r.j.details) ? r.j.details : [];
    cdrCache.set(date, { at: Date.now(), calls });
    return calls;
  }
  if (/no data/i.test(String(r.j.message))) { cdrCache.set(date, { at: Date.now(), calls: [] }); return []; }
  if (hit) return hit.calls; // rate limited or a blip: keep showing the last good pull
  throw new Error('Call records: ' + (typeof r.j.message === 'string' ? r.j.message : 'HTTP ' + r.http));
}


function callList(calls, agent) {
  return calls
    .filter((c) => !agent || c.AgentID === agent || c.AgentName === agent)
    .map((c) => ({
      start: c.StartTime, end: c.EndTime, mode: String(c.Type || ''), number: c.CallerID || c.E164 || '', agentPhone: c.DialedNumber || '',
      campaign: c.CampaignName || '', skill: c.Skill || '', status: c.Status || '', disposition: c.Disposition || '',
      talk: toSec(c.TalkTime), ring: toSec(c.CustomerRingTime), duration: toSec(c.Duration),
      wrapup: toSec(c.WrapupDuration), hold: toSec(c.HoldDuration), hangupBy: c.HangupBy || '',
      customerStatus: c.CustomerDialStatus || '', recording: c.CallAudio || '',
    }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
}

function timeSlots(calls) {
  const periods = [[10, 12], [12, 14], [14, 16], [16, 19]];
  const agents = new Map();
  for (const c of calls) {
    const id = c.AgentID || c.AgentName;
    if (!id || !/^\d{2}:\d{2}:\d{2}$/.test(String(c.StartTime || ''))) continue;
    const hour = Number(c.StartTime.slice(0, 2));
    const slot = periods.findIndex(([start, end]) => hour >= start && hour < end);
    if (slot < 0) continue;
    if (!agents.has(id)) agents.set(id, {agentId: id, agentName: c.AgentName || id,
      slots: periods.map(() => ({calls: 0, connected: 0, talk: 0, boards: {}}))});
    const cell = agents.get(id).slots[slot];
    const talk = toSec(c.TalkTime);
    const mode = String(c.Type || '').toLowerCase();
    const board = mode === 'progressive' ? 'Progressive' : mode === 'manual' ? 'Manual' : mode === 'inbound' ? 'Inbound' : 'Other';
    const connected = c.Status === 'Answered' && talk > 0 ? 1 : 0;
    cell.calls++;
    cell.connected += connected;
    cell.talk += talk;
    const component = cell.boards[board] || (cell.boards[board] = {calls: 0, connected: 0, talk: 0});
    component.calls++;
    component.connected += connected;
    component.talk += talk;
  }
  return [...agents.values()];
}


async function liveData() {
  if (!liveCache.logins || Date.now() - liveCache.loginsAt > 35 * 1000) {
    const r = await oz('POST', '/ca_apis/getAgentLogins', { userName: process.env.OZONETEL_USERNAME });
    const rows = [r.j.message, r.j.details, r.j.data, r.j.agents].find(Array.isArray);
    if (String(r.j.status).toLowerCase() === 'success' && rows) {
      liveCache.logins = rows;
      liveCache.loginsAt = Date.now();
    } else if (!liveCache.logins || Date.now() - liveCache.loginsAt > 120 * 1000) {
      throw new Error('Agent status: ' + (String(r.j.status).toLowerCase() === 'success' ? `unexpected response fields ${Object.keys(r.j).join(',')}; message type ${typeof r.j.message}` : typeof r.j.message === 'string' ? r.j.message : 'HTTP ' + r.http));
    }
  }
  const loggedIn = new Map(liveCache.logins.map(x => [String(x.AgentId || x.agentId || ''), x]).filter(([id]) => id));
  const ids = [...new Set([...savedAgentNames.keys(), ...loggedIn.keys(), ...String(process.env.OZONETEL_AGENT_IDS || '').split(',').map(x => x.trim()).filter(Boolean)])];
  const sm = liveCache.stateMap;
  const aux = [...loggedIn].filter(([, x]) => /^(aux|pause|paused|break)$/i.test(String(x.AgentState || x.State || '')));
  for (const [id] of aux.filter(([id]) => !sm[id] || Date.now() - sm[id].at > 60 * 1000).slice(0, 3)) {
    const r = await oz('POST', '/ca_apis/AgentDetails', { userName: process.env.OZONETEL_USERNAME, agentId: id });
    const x = (Array.isArray(r.j.message) ? r.j.message : Array.isArray(r.j.details) ? r.j.details : [])[0];
    if (x) sm[id] = { since: x.Since || '', reason: x.PauseReason || x.pauseReason || x.AuxReason || x.auxReason || x.StateReason || x.stateReason || '', at: Date.now() };
  }
  const status = ids.map(id => {
    const x = loggedIn.get(id), state = x ? String(x.AgentState || x.State || 'UNKNOWN') : 'LOGOUT';
    const detail = /^(aux|pause|paused|break)$/i.test(state) && Date.now() - (sm[id]?.at || 0) < 120 * 1000 ? sm[id] : null;
    return { agentId: id, agentName: x?.AgentName || savedAgentNames.get(id) || id, state,
      since: detail?.since || '', reason: x?.PauseReason || x?.pauseReason || x?.AuxReason || x?.auxReason || detail?.reason || '',
      checkedSecsAgo: Math.round((Date.now() - liveCache.loginsAt) / 1000) };
  });
  return { status, agentCount: ids.length, fetchedAt: new Date(liveCache.loginsAt).toISOString(), stale: Date.now() - liveCache.loginsAt > 90 * 1000 };
}

function agedLive(value) {
  const age = Math.max(0, Math.round((Date.now() - Date.parse(value.fetchedAt)) / 1000));
  return {
    ...value,
    stale: value.stale || age > 90,
    status: (value.status || []).map(s => ({ ...s, checkedSecsAgo: age })),
  };
}
async function sharedLiveData() {
  let saved = null;
  try {
    const value = await redis(['GET', 'break:live-status']);
    if (value) saved = JSON.parse(value);
  } catch {}
  if (saved && Date.now() - Date.parse(saved.fetchedAt) < 50 * 1000) return agedLive(saved);
  let locked = false;
  try { locked = !!(await redis(['SET', 'break:live-lock', String(Date.now()), 'NX', 'EX', 15])); } catch {}
  if (!locked && saved) {
    const prior = agedLive(saved);
    return prior.stale ? { ...prior, warning: 'Waiting for the next Ozonetel status check' } : prior;
  }
  if (!locked) {
    await new Promise(resolve => setTimeout(resolve, 900));
    try {
      const value = await redis(['GET', 'break:live-status']);
      if (value) return agedLive(JSON.parse(value));
    } catch {}
  }
  try {
    const fresh = await liveData();
    try { await redis(['SET', 'break:live-status', JSON.stringify(fresh), 'EX', 600]); } catch {}
    return fresh;
  } catch (error) {
    if (saved && Date.now() - Date.parse(saved.fetchedAt) < 300 * 1000)
      return { ...agedLive(saved), stale: true, warning: 'Ozonetel status temporarily rate limited' };
    throw error;
  }
}


const cache = new Map(); // date -> {at, payload}  (API allows only 5 calls/min)
const TTL_MS = 60 * 1000;
const intervalCache = new Map();
const intervalPending = new Map();
const reportIntervals = [
  {label: '10 AM–12 PM', start: '10:00:00', end: '11:59:59', seconds: 7200},
  {label: '12–2 PM', start: '12:00:00', end: '13:59:59', seconds: 7200},
  {label: '2–4 PM', start: '14:00:00', end: '15:59:59', seconds: 7200},
  {label: '4–7 PM', start: '16:00:00', end: '18:59:59', seconds: 10800},
];


const toSec = (t) => {
  if (t == null || t === '') return 0;
  if (typeof t === 'number') return t;
  const p = String(t).trim().split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};


function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}


function pick(o, ...keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
}


function normalise(raw) {
  let list = [raw.details, raw.data, raw.message, raw].find(Array.isArray);
  if (!list) list = [raw.details, raw.data, raw.message].find((x) => x && typeof x === 'object' && (x.AgentName || x.ModeType));
  if (!Array.isArray(list)) list = list ? [list] : [];
  return list.map((r) => ({
    agentId: String(pick(r, 'AgentUniqueID', 'agentId', 'AgentID', 'AgentIncrID') ?? ''),
    agentName: String(pick(r, 'AgentName', 'agentName') ?? ''),
    mode: String(pick(r, 'ModeType', 'modeType') ?? 'Unknown'),
    login: toSec(pick(r, 'TotalLoginDuration', 'loginDuration')),
    talk: toSec(pick(r, 'TotalDialTime', 'talkDuration')),
    idle: toSec(pick(r, 'TotalIdleTime', 'readyDuration')),
    pause: toSec(pick(r, 'TotalPauseTime', 'pauseDuration')),
    busy: toSec(r.TotalBusyTime),
    wrapup: toSec(r.TotalWrapupTime),
  }));
}

async function intervalSummary(date) {
  const hit = intervalCache.get(date);
  if (hit?.payload && Date.now() - hit.at < 60 * 60 * 1000) return hit.payload;
  if (intervalPending.has(date)) return intervalPending.get(date);
  const pending = (async () => {
    const slots = hit?.slots ? [...hit.slots] : [];
    for (const [index, period] of reportIntervals.entries()) {
      if (slots[index]) continue;
      const body = {userName: process.env.OZONETEL_USERNAME,
        fromDate: `${date} ${period.start}`, toDate: `${date} ${period.end}`};
      if (process.env.OZONETEL_MODE_TYPES) body.modeType = process.env.OZONETEL_MODE_TYPES;
      if (process.env.OZONETEL_AGENT_IDS) body.agentId = process.env.OZONETEL_AGENT_IDS;
      const response = await callSummary(body);
      const text = await response.text();
      let raw; try { raw = JSON.parse(text); } catch { raw = {status: 'error', message: text.slice(0, 300)}; }
      const status = String(raw.status || '').toLowerCase();
      let rows;
      if (['error', 'fail', 'false'].includes(status)) {
        const message = typeof raw.message === 'string' ? raw.message : 'Ozonetel returned an error';
        if (!/no data/i.test(message)) throw new Error(`${period.label}: ${message}`);
        rows = [];
      } else rows = normalise(raw);
      slots[index] = {...period, rows};
      intervalCache.set(date, {at: Date.now(), slots});
    }
    const payload = {ok: true, date, fetchedAt: new Date().toISOString(), slots};
    intervalCache.set(date, {at: Date.now(), slots, payload});
    return payload;
  })();
  intervalPending.set(date, pending);
  try { return await pending; } finally { intervalPending.delete(date); }
}


// Figures from the 18 Sep 2026 report, used for ?demo=1 or when no key is configured.
function demoRows() {
  const A = [
    ['SRF123', 'pinki', ['0:00:09', 0, 55.6], ['0:00:15', 0, 100], ['9:52:59', 0, 60.1]],
    ['SRF189', 'Aparna', ['0:00:10', 0, 0], ['8:08:37', '0:37:48', 72.9], null],
    ['SRF225', 'Elveen', ['0:00:05', 0, 0], ['5:19:19', '0:01:42', 99.4], null],
    ['SRF457', 'Vanshika', ['0:00:10', 0, 20], ['8:13:59', '0:24:18', 68.7], ['0:00:37', '0:00:33', 10.8]],
    ['SRF675', 'Mansi', null, ['7:10:42', '0:42:13', 75.1], null],
    ['SRF678', 'Anubhav Singh', ['0:00:02', 0, 50], ['5:16:59', '0:15:54', 91.6], ['1:20:24', '0:22:48', 21.1]],
    ['SRF879', 'Pallavi', ['1:27:34', '0:01:59', 75.1], ['4:55:55', '0:06:52', 88.7], ['2:36:09', '0:46:03', 13.2]],
    ['SRF897', 'Shivalee', ['1:05:50', 0, 99.6], ['7:24:38', '0:46:08', 65.8], null],
    ['SRF956', 'Avesh', ['0:00:02', 0, 0], ['5:33:12', '0:01:06', 79.1], ['2:04:28', '0:26:00', 10.4]],
    ['SRF980', 'Anchal', ['0:01:51', 0, 3.6], ['6:41:47', '0:01:10', 92.4], ['1:55:54', '0:52:45', 26.2]],
  ];
  const modes = ['Inbound', 'Manual', 'Progressive'];
  const rows = [];
  for (const [id, name, ...m] of A) m.forEach((v, i) => {
    if (!v) return;
    const login = toSec(v[0]);
    rows.push({ agentId: id, agentName: name, mode: modes[i], login, talk: toSec(v[1]),
      idle: Math.round((login * v[2]) / 100), pause: 0, busy: 0, wrapup: 0 });
  });
  return rows;
}


const coreReport = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const now = istNow();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : now.date;
  const key = process.env.OZONETEL_API_KEY, user = process.env.OZONETEL_USERNAME;
  const demo = url.searchParams.get('demo') === '1' || !key || !user;


  res.setHeader('Cache-Control', 'no-store');
  if (date > now.date) return res.status(400).json({ ok: false, error: 'Date is in the future.' });

  if (url.searchParams.get('view') === 'slot-summary') {
    if (demo) return res.status(502).json({ok: false, error: 'Interval state summaries require Ozonetel credentials.'});
    if (date === now.date) return res.status(200).json({ok: true, date, pending: true, slots: []});
    try {
      const payload = await intervalSummary(date);
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400');
      return res.status(200).json(payload);
    } catch (e) {
      const error = String(e.message || e);
      if (/max limit|rate limit/i.test(error)) res.setHeader('Retry-After', '65');
      return res.status(/max limit|rate limit/i.test(error) ? 429 : 502).json({ok: false, error});
    }
  }

  if (url.searchParams.get('view') === 'slots') {
    try {
      let calls;
      if (date === now.date && !demo) {
        try { calls = await fetchCalls(date, now); } catch { calls = await savedCalls(date); }
      } else {
        try { calls = await savedCalls(date); } catch { if (demo) throw new Error('Saved call records unavailable'); calls = await fetchCalls(date, now); }
      }
      if (!calls.length && !demo) calls = await fetchCalls(date, now);
      return res.status(200).json({ok: true, date, fetchedAt: new Date().toISOString(), rows: timeSlots(calls)});
    } catch (e) {
      return res.status(502).json({ok: false, error: String(e.message || e)});
    }
  }

  if (demo) {
    return res.status(200).json({ ok: true, demo: true, date: '2026-09-18', fetchedAt: new Date().toISOString(), rows: demoRows(),
      note: !key || !user ? 'OZONETEL_API_KEY / OZONETEL_USERNAME not set — showing sample data.' : 'Demo mode.' });
  }


  if (url.searchParams.get('view') === 'calls') {
    try {
      const agent = url.searchParams.get('agent') || '';
      const calls = await fetchCalls(date, now);
      const rows = callList(calls, agent);
      return res.status(200).json({ ok: true, date, agent, fetchedAt: new Date((cdrCache.get(date) || {}).at || Date.now()).toISOString(), calls: rows });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  }


  if (url.searchParams.get('view') === 'live') {
    try {
      const d = await sharedLiveData();
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=30');
      return res.status(200).json({ ok: true, live: true, date, ...d });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  }


  const hit = cache.get(date);
  const pastDayCache = date < now.date ? 'public, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400' : null;
  if (hit && Date.now() - hit.at < TTL_MS && url.searchParams.get('raw') !== '1') {
    if (pastDayCache) res.setHeader('Cache-Control', pastDayCache);
    return res.status(200).json(hit.payload);
  }


  const body = {
    userName: user,
    fromDate: `${date} 00:00:00`,
    toDate: date === now.date ? `${date} ${now.time}` : `${date} 23:59:59`,
  };
  if (process.env.OZONETEL_MODE_TYPES) body.modeType = process.env.OZONETEL_MODE_TYPES;
  if (process.env.OZONETEL_AGENT_IDS) body.agentId = process.env.OZONETEL_AGENT_IDS;


  try {
    const r = await callSummary(body);
    const text = await r.text();
    let raw; try { raw = JSON.parse(text); } catch { raw = { status: 'error', message: text.slice(0, 300) }; }
    const status = String(raw.status || '').toLowerCase();
    if (status === 'error' || status === 'fail' || status === 'false') {
      const msg = typeof raw.message === 'string' ? raw.message : 'Ozonetel returned an error';
      if (/no data/i.test(msg)) {
        const payload = { ok: true, date, fetchedAt: new Date().toISOString(), rows: [] };
        cache.set(date, { at: Date.now(), payload });
        if (pastDayCache) res.setHeader('Cache-Control', pastDayCache);
        return res.status(200).json(payload);
      }
      if (hit) return res.status(200).json({ ...hit.payload, stale: true, warning: msg });
      return res.status(502).json({ ok: false, error: msg + ' (host: ' + new URL(endpoint()).host + ', HTTP ' + r.status + ')' });
    }
    const payload = { ok: true, date, fetchedAt: new Date().toISOString(), rows: normalise(raw) };
    cache.set(date, { at: Date.now(), payload });
    if (pastDayCache && url.searchParams.get('raw') !== '1') res.setHeader('Cache-Control', pastDayCache);
    return res.status(200).json(url.searchParams.get('raw') === '1' ? {...payload, raw} : payload);
  } catch (e) {
    if (hit) return res.status(200).json({ ...hit.payload, stale: true, warning: String(e.message || e) });
    return res.status(502).json({ ok: false, error: 'Could not reach Ozonetel at ' + (() => { try { return new URL(endpoint()).host; } catch { return 'invalid OZONETEL_BASE_URL'; } })() + ': ' + (e.cause?.code || e.message || e) });
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.OZONETEL_API_KEY || !process.env.OZONETEL_USERNAME)
    return res.status(503).json({ok: false, error: 'Set OZONETEL_API_KEY and OZONETEL_USERNAME in Vercel.'});

  const url = new URL(req.url, 'https://dashboard.local');
  const view = url.searchParams.get('view');
  if (view && view !== 'live') return res.status(404).json({ok: false, error: 'Report view unavailable.'});
  if (url.searchParams.has('raw') || url.searchParams.has('demo'))
    return res.status(404).json({ok: false, error: 'Report view unavailable.'});

  const originalJson = res.json.bind(res);
  res.json = payload => {
    res.setHeader('Cache-Control', view === 'live' && payload?.ok ? 'public, s-maxage=30, stale-while-revalidate=30' : 'no-store');
    if (!payload?.ok) return originalJson(payload);
    if (view === 'live') {
      const status = (payload.status || []).map(s => ({
        agentId: s.agentId, agentName: s.agentName, state: s.state,
        mode: s.mode, since: s.since, reason: s.reason, checkedSecsAgo: s.checkedSecsAgo,
      }));
      return originalJson({ok: true, live: true, date: payload.date, fetchedAt: payload.fetchedAt,
        stale: payload.stale, warning: payload.warning, status, agentCount: payload.agentCount});
    }
    return originalJson({ok: true, date: payload.date, fetchedAt: payload.fetchedAt,
      stale: payload.stale, warning: payload.warning,
      rows: (payload.rows || []).map(r => ({agentId: r.agentId, agentName: r.agentName, pause: r.pause}))});
  };
  return coreReport(req, res);
};
