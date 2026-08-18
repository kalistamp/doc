/* Merging notes.

   app.js is one IIFE with no exports, so the part of the merge worth
   running rather than grepping — the composition rules and what becomes of
   the notes that went into it — is lifted out of the source by name and
   run on its own. Nothing lifted here reaches for the DOM; everything the
   merge calls that does is stubbed below, which is also how each test can
   ask whether it was called. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
/* Normalised, because the patterns below anchor on line ends and the file
   is kept with CRLF. */
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

/* Declarations inside the IIFE are indented four spaces, so a function ends
   at the first `}` back at that column and a `const` at its first `;`. A
   rename breaks this loudly rather than silently testing nothing. */
function lift(name) {
    const fn = app.match(new RegExp(`\\n    function ${name}\\([\\s\\S]*?\\n    \\}`));
    if (fn) return fn[0];
    const konst = app.match(new RegExp(`\\n    const ${name} = [\\s\\S]*?;\\n`));
    if (konst) return konst[0];
    throw new Error(`app.js has no liftable declaration named ${name}`);
}

const LIFTED = ['isList', 'noteText', 'derivedTitle', 'titleOf', 'MERGE_RULE',
                'mergeBlock', 'mergedBody', 'plainText', 'mergeNotes'];

/** A context holding `notes`, with everything the merge touches stubbed. */
function harness(notes) {
    let seq = 0;
    const context = {
        Date, Set, JSON, console,
        notes,
        trash: [],
        calls: { checkpoint: 0, render: 0, commit: 0, merging: [], toast: null },
        uid: () => `new-${++seq}`,
        Store: { checkpoint() { context.calls.checkpoint++; } },
        setMerging: (on) => context.calls.merging.push(on),
        renderAll: () => { context.calls.render++; },
        commit: () => { context.calls.commit++; },
        toast: (msg) => { context.calls.toast = msg; }
    };
    vm.createContext(context);
    vm.runInContext(
        `${LIFTED.map(lift).join('\n')}
         globalThis.api = { mergeNotes, mergedBody, mergeBlock, MERGE_RULE };`,
        context);
    return context;
}

const note = (over) => Object.assign({
    id: 'a', kind: 'note', title: '', body: '', pinned: false, pinnedAt: null,
    finishNext: false, finishNextAt: null, folder: null,
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z'
}, over);

/* A checklist has `items` and no `body` at all — that is what newNote
   writes, and asserting on the body means the fixture has to match. */
function list(over) {
    const n = note(Object.assign({ kind: 'checklist', items: [] }, over));
    delete n.body;
    return n;
}

/* ---- what survives ---------------------------------------------------- */

test('the first note picked is the note that survives, and it keeps its identity', () => {
    const base = note({ id: 'base', title: 'Keep me', body: 'one',
                        folder: 'f1', pinned: true, pinnedAt: '2026-02-02T00:00:00.000Z',
                        created: '2025-06-01T00:00:00.000Z' });
    const other = note({ id: 'other', title: 'Second', body: 'two' });
    const ctx = harness([base, other]);

    ctx.api.mergeNotes([base, other]);

    assert.deepEqual(ctx.notes.map((n) => n.id), ['base'], 'only the base is left on the board');
    const merged = ctx.notes[0];
    assert.equal(merged.id, 'base', 'the same note, not a new one');
    assert.equal(merged.title, 'Keep me', 'its own title is not rewritten');
    assert.equal(merged.folder, 'f1');
    assert.equal(merged.created, '2025-06-01T00:00:00.000Z', 'and its own created date');
    /* A merge is an edit of the base and nothing else. The band flags are
       not edits and were not touched, so their stamps must not move. */
    assert.equal(merged.pinned, true);
    assert.equal(merged.pinnedAt, '2026-02-02T00:00:00.000Z');
    assert.ok(Date.parse(merged.updated) > Date.parse('2026-02-02T00:00:00.000Z'),
              'the body changed, so `updated` does move');
});

test('the picks are appended in the order they were picked', () => {
    const one = note({ id: '1', title: 'First', body: 'alpha' });
    const two = note({ id: '2', title: 'Second', body: 'beta' });
    const three = note({ id: '3', title: 'Third', body: 'gamma' });
    const ctx = harness([one, two, three]);

    /* Picked out of board order — the pick order is what the merge follows. */
    ctx.api.mergeNotes([three, one, two]);

    const body = ctx.notes[0].body;
    assert.equal(ctx.notes[0].id, '3');
    assert.ok(body.indexOf('gamma') < body.indexOf('alpha'), 'the base leads');
    assert.ok(body.indexOf('alpha') < body.indexOf('beta'), 'then pick two, then pick three');
    assert.equal(body, 'gamma\n\n---\n\nFirst\n\nalpha\n\n---\n\nSecond\n\nbeta');
});

test('every pick but the base is introduced by its title, and an untitled one by nothing', () => {
    const base = note({ id: 'b', title: 'Base', body: 'body' });
    const titled = note({ id: 't', title: 'Titled', body: 'has one' });
    const bare = note({ id: 'u', title: '   ', body: 'first line is its own heading' });
    const ctx = harness([base, titled, bare]);

    ctx.api.mergeNotes([base, titled, bare]);

    const body = ctx.notes[0].body;
    /* The base's title is the merged note's title; heading its own text with
       it would title a section that is the whole note. */
    assert.ok(!body.startsWith('Base'), 'the base heads nothing');
    assert.match(body, /---\n\nTitled\n\nhas one/);
    assert.match(body, /---\n\nfirst line is its own heading$/,
                 'a note with no real title contributes no heading line');
});

/* ---- what happens to the rest ----------------------------------------- */

test('the notes merged in go to the trash rather than away', () => {
    const base = note({ id: 'base', body: 'a' });
    const gone = note({ id: 'gone', title: 'Swallowed', body: 'b' });
    const ctx = harness([base, gone]);

    ctx.api.mergeNotes([base, gone]);

    assert.equal(ctx.trash.length, 1);
    assert.equal(ctx.trash[0].kind, 'note');
    assert.equal(ctx.trash[0].item.id, 'gone');
    assert.equal(ctx.trash[0].item.title, 'Swallowed', 'restorable as it was');
    assert.equal(ctx.trash[0].purged, undefined);
});

test('a merged-away note is dated as deleted, not as edited', () => {
    const base = note({ id: 'base' });
    const gone = note({ id: 'gone', updated: '2026-01-01T00:00:00.000Z' });
    const ctx = harness([base, gone]);

    ctx.api.mergeNotes([base, gone]);

    /* store.js keeps a tombstone unless the item's own stamp is LATER than
       the deletion. Touching `updated` here is exactly how a merged-away
       note would out-argue its own tombstone and walk back in from the
       other browser on the next reconcile. */
    const entry = ctx.trash[0];
    assert.equal(entry.item.updated, '2026-01-01T00:00:00.000Z', 'its stamp is left alone');
    assert.ok(Date.parse(entry.deletedAt) > Date.parse(entry.item.updated),
              'so the tombstone is the later word');
});

test('the editing session is finished before any note is merged away', () => {
    const base = note({ id: 'base' });
    const gone = note({ id: 'gone' });
    const ctx = harness([base, gone]);

    ctx.api.mergeNotes([base, gone]);

    /* A hot file left behind for a note that has just been merged away is
       a note that walks back in on the next load. */
    assert.equal(ctx.calls.checkpoint, 1);
    assert.equal(ctx.calls.commit, 1, 'and the merged archive is committed');
    assert.deepEqual(ctx.calls.merging, [false], 'picking ends with the merge');
});

/* ---- kinds ------------------------------------------------------------ */

test('checklists merged into a checklist stay a checklist', () => {
    const base = list({ id: 'b', items: [{ id: 'i1', text: 'one', done: true }] });
    const other = list({ id: 'o', items: [{ id: 'i2', text: 'two', done: false }] });
    const ctx = harness([base, other]);

    ctx.api.mergeNotes([base, other]);

    const merged = ctx.notes[0];
    assert.equal(merged.kind, 'checklist');
    assert.equal(merged.body, undefined, 'and grows no body on the way');
    /* Array.from, not .map: the merged items were built inside the vm, so a
       deepStrictEqual against a literal here would fail on the realm rather
       than on the contents. */
    assert.deepEqual(Array.from(merged.items, (i) => i.text), ['one', 'two']);
    assert.deepEqual(Array.from(merged.items, (i) => i.done), [true, false], 'ticks survive');
});

test('merged items are copies, so the merged note and its trashed source do not share an array', () => {
    const base = list({ id: 'b', items: [{ id: 'i1', text: 'one', done: false }] });
    const other = list({ id: 'o', items: [{ id: 'i2', text: 'two', done: false }] });
    const ctx = harness([base, other]);

    ctx.api.mergeNotes([base, other]);

    const merged = ctx.notes[0];
    merged.items[1].text = 'edited here';
    merged.items[1].done = true;

    /* The source is in the trash, not out of existence — restore it and it
       has to be the note that was merged, not a view of the merge. */
    assert.equal(ctx.trash[0].item.items[0].text, 'two');
    assert.equal(ctx.trash[0].item.items[0].done, false);
    /* Fresh ids too: two items answering to one id inside one note is the
       same bug one card answering to one note id would be. */
    const ids = merged.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.startsWith('new-')), 'and none are the originals');
});

test('a mixed pick lands as text, and the checklists in it come out as [x] lines', () => {
    const base = list({ id: 'b', title: 'Shopping',
                        items: [{ id: 'i1', text: 'milk', done: true },
                                { id: 'i2', text: 'bread', done: false }] });
    const plain = note({ id: 'p', title: 'Note', body: 'just words' });
    const ctx = harness([base, plain]);

    ctx.api.mergeNotes([base, plain]);

    const merged = ctx.notes[0];
    assert.equal(merged.kind, 'note', 'the checklist base flattens');
    assert.equal(merged.items, undefined, 'and its items go with it');
    assert.equal(merged.body, '[x] milk\n[ ] bread\n\n---\n\nNote\n\njust words');
});

/* ---- edges ------------------------------------------------------------ */

test('the base keeps a deliberate opening blank line; the picks below it do not', () => {
    const base = note({ id: 'b', body: '\n\nopens on a blank line\n\n\n' });
    const other = note({ id: 'o', body: '\n\npadded either side\n\n' });
    const ctx = harness([base, other]);

    ctx.api.mergeNotes([base, other]);

    assert.equal(ctx.notes[0].body, '\n\nopens on a blank line\n\n---\n\npadded either side');
});

test('an empty note in the pick leaves no rule hanging over nothing', () => {
    const base = note({ id: 'b', body: '' });
    const empty = note({ id: 'e', title: '', body: '   ' });
    const real = note({ id: 'r', title: 'Real', body: 'text' });
    const ctx = harness([base, empty, real]);

    ctx.api.mergeNotes([base, empty, real]);

    assert.equal(ctx.notes[0].body, 'Real\n\ntext');
});

test('the rule between two notes is plain ASCII', () => {
    const ctx = harness([]);
    /* These bodies are read in a monospaced focus view, copied to the
       clipboard and written into the .txt export. */
    assert.equal(ctx.api.MERGE_RULE, '\n\n---\n\n');
    assert.match(ctx.api.MERGE_RULE, /^[\n-]+$/);
});
