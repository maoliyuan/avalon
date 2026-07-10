'use strict';

/* ============================================================
 * 阿瓦隆记牌器 —— 纯前端，数据全部存在本机（localStorage）
 * ============================================================ */

/* 可标记的身份清单：想增删角色，直接改这个数组即可 */
const IDENTITIES = ['好人', '坏人', '梅林', '派西维尔', '忠臣', '刺客', '莫甘娜', '莫德雷德', '奥伯伦', '爪牙', '蓝兰斯洛特', '红兰斯洛特'];

/* 确定度（可叠加，一个号码可挂多条）
 * 「最终是」= 揭底后的真实身份（金色），是喂给下游分析的「标准答案」标签；
 * 其余四档是主观猜测。 */
const CERTAINTIES = [
  { code: 'final',    label: '最终是',   glyph: '★' },
  { code: 'is',       label: '确定是',   glyph: '✓' },
  { code: 'maybe',    label: '可能是',   glyph: '?' },
  { code: 'maybenot', label: '可能不是', glyph: '?' },
  { code: 'isnt',     label: '确定不是', glyph: '✕' },
];
const CERT_LABEL = Object.fromEntries(CERTAINTIES.map(c => [c.code, c]));

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;
const LS_KEY = 'avalon_tracker_v1';

/* ---------------- 实时助手：频道 & 角色常量 ---------------- */
const NTFY_DEFAULT_BASE = 'https://ntfy.sh';
const CHANNEL_WINDOW = 600;     // 频道轮换窗口(秒)=10min，必须和本地 workflow 一致
// 内置盐：与本地 channel.py 的 CHANNEL_SALT 必须一致。默认用它 => 手机/电脑都不用手动传密钥
const CHANNEL_SALT = 'avalon-tracker-shared-v1';
const STANDARD_EVIL = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4 };
const CONFIG_ROLES = ['梅林', '派西维尔', '莫甘娜', '刺客', '莫德雷德', '奥伯伦', '蓝兰斯洛特', '红兰斯洛特'];
const MY_ROLES = ['梅林', '派西维尔', '忠臣', '刺客', '莫甘娜', '莫德雷德', '奥伯伦', '爪牙', '蓝兰斯洛特', '红兰斯洛特'];
const GOOD_ROLES = new Set(['好人', '梅林', '派西维尔', '忠臣', '蓝兰斯洛特']);
const EVIL_ROLES = new Set(['坏人', '刺客', '莫甘娜', '莫德雷德', '奥伯伦', '爪牙', '红兰斯洛特']);
function factionOf(role) { return role ? (GOOD_ROLES.has(role) ? 'good' : 'evil') : null; }

/* ---------------- 密码闸门（纯客户端，仅用于挡住路人）----------------
 * 注意：静态网页无后端，此校验可被懂技术者绕过；仅防随手乱点。
 * PASSWORD_HASH = 你的密码的 SHA-256（十六进制小写）。
 *   当前是临时密码「avalon」，请务必改成你自己的：
 *   Mac 终端执行：  printf '你的密码' | shasum -a 256
 *   把输出前面那串 64 位十六进制粘到下面即可（不要带空格和文件名）。
 */
const PASSWORD_HASH = '657cd4d68c6a6e51740f32894b11446e720096f954c4faa6b7bdb708e4b8e215';
const AUTH_KEY = 'avalon_auth_v1';
const UNLOCK_HOURS = 8;

/* ---------------- 数据模型 ---------------- */
let idSeq = 0;
function genId(prefix) { return prefix + Date.now().toString(36) + (idSeq++).toString(36); }

function freshResult() {
  return { winner: null, missions: [], assassinTarget: null, assassinHitMerlin: null };
}
function freshGame(count) {
  return {
    id: genId('g'),
    createdAt: new Date().toISOString(),
    playerCount: count || 10,
    players: {},        // 号码 -> { tags:[{c,id}] }
    rounds: [],
    seats: {},          // 座位号 -> 真实玩家 id
    result: freshResult(),
    config: { evilCount: null, roles: [] },   // 本局配置(坏人数/在场特殊角色)
    me: { seat: null, role: null },           // 我的座位/身份
    night: { evilsSeen: [], thumbs: [], evilAllies: [] }, // 夜间私密情报(硬事实)
    review: '',                               // 一整局复盘文字
    analyzeSeq: 0,                            // 「用助手分析」递增序号
  };
}
/* 兼容旧存档：补齐后加的字段 */
function migrateGame(g) {
  if (!g) return g;
  if (!g.id) g.id = genId('g');
  if (!g.createdAt) g.createdAt = new Date().toISOString();
  if (!g.players) g.players = {};
  if (!Array.isArray(g.rounds)) g.rounds = [];
  if (!g.seats) g.seats = {};
  if (!g.result) g.result = freshResult();
  if (!g.config) g.config = { evilCount: null, roles: [] };
  if (!g.me) g.me = { seat: null, role: null };
  if (!g.night) g.night = { evilsSeen: [], thumbs: [], evilAllies: [] };
  else if (Array.isArray(g.night.evilAllies)) {
    // 旧格式 evilAllies:[int] -> 新格式 [{seat,role}]
    g.night.evilAllies = g.night.evilAllies.map(a => (a && typeof a === 'object') ? a : { seat: a, role: null });
  }
  if (typeof g.review !== 'string') g.review = '';
  if (typeof g.analyzeSeq !== 'number') g.analyzeSeq = 0;
  return g;
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.current && Array.isArray(s.current.rounds)) {
      s.roster = Array.isArray(s.roster) ? s.roster : [];
      s.archive = Array.isArray(s.archive) ? s.archive : [];
      s.seatsDay = (typeof s.seatsDay === 'string') ? s.seatsDay : null;
      s.settings = (s.settings && typeof s.settings === 'object') ? s.settings : {};
      migrateGame(s.current);
      if (s.previous) migrateGame(s.previous);
      s.archive.forEach(migrateGame);
      return s;
    }
  } catch (e) { /* 损坏则重建 */ }
  return { current: freshGame(10), previous: null, roster: [], archive: [], seatsDay: beijingDay(), settings: {} };
}
let store = loadStore();
function save() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
function G() { return store.current; }

/* ---------------- 真实玩家名册 & 座位指派 ---------------- */
function personName(id) { const p = store.roster.find(x => x.id === id); return p ? p.name : null; }
function addPerson(name) {
  name = (name || '').trim();
  if (!name) return null;
  const p = { id: genId('p'), name };
  store.roster.push(p); save(); return p;
}
function renamePerson(id, name) {
  name = (name || '').trim(); if (!name) return;
  const p = store.roster.find(x => x.id === id);
  if (p) { p.name = name; save(); }
}
function deletePerson(id) {
  store.roster = store.roster.filter(x => x.id !== id);
  const unbind = g => { if (g && g.seats) Object.keys(g.seats).forEach(k => { if (g.seats[k] === id) delete g.seats[k]; }); };
  unbind(store.current); unbind(store.previous); (store.archive || []).forEach(unbind);
  save();
}
function seatPerson(num) { return G().seats[num] || null; }
function assignSeat(num, personId) {
  const g = G();
  if (personId) {
    // 同一个人一局只占一个座位：先从其它座位解绑
    Object.keys(g.seats).forEach(k => { if (g.seats[k] === personId) delete g.seats[k]; });
    g.seats[num] = personId;
  } else {
    delete g.seats[num];
  }
  save();
}

/* 北京时间(UTC+8)日期串 YYYY-MM-DD —— 座位「每天 0 点重置」的判据 */
function beijingDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  } catch (e) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);   // 兜底：手动 +8 小时
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
}
/* 跨天则重置当前局座位；名册(store.roster)始终保留。返回是否发生了重置。 */
function ensureSeatDay() {
  const today = beijingDay();
  if (store.seatsDay == null) { store.seatsDay = today; save(); return false; }
  if (store.seatsDay !== today) { store.current.seats = {}; store.seatsDay = today; save(); return true; }
  return false;
}

/* 身份标记操作 */
function tagsOf(num) {
  const p = G().players[num];
  return p && Array.isArray(p.tags) ? p.tags : [];
}
function hasTag(num, c, id) {
  return tagsOf(num).some(t => t.c === c && t.id === id);
}
function toggleTag(num, c, id) {
  const g = G();
  if (!g.players[num]) g.players[num] = { tags: [] };
  const t = g.players[num].tags;
  const i = t.findIndex(x => x.c === c && x.id === id);
  if (i >= 0) t.splice(i, 1);
  else t.push({ c, id });
  save();
}
function removeTagAt(num, idx) {
  const t = tagsOf(num);
  if (idx >= 0 && idx < t.length) { t.splice(idx, 1); save(); }
}

/* ---------------- DOM 小工具 ---------------- */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const $ = sel => document.querySelector(sel);

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.classList.add('hidden'), 220);
  }, 1600);
}

/* ---------------- 渲染 ---------------- */
let activeTab = 'identity';

function render() {
  $('#count-val').textContent = G().playerCount;
  $('#btn-rollback').disabled = !store.previous;
  ['identity', 'rounds', 'result', 'assist'].forEach(t =>
    $('#tab-' + t).classList.toggle('hidden', activeTab !== t));
  document.querySelectorAll('.tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === activeTab));
  if (activeTab === 'identity') renderIdentity();
  else if (activeTab === 'rounds') renderRounds();
  else if (activeTab === 'result') renderResult();
  else renderAssist();
}

function chipEl(num, tag, idx) {
  const meta = CERT_LABEL[tag.c] || { glyph: '?' };
  return el('span', { class: 'chip ' + tag.c, title: '点击删除', onclick: () => { removeTagAt(num, idx); renderIdentity(); } },
    el('span', { class: 'g' }, meta.glyph),
    tag.id,
    el('span', { class: 'x' }, '×'));
}

function renderIdentity() {
  const box = $('#identity-list');
  box.textContent = '';
  const g = G();
  syncMe(g);   // 标记里确定了自己身份就同步到 me.role
  const n = g.playerCount;
  for (let num = 1; num <= n; num++) {
    const tags = tagsOf(num);
    const chips = el('div', { class: 'chips' });
    if (tags.length === 0) chips.append(el('span', { class: 'empty-tags' }, '暂无标记'));
    else tags.forEach((t, i) => chips.append(chipEl(num, t, i)));

    const pid = seatPerson(num);
    const seatBtn = el('button', {
      class: 'seat-btn' + (pid ? ' has' : ''), type: 'button',
      onclick: () => openSeatSheet(num)
    }, pid ? personName(pid) : '指派玩家');
    const isMe = g.me.seat === num;
    const meBtn = el('button', {
      class: 'me-btn' + (isMe ? ' on' : ''), type: 'button',
      onclick: () => { setMySeat(g, num); renderIdentity(); }
    }, isMe ? '✓我' : '我');

    box.append(el('div', { class: 'pcard' + (isMe ? ' me-card' : '') },
      el('div', { class: 'pcard-head' },
        el('div', { class: 'pnum-wrap' },
          el('div', { class: 'pnum' }, String(num), el('small', {}, '号')),
          seatBtn, meBtn),
        el('button', { class: 'add-tag', type: 'button', onclick: () => openTagSheet(num) }, '＋ 标记')),
      chips));
  }
}

function renderRounds() {
  const box = $('#rounds-list');
  box.textContent = '';
  const rounds = G().rounds;
  if (rounds.length === 0) {
    box.append(el('div', { class: 'empty-tags', style: 'padding:20px 4px;' }, '还没有记录任何一轮。点上方「＋ 添加一轮」。'));
    return;
  }
  rounds.forEach((r, idx) => {
    const approve = [], reject = [];
    Object.keys(r.votes || {}).forEach(k => {
      if (r.votes[k] === 'approve') approve.push(+k);
      else if (r.votes[k] === 'reject') reject.push(+k);
    });
    approve.sort((a, b) => a - b); reject.sort((a, b) => a - b);

    const teamRow = el('div', { class: 'rrow' }, el('span', { class: 'rlabel' }, '提名'));
    if (r.team && r.team.length) r.team.slice().sort((a, b) => a - b).forEach(t =>
      teamRow.append(el('span', { class: 'numchip' }, String(t))));
    else teamRow.append(el('span', { class: 'vote-tag' }, '—'));

    const voteRow = el('div', { class: 'rrow' }, el('span', { class: 'rlabel' }, '投票'));
    if (approve.length === 0 && reject.length === 0) {
      voteRow.append(el('span', { class: 'vote-tag' }, '未记录'));
    } else {
      const g1 = el('div', { class: 'vote-group' }, el('span', { class: 'vote-tag' }, '赞成'));
      approve.forEach(a => g1.append(el('span', { class: 'numchip approve' }, String(a))));
      const g2 = el('div', { class: 'vote-group' }, el('span', { class: 'vote-tag' }, '反对'));
      reject.forEach(a => g2.append(el('span', { class: 'numchip reject' }, String(a))));
      voteRow.append(g1, g2);
    }

    box.append(el('div', { class: 'rcard' },
      el('div', { class: 'rcard-head' },
        el('div', { class: 'rtitle' }, '第 ' + (idx + 1) + ' 轮'),
        el('div', { class: 'ract' },
          el('button', { class: 'mini-btn', type: 'button', onclick: () => openRoundSheet(idx) }, '编辑'),
          el('button', { class: 'mini-btn', type: 'button', onclick: () => deleteRound(idx) }, '删除'))),
      el('div', { class: 'rrow' },
        el('span', { class: 'rlabel' }, '队长'),
        r.leader ? el('span', { class: 'numchip leader' }, String(r.leader)) : el('span', { class: 'vote-tag' }, '—')),
      teamRow,
      voteRow));
  });
}

function deleteRound(idx) {
  if (!confirm('删除第 ' + (idx + 1) + ' 轮？')) return;
  G().rounds.splice(idx, 1);
  save();
  renderRounds();
}

/* ---------------- 弹层：通用 ---------------- */
function openSheet(title) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').textContent = '';
  $('#sheet-overlay').classList.remove('hidden');
  return $('#sheet-body');
}
function closeSheet() { $('#sheet-overlay').classList.add('hidden'); }

/* ---------------- 弹层：身份标记 ---------------- */
let tagDraftCert = 'is';
function openTagSheet(num) {
  const body = openSheet('给 ' + num + ' 号加标记');
  renderTagSheet(num, body);
}
function renderTagSheet(num, body) {
  body.textContent = '';

  // 确定度选择
  const certRow = el('div', { class: 'opt-row' });
  CERTAINTIES.forEach(c => {
    const selected = tagDraftCert === c.code;
    certRow.append(el('button', {
      class: 'opt' + (selected ? ' sel-' + c.code : ''), type: 'button',
      onclick: () => { tagDraftCert = c.code; renderTagSheet(num, body); }
    }, c.label));
  });

  // 身份选择（点一下即添加/取消，支持叠加）
  const idRow = el('div', { class: 'opt-row' });
  IDENTITIES.forEach(id => {
    const tagged = hasTag(num, tagDraftCert, id);
    idRow.append(el('button', {
      class: 'id-opt opt' + (tagged ? ' tagged sel-' + tagDraftCert : ''), type: 'button',
      onclick: () => {
        toggleTag(num, tagDraftCert, id);
        renderTagSheet(num, body);   // 弹层内即时刷新
        renderIdentity();            // 背后卡片同步
      }
    }, id));
  });

  // 当前号码已有的标记预览
  const cur = el('div', { class: 'chips' });
  const tags = tagsOf(num);
  if (tags.length === 0) cur.append(el('span', { class: 'empty-tags' }, '暂无标记'));
  else tags.forEach((t, i) => cur.append(chipEl(num, t, i)));

  body.append(
    el('div', { class: 'sheet-section' },
      el('div', { class: 'sec-label' }, '① 选确定度'), certRow),
    el('div', { class: 'sheet-section' },
      el('div', { class: 'sec-label' }, '② 点身份添加（再点一次取消，可叠加多条）'), idRow),
    el('div', { class: 'sheet-section' },
      el('div', { class: 'sec-label' }, num + ' 号当前标记（点标记可删）'), cur)
  );
}

/* ---------------- 弹层：每轮记录（新增 / 编辑） ---------------- */
let roundDraft = null;     // { leader, team:Set, votes:{num:'approve'|'reject'} }
let roundEditIndex = null;

function openRoundSheet(editIndex) {
  const n = G().playerCount;
  roundEditIndex = (typeof editIndex === 'number') ? editIndex : null;
  if (roundEditIndex !== null) {
    const r = G().rounds[roundEditIndex];
    roundDraft = { leader: r.leader || null, team: new Set(r.team || []), votes: Object.assign({}, r.votes || {}) };
  } else {
    roundDraft = { leader: null, team: new Set(), votes: {} };
  }
  const body = openSheet(roundEditIndex !== null ? ('编辑第 ' + (roundEditIndex + 1) + ' 轮') : '添加一轮');
  renderRoundSheet(body, n);
}

function numGrid(n, cellClass, cellState, onTap) {
  const grid = el('div', { class: 'numgrid' });
  for (let i = 1; i <= n; i++) {
    grid.append(el('button', {
      class: 'ncell' + (cellState(i) ? ' ' + cellState(i) : ''), type: 'button',
      onclick: () => onTap(i)
    }, String(i)));
  }
  return grid;
}

function renderRoundSheet(body, n) {
  body.textContent = '';

  // 队长（单选）
  const leaderGrid = numGrid(n, '', i => roundDraft.leader === i ? 'sel-leader' : '', i => {
    roundDraft.leader = (roundDraft.leader === i) ? null : i;
    renderRoundSheet(body, n);
  });

  // 提名（多选）
  const teamGrid = numGrid(n, '', i => roundDraft.team.has(i) ? 'sel-team' : '', i => {
    if (roundDraft.team.has(i)) roundDraft.team.delete(i); else roundDraft.team.add(i);
    renderRoundSheet(body, n);
  });

  // 投票（未投→赞成→反对→未投 循环）
  const voteGrid = numGrid(n, '', i => {
    const v = roundDraft.votes[i];
    return v === 'approve' ? 'v-approve' : v === 'reject' ? 'v-reject' : '';
  }, i => {
    const v = roundDraft.votes[i];
    if (!v) roundDraft.votes[i] = 'approve';
    else if (v === 'approve') roundDraft.votes[i] = 'reject';
    else delete roundDraft.votes[i];
    renderRoundSheet(body, n);
  });

  const quick = el('div', { class: 'quick-row' },
    el('button', { class: 'mini-btn', type: 'button', onclick: () => { for (let i = 1; i <= n; i++) roundDraft.votes[i] = 'approve'; renderRoundSheet(body, n); } }, '全设赞成'),
    el('button', { class: 'mini-btn', type: 'button', onclick: () => { for (let i = 1; i <= n; i++) roundDraft.votes[i] = 'reject'; renderRoundSheet(body, n); } }, '全设反对'),
    el('button', { class: 'mini-btn', type: 'button', onclick: () => { roundDraft.votes = {}; renderRoundSheet(body, n); } }, '清空投票'));

  const legend = el('div', { class: 'legend' },
    el('span', {}, el('span', { class: 'dot a' }), '赞成'),
    el('span', {}, el('span', { class: 'dot r' }), '反对'),
    el('span', {}, '灰 = 未投/弃票'));

  const saveBtn = el('button', { class: 'primary-btn', type: 'button', onclick: commitRound }, '保存本轮');

  body.append(
    el('div', { class: 'sheet-section' }, el('div', { class: 'sec-label' }, '队长（单选）'), leaderGrid),
    el('div', { class: 'sheet-section' }, el('div', { class: 'sec-label' }, '提名队员（多选）'), teamGrid),
    el('div', { class: 'sheet-section' }, el('div', { class: 'sec-label' }, '投票（点一下切换）'), voteGrid, quick, legend),
    saveBtn
  );
}

function commitRound() {
  const r = {
    leader: roundDraft.leader,
    team: Array.from(roundDraft.team).sort((a, b) => a - b),
    votes: Object.assign({}, roundDraft.votes),
  };
  if (roundEditIndex !== null) G().rounds[roundEditIndex] = r;
  else G().rounds.push(r);
  save();
  closeSheet();
  activeTab = 'rounds';
  render();
}

/* ---------------- 顶栏操作 ---------------- */
function changeCount(delta) {
  const g = G();
  const next = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, g.playerCount + delta));
  g.playerCount = next;
  save();
  render();
}

function newGame() {
  if (!confirm('新开一局？当前记录会存档（可在「结果 / 导出」页「导出全部」找回），也可用「回溯上一局」切回上一局。真实玩家座位会沿用（每天北京时间 0 点自动重置）。')) return;
  const count = G().playerCount;
  archiveCurrent();
  const today = beijingDay();
  const sameDay = (store.seatsDay === today);
  const carried = sameDay ? Object.assign({}, store.current.seats) : {};   // 同一天沿用座位，跨天则清空
  store.seatsDay = today;
  store.previous = store.current;
  store.current = freshGame(count);
  store.current.seats = carried;
  save();
  activeTab = 'identity';
  render();
  toast(sameDay ? '已新开一局（玩家座位已沿用）' : '已新开一局（新的一天，座位已重置）');
}

function rollback() {
  if (!store.previous) { toast('没有可回溯的上一局'); return; }
  const tmp = store.current;
  store.current = store.previous;
  store.previous = tmp;   // 交换，可再点一次切回
  save();
  render();
  toast('已切换到上一局（再点一次可切回）');
}

/* ---------------- 座位指派弹层 ---------------- */
function openSeatSheet(num) { renderSeatSheet(num, openSheet(num + ' 号 是谁')); }
function renderSeatSheet(num, body) {
  body.textContent = '';
  const cur = seatPerson(num);
  const list = el('div', { class: 'opt-row' });
  if (store.roster.length === 0) list.append(el('span', { class: 'empty-tags' }, '名册为空，点下面「＋ 新增真实玩家」。'));
  store.roster.forEach(p => {
    const sel = cur === p.id;
    list.append(el('button', {
      class: 'opt' + (sel ? ' sel-is' : ''), type: 'button',
      onclick: () => { assignSeat(num, sel ? null : p.id); renderSeatSheet(num, body); renderIdentity(); }
    }, p.name));
  });
  const addBtn = el('button', {
    class: 'opt', type: 'button', style: 'border-style:dashed; color:var(--gold);',
    onclick: () => {
      const name = prompt('新增真实玩家名字：');
      if (name && name.trim()) { const p = addPerson(name); assignSeat(num, p.id); renderSeatSheet(num, body); renderIdentity(); }
    }
  }, '＋ 新增真实玩家');
  body.append(
    el('div', { class: 'sheet-section' },
      el('div', { class: 'sec-label' }, '点名字指派给 ' + num + ' 号（同一人一局只占一个座位；再点一次取消）'), list),
    el('div', { class: 'sheet-section' }, addBtn),
    cur ? el('div', { class: 'sheet-section' },
      el('button', { class: 'mini-btn', type: 'button', onclick: () => { assignSeat(num, null); renderSeatSheet(num, body); renderIdentity(); } }, '清除指派')) : null
  );
}

/* ---------------- 名册管理弹层 ---------------- */
function openRosterSheet() { renderRosterSheet(openSheet('真实玩家名册')); }
function renderRosterSheet(body) {
  body.textContent = '';
  const list = el('div', { class: 'roster-list' });
  if (store.roster.length === 0) list.append(el('span', { class: 'empty-tags' }, '还没有登记任何人。'));
  store.roster.forEach(p => {
    list.append(el('div', { class: 'roster-row' },
      el('span', { class: 'roster-name' }, p.name),
      el('div', { class: 'ract' },
        el('button', { class: 'mini-btn', type: 'button', onclick: () => { const n = prompt('改名字：', p.name); if (n && n.trim()) { renamePerson(p.id, n); renderRosterSheet(body); render(); } } }, '改名'),
        el('button', { class: 'mini-btn', type: 'button', onclick: () => { if (confirm('删除「' + p.name + '」？会同时从所有对局的座位解绑。')) { deletePerson(p.id); renderRosterSheet(body); render(); } } }, '删除'))));
  });
  body.append(
    el('div', { class: 'sheet-section' }, list),
    el('button', { class: 'primary-btn', type: 'button', onclick: () => { const n = prompt('新增真实玩家名字：'); if (n && n.trim()) { addPerson(n); renderRosterSheet(body); } } }, '＋ 新增玩家')
  );
}

/* ---------------- 结果 / 导出 页 ---------------- */
function renderResult() {
  const box = $('#result-panel');
  box.textContent = '';
  const g = G();
  const res = g.result || (g.result = freshResult());
  if (!Array.isArray(res.missions)) res.missions = [];

  // 胜负
  const winRow = el('div', { class: 'opt-row' });
  [['good', '好人赢', 'is'], ['evil', '坏人赢', 'isnt']].forEach(([code, label, cls]) => {
    winRow.append(el('button', {
      class: 'opt' + (res.winner === code ? ' sel-' + cls : ''), type: 'button',
      onclick: () => { res.winner = res.winner === code ? null : code; save(); renderResult(); }
    }, label));
  });

  // 任务 1..5
  const missionsWrap = el('div', { class: 'missions' });
  for (let i = 0; i < 5; i++) {
    const m = res.missions[i] || (res.missions[i] = { result: null, fails: null });
    const row = el('div', { class: 'mrow' },
      el('span', { class: 'rlabel' }, '任务' + (i + 1)),
      el('button', { class: 'mini-btn' + (m.result === 'success' ? ' m-suc' : ''), type: 'button', onclick: () => { m.result = m.result === 'success' ? null : 'success'; if (m.result === 'success') m.fails = 0; save(); renderResult(); } }, '成功'),
      el('button', { class: 'mini-btn' + (m.result === 'fail' ? ' m-fail' : ''), type: 'button', onclick: () => { if (m.result === 'fail') { m.result = null; m.fails = null; } else { m.result = 'fail'; if (m.fails == null || m.fails < 1) m.fails = 1; } save(); renderResult(); } }, '失败'));
    if (m.result === 'fail') {
      row.append(el('span', { class: 'fail-step' },
        el('span', { class: 'vote-tag' }, '失败票'),
        el('button', { class: 'step-btn', type: 'button', onclick: () => { m.fails = Math.max(0, (m.fails || 0) - 1); save(); renderResult(); } }, '−'),
        el('span', { class: 'fail-n' }, String(m.fails || 0)),
        el('button', { class: 'step-btn', type: 'button', onclick: () => { m.fails = (m.fails || 0) + 1; save(); renderResult(); } }, '＋')));
    }
    missionsWrap.append(row);
  }

  // 刺杀
  const n = g.playerCount;
  const targetGrid = numGrid(n, '', i => res.assassinTarget === i ? 'sel-leader' : '', i => { res.assassinTarget = res.assassinTarget === i ? null : i; save(); renderResult(); });
  const hitRow = el('div', { class: 'opt-row' },
    el('button', { class: 'opt' + (res.assassinHitMerlin === true ? ' sel-isnt' : ''), type: 'button', onclick: () => { res.assassinHitMerlin = res.assassinHitMerlin === true ? null : true; save(); renderResult(); } }, '刺中梅林'),
    el('button', { class: 'opt' + (res.assassinHitMerlin === false ? ' sel-is' : ''), type: 'button', onclick: () => { res.assassinHitMerlin = res.assassinHitMerlin === false ? null : false; save(); renderResult(); } }, '没刺中'));

  box.append(
    el('div', { class: 'rcard' }, el('div', { class: 'sec-label' }, '胜负'), winRow),
    el('div', { class: 'rcard' }, el('div', { class: 'sec-label' }, '任务结果（点「失败」后可调失败票数）'), missionsWrap),
    el('div', { class: 'rcard' }, el('div', { class: 'sec-label' }, '刺杀'),
      el('div', { class: 'sec-label', style: 'margin-top:2px;' }, '坏人刺谁（选号码）'), targetGrid, hitRow)
  );
}

/* ---------------- 存档 & 导出 ---------------- */
function gameHasContent(g) {
  if (!g) return false;
  if ((g.rounds || []).length) return true;
  if (g.players && Object.values(g.players).some(p => p && p.tags && p.tags.length)) return true;
  if (g.seats && Object.keys(g.seats).length) return true;
  const r = g.result || {};
  if (r.winner) return true;
  if ((r.missions || []).some(m => m && m.result)) return true;
  if (r.assassinTarget != null || r.assassinHitMerlin != null) return true;
  return false;
}
function archiveCurrent() {
  const g = store.current;
  if (!gameHasContent(g)) return;
  const snap = JSON.parse(JSON.stringify(g));
  store.archive = (store.archive || []).filter(x => x.id !== snap.id);
  store.archive.push(snap);
  if (store.archive.length > 100) store.archive = store.archive.slice(-100);
}
function buildGameExport(g) {
  const players = [];
  for (let num = 1; num <= g.playerCount; num++) {
    const tags = (g.players[num] && g.players[num].tags) || [];
    const finalIdentities = tags.filter(t => t.c === 'final').map(t => t.id);
    const guesses = tags.filter(t => t.c !== 'final').map(t => ({
      certainty: t.c, certaintyLabel: (CERT_LABEL[t.c] || {}).label || t.c, identity: t.id
    }));
    const pid = g.seats[num] || null;
    const votes = [], proposals = [];
    (g.rounds || []).forEach((r, i) => {
      if (r.votes && r.votes[num]) votes.push({ round: i + 1, vote: r.votes[num] });
      if (r.leader === num) proposals.push({ round: i + 1, team: (r.team || []).slice().sort((a, b) => a - b) });
    });
    players.push({
      seat: num,
      person: pid ? { id: pid, name: personName(pid) } : null,
      finalIdentities,   // 「最终是」标记 = 揭底真实身份（标准答案）
      guesses,           // 主观猜测：确定是/可能是/可能不是/确定不是
      actions: { proposalsAsLeader: proposals, votes }
    });
  }
  const rounds = (g.rounds || []).map((r, i) => ({
    index: i + 1,
    leader: (r.leader == null ? null : r.leader),
    team: (r.team || []).slice().sort((a, b) => a - b),
    votes: Object.assign({}, r.votes || {})
  }));
  const res = g.result || {};
  return {
    id: g.id,
    createdAt: g.createdAt || null,
    playerCount: g.playerCount,
    players,
    rounds,
    result: {
      winner: res.winner || null,
      missions: (res.missions || []).map((m, i) => ({
        index: i + 1,
        result: (m && m.result) || null,
        fails: (m && typeof m.fails === 'number') ? m.fails : null
      })),
      assassin: { target: (res.assassinTarget == null ? null : res.assassinTarget), hitMerlin: (res.assassinHitMerlin == null ? null : res.assassinHitMerlin) }
    }
  };
}
function collectAllGames() {
  const map = new Map();
  const add = g => { if (gameHasContent(g)) map.set(g.id, buildGameExport(g)); };
  (store.archive || []).forEach(add);
  add(store.previous);
  add(store.current);
  return Array.from(map.values());
}
function pad2(x) { return (x < 10 ? '0' : '') + x; }
function fileStamp() {
  const d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
}
async function saveJSON(filename, obj) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  // iOS 优先：系统分享菜单（存到「文件」/ AirDrop / 发给其它 App）
  try {
    if (navigator.canShare) {
      const file = new File([blob], filename, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // 用户在分享菜单里取消
    /* 其它错误：落到下载兜底 */
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已生成 JSON 文件');
}
function exportCurrent() {
  const g = G();
  if (!gameHasContent(g)) { toast('本局还没有任何内容'); return; }
  saveJSON('avalon_' + fileStamp() + '_' + g.id + '.json',
    { format: 'avalon-tracker-game', formatVersion: 1, exportedAt: new Date().toISOString(), game: buildGameExport(g) });
}
function exportAll() {
  const games = collectAllGames();
  if (games.length === 0) { toast('还没有可导出的对局'); return; }
  saveJSON('avalon_all_' + fileStamp() + '.json',
    { format: 'avalon-tracker-games', formatVersion: 1, exportedAt: new Date().toISOString(), count: games.length, games });
}

/* ============================================================
 * 实时助手：轮换频道 / ntfy 收发 / 本局配置·我的身份·夜间情报 / 聊天·复盘
 * ============================================================ */

/* ---- 设置访问 ---- */
function settings() { if (!store.settings) store.settings = {}; return store.settings; }
function ntfyBase() { return (settings().ntfyBase || NTFY_DEFAULT_BASE).replace(/\/$/, ''); }
function channelSecret() { return settings().channelSecret || CHANNEL_SALT; }   // 没设就用内置盐(免手动传)
function channelWindow() { return settings().channelWindow || CHANNEL_WINDOW; }

/* ---- 频道名派生（必须和本地 Python channel.py 完全一致）----
 * topic = "avalon-{dir}-" + HMAC_SHA256(secret, "{dir}:{windowIndex}") 前16位hex
 */
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function windowIndex(win) { return Math.floor(Date.now() / 1000 / win); }
async function deriveTopic(secret, dir, idx) {
  return 'avalon-' + dir + '-' + (await hmacHex(secret, dir + ':' + idx)).slice(0, 16);
}
async function upTopic() { return deriveTopic(channelSecret(), 'up', windowIndex(channelWindow())); }
async function upTopics() {
  const idx = windowIndex(channelWindow());
  return [await deriveTopic(channelSecret(), 'up', idx), await deriveTopic(channelSecret(), 'up', idx - 1)];
}

/* ---- 载荷编码（大于 ~3KB 时 gzip+base64；和 Python 一致）---- */
async function gzipB64(text) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('gzip');
  const buf = await new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs)).arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ---- 上行发送 ---- */
async function postNtfy(topic, obj) {
  let body = JSON.stringify(obj);
  if (new Blob([body]).size > 3000) {
    const b64 = await gzipB64(body);
    if (b64) body = JSON.stringify({ enc: 'gzip+b64', data: b64 });
  }
  const res = await fetch(ntfyBase() + '/' + topic, { method: 'POST', body });
  if (!res.ok) throw new Error('ntfy ' + res.status);
}
async function sendToLocal(kind, extra) {
  if (!channelSecret()) { toast('请先在「助手」页设置频道密钥'); return false; }
  try {
    const topics = await upTopics();
    const evt = Object.assign({ v: 1, kind, mid: genId('m'), ts: new Date().toISOString() }, extra || {});
    for (const t of topics) await postNtfy(t, evt);   // 双发 current+previous，防窗口边界丢消息(本地按 mid 去重)
    toast('已发送到本地助手');
    return true;
  } catch (e) { toast('发送失败：' + (e.message || e)); return false; }
}

/* ---- 组装分析载荷 ---- */
function effectiveEvil(g) {
  if (g.config && typeof g.config.evilCount === 'number' && g.config.evilCount > 0) return g.config.evilCount;
  return STANDARD_EVIL[g.playerCount] || null;
}

/* ---- 我的身份/座位：单一真相，两个页面共享；「最终是」标在自己座位上=权威 ---- */
function finalRoleOf(g, seat) {   // 某座位的「最终是」角色（具体角色优先于 好人/坏人）
  const p = g.players[seat]; const tags = (p && p.tags) || [];
  const finals = tags.filter(t => t.c === 'final').map(t => t.id);
  if (!finals.length) return null;
  return finals.find(r => r !== '好人' && r !== '坏人') || finals[0];
}
function myRole(g) {   // 优先读"我座位的最终身份"(我不会给自己标错)，否则用 me.role
  return (g.me.seat && finalRoleOf(g, g.me.seat)) || g.me.role || null;
}
function syncMe(g) {   // 标记里若确定了自己座位的最终身份，就以它为准
  if (g.me.seat) { const r = finalRoleOf(g, g.me.seat); if (r) g.me.role = r; }
}
function setMySeat(g, seat) {
  g.me.seat = (g.me.seat === seat) ? null : seat;
  syncMe(g); save();
}
function setMyRole(g, role) {   // 在结果/助手里选角色 = 同时写进自己座位的「最终是」
  g.me.role = (g.me.role === role) ? null : role;
  const chosen = g.me.role;
  if (g.me.seat) {
    const p = g.players[g.me.seat] || (g.players[g.me.seat] = { tags: [] });
    p.tags = (p.tags || []).filter(t => t.c !== 'final');   // 自己座位的最终身份就一个
    if (chosen) p.tags.push({ c: 'final', id: chosen });
  }
  save();
}
function assistCommon(g) {
  return {
    config: { playerCount: g.playerCount, evilCount: effectiveEvil(g), roles: (g.config.roles || []).slice() },
    me: { seat: g.me.seat || null, role: myRole(g) },
    nightIntel: {
      evilsSeen: (g.night.evilsSeen || []).slice(),
      thumbs: (g.night.thumbs || []).slice(),
      evilAllies: (g.night.evilAllies || []).slice(),
    },
  };
}
async function sendAnalyze() {
  const g = G(); g.analyzeSeq = (g.analyzeSeq || 0) + 1; save();
  await sendToLocal('analyze', Object.assign(
    { gameId: g.id, seq: g.analyzeSeq, label: g.label || null, game: buildGameExport(g) }, assistCommon(g)));
}
async function sendExport() {
  const g = G();
  await sendToLocal('export', Object.assign(
    { gameId: g.id, review: g.review || '', game: buildGameExport(g) }, assistCommon(g)));
}
async function sendReview() {
  const g = G(); const text = (g.review || '').trim();
  if (!text) { toast('复盘内容为空'); return; }
  await sendToLocal('review', Object.assign(
    { gameId: g.id, text, game: buildGameExport(g) }, assistCommon(g)));
}
async function sendChat(text) {
  text = (text || '').trim(); if (!text) return;
  const g = G();
  const ok = await sendToLocal('chat', Object.assign(
    { gameId: g.id, text, game: buildGameExport(g) }, assistCommon(g)));
  if (ok) toast('已发送，回复见钉钉');
}

/* ---- 下游输出已改为「只发钉钉」：本地不再经 ntfy 回传，PWA 也不再订阅下行。 ---- */

/* ---- 本局配置 / 我的身份 / 夜间情报 / 助手动作（结果页顶部） ---- */
function toggleInArr(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

function buildNightCard(g) {
  const role = myRole(g), fac = factionOf(role), n = g.playerCount;
  const card = el('div', { class: 'rcard' }, el('div', { class: 'sec-label' }, '夜间情报（我亲眼所见，作为硬事实）'));
  if (role === '梅林') {
    card.append(el('div', { class: 'sec-label', style: 'margin-top:2px;' }, '梅林看到的坏人（可能不含莫德雷德）'),
      numGrid(n, '', i => g.night.evilsSeen.includes(i) ? 'sel-team' : '', i => { toggleInArr(g.night.evilsSeen, i); save(); renderAssist(); }));
  } else if (role === '派西维尔') {
    card.append(el('div', { class: 'sec-label', style: 'margin-top:2px;' }, '两个拇指（梅林/莫甘娜各一，选 2 个）'),
      numGrid(n, '', i => g.night.thumbs.includes(i) ? 'sel-team' : '', i => {
        const a = g.night.thumbs;
        if (a.includes(i)) toggleInArr(a, i);
        else { if (a.length >= 2) { toast('拇指只有 2 个'); return; } a.push(i); }
        save(); renderAssist();
      }));
  } else if (fac === 'evil' && role !== '奥伯伦') {
    const allies = g.night.evilAllies;   // [{seat, role}]
    const findA = s => allies.find(a => a.seat === s);
    card.append(el('div', { class: 'sec-label', style: 'margin-top:2px;' }, '我的坏队友（点号码添加；下面可指定每人身份；可能不含奥伯伦）'),
      numGrid(n, '', i => findA(i) ? 'sel-team' : '', i => {
        const a = findA(i);
        if (a) allies.splice(allies.indexOf(a), 1);
        else allies.push({ seat: i, role: null });
        save(); renderAssist();
      }));
    // 坏人互认身份：每个队友单独指定是什么坏（只列在场的坏角色；不点=只知是坏）
    const evilOpts = (g.config.roles || []).filter(r => EVIL_ROLES.has(r));
    const opts = evilOpts.length ? evilOpts : ['刺客', '莫甘娜', '莫德雷德', '奥伯伦', '爪牙', '红兰斯洛特'];
    allies.slice().sort((x, y) => x.seat - y.seat).forEach(a => {
      const row = el('div', { class: 'mrow' }, el('span', { class: 'rlabel' }, a.seat + '号'));
      opts.forEach(rr => row.append(el('button', {
        class: 'mini-btn' + (a.role === rr ? ' m-suc' : ''), type: 'button',
        onclick: () => { a.role = (a.role === rr) ? null : rr; save(); renderAssist(); }
      }, rr)));
      card.append(row);
    });
  } else if (role) {
    card.append(el('div', { class: 'empty-tags' }, role + ' 没有夜间情报'));
  } else {
    card.append(el('div', { class: 'empty-tags' }, '先选「我的角色」，或在「身份标记」里给自己标「最终是」'));
  }
  return card;
}

function buildAssistCards(box, g) {
  const ev = effectiveEvil(g);
  const rolesRow = el('div', { class: 'opt-row' });
  CONFIG_ROLES.forEach(r => {
    const on = (g.config.roles || []).includes(r);
    rolesRow.append(el('button', { class: 'opt' + (on ? ' sel-is' : ''), type: 'button', onclick: () => { toggleInArr(g.config.roles, r); save(); renderAssist(); } }, r));
  });
  const cfgCard = el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '本局配置'),
    el('div', { class: 'mrow' },
      el('span', { class: 'rlabel' }, '坏人数'),
      el('button', { class: 'step-btn', type: 'button', onclick: () => { const c = effectiveEvil(g) || 1; g.config.evilCount = Math.max(1, c - 1); save(); renderAssist(); } }, '−'),
      el('span', { class: 'fail-n' }, String(ev || '?')),
      el('button', { class: 'step-btn', type: 'button', onclick: () => { const c = effectiveEvil(g) || 0; g.config.evilCount = Math.min(g.playerCount - 1, c + 1); save(); renderAssist(); } }, '＋'),
      el('span', { class: 'vote-tag' }, g.config.evilCount == null ? '(默认按人数)' : '')),
    el('div', { class: 'sec-label', style: 'margin-top:6px;' }, '在场特殊角色'), rolesRow);

  const meSeatGrid = numGrid(g.playerCount, '', i => g.me.seat === i ? 'sel-leader' : '', i => { setMySeat(g, i); renderAssist(); });
  const roleRow = el('div', { class: 'opt-row' });
  const curRole = myRole(g);
  MY_ROLES.forEach(r => {
    roleRow.append(el('button', { class: 'opt' + (curRole === r ? ' sel-is' : ''), type: 'button', onclick: () => { setMyRole(g, r); renderAssist(); } }, r));
  });
  const meCard = el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '我的身份（与「身份标记」里对自己的标记双向同步）'),
    el('div', { class: 'sec-label', style: 'margin-top:2px;' }, '我坐几号'), meSeatGrid,
    el('div', { class: 'sec-label', style: 'margin-top:6px;' }, '我的角色'), roleRow);

  const reviewTa = el('textarea', { class: 'review-ta', rows: '3', placeholder: '一整局结束后的复盘（谁是什么、关键失误…）' });
  reviewTa.value = g.review || '';
  reviewTa.addEventListener('input', () => { g.review = reviewTa.value; save(); });
  const actCard = el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '发送到本地助手'),
    el('button', { class: 'primary-btn', type: 'button', onclick: sendAnalyze }, '🔍 用助手分析（→ 钉钉）'),
    el('div', { class: 'quick-row' },
      el('button', { class: 'mini-btn', type: 'button', onclick: sendExport }, '发送本局到本地（存档）')),
    el('div', { class: 'sec-label', style: 'margin-top:8px;' }, '复盘'), reviewTa,
    el('button', { class: 'mini-btn', type: 'button', onclick: sendReview }, '发送复盘到本地'));

  box.append(cfgCard, meCard, buildNightCard(g), actCard);
}

/* ---- 助手页：频道 + 本局配置/我的身份/夜间情报/发送 + 聊天 + 助手消息 + 工具 ---- */
function renderAssist() {
  const box = $('#assist-panel');
  box.textContent = '';
  const g = G();
  syncMe(g);
  const custom = !!settings().channelSecret;

  box.append(el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '频道'),
    el('div', { class: 'vote-tag' }, '零配置可用' + (custom ? '（已设自定义密钥）' : '（内置盐，手机/电脑无需传密钥）') + '，每 ' + Math.round(channelWindow() / 60) + ' 分钟自动换名'),
    el('div', { class: 'quick-row', style: 'margin-top:6px;' },
      el('button', { class: 'mini-btn', type: 'button', onclick: openSettingsSheet }, '频道设置'))));

  buildAssistCards(box, g);   // 本局配置 / 我的身份 / 夜间情报 / 发送动作

  const ta = el('textarea', { class: 'review-ta', rows: '2', placeholder: '问助手点什么…（会带上当前对局）' });
  box.append(el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '聊天'), ta,
    el('button', { class: 'primary-btn', type: 'button', onclick: () => { const t = ta.value; ta.value = ''; sendChat(t); } }, '发送')));

  box.append(el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '助手消息'),
    el('div', { class: 'vote-tag' }, '分析 / 回复 / 回执都发送到钉钉查看，不在本页显示。')));

  box.append(el('div', { class: 'rcard' },
    el('div', { class: 'sec-label' }, '工具'),
    el('div', { class: 'quick-row' },
      el('button', { class: 'mini-btn', type: 'button', onclick: exportCurrent }, '导出本局为文件'),
      el('button', { class: 'mini-btn', type: 'button', onclick: exportAll }, '导出全部'),
      el('button', { class: 'mini-btn', type: 'button', onclick: openRosterSheet }, '管理名册'))));
}

function openSettingsSheet() {
  const body = openSheet('频道设置');
  const s = settings();
  const secIn = el('input', { class: 'lock-input', type: 'text', placeholder: '频道密钥（和本地一致，越长越安全）', value: s.channelSecret || '' });
  const baseIn = el('input', { class: 'lock-input', type: 'text', placeholder: 'ntfy 服务器', value: s.ntfyBase || NTFY_DEFAULT_BASE });
  body.append(
    el('div', { class: 'sheet-section' }, el('div', { class: 'sec-label' }, '频道密钥（可留空=默认零配置；若填，手机和电脑要一致，仅用于和别人隔离）'), secIn),
    el('div', { class: 'sheet-section' }, el('div', { class: 'sec-label' }, 'ntfy 服务器'), baseIn),
    el('div', { class: 'sheet-section' },
      el('button', { class: 'mini-btn', type: 'button', onclick: () => { secIn.value = genId('sk') + genId('sk'); } }, '随机生成密钥')),
    el('button', { class: 'primary-btn', type: 'button', onclick: () => {
      s.channelSecret = secIn.value.trim();
      s.ntfyBase = baseIn.value.trim() || NTFY_DEFAULT_BASE;
      save(); closeSheet(); toast('已保存');
    } }, '保存'));
}

/* ---------------- 密码闸门 ---------------- */
async function sha256Hex(s) {
  if (!(window.crypto && window.crypto.subtle)) throw new Error('no-subtle');
  const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function authValid() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY));
    return !!(a && a.exp && Date.now() < a.exp);
  } catch (e) { return false; }
}
function grantAuth() {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ exp: Date.now() + UNLOCK_HOURS * 3600 * 1000 }));
}
function showLock() {
  $('#lock-screen').classList.remove('hidden');
  const i = $('#lock-input');
  if (i) { i.value = ''; setTimeout(() => { try { i.focus(); } catch (e) {} }, 50); }
}
function hideLock() { $('#lock-screen').classList.add('hidden'); }
function lockNow() { localStorage.removeItem(AUTH_KEY); $('#lock-err').textContent = ''; showLock(); }
async function attemptUnlock() {
  const errEl = $('#lock-err');
  const val = $('#lock-input').value || '';
  if (!val) { errEl.textContent = '请输入密码'; return; }
  let h;
  try { h = await sha256Hex(val); }
  catch (e) { errEl.textContent = '当前环境无法校验（需 https），请用 GitHub Pages 地址打开'; return; }
  if (h === PASSWORD_HASH) { grantAuth(); errEl.textContent = ''; hideLock(); }
  else { errEl.textContent = '密码错误'; $('#lock-input').value = ''; }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  document.querySelectorAll('.tab').forEach(b =>
    b.addEventListener('click', () => { activeTab = b.dataset.tab; render(); }));
  $('#count-dec').addEventListener('click', () => changeCount(-1));
  $('#count-inc').addEventListener('click', () => changeCount(1));
  $('#btn-new').addEventListener('click', newGame);
  $('#btn-rollback').addEventListener('click', rollback);
  $('#btn-add-round').addEventListener('click', () => openRoundSheet());
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-overlay').addEventListener('click', e => { if (e.target.id === 'sheet-overlay') closeSheet(); });
  $('#btn-lock').addEventListener('click', lockNow);
  $('#lock-btn').addEventListener('click', attemptUnlock);
  $('#lock-input').addEventListener('keydown', e => { if (e.key === 'Enter') attemptUnlock(); });
}

/* ---------------- 启动 ---------------- */
bind();
ensureSeatDay();   // 跨天(北京时间 0 点)则重置当前局座位
render();
if (authValid()) hideLock(); else showLock();

/* Service Worker：离线可用 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 忽略注册失败 */ });
  });
}
