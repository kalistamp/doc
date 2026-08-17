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

test('compact, medium and large note views are persistent and resize cards', () => {
    assert.match(html, /id="note-view"/);
    assert.match(html, /value="compact"/);
    assert.match(html, /value="medium"/);
    assert.match(html, /value="large"/);
    assert.match(app, /noteView: 'docket\.noteView'/);
    assert.match(app, /localStorage\.setItem\(LS\.noteView, view\)/);
    assert.match(app, /dataset\.noteView = view/);
    assert.match(css, /data-note-view="compact"/);
    assert.match(css, /data-note-view="large"/);
});
