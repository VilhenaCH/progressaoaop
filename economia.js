// Nexo — economia extra: resgate diário, moedas, carteira, mercados, mesa e dados. Carrega depois do app.js (usa a ponte window.NEXO).
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, onSnapshot, runTransaction, addDoc, updateDoc, getDocs, query, where, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
const N = window.NEXO, db = getFirestore(getApp()), auth = getAuth(getApp());
const $ = s => document.querySelector(s), esc = N.esc, gi = N.gi, toast = N.toast;
const S = { me:null, players:[], cur:[], coins:{}, markets:[], tables:[], game:{pot:0,rolls:0}, faces:[6,6,6,6,6,6] };
let uid = null, unsubs = [], raf = 0, rolling = false;
const fmt = n => (n||0).toLocaleString('pt-BR');
const pn = p => p ? (p.displayName || p.email || 'Agente') : '—';
const byId = (a, id) => a.find(x => x.id === id);
const dayKey = d => { const t = new Date(d.getTime() - 3*3600e3); return t.getUTCFullYear() + '-' + (t.getUTCMonth()+1) + '-' + t.getUTCDate(); }; // dia em Brasília
const chance = pot => Math.min(0.075, 1/46656 + Math.floor(pot/200) * 0.0001); // base 6d6 + 0,01% a cada 200 PP, teto 7,5%
const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2**32;
const staff = () => N.staff() || (S.me && S.me.isStaff === true);
const opts = (arr, v, l) => arr.map(x => `<option value="${v(x)}">${esc(l(x))}</option>`).join('');
const F = (l, h) => `<label>${l}</label>${h}`;
const others = () => S.players.filter(p => p.id !== uid);

// ---------- estrutura (abas, telas, gaveta) ----------
function mount(){
  const nav = $('#bottom-nav'), st = $('#staff-tab-mobile');
  const btn = (v, ic, l, extra='') => { const b = document.createElement('button'); b.className = 'tab-btn bn-btn' + extra; b.dataset.view = v; b.innerHTML = gi(ic) + '<span>' + l + '</span>'; b.onclick = () => N.go(v); return b; };
  nav.insertBefore(btn('carteira','piggy-bank','Carteira'), st);
  const bb = btn('banco','banknote','Banco',' staff'); bb.id = 'banco-tab'; bb.style.display = 'none'; nav.appendChild(bb);
  ['carteira','banco'].forEach(v => { const s = document.createElement('section'); s.className = 'view'; s.id = 'view-' + v; $('#stage').appendChild(s); });
  document.body.insertAdjacentHTML('beforeend', `<div class="backdrop" id="eco-drawer-backdrop"></div><div class="drawer" id="eco-drawer"><div class="drawer-header"><h2 id="eco-h"></h2><button class="drawer-close" id="eco-x">${gi('cancel')}</button></div><div id="eco-b" style="padding:0 1.2rem 1.5rem"></div></div>`);
  $('#eco-x').onclick = () => N.closeDrawer('eco-drawer');
  $('#eco-drawer-backdrop').onclick = () => N.closeDrawer('eco-drawer');
  document.addEventListener('click', e => { const b = e.target.closest('[data-eco]'); if(b && ACT[b.dataset.eco]) ACT[b.dataset.eco](b.dataset.id, b); });
}
function sheet(title, body, on){ $('#eco-h').textContent = title; $('#eco-b').innerHTML = body; N.openDrawer('eco-drawer'); on && on($('#eco-b')); }
const done = () => N.closeDrawer('eco-drawer');
const go = (btn, fn) => async () => { btn.disabled = true; try{ await fn(); done(); }catch(e){ toast(e.message, true); btn.disabled = false; } };

// ---------- dados do Firestore ----------
function start(){
  const sub = (q, fn) => unsubs.push(onSnapshot(q, s => { fn(s); kick(); }, e => console.warn('economia:', e.message)));
  const list = s => s.docs.map(d => ({ id:d.id, ...d.data() }));
  sub(doc(db,'players',uid), s => S.me = { id:uid, ...s.data() });
  sub(collection(db,'players'), s => S.players = list(s));
  sub(collection(db,'currencies'), s => S.cur = list(s));
  sub(collection(db,'wallets',uid,'coins'), s => S.coins = Object.fromEntries(s.docs.map(d => [d.id, d.data().amount || 0])));
  sub(collection(db,'markets'), s => S.markets = list(s));
  sub(collection(db,'tableRequests'), s => S.tables = list(s).sort((a,b) => (b.createdAt?.toMillis?.()||0) - (a.createdAt?.toMillis?.()||0)));
  sub(doc(db,'games','dice6'), s => S.game = s.exists() ? s.data() : { pot:0, rolls:0 });
}
function kick(){ cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { $('#banco-tab').style.display = staff() ? 'flex' : 'none'; renderCarteira(); renderBanco(); }); }

// ---------- Carteira ----------
function renderCarteira(){
  const v = $('#view-carteira'); if(!uid || !S.me) return;
  const d = S.me.daily || {}, t = dayKey(new Date()), y = dayKey(new Date(Date.now() - 864e5));
  const today = d.lastDay === t, alive = today || d.lastDay === y, streak = alive ? (d.streak || 0) : 0;
  let dn = streak ? ((streak - 1) % 7) + 1 : 0; if(!today && dn === 7) dn = 0;
  const now = today ? 0 : dn + 1, reward = now === 7 ? 100 : 40;
  const steps = [1,2,3,4,5,6,7].map(i => `<div class="step ${i <= dn ? 'done' : ''} ${i === now ? 'now' : ''}">${i === 7 ? gi(i <= dn ? 'open-treasure-chest' : 'locked-chest') : i}<small>+${i === 7 ? 100 : 40}</small></div>`).join('');
  const p = chance(S.game.pot || 0), pct = (p*100).toFixed(4).replace('.', ',');
  const mine = S.tables.filter(x => x.masterUid === uid).slice(0, 3);
  v.innerHTML = `
  <div class="panel daily"><div class="daily-top">
    <div class="flame ${alive && streak ? 'on' : 'off'}">${gi('fluffy-flame')}<b>${streak}</b></div>
    <div class="grow"><h2>Resgate diário</h2><div class="field-hint">${today ? 'Resgatado hoje. Volte amanhã para manter a ofensiva.' : streak ? `Ofensiva de ${streak} dia${streak > 1 ? 's' : ''}. Resgate hoje para não apagar!` : d.streak ? 'Sua chama apagou. Recomece hoje!' : 'Resgate todo dia e acenda sua chama.'}</div></div>
    <button class="btn primary" data-eco="claim" ${today ? 'disabled' : ''}>${today ? 'Resgatado' : '+' + reward + ' PP'}</button></div>
    <div class="trail">${steps}</div></div>
  <div class="panel"><div class="sec-head"><h2>Minhas moedas</h2><button class="link" data-eco="send">Enviar</button></div>
    ${S.cur.length ? S.cur.map(c => `<div class="tx"><div class="tx-ic in">${gi('coins')}</div><div class="tx-main"><div class="tx-t">${esc(c.name)}</div><div class="tx-s">${esc(c.symbol || '')}</div></div><div class="tx-v">${fmt(S.coins[c.id])}</div></div>`).join('') : '<div class="empty-hint">A staff ainda não criou nenhuma moeda.</div>'}</div>
  <div class="panel"><div class="sec-head"><h2>Mercados</h2></div>
    ${S.markets.length ? S.markets.map(m => `<div class="tx"><div class="tx-ic">${gi('piggy-bank')}</div><div class="tx-main"><div class="tx-t">${esc(m.name)}</div><div class="tx-s">${esc(m.desc || '')}</div></div><div class="tx-v">${fmt(m.balance)} <small>${esc(byId(S.cur, m.cid)?.symbol || '')}</small></div></div><div class="req-actions"><button class="btn small primary" data-eco="deposit" data-id="${m.id}">Enviar moeda</button><button class="btn small" data-eco="log" data-id="${m.id}">Registro</button></div>`).join('') : '<div class="empty-hint">Nenhum mercado criado ainda.</div>'}</div>
  <div class="panel"><div class="sec-head"><h2>Resgate de mestre</h2><button class="link" data-eco="table">Solicitar</button></div>
    <div class="field-hint">Mestre de uma mesa? Selecione todos os jogadores e peça a recompensa de uma vez; a staff aprova.</div>
    ${mine.map(x => `<div class="tx"><div class="tx-main"><div class="tx-t">${x.uids.length} jogadores · ${fmt(x.pp)} PP · ${fmt(x.pe)} PE</div><div class="tx-s">${esc(x.note || '')}</div></div><span class="status-badge status-${x.status}">${x.status}</span></div>`).join('')}</div>
  <div class="panel dice"><div class="sec-head"><h2>Dados da sorte</h2><span class="chip">${pct}% de chance</span></div>
    <div class="pot">${gi('coins')}<b>${fmt(S.game.pot || 0)}</b> PP no pote</div>
    <div class="dice-row ${rolling ? 'shake' : ''}">${S.faces.map(f => `<div class="die ${f === 6 ? 'six' : ''}">${gi('dice-six-faces-' + ['one','two','three','four','five','six'][f-1])}</div>`).join('')}</div>
    <button class="btn primary" style="width:100%" data-eco="roll" ${rolling ? 'disabled' : ''}>Rolar 6d6 · 2 PP</button>
    <div class="field-hint" style="margin-top:.7rem">Tire 6 nos seis dados para levar o pote inteiro. Chance de 1 em ${fmt(Math.round(1/p))}. Base 1 em 46.656 (0,0021%); sobe 0,01% a cada 200 PP no pote, com teto de 7,5%. ${S.game.lastWinner ? `Último vencedor: ${esc(S.game.lastWinner)} (${fmt(S.game.lastPot)} PP).` : ''}</div></div>`;
}

// ---------- Banco (staff) ----------
function renderBanco(){
  const v = $('#view-banco'); if(!uid) return;
  if(!staff()){ v.innerHTML = '<div class="panel"><div class="empty-hint">Área exclusiva da staff.</div></div>'; return; }
  const tile = (a, ic, l) => `<button data-eco="${a}"><i>${gi(ic)}</i>${l}</button>`;
  const pend = S.tables.filter(x => x.status === 'pendente');
  v.innerHTML = `<div class="qa">${tile('move','banknote','Movimentar')}${tile('newcur','coins','Nova moeda')}${tile('newmkt','piggy-bank','Novo mercado')}${tile('tablestaff','tabletop-players','Mesa')}</div>
  <div class="panel"><div class="sec-head"><h2>Resgates de mestre</h2></div>${pend.length ? pend.map(x => `<div class="tx"><div class="tx-main"><div class="tx-t">${esc(x.masterName)} · ${x.uids.length} jogadores</div><div class="tx-s">${fmt(x.pp)} PP · ${fmt(x.pe)} PE${x.session ? ' · sessão' : ''} · ${esc(x.note || '')}</div></div></div><div class="req-actions"><button class="btn small primary" data-eco="approve" data-id="${x.id}">Aprovar</button><button class="btn small danger" data-eco="deny" data-id="${x.id}">Negar</button></div>`).join('') : '<div class="empty-hint">Nenhuma solicitação pendente.</div>'}</div>
  <div class="panel"><div class="sec-head"><h2>Moedas</h2></div>${S.cur.map(c => `<div class="tx"><div class="tx-ic in">${gi('coins')}</div><div class="tx-main"><div class="tx-t">${esc(c.name)}</div><div class="tx-s">${esc(c.symbol || '')}</div></div></div>`).join('') || '<div class="empty-hint">Crie a primeira moeda.</div>'}</div>
  <div class="panel"><div class="sec-head"><h2>Mercados</h2></div>${S.markets.map(m => `<div class="tx"><div class="tx-ic">${gi('piggy-bank')}</div><div class="tx-main"><div class="tx-t">${esc(m.name)}</div><div class="tx-s">${esc(byId(S.cur, m.cid)?.name || '')}</div></div><div class="tx-v">${fmt(m.balance)}</div></div><div class="req-actions"><button class="btn small primary" data-eco="payout" data-id="${m.id}">Pagar a um jogador</button><button class="btn small" data-eco="log" data-id="${m.id}">Registro</button></div>`).join('') || '<div class="empty-hint">Nenhum mercado.</div>'}</div>`;
}

// ---------- ações ----------
const ACT = {
  async claim(){
    const d = S.me.daily || {}, t = dayKey(new Date()), y = dayKey(new Date(Date.now() - 864e5));
    if(d.lastDay === t) return;
    const streak = d.lastDay === y ? (d.streak || 0) + 1 : 1, gain = streak % 7 === 0 ? 100 : 40;
    try{ await updateDoc(doc(db,'players',uid), { ppTotal: increment(gain), daily: { lastDay:t, streak } }); N.confetti(); toast(streak % 7 === 0 ? `Baú aberto! +${gain} PP` : `+${gain} PP · ofensiva de ${streak}`); }
    catch(e){ toast('Não foi possível resgatar: ' + e.message, true); }
  },
  async roll(){
    if(rolling) return; rolling = true; kick();
    try{
      const r = await runTransaction(db, async tx => {
        const pr = doc(db,'players',uid), gr = doc(db,'games','dice6'), ps = await tx.get(pr), gs = await tx.get(gr);
        const pp = ps.data().ppTotal || 0, g = gs.exists() ? gs.data() : { pot:0, rolls:0, wins:0 };
        if(pp < 2) throw new Error('Você precisa de 2 PP para rolar.');
        const pot = g.pot || 0, win = rnd() < chance(pot), base = { rolls:(g.rolls||0) + 1, wins:g.wins||0, lastWinner:g.lastWinner||null, lastPot:g.lastPot||0 };
        if(win){ tx.update(pr, { ppTotal: pp + pot }); tx.set(gr, { ...base, pot:0, wins:base.wins + 1, lastWinner:pn(S.me), lastPot:pot + 2 }); }
        else { tx.update(pr, { ppTotal: pp - 2 }); tx.set(gr, { ...base, pot: pot + 2 }); }
        return { win, pot };
      });
      let f; do{ f = Array.from({length:6}, () => 1 + Math.floor(rnd() * 6)); }while(f.every(x => x === 6)); if(r.win) f = [6,6,6,6,6,6];
      await new Promise(res => setTimeout(res, 700)); S.faces = f; rolling = false; kick();
      if(r.win){ N.confetti(); toast(`SEIS SEIS! Você levou o pote: ${fmt(r.pot)} PP`); } else toast('Não foi dessa vez. -2 PP, pote atualizado.');
    }catch(e){ rolling = false; kick(); toast(e.message, true); }
  },
  send(){ sheet('Enviar moeda', F('Moeda', `<select id="s-c">${opts(S.cur.filter(c => S.coins[c.id] > 0), c => c.id, c => `${c.name} (saldo ${fmt(S.coins[c.id])})`)}</select>`) + F('Para', `<select id="s-p">${opts(others(), p => p.id, pn)}</select>`) + F('Valor', '<input type="number" id="s-v" min="1" inputmode="numeric">') + F('Motivo (opcional)', '<input type="text" id="s-r" maxlength="100">') + '<div class="form-actions"><button class="btn primary" id="s-ok">Enviar</button></div>', () => {
    $('#s-ok').onclick = go($('#s-ok'), () => transfer($('#s-p').value, $('#s-c').value, parseInt($('#s-v').value, 10), $('#s-r').value.trim())); }); },
  deposit(id){ const m = byId(S.markets, id); sheet('Enviar para ' + m.name, `<div class="field-hint">Moeda do mercado: ${esc(byId(S.cur, m.cid)?.name || '')} · seu saldo ${fmt(S.coins[m.cid])}</div>` + F('Valor', '<input type="number" id="d-v" min="1" inputmode="numeric">') + F('Motivo (obrigatório)', '<input type="text" id="d-r" maxlength="100" placeholder="Por que está enviando?">') + '<div class="form-actions"><button class="btn primary" id="d-ok">Enviar</button></div>', () => {
    $('#d-ok').onclick = go($('#d-ok'), () => marketMove(m, 'in', uid, parseInt($('#d-v').value, 10), $('#d-r').value.trim())); }); },
  async log(id){ const m = byId(S.markets, id); sheet('Registro · ' + m.name, '<div class="empty-hint">Carregando…</div>');
    try{ const s = await getDocs(query(collection(db,'transfers'), where('kind','==','market'), where('mid','==',id))); const rows = s.docs.map(d => d.data()).sort((a,b) => (b.at?.toMillis?.()||0) - (a.at?.toMillis?.()||0)).slice(0, 30);
      $('#eco-b').innerHTML = rows.map(r => `<div class="tx"><div class="tx-ic ${r.dir === 'out' ? 'out' : 'in'}">${gi(r.dir === 'out' ? 'shopping-bag' : 'coins')}</div><div class="tx-main"><div class="tx-t">${esc(r.dir === 'out' ? 'Pago a ' + (r.toName || '') : (r.fromName || ''))}</div><div class="tx-s">${esc(r.reason || '')} · ${r.at?.toDate ? r.at.toDate().toLocaleDateString('pt-BR') : 'agora'}</div></div><div class="tx-v ${r.dir === 'out' ? '' : 'in'}">${r.dir === 'out' ? '−' : '+'}${fmt(r.amount)}</div></div>`).join('') || '<div class="empty-hint">Sem movimentações.</div>'; }catch(e){ $('#eco-b').innerHTML = '<div class="empty-hint">' + esc(e.message) + '</div>'; } },
  table(){ tableSheet(false); }, tablestaff(){ tableSheet(true); },
  async approve(id){ const r = byId(S.tables, id); try{ await applyTable(r); await updateDoc(doc(db,'tableRequests',id), { status:'aprovado', reviewedBy:uid }); toast('Recompensa aplicada à mesa.'); }catch(e){ toast(e.message, true); } },
  async deny(id){ const n = prompt('Motivo da negação (opcional):'); if(n === null) return; try{ await updateDoc(doc(db,'tableRequests',id), { status:'negado', reviewedBy:uid, staffNote:n.trim() }); }catch(e){ toast(e.message, true); } },
  move(){ sheet('Movimentar conta', F('Jogador', `<select id="m-p">${opts(S.players, p => p.id, pn)}</select>`) + F('Conta', `<select id="m-a"><option value="pp">Prestígio (PP)</option>${opts(S.cur, c => c.id, c => c.name)}</select>`) + F('Operação', '<select id="m-o"><option value="1">Depositar (+)</option><option value="-1">Retirar (−)</option></select>') + F('Valor', '<input type="number" id="m-v" min="1" inputmode="numeric">') + F('Motivo', '<input type="text" id="m-r" maxlength="100" placeholder="Ex.: prêmio da mesa de sexta">') + '<div class="form-actions"><button class="btn primary" id="m-ok">Confirmar</button></div>', () => {
    $('#m-ok').onclick = go($('#m-ok'), () => staffMove($('#m-p').value, $('#m-a').value, parseInt($('#m-o').value, 10) * parseInt($('#m-v').value, 10), $('#m-r').value.trim())); }); },
  newcur(){ sheet('Nova moeda', F('Nome', '<input type="text" id="c-n" maxlength="30" placeholder="Ex.: Ouro de Barcelos">') + F('Símbolo', '<input type="text" id="c-s" maxlength="5" placeholder="Ex.: OB">') + '<div class="form-actions"><button class="btn primary" id="c-ok">Criar moeda</button></div>', () => {
    $('#c-ok').onclick = go($('#c-ok'), async () => { const name = $('#c-n').value.trim(); if(!name) throw new Error('Dê um nome à moeda.'); await addDoc(collection(db,'currencies'), { name, symbol:$('#c-s').value.trim(), createdBy:uid, createdAt:serverTimestamp() }); toast('Moeda criada.'); }); }); },
  newmkt(){ if(!S.cur.length) return toast('Crie uma moeda antes.', true); sheet('Novo mercado', F('Nome', '<input type="text" id="k-n" maxlength="40">') + F('Descrição / contexto', '<input type="text" id="k-d" maxlength="100" placeholder="Ex.: Cofre da mesa de quinta">') + F('Moeda guardada', `<select id="k-c">${opts(S.cur, c => c.id, c => c.name)}</select>`) + '<div class="form-actions"><button class="btn primary" id="k-ok">Criar mercado</button></div>', () => {
    $('#k-ok').onclick = go($('#k-ok'), async () => { const name = $('#k-n').value.trim(); if(!name) throw new Error('Dê um nome ao mercado.'); await addDoc(collection(db,'markets'), { name, desc:$('#k-d').value.trim(), cid:$('#k-c').value, balance:0, createdBy:uid, createdAt:serverTimestamp() }); toast('Mercado criado.'); }); }); },
  payout(id){ const m = byId(S.markets, id); sheet('Pagar de ' + m.name, `<div class="field-hint">Saldo do mercado: ${fmt(m.balance)}</div>` + F('Jogador', `<select id="o-p">${opts(S.players, p => p.id, pn)}</select>`) + F('Valor', '<input type="number" id="o-v" min="1" inputmode="numeric">') + F('Motivo', '<input type="text" id="o-r" maxlength="100">') + '<div class="form-actions"><button class="btn primary" id="o-ok">Pagar</button></div>', () => {
    $('#o-ok').onclick = go($('#o-ok'), () => marketMove(m, 'out', $('#o-p').value, parseInt($('#o-v').value, 10), $('#o-r').value.trim())); }); }
};

function tableSheet(direct){
  sheet(direct ? 'Recompensa de mesa' : 'Resgate de mestre', `<label>Jogadores da mesa</label><div class="plist">${others().map(p => `<label><input type="checkbox" value="${p.id}">${esc(pn(p))}</label>`).join('')}</div>` + F('PP para cada', '<input type="number" id="t-pp" min="0" value="0" inputmode="numeric">') + F('PE para cada (vai ao personagem ativo)', '<input type="number" id="t-pe" min="0" value="0" inputmode="numeric">') + '<label class="chk"><input type="checkbox" id="t-s" style="width:auto"> Conta como sessão jogada</label>' + F('Nota', '<input type="text" id="t-n" maxlength="100" placeholder="Ex.: Mesa de sexta, capítulo 3">') + `<div class="form-actions"><button class="btn primary" id="t-ok">${direct ? 'Aplicar agora' : 'Enviar para a staff'}</button></div>`, () => {
    $('#t-ok').onclick = go($('#t-ok'), async () => {
      const ids = [...document.querySelectorAll('.plist input:checked')].map(i => i.value), pp = parseInt($('#t-pp').value || 0, 10), pe = parseInt($('#t-pe').value || 0, 10);
      if(!ids.length) throw new Error('Selecione ao menos um jogador.'); if(!pp && !pe && !$('#t-s').checked) throw new Error('Informe PP, PE ou sessão.');
      const r = { masterUid:uid, masterName:pn(S.me), uids:ids, pp, pe, session:$('#t-s').checked, note:$('#t-n').value.trim(), status:direct ? 'aprovado' : 'pendente', createdAt:serverTimestamp() };
      if(direct){ await applyTable(r); await addDoc(collection(db,'tableRequests'), r); toast('Recompensa aplicada.'); } else { await addDoc(collection(db,'tableRequests'), r); toast('Solicitação enviada à staff.'); } }); });
}
async function applyTable(r){
  for(const u of r.uids){
    let cid = null; if(r.pe || r.session){ const cs = await getDocs(collection(db,'players',u,'characters')); const c = cs.docs.find(d => d.data().isActive !== false) || cs.docs[0]; cid = c ? c.id : null; }
    await runTransaction(db, async tx => {
      const pr = doc(db,'players',u), cr = cid ? doc(db,'players',u,'characters',cid) : null, ps = await tx.get(pr), cn = cr ? await tx.get(cr) : null;
      if(r.pp) tx.update(pr, { ppTotal: Math.max(0, (ps.data().ppTotal || 0) + r.pp) });
      if(cr){ const up = {}; if(r.pe) up.peTotal = (cn.data().peTotal || 0) + r.pe; if(r.session) up.sessionsCount = increment(1); if(Object.keys(up).length) tx.update(cr, up); }
    });
    await addDoc(collection(db,'grants'), { uid:u, charId:cid, peAmount:r.pe||0, ppAmount:r.pp||0, reason:'Mesa: ' + (r.note || ''), countsSession:!!r.session, grantedBy:uid, grantedAt:serverTimestamp() });
    N.feed('grant', { uid:u, playerName:pn(byId(S.players, u)), charName:null, peAmount:r.pe||0, ppAmount:r.pp||0 });
  }
}
async function staffMove(target, asset, amt, reason){
  if(!amt) throw new Error('Informe um valor.');
  if(asset === 'pp'){
    await runTransaction(db, async tx => { const r = doc(db,'players',target), s = await tx.get(r); tx.update(r, { ppTotal: Math.max(0, (s.data().ppTotal || 0) + amt) }); });
    await addDoc(collection(db,'grants'), { uid:target, charId:null, peAmount:0, ppAmount:amt, reason, countsSession:false, grantedBy:uid, grantedAt:serverTimestamp() });
    if(amt > 0) N.feed('grant', { uid:target, playerName:pn(byId(S.players, target)), charName:null, peAmount:0, ppAmount:amt });
  } else {
    await runTransaction(db, async tx => { const r = doc(db,'wallets',target,'coins',asset), s = await tx.get(r); tx.set(r, { amount: Math.max(0, (s.exists() ? s.data().amount : 0) + amt), ref:'staff' });
      tx.set(doc(collection(db,'transfers')), { kind:'staff', from:'staff:' + uid, to:target, cid:asset, amount:Math.abs(amt), dir:amt > 0 ? 'in' : 'out', reason, toName:pn(byId(S.players, target)), at:serverTimestamp() }); });
  }
  toast('Movimentação registrada.');
}
async function transfer(to, cid, amt, reason){
  if(!to || !cid || !(amt > 0)) throw new Error('Preencha moeda, destinatário e valor.');
  const tid = doc(collection(db,'transfers')).id;
  await runTransaction(db, async tx => {
    const a = doc(db,'wallets',uid,'coins',cid), b = doc(db,'wallets',to,'coins',cid), sa = await tx.get(a), sb = await tx.get(b), have = sa.exists() ? sa.data().amount : 0;
    if(have < amt) throw new Error('Saldo insuficiente.');
    tx.set(doc(db,'transfers',tid), { kind:'player', from:uid, to, cid, amount:amt, reason, fromName:pn(S.me), toName:pn(byId(S.players, to)), at:serverTimestamp() });
    tx.set(a, { amount:have - amt, ref:tid }); tx.set(b, { amount:(sb.exists() ? sb.data().amount : 0) + amt, ref:tid });
  });
  toast('Enviado!');
}
async function marketMove(m, dir, who, amt, reason){ // 'in': jogador -> mercado | 'out': mercado -> jogador (staff)
  if(!(amt > 0)) throw new Error('Informe um valor.'); if(!reason) throw new Error('Informe o motivo.');
  const tid = doc(collection(db,'transfers')).id;
  await runTransaction(db, async tx => {
    const w = doc(db,'wallets',who,'coins',m.cid), mr = doc(db,'markets',m.id), sw = await tx.get(w), sm = await tx.get(mr), wb = sw.exists() ? sw.data().amount : 0, mb = sm.data().balance || 0;
    if(dir === 'in' && wb < amt) throw new Error('Saldo insuficiente.'); if(dir === 'out' && mb < amt) throw new Error('O mercado não tem esse saldo.');
    const nm = pn(byId(S.players, who));
    tx.set(doc(db,'transfers',tid), { kind:'market', mid:m.id, dir, from:dir === 'in' ? who : 'm:' + m.id, to:dir === 'in' ? 'm:' + m.id : who, cid:m.cid, amount:amt, reason, fromName:dir === 'in' ? nm : m.name, toName:dir === 'in' ? m.name : nm, at:serverTimestamp() });
    tx.set(w, { amount:dir === 'in' ? wb - amt : wb + amt, ref:tid }); tx.update(mr, { balance:dir === 'in' ? mb + amt : mb - amt, ref:tid });
  });
  toast(dir === 'in' ? 'Enviado ao mercado.' : 'Pagamento feito.');
}

mount();
onAuthStateChanged(auth, u => { unsubs.forEach(f => f()); unsubs = []; uid = u ? u.uid : null; S.me = null; if(uid) start(); });
