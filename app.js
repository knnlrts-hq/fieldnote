const SUPABASE_URL = 'https://dbxmizntfrggqivkoibz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_DfPIwut2VO6vfTEvHJc9Ew_WRlyTSXZ';
const BUCKET = 'private-blobs';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;
const PBKDF2_SALT = new Uint8Array([
  0x73, 0x68, 0x65, 0x6c, 0x66, 0x2d, 0x73, 0x61,
  0x6c, 0x74, 0x2d, 0x76, 0x31, 0x2d, 0x30, 0x30,
]);

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/plain']);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const state = {
  encryptionKey: null,
  currentUser: null,
  editor: null,
  notes: [],
  revisions: [],
  currentNote: null,
  lastSavedContent: '',
  lastSavedFilename: '',
  dirty: false,
  searchTerm: '',
  saveBusy: false,
  previewTimer: null,
  statusTimer: null,
};

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const signOutBtn = document.getElementById('sign-out-btn');
const accountChip = document.getElementById('account-chip');

const saveBtn = document.getElementById('save-btn');
const downloadBtn = document.getElementById('download-btn');
const deleteBtn = document.getElementById('delete-btn');
const revertBtn = document.getElementById('revert-btn');
const newNoteBtn = document.getElementById('new-note-btn');
const uploadNoteBtn = document.getElementById('upload-note-btn');
const uploadInput = document.getElementById('upload-input');
const filenameInput = document.getElementById('filename-input');
const noteSearch = document.getElementById('note-search');
const noteList = document.getElementById('note-list');
const notesEmpty = document.getElementById('notes-empty');
const notesHiddenInfo = document.getElementById('notes-hidden-info');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const preview = document.getElementById('preview');
const saveState = document.getElementById('save-state');
const docStats = document.getElementById('doc-stats');
const editorMeta = document.getElementById('editor-meta');
const editorTextarea = document.getElementById('editor-textarea');

const modalBackdrop = document.getElementById('modal-backdrop');
const newNoteForm = document.getElementById('new-note-form');
const newNoteFilename = document.getElementById('new-note-filename');
const newNoteError = document.getElementById('new-note-error');
const modalCancelBtn = document.getElementById('modal-cancel-btn');

function initMarkdownEngine() {
  const md = window.markdownit({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  if (window.markdownitFootnote) {
    md.use(window.markdownitFootnote);
  }
  if (window.markdownitMark) {
    md.use(window.markdownitMark);
  }
  return md;
}

const markdownEngine = initMarkdownEngine();

function initEditor() {
  state.editor = window.CodeMirror.fromTextArea(editorTextarea, {
    mode: 'gfm',
    lineNumbers: true,
    lineWrapping: true,
    autofocus: false,
    viewportMargin: Infinity,
    styleActiveLine: true,
    autoCloseBrackets: true,
    extraKeys: {
      Tab(cm) {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
        } else {
          cm.replaceSelection('  ', 'end');
        }
      },
      'Shift-Tab': 'indentLess',
      'Cmd-S': () => saveCurrentNote(),
      'Ctrl-S': () => saveCurrentNote(),
    },
  });

  state.editor.on('change', () => {
    syncDirtyState();
    updateDocStats();
    renderPreviewDebounced();
  });

  state.editor.setValue('');
  state.editor.refresh();
}

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
}

function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
}

function setLoginError(message) {
  loginError.hidden = !message;
  loginError.textContent = message || '';
}

function setSaveState(message, kind = 'info', sticky = false) {
  saveState.textContent = message;
  saveState.className = kind === 'error' ? 'message error' : 'subtle';

  if (!sticky && kind !== 'error') {
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      saveState.textContent = state.dirty ? 'Unsaved changes.' : 'Ready.';
      saveState.className = 'subtle';
    }, 2500);
  }
}

function setEditorEnabled(enabled) {
  state.editor.setOption('readOnly', enabled ? false : 'nocursor');
  filenameInput.disabled = !enabled;
  saveBtn.disabled = !enabled || state.saveBusy;
  downloadBtn.disabled = !enabled;
  deleteBtn.disabled = !enabled;
  revertBtn.disabled = !enabled;
}

function validateMarkdownFilename(value) {
  const name = value.trim();
  if (!name) {
    return { error: 'Filename is required.' };
  }

  let normalized = name;
  if (!/\.[A-Za-z0-9_-]+$/.test(normalized)) {
    normalized += '.md';
  }

  const extension = getExtension(normalized);
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    return { error: 'Use a markdown-friendly filename ending in .md, .markdown, or .txt.' };
  }

  return { value: normalized };
}

function sanitizeFilename(name) {
  return name.replace(/[^\w.\- ]+/g, '_');
}

function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) {
    return '';
  }
  return filename.slice(idx + 1).toLowerCase();
}

function inferContentType(filename) {
  const ext = getExtension(filename);
  return ext === 'txt' ? 'text/plain' : 'text/markdown';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeNoteKey(name) {
  return name.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function isMarkdownRow(row) {
  if (MARKDOWN_MIME_TYPES.has((row.content_type || '').toLowerCase())) return true;
  return MARKDOWN_EXTENSIONS.has(getExtension(row.filename || ''));
}

function setCurrentNote(note) {
  state.currentNote = note;
  filenameInput.value = note ? note.filename : '';
  state.lastSavedFilename = note ? note.filename : '';
  renderNotesList();
  updateHeaderMeta();
  updateActionState();
}

function updateHeaderMeta() {
  if (!state.currentNote) {
    editorMeta.textContent = 'No note open';
    return;
  }

  const revisionText = state.revisions.length
    ? `Revision ${state.revisions[0].revision_number}`
    : state.currentNote.isNew
      ? 'Unsaved note'
      : 'No revisions yet';

  editorMeta.textContent = `${revisionText} · ${formatBytes(state.currentNote.size_bytes || 0)} · Updated ${state.currentNote.updated_at ? formatDateTime(state.currentNote.updated_at) : 'not yet saved'}`;
}

function updateActionState() {
  const hasNote = Boolean(state.currentNote);
  const enabled = hasNote;
  setEditorEnabled(enabled);
  saveBtn.disabled = !hasNote || state.saveBusy;
  downloadBtn.disabled = !hasNote;
  deleteBtn.disabled = !hasNote;
  revertBtn.disabled = !hasNote || state.currentNote.isNew;
}

function updateDocStats() {
  const text = state.editor.getValue();
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = text.length;
  const lines = text ? text.split('\n').length : 1;
  docStats.textContent = `${words} words · ${lines} lines · ${chars} chars`;
}

function syncDirtyState() {
  if (!state.currentNote) {
    state.dirty = false;
    return;
  }
  const contentChanged = state.editor.getValue() !== state.lastSavedContent;
  const filenameChanged = filenameInput.value.trim() !== state.lastSavedFilename;
  state.dirty = contentChanged || filenameChanged;
  setSaveState(state.dirty ? 'Unsaved changes.' : 'Ready.', 'info', true);
  saveBtn.disabled = !state.currentNote || state.saveBusy;
}

async function deriveKey(passphrase) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBytes(key, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  const result = new Uint8Array(IV_LENGTH + cipherBuffer.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(cipherBuffer), IV_LENGTH);
  return result;
}

async function decryptBytes(key, encryptedBuffer) {
  const bytes = new Uint8Array(encryptedBuffer);
  const iv = bytes.slice(0, IV_LENGTH);
  const payload = bytes.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
}

async function downloadEncryptedObject(objectPath) {
  const { data, error } = await sb.storage.from(BUCKET).download(objectPath);
  if (error) throw error;
  const encrypted = await data.arrayBuffer();
  return decryptBytes(state.encryptionKey, encrypted);
}

function protectCodeBlocks(input) {
  const blocks = [];
  const replaced = input.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) => {
    const token = `@@CODE_BLOCK_${blocks.length}@@`;
    blocks.push(match);
    return token;
  });
  return { text: replaced, blocks };
}

function restoreCodeBlocks(input, blocks) {
  return input.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => blocks[Number(idx)] || '');
}

function preprocessMarkdown(source) {
  const { text, blocks } = protectCodeBlocks(source);
  let output = text.replace(/%%[\s\S]*?%%/g, '');

  output = output.replace(/!\[\[([^\]]+)\]\]/g, (_, rawTarget) => {
    const target = rawTarget.trim();
    return `<span class="embed-chip" data-embed-target="${escapeHtml(target)}">Embedded file: ${escapeHtml(target)}</span>`;
  });

  output = output.replace(/\[\[([^\]]+)\]\]/g, (_, rawTarget) => {
    const [targetPart, aliasPart] = rawTarget.split('|');
    const fullTarget = (targetPart || '').trim();
    const alias = (aliasPart || fullTarget).trim();
    const [noteTarget, headingTarget = ''] = fullTarget.split('#');
    return `<a href="#" class="wiki-link" data-note-target="${escapeHtml(noteTarget.trim())}" data-heading-target="${escapeHtml(headingTarget.trim())}">${escapeHtml(alias)}</a>`;
  });

  return restoreCodeBlocks(output, blocks);
}

function slugifyHeading(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function addHeadingIds(root) {
  const seen = new Map();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = slugifyHeading(heading.textContent || 'section') || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    heading.id = count ? `${base}-${count + 1}` : base;
  }
}

function enhanceCallouts(root) {
  for (const blockquote of root.querySelectorAll('blockquote')) {
    const firstParagraph = blockquote.querySelector(':scope > p');
    if (!firstParagraph) continue;
    const match = firstParagraph.textContent.trim().match(/^\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)$/);
    if (!match) continue;

    const [, typeRaw, foldState, titleRaw] = match;
    const type = typeRaw.toLowerCase();
    const titleText = titleRaw || titleCase(type);

    blockquote.classList.add('callout', `callout-${type}`);

    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'callout-title';
    titleButton.innerHTML = `
      <span class="callout-badge">${escapeHtml(type)}</span>
      <span class="callout-title-text">${escapeHtml(titleText)}</span>
      ${foldState ? `<span class="callout-toggle">${foldState === '-' ? '▸' : '▾'}</span>` : ''}
    `;

    const content = document.createElement('div');
    content.className = 'callout-content';

    const children = Array.from(blockquote.childNodes);
    for (const child of children) {
      if (child === firstParagraph) continue;
      content.appendChild(child);
    }

    blockquote.textContent = '';
    blockquote.appendChild(titleButton);
    blockquote.appendChild(content);

    if (foldState) {
      const expanded = foldState !== '-';
      content.hidden = !expanded;
      titleButton.setAttribute('aria-expanded', String(expanded));
      titleButton.addEventListener('click', () => {
        const next = titleButton.getAttribute('aria-expanded') !== 'true';
        titleButton.setAttribute('aria-expanded', String(next));
        const toggle = titleButton.querySelector('.callout-toggle');
        if (toggle) toggle.textContent = next ? '▾' : '▸';
        content.hidden = !next;
      });
    } else {
      titleButton.disabled = true;
      titleButton.style.cursor = 'default';
    }
  }
}

function findNoteByWikiTarget(target) {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const normalized = normalizeNoteKey(trimmed);

  return state.notes.find((note) => {
    const filenameLower = note.filename.toLowerCase();
    return filenameLower === lower || normalizeNoteKey(note.filename) === normalized;
  }) || null;
}

function enhanceTaskLists(root) {
  for (const item of root.querySelectorAll('li')) {
    const directText = item.firstChild && item.firstChild.nodeType === Node.TEXT_NODE ? item.firstChild : null;
    const paragraph = item.firstElementChild && item.firstElementChild.tagName === 'P' ? item.firstElementChild : null;
    const targetNode = directText || (paragraph && paragraph.firstChild && paragraph.firstChild.nodeType === Node.TEXT_NODE ? paragraph.firstChild : null);
    if (!targetNode) continue;

    const match = targetNode.textContent.match(/^\[([ xX])\]\s+/);
    if (!match) continue;

    const checked = match[1].toLowerCase() === 'x';
    targetNode.textContent = targetNode.textContent.replace(/^\[[ xX]\]\s+/, '');
    item.classList.add('task-list-item');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = true;
    checkbox.checked = checked;
    checkbox.className = 'task-list-checkbox';

    if (paragraph) {
      paragraph.insertBefore(checkbox, paragraph.firstChild);
    } else {
      item.insertBefore(checkbox, item.firstChild);
    }
  }
}

function wireWikiLinks(root) {
  for (const link of root.querySelectorAll('.wiki-link')) {
    const noteTarget = link.dataset.noteTarget || '';
    const headingTarget = link.dataset.headingTarget || '';
    const match = findNoteByWikiTarget(noteTarget);

    if (!match) {
      link.classList.add('missing');
      link.title = `Missing note: ${noteTarget}`;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        alert(`No uploaded note matches "${noteTarget}".`);
      });
      continue;
    }

    link.title = `Open ${match.filename}`;
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      await openNote(match.id, { heading: headingTarget });
    });
  }
}

function renderPreview() {
  const content = state.editor.getValue();
  if (!state.currentNote && !content.trim()) {
    preview.innerHTML = `
      <div class="preview-placeholder">
        <h3>No note selected</h3>
        <p>Create a note, upload a markdown file, or choose one from the sidebar.</p>
      </div>
    `;
    return;
  }

  const rawHtml = markdownEngine.render(preprocessMarkdown(content));
  const safeHtml = window.DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['class', 'data-note-target', 'data-heading-target', 'data-embed-target', 'aria-expanded'],
  });

  preview.innerHTML = safeHtml;
  addHeadingIds(preview);
  enhanceCallouts(preview);
  enhanceTaskLists(preview);
  wireWikiLinks(preview);

  if (window.renderMathInElement) {
    window.renderMathInElement(preview, {
      throwOnError: false,
      strict: 'ignore',
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
    });
  }
}

function renderPreviewDebounced() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(renderPreview, 120);
}

function renderNotesList() {
  const visibleNotes = state.notes.filter((note) =>
    note.filename.toLowerCase().includes(state.searchTerm.toLowerCase())
  );

  noteList.textContent = '';
  notesEmpty.hidden = visibleNotes.length > 0;

  for (const note of visibleNotes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `note-item${state.currentNote && state.currentNote.id === note.id ? ' active' : ''}`;
    button.innerHTML = `
      <div class="note-item-title">${escapeHtml(note.filename)}</div>
      <div class="note-item-meta">Updated ${escapeHtml(formatDateTime(note.updated_at || note.created_at))}</div>
      <div class="note-item-meta">${escapeHtml(formatBytes(note.size_bytes || 0))}</div>
    `;
    button.addEventListener('click', () => openNote(note.id));
    noteList.appendChild(button);
  }
}

function renderHistory() {
  historyList.textContent = '';

  if (!state.currentNote || state.revisions.length === 0) {
    historyEmpty.hidden = false;
    historyEmpty.textContent = state.currentNote ? 'No saved revisions yet.' : 'Select a note to view revisions.';
    return;
  }

  historyEmpty.hidden = true;

  for (const revision of state.revisions) {
    const card = document.createElement('article');
    card.className = 'history-item';

    const isLatest = state.revisions[0] && revision.revision_number === state.revisions[0].revision_number;
    card.innerHTML = `
      <div>
        <div class="history-title">Revision ${revision.revision_number}</div>
        <div class="history-meta">${escapeHtml(formatDateTime(revision.created_at))}</div>
      </div>
      <div class="history-meta">${escapeHtml(formatBytes(revision.size_bytes || 0))}</div>
      <div class="history-actions">
        ${isLatest ? '<span class="history-tag">Current</span>' : ''}
        ${!isLatest ? '<button class="btn history-restore-btn" type="button">Restore</button>' : ''}
        <button class="btn history-download-btn" type="button">Download</button>
      </div>
    `;

    const restoreBtn = card.querySelector('.history-restore-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => restoreRevision(revision));
    }

    const historyDownloadBtn = card.querySelector('.history-download-btn');
    historyDownloadBtn.addEventListener('click', () => downloadRevision(revision));

    historyList.appendChild(card);
  }
}

function resetEditorToEmpty() {
  setCurrentNote(null);
  state.revisions = [];
  state.lastSavedContent = '';
  state.lastSavedFilename = '';
  state.dirty = false;
  filenameInput.value = '';
  state.editor.setValue('');
  renderPreview();
  renderHistory();
  updateDocStats();
  setSaveState('Ready.', 'info', true);
  updateActionState();
}

async function loadNotes() {
  const { data, error } = await sb
    .from('blob_index')
    .select('id, owner_id, bucket_id, object_path, filename, content_type, size_bytes, created_at, updated_at')
    .order('updated_at', { ascending: false });

  if (error) {
    throw error;
  }

  const markdownNotes = (data || []).filter(isMarkdownRow);
  const hiddenCount = (data || []).length - markdownNotes.length;
  state.notes = markdownNotes;
  renderNotesList();

  notesHiddenInfo.hidden = hiddenCount === 0;
  if (hiddenCount > 0) {
    notesHiddenInfo.textContent = `${hiddenCount} non-markdown file${hiddenCount === 1 ? '' : 's'} hidden.`;
  }

  if (!state.currentNote) return;
  const refreshed = state.notes.find((note) => note.id === state.currentNote.id);
  if (refreshed) {
    setCurrentNote({ ...refreshed, isNew: false });
  } else {
    resetEditorToEmpty();
  }
}

async function loadHistory(noteId) {
  const { data, error } = await sb
    .from('markdown_revisions')
    .select('id, blob_id, object_path, revision_number, created_at, size_bytes, filename')
    .eq('blob_id', noteId)
    .order('revision_number', { ascending: false });

  if (error) {
    throw error;
  }

  state.revisions = data || [];
  renderHistory();
  updateHeaderMeta();
}

function ensureCanLeaveCurrentNote() {
  if (!state.dirty) return true;
  return confirm('You have unsaved changes. Continue and discard them?');
}

async function openNote(noteId, options = {}) {
  if (state.currentNote && state.currentNote.id === noteId) {
    if (options.heading) {
      const targetId = slugifyHeading(options.heading);
      const heading = preview.querySelector(`[id="${targetId}"]`);
      if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (!options.heading) return;
  }

  if (!ensureCanLeaveCurrentNote()) {
    return;
  }

  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return;

  setSaveState(`Opening ${note.filename}…`, 'info', true);

  try {
    const plainBuffer = await downloadEncryptedObject(note.object_path);
    const text = textDecoder.decode(plainBuffer);

    setCurrentNote({ ...note, isNew: false });
    state.lastSavedContent = text;
    state.lastSavedFilename = note.filename;
    state.editor.setValue(text);
    state.editor.clearHistory();
    state.dirty = false;
    updateDocStats();
    renderPreview();
    await loadHistory(noteId);
    syncDirtyState();

    if (options.heading) {
      const targetId = slugifyHeading(options.heading);
      requestAnimationFrame(() => {
        const heading = preview.querySelector(`[id="${targetId}"]`);
        if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    setSaveState(`Opened ${note.filename}.`);
  } catch (error) {
    console.error(error);
    setSaveState(error.message && error.message.includes('decrypt')
      ? 'Unable to decrypt this note. Check your passphrase.'
      : `Failed to open note: ${error.message}`, 'error', true);
  }
}

function makeStoragePath(userId, blobId, filename, revisionNumber) {
  const safeName = sanitizeFilename(filename);
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `${userId}/${blobId}/revisions/${String(revisionNumber).padStart(6, '0')}-${stamp}-${safeName}.bin`;
}

async function getNextRevisionNumber(blobId) {
  const { data, error } = await sb
    .from('markdown_revisions')
    .select('revision_number')
    .eq('blob_id', blobId)
    .order('revision_number', { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data && data[0] ? data[0].revision_number : 0) + 1;
}

async function saveCurrentNote() {
  if (!state.currentNote || state.saveBusy) return;

  const validation = validateMarkdownFilename(filenameInput.value);
  if (validation.error) {
    setSaveState(validation.error, 'error', true);
    return;
  }

  const filename = validation.value;
  filenameInput.value = filename;
  const content = state.editor.getValue();
  const plainBytes = textEncoder.encode(content);
  if (plainBytes.byteLength > MAX_FILE_SIZE) {
    setSaveState(`This note is too large. Max size is ${formatBytes(MAX_FILE_SIZE)}.`, 'error', true);
    return;
  }

  state.saveBusy = true;
  updateActionState();
  setSaveState('Encrypting note…', 'info', true);

  try {
    const user = state.currentUser;
    const blobId = state.currentNote.id || crypto.randomUUID();
    const revisionNumber = await getNextRevisionNumber(blobId);
    const objectPath = makeStoragePath(user.id, blobId, filename, revisionNumber);
    const encryptedBytes = await encryptBytes(state.encryptionKey, plainBytes);
    const previousSnapshot = state.currentNote.isNew
      ? null
      : {
          object_path: state.currentNote.object_path,
          filename: state.currentNote.filename,
          content_type: state.currentNote.content_type,
          size_bytes: state.currentNote.size_bytes,
        };

    setSaveState('Uploading encrypted revision…', 'info', true);

    const { error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(objectPath, encryptedBytes, {
        contentType: 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const contentType = inferContentType(filename);
    const metadata = {
      id: blobId,
      owner_id: user.id,
      bucket_id: BUCKET,
      object_path: objectPath,
      filename,
      content_type: contentType,
      size_bytes: plainBytes.byteLength,
    };

    let metaError = null;

    if (state.currentNote.isNew) {
      const { error } = await sb.from('blob_index').insert(metadata);
      metaError = error;
    } else {
      const { error } = await sb
        .from('blob_index')
        .update({
          object_path: objectPath,
          filename,
          content_type: contentType,
          size_bytes: plainBytes.byteLength,
        })
        .eq('id', blobId);
      metaError = error;
    }

    if (metaError) {
      await sb.storage.from(BUCKET).remove([objectPath]);
      throw metaError;
    }

    const { error: revisionError } = await sb.from('markdown_revisions').insert({
      blob_id: blobId,
      owner_id: user.id,
      bucket_id: BUCKET,
      object_path: objectPath,
      filename,
      content_type: contentType,
      size_bytes: plainBytes.byteLength,
      revision_number: revisionNumber,
    });

    if (revisionError) {
      if (state.currentNote.isNew) {
        await sb.from('blob_index').delete().eq('id', blobId);
      } else if (previousSnapshot) {
        await sb
          .from('blob_index')
          .update(previousSnapshot)
          .eq('id', blobId);
      }
      await sb.storage.from(BUCKET).remove([objectPath]);
      throw revisionError;
    }

    state.lastSavedContent = content;
    state.lastSavedFilename = filename;
    state.dirty = false;

    await loadNotes();
    const refreshed = state.notes.find((note) => note.id === blobId) || {
      ...metadata,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    setCurrentNote({ ...refreshed, isNew: false });
    await loadHistory(blobId);
    updateDocStats();
    renderPreview();
    syncDirtyState();
    setSaveState(`Saved ${filename} as revision ${revisionNumber}.`);
  } catch (error) {
    console.error(error);
    setSaveState(`Save failed: ${error.message}`, 'error', true);
  } finally {
    state.saveBusy = false;
    updateActionState();
  }
}

async function deleteCurrentNote() {
  if (!state.currentNote) return;

  if (state.currentNote.isNew) {
    if (ensureCanLeaveCurrentNote()) {
      resetEditorToEmpty();
    }
    return;
  }

  const confirmed = confirm(`Delete ${state.currentNote.filename} and all saved revisions?`);
  if (!confirmed) return;

  try {
    const { data: revisions, error: revisionsError } = await sb
      .from('markdown_revisions')
      .select('object_path')
      .eq('blob_id', state.currentNote.id);

    if (revisionsError) throw revisionsError;

    const objectPaths = new Set((revisions || []).map((row) => row.object_path));
    if (state.currentNote.object_path) {
      objectPaths.add(state.currentNote.object_path);
    }

    if (objectPaths.size > 0) {
      const { error: storageError } = await sb.storage.from(BUCKET).remove([...objectPaths]);
      if (storageError) throw storageError;
    }

    const { error: deleteError } = await sb.from('blob_index').delete().eq('id', state.currentNote.id);
    if (deleteError) throw deleteError;

    resetEditorToEmpty();
    await loadNotes();
    setSaveState('Note deleted.');
  } catch (error) {
    console.error(error);
    setSaveState(`Delete failed: ${error.message}`, 'error', true);
  }
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: inferContentType(filename) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadCurrentNote() {
  if (!state.currentNote) return;
  const validation = validateMarkdownFilename(filenameInput.value || state.currentNote.filename);
  if (validation.error) {
    setSaveState(validation.error, 'error', true);
    return;
  }
  downloadTextFile(validation.value, state.editor.getValue());
}

async function downloadRevision(revision) {
  try {
    const plainBuffer = await downloadEncryptedObject(revision.object_path);
    const text = textDecoder.decode(plainBuffer);
    const baseName = (revision.filename || state.currentNote?.filename || 'note.md').replace(/\.md$/i, '');
    const fileName = `${baseName}.rev-${revision.revision_number}.md`;
    downloadTextFile(fileName, text);
  } catch (error) {
    console.error(error);
    setSaveState(`Revision download failed: ${error.message}`, 'error', true);
  }
}

async function restoreRevision(revision) {
  const confirmed = confirm(`Restore revision ${revision.revision_number} as a new latest save?`);
  if (!confirmed) return;

  try {
    const plainBuffer = await downloadEncryptedObject(revision.object_path);
    const text = textDecoder.decode(plainBuffer);
    state.editor.setValue(text);
    renderPreview();
    syncDirtyState();
    setSaveState(`Loaded revision ${revision.revision_number}. Saving it as the new latest revision…`, 'info', true);
    await saveCurrentNote();
  } catch (error) {
    console.error(error);
    setSaveState(`Restore failed: ${error.message}`, 'error', true);
  }
}

function revertCurrentNote() {
  if (!state.currentNote || state.currentNote.isNew) return;
  state.editor.setValue(state.lastSavedContent);
  filenameInput.value = state.lastSavedFilename;
  syncDirtyState();
  renderPreview();
  setSaveState('Reverted unsaved changes.');
}

function openNewNoteModal() {
  newNoteError.hidden = true;
  newNoteError.textContent = '';
  newNoteFilename.value = 'untitled.md';
  modalBackdrop.hidden = false;
  requestAnimationFrame(() => newNoteFilename.focus());
}

function closeNewNoteModal() {
  modalBackdrop.hidden = true;
}

function createNewNote(filename) {
  setCurrentNote({
    id: crypto.randomUUID(),
    filename,
    content_type: inferContentType(filename),
    size_bytes: 0,
    created_at: null,
    updated_at: null,
    object_path: null,
    isNew: true,
  });
  state.revisions = [];
  state.lastSavedContent = '';
  state.lastSavedFilename = filename;
  state.editor.setValue('');
  state.editor.clearHistory();
  updateDocStats();
  renderPreview();
  renderHistory();
  syncDirtyState();
  setSaveState('New note ready.');
  filenameInput.focus();
}

async function handleUpload(file) {
  if (!file) return;
  const validation = validateMarkdownFilename(file.name);
  if (validation.error) {
    setSaveState(validation.error, 'error', true);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    setSaveState(`This file exceeds the ${formatBytes(MAX_FILE_SIZE)} limit.`, 'error', true);
    return;
  }

  if (state.dirty && !ensureCanLeaveCurrentNote()) {
    return;
  }

  try {
    const text = await file.text();
    createNewNote(validation.value);
    state.editor.setValue(text);
    syncDirtyState();
    renderPreview();
    setSaveState(`Loaded ${validation.value}. Save it to upload an encrypted copy.`, 'info', true);
  } catch (error) {
    console.error(error);
    setSaveState(`Upload failed: ${error.message}`, 'error', true);
  } finally {
    uploadInput.value = '';
  }
}

function insertTemplate(type) {
  if (!state.currentNote) return;
  const cm = state.editor;
  const selection = cm.getSelection();
  let replacement = '';

  switch (type) {
    case 'bold':
      replacement = `**${selection || 'bold text'}**`;
      break;
    case 'italic':
      replacement = `*${selection || 'italic text'}*`;
      break;
    case 'link':
      replacement = `[${selection || 'link text'}](https://example.com)`;
      break;
    case 'wiki':
      replacement = `[[${selection || 'Note Name'}]]`;
      break;
    case 'task':
      replacement = `- [ ] ${selection || 'New task'}`;
      break;
    case 'code':
      replacement = `\n\n\`\`\`\n${selection || 'code'}\n\`\`\`\n`;
      break;
    case 'math':
      replacement = `\n\n$$\n${selection || 'E = mc^2'}\n$$\n`;
      break;
    case 'callout':
      replacement = `\n> [!note] ${selection || 'Callout title'}\n> Callout body\n`;
      break;
    default:
      return;
  }

  cm.replaceSelection(replacement, 'around');
  cm.focus();
}

async function signIn(email, password, passphrase) {
  setLoginError('');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;

  state.encryptionKey = await deriveKey(passphrase);
  const { data: userData } = await sb.auth.getUser();
  state.currentUser = userData.user;
  accountChip.textContent = state.currentUser?.email || '';

  showApp();
  await loadNotes();
  resetEditorToEmpty();
  setSaveState('Signed in. Choose a note or upload one.');
}

async function signOut() {
  if (state.dirty && !confirm('You have unsaved changes. Sign out anyway?')) {
    return;
  }

  await sb.auth.signOut();
  state.encryptionKey = null;
  state.currentUser = null;
  state.notes = [];
  state.revisions = [];
  state.currentNote = null;
  state.lastSavedContent = '';
  state.lastSavedFilename = '';
  state.dirty = false;
  noteList.textContent = '';
  historyList.textContent = '';
  preview.innerHTML = '';
  state.editor.setValue('');
  showLogin();
  setLoginError('');
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const passphrase = document.getElementById('passphrase').value;

  if (!passphrase) {
    setLoginError('Encryption passphrase is required.');
    return;
  }

  try {
    await signIn(email, password, passphrase);
    document.getElementById('passphrase').value = '';
  } catch (error) {
    console.error(error);
    setLoginError(error.message || 'Sign-in failed.');
  }
});

signOutBtn.addEventListener('click', signOut);

saveBtn.addEventListener('click', saveCurrentNote);
downloadBtn.addEventListener('click', downloadCurrentNote);
deleteBtn.addEventListener('click', deleteCurrentNote);
revertBtn.addEventListener('click', revertCurrentNote);
newNoteBtn.addEventListener('click', () => {
  if (!ensureCanLeaveCurrentNote()) return;
  openNewNoteModal();
});
uploadNoteBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => handleUpload(uploadInput.files[0]));

noteSearch.addEventListener('input', () => {
  state.searchTerm = noteSearch.value.trim();
  renderNotesList();
});

filenameInput.addEventListener('input', syncDirtyState);
filenameInput.addEventListener('blur', () => {
  const validation = validateMarkdownFilename(filenameInput.value || '');
  if (!validation.error) {
    filenameInput.value = validation.value;
    syncDirtyState();
  }
});

newNoteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const validation = validateMarkdownFilename(newNoteFilename.value);
  if (validation.error) {
    newNoteError.hidden = false;
    newNoteError.textContent = validation.error;
    return;
  }
  closeNewNoteModal();
  createNewNote(validation.value);
});

modalCancelBtn.addEventListener('click', closeNewNoteModal);
modalBackdrop.addEventListener('click', (event) => {
  if (event.target === modalBackdrop) closeNewNoteModal();
});

document.querySelectorAll('.tool-btn').forEach((button) => {
  button.addEventListener('click', () => insertTemplate(button.dataset.insert));
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCurrentNote();
  }

  if (event.key === 'Escape' && !modalBackdrop.hidden) {
    closeNewNoteModal();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

showLogin();
initEditor();
updateDocStats();
renderPreview();
setEditorEnabled(false);
renderHistory();
