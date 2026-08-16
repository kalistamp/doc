/* ============================================================
   DOCKET SHARING — app

   State is four collections, all of them in the gist:
     notes    [{ id, kind, title, body|items, pinned, pinnedAt, folder,
                 created, updated }]
     files    [{ id, name, size, type, folder, added }]   ← metadata only
     folders  [{ id, name, created }]
     trash    [{ kind, item, deletedAt }]

   A note is either kind 'note' (a `body` string) or kind 'checklist'
   (an `items` array). Anything without a kind is a plain note, which is
   what every note written before checklists existed looks like.

   A folder is only a label: `folder` holds its id, so deleting a folder
   never deletes what was in it.

   All four are cached in localStorage so the app works before a gist is
   connected. File *bytes* never sit in either store: they live
   one-per-file in the gist and are fetched only when downloaded.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const Store = window.DocketStore;

    const $ = (sel) => document.querySelector(sel);
    const el = (id) => document.getElementById(id);

    const LS = {
        notes: 'docket.notes', files: 'docket.files', folders: 'docket.folders',
        trash: 'docket.trash', active: 'docket.activeFolder',
        noteSort: 'docket.noteSort', fileSort: 'docket.fileSort',
        noteView: 'docket.noteView'
    };

    let notes = [];
    let files = [];
    let folders = [];
    let trash = [];
    let unlocked = false;
    let focusId = null;

    /* Which folder the bar is filtered to: null = All, UNFILED = the items
       with no folder, otherwise a folder id. The sentinel is spelled out
       so it is greppable and can never collide with a uid(), which is
       base36 only. */
    const UNFILED = '__unfiled__';
    let activeFolder = null;

    /* How much of each note the board shows: the full card, a shorter
       card, or a two-line row. Kept in localStorage and NOT in the gist —
       like the theme, it is a property of the screen you are looking at,
       and syncing it would have a phone and a desktop overwrite each
       other's choice all day. */
    const VIEWS = ['cards', 'compact', 'list'];
    let noteView = 'cards';

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

    const isList = (n) => n.kind === 'checklist';
    const lineCount = (s) => (s ? s.split('\n').length : 0);

    /** The searchable / sortable text of a note, whichever kind it is. */
    const noteText = (n) =>
        isList(n) ? (n.items || []).map((i) => i.text).join('\n') : (n.body || '');

    /* An untitled note shows its first line as the title instead of the
       word "Untitled". It is shown, never stored — so typing a real title
       still works and nothing is silently rewritten under you. */
    function derivedTitle(n) {
        const first = noteText(n).split('\n').find((l) => l.trim());
        return (first || '').trim().slice(0, 80);
    }
    const titleOf = (n) => ((n.title || '').trim() || derivedTitle(n) || 'Untitled');

    /* ---- toast, with an optional Undo ---------------------------------- */

    let undoFn = null;

    function toast(msg, onUndo) {
        el('toast-text').textContent = msg;
        undoFn = onUndo || null;
        el('toast-undo').hidden = !undoFn;
        el('toast').hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(hideToast, onUndo ? CFG.UNDO_MS : 3200);
    }
    function hideToast() {
        el('toast').hidden = true;
        undoFn = null;
    }
    el('toast-undo').addEventListener('click', () => {
        const fn = undoFn;
        hideToast();
        if (fn) fn();
    });

    /* ---- persistence ---------------------------------------------------- */

    function cache() {
        try {
            localStorage.setItem(LS.notes, JSON.stringify(notes));
            localStorage.setItem(LS.files, JSON.stringify(files));
            localStorage.setItem(LS.folders, JSON.stringify(folders));
            localStorage.setItem(LS.trash, JSON.stringify(trash));
        } catch (e) { /* quota or private mode — the gist is the real home */ }
    }

    function readCache() {
        const get = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } };
        const n = get(LS.notes), f = get(LS.files), d = get(LS.folders), t = get(LS.trash);
        if (Array.isArray(n)) notes = n;
        if (Array.isArray(f)) files = f;
        if (Array.isArray(d)) folders = d;
        if (Array.isArray(t)) trash = t;
        try {
            activeFolder = localStorage.getItem(LS.active) || null;
            el('note-sort').value = localStorage.getItem(LS.noteSort) || 'updated';
            el('file-sort').value = localStorage.getItem(LS.fileSort) || 'added';
            const view = localStorage.getItem(LS.noteView);
            if (VIEWS.includes(view)) noteView = view;
        } catch (e) {}
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
            notes, files, folders, trash,
            version: 4, updated: new Date().toISOString()
        }));

        /* Show the cached copy immediately, then reconcile with the gist.
           Opening straight into your notes beats a spinner. */
        readCache();
        purgeTrash();
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
                trash = data.trash.concat(trash);
            } else {
                notes = data.notes;
                files = data.files;
                folders = data.folders;
                trash = data.trash;
            }
            pruneFolder();
            purgeTrash();
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

    const activeTab = () => document.querySelector('.tab.is-active').dataset.tab;

    function showTab(name) {
        document.querySelectorAll('.tab').forEach((t) => {
            const on = t.dataset.tab === name;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', String(on));
        });
        document.querySelectorAll('.panel').forEach((p) => {
            p.classList.toggle('is-active', p.id === `panel-${name}`);
        });
        /* Folders do not apply to the trash — it is a flat list of things
           on their way out, and filtering it by folder would only hide
           what you came here to find. */
        el('folder-bar').hidden = name === 'trash';
        renderFolders();
    }

    document.querySelectorAll('.tab').forEach((tab) =>
        tab.addEventListener('click', () => showTab(tab.dataset.tab)));

    /* ============================================================
       THEME
       ============================================================ */

    el('theme-btn').addEventListener('click', () => {
        const dark = document.documentElement.classList.toggle('theme-dark');
        try { localStorage.setItem('docket.theme', dark ? 'dark' : 'light'); } catch (e) {}
    });

    /* ============================================================
       SEARCH + SORT
       ============================================================ */

    const query = () => el('search').value.trim().toLowerCase();

    const matchesNote = (n) => {
        const q = query();
        return !q || (n.title || '').toLowerCase().includes(q) ||
                     noteText(n).toLowerCase().includes(q);
    };
    const matchesFile = (f) => {
        const q = query();
        return !q || f.name.toLowerCase().includes(q);
    };

    const NOTE_SORTS = {
        updated: (a, b) => new Date(b.updated || 0) - new Date(a.updated || 0),
        created: (a, b) => new Date(b.created || 0) - new Date(a.created || 0),
        title: (a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' })
    };
    const FILE_SORTS = {
        added: (a, b) => new Date(b.added || 0) - new Date(a.added || 0),
        name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        size: (a, b) => (b.size || 0) - (a.size || 0)
    };

    el('search').addEventListener('input', () => { renderNotes(); renderFiles(); });

    el('note-sort').addEventListener('change', () => {
        try { localStorage.setItem(LS.noteSort, el('note-sort').value); } catch (e) {}
        renderNotes();
    });
    el('file-sort').addEventListener('change', () => {
        try { localStorage.setItem(LS.fileSort, el('file-sort').value); } catch (e) {}
        renderFiles();
    });

    /* ============================================================
       FOLDERS

       One shared set across both tabs — a folder holds notes and files
       alike, and the bar filters whichever tab is showing.
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
            if (id) localStorage.setItem(LS.active, id);
            else localStorage.removeItem(LS.active);
        } catch (e) {}
        if (quiet) return;
        renderFolders();
        renderNotes();
        renderFiles();
    }

    /* Counts follow the tab you are on: "Work 3" means three notes while
       you are reading notes, three files while you are reading files. */
    function folderCount(id) {
        const pool = activeTab() === 'files' ? files : notes;
        return pool.filter((i) => (id === UNFILED ? !i.folder : i.folder === id)).length;
    }

    function renderFolders() {
        const pool = activeTab() === 'files' ? files : notes;
        const unfiled = pool.filter((i) => !i.folder).length;

        const chip = (id, label, count, own) => `
            <button class="chip${activeFolder === id ? ' is-active' : ''}"
                    type="button" data-folder="${id === null ? '' : esc(id)}"
                    role="tab" aria-selected="${activeFolder === id}">
                ${id === null ? '' : '<svg class="ico"><use href="#i-folder"></use></svg>'}
                <span class="chip-label">${esc(label)}</span>
                <span class="chip-count">${count}</span>
                ${own ? `<span class="chip-act" role="button" tabindex="0"
                     data-rename="${esc(id)}" aria-label="Rename folder ${esc(label)}"
                     title="Rename"><svg class="ico"><use href="#i-pencil"></use></svg></span>
                   <span class="chip-act" role="button" tabindex="0"
                     data-del="${esc(id)}" aria-label="Delete folder ${esc(label)}"
                     title="Delete"><svg class="ico"><use href="#i-x"></use></svg></span>` : ''}
            </button>`;

        el('folder-chips').innerHTML =
            chip(null, 'All', pool.length, false) +
            folders.map((f) => chip(f.id, f.name, folderCount(f.id), true)).join('') +
            (unfiled && folders.length ? chip(UNFILED, 'Unfiled', unfiled, false) : '');
    }

    el('folder-chips').addEventListener('click', (e) => {
        const rename = e.target.closest('[data-rename]');
        if (rename) { e.stopPropagation(); askRenameFolder(rename.dataset.rename); return; }
        const del = e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); askDeleteFolder(del.dataset.del); return; }
        const chip = e.target.closest('.chip');
        if (!chip) return;
        setActiveFolder(chip.dataset.folder || null);
    });

    function askRenameFolder(id) {
        const folder = folders.find((f) => f.id === id);
        if (!folder) return;
        openPrompt({
            title: 'Rename folder', label: 'Folder name', value: folder.name, max: 40,
            onSave(name) {
                if (folders.some((f) => f.id !== id &&
                        f.name.toLowerCase() === name.toLowerCase())) {
                    toast('You already have a folder with that name');
                    return false;          /* keep the dialog open */
                }
                folder.name = name;
                renderAll();
                commit();
                toast(`Renamed to “${name}”`);
            }
        });
    }

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
        if (item) item.folder = id;
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

    const findNote = (id) => notes.find((n) => n.id === id);

    /* Pinned notes are pulled into their own band above the rest, sorted
       by when you pinned them. In a masonry flow they would otherwise be
       scattered down the first column, which is the opposite of what
       pinning is for. */
    function splitNotes() {
        const visible = notes.filter(inActiveFolder).filter(matchesNote);
        const cmp = NOTE_SORTS[el('note-sort').value] || NOTE_SORTS.updated;
        const pinned = visible.filter((n) => n.pinned)
            .sort((a, b) => new Date(b.pinnedAt || b.updated || 0) - new Date(a.pinnedAt || a.updated || 0));
        const rest = visible.filter((n) => !n.pinned).sort(cmp);
        return { pinned, rest, total: visible.length };
    }

    /* ---- view: cards / compact / list ---------------------------------- */

    function setNoteView(view) {
        if (!VIEWS.includes(view) || view === noteView) return;
        noteView = view;
        try { localStorage.setItem(LS.noteView, view); } catch (e) {}
        renderNotes();
    }

    /* Both grids carry the view as a class, so the whole difference between
       compact and cards is CSS; only the list swaps the markup out. */
    function paintView() {
        document.querySelectorAll('#view-switch [data-view]').forEach((b) => {
            const on = b.dataset.view === noteView;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', String(on));
        });
        ['pinned-grid', 'note-grid'].forEach((id) => {
            el(id).className = `note-grid view-${noteView}`;
        });
    }

    el('view-switch').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (btn) setNoteView(btn.dataset.view);
    });

    function noteCard(n) {
        const derived = !((n.title || '').trim()) && derivedTitle(n);
        const body = isList(n) ? checklistMarkup(n) : `
            <textarea class="note-body" placeholder="Start typing…"
                      aria-label="Note body"></textarea>`;

        return `
            <article class="note${n.pinned ? ' is-pinned' : ''}${isList(n) ? ' is-list' : ''}"
                     data-id="${n.id}">
                <input class="note-title${derived ? ' is-derived' : ''}" type="text"
                       value="${esc(n.title || '')}"
                       placeholder="${esc(derived || 'Untitled')}"
                       maxlength="120" aria-label="Note title">
                <div class="note-bodywrap">
                    ${body}
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
            </article>`;
    }

    function checklistMarkup(n) {
        const items = n.items || [];
        const done = items.filter((i) => i.done).length;
        return `
            <div class="check-wrap">
                ${items.length ? `<div class="check-progress">${done} of ${items.length} done</div>` : ''}
                <ul class="check-list">
                    ${items.map((i) => `
                        <li class="check-item${i.done ? ' is-done' : ''}" data-item="${esc(i.id)}">
                            <button class="check-box" type="button" role="checkbox"
                                    aria-checked="${i.done}" aria-label="Toggle item">
                                <svg class="ico"><use href="#i-check"></use></svg>
                            </button>
                            <input class="check-text" type="text" value="${esc(i.text)}"
                                   placeholder="Item" aria-label="Item text">
                            <button class="check-del" type="button" aria-label="Remove item">
                                <svg class="ico"><use href="#i-x"></use></svg>
                            </button>
                        </li>`).join('')}
                </ul>
                <button class="check-add" type="button">
                    <svg class="ico"><use href="#i-plus"></use></svg> Add item
                </button>
            </div>`;
    }

    /* The list row: a title, a meta line, and no editor at all. There is no
       room in two lines for a textarea, so opening a row goes straight to
       the focus view — which is the better place to write anyway, and on a
       phone it is a full-screen sheet.

       The stamp keeps its own span rather than being baked into the meta
       string, because the minute tick rewrites that element's text and
       would otherwise wipe the line count and folder along with it. */
    function noteRow(n) {
        const bits = [];
        if (isList(n)) {
            const items = n.items || [];
            bits.push(`${items.filter((i) => i.done).length}/${items.length} done`);
        } else {
            const lines = lineCount(n.body);
            if (lines) bits.push(`${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`);
        }
        if (n.folder) bits.push(folderName(n.folder));

        return `
            <article class="note note-row${n.pinned ? ' is-pinned' : ''}" data-id="${n.id}">
                <button class="row-open" type="button" aria-label="Open ${esc(titleOf(n))}">
                    <span class="row-icon" aria-hidden="true">
                        <svg class="ico"><use href="#i-${isList(n) ? 'list' : 'note'}"></use></svg>
                    </span>
                    <span class="row-main">
                        <span class="row-title">${esc(titleOf(n))}</span>
                        <span class="row-meta"><span class="note-stamp">${esc(relTime(n.updated))}</span>${
                            bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</span>
                    </span>
                </button>
                <div class="row-acts">
                    <button class="note-act note-folder${n.folder ? ' is-set' : ''}" type="button"
                            title="${n.folder ? `In “${esc(folderName(n.folder))}” — move` : 'Move to a folder'}"
                            aria-label="Move to folder">
                        <svg class="ico"><use href="#i-folder"></use></svg>
                    </button>
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
            </article>`;
    }

    function renderNotes() {
        const { pinned, rest, total } = splitNotes();
        paintView();

        el('count-notes').textContent = query()
            ? `${total}` : `${notes.length}`;
        el('notes-empty').hidden = notes.length !== 0;
        el('note-none').hidden = !(total === 0 && notes.length > 0);

        el('pinned-wrap').hidden = pinned.length === 0;
        el('others-title').hidden = rest.length === 0;
        const shape = noteView === 'list' ? noteRow : noteCard;
        el('pinned-grid').innerHTML = pinned.map(shape).join('');
        el('note-grid').innerHTML = rest.map(shape).join('');

        if (noteView === 'list') return;   /* a row has no body to fill or size */

        /* Bodies are assigned, not interpolated into the markup. The HTML
           parser drops a leading newline inside <textarea>, so a note that
           opens with a blank line would lose it on every re-render — and
           this grid re-renders on pin, search, delete and sync. */
        document.querySelectorAll('.note').forEach((card) => {
            const n = findNote(card.dataset.id);
            if (!n) return;
            const ta = card.querySelector('.note-body');
            if (ta) ta.value = n.body || '';
            sizeCard(card);
        });
    }

    /* Grow a card to fit its content, but only up to the ceiling for the
       current view. Past that it clamps and grows an Expand control
       instead — one pasted file should not push every other note off the
       screen. A list row has neither body nor ceiling, so it exits here. */
    function sizeCard(card) {
        const n = findNote(card.dataset.id);
        if (!n || card.classList.contains('note-row')) return;
        const compact = noteView === 'compact';
        const limit = compact ? CFG.NOTE_COMPACT_PX : CFG.NOTE_COLLAPSE_PX;
        let clamped;

        if (isList(n)) {
            const wrap = card.querySelector('.check-wrap');
            wrap.style.maxHeight = 'none';
            clamped = wrap.scrollHeight > limit;
            wrap.style.maxHeight = clamped ? `${limit}px` : '';
        } else {
            const ta = card.querySelector('.note-body');
            ta.style.height = 'auto';
            const full = ta.scrollHeight;
            clamped = full > limit;
            /* An empty note still needs somewhere to click; the floor drops
               in compact, where a card of blank space defeats the point. */
            ta.style.height = `${clamped ? limit : Math.max(full, compact ? 52 : 96)}px`;
        }

        card.classList.toggle('is-clamped', clamped);
        if (clamped) {
            card.querySelector('.note-expand-label').textContent = isList(n)
                ? `Expand · ${(n.items || []).length} items`
                : `Expand · ${lineCount(n.body).toLocaleString()} lines`;
        }
    }

    /* The borrowed title has to follow what you type, but re-rendering the
       card on every keystroke would blow away the caret — so it, and the
       stamp, are patched in place instead. */
    function refreshDerived(note, card) {
        const input = card.querySelector('.note-title');
        if (input.value.trim()) { input.classList.remove('is-derived'); return; }
        const d = derivedTitle(note);
        input.placeholder = d || 'Untitled';
        input.classList.toggle('is-derived', Boolean(d));
    }

    function touchNote(note, card) {
        note.updated = new Date().toISOString();
        if (card) {
            card.querySelector('.note-stamp').textContent = relTime(note.updated);
            refreshDerived(note, card);
        }
        commit();
    }

    function newNote(kind) {
        const now = new Date().toISOString();
        const note = {
            id: uid(), kind, title: '', pinned: false, pinnedAt: null,
            folder: activeFolder && activeFolder !== UNFILED ? activeFolder : null,
            created: now, updated: now
        };
        if (kind === 'checklist') note.items = [{ id: uid(), text: '', done: false }];
        else note.body = '';

        notes.unshift(note);
        renderNotes();
        commit();

        /* A list row has nothing to type into, so a note made there opens
           in the focus view instead — otherwise "New note" would appear to
           do nothing but add an empty line. */
        if (noteView === 'list') { openFocus(note.id); return; }

        /* A brand new note is never pinned, so it is the first card in the
           unpinned grid — focus its title so you can just start typing. */
        const first = el('note-grid').querySelector('.note-title');
        if (first) first.focus();
    }

    el('new-note-btn').addEventListener('click', () => newNote('note'));
    el('new-list-btn').addEventListener('click', () => newNote('checklist'));
    document.querySelectorAll('[data-act="new-note"]').forEach((b) =>
        b.addEventListener('click', () => newNote('note')));

    /* One delegated listener per event type on the whole notes panel,
       rather than several per card — cards re-render often enough that
       per-card wiring would leak handlers. */
    el('panel-notes').addEventListener('input', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;
        const t = e.target;

        if (t.classList.contains('note-title')) {
            note.title = t.value;
            t.classList.toggle('is-derived', !t.value.trim());
        } else if (t.classList.contains('note-body')) {
            note.body = t.value;
            sizeCard(card);
        } else if (t.classList.contains('check-text')) {
            const item = (note.items || []).find((i) => i.id === t.closest('.check-item').dataset.item);
            if (item) item.text = t.value;
        } else return;

        touchNote(note, card);
    });

    el('panel-notes').addEventListener('click', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        if (e.target.closest('.check-box')) {
            const row = e.target.closest('.check-item');
            const item = (note.items || []).find((i) => i.id === row.dataset.item);
            if (item) {
                item.done = !item.done;
                touchNote(note, card);
                renderNotes();
            }
        } else if (e.target.closest('.check-del')) {
            const row = e.target.closest('.check-item');
            note.items = (note.items || []).filter((i) => i.id !== row.dataset.item);
            touchNote(note, card);
            renderNotes();
        } else if (e.target.closest('.check-add')) {
            addChecklistItem(note, card);
        } else if (e.target.closest('.note-folder')) {
            openFolderModal({ kind: 'note', id: note.id });
        } else if (e.target.closest('.note-expand') || e.target.closest('.row-open')) {
            openFocus(note.id);
        } else if (e.target.closest('.act-pin')) {
            note.pinned = !note.pinned;
            /* Pinning is not an edit, so it must not bump `updated` — that
               would make a note you merely pinned look freshly written and
               jump it up a recently-updated sort. */
            note.pinnedAt = note.pinned ? new Date().toISOString() : null;
            renderNotes();
            commit();
        } else if (e.target.closest('.act-del')) {
            trashItem('note', note);
        }
    });

    function addChecklistItem(note, card) {
        note.items = note.items || [];
        note.items.push({ id: uid(), text: '', done: false });
        touchNote(note, card);
        renderNotes();
        const live = document.querySelector(`.note[data-id="${note.id}"]`);
        const inputs = live ? live.querySelectorAll('.check-text') : [];
        if (inputs.length) inputs[inputs.length - 1].focus();
    }

    /* Enter at the end of a checklist row adds the next one, the way every
       list app behaves; without it you have to reach for the mouse on
       every single item. */
    el('panel-notes').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.classList.contains('check-text')) return;
        e.preventDefault();
        const card = e.target.closest('.note');
        const note = findNote(card.dataset.id);
        if (note) addChecklistItem(note, card);
    });

    /* ============================================================
       TRASH
       ============================================================ */

    function trashItem(kind, item) {
        const label = kind === 'note' ? titleOf(item) : item.name;
        if (kind === 'note') notes = notes.filter((n) => n.id !== item.id);
        else files = files.filter((f) => f.id !== item.id);

        trash.unshift({ kind, item, deletedAt: new Date().toISOString() });
        renderAll();
        commit();

        /* The blob stays in the gist while a file is only trashed — there
           would be nothing to restore otherwise. Emptying the trash is
           what actually deletes it. */
        toast(`${kind === 'note' ? 'Note' : 'File'} “${label}” moved to trash`, () => {
            restoreFromTrash(item.id);
        });
    }

    function restoreFromTrash(id) {
        const idx = trash.findIndex((t) => t.item.id === id);
        if (idx === -1) return;
        const [entry] = trash.splice(idx, 1);
        if (entry.kind === 'note') notes.unshift(entry.item);
        else files.unshift(entry.item);
        pruneFolder();
        renderAll();
        commit();
        toast('Restored');
    }

    function purgeForever(entry) {
        trash = trash.filter((t) => t.item.id !== entry.item.id);
        if (entry.kind === 'file') Store.dropBlob(entry.item.id);
    }

    /* Anything sitting in the trash past TRASH_DAYS goes on the next load.
       Files take their gist blob with them, which is the only point at
       which storage is actually reclaimed. */
    function purgeTrash() {
        const cutoff = Date.now() - CFG.TRASH_DAYS * 86400000;
        const stale = trash.filter((t) => new Date(t.deletedAt || 0).getTime() < cutoff);
        if (!stale.length) return;
        stale.forEach(purgeForever);
        cache();
    }

    function renderTrash() {
        el('count-trash').textContent = trash.length;
        el('tab-trash').hidden = trash.length === 0;
        if (!trash.length && activeTab() === 'trash') showTab('notes');

        el('trash-lede').textContent = trash.length
            ? `Deleted items are kept for ${CFG.TRASH_DAYS} days, then removed.`
            : 'Nothing in the trash.';

        el('trash-list').innerHTML = trash.map((t) => `
            <li class="file" data-id="${esc(t.item.id)}">
                <span class="file-icon" aria-hidden="true">
                    <svg class="ico"><use href="#i-${t.kind === 'note' ? 'note' : 'file'}"></use></svg>
                </span>
                <div class="file-main">
                    <span class="file-name">${esc(t.kind === 'note' ? titleOf(t.item) : t.item.name)}</span>
                    <span class="file-meta">${t.kind} · deleted ${esc(relTime(t.deletedAt))}</span>
                </div>
                <div class="file-acts">
                    <button class="note-act act-restore" type="button" title="Restore"
                            aria-label="Restore"><svg class="ico"><use href="#i-undo"></use></svg></button>
                    <button class="note-act act-purge" type="button" title="Delete forever"
                            aria-label="Delete forever"><svg class="ico"><use href="#i-trash"></use></svg></button>
                </div>
            </li>`).join('');
    }

    el('trash-list').addEventListener('click', (e) => {
        const row = e.target.closest('.file');
        if (!row) return;
        const entry = trash.find((t) => t.item.id === row.dataset.id);
        if (!entry) return;

        if (e.target.closest('.act-restore')) restoreFromTrash(entry.item.id);
        else if (e.target.closest('.act-purge')) {
            const label = entry.kind === 'note' ? titleOf(entry.item) : entry.item.name;
            confirmAction('Delete forever?', `“${label}” cannot be recovered after this.`, () => {
                purgeForever(entry);
                renderAll();
                commit();
                toast('Deleted forever');
            });
        }
    });

    el('empty-trash-btn').addEventListener('click', () => {
        if (!trash.length) return;
        confirmAction('Empty the trash?',
            `${trash.length} item${trash.length === 1 ? '' : 's'} will be gone for good.`, () => {
                trash.slice().forEach(purgeForever);
                renderAll();
                commit();
                toast('Trash emptied');
            });
    });

    /* ============================================================
       FOCUS VIEW
       ============================================================ */

    function openFocus(id) {
        const note = findNote(id);
        if (!note) return;
        focusId = id;
        el('focus-title').value = note.title || '';
        el('focus-title').placeholder = derivedTitle(note) || 'Untitled';

        const list = isList(note);
        el('focus-body').hidden = list;
        el('focus-items').hidden = !list;
        if (list) renderFocusItems(note);
        else el('focus-body').value = note.body || '';

        updateFocusMeta();
        el('focus-modal').hidden = false;
        document.body.classList.add('is-locked');
        if (!list) {
            el('focus-body').focus();
            el('focus-body').setSelectionRange(0, 0);
            el('focus-body').scrollTop = 0;
        }
    }

    function renderFocusItems(note) {
        el('focus-items').innerHTML = checklistMarkup(note);
    }

    function closeFocus() {
        el('focus-modal').hidden = true;
        document.body.classList.remove('is-locked');
        focusId = null;
        renderNotes();
    }

    function updateFocusMeta() {
        const note = findNote(focusId);
        if (!note) return;
        if (isList(note)) {
            const items = note.items || [];
            el('focus-meta').textContent =
                `${items.filter((i) => i.done).length} of ${items.length} done`;
        } else {
            const body = el('focus-body').value;
            const words = body.trim() ? body.trim().split(/\s+/).length : 0;
            el('focus-meta').textContent =
                `${lineCount(body).toLocaleString()} lines · ${words.toLocaleString()} words`;
        }
    }

    ['focus-title', 'focus-body'].forEach((id) => {
        el(id).addEventListener('input', () => {
            const note = findNote(focusId);
            if (!note) return;
            note.title = el('focus-title').value;
            if (!isList(note)) note.body = el('focus-body').value;
            note.updated = new Date().toISOString();
            updateFocusMeta();
            commit();
        });
    });

    /* The checklist inside the focus view is the same markup as on a card,
       so it needs the same handlers — scoped here rather than shared,
       because this copy re-renders on its own schedule. */
    el('focus-items').addEventListener('input', (e) => {
        const note = findNote(focusId);
        if (!note || !e.target.classList.contains('check-text')) return;
        const item = (note.items || []).find((i) => i.id === e.target.closest('.check-item').dataset.item);
        if (item) item.text = e.target.value;
        note.updated = new Date().toISOString();
        commit();
    });

    el('focus-items').addEventListener('click', (e) => {
        const note = findNote(focusId);
        if (!note) return;
        const row = e.target.closest('.check-item');

        if (e.target.closest('.check-box') && row) {
            const item = (note.items || []).find((i) => i.id === row.dataset.item);
            if (item) item.done = !item.done;
        } else if (e.target.closest('.check-del') && row) {
            note.items = (note.items || []).filter((i) => i.id !== row.dataset.item);
        } else if (e.target.closest('.check-add')) {
            note.items = note.items || [];
            note.items.push({ id: uid(), text: '', done: false });
        } else return;

        note.updated = new Date().toISOString();
        renderFocusItems(note);
        updateFocusMeta();
        commit();
        const inputs = el('focus-items').querySelectorAll('.check-text');
        if (e.target.closest('.check-add') && inputs.length) inputs[inputs.length - 1].focus();
    });

    el('focus-items').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.classList.contains('check-text')) return;
        e.preventDefault();
        const note = findNote(focusId);
        if (!note) return;
        note.items.push({ id: uid(), text: '', done: false });
        renderFocusItems(note);
        commit();
        const inputs = el('focus-items').querySelectorAll('.check-text');
        if (inputs.length) inputs[inputs.length - 1].focus();
    });

    el('focus-close').addEventListener('click', closeFocus);
    el('focus-done').addEventListener('click', closeFocus);
    el('focus-modal').addEventListener('click', (e) => {
        if (e.target === el('focus-modal')) closeFocus();
    });

    el('focus-copy').addEventListener('click', async () => {
        const note = findNote(focusId);
        if (!note) return;
        try {
            await navigator.clipboard.writeText(plainText(note));
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
        renderAll();
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

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        /* Revoking immediately can beat the download on some browsers. */
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function renderFiles() {
        const shown = files.filter(inActiveFolder).filter(matchesFile)
            .sort(FILE_SORTS[el('file-sort').value] || FILE_SORTS.added);

        el('count-files').textContent = query() ? `${shown.length}` : `${files.length}`;
        el('file-none').hidden = !(shown.length === 0 && files.length > 0);

        el('file-list').innerHTML = shown.map((f) => `
            <li class="file" data-id="${f.id}">
                <span class="file-icon" aria-hidden="true">
                    <svg class="ico"><use href="#i-file"></use></svg>
                </span>
                <div class="file-main">
                    <button class="file-name act-rename" type="button" title="Rename ${esc(f.name)}">${esc(f.name)}</button>
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
        if (e.target.closest('.act-rename')) {
            openPrompt({
                title: 'Rename file', label: 'File name', value: meta.name, max: 200,
                onSave(name) {
                    meta.name = name;
                    renderFiles();
                    commit();
                    toast(`Renamed to “${name}”`);
                }
            });
            return;
        }
        if (e.target.closest('.act-del')) { trashItem('file', meta); return; }

        const btn = e.target.closest('.note-act');
        if (!btn) return;

        /* Bytes are pulled on demand, so both of these are async and can
           take a moment on a large file. */
        btn.classList.add('is-working');
        try {
            const payload = await Store.getBlob(meta.id);
            if (!payload) { toast('That file has no contents in the gist yet'); return; }

            if (btn.classList.contains('act-get')) {
                saveBlob(base64ToBlob(payload, meta.type), meta.name);
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

    /* ============================================================
       EXPORT / IMPORT
       ============================================================ */

    const stamp = () => new Date().toISOString().slice(0, 10);

    function plainText(n) {
        if (!isList(n)) return n.body || '';
        return (n.items || []).map((i) => `[${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
    }

    el('export-json-btn').addEventListener('click', () => {
        const doc = { notes, files, folders, trash, version: 4, exported: new Date().toISOString() };
        saveBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
                 `docket-${stamp()}.json`);
        toast('Backup downloaded');
    });

    /* The .txt is for reading, not for restoring — so it is laid out for a
       human, and it says so at the top rather than pretending otherwise. */
    el('export-txt-btn').addEventListener('click', () => {
        const rule = '='.repeat(60);
        const out = [
            'DOCKET SHARING', `exported ${new Date().toLocaleString()}`,
            `${notes.length} notes, ${files.length} files`,
            'This file is for reading. Use the .json export to restore.', ''
        ];
        notes.slice()
            .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || NOTE_SORTS.updated(a, b))
            .forEach((n) => {
                out.push(rule);
                out.push(titleOf(n) + (n.pinned ? '   [pinned]' : ''));
                const bits = [];
                if (n.folder) bits.push(`folder: ${folderName(n.folder)}`);
                if (isList(n)) bits.push('checklist');
                bits.push(`updated ${new Date(n.updated || Date.now()).toLocaleString()}`);
                out.push(bits.join('   ·   '));
                out.push('-'.repeat(60));
                out.push(plainText(n));
                out.push('');
            });
        if (files.length) {
            out.push(rule, 'FILES', '-'.repeat(60));
            files.forEach((f) => out.push(
                `${f.name}   ${formatBytes(f.size)}${f.folder ? `   [${folderName(f.folder)}]` : ''}`));
        }
        saveBlob(new Blob([out.join('\n')], { type: 'text/plain' }), `docket-${stamp()}.txt`);
        toast('Text export downloaded');
    });

    el('import-btn').addEventListener('click', () => el('import-input').click());

    el('import-input').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;

        let doc;
        try {
            doc = JSON.parse(await file.text());
        } catch (err) { toast('That file is not valid JSON'); return; }
        if (!doc || !Array.isArray(doc.notes)) { toast('That does not look like a Docket backup'); return; }

        el('settings-modal').hidden = true;
        confirmAction('Import this backup?',
            `It holds ${doc.notes.length} notes and ${(doc.files || []).length} files, and will replace what is here now. ` +
            'Your file uploads stay in the gist either way.',
            () => {
                notes = doc.notes;
                files = Array.isArray(doc.files) ? doc.files : [];
                folders = Array.isArray(doc.folders) ? doc.folders : [];
                trash = Array.isArray(doc.trash) ? doc.trash : [];
                pruneFolder();
                renderAll();
                commit();
                toast(`Imported ${notes.length} notes`);
            });
    });

    /* ============================================================
       VERSION HISTORY
       ============================================================ */

    el('history-btn').addEventListener('click', async () => {
        if (!Store.isConnected()) { toast('Connect a gist first — history lives in it'); return; }
        el('settings-modal').hidden = true;
        el('history-list').innerHTML = '<li class="hint">Loading…</li>';
        el('history-modal').hidden = false;

        /* history() is filled by the last load, so refresh it first —
           otherwise this shows the list as it was when you unlocked. */
        await pullFromGist();
        const revs = Store.history();

        el('history-list').innerHTML = revs.length ? revs.map((r, i) => `
            <li class="history-row" data-sha="${esc(r.sha)}">
                <div class="history-main">
                    <span class="history-when">${esc(new Date(r.at).toLocaleString())}</span>
                    <span class="history-delta">${i === 0 ? 'current' :
                        `+${r.added || 0} / −${r.removed || 0} lines`}</span>
                </div>
                ${i === 0 ? '' : '<button class="btn btn-ghost btn-sm act-restore" type="button">Restore</button>'}
            </li>`).join('')
            : '<li class="hint">No revisions yet — save something first.</li>';
    });

    el('history-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('.act-restore');
        if (!btn) return;
        const sha = btn.closest('.history-row').dataset.sha;
        const when = btn.closest('.history-row').querySelector('.history-when').textContent;

        btn.disabled = true;
        let snapshot;
        try {
            snapshot = await Store.atVersion(sha);
        } catch (err) {
            toast(err.message || 'Could not read that revision');
            btn.disabled = false;
            return;
        }
        btn.disabled = false;

        el('history-modal').hidden = true;
        confirmAction('Restore this version?',
            `The docket will go back to ${when} — ${snapshot.notes.length} notes and ` +
            `${snapshot.files.length} files. The current state stays in the history, so this is undoable.`,
            () => {
                notes = snapshot.notes;
                files = snapshot.files;
                folders = snapshot.folders;
                trash = snapshot.trash;
                pruneFolder();
                renderAll();
                commit();
                toast(`Restored the version from ${when}`);
            });
    });

    el('history-close').addEventListener('click', () => { el('history-modal').hidden = true; });
    el('history-modal').addEventListener('click', (e) => {
        if (e.target === el('history-modal')) el('history-modal').hidden = true;
    });

    /* ============================================================
       PROMPT + CONFIRM MODALS
       ============================================================ */

    let promptSave = null;

    /** A single-field dialog. onSave may return false to keep it open —
     *  that is how a duplicate folder name reports itself without losing
     *  what was typed. */
    function openPrompt({ title, label, value, max, onSave }) {
        el('prompt-title').textContent = title;
        el('prompt-label').textContent = label;
        el('prompt-input').value = value || '';
        el('prompt-input').maxLength = max || 200;
        promptSave = onSave;
        el('prompt-modal').hidden = false;
        el('prompt-input').focus();
        el('prompt-input').select();
    }

    function submitPrompt() {
        const value = el('prompt-input').value.trim();
        if (!value) { el('prompt-input').focus(); return; }
        if (promptSave && promptSave(value) === false) return;
        closePrompt();
    }
    function closePrompt() {
        el('prompt-modal').hidden = true;
        promptSave = null;
    }

    el('prompt-ok').addEventListener('click', submitPrompt);
    el('prompt-cancel').addEventListener('click', closePrompt);
    el('prompt-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
    });
    el('prompt-modal').addEventListener('click', (e) => {
        if (e.target === el('prompt-modal')) closePrompt();
    });

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
        else if (!el('prompt-modal').hidden) closePrompt();
        else if (!el('folder-modal').hidden) closeFolderModal();
        else if (!el('history-modal').hidden) el('history-modal').hidden = true;
        else if (!el('settings-modal').hidden) el('settings-modal').hidden = true;
        else if (!el('focus-modal').hidden) closeFocus();
    });

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
        renderTrash();
        reflectConnection();
    }

    /* Relative stamps go stale on a tab left open all day. Cheap enough
       on a minute tick, but only when nothing in the grid has focus —
       otherwise it would fight the caret. */
    setInterval(() => {
        if (!unlocked) return;
        if (el('panel-notes').contains(document.activeElement)) return;
        document.querySelectorAll('.note').forEach((card) => {
            const note = findNote(card.dataset.id);
            const stamp = card.querySelector('.note-stamp');
            if (note && stamp) stamp.textContent = relTime(note.updated);
        });
    }, 60000);

    /* Re-clamp on resize: a card that fits at desktop width may overflow
       once the masonry drops to one column. */
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!unlocked) return;
            document.querySelectorAll('.note').forEach(sizeCard);
        }, 150);
    });
})();
