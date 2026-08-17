/* Two browsers, one gist.
   Everything here runs two independent store.js instances against a single
   fake gist that keeps GitHub's semantics: a PATCH touches only the files
   it names, a null value deletes one, and an unchanged gist answers a
   conditional GET with 304. These are the cases where a second browser
   used to quietly undo the first one's work. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'store.js'), 'utf8');

/* ---- the shared gist ------------------------------------------------- */

function gistServer(seed) {
    const state = { files: {}, revision: 0, gets: 0, conditionalHits: 0 };
    if (seed) state.files['docket share.json'] = { content: JSON.stringify(seed) };

    const etag = () => `"rev-${state.revision}"`;

    const reply = (status, body, headers = {}) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] || null },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    });

    return {
        state,
        handle(who, url, options = {}) {
            if (options.method === 'PATCH') {
                const files = JSON.parse(options.body).files;
                Object.keys(files).forEach((name) => {
                    if (files[name] === null) delete state.files[name];
                    else state.files[name] = { content: files[name].content };
                });
                state.revision++;
                state.log.push(`${who} PATCH ${Object.keys(files).map((n) =>
                    files[n] === null ? `-${n}` : n).join(' ')}`);
                return reply(200, { history: [{ version: `v${state.revision}` }] },
                    { etag: etag() });
            }
            state.gets++;
            const sent = options.headers && options.headers['If-None-Match'];
            if (sent && sent === etag()) {
                state.conditionalHits++;
                return reply(304, null, { etag: etag() });
            }
            return reply(200, {
                files: JSON.parse(JSON.stringify(state.files)),
                history: [{ version: `v${state.revision}` }]
            }, { etag: etag() });
        }
    };
}

/* ---- one browser ------------------------------------------------------ */

function browser(name, server) {
    const storage = new Map([['docket.token', 't'], ['docket.gistId', 'g']]);
    const timers = new Map();
    let timerId = 0;
    const context = {
        console, Date, encodeURIComponent,
        setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id) => timers.delete(id),
        window: {},
        localStorage: {
            getItem: (k) => storage.get(k) || null,
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: (k) => storage.delete(k)
        },
        fetch: async (url, options) => server.handle(name, url, options)
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(configSource, context, { filename: 'config.js' });
    vm.runInContext(storeSource, context, { filename: 'store.js' });

    const self = {
        name,
        Store: context.window.DocketStore,
        CFG: context.window.DOCKET_CONFIG,
        state: null,
        timerDelays: () => Array.from(timers.values()).map((t) => t.delay),
        /** Open the app: pull, install, and wire the adopt callback exactly
         *  the way app.js does. */
        async open() {
            self.state = await self.Store.load();
            self.Store.bind(() => self.state, (merged) => { self.state = merged; });
            return self.state;
        }
    };
    return self;
}

const iso = (min) => new Date(Date.UTC(2026, 7, 17, 12, min)).toISOString();
const docket = (notes, extra) => Object.assign(
    { notes: notes || [], files: [], folders: [], trash: [] }, extra);

/* ---- the cases -------------------------------------------------------- */

test('concurrent archive writes from two browsers keep both dockets', async () => {
    const server = gistServer(docket([{ id: 'shared', body: 'original', updated: iso(0) }]));
    server.state.log = [];

    const chrome = browser('chrome', server);
    const firefox = browser('firefox', server);
    await chrome.open();
    await firefox.open();

    /* Neither has pulled since; each makes a structural change and pushes. */
    chrome.state.notes.unshift({ id: 'from-chrome', body: 'x', updated: iso(1) });
    chrome.Store.touchData();
    await chrome.Store.flush();

    firefox.state.notes.unshift({ id: 'from-firefox', body: 'y', updated: iso(2) });
    firefox.Store.touchData();
    await firefox.Store.flush();

    const ids = JSON.parse(server.state.files['docket share.json'].content)
        .notes.map((n) => n.id).sort();
    assert.deepEqual(ids, ['from-chrome', 'from-firefox', 'shared'],
        'the second writer must merge, not replace');
});

test('an unchanged gist answers the pre-write check with 304, not a merge', async () => {
    const server = gistServer(docket([{ id: 'a', body: 'one', updated: iso(0) }]));
    server.state.log = [];

    const only = browser('solo', server);
    await only.open();

    only.state.notes[0].body = 'two';
    only.state.notes[0].updated = iso(1);
    only.Store.touchData();
    await only.Store.flush();

    assert.equal(server.state.conditionalHits, 1,
        'the guard read should be conditional and hit');
    assert.equal(JSON.parse(server.state.files['docket share.json'].content).notes[0].body,
        'two');
});

test('opening a second browser leaves the first one\'s live hot file alone', async () => {
    const server = gistServer(docket([{ id: 'n1', body: 'para one', updated: iso(0) }]));
    server.state.log = [];

    const chrome = browser('chrome', server);
    await chrome.open();

    /* Chrome is mid-note: typing writes only the compact hot file. */
    chrome.state.notes[0].body = 'para one\npara two';
    chrome.state.notes[0].updated = iso(5);
    chrome.Store.touchNote('n1');
    await chrome.Store.flush();
    assert.ok(server.state.files['docket-hot-n1'], 'chrome has a hot file');

    /* Firefox opens and does what pullFromGist does. */
    const firefox = browser('firefox', server);
    await firefox.open();
    assert.equal(firefox.Store.foldLoadedHot(), false,
        'someone else\'s live draft is not ours to fold');
    await firefox.Store.flush();

    assert.ok(server.state.files['docket-hot-n1'],
        'chrome\'s unsaved draft must survive firefox merely opening');
    /* The recovered text still reached firefox's view of the docket. */
    assert.match(firefox.state.notes.find((n) => n.id === 'n1').body, /para two/);
});

test('a hot file left by a crashed browser is still folded', async () => {
    const server = gistServer(docket([{ id: 'n1', body: 'old', updated: iso(0) }]));
    server.state.log = [];
    const abandoned = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    server.state.files['docket-hot-n1'] = {
        content: JSON.stringify({
            version: 1, client: 'a-browser-that-is-gone', savedAt: abandoned,
            note: { id: 'n1', body: 'recovered', updated: iso(5) }
        })
    };

    const fresh = browser('fresh', server);
    await fresh.open();
    assert.equal(fresh.state.notes[0].body, 'recovered', 'crash recovery still works');
    assert.equal(fresh.Store.foldLoadedHot(), true, 'an abandoned hot file folds');
    await fresh.Store.flush();
    assert.equal(server.state.files['docket-hot-n1'], undefined);
});

test('a delete made on one browser survives a merge with one that still has it', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    const note = { id: 'gone', body: 'text', updated: iso(0) };
    const remote = docket([], { trash: [{ kind: 'note', item: note, deletedAt: iso(5) }] });
    const local = docket([note]);

    const merged = only.Store.merge(remote, local);
    assert.equal(merged.notes.length, 0, 'a tombstone beats a stale copy');
    assert.equal(merged.trash.length, 1);
});

test('editing a note after another browser binned it wins, and clears the tombstone', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    const remote = docket([], {
        trash: [{ kind: 'note', item: { id: 'x', body: 'old' }, deletedAt: iso(5) }]
    });
    const local = docket([{ id: 'x', body: 'kept typing', updated: iso(9) }]);

    const merged = only.Store.merge(remote, local);
    assert.equal(merged.notes.length, 1, 'the later edit wins');
    assert.equal(merged.trash.length, 0, 'and takes its tombstone with it');
});

test('a purged item does not come back from a browser that still holds it', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    const note = { id: 'p', body: 'text', updated: iso(0) };
    /* Emptying the trash leaves the id, the date and a flag. */
    const remote = docket([], {
        trash: [{ kind: 'note', item: { id: 'p' }, deletedAt: iso(5), purged: true }]
    });
    const local = docket([note], {
        trash: [{ kind: 'note', item: note, deletedAt: iso(5) }]
    });

    const merged = only.Store.merge(remote, local);
    assert.equal(merged.notes.length, 0);
    assert.equal(merged.trash[0].purged, true, 'a purge is sticky');
});

test('a change that deliberately does not bump `updated` survives the merge', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* Pinning must not touch `updated` — a note you merely pinned should not
       jump up a recently-updated sort — so the tie has to go to the browser
       doing the reconciling, which is the one that just pinned it. */
    const remote = docket([{ id: 'n', body: 'same', updated: iso(0), pinned: false }]);
    const local = docket([{ id: 'n', body: 'same', updated: iso(0), pinned: true }]);

    assert.equal(only.Store.merge(remote, local).notes[0].pinned, true);
});

test('a failed write arms its own retry instead of parking on Failed', async () => {
    const server = gistServer(docket([]));
    server.state.log = [];
    const flaky = browser('flaky', server);
    const real = server.handle.bind(server);
    let fail = true;
    server.handle = (who, url, options) => {
        if (options && options.method === 'PATCH' && fail) {
            fail = false;
            return {
                ok: false, status: 500,
                headers: { get: () => null },
                json: async () => ({ message: 'server error' })
            };
        }
        return real(who, url, options);
    };

    flaky.state = docket([{ id: 'z', body: 'important', updated: iso(9) }]);
    flaky.Store.bind(() => flaky.state, (merged) => { flaky.state = merged; });
    flaky.Store.touchData();
    await flaky.Store.flush();

    assert.match(flaky.Store.lastError(), /500/);
    assert.ok(flaky.Store.hasPending(), 'the work is still queued');
    assert.ok(flaky.timerDelays().includes(flaky.CFG.RETRY_BASE_MS),
        'and a retry is armed to carry it up');
});

test('a rate-limited 403 is not reported as a token-scope problem', async () => {
    const server = gistServer(docket([]));
    const limited = browser('limited', server);
    const real = server.handle.bind(server);
    server.handle = (who, url, options) => {
        if (options && options.method === 'PATCH') {
            return {
                ok: false, status: 403,
                headers: { get: (n) => (String(n).toLowerCase() === 'retry-after' ? '31' : null) },
                json: async () => ({ message: 'You have exceeded a secondary rate limit' })
            };
        }
        return real(who, url, options);
    };

    limited.state = docket([{ id: 'z', body: 'x', updated: iso(1) }]);
    limited.Store.bind(() => limited.state, (m) => { limited.state = m; });
    limited.Store.touchData();
    await limited.Store.flush();

    const message = limited.Store.lastError();
    assert.match(message, /rate-limiting/);
    assert.doesNotMatch(message, /Read and write/,
        'telling the user to fix a permission they have not got wrong wastes their afternoon');
    assert.ok(limited.timerDelays().includes(31000), 'and Retry-After is honoured');
});
