const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

test('high-frequency search path updates visibility without rendering cards', () => {
    const listener = app.match(/el\('search'\)\.addEventListener\('input', \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(listener, 'search input listener exists');
    assert.match(listener[1], /applyFilters\(\)/);
    assert.doesNotMatch(listener[1], /renderNotes|renderFiles|sizeCard/);
    assert.match(css, /\.is-filtered\s*\{\s*display:\s*none\s*!important/);
});

test('note and file ids are escaped before entering data attributes', () => {
    assert.match(app, /data-id="\$\{esc\(n\.id\)\}"/);
    assert.match(app, /data-id="\$\{esc\(f\.id\)\}"/);
    assert.doesNotMatch(app, /data-id="\$\{n\.id\}"/);
    assert.doesNotMatch(app, /data-id="\$\{f\.id\}"/);
});

test('the document has no render-blocking third-party font request', () => {
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
    assert.match(css, /--font-body:\s*system-ui/);
});

test('new notes focus and smoothly reveal the exact created card', () => {
    assert.match(app, /revealNewNote\(note\.id\)/);
    assert.match(app, /candidate\.dataset\.id === String\(id\)/);
    assert.match(app, /focus\(\{ preventScroll: true \}\)/);
    assert.match(app, /scrollIntoView\(\{[\s\S]*?behavior: 'smooth',[\s\S]*?block: 'center'/);
    assert.match(app, /el\('search'\)\.value = ''/);
    assert.match(css, /\.note-title\s*\{\s*scroll-margin-block:/);
});

test('the note view menu offers a list and four card sizes, and persists', () => {
    assert.match(html, /id="note-view"/);
    ['list', 'small', 'medium', 'large', 'xlarge'].forEach((view) => {
        assert.match(html, new RegExp(`value="${view}"`), `${view} option exists`);
    });
    /* Medium is deliberately absent below: it is the base .note-grid, so
       overriding it would leave the default with two sources of truth. */
    ['list', 'small', 'large', 'xlarge'].forEach((view) => {
        assert.match(css, new RegExp(`data-note-view="${view}"`), `${view} is styled`);
    });
    assert.doesNotMatch(css, /data-note-view="medium"/);
    assert.doesNotMatch(html, /value="compact"/);
    assert.match(app, /noteView: 'docket\.noteView'/);
    assert.match(app, /localStorage\.setItem\(LS\.noteView, view\)/);
    assert.match(app, /dataset\.noteView = view/);
});

test('every card-sized view has a body height, and list is measured by neither', () => {
    const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
    ['small', 'medium', 'large', 'xlarge'].forEach((view) => {
        assert.match(config, new RegExp(`${view}:\\s*\\{ collapse:`), `${view} has heights`);
    });
    assert.doesNotMatch(config, /list:\s*\{ collapse:/);
    assert.doesNotMatch(config, /compact:\s*\{ collapse:/);
    /* sizeCard must leave before it measures a hidden body, or a list row
       would clamp against a scrollHeight of 0. */
    const sizeCard = app.match(/function sizeCard\(card\) \{([\s\S]*?)\n    \}/);
    assert.ok(sizeCard, 'sizeCard exists');
    assert.match(sizeCard[1], /if \(view === 'list'\)[\s\S]*?return;[\s\S]*?scrollHeight/);
});

test('a device holding the retired compact preference lands on small', () => {
    assert.match(app, /LEGACY_NOTE_VIEWS = \{ compact: 'small' \}/);
    assert.match(app, /LEGACY_NOTE_VIEWS\[value\] \|\| value/);
});

test('the pin is stamped whichever way it is turned', () => {
    const handler = app.match(/act-pin'\)\) \{([\s\S]*?)\n        \} else if/);
    assert.ok(handler, 'the pin control has a handler');
    assert.match(handler[1], /note\.pinned = !note\.pinned/);
    assert.match(handler[1], /note\.pinnedAt = new Date\(\)\.toISOString\(\)/);
    /* Clearing the stamp on the way off is what left an unpin undatable,
       and a merge with nothing to compare falls back to the tie — which
       always keeps whatever the reconciling browser already had. */
    assert.doesNotMatch(handler[1], /pinnedAt = note\.pinned \?/);
    /* And pinning still must not look like an edit. */
    assert.doesNotMatch(handler[1], /note\.updated =|touchNote\(/);
});

/* ---- Finish Next ------------------------------------------------------

   A second band, above Pinned, on a second flag. The two are separate
   features that happen to share a shape, and most of what is asserted here
   is that they stay separate. */

test('Finish Next is its own band, and it stands above Pinned', () => {
    const finish = html.indexOf('id="finish-wrap"');
    const pinned = html.indexOf('id="pinned-wrap"');
    const others = html.indexOf('id="others-title"');
    assert.ok(finish > 0 && pinned > 0, 'both bands exist');
    assert.ok(finish < pinned, 'Finish Next is rendered above Pinned');
    assert.match(html, /id="finish-grid" class="note-grid"/);
    assert.match(app, /el\('finish-grid'\)\.innerHTML = finish\.map\(noteCard\)/);

    /* "Everything else" answers whatever bands are above it, so it belongs
       to neither. Nested inside one, it vanished whenever that band did. */
    assert.ok(others > pinned, 'the others title follows both bands');
    assert.doesNotMatch(html.slice(pinned, others), /id="others-title"/);
    assert.match(app, /others-title'\)\.hidden = rest === 0 \|\| \(finish === 0 && pinned === 0\)/);
});

test('the Finish Next flag is stamped whichever way it is turned', () => {
    const handler = app.match(/act-finish'\)\) \{([\s\S]*?)\n        \} else if/);
    assert.ok(handler, 'the Finish Next control has a handler');
    assert.match(handler[1], /note\.finishNext = !note\.finishNext/);
    assert.match(handler[1], /note\.finishNextAt = new Date\(\)\.toISOString\(\)/);
    /* Same reasoning as the pin: a clear that wiped the stamp would be the
       one change that could never out-argue the flag it undoes. */
    assert.doesNotMatch(handler[1], /finishNextAt = note\.finishNext \?/);
    /* And marking a note is not an edit, so it must not look like one. */
    assert.doesNotMatch(handler[1], /note\.updated =|touchNote\(/);
});

test('the two band flags are separate features and never read each other', () => {
    const finish = app.match(/act-finish'\)\) \{([\s\S]*?)\n        \} else if/);
    const pin = app.match(/act-pin'\)\) \{([\s\S]*?)\n        \} else if/);
    assert.doesNotMatch(finish[1], /note\.pinned/, 'marking a note leaves its pin alone');
    assert.doesNotMatch(pin[1], /finishNext/, 'and pinning leaves the mark alone');

    /* Both controls sit in the footer, and both can be lit at once. */
    assert.match(app, /class="note-act act-finish\$\{n\.finishNext \? ' is-on' : ''\}/);
    assert.match(app, /class="note-act act-pin\$\{n\.pinned \? ' is-on' : ''\}/);
    assert.match(app, /finishNext: false, finishNextAt: null/, 'and a new note has neither');
});

test('a note wearing both flags is drawn once, in the higher band', () => {
    const split = app.match(/function splitNotes\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(split, 'splitNotes exists');
    assert.match(split[1], /finish = notes\.filter\(\(n\) => n\.finishNext\)/);
    assert.match(split[1], /pinned = notes\.filter\(\(n\) => n\.pinned && !n\.finishNext\)/);
    assert.match(split[1], /rest = notes\.filter\(\(n\) => !n\.pinned && !n\.finishNext\)/);

    /* Two cards answering to one data-id is what that avoids — every lookup
       on the board reads the first it finds. The filter pass has to count
       bands the same way, or it titles a band over nothing. */
    const filters = app.match(/function applyNoteFilters\(\) \{([\s\S]*?)\n    \}/);
    assert.match(filters[1],
        /if \(note\.finishNext\) finish\+\+;\s+else if \(note\.pinned\) pinned\+\+;\s+else rest\+\+;/);
});

test('the bomb icon is plain geometry, coloured by nothing of its own', () => {
    const symbol = html.match(/<symbol id="i-bomb"[\s\S]*?<\/symbol>/);
    assert.ok(symbol, 'the sprite carries a bomb');
    assert.match(symbol[0], /viewBox="0 0 24 24"/, 'on the same grid as every other icon');
    /* .ico supplies fill:none and stroke:currentColor once for the whole
       sprite. A symbol carrying its own would be the one icon that ignored
       the theme. */
    assert.doesNotMatch(symbol[0], /fill=|stroke=|style=/);
    assert.match(html, /<use href="#i-bomb">/, 'and it is what the band and the button show');
});

test('deleting a note asks before it acts, and does not also offer Undo', () => {
    const trashItem = app.match(/function trashItem\(kind, item\) \{([\s\S]*?)\n    \}/);
    assert.ok(trashItem, 'trashItem exists');
    assert.match(trashItem[1], /confirmAction\(/, 'a note delete is confirmed first');
    assert.doesNotMatch(trashItem[1], /notes = notes\.filter/,
        'and nothing is removed until the question is answered');

    const binItem = app.match(/function binItem\(kind, item\) \{([\s\S]*?)\n    \}/);
    assert.ok(binItem, 'the deletion itself moved into binItem');
    assert.match(binItem[1], /notes = notes\.filter/);
    /* A note's toast is bare; a file's keeps its Undo, having asked
       nothing. Both still say what happened. */
    assert.match(binItem[1], /toast\(`Note[^`]*`\);/);
    assert.match(binItem[1], /toast\(`File[^`]*`, \(\) => \{[\s\S]*?restoreFromTrash/);
});
