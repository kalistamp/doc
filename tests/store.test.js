const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'store.js'), 'utf8');

function response(json, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => typeof json === 'string' ? json : JSON.stringify(json)
    };
}

function harness(getPayload) {
    const patches = [];
    let timerId = 0;
    const timers = new Map();
    const storage = new Map([
        ['docket.token', 'token'],
        ['docket.gistId', 'gist']
    ]);
    const context = {
        console,
        Date,
        encodeURIComponent,
        window: {},
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        setTimeout: (fn, delay) => {
            const id = ++timerId;
            timers.set(id, { fn, delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        fetch: async (url, options = {}) => {
            if (options.method === 'PATCH') {
                const body = JSON.parse(options.body);
                patches.push({ files: body.files, options });
                return response({ history: [] });
            }
            return response(typeof getPayload === 'function' ? getPayload(url) : getPayload);
        }
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(configSource, context, { filename: 'config.js' });
    vm.runInContext(storeSource, context, { filename: 'store.js' });
    return {
        Store: context.window.DocketStore,
        CFG: context.window.DOCKET_CONFIG,
        patches,
        runTimers(delay) {
            const selected = Array.from(timers.entries()).filter(([, timer]) => timer.delay === delay);
            selected.forEach(([id, timer]) => { timers.delete(id); timer.fn(); });
        }
    };
}

function docket(notes) {
    return { notes, files: [], folders: [], trash: [] };
}

test('typing flushes only the compact hot note, then checkpoint folds it', async () => {
    const note = { id: 'n1', title: 'One', body: 'draft', updated: '2026-08-16T10:00:00Z' };
    const state = docket([note]);
    const { Store, CFG, patches } = harness({ files: {}, history: [] });
    Store.bind(() => state);

    Store.touchNote(note.id);
    await Store.flush();

    assert.equal(patches.length, 1);
    assert.deepEqual(Object.keys(patches[0].files), [`${CFG.HOT_PREFIX}n1`]);
    assert.equal(JSON.parse(patches[0].files[`${CFG.HOT_PREFIX}n1`].content).note.body, 'draft');
    assert.equal(patches[0].files[CFG.DATA_FILE], undefined);

    Store.checkpoint(note.id);
    await Store.flush();

    assert.equal(patches.length, 2);
    assert.equal(patches[1].files[`${CFG.HOT_PREFIX}n1`], null);
    assert.deepEqual(JSON.parse(patches[1].files[CFG.DATA_FILE].content).notes, [note]);
});

test('switching notes checkpoints the old note and keeps exactly one hot file', async () => {
    const notes = [
        { id: 'a', body: 'A2', updated: '2026-08-16T10:01:00Z' },
        { id: 'b', body: 'B1', updated: '2026-08-16T10:02:00Z' }
    ];
    const state = docket(notes);
    const { Store, CFG, patches } = harness({ files: {}, history: [] });
    Store.bind(() => state);

    Store.touchNote('a');
    await Store.flush();
    Store.touchNote('b');
    await Store.flush();

    const switched = patches[1].files;
    assert.equal(switched[`${CFG.HOT_PREFIX}a`], null);
    assert.ok(switched[`${CFG.HOT_PREFIX}b`]);
    assert.ok(switched[CFG.DATA_FILE]);
});

test('load reconciles newer crash-recovery notes and folds every stale hot file', async () => {
    const archived = { id: 'a', body: 'old', updated: '2026-08-16T10:00:00Z' };
    const recovered = { id: 'a', body: 'new', updated: '2026-08-16T10:05:00Z' };
    const newNote = { id: 'b', body: 'survived', updated: '2026-08-16T10:06:00Z' };
    const payload = {
        files: {
            'docket share.json': { content: JSON.stringify(docket([archived])) },
            'docket-hot-a': { content: JSON.stringify({ note: recovered }) },
            'docket-hot-b': { content: JSON.stringify({ note: newNote }) }
        },
        history: []
    };
    const { Store, CFG, patches } = harness(payload);
    let state = docket([]);
    Store.bind(() => state);

    state = await Store.load();
    assert.equal(state.notes.find((note) => note.id === 'a').body, 'new');
    assert.equal(state.notes.find((note) => note.id === 'b').body, 'survived');

    assert.equal(Store.foldLoadedHot(), true);
    await Store.flush();
    assert.equal(patches[0].files['docket-hot-a'], null);
    assert.equal(patches[0].files['docket-hot-b'], null);
    assert.equal(JSON.parse(patches[0].files[CFG.DATA_FILE].content).notes.length, 2);
});

test('history thinning prevents save-clock noise from consuming the limit', async () => {
    const base = Date.parse('2026-08-16T12:00:00Z');
    const history = Array.from({ length: 80 }, (_, index) => ({
        version: `v${index}`,
        committed_at: new Date(base - index * 30000).toISOString(),
        change_status: { additions: 1, deletions: 1 }
    }));
    const { Store } = harness({
        files: { 'docket share.json': { content: JSON.stringify(docket([])) } },
        history
    });

    await Store.load();
    const rows = Store.history();
    assert.ok(rows.length < 10, `expected aggressive recent thinning, got ${rows.length}`);
    assert.equal(rows[0].sha, 'v0');
});

test('ten quiet minutes creates an archive checkpoint', async () => {
    const note = { id: 'idle', body: 'settled', updated: '2026-08-16T10:00:00Z' };
    const state = docket([note]);
    const { Store, CFG, patches, runTimers } = harness({ files: {}, history: [] });
    Store.bind(() => state);

    Store.touchNote(note.id);
    await Store.flush();
    runTimers(CFG.CHECKPOINT_IDLE_MS);
    await Store.flush();

    assert.equal(patches[1].files[`${CFG.HOT_PREFIX}idle`], null);
    assert.ok(patches[1].files[CFG.DATA_FILE]);
});
