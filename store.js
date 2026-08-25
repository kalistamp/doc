/* Docket persistence: Supabase Auth + the isolated `doc` Postgres schema. */
(function () {
    'use strict';

    const CFG = window.DOCKET_CONFIG;
    const CLIENT_ID = Math.random().toString(36).slice(2, 10);
    let clientInstance = null;
    let userId = null;
    let userEmail = '';
    let remoteVersion = 0;
    let listeners = [];
    let sources = { data: null, adopt: null };
    let lastHistory = [];
    let loadedDrafts = [];
    let activeNoteId = null;
    let checkpointTimer = null;
    let flushTimer = null;
    let retryTimer = null;
    let retryDelay = 0;
    let dirtySince = 0;
    let inFlight = null;
    let lastError = null;
    const dirty = { archive: false, draft: false };
    let pendingDraftDeletes = new Set();
    let pendingBlobs = new Map();
    const blobCache = new Map();

    const emit = (state, detail) => listeners.forEach((fn) => fn(state, detail));
    const normalise = (data) => {
        const arr = (value) => Array.isArray(value) ? value : [];
        return {
            notes: arr(data && data.notes),
            files: arr(data && data.files),
            folders: arr(data && data.folders),
            trash: arr(data && data.trash)
        };
    };

    function configured() {
        const config = window.SUPABASE_CONFIG;
        return Boolean(config && config.url && config.publishableKey && config.schema &&
            config.url.startsWith('https://'));
    }

    function client() {
        if (clientInstance) return clientInstance;
        if (!configured() || !window.supabase || !window.supabase.createClient) return null;
        const config = window.SUPABASE_CONFIG;
        clientInstance = window.supabase.createClient(config.url, config.publishableKey, {
            db: { schema: config.schema },
            auth: { persistSession: true, autoRefreshToken: true }
        });
        return clientInstance;
    }

    function installSession(session) {
        userId = session && session.user ? session.user.id : null;
        userEmail = session && session.user ? session.user.email || '' : '';
        return session || null;
    }

    async function getSession() {
        const c = client();
        if (!c) return null;
        const { data, error } = await c.auth.getSession();
        if (error) throw new Error(error.message);
        return installSession(data && data.session);
    }

    async function signIn(email, password) {
        const c = client();
        if (!c) return { ok: false, error: 'Cloud sync is not configured.' };
        const { data, error } = await c.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, error: error.message };
        installSession(data.session);
        return { ok: true, session: data.session };
    }

    async function signOut() {
        const c = client();
        userId = null;
        userEmail = '';
        remoteVersion = 0;
        if (c) await c.auth.signOut();
    }

    async function requireUser() {
        if (userId) return userId;
        const session = await getSession();
        if (!session) throw new Error('Your session expired. Sign in again.');
        return userId;
    }

    const isConnected = () => Boolean(userId && client());
    const noteTime = (note) => {
        const value = new Date(note && (note.updated || note.created) || 0).getTime();
        return Number.isFinite(value) ? value : 0;
    };
    const STAMPED = [
        { on: 'pinned', at: 'pinnedAt', cast: (v) => !!v },
        { on: 'finishNext', at: 'finishNextAt', cast: (v) => !!v },
        { on: 'markdown', at: 'markdownAt', cast: (v) => v == null ? null : !!v }
    ];
    const flagTime = (item, key) => Date.parse((item && item[key]) || '') || 0;

    function withFlags(winner, loser) {
        if (!loser || loser === winner) return winner;
        let out = winner;
        STAMPED.forEach(({ on, at, cast }) => {
            if (flagTime(loser, at) <= flagTime(out, at)) return;
            out = Object.assign({}, out, { [on]: cast(loser[on]), [at]: loser[at] || null });
        });
        return out;
    }

    function overlayDrafts(data, records) {
        const byId = new Map(data.notes.map((note, index) => [String(note.id), index]));
        records.slice().sort((a, b) => noteTime(a.note) - noteTime(b.note)).forEach(({ note }) => {
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

    const stampOf = (item) =>
        Date.parse((item && (item.updated || item.added || item.created)) || '') || 0;
    const binnedAt = (entry) => Date.parse((entry && entry.deletedAt) || '') || 0;

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
            out[index] = withFlags(winner, winner === item ? held : item);
        };
        (remote || []).forEach(take);
        (local || []).forEach(take);
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
            const earlier = binnedAt(entry) && (!binnedAt(kept) || binnedAt(entry) < binnedAt(kept))
                ? entry : kept;
            at.set(id, (kept.purged || entry.purged)
                ? { kind: earlier.kind, item: { id: earlier.item.id },
                    deletedAt: earlier.deletedAt, purged: true }
                : earlier);
        });
        return Array.from(at.values()).sort((a, b) => binnedAt(b) - binnedAt(a));
    }

    function mergeDocket(remote, local) {
        const a = normalise(remote);
        const b = normalise(local);
        const trash = mergeTrash(a.trash, b.trash);
        const graves = new Map(trash.map((entry) => [String(entry.item.id), binnedAt(entry)]));
        const merged = {
            notes: mergeCollection(a.notes, b.notes, graves),
            files: mergeCollection(a.files, b.files, graves),
            folders: mergeCollection(a.folders, b.folders, graves),
            trash
        };
        const alive = new Set([].concat(merged.notes, merged.files, merged.folders)
            .map((item) => String(item.id)));
        merged.trash = merged.trash.filter((entry) => !alive.has(String(entry.item.id)));
        return merged;
    }

    function bind(read, adopt) {
        sources.data = read;
        sources.adopt = adopt || null;
    }

    async function readDocument(includeDrafts) {
        const c = client();
        const id = await requireUser();
        const requests = [
            c.from('documents').select('data,version').eq('user_id', id).maybeSingle(),
            c.from('revisions').select('id,created_at').eq('user_id', id)
                .order('created_at', { ascending: false }).limit(200)
        ];
        if (includeDrafts) {
            requests.push(c.from('drafts').select('note_id,client_id,note,saved_at')
                .eq('user_id', id));
        }
        const results = await Promise.all(requests);
        results.forEach((result) => { if (result.error) throw new Error(result.error.message); });
        const row = results[0].data;
        remoteVersion = Number(row && row.version || 0);
        lastHistory = results[1].data || [];
        let docket = normalise(row && row.data);
        if (includeDrafts) {
            loadedDrafts = results[2].data || [];
            docket = overlayDrafts(docket, loadedDrafts);
        }
        return docket;
    }

    async function load() {
        if (!isConnected()) { emit('offline'); return null; }
        emit('loading');
        try {
            const data = await readDocument(true);
            emit('synced');
            return data;
        } catch (error) {
            lastError = error.message;
            emit('error', error.message);
            throw error;
        }
    }

    const draftKey = (noteId, clientId) => `${String(noteId)}\u0000${String(clientId)}`;
    const parseDraftKey = (key) => {
        const index = key.indexOf('\u0000');
        return { noteId: key.slice(0, index), clientId: key.slice(index + 1) };
    };
    const sourceNote = (id) => {
        const data = sources.data ? sources.data() : null;
        return data && Array.isArray(data.notes)
            ? data.notes.find((note) => String(note.id) === String(id)) : null;
    };

    function schedule() {
        if (!isConnected()) { emit('offline'); return; }
        emit('dirty');
        if (!dirtySince) dirtySince = Date.now();
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    function queueCurrentDraftDelete(id) {
        if (id != null) pendingDraftDeletes.add(draftKey(id, CLIENT_ID));
    }

    function touchData() {
        clearTimeout(checkpointTimer);
        queueCurrentDraftDelete(activeNoteId);
        activeNoteId = null;
        dirty.draft = false;
        dirty.archive = true;
        schedule();
    }

    function touchNote(id) {
        if (id == null) return;
        id = String(id);
        if (activeNoteId != null && activeNoteId !== id) {
            queueCurrentDraftDelete(activeNoteId);
            dirty.archive = true;
        }
        activeNoteId = id;
        dirty.draft = true;
        clearTimeout(checkpointTimer);
        checkpointTimer = setTimeout(() => checkpoint(id), CFG.CHECKPOINT_IDLE_MS);
        schedule();
    }

    function checkpoint(id) {
        if (activeNoteId == null || (id != null && String(id) !== activeNoteId)) return false;
        clearTimeout(checkpointTimer);
        queueCurrentDraftDelete(activeNoteId);
        activeNoteId = null;
        dirty.draft = false;
        dirty.archive = true;
        schedule();
        return true;
    }

    function foldLoadedHot() {
        const now = Date.now();
        const foldable = loadedDrafts.filter((row) => row.client_id === CLIENT_ID ||
            now - new Date(row.saved_at || 0).getTime() > CFG.HOT_STALE_MS);
        loadedDrafts = [];
        foldable.forEach((row) => pendingDraftDeletes.add(draftKey(row.note_id, row.client_id)));
        if (!foldable.length) return false;
        dirty.archive = true;
        schedule();
        return true;
    }

    function putBlob(id, base64) {
        pendingBlobs.set(String(id), String(base64 || ''));
        blobCache.set(String(id), String(base64 || ''));
        schedule();
    }

    function dropBlob(id) {
        pendingBlobs.set(String(id), null);
        blobCache.delete(String(id));
        schedule();
    }

    async function getBlob(id) {
        id = String(id);
        if (blobCache.has(id)) return blobCache.get(id);
        if (pendingBlobs.has(id)) return pendingBlobs.get(id) || '';
        const c = client();
        const uid = await requireUser();
        const { data, error } = await c.from('blobs').select('content')
            .eq('user_id', uid).eq('file_id', id).maybeSingle();
        if (error) throw new Error(error.message);
        const content = data ? data.content || '' : '';
        if (content) blobCache.set(id, content);
        return content;
    }

    const hasPending = () => dirty.archive || dirty.draft || pendingDraftDeletes.size > 0 ||
        pendingBlobs.size > 0 || Boolean(inFlight);

    async function reconcile() {
        if (!sources.adopt || !sources.data) return;
        const previous = remoteVersion;
        const remote = await readDocument(false);
        if (remoteVersion !== previous) sources.adopt(mergeDocket(remote, sources.data()));
    }

    async function saveArchive() {
        const c = client();
        for (let attempt = 0; attempt < 3; attempt++) {
            const payload = sources.data ? sources.data() : normalise(null);
            const { data, error } = await c.rpc('save_document', {
                expected_version: remoteVersion,
                new_data: payload
            });
            if (!error) {
                remoteVersion = Number(data || remoteVersion + 1);
                return;
            }
            if (!String(error.message || '').includes('DOC_VERSION_CONFLICT')) {
                throw new Error(error.message);
            }
            await reconcile();
        }
        throw new Error('This docket changed elsewhere. Reload and try again.');
    }

    function restoreWork(work) {
        dirty.archive = dirty.archive || work.archive;
        if (work.draftId != null && activeNoteId === work.draftId) dirty.draft = true;
        work.draftDeletes.forEach((key) => pendingDraftDeletes.add(key));
        work.blobs.forEach((value, key) => pendingBlobs.set(key, value));
    }

    async function flush() {
        clearTimeout(flushTimer);
        if (!isConnected() || !hasPending()) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(); }
        const work = {
            archive: dirty.archive,
            draftId: dirty.draft ? activeNoteId : null,
            draftDeletes: pendingDraftDeletes,
            blobs: pendingBlobs
        };
        dirty.archive = false;
        dirty.draft = false;
        pendingDraftDeletes = new Set();
        pendingBlobs = new Map();
        dirtySince = 0;
        emit('saving');
        inFlight = (async () => {
            const c = client();
            const uid = await requireUser();
            if (work.archive) {
                await reconcile();
                await saveArchive();
            }
            for (const key of work.draftDeletes) {
                const { noteId, clientId } = parseDraftKey(key);
                const { error } = await c.from('drafts').delete().eq('user_id', uid)
                    .eq('note_id', noteId).eq('client_id', clientId);
                if (error) throw new Error(error.message);
            }
            if (work.draftId != null) {
                const note = sourceNote(work.draftId);
                if (note) {
                    const { error } = await c.from('drafts').upsert({
                        user_id: uid, note_id: String(work.draftId), client_id: CLIENT_ID,
                        note, saved_at: new Date().toISOString()
                    }, { onConflict: 'user_id,note_id,client_id' });
                    if (error) throw new Error(error.message);
                }
            }
            for (const [fileId, content] of work.blobs) {
                const query = content === null
                    ? c.from('blobs').delete().eq('user_id', uid).eq('file_id', fileId)
                    : c.from('blobs').upsert({ user_id: uid, file_id: fileId, content },
                        { onConflict: 'user_id,file_id' });
                const { error } = await query;
                if (error) throw new Error(error.message);
            }
        })();
        try {
            await inFlight;
            lastError = null;
            retryDelay = 0;
            emit('synced');
        } catch (error) {
            restoreWork(work);
            lastError = error.message;
            emit('error', error.message);
            scheduleRetry();
        } finally {
            inFlight = null;
        }
        if (hasPending() && !lastError) flush();
    }

    function scheduleRetry() {
        clearTimeout(retryTimer);
        retryDelay = retryDelay ? Math.min(retryDelay * 2, CFG.RETRY_MAX_MS) : CFG.RETRY_BASE_MS;
        retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelay);
    }

    const history = () => lastHistory.slice(0, CFG.HISTORY_LIMIT).map((row) => ({
        sha: String(row.id), at: row.created_at, added: null, removed: null
    }));

    async function atVersion(id) {
        const c = client();
        const uid = await requireUser();
        const { data, error } = await c.from('revisions').select('data')
            .eq('user_id', uid).eq('id', Number(id)).single();
        if (error) throw new Error(error.message);
        return normalise(data.data);
    }

    window.DocketStore = {
        load, bind, touchData, touchNote, checkpoint, foldLoadedHot, flush,
        history, atVersion, getBlob, putBlob, dropBlob, merge: mergeDocket,
        retry: () => { lastError = null; retryDelay = 0; clearTimeout(retryTimer); flush(); },
        onStatus: (fn) => listeners.push(fn),
        hasPending,
        lastError: () => lastError,
        isConnected,
        getSession,
        signIn,
        signOut,
        currentEmail: () => userEmail
    };
})();
