/* ============================================================
   DOCKET SHARING — gist store

   The gist is the only backend. Everything the app knows lives in two
   files inside it: `docket share.json` (notes + file metadata) and
   `docket-blobs.json` (base64 payloads).

   Writes are queued rather than fired per-change. A PATCH only touches
   the files it names, so a notes save and a blob save can be coalesced
   into one request, and only ever one request is in flight at a time —
   two overlapping PATCHes to the same gist can land out of order and
   silently undo each other.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const API = `https://api.github.com/gists/${CFG.GIST_ID}`;
    const TOKEN_OVERRIDE_KEY = 'docket.tokenOverride';

    let token = null;
    let listeners = [];

    /* Dirty flags + the getters that produce a payload when we flush. */
    const dirty = { data: false, blobs: false };
    let sources = { data: null, blobs: null };

    let flushTimer = null;
    let inFlight = null;
    let lastError = null;
    let dirtySince = 0;   /* when the oldest unsaved change arrived */

    const emit = (state, detail) => listeners.forEach((fn) => fn(state, detail));

    /* ---------- token ---------------------------------------------- */

    /** A token pasted into Settings wins over the sealed one, so a
     *  re-scoped or rotated PAT can be dropped in without a redeploy. */
    function tokenOverride() {
        try { return localStorage.getItem(TOKEN_OVERRIDE_KEY) || ''; } catch (e) { return ''; }
    }

    function setTokenOverride(value) {
        const trimmed = (value || '').trim();
        try {
            if (trimmed) localStorage.setItem(TOKEN_OVERRIDE_KEY, trimmed);
            else localStorage.removeItem(TOKEN_OVERRIDE_KEY);
        } catch (e) { /* private mode — the in-memory token still applies */ }
        if (trimmed) token = trimmed;
    }

    async function unlock(passkey) {
        const override = tokenOverride();
        if (override) { token = override; return; }
        token = await window.DocketCrypto.unseal(
            CFG.SEALED_TOKEN, passkey, CFG.KDF_ITERATIONS
        );
    }

    const headers = () => ({
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
    });

    /* ---------- errors ----------------------------------------------- */

    /* GitHub's own wording for a scope problem ("Resource not accessible by
       personal access token") tells you nothing about how to fix it, and
       this is the single most likely thing to go wrong with a fine-grained
       PAT, so it gets translated. */
    function describe(res, body, verb) {
        if (res.status === 401) {
            return 'GitHub rejected the token (401). It may have been revoked or expired — paste a fresh one in Settings.';
        }
        if (res.status === 403) {
            return `The token is not allowed to ${verb} this gist (403). Give it Account permissions → Gists → Read and write, then reload.`;
        }
        if (res.status === 404) {
            return verb === 'read'
                ? 'No gist found at that id (404) — check GIST_ID, or the token may not be allowed to see it.'
                : 'Cannot write this gist (404). Usually the token lacks Gists → Read and write.';
        }
        if (res.status === 422) {
            return 'GitHub refused the payload (422) — usually a file over the size limit.';
        }
        const msg = body && body.message ? ` — ${body.message}` : '';
        return `Sync failed (${res.status})${msg}`;
    }

    async function readBody(res) {
        try { return await res.json(); } catch (e) { return null; }
    }

    /* ---------- load -------------------------------------------------- */

    function parseFile(files, name, fallback) {
        const entry = files && files[name];
        if (!entry) return fallback;
        /* Gist files past ~1 MB come back truncated with a raw_url instead
           of inline content; that mostly means the blob file. */
        if (entry.truncated && entry.raw_url) return { __truncated: entry.raw_url };
        try { return JSON.parse(entry.content || 'null') ?? fallback; }
        catch (e) { return fallback; }
    }

    async function resolveTruncated(value, fallback) {
        if (!value || !value.__truncated) return value;
        try {
            const res = await fetch(value.__truncated, { cache: 'no-store' });
            return JSON.parse(await res.text());
        } catch (e) { return fallback; }
    }

    async function load() {
        emit('loading');
        const res = await fetch(`${API}?_=${Date.now()}`, {
            headers: headers(), cache: 'no-store'
        });
        if (!res.ok) {
            const body = await readBody(res);
            const err = new Error(describe(res, body, 'read'));
            lastError = err.message;
            emit('error', err.message);
            throw err;
        }
        const json = await res.json();
        const files = json.files || {};

        let data = parseFile(files, CFG.DATA_FILE, {});
        let blobs = parseFile(files, CFG.BLOB_FILE, {});
        data = await resolveTruncated(data, {});
        blobs = await resolveTruncated(blobs, {});

        lastError = null;
        emit('synced');
        return {
            notes: Array.isArray(data.notes) ? data.notes : [],
            files: Array.isArray(data.files) ? data.files : [],
            blobs: blobs && typeof blobs === 'object' ? blobs : {}
        };
    }

    /* ---------- save -------------------------------------------------- */

    /** Register the functions that produce each gist file's contents.
     *  The store pulls from these at flush time rather than being handed a
     *  snapshot at request time, so a burst of edits always uploads the
     *  latest state instead of a stale one. */
    function bind(dataSource, blobSource) {
        sources = { data: dataSource, blobs: blobSource };
    }

    /* Plain debouncing starves: someone typing steadily resets the timer on
       every keystroke and nothing ever reaches the gist. The ceiling makes
       the wait bounded — quiet typing still coalesces into one PATCH, but a
       long unbroken run gets checkpointed every MAX_SAVE_WAIT_MS. */
    function touch(which) {
        dirty[which] = true;
        emit('dirty');
        if (!dirtySince) dirtySince = Date.now();

        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    const touchData = () => touch('data');
    const touchBlobs = () => touch('blobs');

    async function flush() {
        clearTimeout(flushTimer);
        if (!dirty.data && !dirty.blobs) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(); }

        const sending = { data: dirty.data, blobs: dirty.blobs };
        dirty.data = false;
        dirty.blobs = false;
        dirtySince = 0;

        const payload = {};
        if (sending.data) {
            payload[CFG.DATA_FILE] = { content: JSON.stringify(sources.data(), null, 2) };
        }
        if (sending.blobs) {
            payload[CFG.BLOB_FILE] = { content: JSON.stringify(sources.blobs()) };
        }

        emit('saving');
        inFlight = (async () => {
            const res = await fetch(API, {
                method: 'PATCH', headers: headers(),
                body: JSON.stringify({ files: payload })
            });
            if (!res.ok) {
                /* Put the flags back — the change is still unsaved, and the
                   next edit (or Retry) should carry it up again. */
                dirty.data = dirty.data || sending.data;
                dirty.blobs = dirty.blobs || sending.blobs;
                throw new Error(describe(res, await readBody(res), 'write'));
            }
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
        /* An edit that landed mid-request left the flags set; go again. */
        if ((dirty.data || dirty.blobs) && !lastError) flush();
    }

    window.DocketStore = {
        unlock, load, bind, touchData, touchBlobs,
        flush,
        retry: () => { lastError = null; flush(); },
        onStatus: (fn) => listeners.push(fn),
        hasPending: () => dirty.data || dirty.blobs || !!inFlight,
        lastError: () => lastError,
        tokenOverride, setTokenOverride,
        /* Settings shows a fingerprint rather than the token itself. */
        tokenHint: () => (token ? `${token.slice(0, 11)}…${token.slice(-4)}` : '—')
    };
})();
