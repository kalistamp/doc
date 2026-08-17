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
