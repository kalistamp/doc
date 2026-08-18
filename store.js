/* ============================================================
   DOCKET SHARING — gist store

   Credentials are the user's own, entered under Settings → Cloud sync
   and held in localStorage on that device. Until both a token and a
   gist id are present the store is simply "not connected": the app
   still runs, notes still persist locally, nothing is uploaded.

   Layout inside the gist:
     docket share.json     cold archive, rewritten at checkpoints
     docket-hot-<id>       one per browser currently editing a note
     docket-blob-<id>      one file per upload, base64

   Blobs are NOT downloaded on load. The gist listing gives us each
   file's content or a raw_url, and we only pull the bytes when someone
   actually downloads or copies that file — so a docket holding 200 MB
   opens as fast as an empty one.

   Writes are queued: a PATCH only touches the files it names, so
   several changes coalesce into one request, and only one request is
   ever in flight — two overlapping PATCHes can land out of order and
   silently undo each other.

   That queue only orders THIS browser's writes. Two browsers on one
   gist are two writers with no lock between them, and a whole-archive
   PATCH built from stale memory replaces the other one's docket
   wholesale. Three things keep that from happening:

     · a write that rewrites the archive first asks GitHub whether the
       gist has moved since we last read it, and reconciles if it has;
     · reconciling is a merge by id and timestamp, with `trash` acting
       as the tombstone that lets a delete survive the merge;
     · a hot file is stamped with the client that owns it, so opening a
       second window no longer deletes the first one's live draft.
   ============================================================ */

(function () {
    const CFG = window.DOCKET_CONFIG;
    const TOKEN_KEY = 'docket.token';
    const GIST_KEY = 'docket.gistId';

    let token = readLS(TOKEN_KEY);
    let gistId = readLS(GIST_KEY);
    let listeners = [];

    /* Who this browser is, for the length of this page load. It is only
       ever compared to itself, so a random handle is enough — no identity,
       nothing stored, nothing to collide with across devices. */
    const CLIENT_ID = Math.random().toString(36).slice(2, 10);

    /* Dirty flags + the getters that produce a payload when we flush. */
    const dirty = { archive: false, hot: false };
    let pendingBlobs = {};      /* gist filename -> base64 or null (delete) */
    let pendingHotDeletes = {}; /* hot filename -> null */
    let sources = { data: null, adopt: null };

    let activeHotId = null;
    let loadedHotNames = [];
    let hotOwners = {};         /* hot filename -> { client, savedAt } */
    let checkpointTimer = null;

    let flushTimer = null;
    let inFlight = null;
    let lastError = null;
    let dirtySince = 0;

    /* A save that fails is not a save that is abandoned. Nothing rearmed
       the clock before, so one dropped packet parked the docket on
       "Failed" until the user noticed and pressed Retry. */
    let retryTimer = null;
    let retryDelay = 0;

    /* What GitHub last told us the gist looked like. The etag makes the
       pre-write check cheap — an unchanged gist answers 304 with no body
       and no rate-limit cost — and the revision is the same answer for a
       response that arrives without one. */
    let etag = '';
    let headVersion = '';

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
        /* A different gist is a different document: nothing we know about
           the old one may be used to guard a write to the new one. */
        etag = '';
        headVersion = '';
        blobRefs = {};
        loadedHotNames = [];
        hotOwners = {};
    }

    const api = () => `https://api.github.com/gists/${gistId}`;

    const headers = () => ({
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
    });

    /* ---------- errors ------------------------------------------------ */

    /* Test doubles and 304s arrive without a headers bag; every read of
       one goes through here so none of them has to care. */
    function header(res, name) {
        return (res && res.headers && res.headers.get && res.headers.get(name)) || '';
    }

    /* GitHub spends 403 on two completely different problems: a token that
       is not allowed to do this, and a token that has been doing it too
       often. Telling them apart matters — the first is a setting the user
       must change, the second fixes itself if we simply wait. */
    function isRateLimited(res, body) {
        if (res.status === 429) return true;
        if (res.status !== 403) return false;
        if (header(res, 'retry-after')) return true;
        if (header(res, 'x-ratelimit-remaining') === '0') return true;
        const msg = String((body && body.message) || '').toLowerCase();
        return msg.includes('rate limit') || msg.includes('abuse');
    }

    function retryAfterMs(res) {
        const after = Number(header(res, 'retry-after'));
        if (after > 0) return after * 1000;
        const reset = Number(header(res, 'x-ratelimit-reset'));
        if (reset > 0) return Math.max(0, reset * 1000 - Date.now());
        return 0;
    }

    /* GitHub's own wording for a scope problem ("Resource not accessible
       by personal access token") says nothing about how to fix it, and
       it is the single most likely thing to go wrong. */
    function describe(res, body, verb) {
        if (isRateLimited(res, body)) {
            const wait = retryAfterMs(res);
            return 'GitHub is rate-limiting this token' +
                (wait ? ` — retrying in ${Math.ceil(wait / 1000)}s. ` : ' — retrying shortly. ') +
                'Several browsers saving into one gist can reach its write limit.';
        }
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
        if (res.status === 409) {
            return 'Another browser wrote to this gist at the same moment (409) — retrying.';
        }
        if (res.status === 413 || res.status === 422) {
            return `GitHub refused the upload (${res.status}) — the file is likely too large for a gist.`;
        }
        const msg = body && body.message ? ` — ${body.message}` : '';
        return `Sync failed (${res.status})${msg}`;
    }

    /* Only some failures are worth trying again. A 401 or a missing scope
       will fail identically forever and retrying it just burns quota. */
    function failure(res, body, verb) {
        const err = new Error(describe(res, body, verb));
        err.status = res.status;
        err.retryable = res.status >= 500 || res.status === 409 ||
                        isRateLimited(res, body);
        err.retryAfter = retryAfterMs(res);
        return err;
    }

    function transient(message) {
        const err = new Error(message);
        err.retryable = true;
        return err;
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

    /* ---------- the band flags' own clocks ------------------------------ */

    /* Every other change to a note is dated by `updated`, and every
       reconciliation below picks a whole winner by comparing it. Two
       changes deliberately opt out — pinning a note, and marking it to
       finish next. Neither is an edit, and a note you merely flagged must
       not look freshly written and jump up a recently-updated sort.

       That leaves both flags invisible to those comparisons. Two copies of
       a note differing only in a flag are identical in every field the
       comparison reads, so the flag never travels on its own merit — it
       survives only where the tie happens to fall, which is always the
       browser doing the reconciling. A pin made HERE is kept, and a pin
       made anywhere else is dropped, then written back out as an unpin.

       So each flag carries its own stamp and is reconciled on its own
       axis: whichever side changed that flag last says what it is, whoever
       wins the note itself. The stamp is written when the flag comes off as
       well as when it goes on — clearing one is a change like any other and
       needs a date, or it could never out-argue the flag it undoes. Only a
       set flag's stamp is ever read for anything else (its band orders by
       it), so carrying one on a note that is not flagged costs nothing.

       The two axes are separate, so a pin made here and a Finish Next made
       on the phone both land on the same note rather than one of them
       taking the other's place. */

    const BAND_FLAGS = [
        { on: 'pinned', at: 'pinnedAt' },
        { on: 'finishNext', at: 'finishNextAt' }
    ];

    const flagTime = (item, key) => Date.parse((item && item[key]) || '') || 0;

    /** The winning copy of an item, wearing whichever side set each band
     *  flag most recently. Copies rather than mutates: both dockets belong
     *  to their callers. A tie keeps the winner's own flag, which is what
     *  makes a docket written before the flags were stamped — or before
     *  Finish Next existed at all — merge as it always did. */
    function withFlags(winner, loser) {
        if (!loser || loser === winner) return winner;
        let out = winner;
        BAND_FLAGS.forEach(({ on, at }) => {
            if (flagTime(loser, at) <= flagTime(out, at)) return;
            out = Object.assign({}, out, { [on]: !!loser[on], [at]: loser[at] || null });
        });
        return out;
    }

    /* The archive intentionally contains the last checkpointed copy of the
       hot note. On load, the newer per-note copy wins. A missing archive
       copy means a crash happened before the note's first fold, so the hot
       copy is recovered rather than discarded.

       A hot file is a snapshot of a note as one browser was typing it, and
       it knows nothing of a pin another browser put on that note since. It
       still carries a `pinned` field, so replacing wholesale would quietly
       strip the pin off again — this time before the merge downstream ever
       sees it. Both directions therefore go through withFlags, which does
       the same for Finish Next. */
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
                data.notes[index] = withFlags(note, data.notes[index]);
            } else {
                data.notes[index] = withFlags(data.notes[index], note);
            }
        });
        return data;
    }

    const revisionOf = (json) =>
        (Array.isArray(json && json.history) && json.history[0] &&
         json.history[0].version) || '';

    /**
     * GET the gist. With `conditional`, ask GitHub to answer 304 when
     * nothing has changed since we last read or wrote — a 304 carries no
     * body and no primary rate-limit cost, which is exactly what makes it
     * affordable to check before every archive write. Returns null for a
     * 304, meaning "still ours to overwrite".
     */
    async function fetchGist(conditional) {
        const head = headers();
        if (conditional && etag) head['If-None-Match'] = etag;

        let res;
        try {
            res = await fetch(conditional ? api() : `${api()}?_=${Date.now()}`, {
                headers: head, cache: 'no-store'
            });
        } catch (e) {
            throw transient('Could not reach GitHub. Check your connection.');
        }
        if (res.status === 304) return null;
        if (!res.ok) throw failure(res, await readBody(res), 'read');

        const tag = header(res, 'etag');
        if (tag) etag = tag;
        const json = await res.json();
        headVersion = revisionOf(json) || headVersion;
        return json;
    }

    /**
     * One parsed view of a gist response: the archive with any hot notes
     * overlaid, plus the bookkeeping a later write needs. load() and the
     * pre-write guard share it so both reconcile identically.
     */
    async function absorb(json) {
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
        const records = [];
        const owners = {};
        await Promise.all(hotNames.map(async (name) => {
            try {
                const parsed = JSON.parse(await entryText(files[name]) || '{}');
                const note = parsed && parsed.note ? parsed.note : parsed;
                owners[name] = {
                    client: (parsed && parsed.client) || '',
                    savedAt: Date.parse((parsed && parsed.savedAt) || '') || 0
                };
                if (note && note.id != null) records.push({ note });
            } catch (e) { /* a partial hot file cannot override the archive */ }
        }));
        overlayHot(data, records);

        loadedHotNames = hotNames;
        hotOwners = owners;
        lastHistory = Array.isArray(json.history) ? json.history : [];
        return data;
    }

    async function load() {
        if (!isConnected()) { emit('offline'); return null; }

        emit('loading');
        let json;
        try {
            json = await fetchGist(false);
        } catch (e) {
            lastError = e.message;
            emit('error', e.message);
            throw e;
        }

        const data = await absorb(json);
        lastError = null;
        emit('synced');
        return data;
    }

    /* ---------- merge --------------------------------------------------- */

    /* Two browsers hold two whole dockets, and a write has to combine them
       rather than pick one. Items reconcile by id on their own timestamp.
       A deletion is not an absence — it is an entry in `trash` — which is
       what lets a delete made on one machine survive being merged with a
       machine that still has the item sitting in its list. */

    const stampOf = (item) =>
        Date.parse((item && (item.updated || item.added || item.created)) || '') || 0;
    const binnedAt = (entry) =>
        Date.parse((entry && entry.deletedAt) || '') || 0;

    function mergeCollection(remote, local, graves) {
        const out = [];
        const at = new Map();
        const take = (item) => {
            if (!item || item.id == null) return;
            const id = String(item.id);
            const index = at.get(id);
            if (index == null) { at.set(id, out.length); out.push(item); return; }
            const held = out[index];
            const winner = stampOf(item) >= stampOf(held) ? item : held;
            /* The loser is not discarded outright: the band flags it
               carries are dated on their own clocks and may be the later
               word, whichever copy of the note itself won. */
            out[index] = withFlags(winner, winner === item ? held : item);
        };
        /* Local goes second, and a tie goes to whoever went second, so the
           browser doing the reconciling keeps its own copy when neither
           side is newer. That settles the note; `pinnedAt` and
           `finishNextAt` settle the band flags, which are the changes that
           deliberately never bump `updated` and so can never win that
           comparison on their own. */
        (remote || []).forEach(take);
        (local || []).forEach(take);

        /* A tombstone wins unless the item was edited after it was binned.
           Deleting on one machine while editing on another is a conflict
           like any other, and it resolves the same way: last write wins. */
        return out.filter((item) => {
            const grave = graves.get(String(item.id));
            return !grave || stampOf(item) > grave;
        });
    }

    function mergeTrash(remote, local) {
        const at = new Map();
        [].concat(remote || [], local || []).forEach((entry) => {
            if (!entry || !entry.item || entry.item.id == null) return;
            const id = String(entry.item.id);
            const kept = at.get(id);
            if (!kept) { at.set(id, entry); return; }

            /* The earliest deletion is the one that actually happened; a
               purge is sticky, because the whole point of the stripped
               tombstone it leaves is to stop the item coming back. */
            const a = binnedAt(kept);
            const b = binnedAt(entry);
            const earlier = (b && (!a || b < a)) ? entry : kept;
            at.set(id, (kept.purged || entry.purged)
                ? { kind: earlier.kind, item: { id: earlier.item.id },
                    deletedAt: earlier.deletedAt, purged: true }
                : earlier);
        });
        return Array.from(at.values())
            .sort((x, y) => binnedAt(y) - binnedAt(x));
    }

    /** Reconcile a remote docket with a local one. Pure — it reads neither
     *  and returns a third. */
    function mergeDocket(remote, local) {
        const a = normalise(remote);
        const b = normalise(local);
        const trash = mergeTrash(a.trash, b.trash);
        const graves = new Map(trash.map((t) => [String(t.item.id), binnedAt(t)]));

        const merged = {
            notes: mergeCollection(a.notes, b.notes, graves),
            files: mergeCollection(a.files, b.files, graves),
            folders: mergeCollection(a.folders, b.folders, graves),
            trash
        };

        /* An item edited back out of the trash takes its tombstone with it,
           or the next merge would bin it all over again. */
        const alive = new Set([]
            .concat(merged.notes, merged.files, merged.folders)
            .map((item) => String(item.id)));
        merged.trash = merged.trash.filter((t) => !alive.has(String(t.item.id)));
        return merged;
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

    /** The store pulls from `read` at flush time rather than being handed a
     *  snapshot when the change happens, so a burst of edits always uploads
     *  the latest state instead of a stale one. `adopt` is the other
     *  direction: the store calls it with a reconciled docket when a read
     *  finds the gist has moved under us. */
    function bind(read, adopt) {
        sources.data = read;
        sources.adopt = adopt || null;
    }

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
        /* A fresh edit supersedes a pending retry: the flush it is about to
           trigger carries the failed work up with it. */
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    function scheduleRetry(err) {
        clearTimeout(retryTimer);
        const wait = (err && err.retryAfter) ||
            (retryDelay ? Math.min(retryDelay * 2, CFG.RETRY_MAX_MS) : CFG.RETRY_BASE_MS);
        retryDelay = Math.min(wait, CFG.RETRY_MAX_MS);
        retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelay);
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

    /* Fold the hot files a load turned up — but only the ones it is ours to
       fold. A hot file another browser is still writing into is that
       browser's unsaved draft, and deleting it because we happened to open
       the app is how a second window destroys the first one's work. Ours,
       files from a build that stamped no owner, and genuinely abandoned
       ones still fold, so crash recovery is unaffected.

       load() cannot fold immediately: its caller must first install the
       reconciled notes into the bound data source. */
    function foldLoadedHot() {
        const foldable = loadedHotNames.filter((name) => {
            const owner = hotOwners[name] || {};
            if (!owner.client || owner.client === CLIENT_ID) return true;
            return Boolean(owner.savedAt) &&
                   Date.now() - owner.savedAt > CFG.HOT_STALE_MS;
        });
        loadedHotNames = [];
        if (!foldable.length) return false;
        foldable.forEach((name) => { pendingHotDeletes[name] = null; });
        dirty.archive = true;
        schedule();
        return true;
    }

    const hasPending = () =>
        dirty.archive || dirty.hot || Object.keys(pendingHotDeletes).length > 0 ||
        Object.keys(pendingBlobs).length > 0 || !!inFlight;

    /**
     * Ask whether the gist moved under us, and reconcile if it did.
     *
     * Only ever called before a write that rewrites the whole archive,
     * because that is the only payload capable of undoing another
     * browser's work. Hot files are named per note and per writer, and
     * blobs per upload, so those need no guard and stay at one request.
     */
    async function reconcile() {
        if (!sources.adopt || !sources.data) return;
        const json = await fetchGist(true);
        if (!json) return;                    /* 304 — nothing moved */
        const remote = await absorb(json);
        sources.adopt(mergeDocket(remote, sources.data()));
    }

    async function flush(options) {
        clearTimeout(flushTimer);
        if (!isConnected()) return;
        if (!dirty.archive && !dirty.hot && !Object.keys(pendingHotDeletes).length &&
                !Object.keys(pendingBlobs).length) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(options); }

        const sendArchive = dirty.archive;
        const sendHotId = dirty.hot ? activeHotId : null;
        const sendHotDeletes = pendingHotDeletes;
        const sendBlobs = pendingBlobs;
        dirty.archive = false;
        dirty.hot = false;
        pendingHotDeletes = {};
        pendingBlobs = {};
        dirtySince = 0;

        /* Put the work back — the change is still unsaved, and the next
           edit, the retry timer or the Retry button should carry it up
           again. Reachable from the guard read as well as the write, so
           neither can drop a pending change on the floor. */
        const restore = () => {
            dirty.archive = dirty.archive || sendArchive;
            if (sendHotId != null && activeHotId === sendHotId) dirty.hot = true;
            pendingHotDeletes = Object.assign({}, sendHotDeletes, pendingHotDeletes);
            pendingBlobs = Object.assign({}, sendBlobs, pendingBlobs);
        };

        /* An unload has no time for a round trip, so it writes unguarded
           and accepts last-write-wins for whatever is still dirty. */
        const guarded = sendArchive && !(options && options.unguarded);

        emit('saving');
        inFlight = (async () => {
            try {
                if (guarded) await reconcile();

                /* Built after the merge, so what goes up is the reconciled
                   docket rather than the one we walked in with. */
                const payload = {};
                if (sendArchive && sources.data) {
                    payload[CFG.DATA_FILE] = { content: JSON.stringify(sources.data(), null, 2) };
                }
                Object.keys(sendHotDeletes).forEach((name) => { payload[name] = null; });

                const sendHotNote = sendHotId != null ? sourceNote(sendHotId) : null;
                if (sendHotNote) {
                    payload[hotName(sendHotId)] = { content: JSON.stringify({
                        version: 1, client: CLIENT_ID,
                        savedAt: new Date().toISOString(), note: sendHotNote
                    }) };
                } else if (sendHotId != null) {
                    payload[hotName(sendHotId)] = null;
                }
                Object.keys(sendBlobs).forEach((name) => {
                    /* null content is how the gist API deletes a file. */
                    payload[name] = sendBlobs[name] === null ? null : { content: sendBlobs[name] };
                });

                let res;
                try {
                    res = await fetch(api(), {
                        method: 'PATCH', headers: headers(),
                        body: JSON.stringify({ files: payload }),
                        keepalive: Boolean(options && options.keepalive)
                    });
                } catch (e) {
                    throw transient('Could not reach GitHub. Check your connection.');
                }
                if (!res.ok) throw failure(res, await readBody(res), 'write');

                /* Our own write moved the gist; record where to, so the next
                   guard read can answer 304 instead of pulling the lot. */
                const tag = header(res, 'etag');
                if (tag) etag = tag;
                const json = await readBody(res);
                if (json && Array.isArray(json.history)) lastHistory = json.history;
                headVersion = revisionOf(json) || headVersion;

                /* Written blobs are now readable straight from the gist. */
                Object.keys(sendBlobs).forEach((name) => {
                    if (sendBlobs[name] !== null) blobRefs[name] = { content: sendBlobs[name] };
                });
            } catch (e) {
                restore();
                throw e;
            }
        })();

        try {
            await inFlight;
            lastError = null;
            retryDelay = 0;
            emit('synced');
        } catch (e) {
            lastError = e.message;
            emit('error', e.message);
            if (e.retryable) scheduleRetry(e);
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
        if (!res.ok) throw failure(res, await readBody(res), 'read');
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
        merge: mergeDocket,
        retry: () => {
            clearTimeout(retryTimer);
            retryTimer = null;
            retryDelay = 0;
            lastError = null;
            flush();
        },
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
