/* ============================================================
   DOCKET SHARING — app

   State is three collections:
     notes    [{ id, title, body, pinned, folder, created, updated }]
     files    [{ id, name, size, type, folder, added }]   ← metadata only
     folders  [{ id, name, created }]

   A folder is only a label: `folder` holds its id, so deleting a folder
   never deletes what was in it.

   Both are cached in localStorage so the app works before you have
   connected a gist, and both are pushed to the gist when you have.
   File *bytes* never sit in either: they live one-per-file in the gist
   and are fetched only when downloaded (see store.js).
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const Store = window.DocketStore;

    const $ = (sel) => document.querySelector(sel);
    const el = (id) => document.getElementById(id);

    const LS_NOTES = 'docket.notes';
    const LS_FILES = 'docket.files';
    const LS_FOLDERS = 'docket.folders';
    const LS_ACTIVE = 'docket.activeFolder';

    let notes = [];
    let files = [];
    let folders = [];
    let unlocked = false;
    let focusId = null;

    /* Which folder the bar is filtered to: null = All, UNFILED = the items
       with no folder, otherwise a folder id. The sentinel is spelled out
       rather than being a blank or symbolic value so it is greppable and
       can never collide with a uid(), which is base36 only. */
    const UNFILED = '__unfiled__';
    let activeFolder = null;

    /* ============================================================
       HELPERS
       ============================================================ */

    const uid = () =>
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    function formatBytes(n) {
        if (!n) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
        const v = n / Math.pow(1024, i);
        return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    }

    function relTime(iso) {
        if (!iso) return '—';
        const then = new Date(iso);
        if (isNaN(then)) return '—';
        const secs = Math.round((Date.now() - then) / 1000);
        if (secs < 45) return 'just now';
        if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
        if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
        const days = Math.floor(secs / 86400);
        if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
        return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    const TEXTY = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml)|$)/;
    const isTexty = (type, name) =>
        TEXTY.test(type || '') || /\.(txt|md|json|csv|log|ya?ml|xml|js|ts|css|html|sh|py)$/i.test(name);

    function toast(msg) {
        const t = el('toast');
        t.textContent = msg;
        t.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { t.hidden = true; }, 3200);
    }

    function cache() {
        try {
            localStorage.setItem(LS_NOTES, JSON.stringify(notes));
            localStorage.setItem(LS_FILES, JSON.stringify(files));
            localStorage.setItem(LS_FOLDERS, JSON.stringify(folders));
        } catch (e) { /* quota or private mode — the gist is the real home */ }
    }

    function readCache() {
        try {
            const n = JSON.parse(localStorage.getItem(LS_NOTES) || '[]');
            const f = JSON.parse(localStorage.getItem(LS_FILES) || '[]');
            const d = JSON.parse(localStorage.getItem(LS_FOLDERS) || '[]');
            if (Array.isArray(n)) notes = n;
            if (Array.isArray(f)) files = f;
            if (Array.isArray(d)) folders = d;
            activeFolder = localStorage.getItem(LS_ACTIVE) || null;
        } catch (e) { /* leave the empties */ }
    }

    /* Every mutation goes through here: cache locally, then queue a push. */
    function commit() {
        cache();
        Store.touchData();
    }

    /* ============================================================
       PASSKEY GATE
       ============================================================ */

    el('gate-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const card = $('.gate-card');
        const msg = el('gate-msg');

        if (el('passkey').value !== CFG.PASSKEY) {
            msg.className = 'gate-msg';
            msg.textContent = "That passkey didn't work.";
            card.classList.remove('is-wrong');
            void card.offsetWidth;              /* restart the shake */
            card.classList.add('is-wrong');
            el('passkey').select();
            return;
        }

        el('gate').classList.add('is-gone');
        el('app').hidden = false;
        unlocked = true;

        Store.bind(() => ({
            notes, files, folders, version: 3, updated: new Date().toISOString()
        }));

        /* Show the cached copy immediately, then reconcile with the gist.
           Opening straight into your notes beats a spinner. */
        readCache();
        renderAll();
        await pullFromGist();
        reflectConnection();
    });

    el('lock-btn').addEventListener('click', async () => {
        if (Store.hasPending()) await Store.flush();
        location.reload();
    });

    /**
     * Pull the gist over local state.
     *
     * Replacing is right for a normal sync — it is how a delete made on
     * another machine actually lands here. But on the FIRST connect the
     * local notes have never been uploaded, and replacing would silently
     * bin them, so that one case merges instead: remote wins a conflict,
     * local-only notes survive.
     */
    async function pullFromGist(merge) {
        try {
            const data = await Store.load();
            if (!data) return;              /* not connected */

            if (merge) {
                notes = mergeById(data.notes, notes);
                files = mergeById(data.files, files);
                folders = mergeById(data.folders, folders);
            } else {
                notes = data.notes;
                files = data.files;
                folders = data.folders;
            }
            pruneFolder();
            cache();
            renderAll();
        } catch (err) { /* onStatus already surfaced it */ }
    }

    function mergeById(remote, local) {
        const out = remote.slice();
        const seen = new Set(remote.map((r) => r.id));
        local.forEach((l) => { if (!seen.has(l.id)) out.push(l); });
        return out;
    }

    /* ============================================================
       SYNC STATUS
       ============================================================ */

    const SYNC_UI = {
        loading: { icon: '#i-refresh',   text: 'Loading…',  cls: 'is-busy' },
        saving:  { icon: '#i-refresh',   text: 'Saving…',   cls: 'is-busy' },
        dirty:   { icon: '#i-refresh',   text: 'Unsaved',   cls: '' },
        synced:  { icon: '#i-check',     text: 'Synced',    cls: 'is-synced' },
        offline: { icon: '#i-cloud-off', text: 'Local',     cls: 'is-offline' },
        error:   { icon: '#i-alert',     text: 'Failed',    cls: 'is-error' }
    };

    Store.onStatus((state, detail) => {
        const ui = SYNC_UI[state] || SYNC_UI.synced;
        const pill = el('sync-pill');
        pill.className = `sync-pill ${ui.cls}`;
        pill.querySelector('use').setAttribute('href', ui.icon);
        el('sync-text').textContent = ui.text;
        pill.title = state === 'offline'
            ? 'Not connected — saved on this device only'
            : 'Sync now';

        if (state === 'error') showBanner(detail);
        if (state === 'synced') {
            hideBanner();
            el('foot-stamp').textContent = `synced ${new Date().toLocaleTimeString()}`;
        }
        if (state === 'offline') el('foot-stamp').textContent = 'not connected';
    });

    function showBanner(text) {
        el('banner-text').textContent = text;
        el('banner').hidden = false;
    }
    function hideBanner() { el('banner').hidden = true; }

    el('banner-close').addEventListener('click', hideBanner);
    el('banner-retry').addEventListener('click', () => { hideBanner(); Store.retry(); });

    /* Clicking the pill pushes anything outstanding, then pulls — the
       manual "get me level with the other machine" button. */
    el('sync-pill').addEventListener('click', async () => {
        if (!Store.isConnected()) { openSettings(); return; }
        if (Store.hasPending()) await Store.flush();
        await pullFromGist();
    });

    function reflectConnection() {
        const on = Store.isConnected();
        el('connect-card').hidden = on;
        el('dropzone-hint').textContent = on
            ? `Up to ${formatBytes(CFG.MAX_FILE_BYTES)} each · ${CFG.MAX_FILES} files`
            : 'Connect a gist under Settings to store files';
        el('dropzone').classList.toggle('is-disabled', !on);
        if (!on) el('foot-stamp').textContent = 'not connected';
    }

    /* Last line of defence against closing the tab on an unsaved edit. */
    window.addEventListener('beforeunload', (e) => {
        if (unlocked && Store.hasPending()) { e.preventDefault(); e.returnValue = ''; }
    });

    /* ============================================================
       TABS
       ============================================================ */

    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((t) => {
                const on = t === tab;
                t.classList.toggle('is-active', on);
                t.setAttribute('aria-selected', String(on));
            });
            document.querySelectorAll('.panel').forEach((p) => {
                p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`);
            });
            renderFolders();
        });
    });

    /* ============================================================
       THEME
       ============================================================ */

    el('theme-btn').addEventListener('click', () => {
        const dark = document.documentElement.classList.toggle('theme-dark');
        try { localStorage.setItem('docket.theme', dark ? 'dark' : 'light'); } catch (e) {}
    });

    /* ============================================================
       FOLDERS

       One shared set across both tabs — a folder holds notes and files
       alike, and the bar filters whichever tab is showing. Membership is
       a single `folder` id on the item, so a folder is only ever a label:
       deleting one never deletes what is in it.
       ============================================================ */

    const folderName = (id) => {
        const f = folders.find((x) => x.id === id);
        return f ? f.name : '';
    };

    const inActiveFolder = (item) =>
        activeFolder === null ||
        (activeFolder === UNFILED ? !item.folder : item.folder === activeFolder);

    /* A folder deleted on another machine leaves items pointing at nothing,
       and possibly a selection pointing at nothing. Both fall back to
       unfiled rather than showing an empty app with no way out. */
    function pruneFolder() {
        const live = new Set(folders.map((f) => f.id));
        [...notes, ...files].forEach((i) => { if (i.folder && !live.has(i.folder)) i.folder = null; });
        if (activeFolder && activeFolder !== UNFILED && !live.has(activeFolder)) {
            setActiveFolder(null, true);
        }
    }

    function setActiveFolder(id, quiet) {
        activeFolder = id;
        try {
            if (id) localStorage.setItem(LS_ACTIVE, id);
            else localStorage.removeItem(LS_ACTIVE);
        } catch (e) {}
        if (quiet) return;
        renderFolders();
        renderNotes();
        renderFiles();
    }

    const activeTab = () =>
        document.querySelector('.tab.is-active').dataset.tab;

    /* Counts follow the tab you are on: "Work 3" means three notes while
       you are reading notes, three files while you are reading files. */
    function folderCount(id) {
        const pool = activeTab() === 'files' ? files : notes;
        return pool.filter((i) => (id === UNFILED ? !i.folder : i.folder === id)).length;
    }

    function renderFolders() {
        const pool = activeTab() === 'files' ? files : notes;
        const unfiled = pool.filter((i) => !i.folder).length;

        const chip = (id, label, count, deletable) => `
            <button class="chip${activeFolder === id ? ' is-active' : ''}"
                    type="button" data-folder="${id === null ? '' : esc(id)}"
                    role="tab" aria-selected="${activeFolder === id}">
                ${id === null ? '' : '<svg class="ico"><use href="#i-folder"></use></svg>'}
                <span class="chip-label">${esc(label)}</span>
                <span class="chip-count">${count}</span>
                ${deletable ? `<span class="chip-x" role="button" tabindex="0"
                     data-del="${esc(id)}" aria-label="Delete folder ${esc(label)}">
                     <svg class="ico"><use href="#i-x"></use></svg></span>` : ''}
            </button>`;

        el('folder-chips').innerHTML =
            chip(null, 'All', pool.length, false) +
            folders.map((f) => chip(f.id, f.name, folderCount(f.id), true)).join('') +
            (unfiled && folders.length ? chip(UNFILED, 'Unfiled', unfiled, false) : '');
    }

    el('folder-chips').addEventListener('click', (e) => {
        const x = e.target.closest('.chip-x');
        if (x) { e.stopPropagation(); askDeleteFolder(x.dataset.del); return; }
        const chip = e.target.closest('.chip');
        if (!chip) return;
        setActiveFolder(chip.dataset.folder || null);
    });

    function askDeleteFolder(id) {
        const name = folderName(id);
        const held = [...notes, ...files].filter((i) => i.folder === id).length;
        confirmAction(
            `Delete “${name}”?`,
            held
                ? `The ${held} item${held === 1 ? '' : 's'} in it will move to Unfiled, not be deleted.`
                : 'The folder is empty.',
            () => {
                folders = folders.filter((f) => f.id !== id);
                [...notes, ...files].forEach((i) => { if (i.folder === id) i.folder = null; });
                if (activeFolder === id) setActiveFolder(null, true);
                renderAll();
                commit();
                toast(`Folder “${name}” deleted`);
            });
    }

    /* ---- the folder modal: pick one for an item, or make a new one ---- */

    let folderTarget = null;     /* {kind:'note'|'file', id} while moving */

    function openFolderModal(target) {
        folderTarget = target || null;
        const moving = Boolean(target);
        el('folder-modal-title').textContent = moving ? 'Move to folder' : 'New folder';
        el('folder-picker').hidden = !moving;
        el('folder-create').textContent = moving ? 'Create & move' : 'Create';

        if (moving) {
            const item = itemOf(target);
            const row = (id, label) => `
                <li><button class="picker-row${item.folder === id || (!item.folder && id === null)
                        ? ' is-current' : ''}" type="button" data-pick="${id === null ? '' : esc(id)}">
                    <svg class="ico"><use href="#i-${id === null ? 'x' : 'folder'}"></use></svg>
                    <span>${esc(label)}</span>
                </button></li>`;
            el('folder-picker').innerHTML =
                row(null, 'No folder') + folders.map((f) => row(f.id, f.name)).join('');
        }

        el('folder-name').value = '';
        el('folder-modal').hidden = false;
        (moving ? el('folder-picker').querySelector('.picker-row') : el('folder-name')).focus();
    }

    const itemOf = (t) => (t.kind === 'note' ? notes : files).find((i) => i.id === t.id);

    function closeFolderModal() {
        el('folder-modal').hidden = true;
        folderTarget = null;
    }

    function assignFolder(id) {
        if (!folderTarget) return;
        const item = itemOf(folderTarget);
        if (item) {
            item.folder = id;
            if (folderTarget.kind === 'note') item.updated = new Date().toISOString();
        }
        closeFolderModal();
        renderAll();
        commit();
        toast(id ? `Moved to “${folderName(id)}”` : 'Removed from folder');
    }

    el('folder-picker').addEventListener('click', (e) => {
        const row = e.target.closest('.picker-row');
        if (row) assignFolder(row.dataset.pick || null);
    });

    function createFolder() {
        const name = el('folder-name').value.trim();
        if (!name) { el('folder-name').focus(); return; }
        if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
            toast('You already have a folder with that name');
            return;
        }
        const folder = { id: uid(), name, created: new Date().toISOString() };
        folders.push(folder);

        /* Creating from the move dialog should also do the moving —
           otherwise you make a folder and then have to find the item again. */
        if (folderTarget) { assignFolder(folder.id); return; }

        closeFolderModal();
        setActiveFolder(folder.id);
        renderAll();
        commit();
        toast(`Folder “${name}” created`);
    }

    el('new-folder-btn').addEventListener('click', () => openFolderModal(null));
    el('folder-create').addEventListener('click', createFolder);
    el('folder-cancel').addEventListener('click', closeFolderModal);
    el('folder-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); createFolder(); }
    });
    el('folder-modal').addEventListener('click', (e) => {
        if (e.target === el('folder-modal')) closeFolderModal();
    });

    /* ============================================================
       NOTES
       ============================================================ */

    function sortedNotes() {
        const q = el('note-search').value.trim().toLowerCase();
        return notes
            .filter(inActiveFolder)
            .filter((n) => !q ||
                (n.title || '').toLowerCase().includes(q) ||
                (n.body || '').toLowerCase().includes(q))
            .slice()
            .sort((a, b) =>
                (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                new Date(b.updated || 0) - new Date(a.updated || 0));
    }

    const lineCount = (s) => (s ? s.split('\n').length : 0);

    function renderNotes() {
        const grid = el('note-grid');
        const list = sortedNotes();

        el('count-notes').textContent = notes.length;
        el('notes-empty').hidden = notes.length !== 0;

        grid.innerHTML = list.map((n) => `
            <article class="note${n.pinned ? ' is-pinned' : ''}" data-id="${n.id}">
                <input class="note-title" type="text" value="${esc(n.title || '')}"
                       placeholder="Untitled" maxlength="120" aria-label="Note title">
                <div class="note-bodywrap">
                    <textarea class="note-body" placeholder="Start typing…"
                              aria-label="Note body"></textarea>
                    <div class="note-fade" aria-hidden="true"></div>
                </div>
                <button class="note-expand" type="button">
                    <svg class="ico"><use href="#i-chevron"></use></svg>
                    <span class="note-expand-label">Expand</span>
                </button>
                <div class="note-foot">
                    <button class="note-folder${n.folder ? ' is-set' : ''}" type="button"
                            title="${n.folder ? `In “${esc(folderName(n.folder))}” — move` : 'Move to a folder'}"
                            aria-label="Move to folder">
                        <svg class="ico"><use href="#i-folder"></use></svg>
                        ${n.folder ? `<span>${esc(folderName(n.folder))}</span>` : ''}
                    </button>
                    <span class="note-stamp">${esc(relTime(n.updated))}</span>
                    <button class="note-act act-pin${n.pinned ? ' is-on' : ''}" type="button"
                            title="${n.pinned ? 'Unpin' : 'Pin to top'}"
                            aria-label="${n.pinned ? 'Unpin note' : 'Pin note'}">
                        <svg class="ico"><use href="#i-pin"></use></svg>
                    </button>
                    <button class="note-act act-del" type="button" title="Delete note"
                            aria-label="Delete note">
                        <svg class="ico"><use href="#i-trash"></use></svg>
                    </button>
                </div>
            </article>`).join('');

        /* Bodies are assigned, not interpolated into the markup. The HTML
           parser drops a leading newline inside <textarea>, so a note that
           opens with a blank line would lose it on every re-render — and
           this grid re-renders on pin, search, delete and sync. */
        grid.querySelectorAll('.note-body').forEach((ta, i) => {
            ta.value = list[i].body || '';
            sizeNote(ta);
        });

        if (list.length === 0 && notes.length > 0) {
            grid.innerHTML = '<p class="hint">No notes match that search.</p>';
        }
    }

    /* Grow a note to fit its text, but only up to NOTE_COLLAPSE_PX. Past
       that the card clamps and grows an Expand control instead — one
       pasted file should not push every other note off the screen. */
    function sizeNote(ta) {
        const card = ta.closest('.note');
        ta.style.height = 'auto';
        const full = ta.scrollHeight;
        const clamped = full > CFG.NOTE_COLLAPSE_PX;

        ta.style.height = `${clamped ? CFG.NOTE_COLLAPSE_PX : Math.max(full, 132)}px`;
        card.classList.toggle('is-clamped', clamped);

        if (clamped) {
            const note = findNote(card.dataset.id);
            const lines = lineCount(note && note.body);
            card.querySelector('.note-expand-label').textContent =
                `Expand · ${lines.toLocaleString()} lines`;
        }
    }

    const findNote = (id) => notes.find((n) => n.id === id);

    function touchNote(note, card) {
        note.updated = new Date().toISOString();
        /* Update the stamp in place rather than re-rendering: a re-render
           mid-keystroke would blow away the caret. */
        if (card) card.querySelector('.note-stamp').textContent = relTime(note.updated);
        commit();
    }

    function newNote() {
        const now = new Date().toISOString();
        notes.unshift({
            id: uid(), title: '', body: '', pinned: false,
            folder: activeFolder && activeFolder !== UNFILED ? activeFolder : null,
            created: now, updated: now
        });
        renderNotes();
        commit();
        const first = $('.note .note-title');
        if (first) first.focus();
    }

    el('new-note-btn').addEventListener('click', newNote);
    document.querySelectorAll('[data-act="new-note"]').forEach((b) =>
        b.addEventListener('click', newNote));

    /* One delegated listener per event type, rather than four per card —
       note cards re-render often enough that per-card wiring would leak. */
    el('note-grid').addEventListener('input', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        if (e.target.classList.contains('note-title')) note.title = e.target.value;
        else if (e.target.classList.contains('note-body')) {
            note.body = e.target.value;
            sizeNote(e.target);
        } else return;

        touchNote(note, card);
    });

    el('note-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        if (e.target.closest('.note-folder')) {
            openFolderModal({ kind: 'note', id: note.id });
        } else if (e.target.closest('.note-expand')) {
            openFocus(note.id);
        } else if (e.target.closest('.act-pin')) {
            note.pinned = !note.pinned;
            touchNote(note, null);
            renderNotes();
        } else if (e.target.closest('.act-del')) {
            const label = (note.title || '').trim() || 'this untitled note';
            confirmAction('Delete note?', `“${label}” will be removed everywhere this docket syncs.`, () => {
                notes = notes.filter((n) => n.id !== note.id);
                renderNotes();
                commit();
                toast('Note deleted');
            });
        }
    });

    el('note-search').addEventListener('input', renderNotes);

    /* ============================================================
       FOCUS VIEW
       ============================================================ */

    function openFocus(id) {
        const note = findNote(id);
        if (!note) return;
        focusId = id;
        el('focus-title').value = note.title || '';
        el('focus-body').value = note.body || '';
        updateFocusMeta();
        el('focus-modal').hidden = false;
        document.body.classList.add('is-locked');
        el('focus-body').focus();
        el('focus-body').setSelectionRange(0, 0);
        el('focus-body').scrollTop = 0;
    }

    function closeFocus() {
        el('focus-modal').hidden = true;
        document.body.classList.remove('is-locked');
        focusId = null;
        renderNotes();
    }

    function updateFocusMeta() {
        const body = el('focus-body').value;
        const words = body.trim() ? body.trim().split(/\s+/).length : 0;
        el('focus-meta').textContent =
            `${lineCount(body).toLocaleString()} lines · ${words.toLocaleString()} words`;
    }

    ['focus-title', 'focus-body'].forEach((id) => {
        el(id).addEventListener('input', () => {
            const note = findNote(focusId);
            if (!note) return;
            note.title = el('focus-title').value;
            note.body = el('focus-body').value;
            note.updated = new Date().toISOString();
            updateFocusMeta();
            commit();
        });
    });

    el('focus-close').addEventListener('click', closeFocus);
    el('focus-done').addEventListener('click', closeFocus);
    el('focus-modal').addEventListener('click', (e) => {
        if (e.target === el('focus-modal')) closeFocus();
    });

    el('focus-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(el('focus-body').value);
            toast('Note copied');
        } catch (err) { toast('Clipboard blocked by the browser'); }
    });

    /* Tab should indent inside a note, not jump to the next control —
       these notes hold code often enough for that to matter. */
    el('focus-body').addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const ta = e.target;
        const { selectionStart: s, selectionEnd: t } = ta;
        ta.value = `${ta.value.slice(0, s)}    ${ta.value.slice(t)}`;
        ta.selectionStart = ta.selectionEnd = s + 4;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    /* ============================================================
       FILES
       ============================================================ */

    el('upload-btn').addEventListener('click', () => el('file-input').click());
    document.querySelectorAll('[data-act="upload"]').forEach((b) =>
        b.addEventListener('click', () => el('file-input').click()));

    el('file-input').addEventListener('change', (e) => {
        acceptFiles(e.target.files);
        e.target.value = '';   /* so re-picking the same file fires again */
    });

    const zone = el('dropzone');
    ['dragenter', 'dragover'].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
            e.preventDefault();
            if (Store.isConnected()) zone.classList.add('is-over');
        }));
    ['dragleave', 'drop'].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
        }));
    zone.addEventListener('drop', (e) => acceptFiles(e.dataTransfer.files));

    /* A drop anywhere but the zone would otherwise make the browser
       navigate away to the file, silently losing unsaved work. */
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    const totalBytes = () => files.reduce((sum, f) => sum + (f.size || 0), 0);

    async function acceptFiles(fileList) {
        const incoming = Array.from(fileList || []);
        if (!incoming.length) return;

        /* Bytes live in the gist, not on this device — there is nowhere
           to put them until a gist is connected. */
        if (!Store.isConnected()) {
            toast('Connect a gist under Settings to store files');
            openSettings();
            return;
        }

        let added = 0;
        for (const file of incoming) {
            if (file.size > CFG.MAX_FILE_BYTES) {
                toast(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(CFG.MAX_FILE_BYTES)} per file`);
                continue;
            }
            if (files.length >= CFG.MAX_FILES) {
                toast(`A gist holds ${CFG.MAX_FILES} files; delete something first`);
                break;
            }

            /* Read first, register second. The other order leaves a row in
               `files` with no matching blob if the read fails. */
            let payload;
            try {
                payload = await readBase64(file);
            } catch (err) {
                toast(`Could not read ${file.name}`);
                continue;
            }

            const id = uid();
            Store.putBlob(id, payload);
            files.unshift({
                id,
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                folder: activeFolder && activeFolder !== UNFILED ? activeFolder : null,
                added: new Date().toISOString()
            });
            added++;
        }

        if (!added) return;
        renderFiles();
        commit();
        toast(`${added} file${added === 1 ? '' : 's'} uploading…`);
    }

    /* readAsDataURL hands back "data:<mime>;base64,<payload>"; only the
       payload is stored, since the mime is already in the metadata. */
    function readBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    function base64ToBlob(b64, type) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: type || 'application/octet-stream' });
    }

    function renderFiles() {
        const list = el('file-list');
        const q = el('file-search').value.trim().toLowerCase();
        const shown = files.filter(inActiveFolder)
                           .filter((f) => !q || f.name.toLowerCase().includes(q));

        el('count-files').textContent = files.length;

        list.innerHTML = shown.map((f) => `
            <li class="file" data-id="${f.id}">
                <span class="file-icon" aria-hidden="true">
                    <svg class="ico"><use href="#i-file"></use></svg>
                </span>
                <div class="file-main">
                    <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
                    <span class="file-meta">${formatBytes(f.size)} · ${esc(relTime(f.added))}
                        · <button class="file-folder${f.folder ? ' is-set' : ''}" type="button"
                                  aria-label="Move to folder">${f.folder
                            ? esc(folderName(f.folder)) : 'add to folder'}</button>
                    </span>
                </div>
                <div class="file-acts">
                    ${isTexty(f.type, f.name) ? `
                    <button class="note-act act-copy" type="button" title="Copy contents"
                            aria-label="Copy contents">
                        <svg class="ico"><use href="#i-copy"></use></svg>
                    </button>` : ''}
                    <button class="note-act act-get" type="button" title="Download"
                            aria-label="Download">
                        <svg class="ico"><use href="#i-download"></use></svg>
                    </button>
                    <button class="note-act act-del" type="button" title="Delete"
                            aria-label="Delete">
                        <svg class="ico"><use href="#i-trash"></use></svg>
                    </button>
                </div>
            </li>`).join('');

        if (!shown.length && files.length) {
            list.innerHTML = '<p class="hint">No files match that search.</p>';
        }

        el('file-note').textContent = files.length
            ? `${files.length} of ${CFG.MAX_FILES} files · ${formatBytes(totalBytes())} stored in your gist`
            : '';
    }

    el('file-list').addEventListener('click', async (e) => {
        const row = e.target.closest('.file');
        if (!row) return;
        const meta = files.find((f) => f.id === row.dataset.id);
        if (!meta) return;

        if (e.target.closest('.file-folder')) {
            openFolderModal({ kind: 'file', id: meta.id });
            return;
        }

        const btn = e.target.closest('.note-act');
        if (!btn) return;

        if (btn.classList.contains('act-del')) {
            confirmAction('Delete file?', `“${meta.name}” will be removed everywhere this docket syncs.`, () => {
                files = files.filter((f) => f.id !== meta.id);
                Store.dropBlob(meta.id);
                renderFiles();
                commit();
                toast('File deleted');
            });
            return;
        }

        /* Bytes are pulled on demand, so both of these are async and can
           take a moment on a large file. */
        btn.classList.add('is-working');
        try {
            const payload = await Store.getBlob(meta.id);
            if (!payload) { toast('That file has no contents in the gist yet'); return; }

            if (btn.classList.contains('act-get')) {
                const url = URL.createObjectURL(base64ToBlob(payload, meta.type));
                const a = document.createElement('a');
                a.href = url;
                a.download = meta.name;
                a.click();
                /* Revoking immediately can beat the download on some browsers. */
                setTimeout(() => URL.revokeObjectURL(url), 30000);
            } else if (btn.classList.contains('act-copy')) {
                await navigator.clipboard.writeText(
                    await base64ToBlob(payload, meta.type).text());
                toast('Copied to clipboard');
            }
        } catch (err) {
            toast(err.message || 'Could not fetch that file');
        } finally {
            btn.classList.remove('is-working');
        }
    });

    el('file-search').addEventListener('input', renderFiles);

    /* ============================================================
       CONFIRM MODAL
       ============================================================ */

    let confirmFn = null;

    function confirmAction(title, body, onOk) {
        el('confirm-title').textContent = title;
        el('confirm-body').textContent = body;
        confirmFn = onOk;
        el('confirm-modal').hidden = false;
        el('confirm-ok').focus();
    }

    function closeConfirm() {
        el('confirm-modal').hidden = true;
        confirmFn = null;
    }

    el('confirm-ok').addEventListener('click', () => {
        const fn = confirmFn;
        closeConfirm();
        if (fn) fn();
    });
    el('confirm-cancel').addEventListener('click', closeConfirm);

    /* ============================================================
       SETTINGS
       ============================================================ */

    function openSettings() {
        const { token, gistId } = Store.credentials();
        el('token-input').value = token;
        el('gist-input').value = gistId;
        el('fact-status').textContent = Store.isConnected() ? 'connected' : 'not connected';
        el('fact-token').textContent = Store.tokenHint();
        el('fact-notes').textContent = `${notes.length} saved`;
        el('fact-files').textContent = `${files.length} · ${formatBytes(totalBytes())}`;
        el('settings-modal').hidden = false;
    }

    el('settings-btn').addEventListener('click', openSettings);
    document.querySelectorAll('[data-act="settings"]').forEach((b) =>
        b.addEventListener('click', openSettings));

    el('settings-cancel').addEventListener('click', () => { el('settings-modal').hidden = true; });

    el('settings-save').addEventListener('click', async () => {
        Store.setCredentials(el('token-input').value, el('gist-input').value);
        el('settings-modal').hidden = true;
        reflectConnection();

        if (!Store.isConnected()) { toast('Cloud sync turned off'); return; }
        toast('Connecting…');
        await pullFromGist(true);
        /* Push the merged result straight back, so whatever this device
           had before connecting actually reaches the gist. */
        if (notes.length || files.length) commit();
    });

    el('reload-btn').addEventListener('click', async () => {
        el('settings-modal').hidden = true;
        if (Store.hasPending()) await Store.flush();
        await pullFromGist();
        toast(Store.isConnected() ? 'Reloaded from gist' : 'Not connected');
    });

    /* Escape closes whichever layer is on top. */
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!el('confirm-modal').hidden) closeConfirm();
        else if (!el('folder-modal').hidden) closeFolderModal();
        else if (!el('settings-modal').hidden) el('settings-modal').hidden = true;
        else if (!el('focus-modal').hidden) closeFocus();
    });

    /* Click the scrim (but not the card) to dismiss. */
    ['settings-modal', 'confirm-modal'].forEach((id) => {
        el(id).addEventListener('click', (e) => {
            if (e.target !== el(id)) return;
            if (id === 'confirm-modal') closeConfirm();
            else el(id).hidden = true;
        });
    });

    /* ============================================================
       RENDER + CLOCK
       ============================================================ */

    function renderAll() {
        renderFolders();
        renderNotes();
        renderFiles();
        reflectConnection();
    }

    /* Relative stamps go stale on a tab left open all day. Cheap enough
       on a minute tick, but only when nothing in the grid has focus —
       otherwise it would fight the caret. */
    setInterval(() => {
        if (!unlocked) return;
        if (el('note-grid').contains(document.activeElement)) return;
        document.querySelectorAll('.note').forEach((card) => {
            const note = findNote(card.dataset.id);
            if (note) card.querySelector('.note-stamp').textContent = relTime(note.updated);
        });
    }, 60000);

    /* Re-clamp on resize: a card that fits at desktop width may overflow
       once the grid drops to one column. */
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!unlocked) return;
            document.querySelectorAll('.note-body').forEach(sizeNote);
        }, 150);
    });
})();
