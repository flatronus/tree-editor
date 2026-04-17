// ════════════════════════════════════════════════════════════
//  ARKHIV — app.js
// ════════════════════════════════════════════════════════════

const ROOT_ID = '__root__';
const LS_KEY  = 'arkhiv_v3';
const LS_SW   = 'arkhiv-sidebar-w';
const LS_SO   = 'arkhiv-sidebar-open';
const LS_LBL  = 'arkhiv-labels';

// ── Firebase config ─────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyAQDvjtD4mmBS6r4TYqfq_SPYPL-7QVGwg",
  authDomain:        "notes-app-b58f8.firebaseapp.com",
  projectId:         "notes-app-b58f8",
  storageBucket:     "notes-app-b58f8.firebasestorage.app",
  messagingSenderId: "184097835729",
  appId:             "1:184097835729:web:2231b0e0f8d1a6af20d3f0"
};

// ── App state ───────────────────────────────────────────────
let state        = { pages: {}, activeId: null };
let unsaved      = false;
let activeFormat = 'plain';
let previewActive = false;
const expandState = {};

// ── Firebase handles ────────────────────────────────────────
let db         = null;
let auth       = null;
let currentUid = null;
let fbReady    = false;
let fbUnsub    = null;

// Write queue — batched writes to Firestore
const writeQueue = new Set();
let writeTimer   = null;

// Tracks every page we wrote to Firestore ourselves.
// When onSnapshot echoes our own write back, we skip it.
const localWrites = new Map(); // id → updatedAt of our write

// ════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════
function initFirebase() {
  if (!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
  db   = firebase.firestore();
  auth = firebase.auth();

  // Offline persistence (works even without internet)
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  // This is the single source of truth for auth state
  // It fires once immediately on load with the cached session
  auth.onAuthStateChanged(user => {
    if (user) {
      currentUid = user.uid;
      fbReady    = true;
      onLogin(user);
    } else {
      currentUid = null;
      fbReady    = false;
      onLogout();
    }
  });
}

// Called when user is confirmed logged in
function onLogin(user) {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const badge = document.getElementById('user-email-badge');
  if (badge) {
    const name = user.displayName || user.email || '';
    badge.textContent = name ? '· ' + (name.includes('@') ? name.split('@')[0] : name) : '';
  }

  setSyncStatus('syncing');

  // Load remote data first, then subscribe to changes
  syncFromFirestore().then(() => {
    subscribeFirestore();
  });
}

function onLogout() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-overlay').classList.remove('hidden');
  // Show login form (not spinner)
  document.getElementById('auth-spinner-wrap').classList.add('hidden');
  document.getElementById('auth-forms').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════
//  FIRESTORE — user-scoped path: users/{uid}/pages/{id}
//
//  SYNC RULES:
//  1. Device → DB : only on explicit Save (button / Ctrl+S)
//  2. DB → Device : automatically when DB changes (onSnapshot)
//                   but NEVER overwrite a page the user is
//                   currently editing (unsaved changes).
//  3. On app open : full download from DB if DB has data;
//                   upload local if DB is empty (first run).
// ════════════════════════════════════════════════════════════
function pagesCol() {
  return db.collection('users').doc(currentUid).collection('pages');
}

// ── Helpers ─────────────────────────────────────────────────

// Apply a set of remote pages to local state and refresh UI.
// Pages the user is currently editing are protected — only
// metadata (title, parentId, format) is updated, content is kept.
function applyRemotePages(remoteMap, { fullReplace = false } = {}) {
  if (fullReplace) {
    state.pages = {};
  }

  Object.values(remoteMap).forEach(remote => {
    const id = remote.id;
    if (!id) return;
    const local = state.pages[id];
    const isEditing = (id === state.activeId && unsaved);

    if (isEditing) {
      // Keep local content; accept remote structural fields
      state.pages[id] = { ...remote, content: local.content, children: local.children || [] };
    } else {
      state.pages[id] = { ...remote, children: local ? local.children : [] };
    }
  });

  ensureRoot();
  rebuildChildrenFromParentId();
  saveLocalOnly();
}

// Remove a remote-deleted page from local state.
function applyRemoteDelete(id) {
  if (!state.pages[id] || id === ROOT_ID) return;
  const page = state.pages[id];
  if (page.parentId && state.pages[page.parentId]) {
    const par = state.pages[page.parentId];
    par.children = (par.children || []).filter(c => c !== id);
  }
  delete state.pages[id];
}

// ── Initial load (called once on login) ─────────────────────
async function syncFromFirestore() {
  if (!fbReady || !currentUid) return;
  setSyncStatus('syncing');
  try {
    const snap = await pagesCol().get();
    if (!snap.empty) {
      // DB has data — it is the source of truth on first load
      const remoteMap = {};
      snap.forEach(doc => {
        remoteMap[doc.id] = { ...doc.data(), id: doc.id, children: [] };
      });
      applyRemotePages(remoteMap, { fullReplace: true });
      renderTree();
      if (state.activeId && state.pages[state.activeId]) openPage(state.activeId);
      else openPage(ROOT_ID);
      setSyncStatus('synced');
    } else {
      // DB empty — first run on a new device, push local data up
      await batchUploadAll();
    }
  } catch (e) {
    console.warn('syncFromFirestore error', e);
    setSyncStatus('error');
  }
}

// ── Upload all local pages (first-run / manual full push) ───
async function batchUploadAll() {
  const pages = Object.values(state.pages);
  if (!pages.length) { setSyncStatus('synced'); return; }
  setSyncStatus('syncing');
  for (let i = 0; i < pages.length; i += 400) {
    const batch = db.batch();
    pages.slice(i, i + 400).forEach(p => batch.set(pagesCol().doc(p.id), pageToFirestore(p)));
    await batch.commit();
  }
  setSyncStatus('synced');
}

// ── Real-time listener: DB → Device ─────────────────────────
// Fires whenever the DB changes (from any device).
// This is READ-ONLY from the perspective of this device —
// we never write to DB from here.
function subscribeFirestore() {
  if (!fbReady || !currentUid) return;
  if (fbUnsub) fbUnsub();

  // skipFirst: the initial snapshot fires immediately and contains
  // all existing docs as 'added'. We already loaded them in
  // syncFromFirestore(), so we skip that first batch.
  let skipFirst = true;

  fbUnsub = pagesCol().onSnapshot({ includeMetadataChanges: false }, snap => {
    if (skipFirst) {
      skipFirst = false;
      return; // already handled by syncFromFirestore()
    }

    // localWrites: ignore echo of our own Save
    // (Firestore echoes every write back to the same client)
    const toApply  = {};
    const toDelete = [];
    let   hasChanges = false;

    snap.docChanges().forEach(change => {
      const id = change.doc.id;

      if (change.type === 'removed') {
        // Always apply deletes (deletion is authoritative)
        toDelete.push(id);
        hasChanges = true;
        return;
      }

      // Skip the echo of our own write
      const ourTs = localWrites.get(id);
      const remoteTs = change.doc.data().updatedAt;
      if (ourTs !== undefined && remoteTs === ourTs) {
        localWrites.delete(id);
        return; // our own data, already correct locally
      }
      localWrites.delete(id);

      // Genuine change from another device — queue for apply
      toApply[id] = { ...change.doc.data(), id, children: [] };
      hasChanges = true;
    });

    if (!hasChanges) return;

    toDelete.forEach(id => applyRemoteDelete(id));
    if (Object.keys(toApply).length) applyRemotePages(toApply);

    ensureRoot();
    rebuildChildrenFromParentId();
    saveLocalOnly();
    renderTree();

    // Refresh editor only if active page changed from remote
    // and user has no unsaved edits
    if (state.activeId && state.pages[state.activeId] && !unsaved) {
      if (toApply[state.activeId]) {
        reloadEditorContent(state.pages[state.activeId]);
      }
    }

    setSyncStatus('synced');

  }, err => {
    console.warn('Firestore listener error', err.code, err.message);
    setSyncStatus(navigator.onLine ? 'error' : 'offline');
  });
}

// Queue a page write — flushed only on explicit Save (Ctrl+S / кнопка)
function fbQueueWrite(page) {
  if (!fbReady || !currentUid) return;
  writeQueue.add(page.id);
}

// Serialise a page for Firestore — strip runtime-only children[] field
// The tree is reconstructed from parentId on every load/sync, so storing
// children[] in Firestore only causes cross-device conflicts.
function pageToFirestore(page) {
  const { children, ...rest } = page; // eslint-disable-line no-unused-vars
  return rest;
}

async function flushWriteQueue() {
  if (!fbReady || !currentUid || !writeQueue.size) return;
  setSyncStatus('syncing');
  const ids = [...writeQueue];
  writeQueue.clear();
  try {
    const batch = db.batch();
    ids.forEach(id => {
      const p = state.pages[id];
      if (p) batch.set(pagesCol().doc(id), pageToFirestore(p));
    });
    await batch.commit();
    // Pages confirmed in Firestore — remove from recently-created guard
    ids.forEach(id => recentlyCreated.delete(id));
    // Record that these are OUR writes — onSnapshot echo must be ignored
    ids.forEach(id => {
      if (state.pages[id]) localWrites.set(id, state.pages[id].updatedAt);
    });
    setSyncStatus('synced');
  } catch (e) {
    console.warn('flushWriteQueue error', e);
    // Re-queue on failure
    ids.forEach(id => writeQueue.add(id));
    setSyncStatus('error');
    setTimeout(flushWriteQueue, 5000);
  }
}

async function fbDeletePage(id) {
  if (!fbReady || !currentUid) return;
  try { await pagesCol().doc(id).delete(); } catch (e) { console.warn(e); }
}

function setSyncStatus(s) {
  const el = document.getElementById('status-sync');
  if (!el) return;
  const map = { syncing: '↻ синхронізація…', synced: '☁ синхронізовано', offline: '○ офлайн', error: '⚠ помилка', pending: '● не збережено' };
  el.textContent = map[s] || '';
  el.className = 'sync-badge ' + s;
}

// ════════════════════════════════════════════════════════════
//  AUTH UI
// ════════════════════════════════════════════════════════════
function authError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg; el.classList.remove('hidden'); el.style.color = '';
}

// Google sign-in — only auth method
document.getElementById('btn-google').addEventListener('click', async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    // onAuthStateChanged handles everything after this
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') authError(e.message);
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  auth.signOut();
});

// ════════════════════════════════════════════════════════════
//  LOCAL STORAGE
// ════════════════════════════════════════════════════════════
function saveLocalOnly() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ pages: state.pages, activeId: state.activeId })); }
  catch (e) { console.warn(e); }
}
function saveState() { saveLocalOnly(); }

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const p = JSON.parse(raw); state.pages = p.pages || {}; state.activeId = p.activeId || null; }
  } catch (e) { console.warn(e); }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function ensureRoot() {
  if (!state.pages[ROOT_ID]) {
    state.pages[ROOT_ID] = { id: ROOT_ID, title: 'Мій архів', content: '', format: 'plain', parentId: null, children: [], createdAt: Date.now(), updatedAt: Date.now() };
    // Write root to Firestore so other devices see it
    if (fbReady) fbQueueWrite(state.pages[ROOT_ID]);
  }
  Object.values(state.pages).forEach(p => { if (!Array.isArray(p.children)) p.children = []; });
}

// Rebuild children[] arrays from parentId — fixes tree after Firestore sync
// Strategy: collect all children grouped by parentId, then merge with existing
// order (existing order in parent.children takes priority, new ones appended)
function rebuildChildrenFromParentId() {
  // Group child IDs by parentId
  const byParent = {};
  Object.values(state.pages).forEach(p => {
    if (p.parentId && state.pages[p.parentId]) {
      if (!byParent[p.parentId]) byParent[p.parentId] = new Set();
      byParent[p.parentId].add(p.id);
    }
  });

  // For each parent: keep existing order, append missing, remove orphans
  Object.values(state.pages).forEach(p => {
    const expected = byParent[p.id] || new Set();
    // Keep existing valid children in their current order
    const kept = (p.children || []).filter(c => expected.has(c));
    // Append any new children not yet in the list (sorted by createdAt)
    const existing = new Set(kept);
    const newKids = [...expected].filter(c => !existing.has(c));
    newKids.sort((a, b) => (state.pages[a]?.createdAt || 0) - (state.pages[b]?.createdAt || 0));
    p.children = [...kept, ...newKids];
  });
}

// ════════════════════════════════════════════════════════════
//  PAGE CRUD
// ════════════════════════════════════════════════════════════
function createPage(parentId) {
  const id = uid();
  const now = Date.now();
  const page = { id, title: 'Без назви', content: '', format: 'auto', parentId, children: [], createdAt: now, updatedAt: now };
  state.pages[id] = page;
  const parent = state.pages[parentId];
  if (parent) {
    if (!Array.isArray(parent.children)) parent.children = [];
    if (!parent.children.includes(id)) parent.children.push(id);
    parent.updatedAt = now;
    // No need to fbQueueWrite(parent) — tree structure is derived from child's parentId
  }
  saveState();
  fbQueueWrite(page);
  // Flush immediately — new page must appear on other devices right away
  flushWriteQueue();
  return page;
}

function deletePage(id) {
  if (id === ROOT_ID) return;
  const page = state.pages[id]; if (!page) return;
  [...(page.children || [])].forEach(deletePage);
  const parent = state.pages[page.parentId];
  if (parent) {
    parent.children = parent.children.filter(c => c !== id);
    // No need to write parent to Firestore — child deletion triggers rebuild on all devices
  }
  fbDeletePage(id);
  delete state.pages[id];
  saveState();
}

function duplicatePage(id) {
  if (id === ROOT_ID) return null;
  const src = state.pages[id]; if (!src) return null;
  const np = createPage(src.parentId);
  np.title = src.title + ' (копія)'; np.content = src.content; np.format = src.format;
  np.updatedAt = Date.now();
  saveState(); fbQueueWrite(np); flushWriteQueue();
  return np;
}

// ════════════════════════════════════════════════════════════
//  FORMAT
// ════════════════════════════════════════════════════════════
function detectFormat(text) {
  if (!text || !text.trim()) return 'plain';
  let md = 0;
  for (const l of text.split('\n')) {
    if (/^#{1,6}\s/.test(l)) md += 3;
    if (/^\s*[-*+]\s/.test(l)) md += 2;
    if (/^\s*\d+\.\s/.test(l)) md += 2;
    if (/\*\*|__/.test(l)) md += 1;
    if (/\[.+\]\(.+\)/.test(l)) md += 2;
    if (/^```|^> /.test(l)) md += 3;
  }
  if ((text.match(/<[a-z][a-z0-9]*[\s>]/gi) || []).length > 3) return 'rich';
  return md >= 4 ? 'markdown' : 'plain';
}
function resolveFormat(page) { return page.format !== 'auto' ? page.format : detectFormat(page.content); }

// ════════════════════════════════════════════════════════════
//  TREE HELPERS
// ════════════════════════════════════════════════════════════
function collectSubtree(id) {
  const p = state.pages[id]; if (!p) return [];
  return [p, ...(p.children || []).flatMap(c => collectSubtree(c))];
}
function isInSubtree(targetId, rootId) {
  if (targetId === rootId) return true;
  const p = state.pages[rootId]; if (!p) return false;
  return (p.children || []).some(c => isInSubtree(targetId, c));
}
function getBreadcrumb(id) {
  const parts = []; let cur = state.pages[id];
  while (cur) { parts.unshift(cur.title); cur = cur.parentId ? state.pages[cur.parentId] : null; }
  return parts.join(' › ');
}
function updateBreadcrumb(id) {
  const bc = getBreadcrumb(id);
  const el = document.getElementById('breadcrumb-bar'); if (el) el.textContent = bc;
}

// ════════════════════════════════════════════════════════════
//  RENDER TREE
// ════════════════════════════════════════════════════════════
function renderTree() {
  const treeEl = document.getElementById('tree-root');
  treeEl.innerHTML = '';
  const q = document.getElementById('search-input').value.trim().toLowerCase();

  function buildNode(id, depth) {
    const page = state.pages[id]; if (!page) return null;
    const children = page.children || [];
    const hasKids = children.length > 0;
    const matchTitle = page.title.toLowerCase().includes(q);
    const childNodes = children.map(c => buildNode(c, depth + 1)).filter(Boolean);
    if (q && !matchTitle && !childNodes.length) return null;

    const item = document.createElement('div');
    item.className = 'tree-item';

    const row = document.createElement('div');
    row.className = 'tree-row' + (state.activeId === id ? ' active' : '');
    row.dataset.id = id;
    row.style.paddingLeft = (4 + depth * 13) + 'px';
    row.title = page.title;

    // Toggle
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (hasKids) {
      toggle.innerHTML = expandState[id] !== false ? '&#9660;' : '&#9654;';
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        expandState[id] = expandState[id] === false ? true : false;
        renderTree();
      });
    } else {
      toggle.innerHTML = '<i class="tree-dot"></i>';
    }

    // Icon → page actions popup
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.title = 'Зберегти / Експортувати гілку';
    icon.textContent = id === ROOT_ID ? '⌂' : '◻';
    icon.addEventListener('click', e => { e.stopPropagation(); showPageActions(id, icon); });

    // Label
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = page.title;

    row.append(toggle, icon, label);
    item.appendChild(row);

    if (hasKids && (expandState[id] !== false || q)) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-children';
      childNodes.forEach(n => wrap.appendChild(n));
      item.appendChild(wrap);
    }

    row.addEventListener('click', e => { if (e.target === toggle || e.target === icon) return; openPage(id); });
    row.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, id); });
    return item;
  }

  const root = buildNode(ROOT_ID, 0);
  if (root) treeEl.appendChild(root);
}

// ════════════════════════════════════════════════════════════
//  LABELS TOGGLE
// ════════════════════════════════════════════════════════════
let labelsExpanded = localStorage.getItem(LS_LBL) === '1';
function applyLabels() {
  document.body.classList.toggle('labels-expanded', labelsExpanded);
  document.getElementById('btn-expand-labels')?.classList.toggle('active', labelsExpanded);
}
document.getElementById('btn-expand-labels').addEventListener('click', () => {
  labelsExpanded = !labelsExpanded;
  localStorage.setItem(LS_LBL, labelsExpanded ? '1' : '0');
  applyLabels();
});

// ════════════════════════════════════════════════════════════
//  PAGE ACTIONS POPUP
// ════════════════════════════════════════════════════════════
function showPageActions(id, anchor) {
  document.querySelectorAll('.page-action-popup').forEach(el => el.remove());
  const popup = document.createElement('div');
  popup.className = 'page-action-popup';
  const pages = collectSubtree(id);
  popup.innerHTML = `
    <div class="popup-title">${state.pages[id]?.title || ''}</div>
    <div class="popup-sub">${pages.length === 1 ? 'лише ця сторінка' : pages.length + ' сторінок у гілці'}</div>
    <button data-act="save">💾 Зберегти і синхронізувати</button>
    <button data-act="pdf">📑 Експорт у PDF</button>
    <button data-act="txt">📃 Експорт у TXT</button>`;
  document.body.appendChild(popup);
  const rect = anchor.getBoundingClientRect();
  popup.style.cssText = `top:${rect.bottom + 4}px;left:${Math.max(4, Math.min(rect.left, window.innerWidth - 200))}px`;
  popup.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    popup.remove();
    if (btn.dataset.act === 'save') { saveBranch(id); }
    else if (btn.dataset.act === 'pdf') exportBranchPDF(id);
    else if (btn.dataset.act === 'txt') exportBranchTXT(id);
  });
  setTimeout(() => document.addEventListener('click', function h() { popup.remove(); document.removeEventListener('click', h); }), 0);
}

function saveBranch(id) {
  if (state.activeId && isInSubtree(state.activeId, id)) saveCurrentEditorToPage(false);
  collectSubtree(id).forEach(p => writeQueue.add(p.id));
  setSyncStatus('syncing');
  flushWriteQueue();
}

// ════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════
function pageToHtml(page) {
  const fmt = resolveFormat(page);
  if (fmt === 'markdown') return typeof marked !== 'undefined' ? marked.parse(page.content || '') : (page.content || '').replace(/\n/g, '<br>');
  if (fmt === 'rich') return page.content || '';
  return '<pre>' + (page.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
}

function exportBranchPDF(id) {
  const pages = collectSubtree(id);
  const styles = `<style>
    body{font-family:Georgia,serif;color:#111;font-size:11pt;line-height:1.75;margin:0;padding:0}
    h1{font-size:15pt;font-weight:500;color:#1a1a2e;margin:14pt 0 3pt;border-bottom:1pt solid #4A90D9;padding-bottom:3pt}
    h2{font-size:13pt;color:#2563a8;margin:11pt 0 3pt} h3{font-size:11pt;color:#4a5568;margin:8pt 0 2pt}
    p{margin:4pt 0}ul,ol{padding-left:16pt;margin:4pt 0}
    pre{background:#f5f7fa;border:0.5pt solid #e2e8f0;padding:6pt 9pt;white-space:pre-wrap;font-size:9pt;font-family:monospace}
    code{background:#f0f2f5;padding:1pt 3pt;font-family:monospace;font-size:9pt;color:#c7254e}
    blockquote{border-left:2pt solid #4A90D9;margin:6pt 0;padding-left:9pt;color:#4a5568;font-style:italic}
    table{width:100%;border-collapse:collapse;margin:6pt 0}th{background:#eef2f8;border:0.5pt solid #cbd5e1;padding:3pt 6pt;font-weight:500}td{border:0.5pt solid #e2e8f0;padding:3pt 6pt}
    hr{border:none;border-top:0.5pt solid #e2e8f0;margin:10pt 0 7pt}
    .crumb{font-size:8pt;color:#94a3b8;margin-bottom:1pt;font-family:monospace}
  </style>`;
  let body = '';
  pages.forEach((page, i) => {
    body += (i > 0 ? '<hr>' : '') + `<div class="crumb">${getBreadcrumb(page.id)}</div><h1>${page.title}</h1>` + pageToHtml(page);
  });
  const el = document.createElement('div');
  el.style.cssText = 'padding:10mm 12mm;background:#fff';
  el.innerHTML = styles + body;
  if (typeof html2pdf !== 'undefined') {
    html2pdf().set({ margin:[10,12,10,12], filename:(state.pages[id]?.title||'export')+'.pdf', html2canvas:{scale:2,useCORS:true}, jsPDF:{unit:'mm',format:'a4'}, pagebreak:{mode:['avoid-all','css']} }).from(el).save();
  } else {
    const w = window.open('', '_blank');
    w.document.write('<!DOCTYPE html><html><body>' + el.innerHTML + '</body></html>');
    w.document.close(); setTimeout(() => w.print(), 700);
  }
}

function exportBranchTXT(id) {
  const txt = collectSubtree(id).map((p, i) =>
    (i > 0 ? '\n\n' + '─'.repeat(60) + '\n\n' : '') + `# ${p.title}\n${getBreadcrumb(p.id)}\n\n` + (p.content || '').replace(/<[^>]+>/g, '')
  ).join('');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = (state.pages[id]?.title || 'export') + '.txt';
  a.click();
}

// ════════════════════════════════════════════════════════════
//  OPEN PAGE / EDITOR
// ════════════════════════════════════════════════════════════
function openPage(id) {
  if (unsaved && state.activeId) saveCurrentEditorToPage();
  state.activeId = id; saveState();
  const page = state.pages[id]; if (!page) return;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('editor-wrap').classList.remove('hidden');
  document.getElementById('page-title').value = page.title;
  document.getElementById('format-select').value = page.format || 'auto';
  updateBreadcrumb(id);

  previewActive = false;
  document.getElementById('btn-preview').querySelector('.btn-icon').textContent = '▶';
  document.querySelector('#btn-preview .btn-label').textContent = ' Перегляд';

  activeFormat = resolveFormat(page);
  applyEditorFormat(activeFormat, page.content || '');
  updateStatusFormat(activeFormat);
  updateWordCount();
  setUnsaved(false);
  renderTree();

  if (window.innerWidth <= 700) setSidebarOpen(false);
}

function reloadEditorContent(page) {
  const fmt = resolveFormat(page);
  activeFormat = fmt;
  document.getElementById('format-select').value = page.format || 'auto';
  applyEditorFormat(fmt, page.content || '');
  updateStatusFormat(fmt);
  updateWordCount();
  updateBreadcrumb(page.id);
}

function applyEditorFormat(fmt, content) {
  const plain = document.getElementById('editor-plain');
  const rich  = document.getElementById('editor-rich');
  const prev  = document.getElementById('editor-preview');
  const fbar  = document.getElementById('format-bar');
  plain.classList.add('hidden'); rich.classList.add('hidden'); prev.classList.add('hidden'); fbar.classList.add('hidden');
  if (fmt === 'rich') { rich.classList.remove('hidden'); fbar.classList.remove('hidden'); rich.innerHTML = content; }
  else { plain.classList.remove('hidden'); plain.value = content; }
}

function getEditorContent() {
  return activeFormat === 'rich' ? document.getElementById('editor-rich').innerHTML : document.getElementById('editor-plain').value;
}

function saveCurrentEditorToPage(flushRemote = false) {
  const id = state.activeId; if (!id || !state.pages[id]) return;
  const page = state.pages[id];
  page.title   = document.getElementById('page-title').value.trim() || 'Без назви';
  page.format  = document.getElementById('format-select').value;
  page.content = getEditorContent();
  page.updatedAt = Date.now();
  saveState();
  fbQueueWrite(page);
  setUnsaved(false);
  renderTree();
  if (flushRemote) {
    setSyncStatus('syncing');
    flushWriteQueue();
  }
}

function setUnsaved(val) {
  unsaved = val;
  // No separate "saved" indicator — sync status covers it
}

function setSavedFlash() {
  // Trigger immediate flush and show syncing
  flushWriteQueue();
}

function updateStatusFormat(fmt) {
  const L = { plain:'Текст', markdown:'Markdown', rich:'Форматований', auto:'Авто' };
  document.getElementById('status-format').textContent = 'Формат: ' + (L[fmt] || fmt);
}
function updateWordCount() {
  const text = getEditorContent().replace(/<[^>]+>/g, ' ');
  document.getElementById('status-words').textContent = (text.trim() ? text.trim().split(/\s+/).length : 0) + ' слів';
}

// ════════════════════════════════════════════════════════════
//  PREVIEW
// ════════════════════════════════════════════════════════════
function togglePreview() {
  const plain = document.getElementById('editor-plain');
  const rich  = document.getElementById('editor-rich');
  const prev  = document.getElementById('editor-preview');
  const lbl   = document.querySelector('#btn-preview .btn-label');
  const ico   = document.querySelector('#btn-preview .btn-icon');
  if (!previewActive) {
    let html = '';
    const c = getEditorContent();
    if (activeFormat === 'markdown') html = typeof marked !== 'undefined' ? marked.parse(c) : c.replace(/\n/g,'<br>');
    else if (activeFormat === 'rich') html = c;
    else html = '<pre style="white-space:pre-wrap">' + c.replace(/</g,'&lt;') + '</pre>';
    prev.innerHTML = html;
    plain.classList.add('hidden'); rich.classList.add('hidden'); prev.classList.remove('hidden');
    if (ico) ico.textContent = '✕'; if (lbl) lbl.textContent = ' Редагувати';
    previewActive = true;
  } else {
    prev.classList.add('hidden');
    applyEditorFormat(activeFormat, getEditorContent());
    if (ico) ico.textContent = '▶'; if (lbl) lbl.textContent = ' Перегляд';
    previewActive = false;
  }
}

// ════════════════════════════════════════════════════════════
//  CONTEXT MENU
// ════════════════════════════════════════════════════════════
const ctxMenu = document.getElementById('ctx-menu');
let ctxTargetId = null;

function showCtxMenu(x, y, id) {
  ctxTargetId = id;
  const isRoot = id === ROOT_ID;
  ctxMenu.querySelector('[data-action="delete"]').style.display    = isRoot ? 'none' : '';
  ctxMenu.querySelector('[data-action="duplicate"]').style.display = isRoot ? 'none' : '';
  ctxMenu.querySelectorAll('hr').forEach(hr => hr.style.display = isRoot ? 'none' : '');
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - 180) + 'px';
}
document.addEventListener('click', e => { if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden'); });

ctxMenu.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const action = btn.dataset.action, id = ctxTargetId;
  ctxMenu.classList.add('hidden');
  if (action === 'rename') {
    startInlineRename(id);
  } else if (action === 'add-child') {
    const child = createPage(id);
    expandState[id] = true;   // expand parent
    renderTree();
    openPage(child.id);
    setTimeout(() => startInlineRename(child.id), 120);
  } else if (action === 'duplicate') {
    const np = duplicatePage(id);
    if (np) { expandState[np.parentId] = true; renderTree(); openPage(np.id); }
  } else if (action === 'delete') {
    showModal(`Видалити "${state.pages[id]?.title}" та всі підсторінки?`, () => {
      const wasActive = isInSubtree(state.activeId, id);
      deletePage(id);
      if (wasActive) { state.activeId = null; document.getElementById('editor-wrap').classList.add('hidden'); document.getElementById('empty-state').classList.remove('hidden'); }
      renderTree();
    });
  }
});

// ════════════════════════════════════════════════════════════
//  INLINE RENAME
// ════════════════════════════════════════════════════════════
function startInlineRename(id) {
  renderTree();
  requestAnimationFrame(() => {
    const row = document.querySelector(`.tree-row[data-id="${id}"]`); if (!row) return;
    const label = row.querySelector('.tree-label');
    const inp = document.createElement('input');
    inp.className = 'rename-input'; inp.value = label.textContent;
    label.textContent = ''; label.appendChild(inp);
    inp.focus(); inp.select();
    const commit = () => {
      const val = inp.value.trim() || 'Без назви';
      if (state.pages[id]) {
        state.pages[id].title = val; state.pages[id].updatedAt = Date.now();
        if (state.activeId === id) { document.getElementById('page-title').value = val; updateBreadcrumb(id); }
        saveState(); fbQueueWrite(state.pages[id]); flushWriteQueue();
      }
      renderTree();
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') renderTree(); });
    inp.addEventListener('blur', commit);
  });
}

// ════════════════════════════════════════════════════════════
//  MODAL
// ════════════════════════════════════════════════════════════
function showModal(text, onConfirm) {
  document.getElementById('modal-text').textContent = text;
  document.getElementById('modal-overlay').classList.remove('hidden');
  const close = () => document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-confirm').onclick = () => { close(); onConfirm(); };
  document.getElementById('modal-cancel').onclick = close;
}

// ════════════════════════════════════════════════════════════
//  SIDEBAR
// ════════════════════════════════════════════════════════════
function setSidebarOpen(open) {
  const sb = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 700;
  if (isMobile) { sb.style.top = document.getElementById('global-topbar').offsetHeight + 'px'; sb.classList.toggle('mobile-open', open); sb.classList.remove('collapsed'); }
  else { sb.classList.toggle('collapsed', !open); }
  localStorage.setItem(LS_SO, open ? '1' : '0');
  const arrow = document.getElementById('sidebar-arrow');
  if (arrow) arrow.innerHTML = open ? '&#8592;' : '&#8594;';
}
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 700;
  const isOpen = isMobile ? sb.classList.contains('mobile-open') : !sb.classList.contains('collapsed');
  setSidebarOpen(!isOpen);
}
document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
document.getElementById('editor-area').addEventListener('click', () => { if (window.innerWidth <= 700) setSidebarOpen(false); });

// Resize handle
(function () {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  function doResize(dx) {
    if (window.innerWidth <= 700) return;
    const w = Math.min(Math.max(sidebar.offsetWidth + dx, 150), Math.floor(window.innerWidth * 0.6));
    sidebar.style.width = w + 'px'; sidebar.style.transition = 'none';
  }
  function endResize() { sidebar.style.transition = ''; localStorage.setItem(LS_SW, sidebar.offsetWidth); resizer.classList.remove('dragging'); document.body.style.cursor = document.body.style.userSelect = ''; }
  resizer.addEventListener('mousedown', e => {
    let lx = e.clientX; resizer.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    const mm = e2 => { doResize(e2.clientX - lx); lx = e2.clientX; };
    const mu = () => { endResize(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  });
  resizer.addEventListener('touchstart', e => {
    let lx = e.touches[0].clientX;
    const tm = e2 => { doResize(e2.touches[0].clientX - lx); lx = e2.touches[0].clientX; };
    const te = () => { endResize(); document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', te); };
    document.addEventListener('touchmove', tm, { passive: true }); document.addEventListener('touchend', te);
  }, { passive: true });
})();

// ════════════════════════════════════════════════════════════
//  EDITOR CONTROLS
// ════════════════════════════════════════════════════════════
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const parentId = state.activeId || ROOT_ID;
    const p = createPage(parentId);
    p.content = ev.target.result; p.title = file.name.replace(/\.[^.]+$/, '');
    const ext = file.name.split('.').pop().toLowerCase();
    p.format = ext === 'md' ? 'markdown' : ext === 'html' ? 'rich' : 'auto';
    p.updatedAt = Date.now();
    expandState[parentId] = true; saveState(); fbQueueWrite(p); flushWriteQueue(); renderTree(); openPage(p.id);
  };
  reader.readAsText(file); e.target.value = '';
});

document.getElementById('btn-export-pdf').addEventListener('click', () => { if (!state.activeId) return; saveCurrentEditorToPage(); exportBranchPDF(state.activeId); });

document.getElementById('format-bar').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  if (btn.dataset.cmd) { if (btn.dataset.cmd === 'createLink') { const u = prompt('URL:'); if (u) document.execCommand('createLink', false, u); } else document.execCommand(btn.dataset.cmd, false, null); }
  else if (btn.dataset.heading) document.execCommand('formatBlock', false, btn.dataset.heading);
  document.getElementById('editor-rich').focus(); unsaved = true;
});

document.getElementById('format-select').addEventListener('change', e => {
  if (!state.activeId) return;
  const fmt = e.target.value, content = getEditorContent();
  state.pages[state.activeId].format = fmt;
  activeFormat = fmt === 'auto' ? detectFormat(content) : fmt;
  previewActive = false;
  applyEditorFormat(activeFormat, content); updateStatusFormat(activeFormat); unsaved = true;
});

document.getElementById('btn-save').addEventListener('click', () => {
  saveCurrentEditorToPage(true);
});

document.getElementById('btn-delete-page').addEventListener('click', () => {
  const id = state.activeId; if (!id || id === ROOT_ID) return;
  showModal(`Видалити "${state.pages[id]?.title}"?`, () => {
    deletePage(id); state.activeId = null;
    document.getElementById('editor-wrap').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    renderTree();
  });
});

document.getElementById('btn-preview').addEventListener('click', togglePreview);

document.getElementById('btn-new-page').addEventListener('click', () => {
  // Save current page first, then reset unsaved to prevent double-save
  if (unsaved && state.activeId) saveCurrentEditorToPage();
  unsaved = false;

  // New page is child of current active page (or root)
  const parentId = state.activeId || ROOT_ID;
  const p = createPage(parentId);

  // Expand parent so child appears in tree
  expandState[parentId] = true;

  renderTree();
  openPage(p.id);
  setTimeout(() => document.getElementById('page-title').select(), 60);
});
document.getElementById('btn-create-first').addEventListener('click', () => document.getElementById('btn-new-page').click());

document.getElementById('page-title').addEventListener('input', e => {
  if (state.activeId && state.pages[state.activeId]) { state.pages[state.activeId].title = e.target.value || 'Без назви'; updateBreadcrumb(state.activeId); renderTree(); }
  unsaved = true; setSyncStatus('pending');
});
document.getElementById('editor-plain').addEventListener('input', () => { unsaved = true; setSyncStatus('pending'); updateWordCount(); if (state.pages[state.activeId]?.format === 'auto') updateStatusFormat(detectFormat(document.getElementById('editor-plain').value)); });
document.getElementById('editor-rich').addEventListener('input', () => { unsaved = true; setSyncStatus('pending'); updateWordCount(); });
document.getElementById('search-input').addEventListener('input', renderTree);

// ════════════════════════════════════════════════════════════
//  KEYBOARD
// ════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') { e.preventDefault(); saveCurrentEditorToPage(true); }
  if (mod && e.key === 'n') { e.preventDefault(); document.getElementById('btn-new-page').click(); }
  if (mod && e.shiftKey && e.key === 'P') { e.preventDefault(); togglePreview(); }
});

// ════════════════════════════════════════════════════════════
//  AUTOSAVE + NETWORK
// ════════════════════════════════════════════════════════════
setInterval(() => { if (unsaved && state.activeId) saveCurrentEditorToPage(); }, 15000);
window.addEventListener('online',  () => setSyncStatus(writeQueue.size > 0 ? 'pending' : 'synced'));
window.addEventListener('offline', () => setSyncStatus('offline'));

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
loadState();
ensureRoot();

const savedW = localStorage.getItem(LS_SW);
if (savedW && window.innerWidth > 700) document.getElementById('sidebar').style.width = savedW + 'px';

// Sidebar defaults: open on desktop, closed on mobile
const sidebarPref = localStorage.getItem(LS_SO);
setSidebarOpen(window.innerWidth > 700 ? sidebarPref !== '0' : false);

applyLabels();
if (expandState[ROOT_ID] === undefined) expandState[ROOT_ID] = true;

// Render local data immediately (works offline)
renderTree();
if (state.activeId && state.pages[state.activeId]) openPage(state.activeId);
else openPage(ROOT_ID);

// Firebase init — auth overlay shows/hides automatically via onAuthStateChanged
window.addEventListener('load', () => initFirebase());
