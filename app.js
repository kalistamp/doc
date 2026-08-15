/* ============================================================
   DOCKET SHARING — app

   State is three collections, all of them living in the gist:
     notes  [{ id, title, body, pinned, created, updated }]
     files  [{ id, name, size, type, added }]        ← metadata only
     blobs  { [fileId]: "<base64>" }                 ← payloads

   files/blobs are split so that editing a note never re-uploads
   megabytes of base64; see the note in config.js.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const Store = window.DocketStore;

    const $ = (sel) => document.querySelector(sel);
    const el = (id) => document.getElementById(id);

    let notes = [];
    let files = [];
    let blobs = {};
    let unlocked = false;

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
        const days = Math.round(secs / 86400);
        if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
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
        toast._t = setTimeout(() => { t.hidden = true; }, 2600);
    }

    /* ============================================================
       PASSKEY GATE
       ============================================================ */

    el('gate-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const card = $('.gate-card');
        const msg = el('gate-msg');
        const btn = el('gate-btn');
        const value = el('passkey').value;

        if (value !== CFG.PASSKEY) {
            msg.className = 'gate-msg';
            msg.textContent = "That passkey didn't work.";
            card.classList.remove('is-wrong');
            void card.offsetWidth;          /* restart the shake */
            card.classList.add('is-wrong');
            el('passkey').select();
            return;
        }

        btn.disabled = true;
        msg.className = 'gate-msg is-busy';
        msg.textContent = 'Unlocking…';

        try {
            /* Deriving the key is deliberately slow (250k PBKDF2 rounds), and
               it is the only thing standing between the sealed token and the
               open web, so it stays slow. */
            await Store.unlock(value);
        } catch (err) {
            btn.disabled = false;
            msg.className = 'gate-msg';
            msg.textContent = 'Could not unseal the token for that passkey.';
            return;
        }

        msg.textContent = 'Fetching your docket…';
        try {
            const data = await Store.load();
            notes = data.notes;
            files = data.files;
            blobs = data.blobs;
        } catch (err) {
            /* A read failure is not fatal — the app opens empty and the
               banner explains why, so the user can fix the token in
               Settings instead of being stuck at a dead gate. */
            showBanner(err.message);
        }

        unlocked = true;
        el('gate').classList.add('is-gone');
        el('app').hidden = false;
        Store.bind(
            () => ({ notes, files, version: 1, updated: new Date().toISOString() }),
            () => blobs
        );
        renderAll();
    });

    el('lock-btn').addEventListener('click', async () => {
        if (Store.hasPending()) await Store.flush();
        location.reload();
    });

    /* ============================================================
       SYNC STATUS
       ============================================================ */

    const SYNC_UI = {
        loading: { icon: '#i-refresh', text: 'Loading…', cls: 'is-busy' },
        saving:  { icon: '#i-refresh', text: 'Saving…',  cls: 'is-busy' },
        dirty:   { icon: '#i-refresh', text: 'Unsaved',  cls: '' },
        synced:  { icon: '#i-check',   text: 'Synced',   cls: 'is-synced' },
        error:   { icon: '#i-alert',   text: 'Failed',   cls: 'is-error' }
    };

    Store.onStatus((state, detail) => {
        const ui = SYNC_UI[state] || SYNC_UI.synced;
        const pill = el('sync-pill');
        pill.className = `sync-pill ${ui.cls}`;
        pill.querySelector('use').setAttribute('href', ui.icon);
        el('sync-text').textContent = ui.text;

        if (state === 'error') showBanner(detail);
        if (state === 'synced') {
            hideBanner();
            el('foot-stamp').textContent = `last synced ${new Date().toLocaleTimeString()}`;
        }
    });

    function showBanner(text) {
        el('banner-text').textContent = text;
        el('banner').hidden = false;
    }
    function hideBanner() { el('banner').hidden = true; }

    el('banner-close').addEventListener('click', hideBanner);
    el('banner-retry').addEventListener('click', () => { hideBanner(); Store.retry(); });

    /* Clicking the pill pushes anything outstanding, then pulls — the manual
       "get me level with the other machine" button. */
    el('sync-pill').addEventListener('click', async () => {
        if (Store.hasPending()) await Store.flush();
        await reloadFromGist();
    });

    async function reloadFromGist() {
        try {
            const data = await Store.load();
            notes = data.notes;
            files = data.files;
            blobs = data.blobs;
            renderAll();
        } catch (err) { /* onStatus already surfaced it */ }
    }

    /* Last line of defence against closing the tab on an unsaved edit. The
       debounce window is under a second, so this fires rarely. */
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
       NOTES
       ============================================================ */

    /* Pinned first, then most recently touched. Sorting on a copy keeps the
       underlying array in insertion order, which is what gets serialised. */
    function sortedNotes() {
        const q = el('note-search').value.trim().toLowerCase();
        return notes
            .filter((n) => !q ||
                (n.title || '').toLowerCase().includes(q) ||
                (n.body || '').toLowerCase().includes(q))
            .slice()
            .sort((a, b) =>
                (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                new Date(b.updated || 0) - new Date(a.updated || 0));
    }

    function renderNotes() {
        const grid = el('note-grid');
        const list = sortedNotes();

        el('count-notes').textContent = notes.length;
        el('notes-empty').hidden = notes.length !== 0;

        grid.innerHTML = list.map((n) => `
            <article class="note${n.pinned ? ' is-pinned' : ''}" data-id="${n.id}">
                <input class="note-title" type="text" value="${esc(n.title || '')}"
                       placeholder="Untitled" maxlength="120" aria-label="Note title">
                <textarea class="note-body" placeholder="Start typing…"
                          aria-label="Note body">${esc(n.body || '')}</textarea>
                <div class="note-foot">
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

        grid.querySelectorAll('.note-body').forEach(autosize);

        if (list.length === 0 && notes.length > 0) {
            grid.innerHTML = `<p class="hint" style="grid-column:1/-1">
                No notes match that search.</p>`;
        }
    }

    function autosize(ta) {
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(ta.scrollHeight, 136)}px`;
    }

    const findNote = (id) => notes.find((n) => n.id === id);

    function touchNote(note, card) {
        note.updated = new Date().toISOString();
        /* Update the stamp in place rather than re-rendering: a re-render
           mid-keystroke would blow away the caret. */
        if (card) card.querySelector('.note-stamp').textContent = relTime(note.updated);
        Store.touchData();
    }

    el('new-note-btn').addEventListener('click', newNote);

    function newNote() {
        const now = new Date().toISOString();
        notes.unshift({ id: uid(), title: '', body: '', pinned: false, created: now, updated: now });
        renderNotes();
        Store.touchData();
        const first = $('.note .note-title');
        if (first) first.focus();
    }

    /* One delegated listener per event type on the grid, rather than four per
       card — note cards are re-rendered often enough that per-card wiring
       would leak handlers. */
    el('note-grid').addEventListener('input', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        if (e.target.classList.contains('note-title')) note.title = e.target.value;
        else if (e.target.classList.contains('note-body')) {
            note.body = e.target.value;
            autosize(e.target);
        } else return;

        touchNote(note, card);
    });

    el('note-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.note');
        if (!card) return;
        const note = findNote(card.dataset.id);
        if (!note) return;

        if (e.target.closest('.act-pin')) {
            note.pinned = !note.pinned;
            touchNote(note, null);
            renderNotes();
        } else if (e.target.closest('.act-del')) {
            const label = note.title.trim() || 'this untitled note';
            confirmAction('Delete note?', `“${label}” will be removed from every machine.`, () => {
                notes = notes.filter((n) => n.id !== note.id);
                renderNotes();
                Store.touchData();
                toast('Note deleted');
            });
        }
    });

    el('note-search').addEventListener('input', renderNotes);

    document.querySelectorAll('[data-act="new-note"]').forEach((b) =>
        b.addEventListener('click', newNote));

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
            zone.classList.add('is-over');
        }));
    ['dragleave', 'drop'].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
        }));
    zone.addEventListener('drop', (e) => acceptFiles(e.dataTransfer.files));

    /* A drop anywhere but the zone would otherwise make the browser navigate
       away to the file, silently losing unsaved work. */
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    const totalBytes = () => files.reduce((sum, f) => sum + (f.size || 0), 0);

    async function acceptFiles(fileList) {
        const incoming = Array.from(fileList || []);
        if (!incoming.length) return;

        let added = 0;
        for (const file of incoming) {
            if (file.size > CFG.MAX_FILE_BYTES) {
                toast(`${file.name} is ${formatBytes(file.size)} — over the ${formatBytes(CFG.MAX_FILE_BYTES)} limit`);
                continue;
            }
            if (totalBytes() + file.size > CFG.MAX_TOTAL_BYTES) {
                toast(`No room for ${file.name} — the gist is nearly full`);
                continue;
            }
            /* Read first, register second. The other order leaves a row in
               `files` with no matching blob if the read fails — a listing
               that can only ever say "missing its contents". */
            let payload;
            try {
                payload = await readBase64(file);
            } catch (err) {
                toast(`Could not read ${file.name}`);
                continue;
            }

            const id = uid();
            blobs[id] = payload;
            files.unshift({
                id,
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                added: new Date().toISOString()
            });
            added++;
        }

        if (!added) return;
        renderFiles();
        Store.touchData();
        Store.touchBlobs();
        toast(`${added} file${added === 1 ? '' : 's'} uploaded`);
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
        const shown = files.filter((f) => !q || f.name.toLowerCase().includes(q));

        el('count-files').textContent = files.length;
        el('dropzone-hint').textContent =
            `Up to ${formatBytes(CFG.MAX_FILE_BYTES)} each · ${formatBytes(CFG.MAX_TOTAL_BYTES)} total`;

        list.innerHTML = shown.map((f) => `
            <li class="file" data-id="${f.id}">
                <span class="file-icon" aria-hidden="true">
                    <svg class="ico"><use href="#i-file"></use></svg>
                </span>
                <div class="file-main">
                    <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
                    <span class="file-meta">${formatBytes(f.size)} · ${esc(relTime(f.added))}</span>
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

        if (!shown.length) {
            list.innerHTML = files.length
                ? '<p class="hint">No files match that search.</p>'
                : '';
        }

        const used = totalBytes();
        const pct = Math.min(100, (used / CFG.MAX_TOTAL_BYTES) * 100);
        const fill = el('storage-fill');
        fill.style.width = `${pct}%`;
        fill.className = `storage-fill${pct > 90 ? ' is-full' : pct > 70 ? ' is-high' : ''}`;
        el('storage-text').textContent =
            `${formatBytes(used)} of ${formatBytes(CFG.MAX_TOTAL_BYTES)} used`;
    }

    el('file-list').addEventListener('click', async (e) => {
        const row = e.target.closest('.file');
        if (!row) return;
        const meta = files.find((f) => f.id === row.dataset.id);
        if (!meta) return;

        const payload = blobs[meta.id];
        if (!payload && !e.target.closest('.act-del')) {
            toast('That file is missing its contents — try Sync.');
            return;
        }

        if (e.target.closest('.act-get')) {
            const url = URL.createObjectURL(base64ToBlob(payload, meta.type));
            const a = document.createElement('a');
            a.href = url;
            a.download = meta.name;
            a.click();
            /* Revoking immediately can beat the download on some browsers. */
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } else if (e.target.closest('.act-copy')) {
            try {
                await navigator.clipboard.writeText(await base64ToBlob(payload, meta.type).text());
                toast('Copied to clipboard');
            } catch (err) {
                toast('Clipboard blocked by the browser');
            }
        } else if (e.target.closest('.act-del')) {
            confirmAction('Delete file?', `“${meta.name}” will be removed from every machine.`, () => {
                files = files.filter((f) => f.id !== meta.id);
                delete blobs[meta.id];
                renderFiles();
                Store.touchData();
                Store.touchBlobs();
                toast('File deleted');
            });
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

    el('settings-btn').addEventListener('click', () => {
        el('token-input').value = Store.tokenOverride();
        el('fact-token').textContent = Store.tokenHint();
        el('fact-gist').href = `https://gist.github.com/${CFG.GIST_ID}`;
        el('fact-notes').textContent = `${notes.length} saved`;
        el('fact-files').textContent = `${files.length} · ${formatBytes(totalBytes())}`;
        el('settings-modal').hidden = false;
    });

    el('settings-cancel').addEventListener('click', () => { el('settings-modal').hidden = true; });

    el('settings-save').addEventListener('click', () => {
        Store.setTokenOverride(el('token-input').value);
        el('settings-modal').hidden = true;
        toast('Settings saved');
        reloadFromGist();
    });

    el('reload-btn').addEventListener('click', async () => {
        el('settings-modal').hidden = true;
        if (Store.hasPending()) await Store.flush();
        await reloadFromGist();
        toast('Reloaded from gist');
    });

    /* Escape closes whichever modal is on top. */
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!el('confirm-modal').hidden) closeConfirm();
        else if (!el('settings-modal').hidden) el('settings-modal').hidden = true;
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
        renderNotes();
        renderFiles();
    }

    /* The "3 min ago" stamps go stale on a tab left open all day. Cheap
       enough to refresh on a minute tick, but only when nothing is focused
       inside the grid — otherwise it would fight the caret. */
    setInterval(() => {
        if (!unlocked) return;
        if (el('note-grid').contains(document.activeElement)) return;
        document.querySelectorAll('.note').forEach((card) => {
            const note = findNote(card.dataset.id);
            if (note) card.querySelector('.note-stamp').textContent = relTime(note.updated);
        });
    }, 60000);
})();
