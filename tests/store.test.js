const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'store.js'), 'utf8');

function harness() {
    const calls = [];
    const rows = {
        documents: { data: { notes: [{ id: 'n1', body: 'saved', updated: '2026-01-01' }],
            files: [], folders: [], trash: [] }, version: 4 },
        revisions: [{ id: 9, created_at: '2026-01-02T00:00:00Z' }],
        drafts: [{ note_id: 'n1', client_id: 'old',
            note: { id: 'n1', body: 'draft', updated: '2026-01-03' },
            saved_at: '2026-01-03T00:00:00Z' }],
        blobs: { content: 'YWJj' }
    };

    class Query {
        constructor(table) { this.table = table; this.operation = 'select'; }
        select(columns) { this.operation = 'select'; this.columns = columns; return this; }
        eq() { return this; }
        order() { return this; }
        limit(value) { this.rowLimit = value; return this; }
        maybeSingle() { this.singleRow = true; return this; }
        single() { this.singleRow = true; return this; }
        delete() { this.operation = 'delete'; return this; }
        upsert(value, options) {
            this.operation = 'upsert';
            calls.push({ operation: 'upsert', table: this.table, value, options });
            return this;
        }
        then(resolve, reject) {
            if (this.operation === 'delete') calls.push({ operation: 'delete', table: this.table });
            if (this.operation === 'select') {
                const call = { operation: 'select', table: this.table, columns: this.columns };
                if (this.rowLimit != null) call.limit = this.rowLimit;
                calls.push(call);
            }
            let data = rows[this.table];
            if (this.table === 'documents' && this.columns === 'version') {
                data = data ? { version: data.version } : null;
            }
            if (this.singleRow && Array.isArray(data)) data = data[0] || null;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
    }

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
            return { data: 5, error: null };
        }
    };
    const window = {
        DOCKET_CONFIG: {
            SAVE_DEBOUNCE_MS: 900, MAX_SAVE_WAIT_MS: 5000,
            CHECKPOINT_IDLE_MS: 600000, HOT_STALE_MS: 120000,
            RETRY_BASE_MS: 2000, RETRY_MAX_MS: 60000, HISTORY_LIMIT: 40
        },
        SUPABASE_CONFIG: {
            url: 'https://example.supabase.co', publishableKey: 'public-key', schema: 'doc'
        },
        supabase: { createClient: (...args) => { createArgs = args; return client; } }
    };
    const timers = new Map();
    let timerId = 0;
    const context = {
        window, console, Date, Math, Map, Set, Promise,
        setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id) => timers.delete(id)
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'store.js' });
    return { Store: window.DocketStore, calls, rows, createArgs: () => createArgs };
}

test('Supabase client is scoped to the doc schema', async () => {
    const h = harness();
    await h.Store.getSession();
    assert.equal(h.createArgs()[2].db.schema, 'doc');
    assert.equal(h.Store.currentEmail(), 'owner@example.com');
});

test('load overlays a newer crash-recovery draft', async () => {
    const h = harness();
    await h.Store.getSession();
    const docket = await h.Store.load();
    assert.equal(docket.notes[0].body, 'draft');
    assert.equal(h.Store.history().length, 0);
    const before = h.calls.length;
    await h.Store.refreshHistory();
    assert.equal(h.Store.history()[0].sha, '9');
    assert.deepEqual(h.calls.slice(before), [{
        operation: 'select', table: 'revisions', columns: 'id,created_at', limit: 40
    }]);
});

test('unchanged reload reads only the document version', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.load();
    const before = h.calls.length;

    const docket = await h.Store.load();

    assert.equal(docket, null);
    assert.deepEqual(h.calls.slice(before), [{
        operation: 'select', table: 'documents', columns: 'version'
    }]);
});

test('a newer version triggers the full document load', async () => {
    const h = harness();
    await h.Store.getSession();
    await h.Store.load();
    h.rows.documents.version = 5;
    h.rows.documents.data.notes[0] = {
        id: 'n1', body: 'changed elsewhere', updated: '2026-01-04'
    };
    const before = h.calls.length;

    const docket = await h.Store.load();

    assert.equal(docket.notes[0].body, 'changed elsewhere');
    assert.deepEqual(h.calls.slice(before).map(({ table, columns }) => ({ table, columns })), [
        { table: 'documents', columns: 'version' },
        { table: 'documents', columns: 'data,version' },
        { table: 'drafts', columns: 'note_id,client_id,note,saved_at' }
    ]);
});

test('archive writes use the version-checked save_document function', async () => {
    const h = harness();
    await h.Store.getSession();
    let state = await h.Store.load();
    h.Store.bind(() => state, (next) => { state = next; });
    h.Store.touchData();
    await h.Store.flush();
    const call = h.calls.find((entry) => entry.operation === 'rpc');
    assert.equal(call.name, 'save_document');
    assert.equal(call.args.expected_version, 4);
    assert.equal(call.args.new_data.notes[0].body, 'draft');
});

test('an unchanged save reconciliation reads only the version', async () => {
    const h = harness();
    await h.Store.getSession();
    let state = await h.Store.load();
    h.Store.bind(() => state, (next) => { state = next; });
    h.Store.touchData();
    const before = h.calls.length;

    await h.Store.flush();

    const reads = h.calls.slice(before).filter((entry) => entry.operation === 'select');
    assert.deepEqual(reads, [{
        operation: 'select', table: 'documents', columns: 'version'
    }]);
});

test('file content is upserted separately from docket metadata', async () => {
    const h = harness();
    await h.Store.getSession();
    h.Store.putBlob('file-1', 'YWJj');
    await h.Store.flush();
    const call = h.calls.find((entry) => entry.operation === 'upsert' && entry.table === 'blobs');
    assert.equal(call.value.user_id, 'user-1');
    assert.equal(call.value.file_id, 'file-1');
    assert.equal(call.value.content, 'YWJj');
});
