const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'store.js'), 'utf8');

/* Enough of IndexedDB to exercise the blob cache: the handful of calls
   store.js actually makes, with requests resolved on the microtask queue
   because the harness deliberately never runs its stubbed timers. */
function fakeIndexedDB() {
    const stores = new Map();
    const keyPaths = new Map();
    const later = (fn) => Promise.resolve().then(fn);

    function storeFor(name) {
        const data = stores.get(name);
        const keyPath = keyPaths.get(name);
        return {
            get(key) {
                const request = {};
                later(() => { request.result = data.get(key); if (request.onsuccess) request.onsuccess(); });
                return request;
            },
            getAll() {
                const request = {};
                later(() => {
                    request.result = Array.from(data.values());
                    if (request.onsuccess) request.onsuccess();
                });
                return request;
            },
            put(value) { data.set(value[keyPath], value); return {}; },
            delete(key) { data.delete(key); return {}; },
            clear() { data.clear(); return {}; }
        };
    }

    const db = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore(name, options) {
            stores.set(name, new Map());
            keyPaths.set(name, options.keyPath);
            return storeFor(name);
        },
        close() {},
        transaction(names) {
            const tx = { objectStore: storeFor };
            /* oncomplete is assigned after the caller's writes run, so it
               cannot fire until the current synchronous block is done. */
            later(() => { if (tx.oncomplete) tx.oncomplete(); });
            return tx;
        }
    };

    return {
        open() {
            const request = { result: db };
            later(() => {
                if (request.onupgradeneeded) request.onupgradeneeded();
                if (request.onsuccess) request.onsuccess();
            });
            return request;
        },
        stores
    };
}

function harness(options) {
    const opts = options || {};
    const calls = [];
    const rows = {
        docket_sync_state: { revision: 4 },
        docket_items: [
            { entity_type: 'note', entity_id: 'n1', revision: 4,
                data: { id: 'n1', body: 'saved', updated: '2026-01-01' } },
            { entity_type: 'folder', entity_id: 'd1', revision: 4,
                data: { id: 'd1', name: 'Work', created: '2026-01-01' } }
        ],
        docket_revision_events: [
            { revision: 9, created_at: '2026-01-02T00:00:00Z', changed_count: 2 }
        ],
        blobs: null
    };
    let delta = { revision: 5, changes: [{
        entity_type: 'note', entity_id: 'n1', deleted: false, revision: 5,
        data: { id: 'n1', body: 'changed elsewhere', updated: '2026-01-04' }
    }] };

    class Query {
        constructor(table) { this.table = table; this.operation = 'select'; }
        select(columns) { this.operation = 'select'; this.columns = columns; return this; }
        eq() { return this; }
        order() { return this; }
        limit(value) { this.limitValue = value; return this; }
        range(from, to) { this.from = from; this.to = to; return this; }
        maybeSingle() { this.singleRow = true; return this; }
        delete() { this.operation = 'delete'; return this; }
        then(resolve, reject) {
            calls.push({ operation: this.operation, table: this.table, columns: this.columns,
                limit: this.limitValue, range: this.from == null ? null : [this.from, this.to] });
            let data = rows[this.table];
            if (this.from != null && Array.isArray(data)) data = data.slice(this.from, this.to + 1);
            if (this.singleRow && Array.isArray(data)) data = data[0] || null;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
    }

    const storage = {
        upload: async (filePath, blob, options) => {
            calls.push({ operation: 'upload', path: filePath, blob, options });
            return { data: { path: filePath }, error: null };
        },
        download: async (filePath) => {
            calls.push({ operation: 'download', path: filePath });
            return { data: { size: 5, type: 'text/plain', text: async () => 'hello' }, error: null };
        },
        remove: async (paths) => {
            calls.push({ operation: 'remove', paths });
            return { data: paths, error: null };
        }
    };
    let subscribedHandler = null;
    let createArgs;
    const client = {
        auth: {
            getSession: async () => ({ data: { session: { user: {
                id: 'user-1', email: 'owner@example.com'
            } } }, error: null }),
            signInWithPassword: async () => ({ data: { session: { user: {
                id: 'user-1', email: 'owner@example.com'
            } } }, error: null }),
            signOut: async () => ({ error: null })
        },
        from: (table) => new Query(table),
        rpc: async (name, args) => {
            calls.push({ operation: 'rpc', name, args });
            if (name === 'read_docket_changes_since') return { data: delta, error: null };
            if (name === 'read_docket_revision') {
                return { data: { notes: [], files: [], folders: [], trash: [] }, error: null };
            }
            if (name === 'ensure_docket_state') return { data: 0, error: null };
            if (name === 'apply_docket_changes') {
                rows.docket_sync_state.revision++;
                return { data: rows.docket_sync_state.revision, error: null };
            }
            return { data: null, error: null };
        },
        storage: { from: (bucket) => { calls.push({ operation: 'bucket', bucket }); return storage; } },
        channel: (name) => ({
            on(event, options, handler) {
                calls.push({ operation: 'channel', name, event, options });
                subscribedHandler = handler;
                return this;
            },
            subscribe() { calls.push({ operation: 'subscribe', name }); return this; }
        }),
        removeChannel: async () => ({ error: null })
    };
    const window = {
        DOCKET_CONFIG: {
            SAVE_DEBOUNCE_MS: 900, MAX_SAVE_WAIT_MS: 5000,
            RETRY_BASE_MS: 2000, RETRY_MAX_MS: 60000, HISTORY_LIMIT: 40,
            STORAGE_BUCKET: 'doc-files-v2', BLOB_MIGRATION_PAUSE_MS: 0,
            BLOB_CACHE_BYTES: opts.blobCacheBytes || 200 * 1024 * 1024
        },
        indexedDB: opts.cache ? fakeIndexedDB() : null,
        SUPABASE_CONFIG: {
            url: 'https://example.supabase.co', publishableKey: 'public-key', schema: 'doc'
        },
        supabase: { createClient: (...args) => { createArgs = args; return client; } }
    };
    const timers = new Map();
    let timerId = 0;
    const context = {
        window, console, Date, Math, Map, Set, Promise, JSON, Uint8Array,
        setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id) => timers.delete(id)
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'store.js' });
    return {
        Store: window.DocketStore, calls, rows, cache: window.indexedDB,
        setDelta: (value) => { delta = value; },
        emitRealtime: (revision) => subscribedHandler({ new: { revision } }),
        createArgs: () => createArgs
    };
}

test('Supabase client is scoped to the doc schema', async () => {
    const h = harness();
    await h.Store.getSession();
    assert.equal(h.createArgs()[2].db.schema, 'doc');
    assert.equal(h.Store.currentEmail(), 'owner@example.com');
});

test('initial load reads normalized rows and never fetches the legacy JSONB document', async () => {
    const h = harness();
    await h.Store.getSession();
    const docket = await h.Store.load();
    assert.equal(docket.notes[0].body, 'saved');
    assert.equal(docket.folders[0].name, 'Work');
    assert.ok(h.calls.some((call) => call.table === 'docket_items'));
    assert.equal(h.calls.some((call) => call.table === 'documents'), false);
});

test('an unchanged safety refresh reads only the small sync state row', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.load();
    const before = h.calls.length;
    assert.equal(await h.Store.load(), null);
    assert.deepEqual(h.calls.slice(before).map(({ table, columns }) => ({ table, columns })), [
        { table: 'docket_sync_state', columns: 'revision' }
    ]);
});

test('a Realtime revision fetches only item deltas', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.load();
    const before = h.calls.length;
    const docket = await h.Store.load(5);
    assert.equal(docket.notes[0].body, 'changed elsewhere');
    assert.deepEqual(h.calls.slice(before).map((call) => call.name || call.table), [
        'read_docket_changes_since'
    ]);
});

test('typing saves one note row rather than the complete docket', async () => {
    const h = harness();
    await h.Store.getSession();
    let state = await h.Store.load();
    h.Store.bind(() => state, (next) => { state = next; });
    state.notes[0].body = 'one edited note';
    state.notes[0].updated = '2026-01-05';
    h.Store.touchNote('n1');
    await h.Store.flush();
    const call = h.calls.find((entry) => entry.name === 'apply_docket_changes');
    assert.equal(call.args.changes.length, 1);
    assert.equal(call.args.changes[0].entity_type, 'note');
    assert.equal(call.args.changes[0].data.body, 'one edited note');
    assert.equal('new_data' in call.args, false);
});

test('structural changes send row upserts and deletes only', async () => {
    const h = harness();
    await h.Store.getSession();
    let state = await h.Store.load();
    h.Store.bind(() => state, (next) => { state = next; });
    state.folders = [];
    h.Store.touchData();
    await h.Store.flush();
    const call = h.calls.find((entry) => entry.name === 'apply_docket_changes');
    assert.deepEqual(JSON.parse(JSON.stringify(call.args.changes.map(
        ({ entity_type, entity_id, action }) => ({ entity_type, entity_id, action })))), [
        { entity_type: 'folder', entity_id: 'd1', action: 'delete' }
    ]);
});

test('revision history is lazy, bounded, and backed by delta events', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.loadHistory();
    assert.equal(h.Store.history()[0].sha, '9');
    const call = h.calls.find((entry) => entry.table === 'docket_revision_events');
    assert.equal(call.limit, 40);
});

test('new file bytes upload to private Storage rather than Postgres', async () => {
    const h = harness();
    await h.Store.getSession();
    const blob = { type: 'text/plain' };
    const filePath = await h.Store.putBlob('file-1', blob);
    assert.equal(filePath, 'user-1/file-1');
    assert.ok(h.calls.some((call) => call.operation === 'upload' && call.blob === blob));
    assert.equal(h.calls.some((call) => call.table === 'blobs' && call.operation !== 'select'), false);
});

test('Realtime subscribes to the owner sync row and ignores the current revision', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.load();
    const revisions = [];
    h.Store.subscribe((revision) => revisions.push(revision));
    h.emitRealtime(4);
    h.emitRealtime(5);
    assert.deepEqual(revisions, [5]);
    const call = h.calls.find((entry) => entry.operation === 'channel');
    assert.equal(call.options.filter, 'user_id=eq.user-1');
});

/* ---- cached file bytes -------------------------------------------------

   Storage egress is the part of the free tier that is spent rather than
   occupied, so "did this touch the network at all" is the assertion that
   matters in every one of these. */

test('a file downloaded once is served from the device the second time', async () => {
    const h = harness({ cache: true });
    await h.Store.getSession();
    const file = { id: 'file-1', storagePath: 'user-1/file-1' };

    assert.equal(await (await h.Store.getBlob(file)).text(), 'hello');
    assert.equal(await (await h.Store.getBlob(file)).text(), 'hello');

    assert.equal(h.calls.filter((call) => call.operation === 'download').length, 1);
});

test('bytes just uploaded are cached, so reading them back costs no egress', async () => {
    const h = harness({ cache: true });
    await h.Store.getSession();
    const blob = { size: 12, type: 'video/mp4', text: async () => 'twelve bytes' };

    await h.Store.putBlob('file-2', blob);
    const read = await h.Store.getBlob({ id: 'file-2', storagePath: 'user-1/file-2' });

    assert.equal(read, blob);
    assert.equal(h.calls.some((call) => call.operation === 'download'), false);
});

test('the local cache evicts least-recently-used bytes instead of growing without bound', async () => {
    const h = harness({ cache: true, blobCacheBytes: 30 });
    await h.Store.getSession();
    const blob = (name) => ({ size: 20, type: 'video/mp4', text: async () => name });

    await h.Store.putBlob('old', blob('old'));
    await h.Store.putBlob('new', blob('new'));

    /* 40 bytes will not fit in 30, so the older file gave up its place. */
    assert.deepEqual(Array.from(h.cache.stores.get('blobs').keys()), ['new']);
    assert.deepEqual(Array.from(h.cache.stores.get('blobstats').keys()), ['new']);

    assert.equal(await (await h.Store.getBlob({ id: 'new', storagePath: 'user-1/new' })).text(), 'new');
    assert.equal(h.calls.some((call) => call.operation === 'download'), false);

    await h.Store.getBlob({ id: 'old', storagePath: 'user-1/old' });
    assert.ok(h.calls.some((call) => call.operation === 'download' && call.path === 'user-1/old'));
});

test('a file larger than the whole local budget is fetched but never cached', async () => {
    const h = harness({ cache: true, blobCacheBytes: 10 });
    await h.Store.getSession();
    await h.Store.readCache();

    await h.Store.putBlob('huge', { size: 999, type: 'video/mp4' });

    /* Caching it would have evicted everything else to hold only itself. */
    assert.equal(h.cache.stores.get('blobs').size, 0);
    assert.ok(h.calls.some((call) => call.operation === 'upload' && call.path === 'user-1/huge'));
});

test('deleting a file drops its cached bytes as well as the object', async () => {
    const h = harness({ cache: true });
    await h.Store.getSession();
    await h.Store.putBlob('file-3', { size: 8, type: 'text/plain' });
    assert.equal(h.cache.stores.get('blobs').size, 1);

    h.Store.dropBlob('file-3');
    await h.Store.flush();

    assert.equal(h.cache.stores.get('blobs').size, 0);
    assert.equal(h.cache.stores.get('blobstats').size, 0);
    assert.ok(h.calls.some((call) => call.operation === 'remove' &&
        call.paths.includes('user-1/file-3')));
});

test('a browser that refuses IndexedDB leaves the docket working over the network', async () => {
    const h = harness({ cache: true });
    h.cache.open = () => {
        const request = {};
        Promise.resolve().then(() => request.onerror && request.onerror());
        return request;
    };
    await h.Store.getSession();

    const docket = await h.Store.readCache();
    assert.equal(docket.notes.length, 0);
    assert.equal(docket.files.length, 0);
    assert.equal(await (await h.Store.getBlob({ id: 'x', storagePath: 'user-1/x' })).text(), 'hello');
});
