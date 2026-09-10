import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
  import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
  } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
  import {
    getFirestore, doc, setDoc, getDoc, updateDoc, addDoc, collection, query, where,
    onSnapshot, serverTimestamp, deleteDoc, orderBy, runTransaction, increment, getDocs, deleteField, limit
  } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

  // ================= CONFIG =================
  const firebaseConfig = {
    apiKey: "AIzaSyADHeL4G3ntVOC4uhdAT4YzQkJLJt4pTGU",
    authDomain: "progressao-nexo.firebaseapp.com",
    projectId: "progressao-nexo",
    storageBucket: "progressao-nexo.firebasestorage.app",
    messagingSenderId: "103038923836",
    appId: "1:103038923836:web:225fba1469fd6a6ceeff39",
    measurementId: "G-NVCLE22Q77"
  };

  // Lista fixa de admins (UIDs do Firebase Auth). Adicione seu UID aqui
  // DEPOIS de logar pela primeira vez (ele aparece no rodapé da tela de login
  // se você não estiver na lista, e também no console do navegador).
  // IMPORTANTE: a mesma lista precisa estar em firestore.rules, senão as
  // regras de segurança vão continuar bloqueando ações de staff no banco.
  const ADMIN_UIDS = [
    "a7iPwYGIdgbvJTGtqrrV8LMn6ea2",
    "HutienalLha4HDnGDNlDa2XBXD23"
  ];

  // Temporada vigente (ajuste manualmente a cada nova temporada)
  const SEASON = { name: "Temporada 1", maxLevel: 8, maxNex: 40 };

  // Tabela de patentes: nível mínimo + custo em PP
  const PATENTES = [
    { key: "recruta", label: "Recruta", minLevel: 1, cost: 0 },
    { key: "operador", label: "Operador", minLevel: 4, cost: 300 },
    { key: "agente_especial", label: "Agente Especial", minLevel: 8, cost: 700 },
    { key: "oficial_operacoes", label: "Oficial de Operações", minLevel: 13, cost: 1000 },
    { key: "agente_elite", label: "Agente de Elite", minLevel: 17, cost: 1500 },
  ];

  // ================= FIREBASE INIT =================
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  // ================= HELPERS =================
  // Converte um arquivo de imagem em um data URL já redimensionado/comprimido,
  // pra funcionar sem depender de configuração de Firebase Storage.
  function resizeImageToDataURL(file, maxDim = 360, quality = 0.82){
    return new Promise((resolve, reject) => {
      if(!file.type || !file.type.startsWith('image/')){ reject(new Error('O arquivo selecionado não é uma imagem.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Não foi possível abrir a imagem.'));
        img.onload = () => {
          let { width, height } = img;
          if(width > height){ if(width > maxDim){ height = Math.round(height * (maxDim / width)); width = maxDim; } }
          else { if(height > maxDim){ width = Math.round(width * (maxDim / height)); height = maxDim; } }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Lê um arquivo de imagem/GIF como data URL sem passar por canvas,
  // pra não perder a animação de GIFs. Aplica um limite de tamanho porque
  // o ícone fica salvo direto no documento da badge no Firestore.
  function readIconFileAsDataURL(file, maxBytes){
    return new Promise((resolve, reject) => {
      if(!file.type || !file.type.startsWith('image/')){ reject(new Error('O arquivo selecionado não é uma imagem.')); return; }
      if(maxBytes && file.size > maxBytes){ reject(new Error(`Arquivo muito grande (máx. ${Math.round(maxBytes/1024)}KB pra GIFs). Escolha um arquivo menor.`)); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  function toast(msg, isError=false){
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=> el.classList.remove('show'), 3200);
  }

  function isAdmin(uid){ return ADMIN_UIDS.includes(uid); }

  // custo incremental de PE por nível (nível N precisa desse tanto de PE
  // além do que já foi gasto pra chegar no nível N-1)
  function peCostForLevel(level){
    if(level <= 1) return 0;
    if(level <= 10) return level - 1; // nível2=1 ... nível10=6 (níveis 8,9,10 ficam fixos em 6 pela tabela)
    return 7; // 11..20
  }
  // a tabela original trava em 6 do nível 6 ao 10, então corrige a regra acima:
  function peCostForLevelFixed(level){
    if(level <= 1) return 0;
    if(level <= 6) return level - 1;   // 2:1 3:2 4:3 5:4 6:5
    if(level <= 10) return 6;          // 7:6 8:6 9:6 10:6
    return 7;                          // 11..20
  }
  // PE cumulativo necessário para estar EM um dado nível
  function cumulativePeForLevel(level){
    let total = 0;
    for(let l=2; l<=level; l++) total += peCostForLevelFixed(l);
    return total;
  }
  function levelFromPe(peTotal){
    let level = 1;
    while(level < 20 && peTotal >= cumulativePeForLevel(level+1)) level++;
    return level;
  }
  function nextLevelInfo(peTotal){
    const level = levelFromPe(peTotal);
    if(level >= 20) return { level, isMax:true };
    const floor = cumulativePeForLevel(level);
    const ceil = cumulativePeForLevel(level+1);
    return { level, isMax:false, floor, ceil, progress: peTotal - floor, needed: ceil - floor };
  }
  function patenteAtual(charPatenteKey){
    return PATENTES.find(p => p.key === charPatenteKey) || PATENTES[0];
  }
  function proximaPatente(level, currentKey){
    const idx = PATENTES.findIndex(p => p.key === currentKey);
    const next = PATENTES[idx+1];
    if(!next) return null;
    return next;
  }

  // ================= STATE =================
  let currentUser = null;
  let myPlayerDoc = null;      // { ppTotal, displayName, ... }
  let myCharacters = [];        // array de {id, ...data}
  let myRequests = [];
  let unsubCharacters = null;
  let unsubRequests = null;
  let unsubPending = null;
  let unsubAllPlayers = null;
  let unsubRanking = null;
  let unsubBadges = null;
  let unsubFeed = null;
  let lastFeedIds = new Set();     // pra animar só os itens novos que chegam
  let presenceTimer = null;
  const feedReactionUnsubs = new Map(); // feedId -> unsub, pra não vazar listener a cada render
  let prevMyBadgeIds = null;       // pra detectar badge nova e disparar confete
  let prevCharPatentes = new Map();// charId -> patente anterior, pra detectar promoção
  let prevRankOrder = [];
  let staffSubsActive = false;
  let allBadges = [];              // catálogo global de badges: [{id, name, emoji, anim, color}]
  let lastRankingPlayers = [];
  let selectedDisplayBadges = [];  // seleção em edição no drawer de apresentação (até 3)
  let editingBadgeId = null;       // badge sendo editada no painel de staff
  let currentBadgeIconData = '';   // data URL da imagem/GIF enviada pra badge (form atual)
  let currentBadgeHasColor = false; // se a badge atual tem cor de destaque escolhida
  const BADGE_COLOR_DEFAULT_SWATCH = '#8fd7e8';

  function setBadgeColorPicker(color){
    const input = document.getElementById('badge-color-input');
    if(!input) return;
    currentBadgeHasColor = !!color;
    input.value = color || BADGE_COLOR_DEFAULT_SWATCH;
  }

  function setBadgeIconPreview(dataUrl){
    const preview = document.getElementById('badge-icon-preview');
    const removeBtn = document.getElementById('badge-icon-remove-btn');
    if(!preview || !removeBtn) return;
    if(dataUrl){
      preview.innerHTML = `<img src="${dataUrl}" alt="preview">`;
      removeBtn.style.display = 'inline-block';
    } else {
      preview.innerHTML = '🖼️';
      removeBtn.style.display = 'none';
    }
  }

  // ================= BADGES (catálogo + helpers visuais) =================
  function subscribeBadges(){
    if(unsubBadges) return;
    unsubBadges = onSnapshot(collection(db, 'badges'), (snap) => {
      allBadges = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderRanking(lastRankingPlayers);
      if(myPlayerDoc){ renderMyBio(); renderMyBadgeSelect(); }
      renderBadgeCatalogPanel();
    }, (err) => console.warn('Badges indisponível:', err.message));
  }
  function getBadge(id){ return allBadges.find(b => b.id === id); }
  function animLabel(anim){
    const map = { none:'Nenhuma', pulse:'Pulso', bounce:'Saltitante', spin:'Girando', float:'Flutuando', shine:'Brilho', shake:'Balançando' };
    return map[anim] || 'Nenhuma';
  }
  function badgeChipHTML(badge, extraClass='', awardedAt=null){
    if(!badge) return '';
    const animClass = badge.anim && badge.anim !== 'none' ? ' anim-' + badge.anim : '';
    const title = escapeHtml(badge.name || '');
    const colorStyle = badge.color ? ` style="border-color:${escapeHtml(badge.color)}; box-shadow:0 0 7px ${escapeHtml(badge.color)}66;"` : '';
    const inner = badge.iconUrl
      ? `<img src="${escapeHtml(badge.iconUrl)}" alt="${title}" loading="lazy">`
      : escapeHtml(badge.emoji || '⭐');
    const millis = awardedAtToMillis(awardedAt);
    const dataAttrs = ` data-badge-id="${escapeHtml(badge.id || '')}"${millis ? ` data-awarded-at="${millis}"` : ''}`;
    return `<span class="badge-chip inspectable${animClass}${extraClass}" title="${title}"${colorStyle}${dataAttrs}>${inner}</span>`;
  }

  function awardedAtToMillis(awardedAt){
    if(!awardedAt) return null;
    if(typeof awardedAt.toMillis === 'function') return awardedAt.toMillis();
    if(awardedAt instanceof Date) return awardedAt.getTime();
    if(typeof awardedAt === 'number') return awardedAt;
    return null;
  }

  function formatBadgeAwardedDate(millis){
    try{ return new Date(millis).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric' }); }
    catch(e){ return null; }
  }

  function openBadgeInspect(badge, awardedAtMillis){
    document.getElementById('badge-inspect-name').textContent = badge.name || 'Badge';
    const body = document.getElementById('badge-inspect-body');
    const desc = (badge.description || '').trim();
    const dateLine = awardedAtMillis ? formatBadgeAwardedDate(awardedAtMillis) : null;
    const iconHTML = badge.iconUrl
      ? `<img src="${escapeHtml(badge.iconUrl)}" alt="${escapeHtml(badge.name || '')}">`
      : escapeHtml(badge.emoji || '⭐');
    const colorStyle = badge.color ? ` border-color:${escapeHtml(badge.color)}; box-shadow:0 0 10px ${escapeHtml(badge.color)}66;` : '';
    body.innerHTML = `
      <div style="display:flex; justify-content:center; margin-bottom:1rem;">
        <span class="badge-chip${badge.anim && badge.anim !== 'none' ? ' anim-' + badge.anim : ''}" style="width:4rem; height:4rem; font-size:2rem;${colorStyle}">${iconHTML}</span>
      </div>
      ${desc ? `<div class="bio-text" style="text-align:center;">${escapeHtml(desc)}</div>` : '<div class="empty-hint" style="text-align:center;">Essa badge ainda não tem uma descrição.</div>'}
      ${dateLine ? `<div class="field-hint" style="text-align:center; margin-top:0.9rem;">Concedida em ${dateLine}</div>` : ''}
    `;
    openDrawer('badge-inspect-drawer');
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.badge-chip.inspectable[data-badge-id]');
    if(!chip) return;
    const badge = getBadge(chip.dataset.badgeId);
    if(!badge) return;
    e.stopPropagation();
    const awardedAtMillis = chip.dataset.awardedAt ? Number(chip.dataset.awardedAt) : null;
    openBadgeInspect(badge, awardedAtMillis);
  }, true);

  // ================= TEMA =================
  const THEME_KEY = 'nexo-theme';
  const THEME_ORDER = ['escuro', 'claro', 'rosa', 'rosa-escuro'];
  const THEME_META = {
    'escuro': { icon: '🌙', label: 'Tema escuro — toque para trocar' },
    'claro': { icon: '☀️', label: 'Tema claro — toque para trocar' },
    'rosa': { icon: '🌸', label: 'Tema rosa claro — toque para trocar' },
    'rosa-escuro': { icon: '💜', label: 'Tema rosa escuro — toque para trocar' }
  };
  function applyTheme(theme){
    if(!THEME_META[theme]) theme = 'escuro';
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if(btn){
      const m = THEME_META[theme];
      btn.textContent = m.icon;
      btn.title = m.label;
      btn.setAttribute('aria-label', m.label);
    }
    document.querySelectorAll('.theme-option').forEach(o => o.classList.toggle('active', o.dataset.theme === theme));
    const meta = document.getElementById('meta-theme-color');
    if(meta){
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
      if(bg) meta.setAttribute('content', bg);
    }
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
  }
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeMenu = document.getElementById('theme-menu');
  function openThemeMenu(){
    themeMenu.classList.add('open');
    themeToggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeThemeMenu(){
    themeMenu.classList.remove('open');
    themeToggleBtn.setAttribute('aria-expanded', 'false');
  }
  if(themeToggleBtn && themeMenu){
    themeToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      themeMenu.classList.contains('open') ? closeThemeMenu() : openThemeMenu();
    });
    document.querySelectorAll('.theme-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTheme(opt.dataset.theme);
        closeThemeMenu();
      });
    });
    document.addEventListener('click', (e) => {
      if(!themeMenu.contains(e.target) && e.target !== themeToggleBtn) closeThemeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape') closeThemeMenu();
    });
  }
  applyTheme((function(){ try{ return localStorage.getItem(THEME_KEY); }catch(e){ return null; } })() || 'escuro');

  // ================= ACESSO DE STAFF (admins fixos + isStaff concedido pelo painel) =================
  function updateStaffAccess(){
    const admin = !!currentUser && (isAdmin(currentUser.uid) || (myPlayerDoc && myPlayerDoc.isStaff === true));
    const tab = document.getElementById('staff-tab');
    const tabMobile = document.getElementById('staff-tab-mobile');
    if(tab) tab.style.display = admin ? 'inline-block' : 'none';
    if(tabMobile) tabMobile.style.display = admin ? 'flex' : 'none';
    if(admin && !staffSubsActive){
      subscribePendingRequests();
      subscribeAllPlayers();
      staffSubsActive = true;
    } else if(!admin && staffSubsActive){
      if(unsubPending) unsubPending();
      if(unsubAllPlayers) unsubAllPlayers();
      staffSubsActive = false;
      const staffView = document.getElementById('view-staff');
      if(staffView && staffView.classList.contains('active')) switchView('personagens');
    }
  }

  function formatBirthdayLine(birthday){
    if(!birthday) return '';
    const parts = String(birthday).split('-');
    if(parts.length !== 3) return '';
    const [y, m, d] = parts;
    if(!y || !m || !d) return '';
    return `Aniversário: ${d}/${m}/${y}`;
  }

  // ================= AUTH =================
  document.getElementById('login-btn').addEventListener('click', async () => {
    try{ await signInWithPopup(auth, provider); }
    catch(e){ toast('Falha no login: ' + e.message, true); }
  });

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    cleanupSubscriptions();
    if(!user){
      renderLoggedOut();
      return;
    }
    document.getElementById('login-gate').style.display = 'none';
    document.getElementById('navbar').style.display = 'flex';
    document.getElementById('bottom-nav').classList.add('visible');
    document.body.classList.add('app-mode');

    await ensurePlayerDoc(user);
    renderAccountBox(user);
    subscribeCharacters(user.uid);
    subscribeMyRequests(user.uid);
    subscribeRanking();
    subscribeBadges();
    subscribeFeed();
    startPresenceHeartbeat();

    updateStaffAccess();
    if(!isAdmin(user.uid)) console.info('Seu UID (caso precise virar staff):', user.uid);
  });

  // marca lastActive no próprio documento enquanto a aba estiver aberta e
  // visível — sinal real de presença, não decorativo. Qualquer jogador já
  // pode escrever no próprio doc (regra do Firestore só bloqueia ppTotal/isStaff).
  function startPresenceHeartbeat(){
    const beat = () => {
      if(!currentUser || document.visibilityState !== 'visible') return;
      updateDoc(doc(db, 'players', currentUser.uid), { lastActive: serverTimestamp() }).catch(() => {});
    };
    beat();
    stopPresenceHeartbeat();
    presenceTimer = setInterval(beat, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', beat);
  }
  function stopPresenceHeartbeat(){
    if(presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
  }
  function isOnline(p){
    if(!p || !p.lastActive || !p.lastActive.toDate) return false;
    return (Date.now() - p.lastActive.toDate().getTime()) < 5 * 60 * 1000;
  }

  function cleanupSubscriptions(){
    if(unsubCharacters) unsubCharacters();
    if(unsubRequests) unsubRequests();
    if(unsubPending) unsubPending();
    if(unsubAllPlayers) unsubAllPlayers();
    if(unsubRanking) unsubRanking();
    if(unsubBadges) unsubBadges();
    unsubBadges = null;
    if(unsubFeed) unsubFeed();
    unsubFeed = null;
    feedReactionUnsubs.forEach(unsub => unsub());
    feedReactionUnsubs.clear();
  }

  function renderLoggedOut(){
    stopPresenceHeartbeat();
    document.getElementById('login-gate').style.display = 'flex';
    document.getElementById('navbar').style.display = 'none';
    document.getElementById('bottom-nav').classList.remove('visible');
    document.body.classList.remove('app-mode');
    document.getElementById('staff-tab').style.display = 'none';
    document.getElementById('staff-tab-mobile').style.display = 'none';
    document.getElementById('account-box').innerHTML = '';
    myCharacters = []; myRequests = []; myPlayerDoc = null;
    prevRankOrder = []; staffSubsActive = false;
    allBadges = []; lastRankingPlayers = []; selectedDisplayBadges = [];
    lastFeedIds = new Set();
    prevMyBadgeIds = null;
    prevCharPatentes = new Map();
  }

  // ================= RANKING (visível a todos os agentes) =================
  function subscribeRanking(){
    const q = query(collection(db, 'players'), orderBy('ppTotal', 'desc'));
    unsubRanking = onSnapshot(q, (snap) => {
      const players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      lastRankingPlayers = players;
      renderRanking(players);
    }, (err) => {
      // Se as regras do Firestore ainda não liberarem leitura de todos os
      // jogadores para não-staff, o ranking simplesmente fica vazio aqui.
      console.warn('Ranking indisponível:', err.message);
    });
  }

  function renderRanking(players){
    const el = document.getElementById('ranking-list');
    if(!el) return;
    if(players.length === 0){ el.innerHTML = '<div class="empty-hint">Ninguém pontuou ainda.</div>'; return; }
    const maxPp = Math.max(1, ...players.map(p => p.ppTotal || 0));
    const newOrder = players.map(p => p.id);

    el.innerHTML = '';
    players.forEach((p, idx) => {
      const rank = idx + 1;
      const pp = p.ppTotal || 0;
      const pct = Math.max(2, Math.round((pp / maxPp) * 100));
      const prevIdx = prevRankOrder.indexOf(p.id);
      let flashClass = '';
      if(prevRankOrder.length && prevIdx !== -1){
        if(prevIdx > idx) flashClass = ' flash-up';
        else if(prevIdx < idx) flashClass = ' flash-down';
      }
      const item = document.createElement('div');
      item.className = `rank-item rank-${rank}${flashClass}`;
      item.style.animationDelay = `${Math.min(idx * 45, 500)}ms`;
      const avatarStyle = p.photoURL ? `style="background-image:url('${escapeHtml(p.photoURL)}')"` : '';
      const avatarInitial = p.photoURL ? '' : escapeHtml((p.displayName || p.email || '?').slice(0,1).toUpperCase());
      const crown = rank === 1 ? '<span class="rank-crown">👑</span>' : '';
      const displayIds = (p.displayBadges || []).filter(id => p.badges && p.badges[id]);
      const badgesHTML = displayIds.length
        ? `<span class="badge-row inline">${displayIds.map(id => badgeChipHTML(getBadge(id), ' sm', p.badges && p.badges[id] && p.badges[id].awardedAt)).join('')}</span>`
        : '';
      item.innerHTML = `
        <div class="rank-pos">${crown}${rank}º</div>
        <div class="rank-avatar" ${avatarStyle}>${avatarInitial}${isOnline(p) ? '<span class="presence-dot" title="Ativo agora"></span>' : ''}</div>
        <div class="rank-main">
          <div class="rank-name"><span class="rank-name-text">${escapeHtml(p.displayName || p.email || 'Agente')}</span>${badgesHTML}</div>
          <div class="rank-bar-wrap"><div class="rank-bar" style="width:${pct}%"></div></div>
        </div>
        <div class="rank-pp">${pp}<span class="unit">PP</span></div>
      `;
      item.addEventListener('click', () => openPlayerViewDrawer(p));
      el.appendChild(item);
    });
    prevRankOrder = newOrder;
  }

  // ================= FEED DE ATIVIDADE (mural público) =================
  // Grava um evento leve e público em `feed`; nunca inclui motivo/nota interna da staff.
  async function publishFeedEvent(type, data){
    try{
      await addDoc(collection(db, 'feed'), { type, ...data, createdAt: serverTimestamp() });
    }catch(e){ console.warn('Feed indisponível (regra do Firestore ainda não liberada?):', e.message); }
  }

  function playerLookup(uid){
    return lastRankingPlayers.find(p => p.id === uid) || null;
  }

  function subscribeFeed(){
    const q = query(collection(db, 'feed'), orderBy('createdAt', 'desc'), limit(30));
    unsubFeed = onSnapshot(q, (snap) => {
      const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderFeed(events);
    }, (err) => {
      console.warn('Feed indisponível:', err.message);
      const el = document.getElementById('feed-list');
      if(el) el.innerHTML = '<div class="empty-hint">O mural ainda não está liberado (regra do Firestore para a coleção "feed" precisa ser adicionada).</div>';
    });
  }

  const FEED_ICONS = { grant:'✨', badge:'🏅', patente:'⭐', resgate:'🎁' };

  function feedItemText(ev){
    const who = escapeHtml(ev.playerName || 'Um agente');
    if(ev.type === 'grant'){
      const parts = [];
      if(ev.peAmount) parts.push(`${ev.peAmount > 0 ? '+' : ''}${ev.peAmount} PE`);
      if(ev.ppAmount) parts.push(`${ev.ppAmount > 0 ? '+' : ''}${ev.ppAmount} PP`);
      return `<strong>${who}</strong> recebeu ${parts.join(' e ') || 'um ajuste'} da staff${ev.charName ? ` em <em>${escapeHtml(ev.charName)}</em>` : ''}`;
    }
    if(ev.type === 'badge'){
      return `<strong>${who}</strong> conquistou a badge <em>${escapeHtml(ev.badgeName || '')}</em>`;
    }
    if(ev.type === 'patente'){
      return `<strong>${who}</strong> alcançou a patente <em>${escapeHtml(ev.patenteLabel || '')}</em>${ev.charName ? ` com <em>${escapeHtml(ev.charName)}</em>` : ''}`;
    }
    if(ev.type === 'resgate'){
      const parts = [];
      if(ev.ppAmount) parts.push(`${ev.ppAmount} PP`);
      if(ev.peAmount) parts.push(`${ev.peAmount} PE`);
      const amounts = parts.length ? parts.join(' e ') : 'uma recompensa';
      const gmNote = ev.gmBonus ? ` <span style="opacity:0.75;">(inclui ${ev.gmBonus} PE de mestragem)</span>` : '';
      return `<strong>${who}</strong> resgatou <em>${amounts}</em>${gmNote} — ${escapeHtml(ev.reqLabel || '')}${ev.charName ? ` para <em>${escapeHtml(ev.charName)}</em>` : ''}`;
    }
    return `<strong>${who}</strong> teve uma atualização`;
  }

  function renderFeed(events){
    const el = document.getElementById('feed-list');
    if(!el) return;
    feedReactionUnsubs.forEach(unsub => unsub());
    feedReactionUnsubs.clear();
    if(events.length === 0){ el.innerHTML = '<div class="empty-hint">Ainda não rolou nada por aqui. As conquistas da mesa vão aparecer neste mural.</div>'; return; }
    el.innerHTML = '';
    events.forEach((ev, idx) => {
      const isNew = !lastFeedIds.has(ev.id);
      const p = playerLookup(ev.uid);
      const avatarStyle = p && p.photoURL ? `style="background-image:url('${escapeHtml(p.photoURL)}')"` : '';
      const avatarInitial = p && p.photoURL ? '' : escapeHtml((ev.playerName || p?.displayName || '?').slice(0,1).toUpperCase());
      const item = document.createElement('div');
      item.className = 'feed-item' + (isNew && lastFeedIds.size ? ' feed-item-new' : '');
      item.style.animationDelay = `${Math.min(idx * 45, 400)}ms`;
      item.innerHTML = `
        <div class="feed-icon">${FEED_ICONS[ev.type] || '📌'}</div>
        <div class="rank-avatar feed-avatar" ${avatarStyle}>${avatarInitial}</div>
        <div class="feed-main">
          <div class="feed-text">${feedItemText(ev)}</div>
          <div class="feed-time">${feedRelativeTime(ev.createdAt)}</div>
        </div>
        <button class="feed-react-btn" data-feed-id="${ev.id}" title="Comemorar">🎉 <span class="count">0</span></button>
      `;
      el.appendChild(item);
      wireFeedReaction(item.querySelector('.feed-react-btn'), ev.id);
    });
    lastFeedIds = new Set(events.map(e => e.id));
  }

  // reação simples (🎉) por evento: 1 doc por usuário em feed/{id}/reactions/{uid}.
  // exige a regra: match /feed/{id}/reactions/{uid} { allow read: if isSignedIn(); allow write: if isOwner(uid); }
  function wireFeedReaction(btn, feedId){
    if(!btn) return;
    const reactionsRef = collection(db, 'feed', feedId, 'reactions');
    let reacted = false;
    const unsub = onSnapshot(reactionsRef, (snap) => {
      btn.querySelector('.count').textContent = snap.size;
      reacted = currentUser ? snap.docs.some(d => d.id === currentUser.uid) : false;
      btn.classList.toggle('reacted', reacted);
    }, () => { btn.style.display = 'none'; });
    feedReactionUnsubs.set(feedId, unsub);
    btn.addEventListener('click', async () => {
      if(!currentUser) return;
      const mine = doc(db, 'feed', feedId, 'reactions', currentUser.uid);
      try{
        if(reacted) await deleteDoc(mine);
        else await setDoc(mine, { createdAt: serverTimestamp() });
      }catch(e){ toast('Erro ao reagir: ' + e.message, true); }
    });
  }



  function feedRelativeTime(ts){
    if(!ts || !ts.toDate) return 'agora há pouco';
    const diffMs = Date.now() - ts.toDate().getTime();
    const min = Math.floor(diffMs / 60000);
    if(min < 1) return 'agora há pouco';
    if(min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if(h < 24) return `há ${h}h`;
    const d = Math.floor(h / 24);
    return `há ${d}d`;
  }


  async function openPlayerViewDrawer(player){
    document.getElementById('player-view-name').textContent = player.displayName || player.email || 'Agente';
    const body = document.getElementById('player-view-body');
    const bio = (player.bio || '').trim();
    const birthdayLine = formatBirthdayLine(player.birthday);
    const avatarStyle = player.photoURL ? `style="background-image:url('${escapeHtml(player.photoURL)}')"` : '';
    const avatarInitial = player.photoURL ? '' : escapeHtml((player.displayName || player.email || '?').slice(0,1).toUpperCase());
    const bannerStyle = player.bannerURL ? `style="background-image:url('${escapeHtml(player.bannerURL)}')"` : '';
    const onlineNow = isOnline(player);
    const ownedIds = Object.keys(player.badges || {});
    const badgesSectionHTML = ownedIds.length
      ? `<div class="badge-row" style="justify-content:center; margin-top:0.6rem;">${ownedIds.map(id => badgeChipHTML(getBadge(id), '', player.badges[id] && player.badges[id].awardedAt)).join('')}</div>`
      : '<div class="empty-hint">Nenhuma badge conquistada ainda.</div>';
    body.innerHTML = `
      <div class="profile-banner" ${bannerStyle}></div>
      <div class="char-avatar-lg profile-avatar-overlap" ${avatarStyle}>${avatarInitial}${onlineNow ? '<span class="presence-dot lg" title="Ativo agora"></span>' : ''}</div>
      <div class="presence-label">${onlineNow ? 'Ativo agora' : (player.lastActive ? 'Visto ' + feedRelativeTime(player.lastActive) : '')}</div>
      <div class="stat-grid"><div class="stat-box"><div class="label">Prestígio (PP)</div><div class="value">${player.ppTotal || 0}</div></div></div>
      ${birthdayLine ? `<div class="field-hint" style="text-align:center; margin-top:0.7rem;">🎂 ${escapeHtml(birthdayLine)}</div>` : ''}
      <div class="section-label" style="margin-top:1.1rem;">Badges</div>
      ${badgesSectionHTML}
      <div class="section-label" style="margin-top:1.1rem;">Apresentação</div>
      <div class="profile-card">${bio ? `<div class="bio-text">${escapeHtml(bio)}</div>` : '<div class="bio-text bio-empty">Este jogador ainda não escreveu uma apresentação.</div>'}</div>
      <div class="section-label" style="margin-top:1.1rem;">Personagens</div>
      <div id="player-view-chars"><div class="empty-hint">Carregando personagens...</div></div>
    `;
    openDrawer('player-view-drawer');
    try{
      const snap = await getDocs(collection(db, 'players', player.id, 'characters'));
      const chars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const wrap = document.getElementById('player-view-chars');
      if(!wrap) return;
      if(chars.length === 0){ wrap.innerHTML = '<div class="empty-hint">Nenhum personagem cadastrado.</div>'; return; }
      wrap.innerHTML = '';
      chars.forEach(c => {
        const info = nextLevelInfo(c.peTotal || 0);
        const pat = patenteAtual(c.patente || 'recruta');
        const card = document.createElement('div');
        card.className = 'req-card';
        card.style.cursor = 'pointer';
        card.innerHTML = `
          <div class="req-top">
            <div>
              <div class="req-type">${escapeHtml(c.name)}${c.isAlt ? '<span class="alt-badge">Alt</span>' : ''}</div>
              <div class="req-char">${pat.label} — Nível ${info.level}${c.seasonMaxed ? ' — Evolução Máxima' : ''}${c.isActive===false ? ' — Inativo' : ''}</div>
            </div>
          </div>
        `;
        card.addEventListener('click', () => openPublicCharProfile(player, c));
        wrap.appendChild(card);
      });
    }catch(e){
      const wrap = document.getElementById('player-view-chars');
      if(wrap) wrap.innerHTML = '<div class="empty-hint">Não foi possível carregar os personagens deste jogador. As regras do Firestore podem ainda não permitir a leitura pública dos personagens.</div>';
      console.warn('Erro ao carregar personagens públicos:', e.message);
    }
  }

  function openPublicCharProfile(player, c){
    document.getElementById('char-profile-name').textContent = c.name || 'Personagem';
    const info = nextLevelInfo(c.peTotal || 0);
    const pat = patenteAtual(c.patente || 'recruta');
    const pct = info.isMax ? 100 : Math.min(100, Math.round((info.progress / info.needed) * 100));
    const avatarStyle = c.photoURL ? `style="background-image:url('${escapeHtml(c.photoURL)}')"` : '';
    const avatarInitial = c.photoURL ? '' : escapeHtml((c.name||'?').slice(0,1).toUpperCase());
    const body = document.getElementById('char-profile-body');
    body.innerHTML = `
      <div class="char-avatar-lg" ${avatarStyle}>${avatarInitial}</div>
      <div style="text-align:center; margin-bottom:0.8rem;">
        <span class="patente">${pat.label}</span>${c.isAlt ? '<span class="alt-badge">Alt' + (c.altOf ? ' de ' + escapeHtml(c.altOf) : '') + '</span>' : ''}
      </div>
      <div class="field-hint" style="text-align:center; margin-bottom:0.6rem;">Jogador: ${escapeHtml(player.displayName||player.email||player.id)}${c.isActive===false ? ' · Inativo' : ''}</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="label">Nível</div><div class="value">${info.level}</div></div>
        <div class="stat-box"><div class="label">PE total</div><div class="value">${c.peTotal || 0}</div></div>
        <div class="stat-box"><div class="label">Patente</div><div class="value" style="font-size:0.95rem;">${pat.label}</div></div>
      </div>
      <div class="progress-bar" style="margin-top:0.9rem;"><div style="width:${pct}%"></div></div>
      <div class="pe-line">${info.isMax ? 'Nível máximo atingido' : `${info.progress} / ${info.needed} PE para o nível ${info.level+1}`}</div>
      <div class="section-label" style="margin-top:1.1rem;">Anotações</div>
      <div class="profile-card">${c.notes ? `<div class="bio-text">${escapeHtml(c.notes)}</div>` : '<div class="bio-text bio-empty">Sem anotações.</div>'}</div>
    `;
    closeDrawer('player-view-drawer');
    openDrawer('char-profile-drawer');
  }

  // ================= TRILHA DE PROGRESSÃO (tabela de referência estática) =================
  function renderTrilhaTable(){
    const el = document.getElementById('trilha-table');
    if(!el) return;
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Nível</th><th>PE p/ subir</th><th>PE acumulado</th><th>Patente desbloqueada</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for(let level = 1; level <= 20; level++){
      const pat = PATENTES.find(p => p.minLevel === level);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${level}</td>
        <td>${level === 1 ? '—' : peCostForLevelFixed(level)}</td>
        <td>${cumulativePeForLevel(level)}</td>
        <td>${pat ? `${escapeHtml(pat.label)}${pat.cost ? ' (' + pat.cost + ' PP)' : ''}` : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.innerHTML = '';
    el.appendChild(table);
  }
  renderTrilhaTable();

  function renderAccountBox(user){
    const box = document.getElementById('account-box');
    box.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.id = 'account-box-avatar';
    if(user.photoURL){ av.style.backgroundImage = `url(${user.photoURL})`; }
    else { av.textContent = (user.displayName||'?').slice(0,1).toUpperCase(); }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = user.displayName || user.email || 'Agente';
    chip.appendChild(av); chip.appendChild(name);
    const profileBtn = document.createElement('button');
    profileBtn.className = 'btn small';
    profileBtn.textContent = 'Perfil';
    profileBtn.addEventListener('click', openMyProfileDrawer);
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn small';
    logoutBtn.textContent = 'Sair';
    logoutBtn.addEventListener('click', () => signOut(auth));
    box.appendChild(chip);
    box.appendChild(profileBtn);
    box.appendChild(logoutBtn);
  }

  // ================= PERFIL DO JOGADOR (apresentação) =================
  function renderMyBio(){
    const box = document.getElementById('my-bio-box');
    if(!box) return;
    const bio = (myPlayerDoc && myPlayerDoc.bio) ? myPlayerDoc.bio.trim() : '';
    const birthdayLine = formatBirthdayLine(myPlayerDoc && myPlayerDoc.birthday);
    const ownedIds = Object.keys((myPlayerDoc && myPlayerDoc.badges) || {});
    const badgesHTML = ownedIds.length
      ? `<div class="section-label" style="margin-top:0.8rem;">Suas badges</div><div class="badge-row" style="margin-top:0.4rem;">${ownedIds.map(id => badgeChipHTML(getBadge(id), '', myPlayerDoc.badges[id] && myPlayerDoc.badges[id].awardedAt)).join('')}</div>`
      : '';
    box.innerHTML =
      (birthdayLine ? `<div class="field-hint" style="margin-bottom:0.5rem;">🎂 ${escapeHtml(birthdayLine)}</div>` : '') +
      (bio
        ? `<div class="bio-text">${escapeHtml(bio)}</div>`
        : `<div class="bio-text bio-empty">Você ainda não escreveu sua apresentação. Clique em "Editar apresentação" para contar um pouco sobre você.</div>`) +
      badgesHTML;
  }

  function openMyProfileDrawer(){
    document.getElementById('my-bio-input').value = (myPlayerDoc && myPlayerDoc.bio) ? myPlayerDoc.bio : '';
    document.getElementById('my-displayname-input').value = (myPlayerDoc && myPlayerDoc.displayName) ? myPlayerDoc.displayName : (currentUser ? (currentUser.displayName || '') : '');
    document.getElementById('my-birthday-input').value = (myPlayerDoc && myPlayerDoc.birthday) ? myPlayerDoc.birthday : '';
    const photoURL = (myPlayerDoc && myPlayerDoc.photoURL) ? myPlayerDoc.photoURL : (currentUser ? (currentUser.photoURL || '') : '');
    document.getElementById('my-photo-url').value = photoURL;
    document.getElementById('my-photo-upload-hint').textContent = 'Envie uma imagem (JPG, PNG, etc.). Ela substitui a foto atual.';
    updateMyAvatarPreview(photoURL);
    const bannerURL = (myPlayerDoc && myPlayerDoc.bannerURL) ? myPlayerDoc.bannerURL : '';
    document.getElementById('my-banner-url').value = bannerURL;
    updateMyBannerPreview(bannerURL);
    selectedDisplayBadges = ((myPlayerDoc && myPlayerDoc.displayBadges) || []).filter(id => myPlayerDoc && myPlayerDoc.badges && myPlayerDoc.badges[id]);
    renderMyBadgeSelect();
    openDrawer('profile-drawer');
  }

  function renderMyBadgeSelect(){
    const wrap = document.getElementById('my-badges-select');
    if(!wrap) return;
    const ownedIds = Object.keys((myPlayerDoc && myPlayerDoc.badges) || {});
    if(ownedIds.length === 0){
      wrap.innerHTML = '<div class="empty-hint">Você ainda não tem badges. A staff concede badges pelo painel de jogadores.</div>';
      return;
    }
    wrap.innerHTML = '';
    ownedIds.forEach(id => {
      const badge = getBadge(id);
      if(!badge) return;
      const chip = document.createElement('span');
      const animClass = badge.anim && badge.anim !== 'none' ? ' anim-' + badge.anim : '';
      chip.className = 'badge-chip selectable' + animClass + (selectedDisplayBadges.includes(id) ? ' selected' : '');
      chip.title = badge.name || '';
      if(badge.color){ chip.style.borderColor = badge.color; chip.style.boxShadow = `0 0 7px ${badge.color}66`; }
      if(badge.iconUrl){
        const img = document.createElement('img');
        img.src = badge.iconUrl; img.alt = badge.name || '';
        chip.appendChild(img);
      } else {
        chip.textContent = badge.emoji || '⭐';
      }
      chip.addEventListener('click', () => {
        const idx = selectedDisplayBadges.indexOf(id);
        if(idx !== -1){
          selectedDisplayBadges.splice(idx, 1);
        } else {
          if(selectedDisplayBadges.length >= 3){ toast('Você só pode exibir até 3 badges no ranking.', true); return; }
          selectedDisplayBadges.push(id);
        }
        renderMyBadgeSelect();
      });
      wrap.appendChild(chip);
    });
  }

  function updateMyAvatarPreview(url){
    const preview = document.getElementById('my-avatar-preview');
    if(url){ preview.style.backgroundImage = `url('${url.replace(/'/g,"%27")}')`; preview.textContent = ''; }
    else {
      preview.style.backgroundImage = 'none';
      const name = document.getElementById('my-displayname-input').value || (currentUser ? currentUser.displayName : '') || '?';
      preview.textContent = name.slice(0,1).toUpperCase();
    }
  }

  function updateMyBannerPreview(url){
    const preview = document.getElementById('my-banner-preview');
    if(!preview) return;
    preview.style.backgroundImage = url ? `url('${url.replace(/'/g,"%27")}')` : 'none';
  }

  document.getElementById('edit-profile-btn').addEventListener('click', openMyProfileDrawer);

  document.getElementById('my-photo-url').addEventListener('input', (e) => updateMyAvatarPreview(e.target.value.trim()));
  document.getElementById('my-banner-url').addEventListener('input', (e) => updateMyBannerPreview(e.target.value.trim()));

  document.getElementById('my-photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file || !currentUser) return;
    const hint = document.getElementById('my-photo-upload-hint');
    hint.textContent = 'Processando imagem...';
    try{
      const dataUrl = await resizeImageToDataURL(file);
      const urlInput = document.getElementById('my-photo-url');
      urlInput.value = dataUrl;
      urlInput.dispatchEvent(new Event('input'));
      hint.textContent = 'Imagem carregada. Clique em "Salvar apresentação" para confirmar.';
    }catch(err){
      console.error('Erro ao processar foto de perfil:', err);
      hint.textContent = 'Erro ao processar imagem: ' + err.message;
      toast('Erro ao processar imagem: ' + err.message, true);
    }
  });

  document.getElementById('my-banner-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file || !currentUser) return;
    const hint = document.getElementById('my-banner-upload-hint');
    hint.textContent = 'Processando imagem...';
    try{
      const dataUrl = await resizeImageToDataURL(file, 900, 0.78);
      const urlInput = document.getElementById('my-banner-url');
      urlInput.value = dataUrl;
      urlInput.dispatchEvent(new Event('input'));
      hint.textContent = 'Banner carregado. Clique em "Salvar apresentação" para confirmar.';
    }catch(err){
      console.error('Erro ao processar banner:', err);
      hint.textContent = 'Erro ao processar imagem: ' + err.message;
      toast('Erro ao processar imagem: ' + err.message, true);
    }
  });

  document.getElementById('save-profile-btn').addEventListener('click', async () => {
    if(!currentUser) return;
    const bio = document.getElementById('my-bio-input').value.trim();
    const displayName = document.getElementById('my-displayname-input').value.trim();
    const photoURL = document.getElementById('my-photo-url').value.trim();
    const bannerURL = document.getElementById('my-banner-url').value.trim();
    const birthday = document.getElementById('my-birthday-input').value;
    if(!displayName){ toast('O nome exibido não pode ficar em branco.', true); return; }
    try{
      await updateDoc(doc(db, 'players', currentUser.uid), { bio, displayName, photoURL, bannerURL, birthday, displayBadges: selectedDisplayBadges });
      closeDrawer('profile-drawer');
      toast('Apresentação salva.');
    }catch(e){ toast('Erro: ' + e.message, true); }
  });

  async function ensurePlayerDoc(user){
    const ref = doc(db, 'players', user.uid);
    const snap = await getDoc(ref);
    if(!snap.exists()){
      await setDoc(ref, {
        displayName: user.displayName || '',
        googleDisplayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || '',
        googlePhotoURL: user.photoURL || '',
        ppTotal: 0,
        gmPeCredits: 0,
        badges: {},
        displayBadges: [],
        createdAt: serverTimestamp()
      });
    } else {
      // mantém o nome/foto da conta Google como referência, mas preserva o
      // nome de exibição e a foto escolhidos pelo jogador (não sobrescreve
      // displayName nem photoURL de quem já customizou o perfil)
      await updateDoc(ref, { googleDisplayName: user.displayName || '', googlePhotoURL: user.photoURL || '' });
    }
    onSnapshot(ref, (s) => {
      const fresh = s.data();
      const newIds = Object.keys(fresh.badges || {});
      if(prevMyBadgeIds !== null){
        const added = newIds.filter(id => !prevMyBadgeIds.includes(id));
        if(added.length){
          const b = getBadge(added[0]);
          fireConfetti();
          toast(`Nova badge: ${b ? b.name : 'conquista'}! 🎉`);
        }
      }
      prevMyBadgeIds = newIds;
      myPlayerDoc = fresh;
      renderEconomy(); renderCharGrid(); renderMyBio();
      updateStaffAccess();
      const nameEl = document.querySelector('#account-box .user-chip .name');
      if(nameEl) nameEl.textContent = myPlayerDoc.displayName || user.displayName || user.email || 'Agente';
      const avEl = document.getElementById('account-box-avatar');
      if(avEl){
        const url = myPlayerDoc.photoURL || user.photoURL || '';
        if(url){ avEl.style.backgroundImage = `url('${url.replace(/'/g,"%27")}')`; avEl.textContent = ''; }
        else { avEl.style.backgroundImage = 'none'; avEl.textContent = (myPlayerDoc.displayName || user.displayName || '?').slice(0,1).toUpperCase(); }
      }
    });
  }

  // ---- confete leve, sem dependência externa (vanilla canvas) ----
  function fireConfetti(){
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const colors = ['#e0759e', '#8fd7e8', '#d9c07f', '#7fb98a', '#ff9f6b'];
    const pieces = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * 0.3,
      w: 6 + Math.random() * 5, h: 8 + Math.random() * 6,
      vy: 2.4 + Math.random() * 2.6, vx: -1.4 + Math.random() * 2.8,
      rot: Math.random() * Math.PI, vr: -0.2 + Math.random() * 0.4,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));
    let frame = 0;
    function tick(){
      frame++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
        ctx.restore();
      });
      if(frame < 150) requestAnimationFrame(tick);
      else canvas.remove();
    }
    requestAnimationFrame(tick);
  }

  // ================= NAV =================
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  function switchView(name){
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  }
  switchView('feed');

  // ================= CHARACTERS =================
  function subscribeCharacters(uid){
    const ref = collection(db, 'players', uid, 'characters');
    unsubCharacters = onSnapshot(ref, (snap) => {
      myCharacters = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      myCharacters.forEach(c => {
        const prev = prevCharPatentes.get(c.id);
        if(prev !== undefined && prev !== (c.patente || 'recruta')){
          fireConfetti();
          toast(`${c.name} subiu de patente! 🎖️`);
        }
        prevCharPatentes.set(c.id, c.patente || 'recruta');
      });
      renderCharGrid();
      renderEconomy();
      populateCharSelects();
    }, (err) => toast('Erro ao carregar personagens: ' + err.message, true));
  }

  function activeCharCount(){
    return myCharacters.filter(c => c.isActive !== false && !c.seasonMaxed).length || 1;
  }

  function renderCharGrid(){
    const grid = document.getElementById('char-grid');
    grid.innerHTML = '';
    myCharacters.forEach((c, idx) => {
      const info = nextLevelInfo(c.peTotal || 0);
      const pat = patenteAtual(c.patente || 'recruta');
      const card = document.createElement('div');
      card.className = 'char-card card-enter' + (c.seasonMaxed ? ' maxed' : '');
      card.style.animationDelay = `${Math.min(idx * 60, 400)}ms`;
      const pct = info.isMax ? 100 : Math.min(100, Math.round((info.progress / info.needed) * 100));
      const avatarStyle = c.photoURL ? `style="background-image:url('${escapeHtml(c.photoURL)}')"` : '';
      const avatarInitial = c.photoURL ? '' : escapeHtml((c.name||'?').slice(0,1).toUpperCase());
      card.innerHTML = `
        <div class="char-card-top">
          <div class="char-avatar" ${avatarStyle}>${avatarInitial}</div>
          <div class="char-card-main">
            <span class="tag">${c.seasonMaxed ? 'Evolução máxima da temporada' : 'Nível ' + info.level}${c.isAlt ? '<span class="alt-badge">Alt</span>' : ''}</span>
            <h3>${escapeHtml(c.name || 'Sem nome')}</h3>
            <div class="patente">${pat.label}</div>
          </div>
        </div>
        <div class="progress-bar"><div style="width:${pct}%"></div></div>
        <div class="pe-line">${info.isMax ? 'Nível máximo atingido' : `${info.progress} / ${info.needed} PE para o nível ${info.level+1}`}</div>
      `;
      if(c.isActive === false){
        const badge = document.createElement('div');
        badge.className = 'inactive-badge';
        badge.textContent = 'Inativo';
        card.appendChild(badge);
      }
      card.addEventListener('click', () => openCharDetail(c));
      grid.appendChild(card);
    });
    const addCard = document.createElement('div');
    addCard.className = 'add-char-card';
    addCard.textContent = '+ Cadastrar personagem';
    addCard.addEventListener('click', () => openDrawer('char-drawer'));
    grid.appendChild(addCard);
  }

  document.getElementById('create-char-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-char-name').value.trim();
    if(!name){ toast('Dê um nome ao personagem.', true); return; }
    if(!currentUser) return;
    const ref = collection(db, 'players', currentUser.uid, 'characters');
    await addDoc(ref, {
      name, peTotal: 0, sessionsCount: 0, ppConversionsUsed: 0, gmPeApplied: 0,
      patente: 'recruta', seasonMaxed: false, isActive: true,
      photoURL: '', notes: '', isAlt: false, altOf: '', createdAt: serverTimestamp()
    });
    document.getElementById('new-char-name').value = '';
    closeDrawer('char-drawer');
    toast('Personagem cadastrado.');
  });

  function openCharDetail(c){
    document.getElementById('detail-name').textContent = c.name;
    const info = nextLevelInfo(c.peTotal || 0);
    const pat = patenteAtual(c.patente || 'recruta');
    const nextPat = proximaPatente(info.level, c.patente || 'recruta');
    const body = document.getElementById('detail-body');
    const avatarStyle = c.photoURL ? `style="background-image:url('${escapeHtml(c.photoURL)}')"` : '';
    const avatarInitial = c.photoURL ? '' : escapeHtml((c.name||'?').slice(0,1).toUpperCase());
    body.innerHTML = `
      <div class="char-avatar-lg" id="detail-avatar-preview" ${avatarStyle}>${avatarInitial}</div>

      <div class="stat-grid">
        <div class="stat-box"><div class="label">Nível</div><div class="value">${info.level}</div></div>
        <div class="stat-box"><div class="label">PE total</div><div class="value">${c.peTotal || 0}</div></div>
        <div class="stat-box"><div class="label">Sessões jogadas</div><div class="value">${c.sessionsCount || 0}</div></div>
        <div class="stat-box"><div class="label">Patente</div><div class="value" style="font-size:0.95rem;">${pat.label}</div></div>
      </div>
      <div class="section-label" style="margin-top:1.1rem;">Próximos passos</div>
      <div class="field-hint">
        ${info.isMax ? 'Personagem no nível máximo (20).' : `Faltam <b>${info.needed - info.progress} PE</b> para o nível ${info.level+1}.`}<br>
        ${nextPat ? `Próxima patente: <b>${nextPat.label}</b> — requer nível ${nextPat.minLevel} e ${nextPat.cost} PP.` : 'Patente máxima já alcançada.'}<br>
        Conversões de Prestígio em PE usadas: ${c.ppConversionsUsed||0} / ${c.sessionsCount||0} sessões.<br>
        PE de narração aplicados: ${c.gmPeApplied||0} / ${c.sessionsCount||0} sessões.
        ${c.seasonMaxed ? '<br><b style="color:var(--warn);">Em Evolução Máxima da Temporada</b> — recebe 50% de PP, imune a penalidade de morte em Ciclos, e não conta no divisor de gasto de Prestígio dos demais personagens.' : ''}
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="detail-active-toggle" ${c.isActive === false ? '' : 'checked'}>
        <label style="margin:0;" for="detail-active-toggle">Personagem ativo (conta no divisor de gasto de Prestígio)</label>
      </div>

      <div class="section-label" style="margin-top:1.3rem;">Perfil do personagem</div>
      <label>Nome do personagem</label>
      <input type="text" id="detail-edit-name" value="${escapeHtml(c.name||'')}">
      <label>Foto do personagem</label>
      <input type="file" id="detail-edit-photo-file" accept="image/*">
      <div class="field-hint" id="detail-photo-upload-hint">Envie uma imagem (JPG, PNG, etc.). Ela substitui a foto atual.</div>
      <input type="text" id="detail-edit-photo" placeholder="https://..." value="${escapeHtml(c.photoURL||'')}" style="margin-top:0.5rem;">
      <div class="field-hint">Ou cole o link de uma imagem. Deixe tudo em branco para usar a inicial do nome.</div>
      <label>Anotações</label>
      <textarea id="detail-edit-notes" placeholder="Anotações sobre o personagem, ganchos de história, aparência, etc.">${escapeHtml(c.notes||'')}</textarea>
      <div class="checkbox-row">
        <input type="checkbox" id="detail-edit-isalt" ${c.isAlt ? 'checked' : ''}>
        <label style="margin:0;" for="detail-edit-isalt">Este personagem é um Alt</label>
      </div>
      <div id="detail-edit-altof-wrap" style="${c.isAlt ? '' : 'display:none;'}">
        <label>Alt de</label>
        <input type="text" id="detail-edit-altof" placeholder="Nome do personagem principal" value="${escapeHtml(c.altOf||'')}">
      </div>
      <div class="form-actions">
        <button class="btn primary" id="detail-save-profile-btn">Salvar perfil</button>
      </div>
      <div class="section-label" style="margin-top:1.4rem;">Zona de risco</div>
      <div class="form-actions">
        <button class="btn danger" id="detail-delete-char-btn">Excluir personagem</button>
      </div>
    `;
    document.getElementById('detail-active-toggle').addEventListener('change', async (e) => {
      await updateDoc(doc(db, 'players', currentUser.uid, 'characters', c.id), { isActive: e.target.checked });
    });
    document.getElementById('detail-edit-photo').addEventListener('input', (e) => {
      const preview = document.getElementById('detail-avatar-preview');
      const url = e.target.value.trim();
      if(url){ preview.style.backgroundImage = `url('${url.replace(/'/g,"%27")}')`; preview.textContent = ''; }
      else { preview.style.backgroundImage = 'none'; preview.textContent = (document.getElementById('detail-edit-name').value||'?').slice(0,1).toUpperCase(); }
    });
    document.getElementById('detail-edit-photo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const hint = document.getElementById('detail-photo-upload-hint');
      hint.textContent = 'Processando imagem...';
      try{
        const dataUrl = await resizeImageToDataURL(file);
        const photoInput = document.getElementById('detail-edit-photo');
        photoInput.value = dataUrl;
        photoInput.dispatchEvent(new Event('input'));
        hint.textContent = 'Imagem carregada. Clique em "Salvar perfil" para confirmar.';
      }catch(err){
        console.error('Erro ao processar imagem do personagem:', err);
        hint.textContent = 'Erro ao processar imagem: ' + err.message;
        toast('Erro ao processar imagem: ' + err.message, true);
      }
    });
    document.getElementById('detail-edit-isalt').addEventListener('change', (e) => {
      document.getElementById('detail-edit-altof-wrap').style.display = e.target.checked ? '' : 'none';
    });
    document.getElementById('detail-save-profile-btn').addEventListener('click', async () => {
      const name = document.getElementById('detail-edit-name').value.trim();
      if(!name){ toast('O personagem precisa de um nome.', true); return; }
      const photoURL = document.getElementById('detail-edit-photo').value.trim();
      const notes = document.getElementById('detail-edit-notes').value.trim();
      const isAlt = document.getElementById('detail-edit-isalt').checked;
      const altOf = isAlt ? document.getElementById('detail-edit-altof').value.trim() : '';
      try{
        await updateDoc(doc(db, 'players', currentUser.uid, 'characters', c.id), { name, photoURL, notes, isAlt, altOf });
        document.getElementById('detail-name').textContent = name;
        toast('Perfil do personagem salvo.');
      }catch(e){ toast('Erro: ' + e.message, true); }
    });
    document.getElementById('detail-delete-char-btn').addEventListener('click', async () => {
      if(!confirm(`Tem certeza que deseja excluir "${c.name}"? Essa ação não pode ser desfeita.`)) return;
      try{
        await deleteDoc(doc(db, 'players', currentUser.uid, 'characters', c.id));
        closeDrawer('detail-drawer');
        toast('Personagem excluído.');
      }catch(e){ toast('Erro: ' + e.message, true); }
    });
    openDrawer('detail-drawer');
  }

  // ================= ECONOMIA =================
  function renderEconomy(){
    const el = document.getElementById('economy-stats');
    if(!myPlayerDoc){ el.innerHTML=''; return; }
    const ppTotal = myPlayerDoc.ppTotal || 0;
    const divisor = activeCharCount();
    const limit = Math.floor(ppTotal / divisor);
    el.innerHTML = `
      <div class="stat-box"><div class="label">Prestígio total (PP)</div><div class="value">${ppTotal}</div></div>
      <div class="stat-box"><div class="label">Personagens ativos</div><div class="value">${divisor}</div><div class="sub">excluindo os em Evolução Máxima</div></div>
      <div class="stat-box"><div class="label">Teto de gasto por operação</div><div class="value">${limit}</div><div class="sub">PP total ÷ personagens ativos</div></div>
    `;
  }

  // ================= REQUESTS (player) =================
  document.getElementById('new-req-btn').addEventListener('click', () => {
    if(myCharacters.length === 0){ toast('Cadastre um personagem primeiro.', true); return; }
    updateReqFields();
    openDrawer('req-drawer');
  });

  function populateCharSelects(){
    ['req-char-select'].forEach(id => {
      const sel = document.getElementById(id);
      sel.innerHTML = myCharacters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    });
  }

  document.getElementById('req-type-select').addEventListener('change', updateReqFields);
  document.getElementById('req-char-select').addEventListener('change', updateReqFields);

  function updateReqFields(){
    const type = document.getElementById('req-type-select').value;
    const fields = document.getElementById('req-fields');
    const charWrap = document.getElementById('req-char-wrap');
    const noteLabel = document.getElementById('req-note-label');
    const charId = document.getElementById('req-char-select').value;
    const c = myCharacters.find(x => x.id === charId);
    const hint = document.getElementById('req-limit-hint');
    const gmCredits = (myPlayerDoc && myPlayerDoc.gmPeCredits) || 0;

    charWrap.style.display = (type === 'sessao_mestre') ? 'none' : '';
    noteLabel.textContent = 'Detalhes / origem';

    if(type === 'sessao_mestre'){
      fields.innerHTML = `
        <label>Sistema da sessão</label>
        <select id="req-system-select">
          <option value="ordem">Ordem Paranormal — +40 PP e +1 PE extra para o próximo Resgate de Sessão (Jogador)</option>
          <option value="outro">Outro sistema — +80 PP</option>
        </select>
        <label>Data da sessão</label>
        <input type="date" id="req-session-date">
        <label>Jogadores presentes</label>
        <input type="text" id="req-session-players" placeholder="Ex: Fulano, Ciclano, Beltrano">
        <label>Nome da mesa</label>
        <input type="text" id="req-table-name" placeholder="Ex: Barcelos — A Chuva Que Não Para">
      `;
      hint.textContent = 'O PE extra fica guardado e é aplicado automaticamente no seu próximo Resgate de Sessão (Jogador).';
    } else if(type === 'sessao_jogador'){
      fields.innerHTML = `
        <label>Sistema da sessão</label>
        <select id="req-system-select">
          <option value="ordem">Ordem Paranormal — +40 PP e +1 PE para o personagem</option>
          <option value="outro">Outro sistema — +80 PP</option>
        </select>
        <label>Data da sessão</label>
        <input type="date" id="req-session-date">
        <label>Mestre da sessão</label>
        <input type="text" id="req-session-gm" placeholder="Ex: Fulano">
        <label>Nome da mesa</label>
        <input type="text" id="req-table-name" placeholder="Ex: Barcelos — A Chuva Que Não Para">
      `;
      hint.textContent = gmCredits > 0
        ? `Você tem ${gmCredits} PE extra de mestragem disponível — será aplicado automaticamente neste resgate.`
        : 'Esse resgate conta como sessão jogada e já libera +1 conversão de Prestígio em PE para este personagem.';
    } else if(type === 'convert_pp_pe'){
      const available = myPlayerDoc ? (myPlayerDoc.ppTotal || 0) : 0;
      fields.innerHTML = `
        <div class="field-hint" style="margin-bottom:0.6rem;">Prestígio disponível: <b>${available} PP</b></div>
        <label>Quantidade de PP a converter (200 PP = 1 PE)</label>
        <input type="number" id="req-pp-amount" min="200" step="200" value="200" max="${Math.max(200, Math.floor(available/200)*200)}">
      `;
      const used = c ? (c.ppConversionsUsed||0) : 0;
      const sessions = c ? (c.sessionsCount||0) : 0;
      hint.textContent = `Limite: 1 PE extra por sessão jogada. Você já usou ${used} de ${sessions} conversões disponíveis para este personagem.`;
    } else if(type === 'patente'){
      const info = c ? nextLevelInfo(c.peTotal||0) : null;
      const next = c ? proximaPatente(info.level, c.patente||'recruta') : null;
      fields.innerHTML = `<div class="field-hint">${next ? `Próxima patente disponível: <b>${next.label}</b> (requer nível ${next.minLevel} + ${next.cost} PP).` : 'Nenhuma patente pendente ou personagem ainda não tem nível suficiente.'}</div>`;
      hint.textContent = '';
    } else {
      fields.innerHTML = `<label>PE solicitado</label><input type="number" id="req-pe-amount" min="0" value="0">
        <label>PP solicitado</label><input type="number" id="req-pp-amount2" min="0" value="0">`;
      noteLabel.textContent = 'Motivo (obrigatório)';
      hint.textContent = 'Use para pedidos fora do padrão: recompensa especial, aposta, correção, etc.';
    }
  }

  document.getElementById('submit-req-btn').addEventListener('click', async () => {
    const type = document.getElementById('req-type-select').value;
    const charId = document.getElementById('req-char-select').value;
    const c = myCharacters.find(x => x.id === charId);
    const note = document.getElementById('req-note').value.trim();
    let payload = { uid: currentUser.uid, type, note, status: 'pendente', createdAt: serverTimestamp() };

    if(type === 'sessao_mestre'){
      const system = document.getElementById('req-system-select').value;
      const sessionDate = document.getElementById('req-session-date').value;
      const players = document.getElementById('req-session-players').value.trim();
      const tableName = document.getElementById('req-table-name').value.trim();
      if(!sessionDate || !players || !tableName){ toast('Preencha data, jogadores e nome da mesa.', true); return; }
      payload.charId = null; payload.charName = null;
      payload.system = system;
      payload.ppAmount = system === 'ordem' ? 40 : 80;
      payload.peExtraGranted = system === 'ordem' ? 1 : 0;
      payload.sessionDate = sessionDate; payload.players = players; payload.tableName = tableName;
    } else if(type === 'sessao_jogador'){
      if(!c){ toast('Selecione um personagem.', true); return; }
      const system = document.getElementById('req-system-select').value;
      const sessionDate = document.getElementById('req-session-date').value;
      const gmName = document.getElementById('req-session-gm').value.trim();
      const tableName = document.getElementById('req-table-name').value.trim();
      if(!sessionDate || !gmName || !tableName){ toast('Preencha data, mestre e nome da mesa.', true); return; }
      payload.charId = charId; payload.charName = c.name;
      payload.system = system;
      payload.ppAmount = system === 'ordem' ? 40 : 80;
      payload.peAmount = system === 'ordem' ? 1 : 0;
      payload.sessionDate = sessionDate; payload.gmName = gmName; payload.tableName = tableName;
    } else if(type === 'convert_pp_pe'){
      if(!c){ toast('Selecione um personagem.', true); return; }
      const pp = parseInt(document.getElementById('req-pp-amount').value || '0', 10);
      if(pp < 200 || pp % 200 !== 0){ toast('Informe um múltiplo de 200 PP.', true); return; }
      const peGain = pp / 200;
      const used = c.ppConversionsUsed || 0;
      const sessions = c.sessionsCount || 0;
      if(used + peGain > sessions){ toast('Limite de conversões excedido para as sessões já jogadas.', true); return; }
      payload.charId = charId; payload.charName = c.name;
      payload.ppAmount = pp; payload.peAmount = peGain;
    } else if(type === 'patente'){
      if(!c){ toast('Selecione um personagem.', true); return; }
      const info = nextLevelInfo(c.peTotal||0);
      const next = proximaPatente(info.level, c.patente||'recruta');
      if(!next){ toast('Nenhuma patente disponível para solicitar.', true); return; }
      if(info.level < next.minLevel){ toast('Nível insuficiente para essa patente.', true); return; }
      payload.charId = charId; payload.charName = c.name;
      payload.ppAmount = next.cost; payload.patenteKey = next.key; payload.patenteLabel = next.label;
    } else {
      if(!c){ toast('Selecione um personagem.', true); return; }
      if(!note){ toast('Descreva o motivo do resgate personalizado.', true); return; }
      const pe = parseInt(document.getElementById('req-pe-amount').value || '0', 10);
      const pp = parseInt(document.getElementById('req-pp-amount2').value || '0', 10);
      payload.charId = charId; payload.charName = c.name;
      payload.peAmount = pe; payload.ppAmount = pp;
    }

    await addDoc(collection(db, 'redemptions'), payload);
    closeDrawer('req-drawer');
    toast('Solicitação enviada. Aguarde a análise da staff.');
  });

  function subscribeMyRequests(uid){
    const q = query(collection(db, 'redemptions'), where('uid', '==', uid));
    unsubRequests = onSnapshot(q, (snap) => {
      myRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      myRequests.sort((a,b) => (b.createdAt?.toMillis?.()||0) - (a.createdAt?.toMillis?.()||0));
      renderMyRequests();
    }, (err) => toast('Erro ao carregar solicitações: ' + err.message, true));
  }

  function reqLabel(type){
    return {
      sessao_mestre:'Resgate de Sessão (Mestre)', sessao_jogador:'Resgate de Sessão (Jogador)',
      convert_pp_pe:'Conversão de PE Avulsa', patente:'Aquisição de patente', personalizado:'Resgate Personalizado'
    }[type] || type;
  }

  function reqDetailHTML(r){
    const parts = [];
    if(r.ppAmount) parts.push(`${r.ppAmount} PP`);
    if(r.peAmount) parts.push(`${r.peAmount} PE`);
    let amounts = parts.join(' &nbsp; ');
    if(r.patenteLabel) amounts += ` — ${escapeHtml(r.patenteLabel)}`;
    const meta = [];
    if(r.system) meta.push(r.system === 'ordem' ? 'Ordem Paranormal' : 'Outro sistema');
    if(r.tableName) meta.push(escapeHtml(r.tableName));
    if(r.sessionDate) meta.push(new Date(r.sessionDate + 'T00:00:00').toLocaleDateString('pt-BR'));
    if(r.gmName) meta.push(`Mestre: ${escapeHtml(r.gmName)}`);
    if(r.players) meta.push(`Jogadores: ${escapeHtml(r.players)}`);
    if(r.peExtraGranted) meta.push('+1 PE extra guardado');
    const metaHTML = meta.length ? `<div class="req-note" style="opacity:0.8;">${meta.join(' · ')}</div>` : '';
    return `<div class="req-amounts">${amounts}</div>${metaHTML}`;
  }

  function renderMyRequests(){
    const list = document.getElementById('req-list');
    if(myRequests.length === 0){ list.innerHTML = '<div class="empty-hint">Nenhuma solicitação ainda.</div>'; return; }
    list.innerHTML = '';
    myRequests.forEach(r => {
      const card = document.createElement('div');
      card.className = 'req-card';
      card.innerHTML = `
        <div class="req-top">
          <div>
            <div class="req-type">${reqLabel(r.type)}</div>
            ${r.charName ? `<div class="req-char">${escapeHtml(r.charName)}</div>` : ''}
          </div>
          <span class="status-badge status-${r.status}">${r.status}</span>
        </div>
        ${reqDetailHTML(r)}
        ${r.note ? `<div class="req-note">${escapeHtml(r.note)}</div>` : ''}
        ${r.staffNote ? `<div class="req-note">Staff: ${escapeHtml(r.staffNote)}</div>` : ''}
      `;
      if(r.status === 'pendente'){
        const actions = document.createElement('div');
        actions.className = 'req-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn small danger';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.addEventListener('click', async () => {
          await updateDoc(doc(db, 'redemptions', r.id), { status: 'cancelado' });
          toast('Solicitação cancelada.');
        });
        actions.appendChild(cancelBtn);
        card.appendChild(actions);
      }
      list.appendChild(card);
    });
  }

  // ================= STAFF =================
  function subscribePendingRequests(){
    const q = query(collection(db, 'redemptions'), where('status', '==', 'pendente'));
    unsubPending = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      list.sort((a,b) => (a.createdAt?.toMillis?.()||0) - (b.createdAt?.toMillis?.()||0));
      renderStaffPending(list);
    }, (err) => toast('Erro ao carregar solicitações pendentes: ' + err.message, true));
  }

  function renderStaffPending(list){
    const el = document.getElementById('staff-pending-list');
    if(list.length === 0){ el.innerHTML = '<div class="empty-hint">Nenhuma solicitação pendente.</div>'; return; }
    el.innerHTML = '';
    list.forEach(r => {
      const card = document.createElement('div');
      card.className = 'req-card';
      const p = playerLookup(r.uid);
      const who = (p && (p.displayName || p.email)) || r.uid;
      card.innerHTML = `
        <div class="req-top">
          <div>
            <div class="req-type">${reqLabel(r.type)}</div>
            <div class="req-char">${r.charName ? escapeHtml(r.charName) + ' — ' : ''}jogador: ${escapeHtml(who)}</div>
          </div>
          <span class="status-badge status-${r.status}">${r.status}</span>
        </div>
        ${reqDetailHTML(r)}
        ${r.note ? `<div class="req-note">${escapeHtml(r.note)}</div>` : ''}
      `;
      const actions = document.createElement('div');
      actions.className = 'req-actions';
      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn small primary';
      approveBtn.textContent = 'Aprovar';
      approveBtn.addEventListener('click', () => resolveRequest(r, 'aprovado'));
      const denyBtn = document.createElement('button');
      denyBtn.className = 'btn small danger';
      denyBtn.textContent = 'Negar';
      denyBtn.addEventListener('click', () => resolveRequest(r, 'negado'));
      actions.appendChild(approveBtn); actions.appendChild(denyBtn);
      card.appendChild(actions);
      el.appendChild(card);
    });
  }

  async function resolveRequest(r, decision){
    if(!currentUser) return;
    let txResult = null;
    await runTransaction(db, async (tx) => {
      const reqRef = doc(db, 'redemptions', r.id);
      const reqSnap = await tx.get(reqRef);
      if(!reqSnap.exists() || reqSnap.data().status !== 'pendente') throw new Error('Solicitação já foi resolvida.');

      if(decision === 'aprovado'){
        const playerRef = doc(db, 'players', r.uid);
        const playerSnap = await tx.get(playerRef);
        if(!playerSnap.exists()) throw new Error('Jogador não encontrado.');
        const needsChar = r.type !== 'sessao_mestre';
        const charRef = needsChar ? doc(db, 'players', r.uid, 'characters', r.charId) : null;
        const charSnap = needsChar ? await tx.get(charRef) : null;
        if(needsChar && !charSnap.exists()) throw new Error('Personagem não encontrado.');

        const charUpdates = {};
        const playerUpdates = {};
        let gmBonusApplied = 0;

        if(r.type === 'convert_pp_pe'){
          const newPp = (playerSnap.data().ppTotal||0) - r.ppAmount;
          if(newPp < 0) throw new Error('PP insuficiente.');
          playerUpdates.ppTotal = newPp;
          charUpdates.peTotal = increment(r.peAmount);
          charUpdates.ppConversionsUsed = increment(r.peAmount);
        } else if(r.type === 'patente'){
          const newPp = (playerSnap.data().ppTotal||0) - r.ppAmount;
          if(newPp < 0) throw new Error('PP insuficiente.');
          playerUpdates.ppTotal = newPp;
          charUpdates.patente = r.patenteKey;
        } else if(r.type === 'sessao_mestre'){
          playerUpdates.ppTotal = increment(r.ppAmount);
          if(r.peExtraGranted) playerUpdates.gmPeCredits = increment(1);
        } else if(r.type === 'sessao_jogador'){
          playerUpdates.ppTotal = increment(r.ppAmount);
          gmBonusApplied = playerSnap.data().gmPeCredits || 0;
          const peGain = (r.peAmount || 0) + gmBonusApplied;
          if(peGain) charUpdates.peTotal = increment(peGain);
          charUpdates.sessionsCount = increment(1);
          if(gmBonusApplied > 0){
            charUpdates.gmPeApplied = increment(gmBonusApplied);
            playerUpdates.gmPeCredits = increment(-gmBonusApplied);
          }
        } else {
          // personalizado
          if(r.peAmount) charUpdates.peTotal = increment(r.peAmount);
          if(r.ppAmount) playerUpdates.ppTotal = increment(r.ppAmount);
        }

        if(Object.keys(playerUpdates).length) tx.update(playerRef, playerUpdates);
        if(needsChar && Object.keys(charUpdates).length) tx.update(charRef, charUpdates);
        txResult = { gmBonusApplied };
      }

      tx.update(reqRef, { status: decision, reviewedBy: currentUser.uid, reviewedAt: serverTimestamp() });
    }).then(() => {
      toast(decision === 'aprovado' ? 'Solicitação aprovada e aplicada.' : 'Solicitação negada.');
      if(decision === 'aprovado'){
        const p = playerLookup(r.uid);
        const base = { uid: r.uid, playerName: (p && (p.displayName || p.email)) || 'Um agente', charName: r.charName || null };
        if(r.type === 'patente'){
          publishFeedEvent('patente', { ...base, patenteLabel: r.patenteLabel || '' });
        } else {
          const gmBonus = (txResult && txResult.gmBonusApplied) || 0;
          publishFeedEvent('resgate', {
            ...base,
            reqLabel: reqLabel(r.type),
            ppAmount: r.ppAmount || 0,
            peAmount: (r.peAmount || 0) + gmBonus,
            gmBonus
          });
        }
      }
    }).catch(e => toast('Erro: ' + e.message, true));
  }


  function subscribeAllPlayers(){
    unsubAllPlayers = onSnapshot(collection(db, 'players'), async (snap) => {
      const players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderStaffPlayerSelects(players);
      renderStaffPlayersTable(players);
    }, (err) => toast('Erro ao carregar jogadores: ' + err.message, true));
  }

  function renderStaffPlayerSelects(players){
    const sel = document.getElementById('grant-player-select');
    const prev = sel.value;
    sel.innerHTML = players.map(p => `<option value="${p.id}">${escapeHtml(p.displayName||p.email||p.id)}</option>`).join('');
    if(prev) sel.value = prev;
    sel.onchange = () => loadCharsForGrant(sel.value);
    if(players.length) loadCharsForGrant(sel.value || players[0].id);
  }

  async function loadCharsForGrant(playerUid){
    const sel = document.getElementById('grant-char-select');
    sel.innerHTML = '<option>Carregando...</option>';
    const snap = await getDocs(collection(db, 'players', playerUid, 'characters'));
    sel.innerHTML = snap.docs.map(d => `<option value="${d.id}">${escapeHtml(d.data().name)}</option>`).join('') || '<option value="">Sem personagens</option>';
  }

  document.getElementById('grant-submit-btn').addEventListener('click', async () => {
    const playerUid = document.getElementById('grant-player-select').value;
    const charId = document.getElementById('grant-char-select').value;
    const pe = parseInt(document.getElementById('grant-pe').value || '0', 10);
    const pp = parseInt(document.getElementById('grant-pp').value || '0', 10);
    const reason = document.getElementById('grant-reason').value.trim();
    if(!playerUid || (!pe && !pp)){ toast('Informe PE e/ou PP para conceder ou remover.', true); return; }

    const countsSession = document.getElementById('grant-counts-session').checked;
    try{
      await runTransaction(db, async (tx) => {
        const playerRef = doc(db, 'players', playerUid);
        const charRef = charId ? doc(db, 'players', playerUid, 'characters', charId) : null;

        const playerSnap = await tx.get(playerRef);
        const charSnap = charRef ? await tx.get(charRef) : null;

        if(pp){
          const newPp = Math.max(0, (playerSnap.data().ppTotal||0) + pp);
          tx.update(playerRef, { ppTotal: newPp });
        }
        if(charRef && (pe || countsSession)){
          const charUpdates = {};
          if(pe){
            const newPe = Math.max(0, (charSnap.data().peTotal||0) + pe);
            charUpdates.peTotal = newPe;
          }
          if(countsSession) charUpdates.sessionsCount = increment(1);
          tx.update(charRef, charUpdates);
        }
      });
      await addDoc(collection(db, 'grants'), {
        uid: playerUid, charId: charId||null, peAmount: pe, ppAmount: pp, reason, countsSession,
        grantedBy: currentUser.uid, grantedAt: serverTimestamp()
      });
      if(pe > 0 || pp > 0){
        const playerSel = document.getElementById('grant-player-select');
        const charSel = document.getElementById('grant-char-select');
        publishFeedEvent('grant', {
          uid: playerUid,
          playerName: playerSel.selectedOptions[0]?.textContent || '',
          charName: charId ? (charSel.selectedOptions[0]?.textContent || '') : null,
          peAmount: pe > 0 ? pe : 0,
          ppAmount: pp > 0 ? pp : 0
        });
      }
      document.getElementById('grant-pe').value = 0;
      document.getElementById('grant-pp').value = 0;
      document.getElementById('grant-reason').value = '';
      document.getElementById('grant-counts-session').checked = false;
      toast('Ajuste aplicado.');
    }catch(e){ toast('Erro: ' + e.message, true); }
  });

  function renderStaffPlayersTable(players){
    const el = document.getElementById('staff-players-table');
    if(players.length === 0){ el.innerHTML = '<div class="empty-hint">Nenhum jogador cadastrado ainda.</div>'; return; }
    el.innerHTML = '';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Jogador</th><th>PP total</th><th>Badges</th><th>Staff</th></tr></thead>';
    const tbody = document.createElement('tbody');
    players.forEach(p => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      const staffLabel = isAdmin(p.id) ? 'Sim (fixo)' : (p.isStaff ? 'Sim' : '—');
      const badgeCount = Object.keys(p.badges || {}).length;
      tr.innerHTML = `<td>${escapeHtml(p.displayName||p.email||p.id)}</td><td>${p.ppTotal||0}</td><td>${badgeCount}</td><td>${staffLabel}</td>`;
      tr.addEventListener('click', () => openStaffPlayerDetail(p));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.style.marginTop = '0.6rem';
    hint.textContent = 'Clique em um jogador para ver os personagens dele.';
    el.appendChild(hint);
  }

  async function openStaffPlayerDetail(player){
    document.getElementById('detail-name').textContent = player.displayName || player.email || player.id;
    const body = document.getElementById('detail-body');
    body.innerHTML = '<div class="empty-hint">Carregando personagens...</div>';
    openDrawer('detail-drawer');

    const snap = await getDocs(collection(db, 'players', player.id, 'characters'));
    const chars = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const bio = (player.bio || '').trim();
    const birthdayLine = formatBirthdayLine(player.birthday);
    const isFixedAdmin = isAdmin(player.id);
    body.innerHTML = `
      <div class="stat-grid"><div class="stat-box"><div class="label">Prestígio total (PP)</div><div class="value">${player.ppTotal||0}</div></div></div>
      <div class="section-label" style="margin-top:1rem;">Editar Prestígio (staff)</div>
      <label>Definir PP total diretamente</label>
      <input type="number" id="staff-edit-pp-input" min="0" value="${player.ppTotal||0}">
      <div class="field-hint">Isso define o valor absoluto de PP do jogador (diferente do painel "Aplicar ajuste", que soma/subtrai).</div>
      <div class="form-actions">
        <button class="btn small primary" id="staff-edit-pp-save-btn">Salvar PP</button>
      </div>
      <div class="section-label" style="margin-top:1rem;">Privilégios de staff</div>
      ${isFixedAdmin
        ? `<div class="field-hint">Este jogador é staff fixo (definido no código-fonte) e não pode ser alterado por aqui.</div>`
        : `<div class="field-hint">Jogadores com privilégios de staff podem aprovar resgates, conceder PE/PP e gerenciar personagens de todos.</div>
           <div class="form-actions">
             <button class="btn small ${player.isStaff ? 'danger' : 'primary'}" id="staff-toggle-role-btn">${player.isStaff ? 'Remover privilégios de staff' : 'Conceder privilégios de staff'}</button>
           </div>`
      }
      <div class="section-label" style="margin-top:1rem;">Badges do jogador</div>
      <div class="field-hint">Toque em uma badge pra conceder ou remover. As badges concedidas ficam disponíveis pro jogador escolher e exibir no ranking.</div>
      <div class="badge-row" id="staff-player-badges" style="margin-top:0.6rem;"></div>
      <div class="section-label" style="margin-top:1rem;">Apresentação do jogador</div>
      ${birthdayLine ? `<div class="field-hint">🎂 ${escapeHtml(birthdayLine)}</div>` : ''}
      <div class="profile-card">${bio ? `<div class="bio-text">${escapeHtml(bio)}</div>` : '<div class="bio-text bio-empty">Este jogador ainda não escreveu uma apresentação.</div>'}</div>
    `;
    renderStaffPlayerBadges(player);
    document.getElementById('staff-edit-pp-save-btn').addEventListener('click', async () => {
      const val = parseInt(document.getElementById('staff-edit-pp-input').value || '0', 10);
      if(isNaN(val) || val < 0){ toast('Informe um valor de PP válido.', true); return; }
      try{
        await updateDoc(doc(db, 'players', player.id), { ppTotal: val });
        toast('PP do jogador atualizado.');
      }catch(e){ toast('Erro: ' + e.message, true); }
    });
    const toggleRoleBtn = document.getElementById('staff-toggle-role-btn');
    if(toggleRoleBtn){
      toggleRoleBtn.addEventListener('click', async () => {
        const newVal = !player.isStaff;
        try{
          await updateDoc(doc(db, 'players', player.id), { isStaff: newVal });
          toast(newVal ? 'Privilégios de staff concedidos.' : 'Privilégios de staff removidos.');
          openStaffPlayerDetail({ ...player, isStaff: newVal });
        }catch(e){ toast('Erro: ' + e.message, true); }
      });
    }

    if(chars.length === 0){
      body.innerHTML += '<div class="empty-hint" style="margin-top:0.9rem;">Este jogador ainda não cadastrou personagens.</div>';
      return;
    }

    const listWrap = document.createElement('div');
    listWrap.style.marginTop = '1rem';
    const listLabel = document.createElement('div');
    listLabel.className = 'section-label';
    listLabel.textContent = 'Personagens — clique para ver o perfil completo';
    listWrap.appendChild(listLabel);
    chars.forEach(c => {
      const info = nextLevelInfo(c.peTotal || 0);
      const pat = patenteAtual(c.patente || 'recruta');
      const card = document.createElement('div');
      card.className = 'req-card';
      card.style.cursor = 'pointer';
      card.innerHTML = `
        <div class="req-top">
          <div>
            <div class="req-type">${escapeHtml(c.name)}${c.isAlt ? '<span class="alt-badge">Alt</span>' : ''}</div>
            <div class="req-char">${pat.label} — Nível ${info.level}${c.seasonMaxed ? ' — Evolução Máxima' : ''}${c.isActive===false ? ' — Inativo' : ''}</div>
          </div>
        </div>
        <div class="req-amounts">PE total: ${c.peTotal||0} &nbsp; Sessões: ${c.sessionsCount||0}</div>
        <div class="req-note">Conversões PP→PE usadas: ${c.ppConversionsUsed||0} / ${c.sessionsCount||0} · PE de narração aplicados: ${c.gmPeApplied||0} / ${c.sessionsCount||0}</div>
      `;
      card.addEventListener('click', (e) => {
        if(e.target.tagName === 'BUTTON') return;
        openStaffCharProfile(player, c);
      });
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.style.marginTop = '0.6rem';
      btn.textContent = 'Usar no painel de concessão';
      btn.addEventListener('click', () => {
        closeDrawer('detail-drawer');
        switchView('staff');
        const playerSel = document.getElementById('grant-player-select');
        playerSel.value = player.id;
        loadCharsForGrant(player.id).then(() => {
          document.getElementById('grant-char-select').value = c.id;
        });
      });
      card.appendChild(btn);
      listWrap.appendChild(card);
    });
    body.appendChild(listWrap);
  }

  function renderStaffPlayerBadges(player){
    const wrap = document.getElementById('staff-player-badges');
    if(!wrap) return;
    if(allBadges.length === 0){
      wrap.innerHTML = '<div class="empty-hint">Nenhuma badge no catálogo ainda. Crie badges na seção "Catálogo de badges" abaixo.</div>';
      return;
    }
    wrap.innerHTML = '';
    allBadges.forEach(b => {
      const owned = !!(player.badges && player.badges[b.id]);
      const animClass = b.anim && b.anim !== 'none' ? ' anim-' + b.anim : '';
      const chip = document.createElement('span');
      chip.className = 'badge-chip selectable owned-toggle' + (owned ? ' awarded' : '') + animClass;
      chip.title = b.name || '';
      if(b.color){ chip.style.borderColor = b.color; }
      chip.textContent = b.emoji || '⭐';
      chip.addEventListener('click', async () => {
        try{
          if(player.badges && player.badges[b.id]){
            await updateDoc(doc(db, 'players', player.id), {
              [`badges.${b.id}`]: deleteField(),
              displayBadges: (player.displayBadges || []).filter(id => id !== b.id)
            });
            delete player.badges[b.id];
            player.displayBadges = (player.displayBadges || []).filter(id => id !== b.id);
            toast('Badge removida do jogador.');
          } else {
            await updateDoc(doc(db, 'players', player.id), {
              [`badges.${b.id}`]: { awardedAt: serverTimestamp(), awardedBy: currentUser.uid }
            });
            player.badges = { ...(player.badges || {}), [b.id]: true };
            toast('Badge concedida ao jogador.');
            publishFeedEvent('badge', {
              uid: player.id,
              playerName: player.displayName || player.email || 'Um agente',
              badgeName: b.name || ''
            });
          }
          renderStaffPlayerBadges(player);
        }catch(e){ toast('Erro: ' + e.message, true); }
      });
      wrap.appendChild(chip);
    });
  }

  // ================= CATÁLOGO DE BADGES (staff) =================
  function renderBadgeCatalogPanel(){
    const list = document.getElementById('badge-catalog-list');
    if(!list) return;
    if(allBadges.length === 0){ list.innerHTML = '<div class="empty-hint">Nenhuma badge criada ainda.</div>'; return; }
    list.innerHTML = '';
    allBadges.forEach(b => {
      const row = document.createElement('div');
      row.className = 'badge-catalog-item';
      row.innerHTML = `
        ${badgeChipHTML(b)}
        <div class="info">
          <div class="name">${escapeHtml(b.name || 'Sem nome')}</div>
          <div class="meta">${b.iconUrl ? 'Ícone: imagem/GIF · ' : ''}Animação: ${animLabel(b.anim)}</div>
        </div>
      `;
      const editBtn = document.createElement('button');
      editBtn.className = 'btn small';
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => startEditBadge(b));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn small danger';
      delBtn.textContent = 'Excluir';
      delBtn.addEventListener('click', () => deleteBadge(b));
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  function startEditBadge(b){
    editingBadgeId = b.id;
    document.getElementById('badge-name-input').value = b.name || '';
    document.getElementById('badge-emoji-input').value = b.emoji || '';
    currentBadgeIconData = b.iconUrl || '';
    setBadgeIconPreview(currentBadgeIconData);
    document.getElementById('badge-anim-select').value = b.anim || 'none';
    setBadgeColorPicker(b.color || '');
    document.getElementById('badge-description-input').value = b.description || '';
    document.getElementById('badge-form-label').textContent = 'Editando: ' + (b.name || '');
    document.getElementById('badge-save-btn').textContent = 'Salvar edição';
    document.getElementById('badge-cancel-edit-btn').style.display = 'inline-block';
  }

  function resetBadgeForm(){
    editingBadgeId = null;
    document.getElementById('badge-name-input').value = '';
    document.getElementById('badge-emoji-input').value = '';
    currentBadgeIconData = '';
    setBadgeIconPreview('');
    document.getElementById('badge-anim-select').value = 'none';
    document.getElementById('badge-color-input').value = '';
    setBadgeColorPicker('');
    document.getElementById('badge-description-input').value = '';
    document.getElementById('badge-form-label').textContent = 'Nova badge';
    document.getElementById('badge-save-btn').textContent = 'Criar badge';
    document.getElementById('badge-cancel-edit-btn').style.display = 'none';
  }

  document.getElementById('badge-cancel-edit-btn').addEventListener('click', resetBadgeForm);

  document.getElementById('badge-icon-pick-btn').addEventListener('click', () => {
    document.getElementById('badge-icon-file-input').click();
  });

  document.getElementById('badge-icon-remove-btn').addEventListener('click', () => {
    currentBadgeIconData = '';
    setBadgeIconPreview('');
  });

  document.getElementById('badge-color-input').addEventListener('input', () => {
    currentBadgeHasColor = true;
  });

  document.getElementById('badge-color-clear-btn').addEventListener('click', () => {
    setBadgeColorPicker('');
  });

  document.getElementById('badge-icon-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    try{
      const dataUrl = file.type === 'image/gif'
        ? await readIconFileAsDataURL(file, 350 * 1024)
        : await resizeImageToDataURL(file, 120, 0.85);
      currentBadgeIconData = dataUrl;
      setBadgeIconPreview(currentBadgeIconData);
    }catch(err){ toast(err.message, true); }
  });

  document.getElementById('badge-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('badge-name-input').value.trim();
    const emoji = document.getElementById('badge-emoji-input').value.trim() || '⭐';
    const iconUrl = currentBadgeIconData;
    const anim = document.getElementById('badge-anim-select').value;
    const color = currentBadgeHasColor ? document.getElementById('badge-color-input').value.trim() : '';
    const description = document.getElementById('badge-description-input').value.trim();
    if(!name){ toast('Dê um nome para a badge.', true); return; }
    try{
      if(editingBadgeId){
        await updateDoc(doc(db, 'badges', editingBadgeId), { name, emoji, iconUrl, anim, color, description });
        toast('Badge atualizada.');
      } else {
        await addDoc(collection(db, 'badges'), { name, emoji, iconUrl, anim, color, description, createdBy: currentUser.uid, createdAt: serverTimestamp() });
        toast('Badge criada.');
      }
      resetBadgeForm();
    }catch(e){ toast('Erro: ' + e.message, true); }
  });

  async function deleteBadge(b){
    if(!confirm(`Excluir a badge "${b.name}"? Jogadores que já a possuem vão perdê-la (inclusive da exibição no ranking).`)) return;
    try{
      await deleteDoc(doc(db, 'badges', b.id));
      toast('Badge excluída.');
    }catch(e){ toast('Erro: ' + e.message, true); }
  }

  function openStaffCharProfile(player, c){
    document.getElementById('char-profile-name').textContent = c.name || 'Personagem';
    const info = nextLevelInfo(c.peTotal || 0);
    const pat = patenteAtual(c.patente || 'recruta');
    const nextPat = proximaPatente(info.level, c.patente || 'recruta');
    const pct = info.isMax ? 100 : Math.min(100, Math.round((info.progress / info.needed) * 100));
    const avatarStyle = c.photoURL ? `style="background-image:url('${escapeHtml(c.photoURL)}')"` : '';
    const avatarInitial = c.photoURL ? '' : escapeHtml((c.name||'?').slice(0,1).toUpperCase());
    const body = document.getElementById('char-profile-body');
    body.innerHTML = `
      <div class="char-avatar-lg" ${avatarStyle}>${avatarInitial}</div>
      <div style="text-align:center; margin-bottom:0.8rem;">
        <span class="patente">${pat.label}</span>${c.isAlt ? '<span class="alt-badge">Alt' + (c.altOf ? ' de ' + escapeHtml(c.altOf) : '') + '</span>' : ''}
      </div>
      <div class="field-hint" style="text-align:center; margin-bottom:0.6rem;">Jogador: ${escapeHtml(player.displayName||player.email||player.id)}${c.isActive===false ? ' · Inativo' : ''}</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="label">Nível</div><div class="value">${info.level}</div></div>
        <div class="stat-box"><div class="label">PE total</div><div class="value">${c.peTotal || 0}</div></div>
        <div class="stat-box"><div class="label">Sessões jogadas</div><div class="value">${c.sessionsCount || 0}</div></div>
        <div class="stat-box"><div class="label">Patente</div><div class="value" style="font-size:0.95rem;">${pat.label}</div></div>
      </div>
      <div class="progress-bar" style="margin-top:0.9rem;"><div style="width:${pct}%"></div></div>
      <div class="pe-line">${info.isMax ? 'Nível máximo atingido' : `${info.progress} / ${info.needed} PE para o nível ${info.level+1}`}</div>
      <div class="section-label" style="margin-top:1.1rem;">Progressão</div>
      <div class="field-hint">
        ${info.isMax ? 'Personagem no nível máximo (20).' : `Faltam <b>${info.needed - info.progress} PE</b> para o nível ${info.level+1}.`}<br>
        ${nextPat ? `Próxima patente: <b>${nextPat.label}</b> — requer nível ${nextPat.minLevel} e ${nextPat.cost} PP.` : 'Patente máxima já alcançada.'}<br>
        Conversões de Prestígio em PE usadas: ${c.ppConversionsUsed||0} / ${c.sessionsCount||0} sessões.<br>
        PE de narração aplicados: ${c.gmPeApplied||0} / ${c.sessionsCount||0} sessões.
        ${c.seasonMaxed ? '<br><b style="color:var(--warn);">Em Evolução Máxima da Temporada</b>' : ''}
      </div>
      <div class="section-label" style="margin-top:1.1rem;">Anotações</div>
      <div class="profile-card">${c.notes ? `<div class="bio-text">${escapeHtml(c.notes)}</div>` : '<div class="bio-text bio-empty">Sem anotações.</div>'}</div>

      <div class="section-label" style="margin-top:1.4rem;">Editar diretamente (staff)</div>
      <label>Definir PE total</label>
      <input type="number" id="staff-edit-pe-input" min="0" value="${c.peTotal||0}">
      <label>Patente</label>
      <select id="staff-edit-patente-select">
        ${PATENTES.map(p => `<option value="${p.key}" ${(c.patente||'recruta') === p.key ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
      </select>
      <div class="field-hint">Define o PE e a patente diretamente, sem passar pelo fluxo de solicitação/aprovação.</div>
      <div class="form-actions">
        <button class="btn small primary" id="staff-edit-char-save-btn">Salvar PE e patente</button>
      </div>

      <div class="form-actions" style="margin-top:0.5rem;">
        <button class="btn small primary" id="staff-grant-from-profile-btn">Usar no painel de concessão</button>
      </div>
      <div class="section-label" style="margin-top:1.4rem;">Zona de risco</div>
      <div class="form-actions">
        <button class="btn small danger" id="staff-delete-char-btn">Excluir personagem</button>
      </div>
    `;
    document.getElementById('staff-edit-char-save-btn').addEventListener('click', async () => {
      const peVal = parseInt(document.getElementById('staff-edit-pe-input').value || '0', 10);
      const patenteKey = document.getElementById('staff-edit-patente-select').value;
      if(isNaN(peVal) || peVal < 0){ toast('Informe um valor de PE válido.', true); return; }
      try{
        await updateDoc(doc(db, 'players', player.id, 'characters', c.id), { peTotal: peVal, patente: patenteKey });
        toast('PE e patente atualizados.');
        openStaffCharProfile(player, { ...c, peTotal: peVal, patente: patenteKey });
      }catch(e){ toast('Erro: ' + e.message, true); }
    });
    document.getElementById('staff-grant-from-profile-btn').addEventListener('click', () => {
      closeDrawer('char-profile-drawer');
      switchView('staff');
      const playerSel = document.getElementById('grant-player-select');
      playerSel.value = player.id;
      loadCharsForGrant(player.id).then(() => {
        document.getElementById('grant-char-select').value = c.id;
      });
    });
    document.getElementById('staff-delete-char-btn').addEventListener('click', async () => {
      if(!confirm(`Excluir "${c.name}" (jogador: ${player.displayName||player.email||player.id})? Essa ação não pode ser desfeita.`)) return;
      try{
        await deleteDoc(doc(db, 'players', player.id, 'characters', c.id));
        closeDrawer('char-profile-drawer');
        toast('Personagem excluído pela staff.');
      }catch(e){ toast('Erro: ' + e.message, true); }
    });
    closeDrawer('detail-drawer');
    openDrawer('char-profile-drawer');
  }

  // ================= SESSION COUNT (staff também pode registrar sessão jogada) =================
  // Nota: incrementar sessionsCount de um personagem destrava +1 conversão de PP->PE
  // e +1 PE de narração possíveis. Isso é feito manualmente pela staff junto da
  // concessão de PE/PP daquela sessão (ver painel "Conceder PE / PP manualmente").

  // ================= DRAWERS =================
  function openDrawer(id){
    document.getElementById(id).classList.add('open');
    document.getElementById(id + '-backdrop').classList.add('open');
  }
  function closeDrawer(id){
    document.getElementById(id).classList.remove('open');
    document.getElementById(id + '-backdrop').classList.remove('open');
  }
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeDrawer(btn.dataset.close));
  });
  ['char-drawer','detail-drawer','req-drawer','profile-drawer','char-profile-drawer','player-view-drawer','badge-inspect-drawer'].forEach(id => {
    document.getElementById(id + '-backdrop').addEventListener('click', () => closeDrawer(id));
  });

  function escapeHtml(str){
    return String(str||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
