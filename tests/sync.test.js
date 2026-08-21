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
        },
        /** The background refresh: what app.js's pullFromGist does. It
         *  merges the gist into what is already here rather than replacing
         *  it, so an unpushed local change is not binned by a poll. */
        async pull() {
            const data = await self.Store.load();
            if (data) self.state = self.Store.merge(data, self.state);
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

/* ---- the pin travels both ways --------------------------------------- */

/* The tie above is directional: it keeps a pin made HERE, and by exactly
   the same rule it discards one made anywhere else. `pinnedAt` is what
   settles the pin on its own merit instead. */

test('a pin made on the phone reaches the browser that did not make it', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'text', updated: iso(0), pinned: false, pinnedAt: null }
    ]));
    server.state.log = [];

    const phone = browser('phone', server);
    const web = browser('web', server);
    await phone.open();
    await web.open();

    /* Pinning on the phone: `pinned` flips and `updated` deliberately does
       not, so the note is otherwise identical to the copy web holds. */
    const note = phone.state.notes.find((n) => n.id === 'n');
    note.pinned = true;
    note.pinnedAt = iso(5);
    phone.Store.touchData();
    await phone.Store.flush();

    assert.equal(
        JSON.parse(server.state.files['docket share.json'].content).notes[0].pinned,
        true, 'the pin reaches the gist');

    await web.pull();
    assert.equal(web.state.notes.find((n) => n.id === 'n').pinned, true,
        'and lands on the other device');
    assert.equal(web.state.notes.find((n) => n.id === 'n').pinnedAt, iso(5),
        'carrying the stamp that ordered it');
});

test('the browser that did not make the pin does not write it back off', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'text', updated: iso(0), pinned: false, pinnedAt: null }
    ]));
    server.state.log = [];

    const phone = browser('phone', server);
    const web = browser('web', server);
    await phone.open();
    await web.open();

    const note = phone.state.notes.find((n) => n.id === 'n');
    note.pinned = true;
    note.pinnedAt = iso(5);
    phone.Store.touchData();
    await phone.Store.flush();

    /* Web has never seen the pin and now checkpoints something else. The
       guard read in front of that write is the last chance to notice. */
    web.state.notes.push({ id: 'other', body: 'new', updated: iso(6) });
    web.Store.touchData();
    await web.Store.flush();

    const stored = JSON.parse(server.state.files['docket share.json'].content);
    assert.equal(stored.notes.find((n) => n.id === 'n').pinned, true,
        'a browser that never saw the pin must not erase it from the gist');
});

test('an unpin travels too, and outranks the pin it undoes', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'text', updated: iso(0), pinned: true, pinnedAt: iso(5) }
    ]));

    const phone = browser('phone', server);
    const web = browser('web', server);
    await phone.open();
    await web.open();

    /* Unpinning has to be datable, or it is the one change that can never
       out-argue the pin sitting on the other machine. */
    const note = web.state.notes.find((n) => n.id === 'n');
    note.pinned = false;
    note.pinnedAt = iso(9);
    web.Store.touchData();
    await web.Store.flush();

    await phone.pull();
    assert.equal(phone.state.notes.find((n) => n.id === 'n').pinned, false,
        'the later unpin wins');
});

test('a pin survives an edit made to the same note on the other machine', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* The pin loses the note itself here — the remote body is newer — but
       the two changes do not conflict and both should land. */
    const remote = docket([{ id: 'n', body: 'rewritten', updated: iso(9),
                            pinned: false, pinnedAt: null }]);
    const local = docket([{ id: 'n', body: 'old', updated: iso(0),
                           pinned: true, pinnedAt: iso(5) }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.body, 'rewritten', 'the later edit still wins the note');
    assert.equal(merged.pinned, true, 'and the pin rides along');
});

/* ---- Finish Next travels on its own clock too -------------------------

   The second band flag is reconciled exactly the way the pin is, and for
   the same reason: it deliberately does not bump `updated`, so it has to
   carry `finishNextAt` or it loses every tie to the browser doing the
   reconciling. What is worth testing beyond the pin's own cases is that
   the two axes stay independent — one flag settling must not carry the
   other's answer with it. */

test('a Finish Next made on the phone reaches the browser that did not make it', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'text', updated: iso(0), finishNext: false, finishNextAt: null }
    ]));

    const phone = browser('phone', server);
    const web = browser('web', server);
    await phone.open();
    await web.open();

    const note = phone.state.notes.find((n) => n.id === 'n');
    note.finishNext = true;
    note.finishNextAt = iso(5);
    phone.Store.touchData();
    await phone.Store.flush();

    await web.pull();
    assert.equal(web.state.notes.find((n) => n.id === 'n').finishNext, true,
        'the mark lands on the other device');
    assert.equal(web.state.notes.find((n) => n.id === 'n').finishNextAt, iso(5),
        'carrying the stamp that ordered the band');
});

test('clearing Finish Next travels too, and outranks the mark it undoes', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'text', updated: iso(0), finishNext: true, finishNextAt: iso(5) }
    ]));

    const phone = browser('phone', server);
    const web = browser('web', server);
    await phone.open();
    await web.open();

    const note = web.state.notes.find((n) => n.id === 'n');
    note.finishNext = false;
    note.finishNextAt = iso(9);
    web.Store.touchData();
    await web.Store.flush();

    await phone.pull();
    assert.equal(phone.state.notes.find((n) => n.id === 'n').finishNext, false,
        'the later clear wins');
});

test('a pin and a Finish Next made on different machines both land', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* The one case a single shared clock would get wrong: two flags moved
       on two machines, neither change touching `updated`, so the note
       itself is a tie either way. Settled on one axis, the note comes back
       wearing one answer and the other machine's is quietly dropped. */
    const remote = docket([{ id: 'n', body: 'same', updated: iso(0),
                            pinned: false, pinnedAt: null,
                            finishNext: true, finishNextAt: iso(5) }]);
    const local = docket([{ id: 'n', body: 'same', updated: iso(0),
                           pinned: true, pinnedAt: iso(3),
                           finishNext: false, finishNextAt: null }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.pinned, true, 'the pin made here survives');
    assert.equal(merged.finishNext, true, 'and the mark made there arrives');
});

test('a Finish Next survives an edit made to the same note on the other machine', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    const remote = docket([{ id: 'n', body: 'rewritten', updated: iso(9),
                             finishNext: false, finishNextAt: null }]);
    const local = docket([{ id: 'n', body: 'old', updated: iso(0),
                            finishNext: true, finishNextAt: iso(5) }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.body, 'rewritten', 'the later edit still wins the note');
    assert.equal(merged.finishNext, true, 'and the mark rides along');
});

/* ---- the Markdown switch ----------------------------------------------

   Whether a note is drawn as Markdown or as plain text is the third
   change that deliberately does not bump `updated`, and it therefore
   needs the same treatment the two band flags get: a clock of its own, or
   it never survives the trip. The one thing it does not share with them
   is being a boolean — absent means "nobody has said, so look at the
   text", and that has to survive too. */

test('a note switched to plain text on the phone stays plain on the laptop', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* Both copies are the same note. Nothing about the switch touched
       `updated`, so the note itself is a tie — and a tie always keeps
       whatever the browser doing the reconciling already had. */
    const remote = docket([{ id: 'n', body: '# looks like markdown', updated: iso(0),
                             markdown: false, markdownAt: iso(5) }]);
    const local = docket([{ id: 'n', body: '# looks like markdown', updated: iso(0) }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.markdown, false, 'the answer given elsewhere arrives');
    assert.equal(merged.markdownAt, iso(5), 'and brings its date with it');
});

test('the later switch wins, whichever copy of the note wins', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    const remote = docket([{ id: 'n', body: 'rewritten', updated: iso(9),
                             markdown: false, markdownAt: iso(1) }]);
    const local = docket([{ id: 'n', body: 'old', updated: iso(0),
                            markdown: true, markdownAt: iso(6) }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.body, 'rewritten', 'the later edit still wins the note');
    assert.equal(merged.markdown, true, 'and the later switch still wins the switch');
});

test('a docket written before the preview existed still auto-detects', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* The trap a plain boolean cast would set: neither copy has ever said
       anything, and coercing that to `false` on the way through would pin
       every old note to plain text the first time it travelled. */
    const remote = docket([{ id: 'n', body: '# heading\n\n- a\n- b', updated: iso(0) }]);
    const local = docket([{ id: 'n', body: '# heading\n\n- a\n- b', updated: iso(0) }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.notEqual(merged.markdown, false, 'nothing was decided on its behalf');
    assert.ok(merged.markdown == null, 'it is still absent, which means "look at the text"');
});

test('the three stamped switches are settled on three separate axes', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* One shared clock would drop two of these three: none of them bumps
       `updated`, so the note itself is a tie however you look at it. */
    const remote = docket([{ id: 'n', body: 'same', updated: iso(0),
                             pinned: false, pinnedAt: null,
                             finishNext: true, finishNextAt: iso(5),
                             markdown: false, markdownAt: iso(7) }]);
    const local = docket([{ id: 'n', body: 'same', updated: iso(0),
                            pinned: true, pinnedAt: iso(3),
                            finishNext: false, finishNextAt: null }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.pinned, true, 'the pin made here survives');
    assert.equal(merged.finishNext, true, 'the mark made there arrives');
    assert.equal(merged.markdown, false, 'and so does the switch made there');
});

test('a stale hot file does not strip a switch the archive has since gained', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* A hot file is a snapshot of a note as one browser was typing it. It
       knows nothing of a switch another browser has thrown since, and
       folding it in wholesale would undo that before the merge ever saw
       it — the same hole the pin fell down. */
    const archive = docket([{ id: 'n', body: 'typed', updated: iso(2),
                              markdown: true, markdownAt: iso(8) }]);
    const hot = { id: 'n', body: 'typed further', updated: iso(9) };

    const merged = only.Store.merge(archive, docket([hot])).notes[0];
    assert.equal(merged.body, 'typed further', 'the newer text wins');
    assert.equal(merged.markdown, true, 'and the switch it never knew about survives');
});

test('a docket written before Finish Next existed merges as it always did', () => {
    const server = gistServer(docket([]));
    const only = browser('solo', server);

    /* Neither side has the field at all. Nothing may be invented for it,
       and the pin beside it must still settle normally. */
    const remote = docket([{ id: 'n', body: 'same', updated: iso(0), pinned: false }]);
    const local = docket([{ id: 'n', body: 'same', updated: iso(0), pinned: true }]);

    const merged = only.Store.merge(remote, local).notes[0];
    assert.equal(merged.pinned, true);
    assert.equal(merged.finishNext, undefined, 'no flag is conjured onto an old note');
});

test('a stale hot file does not strip a Finish Next the archive has since gained', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'typed', updated: iso(5), finishNext: true, finishNextAt: iso(7) }
    ]));
    /* Left behind by a browser typing before the mark was made: the newer
       note, the older flag. Overlaying it wholesale clears the mark before
       the merge downstream ever sees it. */
    server.state.files['docket-hot-n'] = {
        content: JSON.stringify({
            version: 1, client: 'phone', savedAt: iso(6),
            note: { id: 'n', body: 'typed some more', updated: iso(8),
                    finishNext: false, finishNextAt: null }
        })
    };

    const web = browser('web', server);
    await web.open();

    const note = web.state.notes.find((n) => n.id === 'n');
    assert.equal(note.body, 'typed some more', 'the live draft still wins the text');
    assert.equal(note.finishNext, true, 'without taking the mark off with it');
});

test('a stale hot file does not strip a pin the archive has since gained', async () => {
    const server = gistServer(docket([
        { id: 'n', body: 'typed', updated: iso(5), pinned: true, pinnedAt: iso(7) }
    ]));
    /* Left behind by a browser that was typing before the pin existed: the
       newer note, the older pin. Overlaying it wholesale unpins the note
       before the merge downstream ever sees it. */
    server.state.files['docket-hot-n'] = {
        content: JSON.stringify({
            version: 1, client: 'phone', savedAt: iso(6),
            note: { id: 'n', body: 'typed some more', updated: iso(8),
                    pinned: false, pinnedAt: null }
        })
    };

    const web = browser('web', server);
    await web.open();

    const note = web.state.notes.find((n) => n.id === 'n');
    assert.equal(note.body, 'typed some more', 'the live draft still wins the text');
    assert.equal(note.pinned, true, 'without taking the pin off with it');
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
