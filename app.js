// ── CONSTANTS ──────────────────────────────────────────────
const DB_KEY = 'arkhiv_v2';
const ROOT_ID = '__root__';

// ── STATE ──────────────────────────────────────────────────
let state = { pages: {}, activeId: null };
let unsaved = false;
let activeFormat = 'plain';
const expandState = {};

// ── PERSISTENCE ────────────────────────────────────────────
function saveState() {
  localStorage.setItem(DB_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state.pages = p.pages || {};
      state.activeId = p.activeId || null;
    }
  } catch (e) { console.warn('Load error', e); }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── ROOT PAGE ──────────────────────────────────────────────
function ensureRoot() {
  if (!state.pages[ROOT_ID]) {
    state.pages[ROOT_ID] = {
      id: ROOT_ID, title: 'Мій архів', content: '',
      format: 'plain', parentId: null, children: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    saveState();
  }
}

// ── PAGE CRUD ──────────────────────────────────────────────
function createPage(parentId) {
  const id = uid();
  state.pages[id] = {
    id, title: 'Без назви', content: '', format: 'auto',
    parentId, children: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  if (state.pages[parentId]) {
    state.pages[parentId].children.push(id);
  }
  saveState();
  return state.pages[id];
}

function deletePage(id) {
  if (id === ROOT_ID) return;
  const page = state.pages[id];
  if (!page) return;
  [...(page.children || [])].forEach(deletePage);
  const parent = state.pages[page.parentId];
  if (parent) parent.children = parent.children.filter(c => c !== id);
  delete state.pages[id];
  saveState();
}

function duplicatePage(id) {
  if (id === ROOT_ID) return null;
  const src = state.pages[id];
  if (!src) return null;
  const np = createPage(src.parentId);
  np.title = src.title + ' (копія)';
  np.content = src.content;
  np.format = src.format;
  saveState();
  return np;
}

// ── FORMAT ─────────────────────────────────────────────────
function detectFormat(text) {
  if (!text || !text.trim()) return 'plain';
  let md = 0;
  for (const l of text.split('\n')) {
    if (/^#{1,6}\s/.test(l)) md += 3;
    if (/^\s*[-*+]\s/.test(l)) md += 2;
    if (/^\s*\d+\.\s/.test(l)) md += 2;
    if (/\*\*|__/.test(l)) md += 1;
    if (/\[.+\]\(.+\)/.test(l)) md += 2;
    if (/^```|^>/.test(l)) md += 3;
  }
  const htmlN = (text.match(/<[a-z][a-z0-9]*[\s>]/gi) || []).length;
  if (htmlN > 3) return 'rich';
  if (md >= 4) return 'markdown';
  return 'plain';
}

function resolveFormat(page) {
  if (page.format !== 'auto') return page.format;
  return detectFormat(page.content);
}

// ── SUBTREE ────────────────────────────────────────────────
function collectSubtree(id) {
  const page = state.pages[id];
  if (!page) return [];
  return [page, ...(page.children || []).flatMap(c => collectSubtree(c))];
}

function isInSubtree(targetId, rootId) {
  if (targetId === rootId) return true;
  const page = state.pages[rootId];
  if (!page) return false;
  return (page.children || []).some(c => isInSubtree(targetId, c));
}

// ── BREADCRUMB ─────────────────────────────────────────────
function getBreadcrumb(id) {
  const parts = [];
  let cur = state.pages[id];
  while (cur) {
    parts.unshift(cur.title);
    cur = cur.parentId ? state.pages[cur.parentId] : null;
  }
  return parts.join(' › ');
}

// ── RENDER TREE ────────────────────────────────────────────
function renderTree() {
  const treeRoot = document.getElementById('tree-root');
  treeRoot.innerHTML = '';
  const q = document.getElementById('search-input').value.trim().toLowerCase();

  function buildNode(id, depth) {
    const page = state.pages[id];
    if (!page) return null;
    const hasKids = page.children && page.children.length > 0;
    const matchTitle = page.title.toLowerCase().includes(q);
    const childNodes = hasKids ? page.children.map(c => buildNode(c, depth + 1)).filter(Boolean) : [];
    if (q && !matchTitle && childNodes.length === 0) return null;

    const item = document.createElement('div');
    item.className = 'tree-item';

    const row = document.createElement('div');
    row.className = 'tree-row' + (state.activeId === id ? ' active' : '');
    row.dataset.id = id;
    row.style.paddingLeft = (6 + depth * 14) + 'px';

    // toggle
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (hasKids) {
      const isOpen = expandState[id] !== false;
      toggle.innerHTML = isOpen ? '&#9660;' : '&#9654;';
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        expandState[id] = expandState[id] === false ? true : false;
        renderTree();
      });
    } else {
      toggle.innerHTML = '<i class="tree-dot"></i>';
    }

    // icon — clicking shows save/export popup
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.title = 'Зберегти / Експортувати гілку';
    icon.textContent = id === ROOT_ID ? '⌂' : '◻';
    icon.addEventListener('click', e => {
      e.stopPropagation();
      showPageActions(id, icon);
    });

    // label
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

    row.addEventListener('click', e => {
      if (e.target === toggle || e.target === icon) return;
      openPage(id);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, id);
    });

    return item;
  }

  const rootNode = buildNode(ROOT_ID, 0);
  if (rootNode) treeRoot.appendChild(rootNode);
}

// ── PAGE ACTIONS POPUP ─────────────────────────────────────
function showPageActions(id, anchor) {
  document.querySelectorAll('.page-action-popup').forEach(el => el.remove());
  const popup = document.createElement('div');
  popup.className = 'page-action-popup';
  const pages = collectSubtree(id);
  const sub = pages.length === 1 ? 'лише ця сторінка' : `${pages.length} сторінок у гілці`;
  popup.innerHTML = `
    <div class="popup-title">${state.pages[id]?.title || ''}</div>
    <div class="popup-sub">${sub}</div>
    <button data-act="save">💾 Зберегти гілку</button>
    <button data-act="pdf">📑 Експорт у PDF</button>
    <button data-act="txt">📃 Експорт у TXT</button>
  `;
  document.body.appendChild(popup);

  const rect = anchor.getBoundingClientRect();
  const pw = 190;
  const left = Math.min(rect.left, window.innerWidth - pw - 8);
  popup.style.cssText = `top:${rect.bottom + 4}px;left:${Math.max(4, left)}px`;

  popup.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    popup.remove();
    const act = btn.dataset.act;
    if (act === 'save') { saveBranch(id); }
    else if (act === 'pdf') { exportBranchPDF(id); }
    else if (act === 'txt') { exportBranchTXT(id); }
  });

  setTimeout(() => {
    document.addEventListener('click', function h() { popup.remove(); document.removeEventListener('click', h); });
  }, 0);
}

function saveBranch(id) {
  if (state.activeId && isInSubtree(state.activeId, id)) saveCurrentEditorToPage();
  saveState();
  flashStatus('Гілку збережено ✓');
}

// ── EXPORT PDF ─────────────────────────────────────────────
function pageContentToHtml(page) {
  const fmt = resolveFormat(page);
  if (fmt === 'markdown') {
    return typeof marked !== 'undefined'
      ? marked.parse(page.content || '')
      : (page.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
  } else if (fmt === 'rich') {
    return page.content || '';
  } else {
    // plain text — wrap in pre, escape html
    return '<pre>' + (page.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>';
  }
}

function exportBranchPDF(id) {
  const pages = collectSubtree(id);
  const styles = `<style>
    @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;1,400&family=Playfair+Display:wght@400;500&display=swap');
    body{font-family:'Lora',Georgia,serif;color:#111;font-size:11pt;line-height:1.75;margin:0;padding:0;background:#fff}
    h1{font-family:'Playfair Display',serif;font-size:16pt;font-weight:500;color:#1a1a1a;margin:18pt 0 4pt;border-bottom:1.5pt solid #c9a84c;padding-bottom:4pt}
    h2{font-family:'Playfair Display',serif;font-size:13pt;font-weight:500;color:#333;margin:14pt 0 4pt}
    h3{font-family:'Playfair Display',serif;font-size:11pt;font-weight:500;color:#555;margin:10pt 0 3pt}
    p{margin:5pt 0}
    ul,ol{padding-left:18pt;margin:5pt 0}
    li{margin:2pt 0}
    pre{background:#f6f6f6;border:0.5pt solid #ddd;border-radius:3pt;padding:7pt 10pt;white-space:pre-wrap;font-size:9pt;font-family:monospace;line-height:1.5;margin:6pt 0}
    code{background:#f0f0f0;padding:1pt 3pt;border-radius:2pt;font-family:monospace;font-size:9pt}
    blockquote{border-left:2.5pt solid #c9a84c;margin:8pt 0 8pt 0;padding:2pt 0 2pt 10pt;color:#555;font-style:italic}
    a{color:#7a5c1e;text-decoration:underline}
    table{width:100%;border-collapse:collapse;margin:8pt 0;font-size:10pt}
    th{background:#f5f0e8;border:0.5pt solid #ccc;padding:4pt 7pt;text-align:left;font-weight:500}
    td{border:0.5pt solid #ddd;padding:4pt 7pt}
    hr{border:none;border-top:0.5pt solid #ddd;margin:10pt 0}
    img{max-width:100%}
    .page-crumb{font-size:8pt;color:#aaa;letter-spacing:0.3pt;margin-bottom:2pt;font-family:monospace}
    .page-sep{border:none;border-top:1pt solid #e0d8cc;margin:16pt 0 10pt}
  </style>`;

  let body = '';
  pages.forEach((page, i) => {
    const html = pageContentToHtml(page);
    const crumb = getBreadcrumb(page.id);
    // separator between pages (no hard page-break — continuous flow)
    const sep = i > 0 ? '<hr class="page-sep">' : '';
    body += sep +
      `<div class="page-crumb">${crumb}</div>` +
      `<h1>${page.title}</h1>` +
      html;
  });

  const el = document.createElement('div');
  el.style.cssText = 'padding:12mm 14mm;background:#fff;';
  el.innerHTML = styles + body;

  if (typeof html2pdf !== 'undefined') {
    html2pdf().set({
      margin: [10, 12, 10, 12],
      filename: (state.pages[id]?.title || 'export') + '.pdf',
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['avoid-all', 'css'] }
    }).from(el).save();
  } else {
    const w = window.open('', '_blank');
    w.document.write('<!DOCTYPE html><html><head><title>' + (state.pages[id]?.title || 'Export') + '</title></head><body>' + el.innerHTML + '</body></html>');
    w.document.close();
    setTimeout(() => w.print(), 700);
  }
}

function exportBranchTXT(id) {
  const pages = collectSubtree(id);
  const txt = pages.map((p, i) =>
    (i > 0 ? '\n\n' + '─'.repeat(60) + '\n\n' : '') +
    `# ${p.title}\n${getBreadcrumb(p.id)}\n\n` +
    (p.content || '').replace(/<[^>]+>/g, '')
  ).join('');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = (state.pages[id]?.title || 'export') + '.txt';
  a.click();
}

// ── OPEN PAGE ──────────────────────────────────────────────
function openPage(id) {
  if (unsaved && state.activeId) saveCurrentEditorToPage();
  state.activeId = id;
  saveState();
  const page = state.pages[id];
  if (!page) return;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('editor-wrap').classList.remove('hidden');
  document.getElementById('page-title').value = page.title;
  document.getElementById('format-select').value = page.format || 'auto';
  const bc = getBreadcrumb(id);
  const el1 = document.getElementById('breadcrumb-bar');
  const el2 = document.getElementById('global-breadcrumb');
  if (el1) el1.textContent = bc;
  if (el2) el2.textContent = bc;

  previewActive = false;
  document.getElementById('btn-preview').textContent = '▶ Перегляд';

  activeFormat = resolveFormat(page);
  applyEditorFormat(activeFormat, page.content || '');
  updateStatusFormat(activeFormat);
  updateWordCount();
  setUnsaved(false);
  renderTree();
}

// ── APPLY EDITOR FORMAT ────────────────────────────────────
function applyEditorFormat(fmt, content) {
  const plain = document.getElementById('editor-plain');
  const rich = document.getElementById('editor-rich');
  const preview = document.getElementById('editor-preview');
  const fmtBar = document.getElementById('format-bar');
  plain.classList.add('hidden');
  rich.classList.add('hidden');
  preview.classList.add('hidden');
  fmtBar.classList.add('hidden');

  if (fmt === 'rich') {
    rich.classList.remove('hidden');
    fmtBar.classList.remove('hidden');
    rich.innerHTML = content;
  } else {
    plain.classList.remove('hidden');
    plain.value = content;
  }
}

function getEditorContent() {
  if (activeFormat === 'rich') return document.getElementById('editor-rich').innerHTML;
  return document.getElementById('editor-plain').value;
}

function saveCurrentEditorToPage() {
  const id = state.activeId;
  if (!id || !state.pages[id]) return;
  const page = state.pages[id];
  page.title = document.getElementById('page-title').value.trim() || 'Без назви';
  page.format = document.getElementById('format-select').value;
  page.content = getEditorContent();
  page.updatedAt = Date.now();
  saveState();
  setUnsaved(false);
  renderTree();
}

// ── STATUS ─────────────────────────────────────────────────
function setUnsaved(val) {
  unsaved = val;
  const s = document.getElementById('status-saved');
  s.textContent = val ? '● не збережено' : '● збережено';
  s.className = val ? 'dirty' : 'saved';
}

function flashStatus(msg) {
  const s = document.getElementById('status-saved');
  s.textContent = msg;
  s.className = 'saved';
  setTimeout(() => setUnsaved(false), 2500);
}

function updateStatusFormat(fmt) {
  const L = { plain: 'Текст', markdown: 'Markdown', rich: 'Форматований', auto: 'Авто' };
  document.getElementById('status-format').textContent = 'Формат: ' + (L[fmt] || fmt);
}

function updateWordCount() {
  const text = getEditorContent().replace(/<[^>]+>/g, ' ');
  const w = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById('status-words').textContent = w + ' слів';
}

// ── PREVIEW ────────────────────────────────────────────────
let previewActive = false;

function togglePreview() {
  const btn = document.getElementById('btn-preview');
  const plain = document.getElementById('editor-plain');
  const rich = document.getElementById('editor-rich');
  const preview = document.getElementById('editor-preview');

  if (!previewActive) {
    const content = getEditorContent();
    let html = '';
    if (activeFormat === 'markdown') {
      html = typeof marked !== 'undefined' ? marked.parse(content) : content.replace(/\n/g,'<br>');
    } else if (activeFormat === 'rich') {
      html = content;
    } else {
      html = '<pre style="white-space:pre-wrap">' + content.replace(/</g,'&lt;') + '</pre>';
    }
    preview.innerHTML = html;
    plain.classList.add('hidden');
    rich.classList.add('hidden');
    preview.classList.remove('hidden');
    btn.textContent = '✕ Редагувати';
    previewActive = true;
  } else {
    preview.classList.add('hidden');
    applyEditorFormat(activeFormat, getEditorContent());
    btn.textContent = '▶ Перегляд';
    previewActive = false;
  }
}

// ── CONTEXT MENU ───────────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');
let ctxTargetId = null;

function showCtxMenu(x, y, id) {
  ctxTargetId = id;
  const isRoot = id === ROOT_ID;
  ctxMenu.querySelector('[data-action="delete"]').style.display = isRoot ? 'none' : '';
  ctxMenu.querySelector('[data-action="duplicate"]').style.display = isRoot ? 'none' : '';
  ctxMenu.querySelectorAll('hr').forEach(hr => hr.style.display = isRoot ? 'none' : '');
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
}

document.addEventListener('click', e => {
  if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
});

ctxMenu.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = ctxTargetId;
  ctxMenu.classList.add('hidden');

  if (action === 'rename') {
    startInlineRename(id);
  } else if (action === 'add-child') {
    const child = createPage(id);
    expandState[id] = true;
    renderTree();
    openPage(child.id);
    setTimeout(() => startInlineRename(child.id), 100);
  } else if (action === 'duplicate') {
    const np = duplicatePage(id);
    if (np) { expandState[np.parentId] = true; renderTree(); openPage(np.id); }
  } else if (action === 'delete') {
    showModal(`Видалити "${state.pages[id]?.title}" та всі підсторінки?`, () => {
      const wasActive = isInSubtree(state.activeId, id);
      deletePage(id);
      if (wasActive) {
        state.activeId = null;
        document.getElementById('editor-wrap').classList.add('hidden');
        document.getElementById('empty-state').classList.remove('hidden');
      }
      renderTree();
    });
  }
});

// ── INLINE RENAME ──────────────────────────────────────────
function startInlineRename(id) {
  renderTree();
  requestAnimationFrame(() => {
    const row = document.querySelector(`.tree-row[data-id="${id}"]`);
    if (!row) return;
    const label = row.querySelector('.tree-label');
    const inp = document.createElement('input');
    inp.className = 'rename-input';
    inp.value = label.textContent;
    label.textContent = '';
    label.appendChild(inp);
    inp.focus(); inp.select();

    const commit = () => {
      const val = inp.value.trim() || 'Без назви';
      if (state.pages[id]) {
        state.pages[id].title = val;
        if (state.activeId === id) {
          document.getElementById('page-title').value = val;
          const bc = getBreadcrumb(id);
  const el1 = document.getElementById('breadcrumb-bar');
  const el2 = document.getElementById('global-breadcrumb');
  if (el1) el1.textContent = bc;
  if (el2) el2.textContent = bc;
        }
        saveState();
      }
      renderTree();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') renderTree();
    });
    inp.addEventListener('blur', commit);
  });
}

// ── MODAL ──────────────────────────────────────────────────
function showModal(text, onConfirm) {
  document.getElementById('modal-text').textContent = text;
  document.getElementById('modal-overlay').classList.remove('hidden');
  const close = () => document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-confirm').onclick = () => { close(); onConfirm(); };
  document.getElementById('modal-cancel').onclick = close;
}

// ── SIDEBAR ────────────────────────────────────────────────
function setSidebarOpen(open) {
  const sb = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 640;
  if (isMobile) {
    sb.classList.toggle('mobile-open', open);
    sb.classList.remove('collapsed');
  } else {
    sb.classList.toggle('collapsed', !open);
  }
  localStorage.setItem('arkhiv-sidebar', open ? '1' : '0');
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 640;
  const isOpen = isMobile ? sb.classList.contains('mobile-open') : !sb.classList.contains('collapsed');
  setSidebarOpen(!isOpen);
}

document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
document.getElementById('editor-area').addEventListener('click', () => {
  if (window.innerWidth <= 640) setSidebarOpen(false);
});

// ── IMPORT ─────────────────────────────────────────────────
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click());

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const parentId = state.activeId || ROOT_ID;
    const p = createPage(parentId);
    p.content = ev.target.result;
    p.title = file.name.replace(/\.[^.]+$/, '');
    const ext = file.name.split('.').pop().toLowerCase();
    p.format = ext === 'md' ? 'markdown' : ext === 'html' ? 'rich' : 'auto';
    expandState[parentId] = true;
    saveState();
    renderTree();
    openPage(p.id);
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ── EXPORT CURRENT PAGE ────────────────────────────────────
document.getElementById('btn-export-pdf').addEventListener('click', () => {
  if (!state.activeId) return;
  saveCurrentEditorToPage();
  exportBranchPDF(state.activeId);
});

// ── FORMAT BAR ─────────────────────────────────────────────
document.getElementById('format-bar').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  const heading = btn.dataset.heading;
  if (cmd) {
    if (cmd === 'createLink') {
      const url = prompt('URL посилання:');
      if (url) document.execCommand('createLink', false, url);
    } else {
      document.execCommand(cmd, false, null);
    }
  } else if (heading) {
    document.execCommand('formatBlock', false, heading);
  }
  document.getElementById('editor-rich').focus();
  setUnsaved(true);
});

// ── FORMAT SELECT ──────────────────────────────────────────
document.getElementById('format-select').addEventListener('change', e => {
  if (!state.activeId) return;
  const fmt = e.target.value;
  const content = getEditorContent();
  state.pages[state.activeId].format = fmt;
  activeFormat = fmt === 'auto' ? detectFormat(content) : fmt;
  previewActive = false;
  document.getElementById('btn-preview').textContent = '▶ Перегляд';
  applyEditorFormat(activeFormat, content);
  updateStatusFormat(activeFormat);
  setUnsaved(true);
});

// ── CONTROLS ───────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  saveCurrentEditorToPage();
  flashStatus('Збережено ✓');
});

document.getElementById('btn-delete-page').addEventListener('click', () => {
  const id = state.activeId;
  if (!id || id === ROOT_ID) return;
  showModal(`Видалити "${state.pages[id]?.title}"?`, () => {
    deletePage(id);
    state.activeId = null;
    document.getElementById('editor-wrap').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    renderTree();
  });
});

document.getElementById('btn-preview').addEventListener('click', togglePreview);

document.getElementById('btn-new-page').addEventListener('click', () => {
  if (unsaved && state.activeId) saveCurrentEditorToPage();
  const parentId = state.activeId || ROOT_ID;
  const p = createPage(parentId);
  expandState[parentId] = true;
  renderTree();
  openPage(p.id);
  setTimeout(() => document.getElementById('page-title').select(), 60);
});

document.getElementById('page-title').addEventListener('input', e => {
  if (state.activeId && state.pages[state.activeId]) {
    state.pages[state.activeId].title = e.target.value || 'Без назви';
    const bcv = getBreadcrumb(state.activeId);
    const bce1 = document.getElementById('breadcrumb-bar');
    const bce2 = document.getElementById('global-breadcrumb');
    if (bce1) bce1.textContent = bcv;
    if (bce2) bce2.textContent = bcv;
    renderTree();
  }
  setUnsaved(true);
});

document.getElementById('editor-plain').addEventListener('input', () => {
  setUnsaved(true); updateWordCount();
  if (state.pages[state.activeId]?.format === 'auto')
    updateStatusFormat(detectFormat(document.getElementById('editor-plain').value));
});

document.getElementById('editor-rich').addEventListener('input', () => { setUnsaved(true); updateWordCount(); });

document.getElementById('search-input').addEventListener('input', renderTree);

// ── KEYBOARD ───────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') { e.preventDefault(); saveCurrentEditorToPage(); flashStatus('Збережено ✓'); }
  if (mod && e.key === 'n') { e.preventDefault(); document.getElementById('btn-new-page').click(); }
  if (mod && e.shiftKey && e.key === 'P') { e.preventDefault(); togglePreview(); }
});

// ── AUTOSAVE ───────────────────────────────────────────────
setInterval(() => { if (unsaved && state.activeId) saveCurrentEditorToPage(); }, 30000);

// ── INIT ───────────────────────────────────────────────────
loadState();
ensureRoot();

// restore sidebar
const sidebarPref = localStorage.getItem('arkhiv-sidebar');
setSidebarOpen(sidebarPref !== '0');

// root always expanded by default
if (expandState[ROOT_ID] === undefined) expandState[ROOT_ID] = true;

renderTree();

if (state.activeId && state.pages[state.activeId]) openPage(state.activeId);
else openPage(ROOT_ID);
