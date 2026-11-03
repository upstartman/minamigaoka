/**
 * 南ヶ丘MBC活動計画表 カレンダー購読フィード (Google Apps Script)
 *
 * Firestore の app/main を読み、iCalendar(.ics) 形式で返すWebアプリ。
 * Googleカレンダーの「URLで追加」等で購読すると、アプリの変更が自動で反映される。
 *
 * デプロイ: 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   - 次のユーザーとして実行: 自分
 *   - アクセスできるユーザー: 全員
 *
 * URLパラメータ (すべて省略可):
 *   types  : 含める種類をカンマ区切りで指定 (practice,match,league,other,duty,key)。省略時はすべて
 *   member : メンバーID。指定するとその人が担当の日のお当番・鍵当番だけを含める
 *   names  : 1 のときお当番・鍵当番に名前を含める (既定は含めない)
 */

const FIREBASE_PROJECT_ID = 'minamigaoka-schedule';
const FIREBASE_API_KEY = 'AIzaSyAIYyl157-pOdkFkCIIUwPGha-d95ZjWLM';
const PAST_DAYS = 60;          // 過去何日分まで含めるか
const CACHE_SECONDS = 300;     // Firestoreの読込結果をキャッシュする秒数
const DEFAULT_PLACE = '南小体育館';
const TYPE_LABEL = { practice: '練習', match: '練習試合', league: '大会試合', other: 'その他' };
const ALL_TYPES = ['practice', 'match', 'league', 'other', 'duty', 'key'];
const APP_NOTE = '南ヶ丘MBC活動計画表より';

function doGet(e) {
  const p = (e && e.parameter) || {};
  const types = p.types ? String(p.types).split(',').filter(t => ALL_TYPES.indexOf(t) >= 0) : ALL_TYPES;
  const opts = { types: types, memberId: p.member || '', withNames: p.names === '1' };
  const ics = buildFeed(loadState(), opts, new Date());
  return ContentService.createTextOutput(ics).setMimeType(ContentService.MimeType.ICAL);
}

// ============ Firestore 読込 ============
function loadState() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('state');
  if (cached) return JSON.parse(cached);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/app/main?key=${FIREBASE_API_KEY}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Firestore read failed: ' + res.getResponseCode());
  const state = normalizeState(fromFirestoreFields(JSON.parse(res.getContentText()).fields || {}));
  try { cache.put('state', JSON.stringify(state), CACHE_SECONDS); } catch (err) { /* 100KB超はキャッシュしない */ }
  return state;
}

function fromFirestoreValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  return null;
}
function fromFirestoreFields(fields) {
  const out = {};
  Object.keys(fields).forEach(k => { out[k] = fromFirestoreValue(fields[k]); });
  return out;
}

function normalizeState(d) {
  return {
    events: d.events || {},
    keyDuty: d.keyDuty || {},
    duty: d.duty || {},
    dutyMemberOverrides: d.dutyMemberOverrides || {},
    teams: (d.teams || []).map(t => Object.assign({}, t, {
      members: (t.members || []).filter(m => m && typeof m === 'object')
    }))
  };
}

// ============ アプリと同じ判定ロジック ============
function parseKey(k) { const a = k.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getTeam(s, id) { return s.teams.find(t => t.id === id); }
function getMember(s, id) {
  for (const t of s.teams) {
    const m = t.members.find(x => x.id === id);
    if (m) return { id: m.id, name: m.name, teamId: t.id };
  }
  return null;
}
function parseTimeRange(str) {
  if (!str) return { start: '', end: '' };
  let m = str.match(/^(\d{1,2}:\d{2})\s*[〜~\-]\s*(\d{1,2}:\d{2})$/);
  if (m) return { start: m[1], end: m[2] };
  m = str.match(/^(\d{1,2}:\d{2})$/);
  if (m) return { start: m[1], end: '' };
  return { start: '', end: '' };
}
function hasMatchOrLeague(s, key) {
  return (s.events[key] || []).some(e => e.type === 'match' || e.type === 'league');
}
function canHaveKeyDuty(s, key) {
  const dow = parseKey(key).getDay();
  if (dow !== 4 && dow !== 5) return false;
  return (s.events[key] || []).some(e => e.type === 'practice' || e.type === 'match' || e.type === 'league');
}
function getEffectiveDutyMembers(s, key) {
  const duty = s.duty[key];
  const team = duty ? getTeam(s, duty.teamId) : null;
  if (!team) return [];
  let result = team.members.map(m => ({ id: m.id, name: m.name, fromTeamId: team.id, isOverride: false }));
  (s.dutyMemberOverrides[key] || []).forEach(o => {
    result = result.filter(m => m.id !== o.outMemberId);
    const inMem = getMember(s, o.inMemberId);
    if (inMem) result.push({ id: inMem.id, name: inMem.name, fromTeamId: inMem.teamId, isOverride: true });
  });
  return result;
}
function plainDutyMembers(s, key) {
  return getEffectiveDutyMembers(s, key).map(m => {
    const ot = getTeam(s, m.fromTeamId);
    return m.name + (m.isOverride && ot ? `(${ot.name})` : '');
  }).join('、');
}

// ============ カレンダー項目 ============
function eventToCal(s, key, ev, opts) {
  const label = TYPE_LABEL[ev.type] || '';
  let title = ev.title || label;
  if ((ev.type === 'match' || ev.type === 'league') && title !== label) title = `${label}：${title}`;
  const t = parseTimeRange(ev.time);
  const details = [];
  if (ev.memo) details.push(ev.memo);
  if (ev.type === 'match' || ev.type === 'league') {
    const duty = s.duty[key];
    const team = duty ? getTeam(s, duty.teamId) : null;
    if (team) {
      const mem = opts.withNames ? plainDutyMembers(s, key) : '';
      details.push(`お当番: ${team.name}${mem ? `(${mem})` : ''}`);
    }
  }
  if (opts.withNames && ev.type !== 'other') {
    const kd = s.keyDuty[key];
    const kdMem = kd ? getMember(s, kd.memberId) : null;
    if (kdMem) details.push(`鍵当番: ${kdMem.name}`);
  }
  details.push(APP_NOTE);
  return {
    uid: `ev-${ev.id}@minamigaoka-schedule`, key: key,
    allDay: !t.start, start: t.start, end: t.end, title: `🏀 ${title}`,
    place: ev.place || (ev.type === 'practice' ? DEFAULT_PLACE : ''), details: details.join('\n')
  };
}

function dutyToCal(s, key, opts) {
  const duty = s.duty[key];
  const team = duty ? getTeam(s, duty.teamId) : null;
  if (!team) return null;
  const details = [];
  const mem = opts.withNames ? plainDutyMembers(s, key) : '';
  if (mem) details.push(`担当: ${mem}`);
  const games = (s.events[key] || []).filter(e => e.type === 'match' || e.type === 'league')
    .map(e => e.title || TYPE_LABEL[e.type]).join('、');
  if (games) details.push(`試合: ${games}`);
  details.push(APP_NOTE);
  return { uid: `duty-${key}@minamigaoka-schedule`, key: key, allDay: true,
    title: `🔔 お当番：${team.name}`, place: '', details: details.join('\n') };
}

function keyDutyToCal(s, key, opts) {
  const kd = s.keyDuty[key];
  const mem = kd ? getMember(s, kd.memberId) : null;
  if (!mem) return null;
  const showName = opts.withNames || opts.memberId;
  return { uid: `key-${key}@minamigaoka-schedule`, key: key, allDay: true,
    title: showName ? `🔑 鍵当番：${mem.name}` : '🔑 鍵当番', place: '', details: APP_NOTE };
}

function collectItems(s, opts, now) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PAST_DAYS);
  const fromKey = dateKey(from);
  const keys = {};
  [s.events, s.duty, s.keyDuty].forEach(o => Object.keys(o).forEach(k => { keys[k] = true; }));
  const items = [];
  Object.keys(keys).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && k >= fromKey).sort().forEach(key => {
    (s.events[key] || []).forEach(ev => {
      if (ev && opts.types.indexOf(ev.type) >= 0) items.push(eventToCal(s, key, ev, opts));
    });
    if (opts.types.indexOf('duty') >= 0 && s.duty[key] && hasMatchOrLeague(s, key)) {
      if (!opts.memberId || getEffectiveDutyMembers(s, key).some(x => x.id === opts.memberId)) {
        const it = dutyToCal(s, key, opts);
        if (it) items.push(it);
      }
    }
    if (opts.types.indexOf('key') >= 0 && s.keyDuty[key] && canHaveKeyDuty(s, key)) {
      if (!opts.memberId || s.keyDuty[key].memberId === opts.memberId) {
        const it = keyDutyToCal(s, key, opts);
        if (it) items.push(it);
      }
    }
  });
  return items;
}

// ============ iCalendar 出力 ============
function calDateParts(item) {
  const d = parseKey(item.key);
  const ymd = x => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
  if (item.allDay) {
    const next = new Date(d); next.setDate(next.getDate() + 1);
    return { start: ymd(d), end: ymd(next) };
  }
  const toDT = hm => { const a = hm.split(':').map(Number); const x = new Date(d); x.setHours(a[0], a[1], 0, 0); return x; };
  const st = toDT(item.start);
  let en = item.end ? toDT(item.end) : new Date(st.getTime() + 3600000);
  if (en <= st) en = new Date(st.getTime() + 3600000);
  const fmt = x => `${ymd(x)}T${String(x.getHours()).padStart(2, '0')}${String(x.getMinutes()).padStart(2, '0')}00`;
  return { start: fmt(st), end: fmt(en) };
}

function icsEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC5545: 1行75オクテットで折り返す (UTF-8の文字途中で切らない)
function utf8Len(ch) {
  const c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}
function icsFold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = utf8Len(ch);
    if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

function buildFeed(s, opts, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Minamigaoka MBC//Schedule Feed//JA',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:南ヶ丘MBC', 'X-WR-TIMEZONE:Asia/Tokyo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE'
  ];
  collectItems(s, opts, now).forEach(item => {
    const dp = calDateParts(item);
    lines.push('BEGIN:VEVENT', `UID:${item.uid}`, `DTSTAMP:${stamp}`);
    if (item.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dp.start}`, `DTEND;VALUE=DATE:${dp.end}`, 'TRANSP:TRANSPARENT');
    } else {
      lines.push(`DTSTART;TZID=Asia/Tokyo:${dp.start}`, `DTEND;TZID=Asia/Tokyo:${dp.end}`);
    }
    lines.push(`SUMMARY:${icsEscape(item.title)}`);
    if (item.place) lines.push(`LOCATION:${icsEscape(item.place)}`);
    if (item.details) lines.push(`DESCRIPTION:${icsEscape(item.details)}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
