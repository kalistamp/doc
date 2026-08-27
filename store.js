/* Docket persistence: row deltas, Realtime, IndexedDB, and private Storage. */
(function () {
    'use strict';

    const CFG = window.DOCKET_CONFIG;
    const PAGE_SIZE = 500;
    const TYPES = { notes: 'note', files: 'file', folders: 'folder', trash: 'trash' };
    const LEGACY_KEYS = ['docket.notes', 'docket.files', 'docket.folders', 'docket.trash'];
    let clientInstance = null;
    let userId = null;
    let userEmail = '';
    let remoteRevision = 0;
    let loaded = false;
    let listeners = [];
    let sources = { data: null, adopt: null };
    let lastHistory = [];
    let activeNoteId = null;
    let flushTimer = null;
    let retryTimer = null;
    let retryDelay = 0;
    let dirtySince = 0;
    let inFlight = null;
    let lastError = null;
    let channel = null;
    let migrationPromise = null;
    let knownItems = new Map();
    let pendingChanges = new Map();
    let pendingBlobDeletes = new Set();
    let cacheItems = new Map();
    let cacheDbPromise = null;
    let cacheQueue = Promise.resolve();
    let blobStats = new Map();
    let blobStatsRead = null;

    const emit = (state, detail) => listeners.forEach((fn) => fn(state, detail));
    const normalise = (data) => {
        const arr = (value) => Array.isArray(value) ? value : [];
        return {
            notes: arr(data && data.notes), files: arr(data && data.files),
            folders: arr(data && data.folders), trash: arr(data && data.trash)
        };
    };
    const entityId = (type, data) => String(type === 'trash'
        ? data && data.item && data.item.id : data && data.id);
    const itemKey = (type, id) => `${type}\u0000${String(id)}`;
    const splitKey = (key) => {
        const at = key.indexOf('\u0000');
        return { type: key.slice(0, at), id: key.slice(at + 1) };
    };
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function flatten(docket) {
        const out = new Map();
        const value = normalise(docket);
        Object.entries(TYPES).forEach(([collection, type]) => {
            value[collection].forEach((data) => {
                const id = entityId(type, data);
                if (!id || id === 'undefined' || id === 'null') return;
                out.set(itemKey(type, id), clone(data));
            });
        });
        return out;
    }

    function unflatten(items) {
        const docket = normalise(null);
        const collections = { note: 'notes', file: 'files', folder: 'folders', trash: 'trash' };
        items.forEach((data, key) => {
            const collection = collections[splitKey(key).type];
            if (collection) docket[collection].push(clone(data));
        });
        return docket;
    }

    function diffItems(base, desired) {
        const changes = new Map();
        desired.forEach((data, key) => {
            if (!base.has(key) || !same(base.get(key), data)) {
                const { type, id } = splitKey(key);
                changes.set(key, { entity_type: type, entity_id: id, action: 'upsert', data: clone(data) });
            }
        });
        base.forEach((_, key) => {
            if (!desired.has(key)) {
                const { type, id } = splitKey(key);
                changes.set(key, { entity_type: type, entity_id: id, action: 'delete' });
            }
        });
        return changes;
    }

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
        if (channel && c) await c.removeChannel(channel);
        channel = null;
        if (c) await c.auth.signOut();
        userId = null;
        userEmail = '';
        remoteRevision = 0;
        loaded = false;
        knownItems = new Map();
        pendingChanges = new Map();
        pendingBlobDeletes = new Set();
        cacheItems = new Map();
        cacheDbPromise = null;
        blobStats = new Map();
        blobStatsRead = null;
    }

    async function requireUser() {
        if (userId) return userId;
        const session = await getSession();
        if (!session) throw new Error('Your session expired. Sign in again.');
        return userId;
    }

    const isConnected = () => Boolean(userId && client());
    const STAMPED = [
        { on: 'pinned', at: 'pinnedAt', cast: (v) => !!v },
        { on: 'finishNext', at: 'finishNextAt', cast: (v) => !!v },
        { on: 'markdown', at: 'markdownAt', cast: (v) => v == null ? null : !!v }
    ];
    const flagTime = (item, key) => Date.parse((item && item[key]) || '') || 0;
    const stampOf = (item) =>
        Date.parse((item && (item.updated || item.added || item.created)) || '') || 0;
    const binnedAt = (entry) => Date.parse((entry && entry.deletedAt) || '') || 0;

    function withFlags(winner, loser) {
        if (!loser || loser === winner) return winner;
        let out = winner;
        STAMPED.forEach(({ on, at, cast }) => {
            if (flagTime(loser, at) <= flagTime(out, at)) return;
            out = Object.assign({}, out, { [on]: cast(loser[on]), [at]: loser[at] || null });
        });
        return out;
    }

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
            folders: mergeCollection(a.folders, b.folders, graves), trash
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

    async function readRevision() {
        const c = client();
        const id = await requireUser();
        const { data, error } = await c.from('docket_sync_state').select('revision')
            .eq('user_id', id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
            const created = await c.rpc('ensure_docket_state');
            if (created.error) throw new Error(created.error.message);
            return Number(created.data || 0);
        }
        return Number(data.revision || 0);
    }

    async function readAllItems(revision) {
        const c = client();
        const id = await requireUser();
        const rows = [];
        for (let from = 0; ; from += PAGE_SIZE) {
            const { data, error } = await c.from('docket_items')
                .select('entity_type,entity_id,data,revision')
                .eq('user_id', id).range(from, from + PAGE_SIZE - 1);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < PAGE_SIZE) break;
        }
        knownItems = new Map(rows.map((row) => [
            itemKey(row.entity_type, row.entity_id), clone(row.data)
        ]));
        remoteRevision = Number(revision == null ? await readRevision() : revision);
        loaded = true;
        return unflatten(knownItems);
    }

    async function readDelta(targetRevision) {
        const { data, error } = await client().rpc('read_docket_changes_since', {
            since_revision: remoteRevision
        });
        if (error) throw new Error(error.message);
        const payload = data || {};
        (payload.changes || []).forEach((change) => {
            const key = itemKey(change.entity_type, change.entity_id);
            if (change.deleted) knownItems.delete(key);
            else knownItems.set(key, clone(change.data));
        });
        remoteRevision = Number(payload.revision == null ? targetRevision : payload.revision);
        return unflatten(knownItems);
    }

    async function load(announcedRevision) {
        if (!isConnected()) { emit('offline'); return null; }
        emit('loading');
        try {
            const next = announcedRevision == null ? await readRevision() : Number(announcedRevision);
            if (loaded && next === remoteRevision) { emit('synced'); return null; }
            const data = loaded && next > remoteRevision
                ? await readDelta(next) : await readAllItems(next);
            emit('synced');
            return data;
        } catch (error) {
            lastError = error.message;
            emit('error', error.message);
            throw error;
        }
    }

    function schedule() {
        if (!isConnected()) { emit('offline'); return; }
        if (!pendingChanges.size && !pendingBlobDeletes.size) return;
        emit('dirty');
        if (!dirtySince) dirtySince = Date.now();
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(flushTimer);
        if (Date.now() - dirtySince >= CFG.MAX_SAVE_WAIT_MS) { flush(); return; }
        flushTimer = setTimeout(flush, CFG.SAVE_DEBOUNCE_MS);
    }

    function touchData() {
        activeNoteId = null;
        if (!sources.data) return;
        pendingChanges = diffItems(knownItems, flatten(sources.data()));
        schedule();
    }

    function touchItem(type, data) {
        const id = entityId(type, data);
        if (!id || id === 'undefined' || id === 'null') return;
        const key = itemKey(type, id);
        if (knownItems.has(key) && same(knownItems.get(key), data)) pendingChanges.delete(key);
        else pendingChanges.set(key, {
            entity_type: type, entity_id: id, action: 'upsert', data: clone(data)
        });
        schedule();
    }

    function touchNote(id) {
        const note = sources.data && normalise(sources.data()).notes
            .find((entry) => String(entry.id) === String(id));
        if (!note) return;
        activeNoteId = String(id);
        touchItem('note', note);
    }

    function checkpoint(id) {
        if (activeNoteId == null || (id != null && String(id) !== activeNoteId)) return false;
        activeNoteId = null;
        schedule();
        return true;
    }

    const foldLoadedHot = () => false;
    const hasPending = () => pendingChanges.size > 0 || pendingBlobDeletes.size > 0 || Boolean(inFlight);

    function applyKnown(changes) {
        changes.forEach((change) => {
            const key = itemKey(change.entity_type, change.entity_id);
            if (change.action === 'delete') knownItems.delete(key);
            else knownItems.set(key, clone(change.data));
        });
    }

    async function saveChanges(changes) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = await client().rpc('apply_docket_changes', {
                expected_revision: remoteRevision, changes
            });
            if (!result.error) {
                remoteRevision = Number(result.data == null ? remoteRevision + 1 : result.data);
                applyKnown(changes);
                return;
            }
            if (!String(result.error.message || '').includes('DOCKET_REVISION_CONFLICT')) {
                throw new Error(result.error.message);
            }
            const local = sources.data ? normalise(sources.data()) : normalise(null);
            const remote = await readAllItems();
            const merged = mergeDocket(remote, local);
            if (sources.adopt) sources.adopt(merged);
            changes = Array.from(diffItems(knownItems, flatten(merged)).values());
            if (!changes.length) return;
        }
        throw new Error('This docket changed elsewhere. Reload and try again.');
    }

    const storagePath = (id) => `${userId}/${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}`;

    async function flush() {
        clearTimeout(flushTimer);
        if (!isConnected() || !hasPending()) return;
        if (inFlight) { await inFlight.catch(() => {}); return flush(); }
        const workChanges = Array.from(pendingChanges.values());
        const workDeletes = new Set(pendingBlobDeletes);
        pendingChanges = new Map();
        pendingBlobDeletes = new Set();
        dirtySince = 0;
        emit('saving');
        inFlight = (async () => {
            await requireUser();
            for (let at = 0; at < workChanges.length; at += 200) {
                await saveChanges(workChanges.slice(at, at + 200));
            }
            if (workDeletes.size) {
                const { error } = await client().storage.from(CFG.STORAGE_BUCKET)
                    .remove(Array.from(workDeletes, storagePath));
                if (error) throw new Error(error.message);
            }
        })();
        try {
            await inFlight;
            lastError = null;
            retryDelay = 0;
            if (sources.data) pendingChanges = diffItems(knownItems, flatten(sources.data()));
            emit('synced');
        } catch (error) {
            if (sources.data) pendingChanges = diffItems(knownItems, flatten(sources.data()));
            workDeletes.forEach((id) => pendingBlobDeletes.add(id));
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

    async function putBlob(id, blob) {
        await requireUser();
        const path = storagePath(id);
        const { error } = await client().storage.from(CFG.STORAGE_BUCKET).upload(path, blob, {
            cacheControl: '3600', contentType: blob.type || 'application/octet-stream', upsert: false
        });
        if (error) throw new Error(error.message);
        /* The bytes are already in hand, so the first read of a file this
           device just uploaded should not go back out over the network. */
        await writeBlobCache(id, blob).catch(() => null);
        return path;
    }

    function dropBlob(id) {
        pendingBlobDeletes.add(String(id));
        dropBlobCache(id);
        schedule();
    }

    async function legacyBlob(id) {
        const uid = await requireUser();
        const { data, error } = await client().from('blobs').select('content')
            .eq('user_id', uid).eq('file_id', String(id)).maybeSingle();
        if (error) throw new Error(error.message);
        return data && data.content ? data.content : '';
    }

    function decodeBase64(content, type) {
        const binary = window.atob(content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: type || 'application/octet-stream' });
    }

    async function migrateLegacyEntity(type, data, file) {
        const path = storagePath(file.id);
        let downloaded = await client().storage.from(CFG.STORAGE_BUCKET).download(path);
        if (downloaded.error) {
            const content = await legacyBlob(file.id);
            if (!content) return null;
            const blob = decodeBase64(content, file.type);
            const uploaded = await client().storage.from(CFG.STORAGE_BUCKET).upload(path, blob, {
                cacheControl: '3600', contentType: file.type || 'application/octet-stream', upsert: false
            });
            if (uploaded.error && !String(uploaded.error.message || '').toLowerCase().includes('exist')) {
                throw new Error(uploaded.error.message);
            }
            downloaded = { data: blob, error: null };
        }
        if (!file.storagePath) {
            file.storagePath = path;
            file.updated = new Date().toISOString();
            cacheItem(type, data);
            touchItem(type, data);
            await flush();
        }
        if (!lastError) {
            const uid = await requireUser();
            const { error } = await client().from('blobs').delete()
                .eq('user_id', uid).eq('file_id', String(file.id));
            if (error) throw new Error(error.message);
        }
        return downloaded.data;
    }

    async function getBlob(file) {
        if (!file || file.id == null) return null;
        await requireUser();
        const cached = await readBlobCache(file.id).catch(() => null);
        if (cached) return cached;
        const { data, error } = await client().storage.from(CFG.STORAGE_BUCKET)
            .download(file.storagePath || storagePath(file.id));
        if (!error) {
            await writeBlobCache(file.id, data).catch(() => null);
            return data;
        }
        const docket = sources.data ? normalise(sources.data()) : normalise(null);
        const live = docket.files.find((entry) => String(entry.id) === String(file.id));
        const grave = live ? null : docket.trash.find((entry) => entry.kind === 'file' &&
            entry.item && String(entry.item.id) === String(file.id));
        if (live || grave) {
            /* A null here means the legacy row held no bytes to migrate,
               which the caller reports rather than treats as a failure. */
            const legacy = live
                ? await migrateLegacyEntity('file', live, live)
                : await migrateLegacyEntity('trash', grave, grave.item);
            if (legacy) await writeBlobCache(file.id, legacy).catch(() => null);
            return legacy;
        }
        throw new Error(error.message || 'Could not download that file.');
    }

    async function migrateLegacyFiles() {
        if (migrationPromise) return migrationPromise;
        migrationPromise = (async () => {
            const docket = sources.data ? normalise(sources.data()) : normalise(null);
            const candidates = docket.files.map((file) => ({ type: 'file', data: file, file }))
                .concat(docket.trash.filter((entry) => entry.kind === 'file' && !entry.purged && entry.item)
                    .map((entry) => ({ type: 'trash', data: entry, file: entry.item })))
                .filter(({ file }) => !file.storagePath);
            for (const candidate of candidates) {
                if (!isConnected()) break;
                try {
                    await migrateLegacyEntity(candidate.type, candidate.data, candidate.file);
                } catch (error) {
                    lastError = error.message;
                    emit('error', `Legacy file migration paused: ${error.message}`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, CFG.BLOB_MIGRATION_PAUSE_MS));
            }
        })().finally(() => { migrationPromise = null; });
        return migrationPromise;
    }

    async function loadHistory() {
        const uid = await requireUser();
        const { data, error } = await client().from('docket_revision_events')
            .select('revision,created_at,changed_count').eq('user_id', uid)
            .order('revision', { ascending: false }).limit(CFG.HISTORY_LIMIT);
        if (error) throw new Error(error.message);
        lastHistory = data || [];
        return history();
    }

    const history = () => lastHistory.map((row) => ({
        sha: String(row.revision), at: row.created_at,
        added: Number(row.changed_count || 0), removed: null
    }));

    async function refreshHistory() {
        const c = client();
        const uid = await requireUser();
        const { data, error } = await c.from('revisions').select('id,created_at')
            .eq('user_id', uid).order('created_at', { ascending: false })
            .limit(CFG.HISTORY_LIMIT);
        if (error) throw new Error(error.message);
        lastHistory = data || [];
        return history();
    }

    async function atVersion(id) {
        const { data, error } = await client().rpc('read_docket_revision', {
            target_revision: Number(id)
        });
        if (error) throw new Error(error.message);
        return normalise(data);
    }

    function subscribe(onChange) {
        const c = client();
        if (!c || !userId) return null;
        if (channel) c.removeChannel(channel);
        channel = c.channel(`doc-sync-${userId}`).on('postgres_changes', {
            event: 'UPDATE', schema: 'doc', table: 'docket_sync_state',
            filter: `user_id=eq.${userId}`
        }, (payload) => {
            const revision = Number(payload && payload.new && payload.new.revision || 0);
            if (revision > remoteRevision && onChange) onChange(revision);
        }).subscribe((status) => {
            /* Close the tiny gap between the initial read and a confirmed
               subscription with one revision check. */
            if (status === 'SUBSCRIBED' && onChange) onChange();
        });
        return channel;
    }

    function openCache() {
        if (cacheDbPromise) return cacheDbPromise;
        if (!window.indexedDB || !userId) return Promise.resolve(null);
        cacheDbPromise = new Promise((resolve) => {
            const request = window.indexedDB.open(`docket-cache-v2-${userId}`, 2);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('items')) {
                    db.createObjectStore('items', { keyPath: 'key' });
                }
                /* File bytes sit beside the records, split from their size
                   ledger so the budget can be totalled without reading a
                   single video back out of the database. */
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('blobstats')) {
                    db.createObjectStore('blobstats', { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                /* A second tab opening a newer version must not be held off
                   by this one keeping the old connection alive. */
                request.result.onversionchange = () => {
                    request.result.close();
                    cacheDbPromise = null;
                };
                resolve(request.result);
            };
            /* The cache is an optimisation, so a browser that refuses it —
               or an old tab blocking the upgrade — must not take the docket
               down with it. Without a cache this is simply the path a fresh
               device already takes. */
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        });
        return cacheDbPromise;
    }

    function cacheTransaction(names, mode, run) {
        const stores = [].concat(names);
        return openCache().then((db) => {
            if (!db) return null;
            return new Promise((resolve, reject) => {
                const tx = db.transaction(stores, mode);
                run(...stores.map((name) => tx.objectStore(name)));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        });
    }

    function enqueueCache(run) {
        cacheQueue = cacheQueue.then(run).catch(() => null);
        return cacheQueue;
    }

    async function readCache() {
        await cacheQueue;
        const db = await openCache();
        let records = [];
        if (db) {
            records = await new Promise((resolve, reject) => {
                const request = db.transaction('items').objectStore('items').getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        }
        if (!records.length) {
            const legacy = normalise(Object.fromEntries(Object.keys(TYPES).map((collection) => {
                try { return [collection, JSON.parse(localStorage.getItem(`docket.${collection}`) || '[]')]; }
                catch (_) { return [collection, []]; }
            })));
            if (Object.values(legacy).some((list) => list.length)) {
                await cacheDocket(legacy);
                LEGACY_KEYS.forEach((key) => { try { localStorage.removeItem(key); } catch (_) {} });
                return legacy;
            }
        }
        cacheItems = new Map(records.map((record) => [record.key, record.data]));
        return unflatten(cacheItems);
    }

    function cacheItem(type, data) {
        const id = entityId(type, data);
        if (!id || id === 'undefined' || id === 'null') return Promise.resolve();
        const key = itemKey(type, id);
        const value = clone(data);
        cacheItems.set(key, value);
        return enqueueCache(() => cacheTransaction('items', 'readwrite', (store) => {
            store.put({ key, data: value });
        }));
    }

    function cacheDocket(docket) {
        const desired = flatten(docket);
        const changes = diffItems(cacheItems, desired);
        cacheItems = desired;
        if (!changes.size) return Promise.resolve();
        return enqueueCache(() => cacheTransaction('items', 'readwrite', (store) => {
            changes.forEach((change, key) => {
                if (change.action === 'delete') store.delete(key);
                else store.put({ key, data: change.data });
            });
        }));
    }

    /* ---- cached file bytes ---------------------------------------------

       Storage egress is the scarcest part of the free tier, and every
       download, copy, and preview used to spend it on bytes this device had
       already seen. What is held locally is capped separately from what may
       be stored in the cloud: a phone should not carry the whole docket to
       save a download it may never repeat. */

    function readBlobStats() {
        if (blobStatsRead) return blobStatsRead;
        blobStatsRead = openCache().then((db) => {
            if (!db) return [];
            return new Promise((resolve) => {
                const request = db.transaction('blobstats').objectStore('blobstats').getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            });
        }).then((records) => {
            blobStats = new Map(records.map((record) => [record.id, record]));
            return blobStats;
        }).catch(() => blobStats);
        return blobStatsRead;
    }

    async function readBlobCache(id) {
        const key = String(id);
        await readBlobStats();
        if (!blobStats.has(key)) return null;
        const db = await openCache();
        if (!db) return null;
        const record = await new Promise((resolve) => {
            const request = db.transaction('blobs').objectStore('blobs').get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
        });
        /* The ledger claimed bytes that are not there — an eviction by the
           browser, most likely. Forget the claim and pay for the download. */
        if (!record || !record.blob) {
            blobStats.delete(key);
            return null;
        }
        const stat = blobStats.get(key);
        stat.used = Date.now();
        enqueueCache(() => cacheTransaction('blobstats', 'readwrite',
            (stats) => stats.put({ id: key, size: stat.size, used: stat.used })));
        return record.blob;
    }

    function writeBlobCache(id, blob) {
        const key = String(id);
        const budget = CFG.BLOB_CACHE_BYTES || 0;
        /* One file larger than the whole budget would evict everything else
           to hold only itself, which is worse than not caching it at all. */
        if (!blob || !blob.size || !budget || blob.size > budget) return Promise.resolve(null);
        return readBlobStats().then(() => {
            let total = blob.size;
            blobStats.forEach((stat, other) => {
                if (other !== key) total += stat.size || 0;
            });
            const evict = [];
            Array.from(blobStats.entries())
                .filter(([other]) => other !== key)
                .sort((a, b) => (a[1].used || 0) - (b[1].used || 0))
                .forEach(([other, stat]) => {
                    if (total <= budget) return;
                    evict.push(other);
                    total -= stat.size || 0;
                });

            const record = { id: key, size: blob.size, used: Date.now() };
            evict.forEach((other) => blobStats.delete(other));
            blobStats.set(key, record);
            return enqueueCache(() => cacheTransaction(['blobs', 'blobstats'], 'readwrite',
                (blobs, stats) => {
                    evict.forEach((other) => { blobs.delete(other); stats.delete(other); });
                    blobs.put({ id: key, blob });
                    stats.put(record);
                }).catch((error) => {
                    /* Out of quota, most likely. Drop the claim so the ledger
                       keeps describing what is actually on the disk. */
                    blobStats.delete(key);
                    throw error;
                }));
        });
    }

    function dropBlobCache(id) {
        const key = String(id);
        blobStats.delete(key);
        return enqueueCache(() => cacheTransaction(['blobs', 'blobstats'], 'readwrite',
            (blobs, stats) => { blobs.delete(key); stats.delete(key); }));
    }

    function clearCache() {
        cacheItems = new Map();
        blobStats = new Map();
        blobStatsRead = null;
        return enqueueCache(() => cacheTransaction(['items', 'blobs', 'blobstats'], 'readwrite',
            (items, blobs, stats) => { items.clear(); blobs.clear(); stats.clear(); }));
    }

    window.DocketStore = {
        load, bind, touchData, touchItem, touchNote, checkpoint, foldLoadedHot, flush,
        history, loadHistory, atVersion, getBlob, putBlob, dropBlob, migrateLegacyFiles,
        readCache, cacheItem, cacheDocket, clearCache, subscribe, merge: mergeDocket,
        retry: () => { lastError = null; retryDelay = 0; clearTimeout(retryTimer); flush(); },
        onStatus: (fn) => listeners.push(fn), hasPending,
        lastError: () => lastError, isConnected, getSession, signIn, signOut,
        currentEmail: () => userEmail
    };
})();
