// ════════════════════════════════════════════════════════════
//  ARKHIV — app.js
// ════════════════════════════════════════════════════════════

const ROOT_ID  = 'root';
const TRASH_ID = 'trash';
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
    startPolling();
  });
}

function onLogout() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  stopPolling();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-overlay').classList.remove('hidden');
  // Show login form (not spinner)
  document.getElementById('auth-spinner-wrap').classList.add('hidden');
  document.getElementById('auth-forms').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════
//  FIRESTORE — user-scoped path: users/{uid}/pages/{id}
//
//  SYNC MODEL:
//  • Device → DB : only on explicit Save (button / Ctrl+S)
//    After saving, writes timestamp to users/{uid}/meta {lastSync}
//
//  • DB → Device : polling loop every 30s checks meta.lastSync
//    If DB lastSync > local lastSync → pull all changed pages
//    (pages where updatedAt > localLastSync)
//
//  • On app open : full pull from DB (source of truth)
// ════════════════════════════════════════════════════════════
function pagesCol() {
  return db.collection('users').doc(currentUid).collection('pages');
}
function metaDoc() {
  return db.collection('users').doc(currentUid).collection('meta').doc('sync');
}

// Local timestamp of last successful sync from DB
let localLastSync = 0;
let pollTimer     = null;

// ── Initial load ─────────────────────────────────────────────
async function syncFromFirestore() {
  if (!fbReady || !currentUid) return;
  setSyncStatus('syncing');
  try {
    const snap = await pagesCol().get();
    if (!snap.empty) {
      state.pages = {};
      snap.forEach(doc => {
        const data = { ...doc.data(), id: doc.id, children: [] };
        if (doc.id === '__root__') {
          data.id = ROOT_ID;
          state.pages[ROOT_ID] = data;
        } else {
          if (data.parentId === '__root__') data.parentId = ROOT_ID;
          state.pages[doc.id] = data;
        }
      });
      // Migrate old __root__ document if present
      if (snap.docs.some(d => d.id === '__root__')) {
        try {
          await pagesCol().doc('__root__').delete();
          if (state.pages[ROOT_ID]) {
            await pagesCol().doc(ROOT_ID).set(pageToFirestore(state.pages[ROOT_ID]));
          }
          const fixBatch = db.batch();
          Object.values(state.pages).forEach(p => {
            if (p.id !== ROOT_ID) fixBatch.set(pagesCol().doc(p.id), pageToFirestore(p));
          });
          await fixBatch.commit();
        } catch (me) { console.warn('migration error', me); }
      }
      ensureRoot();
      rebuildChildrenFromParentId();
      saveLocalOnly();
      renderTree();
      if (state.activeId && state.pages[state.activeId]) openPage(state.activeId);
      else openPage(ROOT_ID);
      // Record sync time from meta
      try {
        const meta = await metaDoc().get();
        const raw = meta.exists ? meta.data().lastSync : null;
        localLastSync = raw?.toMillis ? raw.toMillis() : (raw || Date.now());
      } catch (_) { localLastSync = Date.now(); }
      setSyncStatus('synced');
    } else {
      await batchUploadAll();
    }
  } catch (e) {
    console.warn('syncFromFirestore error', e);
    setSyncStatus('error', e.code || e.message);
  }
}

// ── Upload all local pages (first-run) ───────────────────────
async function batchUploadAll() {
  const pages = Object.values(state.pages);
  if (!pages.length) { setSyncStatus('synced'); return; }
  setSyncStatus('syncing');
  const now = Date.now();
  for (let i = 0; i < pages.length; i += 400) {
    const batch = db.batch();
    pages.slice(i, i + 400).forEach(p => batch.set(pagesCol().doc(p.id), pageToFirestore(p)));
    await batch.commit();
  }
  await metaDoc().set({ lastSync: firebase.firestore.FieldValue.serverTimestamp() });
  const metaSnap = await metaDoc().get();
  localLastSync = metaSnap.exists ? (metaSnap.data().lastSync?.toMillis?.() || Date.now()) : Date.now();
  setSyncStatus('synced');
}

// ── Тягнути зміни з БД якщо вона новіша за localLastSync ────
async function pullChangesFromDB() {
  if (!fbReady || !currentUid) return;
  try {
    const meta = await metaDoc().get();
    const raw = meta.exists ? meta.data().lastSync : null;
    const dbLastSync = raw?.toMillis ? raw.toMillis() : (raw || 0);

    if (dbLastSync <= localLastSync) return; // БД не новіша — нічого робити

    setSyncStatus('syncing');

    // Тягнемо ВСІ сторінки з БД — порівняння по updatedAt ненадійне
    // бо updatedAt = Date.now() клієнта, а localLastSync = серверний час.
    const allSnap = await pagesCol().get();

    let treeChanged  = false;
    let activeChanged = false;

    // ── Застосувати всі сторінки з БД ───────────────────────
    allSnap.forEach(doc => {
      const id     = doc.id;
      const remote = { ...doc.data(), id, children: [] };
      const local  = state.pages[id];
      const isActiveUnsaved = (id === state.activeId && unsaved);

      if (isActiveUnsaved) {
        // Не перезаписуємо незбережений контент активної сторінки
        state.pages[id] = { ...remote, content: local.content, children: local.children || [] };
      } else {
        const changed = !local || local.updatedAt !== remote.updatedAt || local.content !== remote.content || local.title !== remote.title;
        state.pages[id] = { ...remote, children: local ? local.children : [] };
        if (changed && id === state.activeId) activeChanged = true;
        if (changed) treeChanged = true;
      }
    });

    // ── Видалити сторінки яких немає в БД ───────────────────
    const dbIds = new Set(allSnap.docs.map(d => d.id));
    Object.keys(state.pages).forEach(id => {
      if (id === ROOT_ID || id === TRASH_ID) return;
      if (!dbIds.has(id)) {
        const page = state.pages[id];
        if (page?.parentId && state.pages[page.parentId]) {
          state.pages[page.parentId].children = (state.pages[page.parentId].children || []).filter(c => c !== id);
        }
        delete state.pages[id];
        if (state.activeId === id) { state.activeId = ROOT_ID; activeChanged = true; }
        treeChanged = true;
      }
    });

    if (treeChanged) {
      ensureRoot();
      rebuildChildrenFromParentId();
      saveLocalOnly();
      renderTree();
      if (activeChanged) {
        if (state.pages[state.activeId]) reloadEditorContent(state.pages[state.activeId]);
        else openPage(ROOT_ID);
      }
    }

    localLastSync = dbLastSync;
    setSyncStatus('synced');

  } catch (e) {
    console.warn('pullChangesFromDB error', e.code, e.message);
    setSyncStatus(navigator.onLine ? 'error' : 'offline', e.code || e.message);
  }
}

// ── Polling loop — резервна перевірка кожні 30с ──────────────
// onSnapshot може "замовкнути" при нестабільному з'єднанні.
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (fbReady && currentUid && navigator.onLine) checkMetaAndPull();
  }, 30000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Перевірити meta і pull якщо БД новіша
async function checkMetaAndPull() {
  if (!fbReady || !currentUid) return;
  try {
    const meta = await metaDoc().get();
    if (!meta.exists) return;
    const raw = meta.data().lastSync;
    const dbLastSync = raw?.toMillis ? raw.toMillis() : (raw || 0);
    if (dbLastSync > localLastSync) pullChangesFromDB();
  } catch (e) { /* тихо — наступна спроба через 30с */ }
}

// ── Subscribe: watch only meta/sync for changes ───────────────
// meta/sync is a single tiny document {lastSync: timestamp}.
// When another device saves, it updates lastSync → this fires
// instantly → we pull only the changed pages. This gives
// real-time sync without polling and without the echo problem
// of watching the full pages collection.
function subscribeFirestore() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }

  fbUnsub = metaDoc().onSnapshot({ includeMetadataChanges: false }, snap => {
    if (!snap.exists) return;
    const raw = snap.data().lastSync;
    // lastSync може бути Timestamp (serverTimestamp) або число (legacy)
    const dbLastSync = raw?.toMillis ? raw.toMillis() : (raw || 0);

    // Skip if this is our own save (we just set localLastSync = dbLastSync after write)
    if (dbLastSync <= localLastSync) return;

    // DB is newer — pull changed pages
    pullChangesFromDB();

  }, err => {
    console.warn('meta listener error', err.code, err.message);
    setSyncStatus(navigator.onLine ? 'error' : 'offline', err.code || err.message);
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
      if (p) {
        localWrites.set(id, p.updatedAt);
        batch.set(pagesCol().doc(id), pageToFirestore(p));
      }
    });
    await batch.commit();
    // Use serverTimestamp so all devices compare against the same clock
    await metaDoc().set({ lastSync: firebase.firestore.FieldValue.serverTimestamp() });
    // Read back the actual server timestamp so our localLastSync matches exactly
    const metaSnap = await metaDoc().get();
    localLastSync = metaSnap.exists ? (metaSnap.data().lastSync?.toMillis?.() || Date.now()) : Date.now();
    setSyncStatus('synced');
  } catch (e) {
    console.warn('flushWriteQueue error', e);
    ids.forEach(id => { writeQueue.add(id); localWrites.delete(id); });
    setSyncStatus('error', e.code || e.message);
    const permanent = ['invalid-argument', 'permission-denied', 'unauthenticated', 'not-found'];
    if (!permanent.includes(e.code)) {
      setTimeout(flushWriteQueue, 5000);
    }
  }
}

async function fbDeletePage(id) {
  if (!fbReady || !currentUid) return;
  try {
    await pagesCol().doc(id).delete();
    // Update sync timestamp so other devices detect the deletion
    await metaDoc().set({ lastSync: firebase.firestore.FieldValue.serverTimestamp() });
    const metaSnap = await metaDoc().get();
    localLastSync = metaSnap.exists ? (metaSnap.data().lastSync?.toMillis?.() || Date.now()) : Date.now();
  } catch (e) { console.warn(e); }
}

function setSyncStatus(s, detail) {
  const el = document.getElementById('status-sync');
  if (!el) return;
  const map = { syncing: '↻ синхронізація…', synced: '☁ синхронізовано', offline: '○ офлайн', error: '⚠ помилка', pending: '● не збережено' };
  el.textContent = (map[s] || '') + (detail ? ': ' + detail : '');
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
    if (raw) {
      const p = JSON.parse(raw);
      state.pages = p.pages || {};
      state.activeId = p.activeId || null;
      // Migrate old reserved id
      if (state.pages['__root__']) {
        state.pages[ROOT_ID] = { ...state.pages['__root__'], id: ROOT_ID };
        delete state.pages['__root__'];
      }
      if (state.activeId === '__root__') state.activeId = ROOT_ID;
      Object.values(state.pages).forEach(p => {
        if (p.parentId === '__root__') p.parentId = ROOT_ID;
      });
    }
  } catch (e) { console.warn(e); }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function ensureRoot() {
  if (!state.pages[ROOT_ID]) {
    state.pages[ROOT_ID] = { id: ROOT_ID, title: 'Мій архів', content: '', format: 'plain', parentId: null, children: [], createdAt: Date.now(), updatedAt: Date.now() };
    if (fbReady) fbQueueWrite(state.pages[ROOT_ID]);
  }
  if (!state.pages[TRASH_ID]) {
    state.pages[TRASH_ID] = { id: TRASH_ID, title: 'Корзина', content: '', format: 'plain', parentId: null, children: [], createdAt: Date.now(), updatedAt: Date.now() };
    if (fbReady) fbQueueWrite(state.pages[TRASH_ID]);
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
    const kept = (p.children || []).filter(c => expected.has(c));
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

// Move page (and subtree) to Trash instead of hard-deleting
function deletePage(id) {
  if (id === ROOT_ID || id === TRASH_ID) return;
  const page = state.pages[id]; if (!page) return;
  if (page.parentId === TRASH_ID) {
    // Already in trash — hard delete
    hardDeletePage(id);
    return;
  }
  // Move to trash
  const oldParent = state.pages[page.parentId];
  if (oldParent) oldParent.children = oldParent.children.filter(c => c !== id);
  page.parentId = TRASH_ID;
  const trash = state.pages[TRASH_ID];
  if (trash && !trash.children.includes(id)) trash.children.push(id);
  page.updatedAt = Date.now();
  saveState(); fbQueueWrite(page); flushWriteQueue();
}

// Hard-delete a page and all children (used for trash emptying)
function hardDeletePage(id) {
  if (id === ROOT_ID || id === TRASH_ID) return;
  const page = state.pages[id]; if (!page) return;
  [...(page.children || [])].forEach(hardDeletePage);
  const parent = state.pages[page.parentId];
  if (parent) parent.children = parent.children.filter(c => c !== id);
  fbDeletePage(id);
  delete state.pages[id];
  saveState();
}

// Restore a page from Trash back to root
function restorePage(id) {
  const page = state.pages[id]; if (!page) return;
  const trash = state.pages[TRASH_ID];
  if (trash) trash.children = trash.children.filter(c => c !== id);
  page.parentId = ROOT_ID;
  const root = state.pages[ROOT_ID];
  if (root && !root.children.includes(id)) root.children.push(id);
  page.updatedAt = Date.now();
  expandState[ROOT_ID] = true;
  saveState(); fbQueueWrite(page); flushWriteQueue();
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
//  DRAG-AND-DROP state
// ════════════════════════════════════════════════════════════
let dragId = null;
let dragOverId = null;

function movePage(id, newParentId) {
  if (!id || !newParentId) return;
  if (id === ROOT_ID || id === TRASH_ID) return;
  if (id === newParentId) return;
  if (isInSubtree(newParentId, id)) return; // can't move into own child
  const page = state.pages[id]; if (!page) return;
  const oldParent = state.pages[page.parentId];
  if (oldParent) oldParent.children = oldParent.children.filter(c => c !== id);
  page.parentId = newParentId;
  const newParent = state.pages[newParentId];
  if (newParent && !newParent.children.includes(id)) newParent.children.push(id);
  page.updatedAt = Date.now();
  expandState[newParentId] = true;
  saveState(); fbQueueWrite(page); flushWriteQueue();
  renderTree();
}

// ════════════════════════════════════════════════════════════
//  RENDER TREE
// ════════════════════════════════════════════════════════════
function renderTree() {
  const treeEl = document.getElementById('tree-root');
  treeEl.innerHTML = '';
  const q = document.getElementById('search-input').value.trim().toLowerCase();

  function attachDragEvents(row, id) {
    if (id === ROOT_ID || id === TRASH_ID) {
      // roots can be drop targets but not draggable
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault(); row.classList.remove('drag-over');
        if (dragId && dragId !== id) movePage(dragId, id);
        dragId = null;
      });
      return;
    }
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      dragId = id;
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
    row.addEventListener('dragover', e => { e.preventDefault(); if (dragId && dragId !== id) row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      if (dragId && dragId !== id && !isInSubtree(id, dragId)) movePage(dragId, id);
      dragId = null;
    });
  }

  function buildNode(id, depth, inTrash) {
    const page = state.pages[id]; if (!page) return null;
    const children = page.children || [];
    const hasKids = children.length > 0;
    const matchTitle = page.title.toLowerCase().includes(q);
    const childNodes = children.map(c => buildNode(c, depth + 1, inTrash)).filter(Boolean);
    if (q && !matchTitle && !childNodes.length) return null;

    const item = document.createElement('div');
    item.className = 'tree-item';

    const row = document.createElement('div');
    const isTrashRoot = id === TRASH_ID;
    row.className = 'tree-row' + (state.activeId === id ? ' active' : '') + (isTrashRoot ? ' trash-root' : '') + (inTrash && id !== TRASH_ID ? ' in-trash' : '');
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

    // Icon
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    if (isTrashRoot) {
      icon.textContent = '🗑';
      icon.title = 'Корзина';
    } else if (id === ROOT_ID) {
      icon.textContent = '⌂';
      icon.title = 'Зберегти / Експортувати гілку';
      icon.addEventListener('click', e => { e.stopPropagation(); showPageActions(id, icon); });
    } else if (inTrash) {
      icon.textContent = '↩';
      icon.title = 'Відновити';
      icon.addEventListener('click', e => { e.stopPropagation(); restorePage(id); renderTree(); });
    } else {
      icon.textContent = '◻';
      icon.title = 'Зберегти / Експортувати гілку';
      icon.addEventListener('click', e => { e.stopPropagation(); showPageActions(id, icon); });
    }

    // Label
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = page.title;

    row.append(toggle, icon, label);

    // Trash-root actions (empty trash button)
    if (isTrashRoot && children.length > 0) {
      const emptyBtn = document.createElement('span');
      emptyBtn.className = 'trash-empty-btn';
      emptyBtn.title = 'Очистити корзину';
      emptyBtn.textContent = '✕';
      emptyBtn.addEventListener('click', e => {
        e.stopPropagation();
        showModal('Остаточно видалити всі сторінки в корзині?', () => {
          [...(state.pages[TRASH_ID]?.children || [])].forEach(hardDeletePage);
          renderTree();
        });
      });
      row.appendChild(emptyBtn);
    }

    item.appendChild(row);
    attachDragEvents(row, id);

    if (hasKids && (expandState[id] !== false || q)) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-children';
      childNodes.forEach(n => wrap.appendChild(n));
      item.appendChild(wrap);
    }

    if (!isTrashRoot) {
      row.addEventListener('click', e => { if (e.target === toggle || e.target === icon || e.target.classList.contains('trash-empty-btn')) return; openPage(id); });
    }
    row.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, id); });
    return item;
  }

  const root = buildNode(ROOT_ID, 0, false);
  if (root) treeEl.appendChild(root);

  // Separator
  const sep = document.createElement('div');
  sep.className = 'tree-separator';
  treeEl.appendChild(sep);

  const trash = buildNode(TRASH_ID, 0, true);
  if (trash) treeEl.appendChild(trash);
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
  const isRoot = id === ROOT_ID || id === TRASH_ID;
  const inTrash = !isRoot && state.pages[id]?.parentId === TRASH_ID;
  ctxMenu.querySelector('[data-action="delete"]').style.display    = isRoot ? 'none' : '';
  ctxMenu.querySelector('[data-action="duplicate"]').style.display = (isRoot || inTrash) ? 'none' : '';
  ctxMenu.querySelector('[data-action="rename"]').style.display    = isRoot ? 'none' : '';
  ctxMenu.querySelector('[data-action="add-child"]').style.display = inTrash ? 'none' : '';
  ctxMenu.querySelectorAll('hr').forEach(hr => hr.style.display = isRoot ? 'none' : '');
  // trash-specific buttons
  let restoreBtn = ctxMenu.querySelector('[data-action="restore"]');
  if (!restoreBtn) {
    restoreBtn = document.createElement('button');
    restoreBtn.dataset.action = 'restore';
    restoreBtn.textContent = 'Відновити';
    ctxMenu.insertBefore(restoreBtn, ctxMenu.querySelector('[data-action="delete"]'));
  }
  restoreBtn.style.display = inTrash ? '' : 'none';
  const deleteBtn = ctxMenu.querySelector('[data-action="delete"]');
  deleteBtn.textContent = inTrash ? 'Видалити назавжди' : 'Видалити';
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - 180) + 'px';
}
document.addEventListener('click', e => { if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden'); });

ctxMenu.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const action = btn.dataset.action, id = ctxTargetId;
  ctxMenu.classList.add('hidden');
  const inTrash = state.pages[id]?.parentId === TRASH_ID;
  if (action === 'restore') {
    restorePage(id); renderTree();
  } else if (action === 'rename') {
    startInlineRename(id);
  } else if (action === 'add-child') {
    const child = createPage(id);
    expandState[id] = true;
    renderTree();
    openPage(child.id);
    setTimeout(() => startInlineRename(child.id), 120);
  } else if (action === 'duplicate') {
    const np = duplicatePage(id);
    if (np) { expandState[np.parentId] = true; renderTree(); openPage(np.id); }
  } else if (action === 'delete') {
    if (inTrash) {
      showModal(`Остаточно видалити "${state.pages[id]?.title}" та всі підсторінки?`, () => {
        const wasActive = isInSubtree(state.activeId, id);
        hardDeletePage(id);
        if (wasActive) { state.activeId = null; document.getElementById('editor-wrap').classList.add('hidden'); document.getElementById('empty-state').classList.remove('hidden'); }
        renderTree();
      });
    } else {
      showModal(`Перемістити "${state.pages[id]?.title}" до корзини?`, () => {
        const wasActive = isInSubtree(state.activeId, id);
        deletePage(id);
        if (wasActive) { state.activeId = null; document.getElementById('editor-wrap').classList.add('hidden'); document.getElementById('empty-state').classList.remove('hidden'); }
        renderTree();
      });
    }
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
  const id = state.activeId; if (!id || id === ROOT_ID || id === TRASH_ID) return;
  const inTrash = state.pages[id]?.parentId === TRASH_ID;
  if (inTrash) {
    showModal(`Остаточно видалити "${state.pages[id]?.title}"?`, () => {
      hardDeletePage(id); state.activeId = null;
      document.getElementById('editor-wrap').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
      renderTree();
    });
  } else {
    showModal(`Перемістити "${state.pages[id]?.title}" до корзини?`, () => {
      deletePage(id); state.activeId = null;
      document.getElementById('editor-wrap').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
      renderTree();
    });
  }
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
//  EMOJI / ICON PICKER
// ════════════════════════════════════════════════════════════
const EMOJI_CATEGORIES = [
  { label: '😊', name: 'Смайли', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','☺️','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','💫','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { label: '👍', name: 'Жести', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🫀','🫁','🧠','🦷','🦴','👀','👁️','👅','👄','💋','🩸'] },
  { label: '❤️', name: 'Символи', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☯️','🕉️','✡️','🔯','🕎','☪️','🛐','⛎','🔱','⚜️','🔰','♻️','✅','❎','🔅','🔆','🔱','📛','🔰','⭕','✔️','❌','❗','❓','💯','🔞','📵','🚫','⭐','🌟','💫','✨','🌈','☀️','🌙','⚡','🔥','💥','❄️','🌊','🌀'] },
  { label: '📝', name: 'Офіс', emojis: ['📝','📄','📃','📋','📊','📈','📉','📁','📂','🗂️','🗃️','🗄️','🗑️','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🖊️','🖋️','✒️','🖌️','🖍️','📝','💼','📚','📖','📰','🗞️','📑','🔖','🏷️','💰','💴','💵','💶','💷','💸','💳','🧾','💹','📩','📨','📧','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','📟','📠','☎️','📞','📟','📺','📻','🖥️','🖨️','⌨️','🖱️','💾','💿','📀','📷','📸','📹','🎥','🔍','🔎'] },
  { label: '🏠', name: 'Місця', emojis: ['🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏧','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🌌','🌠','🎇','🎆','🗺️','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🛣️','🛤️','🛢️','⛽','🚨','🚥','🚦','🛑'] },
  { label: '🎵', name: 'Мистецтво', emojis: ['🎵','🎶','🎼','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🪗','🎤','🎧','📻','🎨','🖼️','🎭','🎬','🎤','🎪','🎠','🎡','🎢','🎮','🕹️','🎲','♟️','🎯','🎳','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎀','🎁','🎊','🎉','🎋','🎍','🎎','🎏','🎐','🧧','🎑'] },
  { label: '🌿', name: 'Природа', emojis: ['🌿','🌱','🌲','🌳','🌴','🌵','🌾','🍀','🍁','🍂','🍃','🌺','🌸','🌼','🌻','🌹','🥀','🌷','🌱','🍄','🐚','🪨','🪵','🌊','💧','💦','❄️','🌬️','🌀','🌈','⛅','🌤️','🌦️','🌧️','🌩️','🌪️','🌫️','🌊','🔥','🌡️','☀️','🌙','⭐','🌟','🌠','☁️','⛈️','🌂','☂️'] },
  { label: '✍️', name: 'Текст', emojis: ['#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🆎','🅱️','🆑','🆒','🆓','ℹ️','🆔','Ⓜ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','🈷️','🈶','🈯','🉐','🈹','🈚','🈲','🉑','🈸','🈴','🈳','㊗️','㊙️','🈺','🈵','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','🎦','🔅','🔆','📶','📳','📴','📵','📴'] },
];

let emojiPanelOpen = false;
let activeCatIndex = 0;
let emojiSearchVal = '';

// Зберігаємо останній фокус та позицію курсору у редагованих полях.
// ВАЖЛИВО: оновлюємо тільки коли фокус іде НЕ на панель емодзі.
let emojiLastFocus = null;
let emojiLastSel   = null; // { start, end } для textarea / input

function isEmojiPanelEl(el) {
  return el && !!el.closest('#emoji-panel, #btn-emoji');
}

['editor-plain', 'editor-rich', 'page-title'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', () => { emojiLastFocus = el; });
  el.addEventListener('mouseup', () => {
    emojiLastFocus = el;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      emojiLastSel = { start: el.selectionStart, end: el.selectionEnd };
  });
  el.addEventListener('keyup', () => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      emojiLastSel = { start: el.selectionStart, end: el.selectionEnd };
  });
  // Коли фокус іде ГЕТЬ з поля — зберігаємо позицію тільки якщо він іде НЕ в панель
  el.addEventListener('blur', e => {
    if (isEmojiPanelEl(e.relatedTarget)) return; // фокус перейшов у панель — не скидаємо
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      emojiLastSel = { start: el.selectionStart, end: el.selectionEnd };
    // emojiLastFocus залишаємо — щоб вставка все одно йшла в це поле
  });
});

function buildEmojiPanel() {
  const catEl = document.getElementById('emoji-categories');
  catEl.innerHTML = '';
  EMOJI_CATEGORIES.forEach((cat, i) => {
    const btn = document.createElement('button');
    btn.className = 'emoji-cat-btn' + (i === activeCatIndex ? ' active' : '');
    btn.textContent = cat.label;
    btn.title = cat.name;
    // mousedown + preventDefault — НЕ забираємо фокус з редактора при натисканні вкладки
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      activeCatIndex = i;
      emojiSearchVal = '';
      document.getElementById('emoji-search').value = '';
      buildEmojiPanel();
    });
    catEl.appendChild(btn);
  });
  renderEmojiGrid(emojiSearchVal);
}

function renderEmojiGrid(query) {
  const gridEl = document.getElementById('emoji-grid');
  gridEl.innerHTML = '';
  const emojis = query
    ? EMOJI_CATEGORIES.flatMap(c => c.emojis)
    : EMOJI_CATEGORIES[activeCatIndex].emojis;
  emojis.forEach(em => {
    const cell = document.createElement('span');
    cell.className = 'emoji-cell';
    cell.textContent = em;
    cell.title = em;
    // mousedown + preventDefault — НЕ забираємо фокус при кліку на іконку
    cell.addEventListener('mousedown', e => e.preventDefault());
    cell.addEventListener('click', e => { e.stopPropagation(); insertEmoji(em); });
    gridEl.appendChild(cell);
  });
}

function insertEmoji(em) {
  const target = emojiLastFocus;

  // — Назва сторінки або plain textarea —
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    // Відновлюємо збережену позицію курсору і вставляємо
    const val   = target.value;
    const sel   = emojiLastSel || { start: val.length, end: val.length };
    const start = sel.start ?? val.length;
    const end   = sel.end   ?? start;
    target.value = val.slice(0, start) + em + val.slice(end);
    const newPos = start + em.length;
    target.selectionStart = target.selectionEnd = newPos;
    emojiLastSel = { start: newPos, end: newPos };
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    unsaved = true; setSyncStatus('pending');
    return;
  }

  // — Rich editor (contenteditable) —
  if (activeFormat === 'rich') {
    const rich = document.getElementById('editor-rich');
    rich.focus();
    document.execCommand('insertText', false, em);
    unsaved = true; setSyncStatus('pending');
    return;
  }

  // — Fallback: plain editor —
  const plain = document.getElementById('editor-plain');
  const start = plain.selectionStart;
  const end   = plain.selectionEnd;
  plain.value = plain.value.slice(0, start) + em + plain.value.slice(end);
  plain.selectionStart = plain.selectionEnd = start + em.length;
  plain.dispatchEvent(new Event('input', { bubbles: true }));
  plain.focus();
  unsaved = true; setSyncStatus('pending');
}

function toggleEmojiPanel() {
  emojiPanelOpen = !emojiPanelOpen;
  const panel = document.getElementById('emoji-panel');
  panel.classList.toggle('hidden', !emojiPanelOpen);
  document.getElementById('btn-emoji').classList.toggle('active', emojiPanelOpen);
  if (emojiPanelOpen) {
    // Зберігаємо поточний фокус / позицію перед відкриттям
    const ae = document.activeElement;
    if (ae && (ae.id === 'editor-plain' || ae.id === 'editor-rich' || ae.id === 'page-title')) {
      emojiLastFocus = ae;
      if (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
        emojiLastSel = { start: ae.selectionStart, end: ae.selectionEnd };
    }
    buildEmojiPanel();
    // НЕ фокусуємо поле пошуку автоматично — щоб не скидати emojiLastFocus
  }
}

document.getElementById('btn-emoji').addEventListener('mousedown', e => e.preventDefault()); // не забираємо фокус з редактора
document.getElementById('btn-emoji').addEventListener('click', e => {
  e.stopPropagation();
  toggleEmojiPanel();
});

document.getElementById('emoji-search').addEventListener('input', e => {
  e.stopPropagation();
  emojiSearchVal = e.target.value.trim().toLowerCase();
  renderEmojiGrid(emojiSearchVal);
});

// Клік всередині панелі — не спливає до document (не закриває панель)
document.getElementById('emoji-panel').addEventListener('click', e => e.stopPropagation());

// Закрити панель при кліку поза нею
document.addEventListener('click', e => {
  if (!emojiPanelOpen) return;
  if (isEmojiPanelEl(e.target)) return;
  emojiPanelOpen = false;
  document.getElementById('emoji-panel').classList.add('hidden');
  document.getElementById('btn-emoji').classList.remove('active');
});

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
