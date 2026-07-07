'use strict';

/* ============================================================
 * 阿瓦隆记牌器 —— 纯前端，数据全部存在本机（localStorage）
 * ============================================================ */

/* 可标记的身份清单：想增删角色，直接改这个数组即可 */
const IDENTITIES = ['好人', '坏人', '梅林', '派西维尔', '忠臣', '刺客', '莫甘娜', '莫德雷德', '奥伯伦', '爪牙'];

/* 四档确定度（可叠加，一个号码可挂多条） */
const CERTAINTIES = [
  { code: 'is',       label: '确定是',   glyph: '✓' },
  { code: 'maybe',    label: '可能是',   glyph: '?' },
  { code: 'maybenot', label: '可能不是', glyph: '?' },
  { code: 'isnt',     label: '确定不是', glyph: '✕' },
];
const CERT_LABEL = Object.fromEntries(CERTAINTIES.map(c => [c.code, c]));

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;
const LS_KEY = 'avalon_tracker_v1';

/* ---------------- 数据模型 ---------------- */
function freshGame(count) {
  return { playerCount: count || 10, players: {}, rounds: [] };
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.current && Array.isArray(s.current.rounds)) return s;
  } catch (e) { /* 损坏则重建 */ }
  return { current: freshGame(10), previous: null };
}
let store = loadStore();
function save() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
function G() { return store.current; }

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
  $('#tab-identity').classList.toggle('hidden', activeTab !== 'identity');
  $('#tab-rounds').classList.toggle('hidden', activeTab !== 'rounds');
  document.querySelectorAll('.tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === activeTab));
  if (activeTab === 'identity') renderIdentity();
  else renderRounds();
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
  const n = G().playerCount;
  for (let num = 1; num <= n; num++) {
    const tags = tagsOf(num);
    const chips = el('div', { class: 'chips' });
    if (tags.length === 0) chips.append(el('span', { class: 'empty-tags' }, '暂无标记'));
    else tags.forEach((t, i) => chips.append(chipEl(num, t, i)));

    box.append(el('div', { class: 'pcard' },
      el('div', { class: 'pcard-head' },
        el('div', { class: 'pnum' }, String(num), el('small', {}, '号')),
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
  if (!confirm('新开一局？当前记录会存为「上一局」，可用「回溯上一局」找回。')) return;
  const count = G().playerCount;
  store.previous = store.current;
  store.current = freshGame(count);
  save();
  activeTab = 'identity';
  render();
  toast('已新开一局（上一局已存档）');
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
}

/* ---------------- 启动 ---------------- */
bind();
render();

/* Service Worker：离线可用 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 忽略注册失败 */ });
  });
}
