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
