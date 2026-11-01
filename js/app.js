// =========================================================
//  함께메모 - 메인 스크립트 (친구 + 대화형 메모장)
//  · 누구나 가입
//  · 친구는 요청 → 수락으로 서로 맺어짐
//  · 메모장은 방장이 친구 중에서 골라 초대한 사람만 접근 (DB RLS 로 강제)
// =========================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'];
const COLOR_LABEL = { yellow: '노랑', pink: '분홍', blue: '파랑', green: '초록', purple: '보라', gray: '회색' };
const PAGE = 80;

const ICON_ADD_FRIEND = '<circle cx="10" cy="8" r="4"/><path d="M2.5 20c.7-3.9 3.6-6 7.5-6s6.8 2.1 7.5 6z"/><path d="M19 4h1.8v2.6h2.6v1.8h-2.6V11H19V8.4h-2.6V6.6H19z"/>';
const ICON_ADD_MEMO = '<path d="M5 3h9v2H5v14h14v-8h2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M18.2 1h1.8v3h3v1.8h-3v3h-1.8v-3h-3V4h3z"/><path d="M7 10h8v1.8H7zm0 4h5v1.8H7z"/>';

// ---------------------------------------------------------
//  상태
// ---------------------------------------------------------
const state = {
  user: null,
  profile: null,
  tab: 'friends',
  search: '',
  friendships: [],
  profiles: new Map(),
  memos: [],
  membersByMemo: new Map(),
  room: null,         // { id, messages, hasMore, loading, query }
  channel: null,
  loaded: false,
};

// ---------------------------------------------------------
//  유틸
// ---------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));

const uid = () => state.user?.id;
const myName = () => state.profile?.display_name || state.user?.email?.split('@')[0] || '나';

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function toast(msg, type = '', action = null) {
  const t = h('div', { class: `toast ${type}` }, h('span', { text: msg }),
    action ? h('button', { class: 'toast-action', text: action.label, onclick: () => { t.remove(); action.onClick(); } }) : null);
  $('#toasts').append(t);
  const life = action ? 6000 : 2800;
  setTimeout(() => t.classList.add('out'), life);
  setTimeout(() => t.remove(), life + 400);
}

function koError(e) {
  const m = String(e?.message || e || '');
  const table = [
    [/Invalid login credentials/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
    [/Email not confirmed/i, '이메일 인증이 아직 안 됐습니다. 받은 메일의 링크를 눌러 주세요.'],
    [/already registered|already been registered/i, '이미 가입된 이메일입니다.'],
    [/Password should be at least/i, '비밀번호는 6자 이상이어야 합니다.'],
    [/Unable to validate email|invalid format/i, '이메일 형식이 올바르지 않습니다.'],
    [/Signups not allowed/i, '현재 회원가입이 꺼져 있습니다. (Supabase Auth 설정 확인)'],
    [/rate limit|too many/i, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'],
    [/row-level security|permission denied/i, '권한이 없습니다.'],
    [/does not exist|Could not find the (table|function)|schema cache/i, 'DB 구성이 없습니다. supabase/01_schema.sql 을 실행해 주세요.'],
    [/Failed to fetch|NetworkError/i, '네트워크 연결을 확인해 주세요.'],
  ];
  for (const [re, ko] of table) if (re.test(m)) return ko;
  return m || '요청에 실패했습니다.';
}
function fail(error) { console.error(error); toast(koError(error), 'error'); }

// 시간 표시
const clock = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return clock(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return '어제';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.toLocaleDateString('ko-KR');
}
const dayLabel = (ts) => new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

function hue(id = '') {
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}
function avatar(userId, name, cls = '') {
  return h('span', {
    class: `avatar ${cls}`.trim(),
    style: `--av: hsl(${hue(userId || '')} 40% 52%)`,
    title: name,
    text: (name || '?').trim().slice(0, 1).toUpperCase(),
  });
}
const memoIcon = (m, cls = '') => h('span', { class: `memo-icon ${cls}`, style: `--mc: var(--c-${COLORS.includes(m.color) ? m.color : 'yellow'})` });

function nameOf(userId) {
  if (!userId) return '알 수 없음';
  if (userId === uid()) return myName();
  const p = state.profiles.get(userId);
  return p?.display_name || p?.email?.split('@')[0] || '알 수 없는 사용자';
}
const emailOf = (userId) => (userId === uid() ? state.user?.email : state.profiles.get(userId)?.email) || '';
const statusOf = (userId) => (userId === uid() ? state.profile?.status_message : state.profiles.get(userId)?.status_message) || '';

// 친구 관계 계산
const otherOf = (f) => (f.requester_id === uid() ? f.addressee_id : f.requester_id);
const friends = () => state.friendships.filter((f) => f.status === 'accepted')
  .map((f) => ({ id: otherOf(f), fid: f.id }))
  .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id), 'ko'));
const incoming = () => state.friendships.filter((f) => f.status === 'pending' && f.addressee_id === uid());
const outgoing = () => state.friendships.filter((f) => f.status === 'pending' && f.requester_id === uid());
const memoById = (id) => state.memos.find((m) => m.id === id);
const membersOf = (id) => state.membersByMemo.get(id) || [];
const isOwner = (id) => memoById(id)?.my_role === 'owner';

// ---------------------------------------------------------
//  인증 (누구나 가입)
// ---------------------------------------------------------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('.signup-only').hidden = mode !== 'signup';
  $('#auth-submit').textContent = mode === 'signup' ? '회원가입' : '로그인';
  $('#auth-form [name=password]').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  authMsg('');
}
function authMsg(text, type = '') {
  const el = $('#auth-msg');
  el.textContent = text;
  el.className = `form-msg ${type}`;
}
$$('.tab').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = String(f.get('email') || '').trim();
  const password = String(f.get('password') || '');
  const name = String(f.get('name') || '').trim();
  if (!email || !password) return authMsg('이메일과 비밀번호를 입력해 주세요.', 'error');
  if (password.length < 6) return authMsg('비밀번호는 6자 이상이어야 합니다.', 'error');
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    if (authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { name: name || email.split('@')[0] }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('already registered');
      if (!data.session) {
        setAuthMode('login');
        authMsg('인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.', 'ok');
      }
    }
  } catch (err) {
    authMsg(koError(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

let bootedFor;
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0); // 콜백 안에서 바로 호출하면 교착될 수 있음
});

async function onSession(session) {
  const id = session?.user?.id || null;
  if (session) state.user = session.user;
  if (id === bootedFor) return;
  bootedFor = id;
  $('#boot').hidden = true;
  if (!id) {
    await teardown();
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
    return;
  }
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await boot();
}

async function boot() {
  await loadProfile();
  renderMe();
  setTab('friends', false);
  fill($('#list-body'), h('div', { class: 'list-empty' }, h('span', { class: 'spinner' })));
  await Promise.all([loadFriends(), loadMemos()]);
  await loadProfiles();
  state.loaded = true;
  renderList();
  renderBadges();
  subscribe();
}

async function teardown() {
  closeRoom();
  $$('dialog[open]').forEach((d) => d.close());
  const ch = state.channel;
  state.channel = null;
  if (ch) { try { await sb.removeChannel(ch); } catch { /* 무시 */ } }
  Object.assign(state, {
    profile: null, friendships: [], profiles: new Map(), memos: [], membersByMemo: new Map(),
    room: null, loaded: false, search: '',
  });
  if (!bootedFor) state.user = null;
}

$('#btn-logout').addEventListener('click', async () => {
  if (!confirm('로그아웃할까요?')) return;
  await sb.auth.signOut();
});

// ---------------------------------------------------------
//  데이터
// ---------------------------------------------------------
async function loadProfile() {
  const { data, error } = await sb.from('profiles').select('*').eq('id', uid()).maybeSingle();
  if (error) { fail(error); return; }
  if (data) { state.profile = data; return; }
  const ins = await sb.from('profiles').insert({
    id: uid(), email: state.user.email,
    display_name: state.user.user_metadata?.name || state.user.email.split('@')[0],
  }).select().single();
  state.profile = ins.data || null;
}

async function loadFriends() {
  const { data, error } = await sb.from('friendships').select('*').order('created_at', { ascending: false });
  if (error) { fail(error); return; }
  state.friendships = data || [];
}

async function loadMemos() {
  const { data, error } = await sb.rpc('my_memos');
  if (error) { fail(error); return; }
  state.memos = data || [];
  const mm = await sb.from('memo_members').select('memo_id, user_id, role');
  if (mm.error) { console.warn(mm.error); return; }
  const by = new Map();
  for (const r of mm.data || []) {
    if (!by.has(r.memo_id)) by.set(r.memo_id, []);
    by.get(r.memo_id).push(r);
  }
  state.membersByMemo = by;
}

async function loadProfiles() {
  const ids = new Set();
  state.friendships.forEach((f) => ids.add(otherOf(f)));
  for (const list of state.membersByMemo.values()) list.forEach((r) => ids.add(r.user_id));
  state.memos.forEach((m) => { if (m.last_sender_id) ids.add(m.last_sender_id); });
  state.room?.messages.forEach((m) => { if (m.user_id) ids.add(m.user_id); });
  ids.delete(uid());
  const need = [...ids].filter(Boolean);
  if (!need.length) return;
  const { data, error } = await sb.from('profiles').select('id, display_name, email, status_message').in('id', need);
  if (error) { console.warn(error); return; }
  for (const p of data || []) state.profiles.set(p.id, p);
}

const refreshAll = debounce(async () => {
  if (!uid()) return;
  await Promise.all([loadFriends(), loadMemos()]);
  await loadProfiles();
  renderList();
  renderBadges();
  if (state.room) {
    if (!memoById(state.room.id)) {
      closeRoom();
      toast('이 메모장에 대한 접근 권한이 없어졌습니다.');
    } else {
      renderRoomHead();
      if (!$('#drawer').hidden) renderDrawer();
    }
  }
  if ($('#dlg-friend').open && friendDialogId) renderFriendDialog();
}, 200);

// ---------------------------------------------------------
//  왼쪽 메뉴 / 목록
// ---------------------------------------------------------
function setTab(tab, doRender = true) {
  state.tab = tab;
  state.search = '';
  $('#search-input').value = '';
  $('#list-search').hidden = true;
  $$('.rail-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#list-title').textContent = tab === 'friends' ? '친구' : '메모장';
  $('#add-icon').innerHTML = tab === 'friends' ? ICON_ADD_FRIEND : ICON_ADD_MEMO;
  $('#btn-add').title = tab === 'friends' ? '친구 추가' : '새 메모장';
  $('#btn-add').setAttribute('aria-label', $('#btn-add').title);
  $('#search-input').placeholder = tab === 'friends' ? '친구 이름 검색' : '메모장 이름 검색';
  if (doRender) renderList();
}
$$('.rail-btn[data-tab]').forEach((b) => b.addEventListener('click', () => {
  setTab(b.dataset.tab);
  if (window.matchMedia('(max-width: 860px)').matches) closeRoom();
}));
$('#btn-search').addEventListener('click', () => {
  const box = $('#list-search');
  box.hidden = !box.hidden;
  if (!box.hidden) $('#search-input').focus();
  else { state.search = ''; $('#search-input').value = ''; renderList(); }
});
$('#search-input').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
$('#btn-add').addEventListener('click', () => (state.tab === 'friends' ? openAddFriend() : openNewMemo()));

function renderBadges() {
  const n = incoming().length;
  $('#badge-friends').textContent = n ? String(n) : '';
  const unread = state.memos.reduce((s, m) => s + (m.id === state.room?.id ? 0 : m.unread || 0), 0);
  $('#badge-memos').textContent = unread ? (unread > 99 ? '99+' : String(unread)) : '';
}

function renderMe() {
  fill($('#rail-avatar'), avatar(uid(), myName()));
}

function renderList() {
  if (!state.loaded) return;
  if (state.tab === 'friends') renderFriendList();
  else renderMemoList();
}

const matches = (text) => !state.search.trim() || String(text || '').toLowerCase().includes(state.search.trim().toLowerCase());

function renderFriendList() {
  const body = $('#list-body');
  const fr = friends().filter((f) => matches(nameOf(f.id)));
  const inc = incoming();
  const out = outgoing();

  const meRow = h('button', { class: 'row me-row', onclick: openProfile },
    avatar(uid(), myName(), 'lg'),
    h('span', { class: 'text' },
      h('span', { class: 'name', text: myName() }),
      h('span', { class: 'sub', text: state.profile?.status_message || '상태메시지를 입력해 보세요' })),
  );

  const incSec = inc.length && !state.search ? h('div', { class: 'sec' },
    h('div', { class: 'sec-title' }, h('span', { text: `받은 친구 요청 ${inc.length}` })),
    inc.map((f) => h('div', { class: 'row' },
      avatar(f.requester_id, nameOf(f.requester_id)),
      h('span', { class: 'text' },
        h('span', { class: 'name', text: nameOf(f.requester_id) }),
        h('span', { class: 'sub', text: emailOf(f.requester_id) })),
      h('span', { class: 'actions' },
        h('button', { class: 'btn small primary', text: '수락', onclick: (e) => acceptFriend(f, e.currentTarget) }),
        h('button', { class: 'btn small ghost', text: '거절', onclick: () => deleteFriendship(f, '친구 요청을 거절했습니다.') })),
    )),
  ) : null;

  const outSec = out.length && !state.search ? h('div', { class: 'sec' },
    h('div', { class: 'sec-title' }, h('span', { text: `보낸 친구 요청 ${out.length}` })),
    out.map((f) => h('div', { class: 'row' },
      avatar(f.addressee_id, nameOf(f.addressee_id)),
      h('span', { class: 'text' },
        h('span', { class: 'name', text: nameOf(f.addressee_id) }),
        h('span', { class: 'sub', text: '수락을 기다리는 중' })),
      h('span', { class: 'actions' },
        h('button', { class: 'btn small ghost', text: '취소', onclick: () => deleteFriendship(f, '친구 요청을 취소했습니다.') })),
    )),
  ) : null;

  const friendSec = h('div', { class: 'sec' },
    h('div', { class: 'sec-title' }, h('span', { text: `친구 ${friends().length}` })),
    fr.length
      ? fr.map((f) => h('button', { class: 'row', onclick: () => openFriend(f.id) },
        avatar(f.id, nameOf(f.id)),
        h('span', { class: 'text' },
          h('span', { class: 'name', text: nameOf(f.id) }),
          statusOf(f.id) ? h('span', { class: 'sub', text: statusOf(f.id) }) : null),
      ))
      : h('div', { class: 'list-empty' },
        state.search ? '검색 결과가 없습니다.' : ['아직 친구가 없습니다.', h('br'), '이메일로 친구 요청을 보내 보세요.'],
        !state.search ? h('div', {}, h('button', { class: 'btn primary', text: '친구 추가', onclick: openAddFriend })) : null),
  );

  fill(body, state.search ? null : h('div', { class: 'sec' }, meRow), incSec, outSec, friendSec);
}

function renderMemoList() {
  const body = $('#list-body');
  const list = state.memos.filter((m) => matches(m.title));
  if (!state.memos.length) {
    fill(body, h('div', { class: 'list-empty' },
      '아직 메모장이 없습니다.', h('br'), '메모장을 만들고 함께 쓸 친구를 초대해 보세요.',
      h('div', {}, h('button', { class: 'btn primary', text: '＋ 새 메모장', onclick: openNewMemo }))));
    return;
  }
  if (!list.length) { fill(body, h('div', { class: 'list-empty', text: '검색 결과가 없습니다.' })); return; }

  fill(body, h('div', { class: 'sec' }, list.map((m) => {
    let preview = m.last_message || '';
    if (m.last_sender_id) preview = `${m.last_sender_id === uid() ? '나' : nameOf(m.last_sender_id)}: ${preview}`;
    const unread = m.id === state.room?.id ? 0 : m.unread;
    return h('button', { class: `row ${state.room?.id === m.id ? 'active' : ''}`, onclick: () => openRoom(m.id) },
      memoIcon(m),
      h('span', { class: 'text' },
        h('span', { class: 'name' }, m.title, h('span', { class: 'memo-count', text: m.member_count })),
        h('span', { class: 'sub', text: preview })),
      h('span', { class: 'side' },
        h('span', { class: 'time', text: listTime(m.last_message_at) }),
        unread ? h('span', { class: 'badge', text: unread > 99 ? '99+' : unread }) : null),
    );
  })));
}

// ---------------------------------------------------------
//  친구 추가 / 수락 / 삭제
// ---------------------------------------------------------
function openAddFriend() {
  $('#add-friend-form').reset();
  $('#add-friend-msg').textContent = '';
  $('#dlg-add-friend').showModal();
}
$('#add-friend-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = String(new FormData(e.target).get('email') || '').trim();
  const msg = $('#add-friend-msg');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.className = 'form-msg error'; msg.textContent = '이메일 형식을 확인해 주세요.'; return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc('send_friend_request', { p_email: email });
  if (btn) btn.disabled = false;
  if (error) { msg.className = 'form-msg error'; msg.textContent = koError(error); return; }
  const text = {
    sent: '친구 요청을 보냈습니다. 상대가 수락하면 친구가 됩니다.',
    pending: '이미 요청을 보냈습니다. 상대의 수락을 기다리는 중입니다.',
    accepted: '상대도 나에게 요청을 보냈었네요. 바로 친구가 되었습니다!',
    already: '이미 친구입니다.',
  }[data] || '완료했습니다.';
  $('#dlg-add-friend').close();
  toast(text, 'ok');
  await loadFriends(); await loadProfiles();
  renderList(); renderBadges();
});

async function acceptFriend(f, btn) {
  if (btn) btn.disabled = true;
  const { error } = await sb.rpc('accept_friend_request', { p_id: f.id });
  if (error) { if (btn) btn.disabled = false; return fail(error); }
  toast(`${nameOf(f.requester_id)}님과 친구가 되었습니다.`, 'ok');
  await loadFriends();
  renderList(); renderBadges();
}

async function deleteFriendship(f, message) {
  const { error } = await sb.from('friendships').delete().eq('id', f.id);
  if (error) return fail(error);
  toast(message);
  await loadFriends();
  renderList(); renderBadges();
  if ($('#dlg-friend').open) $('#dlg-friend').close();
}

// 친구 프로필
let friendDialogId = null;
function openFriend(id) {
  friendDialogId = id;
  renderFriendDialog();
  $('#dlg-friend').showModal();
}
$('#dlg-friend').addEventListener('close', () => { friendDialogId = null; });

function renderFriendDialog() {
  const id = friendDialogId;
  const f = state.friendships.find((x) => x.status === 'accepted' && otherOf(x) === id);
  const shared = state.memos.filter((m) => membersOf(m.id).some((r) => r.user_id === id));
  fill($('#friend-body'),
    h('div', { class: 'profile-card' },
      avatar(id, nameOf(id), 'xl'),
      h('h3', { text: nameOf(id) }),
      h('p', { text: emailOf(id) }),
      statusOf(id) ? h('p', { class: 'status', text: statusOf(id) }) : null),
    h('div', { class: 'profile-actions' },
      h('button', { class: 'btn primary', text: '이 친구와 새 메모장 만들기', onclick: () => { $('#dlg-friend').close(); openNewMemo([id]); } })),
    h('div', { class: 'shared-list' },
      h('h4', { text: `함께 쓰는 메모장 ${shared.length}` }),
      shared.length
        ? shared.map((m) => h('button', { class: 'row', onclick: () => { $('#dlg-friend').close(); setTab('memos'); openRoom(m.id); } },
          memoIcon(m, 'sm'),
          h('span', { class: 'text' }, h('span', { class: 'name', text: m.title }), h('span', { class: 'sub', text: m.my_role === 'owner' ? '내가 만든 메모장' : `${nameOf(m.owner_id)}님의 메모장` }))))
        : h('p', { class: 'hint', text: '아직 함께 쓰는 메모장이 없습니다. 친구라도 내가 초대한 메모장만 볼 수 있습니다.' })),
    f ? h('div', { class: 'profile-actions' },
      h('button', {
        class: 'btn danger-ghost', text: '친구 삭제',
        onclick: () => { if (confirm(`${nameOf(id)}님을 친구에서 삭제할까요? 이미 함께 쓰는 메모장은 그대로 유지됩니다.`)) deleteFriendship(f, '친구를 삭제했습니다.'); },
      })) : null,
  );
}

// 내 프로필
function openProfile() {
  $('#profile-form [name=display_name]').value = myName();
  $('#profile-form [name=status_message]').value = state.profile?.status_message || '';
  $('#profile-email').textContent = `로그인 이메일: ${state.user?.email || ''}`;
  $('#dlg-profile').showModal();
}
$('#btn-profile').addEventListener('click', openProfile);
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const display_name = String(f.get('display_name') || '').trim();
  const status_message = String(f.get('status_message') || '').trim() || null;
  if (!display_name) return;
  const { data, error } = await sb.from('profiles').update({ display_name, status_message }).eq('id', uid()).select().single();
  if (error) return fail(error);
  state.profile = data;
  $('#dlg-profile').close();
  renderMe(); renderList();
  if (state.room) renderMessages(false);
  toast('프로필을 저장했습니다.', 'ok');
});

// ---------------------------------------------------------
//  새 메모장
// ---------------------------------------------------------
let newMemoColor = 'yellow';
function friendPicker(container, list, preselected = [], onChange = () => {}) {
  if (!list.length) {
    fill(container, h('div', { class: 'pick-empty' },
      '초대할 수 있는 친구가 없습니다.',
      h('div', { style: 'margin-top:10px' }, h('button', {
        type: 'button', class: 'btn small', text: '친구 추가하기',
        onclick: () => { $$('dialog[open]').forEach((d) => d.close()); setTab('friends'); openAddFriend(); },
      }))));
    return () => [];
  }
  const boxes = list.map((id) => {
    const cb = h('input', { type: 'checkbox', value: id, checked: preselected.includes(id), onchange: () => onChange(selected()) });
    return { id, cb, el: h('label', { class: 'pick' }, cb, avatar(id, nameOf(id), 'sm'),
      h('span', { class: 'text' }, h('b', { text: nameOf(id) }), h('small', { text: statusOf(id) || emailOf(id) }))) };
  });
  const selected = () => boxes.filter((b) => b.cb.checked).map((b) => b.id);
  fill(container, boxes.map((b) => b.el));
  onChange(selected());
  return selected;
}
let getNewMemoMembers = () => [];
function openNewMemo(preselected = []) {
  $('#new-memo-form').reset();
  newMemoColor = 'yellow';
  renderColorPicker($('#new-memo-colors'), newMemoColor, (c) => { newMemoColor = c; });
  getNewMemoMembers = friendPicker($('#new-memo-picker'), friends().map((f) => f.id), preselected,
    (sel) => { $('#new-memo-picked').textContent = sel.length ? `${sel.length}명 선택` : '(선택 안 하면 나만 보기)'; });
  $('#dlg-new-memo').showModal();
  $('#new-memo-form [name=title]').focus();
}
function renderColorPicker(container, current, onPick) {
  fill(container, COLORS.map((c) => h('button', {
    type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(c === current),
    title: COLOR_LABEL[c], 'aria-label': COLOR_LABEL[c], style: `--sw: var(--c-${c})`,
    onclick: () => { onPick(c); renderColorPicker(container, c, onPick); },
  })));
}
$('#new-memo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = String(new FormData(e.target).get('title') || '').trim();
  if (!title) return;
  const btn = e.submitter; if (btn) btn.disabled = true;
  const { data: id, error } = await sb.rpc('create_memo', { p_title: title, p_color: newMemoColor, p_members: getNewMemoMembers() });
  if (btn) btn.disabled = false;
  if (error) return fail(error);
  $('#dlg-new-memo').close();
  await loadMemos(); await loadProfiles();
  setTab('memos');
  openRoom(id);
});

// ---------------------------------------------------------
//  메모장(대화) 화면
// ---------------------------------------------------------
const elMessages = $('#messages');
const elInput = $('#msg-input');

async function openRoom(id) {
  const m = memoById(id);
  if (!m) return;
  if (state.room?.id === id) { document.body.classList.add('room-open'); return; }
  state.room = { id, messages: [], hasMore: false, loading: true, query: '' };
  $('#drawer').hidden = true;
  $('#room-search').hidden = true;
  $('#room-search-input').value = '';
  $('#room-empty').hidden = true;
  $('#room-inner').hidden = false;
  document.body.classList.add('room-open');
  renderRoomHead();
  fill(elMessages, h('div', { class: 'sys-msg', text: '불러오는 중…' }));
  elInput.value = '';
  updateSendBtn();
  renderList();

  const { data, error } = await sb.from('memo_messages').select('*').eq('memo_id', id)
    .order('created_at', { ascending: false }).limit(PAGE);
  if (state.room?.id !== id) return;
  if (error) { fail(error); return; }
  state.room.messages = (data || []).reverse();
  state.room.hasMore = (data || []).length === PAGE;
  state.room.loading = false;
  await loadProfiles();
  renderMessages(true);
  markRead(id);
  if (!window.matchMedia('(max-width: 860px)').matches) elInput.focus();
}

function closeRoom() {
  state.room = null;
  document.body.classList.remove('room-open');
  $('#room-inner').hidden = true;
  $('#room-empty').hidden = false;
  $('#room').dataset.color = 'yellow';
  if (state.loaded) renderList();
}
$('#room-back').addEventListener('click', closeRoom);

function renderRoomHead() {
  const m = memoById(state.room?.id);
  if (!m) return;
  $('#room').dataset.color = COLORS.includes(m.color) ? m.color : 'yellow';
  fill($('#room-icon'), memoIcon(m, 'sm'));
  $('#room-title').textContent = m.title;
  const members = membersOf(m.id);
  $('#room-count').textContent = members.length || m.member_count;
  fill($('#room-who'), members.slice(0, 5).map((r) => avatar(r.user_id, nameOf(r.user_id), 'xs')));
}

const sameGroup = (a, b) => a && b && a.kind === 'text' && b.kind === 'text' && a.user_id === b.user_id
  && Math.abs(new Date(a.created_at) - new Date(b.created_at)) < 60_000
  && dayKey(a.created_at) === dayKey(b.created_at);

function highlight(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(ql, i);
    if (j < 0) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, j), h('mark', { text: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  return out;
}

function renderMessages(scrollToBottom) {
  const room = state.room;
  if (!room) return;
  const prevHeight = elMessages.scrollHeight;
  const prevTop = elMessages.scrollTop;
  const nearBottom = prevHeight - prevTop - elMessages.clientHeight < 120;
  const q = room.query.trim();
  const msgs = room.messages;
  const ownerView = isOwner(room.id);
  const nodes = [];
  let hits = 0;
  let firstHit = null;

  if (room.hasMore) nodes.push(h('button', { class: 'btn small load-more', text: '이전 메모 더 보기', onclick: loadOlder }));
  if (!msgs.length) nodes.push(h('div', { class: 'sys-msg', text: '아직 메모가 없습니다. 첫 메모를 남겨 보세요.' }));

  msgs.forEach((m, i) => {
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) nodes.push(h('div', { class: 'day-sep', text: dayLabel(m.created_at) }));
    if (m.kind === 'system') { nodes.push(h('div', { class: 'sys-msg', text: m.body })); return; }

    const mine = m.user_id === uid();
    const first = !sameGroup(prev, m);
    const last = !sameGroup(m, next);
    const hit = q && m.body.toLowerCase().includes(q.toLowerCase());
    if (hit) hits += 1;
    const canDel = mine || ownerView;
    const el = h('div', { class: `msg ${mine ? 'mine' : ''} ${first ? 'first' : ''} ${hit ? 'hit' : ''}`.trim(), 'data-id': m.id },
      mine ? null : h('div', { class: 'av-slot' }, first ? avatar(m.user_id, nameOf(m.user_id)) : null),
      h('div', { class: 'body' },
        !mine && first ? h('div', { class: 'author', text: nameOf(m.user_id) }) : null,
        h('div', { class: 'line' },
          h('div', { class: 'bubble' }, highlight(m.body, q)),
          h('div', { class: 'meta' },
            canDel ? h('button', { class: 'del', title: '삭제', 'aria-label': '메모 삭제', text: '삭제', onclick: () => deleteMessage(m) }) : null,
            last ? h('time', { text: clock(m.created_at), title: new Date(m.created_at).toLocaleString('ko-KR') }) : null),
        ),
      ),
    );
    if (hit && !firstHit) firstHit = el;
    nodes.push(el);
  });

  fill(elMessages, nodes);
  $('#room-search-count').textContent = q ? `${hits}건` : '';
  if (q && firstHit) firstHit.scrollIntoView({ block: 'center' });
  else if (scrollToBottom === true || (scrollToBottom !== false && nearBottom)) elMessages.scrollTop = elMessages.scrollHeight;
  else if (scrollToBottom === 'keep') elMessages.scrollTop = elMessages.scrollHeight - prevHeight + prevTop;
  else elMessages.scrollTop = prevTop;
}

async function loadOlder() {
  const room = state.room;
  if (!room || room.loading || !room.messages.length) return;
  room.loading = true;
  const oldest = room.messages[0].created_at;
  const { data, error } = await sb.from('memo_messages').select('*').eq('memo_id', room.id)
    .lt('created_at', oldest).order('created_at', { ascending: false }).limit(PAGE);
  room.loading = false;
  if (state.room !== room) return;
  if (error) return fail(error);
  room.messages = [...(data || []).reverse(), ...room.messages];
  room.hasMore = (data || []).length === PAGE;
  await loadProfiles();
  renderMessages('keep');
}

function updateSendBtn() { $('#send-btn').disabled = !elInput.value.trim(); }
elInput.addEventListener('input', updateSendBtn);
elInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const room = state.room;
  const body = elInput.value.trim();
  if (!room || !body) return;
  elInput.value = '';
  updateSendBtn();
  const { data, error } = await sb.from('memo_messages').insert({ memo_id: room.id, user_id: uid(), body }).select().single();
  if (error) { elInput.value = body; updateSendBtn(); return fail(error); }
  if (state.room === room && !room.messages.some((m) => m.id === data.id)) {
    room.messages.push(data);
    renderMessages(true);
  }
  const m = memoById(room.id);
  if (m) { m.last_message = body; m.last_sender_id = uid(); m.last_message_at = data.created_at; }
  state.memos.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  renderList();
});

async function deleteMessage(msg) {
  if (!confirm('이 메모를 삭제할까요?')) return;
  const { data, error } = await sb.from('memo_messages').delete().eq('id', msg.id).select('id');
  if (error) return fail(error);
  if (!data?.length) return toast('삭제 권한이 없습니다.', 'error');
  if (state.room) {
    state.room.messages = state.room.messages.filter((m) => m.id !== msg.id);
    renderMessages(false);
  }
  refreshAll();
}

const markRead = debounce(async (id) => {
  if (document.hidden || state.room?.id !== id) return;
  await sb.rpc('mark_read', { p_memo: id });
  const m = memoById(id);
  if (m) m.unread = 0;
  renderBadges();
}, 300);

// 메모장 안 검색
$('#room-search-btn').addEventListener('click', () => {
  const box = $('#room-search');
  box.hidden = !box.hidden;
  if (!box.hidden) $('#room-search-input').focus();
  else if (state.room) { state.room.query = ''; $('#room-search-input').value = ''; renderMessages(true); }
});
$('#room-search-input').addEventListener('input', debounce((e) => {
  if (!state.room) return;
  state.room.query = e.target.value;
  renderMessages(false);
}, 150));

// ---------------------------------------------------------
//  참여자·설정 패널
// ---------------------------------------------------------
function openDrawer() { renderDrawer(); $('#drawer').hidden = false; }
$('#room-menu-btn').addEventListener('click', () => ($('#drawer').hidden ? openDrawer() : ($('#drawer').hidden = true)));
$('#room-members-btn').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; });

function renderDrawer() {
  const m = memoById(state.room?.id);
  if (!m) return;
  const owner = m.my_role === 'owner';
  const members = [...membersOf(m.id)].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'ko')));
  const memberIds = new Set(members.map((r) => r.user_id));

  // 정보
  let info;
  if (owner) {
    const title = h('input', { maxlength: '100', 'aria-label': '메모장 이름' });
    title.value = m.title;
    const colors = h('div', { class: 'swatches' });
    renderColorPicker(colors, m.color, (c) => updateMemo(m.id, { color: c }));
    info = h('div', { class: 'sec' },
      h('div', { class: 'sec-title' }, h('span', { text: '메모장 정보' })),
      h('div', { class: 'drawer-pad' },
        h('div', { class: 'inline' }, title, h('button', {
          class: 'btn small', text: '변경',
          onclick: () => { const t = title.value.trim(); if (t && t !== m.title) updateMemo(m.id, { title: t }); },
        })),
        h('div', { style: 'margin-top:12px' }, colors)));
  } else {
    info = h('div', { class: 'sec' },
      h('div', { class: 'sec-title' }, h('span', { text: '메모장 정보' })),
      h('div', { class: 'drawer-pad' }, h('p', { class: 'hint', text: `${nameOf(m.owner_id)}님이 만든 메모장입니다. 방장만 친구를 초대할 수 있습니다.` })));
  }

  // 참여자
  const memberSec = h('div', { class: 'sec' },
    h('div', { class: 'sec-title' }, h('span', { text: `참여자 ${members.length}` })),
    members.map((r) => h('div', { class: 'row' },
      avatar(r.user_id, nameOf(r.user_id), 'sm'),
      h('span', { class: 'text' },
        h('span', { class: 'name' }, nameOf(r.user_id), r.user_id === uid() ? h('span', { class: 'muted', text: ' (나)' }) : null),
        h('span', { class: 'sub', text: statusOf(r.user_id) || emailOf(r.user_id) })),
      r.role === 'owner' ? h('span', { class: 'tag owner', text: '방장' }) : null,
      owner && r.role !== 'owner'
        ? h('button', { class: 'btn small ghost', text: '내보내기', onclick: () => removeMember(m.id, r.user_id) })
        : null,
    )));

  // 친구 초대 (방장)
  let inviteSec = null;
  if (owner) {
    const candidates = friends().map((f) => f.id).filter((id) => !memberIds.has(id));
    const picker = h('div', { class: 'picker' });
    const inviteBtn = h('button', { class: 'btn primary small', text: '초대하기', disabled: true });
    const get = friendPicker(picker, candidates, [], (sel) => {
      inviteBtn.disabled = !sel.length;
      inviteBtn.textContent = sel.length ? `${sel.length}명 초대하기` : '초대하기';
    });
    inviteBtn.addEventListener('click', async () => {
      const ids = get();
      if (!ids.length) return;
      inviteBtn.disabled = true;
      const { error } = await sb.rpc('add_memo_members', { p_memo: m.id, p_members: ids });
      if (error) { inviteBtn.disabled = false; return fail(error); }
      toast(`${ids.map(nameOf).join(', ')}님을 초대했습니다.`, 'ok');
      await loadMemos(); await loadProfiles();
      renderRoomHead(); renderDrawer(); renderList();
    });
    inviteSec = h('div', { class: 'sec' },
      h('div', { class: 'sec-title' }, h('span', { text: '친구 초대' })),
      h('div', { class: 'drawer-pad' },
        h('p', { class: 'hint', style: 'margin-bottom:8px', text: '선택한 친구만 이 메모장을 볼 수 있습니다.' }),
        picker,
        candidates.length ? h('div', { style: 'margin-top:8px; text-align:right' }, inviteBtn) : null));
  }

  const danger = h('div', { class: 'sec' }, h('div', { class: 'drawer-pad', style: 'padding-top:12px' },
    owner
      ? h('button', { class: 'btn danger-ghost block', text: '메모장 삭제', onclick: () => deleteMemo(m) })
      : h('button', { class: 'btn danger-ghost block', text: '메모장 나가기', onclick: () => leaveMemo(m) })));

  fill($('#drawer-body'), info, memberSec, inviteSec, danger);
}

async function updateMemo(id, patch) {
  const { data, error } = await sb.from('memos').update(patch).eq('id', id).select();
  if (error) return fail(error);
  if (!data?.length) return toast('방장만 변경할 수 있습니다.', 'error');
  const m = memoById(id);
  if (m) Object.assign(m, patch);
  renderRoomHead(); renderList(); renderDrawer();
}

async function removeMember(memoId, userId) {
  if (!confirm(`${nameOf(userId)}님을 이 메모장에서 내보낼까요? 더 이상 이 메모장을 볼 수 없습니다.`)) return;
  const { data, error } = await sb.from('memo_members').delete().eq('memo_id', memoId).eq('user_id', userId).select();
  if (error) return fail(error);
  if (!data?.length) return toast('권한이 없습니다.', 'error');
  toast(`${nameOf(userId)}님을 내보냈습니다.`);
  await loadMemos();
  renderRoomHead(); renderDrawer(); renderList();
}

async function leaveMemo(m) {
  if (!confirm(`"${m.title}" 메모장에서 나갈까요? 다시 들어오려면 방장의 초대가 필요합니다.`)) return;
  const { error } = await sb.from('memo_members').delete().eq('memo_id', m.id).eq('user_id', uid());
  if (error) return fail(error);
  closeRoom();
  state.memos = state.memos.filter((x) => x.id !== m.id);
  renderList(); renderBadges();
  toast('메모장에서 나왔습니다.');
}

async function deleteMemo(m) {
  if (!confirm(`"${m.title}" 메모장을 삭제할까요? 모든 메모가 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  const { data, error } = await sb.from('memos').delete().eq('id', m.id).select('id');
  if (error) return fail(error);
  if (!data?.length) return toast('방장만 삭제할 수 있습니다.', 'error');
  closeRoom();
  state.memos = state.memos.filter((x) => x.id !== m.id);
  renderList(); renderBadges();
  toast('메모장을 삭제했습니다.');
}

// ---------------------------------------------------------
//  실시간 (RLS 를 따르므로 권한 있는 변경만 전달됨)
// ---------------------------------------------------------
function subscribe() {
  if (state.channel) return;
  state.channel = sb.channel(`user:${uid()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'memo_messages' }, onMessageEvent)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'memo_members' }, onMemberEvent)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'memos' }, onMemoEvent)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, onFriendEvent)
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('실시간 연결 상태:', status);
    });
}

async function onMessageEvent(p) {
  const room = state.room;
  if (p.eventType === 'INSERT') {
    const msg = p.new;
    if (room && msg.memo_id === room.id && !room.messages.some((m) => m.id === msg.id)) {
      room.messages.push(msg);
      if (msg.user_id && !state.profiles.has(msg.user_id) && msg.user_id !== uid()) await loadProfiles();
      renderMessages();
      markRead(room.id);
    }
  } else if (p.eventType === 'DELETE' && room) {
    const before = room.messages.length;
    room.messages = room.messages.filter((m) => m.id !== p.old?.id);
    if (room.messages.length !== before) renderMessages(false);
  }
  refreshAll();
}

async function onMemberEvent(p) {
  if (p.eventType === 'INSERT' && p.new?.user_id === uid() && p.new.role === 'member') {
    await loadMemos(); await loadProfiles();
    renderList(); renderBadges();
    const m = memoById(p.new.memo_id);
    if (m) toast(`"${m.title}" 메모장에 초대되었습니다.`, 'ok', { label: '열기', onClick: () => { setTab('memos'); openRoom(m.id); } });
    return;
  }
  if (p.eventType === 'DELETE' && p.old?.user_id === uid() && state.room?.id === p.old.memo_id) {
    closeRoom();
    toast('이 메모장에서 내보내졌습니다.');
  }
  refreshAll();
}

function onMemoEvent(p) {
  if (p.eventType === 'DELETE' && state.room?.id === p.old?.id && !isOwner(p.old.id)) {
    closeRoom();
    toast('방장이 메모장을 삭제했습니다.');
  }
  refreshAll();
}

async function onFriendEvent(p) {
  const f = p.new;
  if (p.eventType === 'INSERT' && f?.addressee_id === uid()) {
    await loadFriends(); await loadProfiles();
    toast(`${nameOf(f.requester_id)}님이 친구 요청을 보냈습니다.`, 'ok', { label: '보기', onClick: () => setTab('friends') });
  } else if (p.eventType === 'UPDATE' && f?.status === 'accepted' && f.requester_id === uid()) {
    await loadFriends(); await loadProfiles();
    toast(`${nameOf(f.addressee_id)}님과 친구가 되었습니다.`, 'ok');
  }
  refreshAll();
}

// ---------------------------------------------------------
//  기타
// ---------------------------------------------------------
$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.loaded) return;
  refreshAll();
  if (state.room) markRead(state.room.id);
});

setInterval(() => { if (state.loaded && !document.hidden && state.tab === 'memos') renderMemoList(); }, 60_000);
