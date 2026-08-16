/* ============================================================
   DOCKET SHARING — gist store

   Credentials are the user's own, entered under Settings → Cloud sync
   and held in localStorage on that device. Until both a token and a
   gist id are present the store is simply "not connected": the app
   still runs, notes still persist locally, nothing is uploaded.

   Layout inside the gist:
     docket share.json     notes + file metadata (rewritten on edits)
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
    const dirty = { data: false };
    let pendingBlobs = {};      /* gist filename -> base64 or null (delete) */
    let sources = { data: null };

    let flushTimer = null;
    let inFlight = null;
    let lastError = null;
    let dirtySince = 0;

    /* What the last load told us about each blob file, so a download can
       resolve bytes without re-listing the gist. */
    let blobRefs = {};
    const blobCache = {};

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
                const text = entry.truncated && entry.raw_url
                    ? await (await fetch(entry.raw_url, { cache: 'no-store' })).text()
                    : entry.content;
                data = JSON.parse(text || '{}') || {};
            } catch (e) { data = {}; }
        }

        lastError = null;
        emit('synced');
        return {
            notes: Array.isArray(data.notes) ? data.notes : [],
            files: Array.isArray(data.files) ? data.files : [],
            /* Absent in v2 documents — an older gist just has no folders. */
            folders: Array.isArray(data.folders) ? data.folders : []
        };
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
        touch();
    }

    function dropBlob(id) {
        const name = blobName(id);
        pendingBlobs[name] = null;     /* null tells GitHub to delete it */
        delete blobCache[name];
        delete blobRefs[name];
        touch();
    }

    /* ---------- save ---------------------------------------------------- */

    /** The store pulls from this at flush time rather than being handed a
     *  snapshot when the change happens, so a burst of edits always
     *  uploads the latest state instead of a stale one. */
    function bind(dataSource) { sources.data = dataSource; }

    /* Plain debouncing starves: someone typing steadily resets the timer
       on every keystroke and nothing ever reaches the gist. The ceiling
       keeps the wait bounded. */
    function touch(which) {
        if (which !== 'blobsOnly') dirty.data = true;
        if (!isConnected()) { emit('offline'); return; }

        emit('dirty');
        if (!dirtySince) dirtySince = Date.now();
        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    const touchData = () => touch();

    const hasPending = () =>
        dirty.data || Object.keys(pendingBlobs).length > 0 || !!inFlight;

    async function flush() {
        clearTimeout(flushTimer);
        if (!isConnected()) return;
        if (!dirty.data && !Object.keys(pendingBlobs).length) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(); }

        const sendData = dirty.data;
        const sendBlobs = pendingBlobs;
        dirty.data = false;
        pendingBlobs = {};
        dirtySince = 0;

        const payload = {};
        if (sendData) {
            payload[CFG.DATA_FILE] = { content: JSON.stringify(sources.data(), null, 2) };
        }
        Object.keys(sendBlobs).forEach((name) => {
            /* null content is how the gist API deletes a file. */
            payload[name] = sendBlobs[name] === null ? null : { content: sendBlobs[name] };
        });

        emit('saving');
        inFlight = (async () => {
            const res = await fetch(api(), {
                method: 'PATCH', headers: headers(),
                body: JSON.stringify({ files: payload })
            });
            if (!res.ok) {
                /* Put the work back — the change is still unsaved, and the
                   next edit or Retry should carry it up again. */
                dirty.data = dirty.data || sendData;
                pendingBlobs = Object.assign({}, sendBlobs, pendingBlobs);
                throw new Error(describe(res, await readBody(res), 'write'));
            }
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
        if (hasPending() && !lastError) flush();
    }

    window.DocketStore = {
        load, bind, touchData, flush,
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
