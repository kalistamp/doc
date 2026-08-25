/* ============================================================
   DOCKET SHARING — app

   State is four collections stored in the `doc` Supabase schema:
     notes    [{ id, kind, title, body|items, pinned, pinnedAt,
                 finishNext, finishNextAt, folder, created, updated }]
     files    [{ id, name, size, type, folder, added }]   ← metadata only
     folders  [{ id, name, created }]
     trash    [{ kind, item, deletedAt }]

   A note is either kind 'note' (a `body` string) or kind 'checklist'
   (an `items` array). Anything without a kind is a plain note, which is
   what every note written before checklists existed looks like.

   `pinned` and `finishNext` are two independent bands above the board:
   Finish Next is what you mean to get done, Pinned is what you want
   kept in reach. Neither implies the other, and a note wearing both is
   drawn once, in the higher band — one card per note is what every
   `data-id` lookup on the board assumes.

   Both are stamped, `pinnedAt` and `finishNextAt`, dating the last
   change to the flag in either direction. They are the two changes that
   deliberately do not bump `updated` — neither is an edit, and a note
   you merely flagged should not jump up a recently-updated sort. But
   `updated` is what every merge compares, so without a clock of its own
   a flag is invisible to the other device's reconcile. The stamps are
   also what order each band.

   A folder is only a label: `folder` holds its id, so deleting a folder
   never deletes what was in it.

   All four are cached in localStorage for fast startup. File bytes live
   separately in Supabase and are fetched only when downloaded.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const Store = window.DocketStore;

    const $ = (sel) => document.querySelector(sel);
    const el = (id) => document.getElementById(id);

    /** Dismiss a modal by clicking its backdrop — the overlay element
     *  itself, never the card sitting on it.
     *
     *  Testing that with `e.target === overlay` alone is the trap. The
     *  target of a `click` is the nearest common ancestor of where the
     *  button went down and where it came up, so a press that starts on
     *  the card and is released past its edge lands on the overlay and
     *  is indistinguishable from a click on the overlay. Dragging past
     *  the edge is exactly what selecting to the end of a line looks
     *  like, so the focus view dismissed itself while its text was being
     *  selected to copy — and took the selection with it.
     *
     *  Where the press *started* is what says a dismiss was meant; the
     *  release only says where the mouse happened to stop. */
    const dismissOnBackdrop = (id, close) => {
        const modal = el(id);
        let pressedBackdrop = false;
        modal.addEventListener('mousedown', (e) => {
            pressedBackdrop = e.target === modal;
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal && pressedBackdrop) close();
        });
    };

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

    /* ---- Markdown ------------------------------------------------------

       A note holding Markdown is shown rendered rather than as the source
       you typed, because reading `## Heading` is not what writing it was
       for. Which notes those are is decided by looking at them —
       markdown.js scores the usual syntax — and `markdown` on the note is
       the override for when that reads wrong.

       That field is deliberately three-valued: `true` and `false` are
       answers you gave, and absent is "nobody has said", which is what
       every note written before this existed says. Two values could not
       tell "show this as plain text" apart from "never asked".

       Detection and rendering both walk the whole body, and renderNotes
       runs on every pin, search, delete and background sync. One memo per
       note, discarded the moment that note's text changes, is what keeps a
       board of a hundred Markdown notes from re-parsing all of them
       because a keystroke landed in one. */

    const MD = window.DocketMarkdown;
    const mdMemo = new Map();

    function markdownMemo(n) {
        const id = String(n.id);
        const body = n.body || '';
        let entry = mdMemo.get(id);
        if (!entry || entry.body !== body) {
            entry = { body, looks: null, html: null };
            mdMemo.set(id, entry);
        }
        return entry;
    }

    /** Is this note drawn as Markdown right now? */
    function showsMarkdown(n) {
        if (!n || isList(n)) return false;
        if (typeof n.markdown === 'boolean') return n.markdown;
        const entry = markdownMemo(n);
        if (entry.looks === null) entry.looks = MD.looksLikeMarkdown(entry.body);
        return entry.looks;
    }

    const markdownHtml = (n) => {
        const entry = markdownMemo(n);
        if (entry.html === null) entry.html = MD.render(entry.body);
        return entry.html;
    };

    /* An id never comes back, so a memo for a note that has been deleted or
       merged away is dead weight. Swept on the render that notices, rather
       than on every one — the sweep is the expensive half. */
    function pruneMarkdownMemo() {
        if (mdMemo.size <= notes.length + 16) return;
        const live = new Set(notes.map((n) => String(n.id)));
        mdMemo.forEach((_, id) => { if (!live.has(id)) mdMemo.delete(id); });
    }

    /* Which way a note is drawn is a view choice, not an edit, so this
       takes the shape the pin takes: `updated` is left alone, because a
       note you merely switched must not jump up a recently-updated sort,
       and a stamp of its own is written instead — `updated` is what every
       merge compares, so without one the switch would be invisible to the
       other device and thrown away. Written in both directions, for the
       reason the pin's is. */
    function setMarkdown(note, on) {
        note.markdown = on;
        note.markdownAt = new Date().toISOString();
        renderNotes();
        commit();
    }

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
        } catch (e) { /* quota or private mode — Supabase is the real home */ }
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
            /* Storing the resolved name back retires a legacy preference,
               so the migration only has to happen once per device. */
            localStorage.setItem(LS.noteView,
                applyNoteView(localStorage.getItem(LS.noteView) || 'medium'));
        } catch (e) {}
    }

    /* Structural mutations checkpoint the cold archive. Note keystrokes use
       durableNote instead, so their save clock only writes one hot file. */
    function commit() {
        cache();
        Store.touchData();
    }

    function durableNote(note) {
        cache();
        Store.touchNote(note.id);
    }

    /* ============================================================
       SUPABASE SIGN-IN
       ============================================================ */

    async function openDocket() {
        if (unlocked) return;
        el('gate').classList.add('is-gone');
        el('app').hidden = false;
        unlocked = true;

        Store.bind(() => ({
            notes, files, folders, trash,
            version: 4, updated: new Date().toISOString()
        }), adoptRemote);

        readCache();
        purgeTrash();
        renderAll();
        lastPull = Date.now();
        await pullFromCloud();
        reflectConnection();
    }

    el('gate-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const card = $('.gate-card');
        const msg = el('gate-msg');
        const button = el('gate-btn');
        msg.textContent = '';
        button.disabled = true;
        button.textContent = 'Signing in…';
        const result = await Store.signIn(
            el('email-input').value.trim(), el('password-input').value
        );
        if (!result.ok) {
            msg.className = 'gate-msg';
            msg.textContent = result.error;
            card.classList.remove('is-wrong');
            void card.offsetWidth;
            card.classList.add('is-wrong');
            el('password-input').select();
            button.disabled = false;
            button.textContent = 'Sign in';
            return;
        }
        el('password-input').value = '';
        await openDocket();
    });

    el('lock-btn').addEventListener('click', async () => {
        Store.checkpoint();
        if (Store.hasPending()) await Store.flush();
        await Store.signOut();
        [LS.notes, LS.files, LS.folders, LS.trash].forEach((key) => {
            try { localStorage.removeItem(key); } catch (e) {}
        });
        location.reload();
    });

    Store.getSession().then((session) => {
        if (session) openDocket();
    }).catch((error) => {
        el('gate-msg').textContent = error.message;
    });

    /**
     * Pull Supabase and reconcile it with what is here.
     *
     * This used to replace local state outright, on the grounds that
     * replacing is how a delete made on another machine lands. It is also
     * how a second browser silently bins whatever this one has not pushed
     * yet — and with a background refresh running, that would include the
     * note you are typing into. Deletes now travel as `trash` tombstones,
     * so a merge propagates them just as faithfully and keeps the rest.
     */
    async function pullFromCloud() {
        try {
            const data = await Store.load();
            if (!data) return;              /* not connected */
            adoptRemote(Store.merge(data, { notes, files, folders, trash }));
            purgeTrash();
            /* Any hot file recovered above is now represented in `notes`.
               Fold the ones that are ours to fold and delete them. */
            Store.foldLoadedHot();
        } catch (err) { /* onStatus already surfaced it */ }
    }

    /* Set while a merge lands under a caret. Re-rendering the board rips
       out the textarea being typed into, so the render waits for the edit
       to end; the data itself is installed immediately either way. */
    let deferredRender = false;

    const isEditing = () => {
        const active = document.activeElement;
        return Boolean(active && active.closest && active.closest('.note')) ||
               !el('focus-modal').hidden;
    };

    /* Most merges change nothing — the poll exists to notice the ones that
       do. Comparing what the board actually draws is what keeps a quiet
       45-second tick from re-rendering the grid, and a re-render costs a
       caret, a text selection and a scroll position. Bodies are left out:
       every edit to one bumps `updated`, and hashing a thousand-line note
       on a timer to learn what its timestamp already says is waste.
       `pinned`, `finishNext` and `markdown` are in, because none of the
       three deliberately bumps it. */
    const fingerprint = () => [notes, files, folders, trash].map((list) =>
        (list || []).map((row) => {
            const item = row.item || row;
            return [item.id, item.updated || item.added || item.created || '',
                    row.deletedAt || '', row.purged ? 1 : 0,
                    item.pinned ? 1 : 0, item.finishNext ? 1 : 0,
                    String(item.markdown)].join('~');
        }).join(',')).join('|');

    /**
     * Install a reconciled docket. Called both by an explicit pull and by
     * the store, which reconciles on its own before any write that would
     * otherwise overwrite another browser's copy.
     */
    function adoptRemote(merged) {
        const before = fingerprint();
        notes = merged.notes;
        files = merged.files;
        folders = merged.folders;
        trash = merged.trash;
        pruneFolder();
        cache();
        if (fingerprint() === before) return;
        if (isEditing()) { deferredRender = true; return; }
        deferredRender = false;
        renderAll();
    }

    /* The counterpart: once the caret leaves, show what arrived while it
       was busy. Cheap to call on every blur — it does nothing unless a
       merge actually landed. */
    function flushDeferredRender() {
        if (!deferredRender || isEditing()) return;
        deferredRender = false;
        renderAll();
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
        Store.checkpoint();
        if (Store.hasPending()) await Store.flush();
        await refresh(true);
    });

    function reflectConnection() {
        const on = Store.isConnected();
        el('connect-card').hidden = on;
        el('dropzone-hint').textContent = on
            ? `Up to ${formatBytes(CFG.MAX_FILE_BYTES)} each · ${CFG.MAX_FILES} files`
            : 'Sign in to store files';
        el('dropzone').classList.toggle('is-disabled', !on);
        if (!on) el('foot-stamp').textContent = 'not connected';
    }

    /* Last line of defence against closing the tab on an unsaved edit.
       Deliberately does NOT checkpoint: a checkpoint rewrites the whole
       archive, an unloading page has no time for the read that would make
       that safe, and the note being typed is already durable in its own
       hot file. The next load recovers it from there. */
    window.addEventListener('beforeunload', (e) => {
        if (unlocked) {
            /* keepalive gives supporting browsers a chance to finish the
               write while the page is unloading; unguarded says to skip
               the round trip that page will not survive. */
            Store.flush({ keepalive: true, unguarded: true });
        }
        if (unlocked && Store.hasPending()) { e.preventDefault(); e.returnValue = ''; }
    });

    /* Switching browser tabs is also an editing boundary. Unlike unload,
       visibility changes leave enough time for the queued checkpoint to
       complete normally — and to be reconciled first. */
    document.addEventListener('visibilitychange', () => {
        if (!unlocked) return;
        if (document.visibilityState === 'hidden') {
            Store.checkpoint();
            if (Store.hasPending()) Store.flush();
            return;
        }
        /* Coming back is the other half, and the half that was missing:
           a tab that has sat in the background is holding a docket that
           may be many writes out of date, and the first thing it did on
           return was push that staleness back up. */
        refresh(true);
    });

    window.addEventListener('focus', () => refresh());

    /* Two browsers side by side on one screen are never hidden and never
       blurred, so neither of the above ever fires. A quiet poll is what
       makes them converge; unchanged costs a 304 with no body. */
    setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
    }, CFG.POLL_MS);

    let lastPull = 0;
    let pulling = null;

    /** Re-read Supabase, at most once per POLL_MS unless forced. Returns
     *  the in-flight pull if one is already running, so a burst of focus
     *  and visibility events makes one request between them. */
    function refresh(force) {
        if (!unlocked || !Store.isConnected()) return Promise.resolve();
        if (pulling) return pulling;
        if (!force && Date.now() - lastPull < CFG.POLL_MS) return Promise.resolve();
        lastPull = Date.now();
        pulling = pullFromCloud().finally(() => { pulling = null; });
        return pulling;
    }

    /* ============================================================
       TABS
       ============================================================ */

    const activeTab = () => document.querySelector('.tab.is-active').dataset.tab;

    function showTab(name) {
        Store.checkpoint();
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
        if (merging && name !== 'notes') setMerging(false);
        renderFolders();
        applyFilters();
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
        return !q || String(f.name || '').toLowerCase().includes(q);
    };

    function applyFilters() {
        applyNoteFilters();
        applyFileFilters();
    }

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

    el('search').addEventListener('input', () => {
        renderFolders();
        applyFilters();
    });

    el('note-sort').addEventListener('change', () => {
        try { localStorage.setItem(LS.noteSort, el('note-sort').value); } catch (e) {}
        renderNotes();
    });
    el('note-view').addEventListener('change', () => {
        const view = applyNoteView(el('note-view').value);
        try { localStorage.setItem(LS.noteView, view); } catch (e) {}
        renderNotes();
    });
    el('file-sort').addEventListener('change', () => {
        try { localStorage.setItem(LS.fileSort, el('file-sort').value); } catch (e) {}
        renderFiles();
    });

    /* The view menu mirrors a file explorer's: four card sizes and a
       titles-only list. LEGACY_NOTE_VIEWS carries a device that stored the
       old "compact" preference across to its nearest equivalent, rather
       than silently dropping it back to medium. */
    const NOTE_VIEWS = ['xlarge', 'large', 'medium', 'small', 'list'];
    const LEGACY_NOTE_VIEWS = { compact: 'small' };

    function applyNoteView(value) {
        const named = LEGACY_NOTE_VIEWS[value] || value;
        const view = NOTE_VIEWS.includes(named) ? named : 'medium';
        el('note-view').value = view;
        el('panel-notes').dataset.noteView = view;
        return view;
    }

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
        applyFilters();
    }

    /* Counts follow the tab you are on: "Work 3" means three notes while
       you are reading notes, three files while you are reading files. */
    function folderCount(id) {
        const pool = activeTab() === 'files' ? files : notes;
        const matches = activeTab() === 'files' ? matchesFile : matchesNote;
        return pool.filter(matches)
            .filter((i) => (id === UNFILED ? !i.folder : i.folder === id)).length;
    }

    function renderFolders() {
        const matches = activeTab() === 'files' ? matchesFile : matchesNote;
        const pool = (activeTab() === 'files' ? files : notes).filter(matches);
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
                /* Merges resolve by timestamp, so anything that changes an
                   item has to leave one behind or the other browser's older
                   copy wins the reconcile and undoes it. */
                folder.updated = new Date().toISOString();
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
        if (item) {
            item.folder = id;
            item.updated = new Date().toISOString();
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
    dismissOnBackdrop('folder-modal', closeFolderModal);

    /* ============================================================
       NOTES
       ============================================================ */

    const findNote = (id) => notes.find((n) => String(n.id) === String(id));

    /* Flagged notes are pulled into their own bands above the rest, each
       sorted by when you flagged them. In a masonry flow they would
       otherwise be scattered down the first column, which is the opposite
       of what flagging them is for.

       The two flags are independent, but the bands cannot be: a note drawn
       twice would be two cards answering to one `data-id`, and every
       lookup on the board — the filter pass, the minute tick, sizeCard —
       reads the first it finds and silently leaves the other stale. So a
       note wearing both is drawn once, in the higher band, and keeps both
       flags in the data and both controls lit in its footer. */
    function splitNotes() {
        const cmp = NOTE_SORTS[el('note-sort').value] || NOTE_SORTS.updated;
        const byStamp = (key) => (a, b) =>
            new Date(b[key] || b.updated || 0) - new Date(a[key] || a.updated || 0);
        const finish = notes.filter((n) => n.finishNext).sort(byStamp('finishNextAt'));
        const pinned = notes.filter((n) => n.pinned && !n.finishNext).sort(byStamp('pinnedAt'));
        const rest = notes.filter((n) => !n.pinned && !n.finishNext).sort(cmp);
        return { finish, pinned, rest };
    }

    function noteCard(n) {
        const derived = !((n.title || '').trim()) && derivedTitle(n);
        const markdown = showsMarkdown(n);
        /* A rendered note is read, not typed into — there is no caret to
           put in a <div>. The card is still where the note lives, so a
           click on it opens the focus view, which is where the toggle back
           to plain text and the writing surface both are. */
        const body = isList(n) ? checklistMarkup(n) : markdown
            ? `<div class="note-md md-body">${markdownHtml(n)}</div>`
            : `
            <textarea class="note-body" placeholder="Start typing…"
                      aria-label="Note body"></textarea>`;

        return `
            <article class="note${n.pinned ? ' is-pinned' : ''}${isList(n) ? ' is-list' : ''}"
                     data-id="${esc(n.id)}">
                <button class="note-pick" type="button" aria-pressed="false"
                        aria-label="Pick note for merge">
                    <span class="note-pick-num" aria-hidden="true"></span>
                </button>
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
                    ${isList(n) ? '' : `<button class="note-act act-md${markdown ? ' is-on' : ''}" type="button"
                            title="${markdown ? 'Show as plain text' : 'Preview as Markdown'}"
                            aria-pressed="${markdown ? 'true' : 'false'}"
                            aria-label="${markdown ? 'Show this note as plain text' : 'Preview this note as Markdown'}">
                        <svg class="ico"><use href="#i-markdown"></use></svg>
                    </button>`}
                    <button class="note-act act-finish${n.finishNext ? ' is-on' : ''}" type="button"
                            title="${n.finishNext ? 'Remove from Finish Next' : 'Finish next'}"
                            aria-pressed="${n.finishNext ? 'true' : 'false'}"
                            aria-label="${n.finishNext ? 'Remove note from Finish Next' : 'Mark note to finish next'}">
                        <svg class="ico"><use href="#i-flag"></use></svg>
                    </button>
                    <button class="note-act act-pin${n.pinned ? ' is-on' : ''}" type="button"
                            title="${n.pinned ? 'Unpin' : 'Pin to top'}"
                            aria-pressed="${n.pinned ? 'true' : 'false'}"
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

    function renderNotes() {
        const { finish, pinned, rest } = splitNotes();

        pruneMarkdownMemo();
        el('notes-empty').hidden = notes.length !== 0;
        el('finish-grid').innerHTML = finish.map(noteCard).join('');
        el('pinned-grid').innerHTML = pinned.map(noteCard).join('');
        el('note-grid').innerHTML = rest.map(noteCard).join('');

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
        applyNoteFilters();
        applyPicks();
    }

    /* Search and folder selection only change visibility. Cards remain the
       same DOM nodes, preserving carets and avoiding sizeCard/layout reads
       on the app's highest-frequency path. */
    function applyNoteFilters() {
        let total = 0, finish = 0, pinned = 0, rest = 0;
        document.querySelectorAll('.note').forEach((card) => {
            const note = findNote(card.dataset.id);
            const shown = Boolean(note && inActiveFolder(note) && matchesNote(note));
            card.classList.toggle('is-filtered', !shown);
            if (shown) {
                total++;
                /* Which band this card is actually in, not which flags it
                   wears: a note in both bands is drawn in the higher one,
                   and counting it twice would leave the lower band titled
                   over nothing. */
                if (note.finishNext) finish++;
                else if (note.pinned) pinned++;
                else rest++;
            }
        });
        el('count-notes').textContent = String(total);
        el('finish-wrap').hidden = finish === 0;
        el('pinned-wrap').hidden = pinned === 0;
        /* "Everything else" only means anything with a band above it. */
        el('others-title').hidden = rest === 0 || (finish === 0 && pinned === 0);
        el('note-none').hidden = !(total === 0 && notes.length > 0);
    }

    /* Grow a card to fit its content, but only up to NOTE_COLLAPSE_PX.
       Past that it clamps and grows an Expand control instead — one
       pasted file should not push every other note off the screen. */
    function sizeCard(card) {
        const n = findNote(card.dataset.id);
        if (!n) return;
        const view = el('note-view').value || 'medium';

        /* List view hides the body, so there is nothing on screen to
           measure — and measuring anyway would read a scrollHeight of 0
           off a display:none element and clamp every note to nothing.
           Inline sizes set by a previous view are cleared on the way in. */
        if (view === 'list') {
            const ta = card.querySelector('.note-body');
            if (ta) ta.style.height = '';
            const wrap = card.querySelector('.check-wrap, .note-md');
            if (wrap) wrap.style.maxHeight = '';
            card.classList.remove('is-clamped');
            return;
        }

        const metrics = CFG.NOTE_VIEW_HEIGHTS && CFG.NOTE_VIEW_HEIGHTS[view] || {};
        const limit = metrics.collapse || CFG.NOTE_COLLAPSE_PX;
        const minimum = metrics.minimum || 96;
        let clamped;

        /* A rendered Markdown body clamps the way a checklist does — by
           capping the block — rather than the way a textarea does, whose
           height has to be set for it because it does not grow on its
           own. */
        const wrap = card.querySelector('.check-wrap, .note-md');
        if (wrap) {
            wrap.style.maxHeight = 'none';
            clamped = wrap.scrollHeight > limit;
            wrap.style.maxHeight = clamped ? `${limit}px` : '';
        } else {
            const ta = card.querySelector('.note-body');
            ta.style.height = 'auto';
            const full = ta.scrollHeight;
            clamped = full > limit;
            ta.style.height = `${clamped ? limit : Math.max(full, minimum)}px`;
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
        durableNote(note);
    }

    function newNote(kind) {
        const now = new Date().toISOString();
        const note = {
            id: uid(), kind, title: '', pinned: false, pinnedAt: null,
            finishNext: false, finishNextAt: null,
            /* Null, not false: nobody has said yet, so detection decides. */
            markdown: null, markdownAt: null,
            folder: activeFolder && activeFolder !== UNFILED ? activeFolder : null,
            created: now, updated: now
        };
        if (kind === 'checklist') note.items = [{ id: uid(), text: '', done: false }];
        else note.body = '';

        /* An empty new note cannot match an existing search. Clear it before
           rendering so the card we are about to focus is never born hidden. */
        el('search').value = '';
        notes.unshift(note);
        renderNotes();
        renderFolders();
        commit();
        revealNewNote(note.id);
    }

    function revealNewNote(id) {
        /* Do not assume the card is first: title sorting can place Untitled
           in the middle of a large docket. Find the exact note we created. */
        const card = Array.from(document.querySelectorAll('.note'))
            .find((candidate) => candidate.dataset.id === String(id));

        /* The caret lands on the writing surface, not the title. A note left
           untitled already borrows its first line for one, so opening in the
           title field asks for something the note supplies on its own — and
           the reason to press New note is nearly always to start typing. On
           a checklist that surface is its first item, which is the same
           place for the same reason: `.note-body` is not in that card at
           all, so the fallback is a fallback only on paper. */
        const input = card && (card.querySelector('.note-body') ||
                               card.querySelector('.check-text'));
        if (!input) return;

        /* preventScroll avoids the browser's abrupt focus jump; the explicit
           scroll below supplies one consistent smooth motion instead. */
        try { input.focus({ preventScroll: true }); }
        catch (e) { input.focus(); }

        const reveal = () => input.scrollIntoView({
            behavior: 'smooth', block: 'center', inline: 'nearest'
        });
        requestAnimationFrame(() => requestAnimationFrame(reveal));

        /* Mobile keyboards can resize the visual viewport after the first
           animation frames. Re-centre once after that resize settles. */
        setTimeout(() => {
            if (document.activeElement === input) reveal();
        }, 300);
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

    /* Leaving an edited card is the semantic boundary that folds its hot
       file into the archive. Waiting one task distinguishes movement within
       the same card from an actual note switch. */
    el('panel-notes').addEventListener('focusout', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const id = card.dataset.id;
        setTimeout(() => {
            const active = document.activeElement;
            const stillEditing = card.contains(active) &&
                active.matches('.note-title, .note-body, .check-text');
            if (stillEditing) return;
            const folded = Store.checkpoint(id);
            /* A merge that arrived mid-edit was held back rather than
               yanked out from under the caret. This is where it lands. */
            if (deferredRender) { flushDeferredRender(); return; }
            if (folded) renderNotes();
        }, 0);
    });

    el('panel-notes').addEventListener('click', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        /* While a merge is being picked the whole card is one control: the
           pin, the folder and the delete on it all act on a board the pick
           order is counted against, and the pick button is only there to
           give the keyboard something to land on. */
        if (merging) { togglePick(note.id); return; }

        if (e.target.closest('.check-box')) {
            const row = e.target.closest('.check-item');
            const item = (note.items || []).find((i) => i.id === row.dataset.item);
            if (item) {
                item.done = !item.done;
                touchNote(note, card);
                row.classList.toggle('is-done', item.done);
                row.querySelector('.check-box').setAttribute('aria-checked', String(item.done));
                refreshChecklistProgress(note, card);
                sizeCard(card);
            }
        } else if (e.target.closest('.check-del')) {
            const row = e.target.closest('.check-item');
            note.items = (note.items || []).filter((i) => i.id !== row.dataset.item);
            touchNote(note, card);
            refreshChecklistCard(note, card);
        } else if (e.target.closest('.check-add')) {
            addChecklistItem(note, card);
        } else if (e.target.closest('.note-folder')) {
            openFolderModal({ kind: 'note', id: note.id });
        } else if (e.target.closest('.note-expand')) {
            openFocus(note.id);
        } else if (e.target.closest('.act-md')) {
            /* Whatever it is showing, show the other one — and record that
               as this note's answer, so detection stops being asked. */
            setMarkdown(note, !showsMarkdown(note));
        } else if (e.target.closest('.note-md')) {
            /* A rendered body has no caret to click into, so a click on it
               opens the note where it can be read in full and switched
               back — the same answer a List row's chevron gives, for the
               same reason. A link inside it is left alone: following it is
               what clicking it meant. */
            if (!e.target.closest('a')) openFocus(note.id);
        } else if (e.target.closest('.act-pin')) {
            note.pinned = !note.pinned;
            /* Pinning is not an edit, so it must not bump `updated` — that
               would make a note you merely pinned look freshly written and
               jump it up a recently-updated sort. It does need a date of
               its own, though: `updated` is what every merge compares, so
               a pin with no clock of its own is invisible to the reconcile
               on the other device and gets thrown away as a note that
               machine already has. The stamp is written on the way off as
               well as on the way on — an unpin is a change like any other,
               and clearing the field is what used to leave it undatable. */
            note.pinnedAt = new Date().toISOString();
            renderNotes();
            commit();
        } else if (e.target.closest('.act-finish')) {
            /* The same shape as the pin, and deliberately nothing more:
               the two flags never read each other, so flagging a note to
               finish next leaves its pin exactly as it was and vice versa.
               Only the band it is drawn in changes, and splitNotes settles
               that. Marked at the same clock as the pin, and for the same
               reason — it is not an edit, so it carries its own date or it
               cannot survive the trip to another device. */
            note.finishNext = !note.finishNext;
            note.finishNextAt = new Date().toISOString();
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
        refreshChecklistCard(note, card);
        const inputs = card.querySelectorAll('.check-text');
        if (inputs.length) inputs[inputs.length - 1].focus();
    }

    function refreshChecklistProgress(note, card) {
        const progress = card.querySelector('.check-progress');
        if (!progress) return;
        const items = note.items || [];
        progress.textContent = `${items.filter((item) => item.done).length} of ${items.length} done`;
    }

    /* Checklist edits replace only that card's body. Other cards—and any
       caret they own—remain untouched. */
    function refreshChecklistCard(note, card) {
        card.querySelector('.note-bodywrap').innerHTML =
            `${checklistMarkup(note)}<div class="note-fade" aria-hidden="true"></div>`;
        sizeCard(card);
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
       MERGE

       Two or more notes into one. The first note picked is the one that
       survives: it keeps its id, its created date, its folder and both
       band flags, and every other pick is appended into it in the order
       it was picked. That order is the whole feature, so it is shown
       rather than assumed — each picked card wears its number, and the
       bar names the note the rest are going into.

       The notes merged in go to the trash, not away. A merge is lossy in
       one direction — a checklist folded into a note comes out as text —
       and the trash is where this app keeps what it cannot undo for you.
       The base note's own previous text is in the version history, which
       is the same answer it gives for every other edit. Having asked
       first, a merge does not also offer an Undo, for the reason a note
       delete does not: a question answered before anything happens beats
       a race against an eight-second clock.
       ============================================================ */

    let merging = false;

    /* Note ids, in the order they were picked — an array and not a Set,
       because the order is the point. */
    let picked = [];

    /* The rule drawn between two merged notes. Plain ASCII on purpose:
       these bodies are read in a monospaced focus view, copied to the
       clipboard and written into the .txt export, and a box-drawing
       character survives none of those as dependably as three hyphens. */
    const MERGE_RULE = '\n\n---\n\n';

    function setMerging(on) {
        merging = on;
        picked = [];
        el('panel-notes').classList.toggle('is-picking', on);
        el('notes-bar').hidden = on;
        el('merge-bar').hidden = !on;
        applyPicks();
    }

    function togglePick(id) {
        const at = picked.indexOf(String(id));
        if (at === -1) picked.push(String(id)); else picked.splice(at, 1);
        applyPicks();
    }

    /* Shaped like applyNoteFilters, and for the same reason: the cards are
       already on the board, so picking one patches a class and a number
       rather than rebuilding a grid and replaying every card's entry
       animation. Renumbering after an un-pick is why every card is visited
       and not only the one clicked. */
    function applyPicks() {
        /* A background sync can land mid-pick and take a note with it. */
        picked = picked.filter((id) => findNote(id));

        document.querySelectorAll('.note').forEach((card) => {
            const note = findNote(card.dataset.id);
            const pick = card.querySelector('.note-pick');
            if (!note || !pick) return;
            const at = picked.indexOf(card.dataset.id);
            const label = at === -1 ? `Pick “${titleOf(note)}” for merge`
                : at === 0 ? `First pick — “${titleOf(note)}” is what the others merge into`
                : `Pick ${at + 1} — “${titleOf(note)}”`;

            card.classList.toggle('is-picked', at !== -1);
            card.classList.toggle('is-base', at === 0);
            pick.setAttribute('aria-pressed', String(at !== -1));
            pick.setAttribute('aria-label', label);
            pick.title = label;
            pick.querySelector('.note-pick-num').textContent = at === -1 ? '' : String(at + 1);
        });

        const base = findNote(picked[0]);
        el('merge-go').disabled = picked.length < 2;
        el('merge-lede').textContent = !base
            ? 'Pick the notes to merge. The first one is what the rest go into.'
            : picked.length === 1
                ? `“${titleOf(base)}” goes first. Now pick what to merge into it.`
                : `${picked.length} notes into “${titleOf(base)}”, in the order shown.`;
    }

    /* One note's contribution to a merged body.

       Every note but the base is introduced by its own title. The base's
       title is the merged note's title, so repeating it over its own text
       would head a section that is in fact the whole note. A note with no
       real title gets no heading either — its first line already stands
       in for one, which is exactly what the board shows in its place.

       Only the base keeps its leading whitespace. A note that deliberately
       opens on a blank line is a shape worth preserving at the top of the
       result; the same blank lines buried between two rules are only the
       gap the rule is already drawing. */
    function mergeBlock(note, isBase) {
        const text = plainText(note);
        const heading = isBase ? '' : (note.title || '').trim();
        return [heading, isBase ? text.replace(/\s+$/, '') : text.trim()]
            .filter(Boolean).join('\n\n');
    }

    const mergedBody = (list) =>
        list.map((n, i) => mergeBlock(n, i === 0)).filter(Boolean).join(MERGE_RULE);

    /* A merge keeps the kind its picks agree on. Checklists merged with
       checklists stay a checklist; a mixed pick lands as text, which is
       what a checklist has always rendered as outside itself — `[x] item`,
       the same lines plainText writes into the .txt export. The other
       direction has no honest answer: turning a note's lines into items
       means guessing which of a thousand pasted lines were meant to be
       tickable, and being wrong about most of them. */
    function mergeNotes(list) {
        const base = list[0];
        const rest = list.slice(1);

        /* One of these may be the note being typed into. Finish that
           session first: a hot file left behind for a note that has just
           been merged away is a note that walks back in on the next load. */
        Store.checkpoint();

        if (list.every(isList)) {
            /* Fresh objects and fresh ids. The notes being merged in are on
               their way to the trash rather than out of existence, and items
               shared by reference would leave the merged note and its own
               trashed source editing one array between them. */
            base.items = list.reduce((all, n) => all.concat((n.items || [])
                .map((i) => ({ id: uid(), text: i.text, done: Boolean(i.done) }))), []);
        } else {
            /* Read the whole pick before rewriting any of it. mergedBody
               asks plainText what each note says, and plainText asks each
               note what kind it is — so a base flattened before it is read
               answers for a plain note, hands back the empty body it does
               not have yet, and drops its own items out of the merge. */
            const body = mergedBody(list);
            base.kind = 'note';
            base.body = body;
            delete base.items;
        }

        /* The one edit in the operation. The picks that were merged away
           are deleted rather than edited, and dating them now is precisely
           how they would out-argue their own tombstones on the next
           reconcile and walk back in from the other browser. */
        base.updated = new Date().toISOString();

        const gone = new Set(rest.map((n) => String(n.id)));
        notes = notes.filter((n) => !gone.has(String(n.id)));
        rest.forEach((n) => trash.unshift({
            kind: 'note', item: n, deletedAt: base.updated
        }));

        setMerging(false);
        renderAll();
        commit();
        toast(`${list.length} notes merged into “${titleOf(base)}”`);
    }

    el('merge-btn').addEventListener('click', () => {
        if (notes.length < 2) {
            toast('Two notes at least — there is nothing to merge yet');
            return;
        }
        setMerging(true);
    });

    el('merge-cancel').addEventListener('click', () => setMerging(false));

    el('merge-go').addEventListener('click', () => {
        const list = picked.map(findNote).filter(Boolean);
        if (list.length < 2) return;
        const base = list[0];
        const lists = list.filter(isList).length;

        const body = [`They go into “${titleOf(base)}” in the order you picked them.`];
        /* Say so before it happens rather than after: flattening a checklist
           is the one part of a merge that cannot be read back off the
           result. */
        if (lists && lists < list.length) body.push(isList(base)
            ? 'Not all of them are checklists, so it comes out as plain text.'
            : 'The checklists among them come out as plain text.');
        const rest = list.length - 1;
        body.push(rest === 1
            ? `The other one moves to the trash, where you can restore it for ${CFG.TRASH_DAYS} days.`
            : `The other ${rest} move to the trash, where you can restore them for ${CFG.TRASH_DAYS} days.`);

        confirmAction(`Merge ${list.length} notes?`, body.join(' '),
            () => mergeNotes(list), 'Merge');
    });

    /* ============================================================
       TRASH
       ============================================================ */

    /* Deleting a note asks first, and having asked, does not also offer an
       Undo. The toast was a race against a clock: the delete button sits
       next to the pin on every card, and a mis-click noticed once the
       toast had gone had nothing left to press — the note was in the trash
       tab, and you had to know that. A question answered before anything
       happens is the cheaper of the two, and it is cheap precisely because
       it is rare: nobody deletes a note by the dozen.

       A file keeps its Undo. Dropping one on the board is a single motion
       with nothing to re-read before committing to it, and interrupting a
       drag-and-drop workflow to confirm each one is the friction this
       dialog is worth avoiding. */
    function trashItem(kind, item) {
        if (kind !== 'note') { binItem(kind, item); return; }
        confirmAction('Delete this note?',
            `“${titleOf(item)}” moves to the trash, where you can restore it ` +
            `for ${CFG.TRASH_DAYS} days.`,
            () => binItem(kind, item));
    }

    function binItem(kind, item) {
        const label = kind === 'note' ? titleOf(item) : item.name;
        if (kind === 'note') notes = notes.filter((n) => n.id !== item.id);
        else files = files.filter((f) => f.id !== item.id);

        trash.unshift({ kind, item, deletedAt: new Date().toISOString() });
        renderAll();
        commit();

        /* The blob stays in Supabase while a file is only trashed — there
           would be nothing to restore otherwise. Emptying the trash is
           what actually deletes it. */
        if (kind === 'note') { toast(`Note “${label}” moved to trash`); return; }
        toast(`File “${label}” moved to trash`, () => {
            restoreFromTrash(item.id);
        });
    }

    /* A purged entry keeps its slot as a bare tombstone, so the live trash
       is the subset that still has something in it to look at. */
    const inTrash = () => trash.filter((t) => !t.purged);

    function restoreFromTrash(id) {
        const idx = trash.findIndex((t) => t.item.id === id && !t.purged);
        if (idx === -1) return;
        const [entry] = trash.splice(idx, 1);
        /* Restoring has to out-date the deletion it undoes, or the merge
           reads the tombstone as the later word and bins it again. */
        entry.item.updated = new Date().toISOString();
        if (entry.kind === 'note') notes.unshift(entry.item);
        else files.unshift(entry.item);
        pruneFolder();
        renderAll();
        commit();
        toast('Restored');
    }

    /* Dropping the entry outright would resurrect the item: another browser
       still holding it has nothing left to tell it the thing was deleted,
       and the next merge unions it straight back in. What is left behind is
       the id, the date and a flag — a few dozen bytes that remember the
       deletion until TRASH_DAYS clears the record for good. */
    function purgeForever(entry) {
        if (entry.kind === 'file') Store.dropBlob(entry.item.id);
        const idx = trash.findIndex((t) => t.item.id === entry.item.id);
        const grave = {
            kind: entry.kind,
            item: { id: entry.item.id },
            deletedAt: entry.deletedAt || new Date().toISOString(),
            purged: true
        };
        if (idx === -1) trash.push(grave); else trash[idx] = grave;
    }

    /* Anything sitting in the trash past TRASH_DAYS goes on the next load.
       Files take their cloud blob with them, which is the only point at
       which storage is actually reclaimed — and it is where a tombstone is
       finally dropped too, every browser having long since seen it. */
    function purgeTrash() {
        const cutoff = Date.now() - CFG.TRASH_DAYS * 86400000;
        const stale = trash.filter((t) => new Date(t.deletedAt || 0).getTime() < cutoff);
        if (!stale.length) return;
        stale.forEach((entry) => { if (!entry.purged) purgeForever(entry); });
        trash = trash.filter((t) => new Date(t.deletedAt || 0).getTime() >= cutoff);
        commit();
    }

    function renderTrash() {
        const live = inTrash();
        el('count-trash').textContent = live.length;
        el('tab-trash').hidden = live.length === 0;
        if (!live.length && activeTab() === 'trash') showTab('notes');

        el('trash-lede').textContent = live.length
            ? `Deleted items are kept for ${CFG.TRASH_DAYS} days, then removed.`
            : 'Nothing in the trash.';

        el('trash-list').innerHTML = live.map((t) => `
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
        const entry = trash.find((t) => t.item.id === row.dataset.id && !t.purged);
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
        const live = inTrash();
        if (!live.length) return;
        confirmAction('Empty the trash?',
            `${live.length} item${live.length === 1 ? '' : 's'} will be gone for good.`, () => {
                live.forEach(purgeForever);
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

        renderFocusBody(note);
        updateFocusMeta();
        el('focus-modal').hidden = false;
        document.body.classList.add('is-locked');
        /* The caret goes where there is one to put. A rendered note is
           read rather than typed into, so it is scrolled to the top
           instead and left for the toggle. */
        if (el('focus-body').hidden) {
            el('focus-md').scrollTop = 0;
        } else {
            el('focus-body').focus();
            el('focus-body').setSelectionRange(0, 0);
            el('focus-body').scrollTop = 0;
        }
    }

    /* Which of the three surfaces this note is shown on — a textarea, a
       rendered block, or a checklist — and the toggle set to match. */
    function renderFocusBody(note) {
        const list = isList(note);
        const markdown = showsMarkdown(note);

        el('focus-body').hidden = list || markdown;
        el('focus-md').hidden = list || !markdown;
        el('focus-items').hidden = !list;
        el('focus-mode').hidden = list;

        if (list) { renderFocusItems(note); return; }
        if (markdown) el('focus-md').innerHTML = markdownHtml(note);
        else el('focus-body').value = note.body || '';

        el('focus-mode').querySelectorAll('.seg-btn').forEach((btn) => {
            const on = (btn.dataset.mode === 'markdown') === markdown;
            btn.classList.toggle('is-on', on);
            btn.setAttribute('aria-pressed', String(on));
        });
    }

    function renderFocusItems(note) {
        el('focus-items').innerHTML = checklistMarkup(note);
    }

    function closeFocus() {
        const id = focusId;
        el('focus-modal').hidden = true;
        document.body.classList.remove('is-locked');
        focusId = null;
        Store.checkpoint(id);
        if (deferredRender) { flushDeferredRender(); return; }
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
            /* The note, not the textarea: while the Markdown preview is up
               the textarea is empty and holds nothing to count. */
            const body = note.body || '';
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
            durableNote(note);
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
        durableNote(note);
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
        durableNote(note);
        const inputs = el('focus-items').querySelectorAll('.check-text');
        if (e.target.closest('.check-add') && inputs.length) inputs[inputs.length - 1].focus();
    });

    el('focus-items').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.classList.contains('check-text')) return;
        e.preventDefault();
        const note = findNote(focusId);
        if (!note) return;
        note.items.push({ id: uid(), text: '', done: false });
        note.updated = new Date().toISOString();
        renderFocusItems(note);
        durableNote(note);
        const inputs = el('focus-items').querySelectorAll('.check-text');
        if (inputs.length) inputs[inputs.length - 1].focus();
    });

    el('focus-modal').addEventListener('focusout', () => {
        const id = focusId;
        setTimeout(() => {
            const active = document.activeElement;
            const stillEditing = active === el('focus-title') || active === el('focus-body') ||
                el('focus-items').contains(active);
            if (!stillEditing) Store.checkpoint(id);
        }, 0);
    });

    /* The manual override. Detection is a guess made from the text, and
       this is where you tell it that it guessed wrong — for this note,
       from now on, on every device. */
    el('focus-mode').addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        const note = findNote(focusId);
        if (!btn || !note) return;
        const markdown = btn.dataset.mode === 'markdown';
        if (markdown === showsMarkdown(note)) return;
        setMarkdown(note, markdown);
        renderFocusBody(note);
        /* Switching back to plain text is nearly always the first half of
           an edit, so the caret goes with it. */
        if (!markdown) el('focus-body').focus();
    });

    el('focus-close').addEventListener('click', closeFocus);
    el('focus-done').addEventListener('click', closeFocus);
    dismissOnBackdrop('focus-modal', closeFocus);

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

        /* Bytes live in Supabase, not on this device. */
        if (!Store.isConnected()) {
            toast('Sign in to store files');
            return;
        }

        let added = 0;
        for (const file of incoming) {
            if (file.size > CFG.MAX_FILE_BYTES) {
                toast(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(CFG.MAX_FILE_BYTES)} per file`);
                continue;
            }
            if (files.length >= CFG.MAX_FILES) {
                toast(`The file limit is ${CFG.MAX_FILES}; delete something first`);
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
        const shown = files.slice().sort(FILE_SORTS[el('file-sort').value] || FILE_SORTS.added);

        el('file-list').innerHTML = shown.map((f) => `
            <li class="file" data-id="${esc(f.id)}">
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
            ? `${files.length} of ${CFG.MAX_FILES} files · ${formatBytes(totalBytes())} stored in Supabase`
            : '';
        applyFileFilters();
    }

    function applyFileFilters() {
        let total = 0;
        el('file-list').querySelectorAll('.file').forEach((row) => {
            const file = files.find((item) => String(item.id) === row.dataset.id);
            const shown = Boolean(file && inActiveFolder(file) && matchesFile(file));
            row.classList.toggle('is-filtered', !shown);
            if (shown) total++;
        });
        el('count-files').textContent = String(total);
        el('file-none').hidden = !(total === 0 && files.length > 0);
    }

    el('file-list').addEventListener('click', async (e) => {
        const row = e.target.closest('.file');
        if (!row) return;
        const meta = files.find((f) => String(f.id) === row.dataset.id);
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
                    meta.updated = new Date().toISOString();
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
            if (!payload) { toast('That file has no contents in Supabase yet'); return; }

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
        const band = (n) => (n.finishNext ? 2 : 0) + (n.pinned ? 1 : 0);
        notes.slice()
            .sort((a, b) => band(b) - band(a) || NOTE_SORTS.updated(a, b))
            .forEach((n) => {
                const flags = [n.finishNext && '[finish next]', n.pinned && '[pinned]']
                    .filter(Boolean).join(' ');
                out.push(rule);
                out.push(titleOf(n) + (flags ? `   ${flags}` : ''));
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
            'Your existing file uploads stay in Supabase either way.',
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
        if (!Store.isConnected()) { toast('Sign in first — history is stored in Supabase'); return; }
        el('settings-modal').hidden = true;
        el('history-list').innerHTML = '<li class="hint">Loading…</li>';
        el('history-modal').hidden = false;

        /* Finish the current editing session before loading the list, then
           refresh history so it includes that semantic checkpoint. */
        Store.checkpoint();
        if (Store.hasPending()) await Store.flush();
        await pullFromCloud();
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
    dismissOnBackdrop('history-modal', () => { el('history-modal').hidden = true; });

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
    dismissOnBackdrop('prompt-modal', closePrompt);

    let confirmFn = null;

    /** `ok` renames the confirm button and drops its danger colour, for
     *  the questions that have to be asked before something that is not a
     *  deletion. Left out, it stays the red Delete every caller wanted
     *  when this only ever guarded one. */
    function confirmAction(title, body, onOk, ok) {
        el('confirm-title').textContent = title;
        el('confirm-body').textContent = body;
        el('confirm-ok').textContent = ok || 'Delete';
        el('confirm-ok').classList.toggle('btn-danger', !ok);
        el('confirm-ok').classList.toggle('btn-primary', Boolean(ok));
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
        el('fact-status').textContent = Store.isConnected() ? 'connected' : 'not connected';
        el('fact-account').textContent = Store.currentEmail() || '—';
        el('fact-notes').textContent = `${notes.length} saved`;
        el('fact-files').textContent = `${files.length} · ${formatBytes(totalBytes())}`;
        el('settings-modal').hidden = false;
    }

    el('settings-btn').addEventListener('click', openSettings);
    document.querySelectorAll('[data-act="settings"]').forEach((b) =>
        b.addEventListener('click', openSettings));

    el('settings-cancel').addEventListener('click', () => { el('settings-modal').hidden = true; });

    el('settings-save').addEventListener('click', async () => {
        el('settings-modal').hidden = true;
    });

    el('reload-btn').addEventListener('click', async () => {
        el('settings-modal').hidden = true;
        if (Store.hasPending()) await Store.flush();
        await pullFromCloud();
        toast(Store.isConnected() ? 'Reloaded from Supabase' : 'Not connected');
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
        else if (merging) setMerging(false);
    });

    dismissOnBackdrop('settings-modal', () => { el('settings-modal').hidden = true; });
    dismissOnBackdrop('confirm-modal', closeConfirm);

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
            if (note) card.querySelector('.note-stamp').textContent = relTime(note.updated);
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
