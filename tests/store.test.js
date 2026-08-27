const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'store.js'), 'utf8');

function harness() {
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
            return { data: { text: async () => 'hello' }, error: null };
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
            STORAGE_BUCKET: 'doc-files-v2', BLOB_MIGRATION_PAUSE_MS: 0
        },
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
        Store: window.DocketStore, calls, rows,
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
