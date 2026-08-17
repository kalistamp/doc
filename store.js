/* ============================================================
   DOCKET SHARING — gist store

   Credentials are the user's own, entered under Settings → Cloud sync
   and held in localStorage on that device. Until both a token and a
   gist id are present the store is simply "not connected": the app
   still runs, notes still persist locally, nothing is uploaded.

   Layout inside the gist:
     docket share.json     cold archive, rewritten at checkpoints
     docket-hot-<id>       the one note currently being edited
     docket-blob-<id>      one file per upload, base64

   Blobs are NOT downloaded on load. The gist listing gives us each
   file's content or a raw_url, and we only pull the bytes when someone
   actually downloads or copies that file — so a docket holding 200 MB
   opens as fast as an empty one.

   Writes are queued: a PATCH only touches the files it names, so
   several changes coalesce into one request, and only one request is
   ever in flight — two overlapping PATCHes can land out of order and
   silently undo each other.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const TOKEN_KEY = 'docket.token';
    const GIST_KEY = 'docket.gistId';

    let token = readLS(TOKEN_KEY);
    let gistId = readLS(GIST_KEY);
    let listeners = [];

    /* Dirty flags + the getters that produce a payload when we flush. */
    const dirty = { archive: false, hot: false };
    let pendingBlobs = {};      /* gist filename -> base64 or null (delete) */
    let pendingHotDeletes = {}; /* hot filename -> null */
    let sources = { data: null };

    let activeHotId = null;
    let loadedHotNames = [];
    let checkpointTimer = null;

    let flushTimer = null;
    let inFlight = null;
    let lastError = null;
    let dirtySince = 0;

    /* What the last load told us about each blob file, so a download can
       resolve bytes without re-listing the gist. */
    let blobRefs = {};
    const blobCache = {};

    /* The gist's own revision list, captured on every load. GitHub keeps
       one entry per save, which is version history for free. */
    let lastHistory = [];

    const emit = (state, detail) => listeners.forEach((fn) => fn(state, detail));

    function readLS(k) {
        try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
    }
    function writeLS(k, v) {
        try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
    }

    /* ---------- credentials ------------------------------------------ */

    const isConnected = () => Boolean(token && gistId);

    function setCredentials(nextToken, nextGist) {
        token = (nextToken || '').trim();
        /* People paste the whole gist URL as often as the bare id. */
        gistId = (nextGist || '').trim().replace(/^.*gist\.github\.com\//, '')
                                        .replace(/^[^/]+\//, '')
                                        .replace(/[#?].*$/, '')
                                        .replace(/\/+$/, '');
        writeLS(TOKEN_KEY, token);
        writeLS(GIST_KEY, gistId);
    }

    const api = () => `https://api.github.com/gists/${gistId}`;

    const headers = () => ({
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
    });

    /* ---------- errors ------------------------------------------------ */

    /* GitHub's own wording for a scope problem ("Resource not accessible
       by personal access token") says nothing about how to fix it, and
       it is the single most likely thing to go wrong. */
    function describe(res, body, verb) {
        if (res.status === 401) {
            return 'GitHub rejected the token (401). It may be expired or mistyped — check it under Settings → Cloud sync.';
        }
        if (res.status === 403) {
            return `The token is not allowed to ${verb} this gist (403). It needs Gists → Read and write: for a fine-grained token that is under Account permissions.`;
        }
        if (res.status === 404) {
            return verb === 'read'
                ? 'No gist found for that id (404). Check the Gist ID under Settings → Cloud sync — and that this token can see it.'
                : 'Cannot write that gist (404). Usually the token lacks Gists → Read and write.';
        }
        if (res.status === 413 || res.status === 422) {
            return `GitHub refused the upload (${res.status}) — the file is likely too large for a gist.`;
        }
        const msg = body && body.message ? ` — ${body.message}` : '';
        return `Sync failed (${res.status})${msg}`;
    }

    async function readBody(res) {
        try { return await res.json(); } catch (e) { return null; }
    }

    /* ---------- load --------------------------------------------------- */

    /* Every collection is optional: a v2 gist has no folders, a v3 gist no
       trash. Reading defensively is what lets an older docket open in a
       newer build without a migration step. */
    function normalise(data) {
        const arr = (v) => (Array.isArray(v) ? v : []);
        return {
            notes: arr(data && data.notes),
            files: arr(data && data.files),
            folders: arr(data && data.folders),
            trash: arr(data && data.trash)
        };
    }

    async function entryText(entry) {
        if (!entry) return '';
        if (entry.truncated && entry.raw_url) {
            const res = await fetch(entry.raw_url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`Could not read gist data (${res.status}).`);
            return res.text();
        }
        return entry.content || '';
    }

    const noteTime = (note) => {
        const time = new Date(note && (note.updated || note.created) || 0).getTime();
        return Number.isFinite(time) ? time : 0;
    };

    /* The archive intentionally contains the last checkpointed copy of the
       hot note. On load, the newer per-note copy wins. A missing archive
       copy means a crash happened before the note's first fold, so the hot
       copy is recovered rather than discarded. */
    function overlayHot(data, records) {
        const byId = new Map(data.notes.map((note, index) => [String(note.id), index]));
        records.sort((a, b) => noteTime(a.note) - noteTime(b.note));
        records.forEach(({ note }) => {
            if (!note || note.id == null) return;
            const id = String(note.id);
            const index = byId.get(id);
            if (index == null) {
                byId.set(id, data.notes.length);
                data.notes.push(note);
            } else if (noteTime(note) >= noteTime(data.notes[index])) {
                data.notes[index] = note;
            }
        });
        return data;
    }

    async function load() {
        if (!isConnected()) { emit('offline'); return null; }

        emit('loading');
        let res;
        try {
            res = await fetch(`${api()}?_=${Date.now()}`, {
                headers: headers(), cache: 'no-store'
            });
        } catch (e) {
            lastError = 'Could not reach GitHub. Check your connection.';
            emit('error', lastError);
            throw new Error(lastError);
        }
        if (!res.ok) {
            const err = new Error(describe(res, await readBody(res), 'read'));
            lastError = err.message;
            emit('error', err.message);
            throw err;
        }

        const json = await res.json();
        const files = json.files || {};

        /* Keep every blob's handle; fetch none of them. */
        blobRefs = {};
        Object.keys(files).forEach((name) => {
            if (name.startsWith(CFG.BLOB_PREFIX)) blobRefs[name] = files[name];
        });

        let data = {};
        const entry = files[CFG.DATA_FILE];
        if (entry) {
            try {
                const text = await entryText(entry);
                data = JSON.parse(text || '{}') || {};
            } catch (e) { data = {}; }
        }

        data = normalise(data);
        const hotNames = Object.keys(files).filter((name) => name.startsWith(CFG.HOT_PREFIX));
        const hotRecords = [];
        await Promise.all(hotNames.map(async (name) => {
            try {
                const parsed = JSON.parse(await entryText(files[name]) || '{}');
                const note = parsed && parsed.note ? parsed.note : parsed;
                if (note && note.id != null) hotRecords.push({ note });
            } catch (e) { /* a partial hot file cannot override the archive */ }
        }));
        loadedHotNames = hotNames;
        overlayHot(data, hotRecords);

        lastError = null;
        emit('synced');
        lastHistory = Array.isArray(json.history) ? json.history : [];

        return data;
    }

    /* ---------- blobs -------------------------------------------------- */

    const blobName = (id) => `${CFG.BLOB_PREFIX}${id}`;

    /** Resolve one file's base64, pulling it only now. Returns '' if the
     *  gist has no such file (metadata without a payload). */
    async function getBlob(id) {
        const name = blobName(id);
        if (blobCache[name] != null) return blobCache[name];
        if (pendingBlobs[name]) return pendingBlobs[name];

        const ref = blobRefs[name];
        if (!ref) return '';

        let text;
        if (ref.truncated && ref.raw_url) {
            const res = await fetch(ref.raw_url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`Could not download that file (${res.status}).`);
            text = await res.text();
        } else {
            text = ref.content || '';
        }
        blobCache[name] = text.trim();
        return blobCache[name];
    }

    function putBlob(id, base64) {
        const name = blobName(id);
        pendingBlobs[name] = base64;
        blobCache[name] = base64;
        schedule();
    }

    function dropBlob(id) {
        const name = blobName(id);
        pendingBlobs[name] = null;     /* null tells GitHub to delete it */
        delete blobCache[name];
        delete blobRefs[name];
        schedule();
    }

    /* ---------- save ---------------------------------------------------- */

    /** The store pulls from this at flush time rather than being handed a
     *  snapshot when the change happens, so a burst of edits always
     *  uploads the latest state instead of a stale one. */
    function bind(dataSource) { sources.data = dataSource; }

    const hotName = (id) => `${CFG.HOT_PREFIX}${encodeURIComponent(String(id))}`;

    function sourceNote(id) {
        const data = sources.data ? sources.data() : null;
        return data && Array.isArray(data.notes)
            ? data.notes.find((note) => String(note.id) === String(id))
            : null;
    }

    /* Plain debouncing starves: someone typing steadily resets the timer
       on every keystroke and nothing ever reaches the gist. The ceiling
       keeps the wait bounded. */
    function schedule() {
        if (!isConnected()) { emit('offline'); return; }

        emit('dirty');
        if (!dirtySince) dirtySince = Date.now();
        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    function queueHotDelete(id) {
        if (id != null) pendingHotDeletes[hotName(id)] = null;
    }

    /* Structural changes are checkpoints. If a note is hot, its current
       in-memory copy is already in the archive payload, so the hot file is
       deleted in that same PATCH. */
    function touchData() {
        clearTimeout(checkpointTimer);
        if (activeHotId != null) queueHotDelete(activeHotId);
        activeHotId = null;
        dirty.hot = false;
        dirty.archive = true;
        schedule();
    }

    /* Typing only dirties the compact hot file. Switching notes first folds
       the previous one, giving the archive one revision per edit session. */
    function touchNote(id) {
        if (id == null) return;
        id = String(id);
        if (activeHotId != null && activeHotId !== id) {
            queueHotDelete(activeHotId);
            dirty.archive = true;
        }
        activeHotId = id;
        dirty.hot = true;
        clearTimeout(checkpointTimer);
        checkpointTimer = setTimeout(() => checkpoint(id), CFG.CHECKPOINT_IDLE_MS);
        schedule();
    }

    function checkpoint(id) {
        if (activeHotId == null || (id != null && String(id) !== activeHotId)) return false;
        clearTimeout(checkpointTimer);
        queueHotDelete(activeHotId);
        activeHotId = null;
        dirty.hot = false;
        dirty.archive = true;
        schedule();
        return true;
    }

    /* load() cannot fold immediately: its caller must first install the
       reconciled notes into the bound data source. */
    function foldLoadedHot() {
        if (!loadedHotNames.length) return false;
        loadedHotNames.forEach((name) => { pendingHotDeletes[name] = null; });
        loadedHotNames = [];
        dirty.archive = true;
        schedule();
        return true;
    }

    const hasPending = () =>
        dirty.archive || dirty.hot || Object.keys(pendingHotDeletes).length > 0 ||
        Object.keys(pendingBlobs).length > 0 || !!inFlight;

    async function flush(options) {
        clearTimeout(flushTimer);
        if (!isConnected()) return;
        if (!dirty.archive && !dirty.hot && !Object.keys(pendingHotDeletes).length &&
                !Object.keys(pendingBlobs).length) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(options); }

        const sendArchive = dirty.archive;
        const sendHotId = dirty.hot ? activeHotId : null;
        const sendHotNote = sendHotId != null ? sourceNote(sendHotId) : null;
        const sendHotDeletes = pendingHotDeletes;
        const sendBlobs = pendingBlobs;
        dirty.archive = false;
        dirty.hot = false;
        pendingHotDeletes = {};
        pendingBlobs = {};
        dirtySince = 0;

        const payload = {};
        if (sendArchive && sources.data) {
            payload[CFG.DATA_FILE] = { content: JSON.stringify(sources.data(), null, 2) };
        }
        Object.keys(sendHotDeletes).forEach((name) => { payload[name] = null; });
        if (sendHotNote) {
            payload[hotName(sendHotId)] = { content: JSON.stringify({
                version: 1, savedAt: new Date().toISOString(), note: sendHotNote
            }) };
        } else if (sendHotId != null) {
            payload[hotName(sendHotId)] = null;
        }
        Object.keys(sendBlobs).forEach((name) => {
            /* null content is how the gist API deletes a file. */
            payload[name] = sendBlobs[name] === null ? null : { content: sendBlobs[name] };
        });

        emit('saving');
        inFlight = (async () => {
            const res = await fetch(api(), {
                method: 'PATCH', headers: headers(),
                body: JSON.stringify({ files: payload }),
                keepalive: Boolean(options && options.keepalive)
            });
            if (!res.ok) {
                /* Put the work back — the change is still unsaved, and the
                   next edit or Retry should carry it up again. */
                dirty.archive = dirty.archive || sendArchive;
                if (sendHotId != null && activeHotId === sendHotId) dirty.hot = true;
                pendingHotDeletes = Object.assign({}, sendHotDeletes, pendingHotDeletes);
                pendingBlobs = Object.assign({}, sendBlobs, pendingBlobs);
                throw new Error(describe(res, await readBody(res), 'write'));
            }
            const json = await readBody(res);
            if (json && Array.isArray(json.history)) lastHistory = json.history;
            /* Written blobs are now readable straight from the gist. */
            Object.keys(sendBlobs).forEach((name) => {
                if (sendBlobs[name] !== null) blobRefs[name] = { content: sendBlobs[name] };
            });
        })();

        try {
            await inFlight;
            lastError = null;
            emit('synced');
        } catch (e) {
            lastError = e.message;
            emit('error', e.message);
        } finally {
            inFlight = null;
        }
        if (hasPending() && !lastError) flush(options);
    }

    /* ---------- version history ---------------------------------------- */

    /* GitHub stamps a revision on every PATCH, so this is history we get
       without storing anything ourselves. Each entry carries a sha, a
       timestamp and the line delta of that save. */
    /* Hot-file durability still creates gist commits. Thin clock-noise into
       progressively wider time buckets, Time-Machine style: ten-minute
       points for the last hour, hourly for a day, daily for a month, then
       weekly. Checkpoint revisions remain useful without forty entries
       being consumed by a few minutes of typing. */
    function thinnedHistory() {
        const rows = lastHistory.slice().sort((a, b) =>
            new Date(b.committed_at || 0) - new Date(a.committed_at || 0));
        if (!rows.length) return [];
        const newest = new Date(rows[0].committed_at || Date.now()).getTime();
        const seen = new Set();
        return rows.filter((row, index) => {
            const at = new Date(row.committed_at || 0).getTime();
            const age = Math.max(0, newest - at);
            const width = age < 3600000 ? 600000
                : age < 86400000 ? 3600000
                : age < 30 * 86400000 ? 86400000
                : 7 * 86400000;
            const key = `${width}:${Math.floor(at / width)}`;
            if (index === 0) { seen.add(key); return true; }
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const history = () => thinnedHistory().slice(0, CFG.HISTORY_LIMIT).map((h) => ({
        sha: h.version,
        at: h.committed_at,
        added: h.change_status && h.change_status.additions,
        removed: h.change_status && h.change_status.deletions
    }));

    /** Read the docket as it was at one revision. Does not restore it —
     *  the caller decides what to do with what comes back. */
    async function atVersion(sha) {
        const res = await fetch(`${api()}/${sha}`, { headers: headers(), cache: 'no-store' });
        if (!res.ok) throw new Error(describe(res, await readBody(res), 'read'));
        const json = await res.json();
        const entry = (json.files || {})[CFG.DATA_FILE];
        if (!entry) throw new Error('That revision has no docket in it.');
        const text = entry.truncated && entry.raw_url
            ? await (await fetch(entry.raw_url, { cache: 'no-store' })).text()
            : entry.content;
        return normalise(JSON.parse(text || '{}'));
    }

    window.DocketStore = {
        load, bind, touchData, touchNote, checkpoint, foldLoadedHot, flush,
        history, atVersion,
        getBlob, putBlob, dropBlob,
        retry: () => { lastError = null; flush(); },
        onStatus: (fn) => listeners.push(fn),
        hasPending,
        lastError: () => lastError,
        isConnected,
        setCredentials,
        credentials: () => ({ token, gistId }),
        /* Settings shows a fingerprint, never the token itself. */
        tokenHint: () => (token ? `${token.slice(0, 7)}…${token.slice(-4)}` : '—')
    };
})();
