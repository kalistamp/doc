const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');

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

test('the document restricts network and script sources', () => {
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /connect-src 'self' https:\/\/baiojghilzxhkebfblzv\.supabase\.co wss:\/\/baiojghilzxhkebfblzv\.supabase\.co/);
    assert.match(html, /script-src 'self' 'sha384-[A-Za-z0-9+/=]+' https:\/\/cdn\.jsdelivr\.net/);
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
    assert.match(html, /name="referrer" content="no-referrer"/);
});

test('the Supabase SDK is pinned and integrity checked', () => {
    assert.match(html, /@supabase\/supabase-js@2\.57\.4\/dist\/umd\/supabase\.min\.js/);
    assert.match(html, /integrity="sha384-AkNSQdptcXlJ0\/NBZc4qGk86cDVXcCevwoWgEKIpHOEfbvlXGLlIkimQtONt8KNf"/);
    assert.doesNotMatch(html, /@supabase\/supabase-js@2["/]/);
});

test('the Supabase migration removes obsolete browser-stored GitHub credentials', () => {
    assert.match(app, /\['docket\.token', 'docket\.gistId'\]\.forEach/);
    assert.match(app, /localStorage\.removeItem\(key\)/);
    assert.doesNotMatch(app, /localStorage\.setItem\(['"]docket\.token/);
});

test('revision history is loaded only when its dialog opens', () => {
    const handler = app.match(/el\('history-btn'\)\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(handler, 'history button handler exists');
    assert.match(handler[1], /await Store\.loadHistory\(\)/);
});

test('new notes focus and smoothly reveal the exact created card', () => {
    assert.match(app, /revealNewNote\(note\.id\)/);
    assert.match(app, /candidate\.dataset\.id === String\(id\)/);
    assert.match(app, /focus\(\{ preventScroll: true \}\)/);
    assert.match(app, /scrollIntoView\(\{[\s\S]*?behavior: 'smooth',[\s\S]*?block: 'center'/);
    assert.match(app, /el\('search'\)\.value = ''/);
});

test('a new note opens with the caret in what you came to write in', () => {
    /* The title borrows the first line of an untitled note, so opening in
       the title field asks for something the note supplies on its own. */
    const reveal = app.match(/function revealNewNote\(id\) \{([\s\S]*?)\n    \}/);
    assert.ok(reveal, 'revealNewNote exists');
    assert.match(reveal[1], /querySelector\('\.note-body'\) \|\|[\s\S]*?querySelector\('\.check-text'\)/,
                 'the body, or a checklist\'s first item');
    assert.doesNotMatch(reveal[1], /querySelector\('\.note-title'\)/);
    /* And whichever it lands on has to carry the scroll margin, or the
       reveal centres it under the browser chrome or a phone keyboard. */
    assert.match(css, /\.note-title, \.note-body, \.check-text \{ scroll-margin-block:/);
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

test('the Finish Next flag is plain geometry, coloured by nothing of its own', () => {
    const symbol = html.match(/<symbol id="i-flag"[\s\S]*?<\/symbol>/);
    assert.ok(symbol, 'the sprite carries a flag');
    assert.match(symbol[0], /viewBox="0 0 24 24"/, 'on the same grid as every other icon');
    /* .ico supplies fill:none and stroke:currentColor once for the whole
       sprite. A symbol carrying its own would be the one icon that ignored
       the theme — and the raised flag below fills from CSS for the same
       reason, so the geometry has to stay unpainted. */
    assert.doesNotMatch(symbol[0], /fill=|stroke=|style=/);
    assert.match(html, /<use href="#i-flag">/, 'the band shows it');
    assert.match(app, /act-finish\$\{n\.finishNext \? ' is-on' : ''\}/);
    assert.match(app, /<use href="#i-flag">/, 'and so does the button');
    /* Nothing should still be reaching for the icon this replaced. */
    assert.doesNotMatch(html + app, /i-bomb/);
});

test('a raised flag is solid, and the pin it sits beside is not', () => {
    /* Both controls light up in the same accent, so when a note wears both
       the colour says nothing about which is which. The flag has a second
       shape to give and the pin does not, which is the whole reason only
       one of them fills. */
    assert.match(css, /\.note-act\.act-finish\.is-on \.ico \{ fill: currentColor; \}/);
    assert.doesNotMatch(css, /\.act-pin\.is-on \.ico \{ fill/);
    assert.match(css, /#finish-wrap \.band-title \.ico \{ fill: currentColor; \}/,
                 'and the band wears it raised too');
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

/* ---- Merge ------------------------------------------------------------

   Picking notes to merge turns the board into a selection surface, and the
   composition rules themselves are exercised in merge.test.js. What is
   asserted here is the wiring around them: that picking replaces the board's
   normal controls rather than sitting beside them, and that every way out of
   the mode actually leaves it. */

test('picking replaces the notes bar rather than joining it', () => {
    assert.match(html, /id="merge-btn"/, 'a Merge button opens the mode');
    assert.match(html, /<div class="panel-bar" id="notes-bar">/);
    assert.match(html, /<div class="panel-bar merge-bar" id="merge-bar" hidden>/);
    /* Sort, view and New note all act on the board the pick order is
       counted against, so they go away while it is being counted. */
    const setMerging = app.match(/function setMerging\(on\) \{([\s\S]*?)\n    \}/);
    assert.ok(setMerging, 'setMerging exists');
    assert.match(setMerging[1], /el\('notes-bar'\)\.hidden = on/);
    assert.match(setMerging[1], /el\('merge-bar'\)\.hidden = !on/);
    assert.match(setMerging[1], /picked = \[\]/, 'and the picks do not outlive the mode');
});

test('the pick order is kept as an order, and shown as one', () => {
    /* An array and not a Set: which note was picked first is the whole
       feature, since it is the note the others are merged into. */
    assert.match(app, /let picked = \[\]/);
    assert.match(app, /picked\.push\(String\(id\)\)/);
    assert.match(app, /note-pick-num'\)\.textContent = at === -1 \? '' : String\(at \+ 1\)/);
    assert.match(app, /card\.classList\.toggle\('is-base', at === 0\)/);
    assert.match(html, /id="merge-lede"/, 'and the bar names the note being merged into');
});

test('while picking, a card is one control and nothing else on it acts', () => {
    /* The click handler is delegated for the whole panel, so the check has
       to come before every other action it dispatches. */
    const handler = app.match(/el\('panel-notes'\)\.addEventListener\('click', \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(handler, 'the notes click handler exists');
    const guard = handler[1].indexOf('if (merging)');
    assert.ok(guard > -1, 'picking is checked');
    ['check-box', 'act-pin', 'act-finish', 'act-del', 'note-expand'].forEach((act) => {
        assert.ok(guard < handler[1].indexOf(act), `${act} is dispatched after the check`);
    });
    /* And the writing surfaces stop taking clicks, or reaching for a note
       lands a caret in its body instead of picking it. */
    assert.match(css, /#panel-notes\.is-picking \.note-title,[\s\S]*?pointer-events: none/);
    assert.match(css, /\.note-pick \{ display: none; \}/, 'and the badge is off the board otherwise');
});

test('every way out of picking leaves it', () => {
    assert.match(app, /el\('merge-cancel'\)\.addEventListener\('click', \(\) => setMerging\(false\)\)/);
    assert.match(app, /else if \(merging\) setMerging\(false\);/, 'Escape');
    /* A pick order counted against the notes board means nothing on another
       tab, and the bar it replaced is that tab's own. */
    assert.match(app, /if \(merging && name !== 'notes'\) setMerging\(false\)/);
    const merge = app.match(/function mergeNotes\(list\) \{([\s\S]*?)\n    \}/);
    assert.match(merge[1], /setMerging\(false\)/, 'and the merge itself');
});

test('a re-render puts the pick numbers back', () => {
    /* renderNotes repaints all three grids, so the numbers go with them —
       and a background sync repaints on its own schedule, mid-pick. */
    const render = app.match(/function renderNotes\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(render, 'renderNotes exists');
    assert.match(render[1], /applyPicks\(\)/);
    assert.match(app, /picked = picked\.filter\(\(id\) => findNote\(id\)\)/,
                 'and a note the sync took with it drops out of the picks');
});

test('a merge asks first, and the question is not dressed as a deletion', () => {
    const go = app.match(/el\('merge-go'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(go, 'the Merge button has a handler');
    assert.match(go[1], /confirmAction\(/, 'nothing is merged until the question is answered');
    assert.doesNotMatch(go[1], /notes = notes\.filter/);
    assert.match(go[1], /\(\) => mergeNotes\(list\), 'Merge'\)/, 'and the button says Merge');

    const confirm = app.match(/function confirmAction\(title, body, onOk, ok\) \{([\s\S]*?)\n    \}/);
    assert.ok(confirm, 'confirmAction takes a label');
    assert.match(confirm[1], /textContent = ok \|\| 'Delete'/, 'and still defaults to Delete');
    assert.match(confirm[1], /classList\.toggle\('btn-danger', !ok\)/);
});

test('the notes merged in go to the trash, and stay there', () => {
    const merge = app.match(/function mergeNotes\(list\) \{([\s\S]*?)\n    \}/);
    assert.ok(merge, 'mergeNotes exists');
    assert.match(merge[1], /trash\.unshift\(\{\s*\n?\s*kind: 'note', item: n, deletedAt: base\.updated/);
    /* store.js keeps a tombstone only while the item's own stamp is not
       later than the deletion, so only the base may be dated. */
    assert.match(merge[1], /base\.updated = new Date\(\)\.toISOString\(\)/);
    assert.doesNotMatch(merge[1], /n\.updated =|rest\.forEach\(\(n\) => \{ n\.updated/);
    /* And a hot file left behind for a note that has just been merged away
       is a note that walks back in on the next load. */
    assert.match(merge[1], /Store\.checkpoint\(\)/);
});

test('the merge icon is plain geometry, coloured by nothing of its own', () => {
    const symbol = html.match(/<symbol id="i-merge"[\s\S]*?<\/symbol>/);
    assert.ok(symbol, 'the sprite carries a merge glyph');
    assert.match(symbol[0], /viewBox="0 0 24 24"/, 'on the same grid as every other icon');
    assert.doesNotMatch(symbol[0], /fill=|stroke=|style=/);
    assert.match(html, /<use href="#i-merge">/);
});

test('the cache buster moved with the scripts and the sheet', () => {
    /* Pages serves this repo root; a returning visitor otherwise runs a
       stale app.js against the new markup. */
    assert.doesNotMatch(html, /\?v=19/);
    ['style.css', 'config.js', 'store.js', 'markdown.js', 'app.js'].forEach((asset) => {
        assert.match(html, new RegExp(`${asset.replace('.', '\\.')}\\?v=20`), `${asset} is busted`);
    });
});

test('note keystrokes cache and queue only the edited note', () => {
    const durable = app.match(/function durableNote\(note\) \{([\s\S]*?)\n    \}/);
    assert.ok(durable);
    assert.match(durable[1], /Store\.cacheItem\('note', note\)/);
    assert.match(durable[1], /Store\.touchNote\(note\.id\)/);
    assert.doesNotMatch(durable[1], /cache\(\)|JSON\.stringify/);
});

test('file bytes move directly between File or Blob objects and private Storage', () => {
    assert.match(app, /await Store\.putBlob\(id, file\)/);
    assert.match(app, /const blob = await Store\.getBlob\(meta\)/);
    assert.doesNotMatch(app, /readAsDataURL|readBase64|base64ToBlob/);
});

test('cloud changes arrive through Realtime without a polling interval', () => {
    assert.match(app, /Store\.subscribe\(\(revision\) => refresh\(true, revision\)\)/);
    assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) refresh/);
});

test('markdown.js loads before the app that calls into it', () => {
    /* app.js reads window.DocketMarkdown at the top of its IIFE, so the
       order in the document is the whole of the contract between them. */
    assert.ok(html.indexOf('markdown.js') < html.indexOf('app.js?v='),
              'the renderer is defined first');
    assert.match(app, /const MD = window\.DocketMarkdown/);
});

/* ---- Markdown preview -------------------------------------------------

   A note that reads like Markdown is drawn rendered rather than as the
   source you typed. What is asserted here is the wiring: that the two
   surfaces agree on which notes those are, that the toggle is a note's
   own answer and not a device's, and that switching one is treated as the
   view change it is rather than as an edit. The renderer and the detector
   themselves are exercised in markdown.test.js. */

test('the rendered body replaces the textarea rather than sitting beside it', () => {
    const card = app.match(/function noteCard\(n\) \{([\s\S]*?)\n    \}/);
    assert.ok(card, 'noteCard exists');
    assert.match(card[1], /const markdown = showsMarkdown\(n\)/);
    assert.match(card[1], /markdown\s*\n?\s*\? `<div class="note-md md-body">\$\{markdownHtml\(n\)\}<\/div>`/);
    /* Two bodies in one card would be two answers to `.note-body`, and
       every keystroke handler on the panel reads the first it finds. */
    assert.match(card[1], /: `\s*\n\s*<textarea class="note-body"/);
});

test('detection is asked once per note and re-asked when its text changes', () => {
    /* renderNotes runs on every pin, search, delete and background sync,
       and both detecting and rendering walk the whole body. */
    const memo = app.match(/function markdownMemo\(n\) \{([\s\S]*?)\n    \}/);
    assert.ok(memo, 'markdownMemo exists');
    assert.match(memo[1], /entry\.body !== body/, 'a changed body invalidates it');
    assert.match(app, /if \(entry\.looks === null\) entry\.looks = MD\.looksLikeMarkdown/);
    assert.match(app, /if \(entry\.html === null\) entry\.html = MD\.render/);
    assert.match(app, /pruneMarkdownMemo\(\)/, 'and dead entries are swept');
});

test('the note override is three-valued, so an old note still auto-detects', () => {
    /* `false` has to mean "shown as plain text because you said so", which
       leaves absent as the only spelling for "nobody has said". A boolean
       would read every note written before this as a decision. */
    const shows = app.match(/function showsMarkdown\(n\) \{([\s\S]*?)\n    \}/);
    assert.ok(shows, 'showsMarkdown exists');
    assert.match(shows[1], /if \(typeof n\.markdown === 'boolean'\) return n\.markdown/);
    assert.match(shows[1], /isList\(n\)\) return false/, 'a checklist has no body to render');
    assert.match(app, /markdown: null, markdownAt: null/, 'and a new note has said nothing');
});

test('switching a note between the two views is not an edit', () => {
    const setter = app.match(/function setMarkdown\(note, on\) \{([\s\S]*?)\n    \}/);
    assert.ok(setter, 'setMarkdown exists');
    assert.match(setter[1], /note\.markdown = on/);
    assert.match(setter[1], /note\.markdownAt = new Date\(\)\.toISOString\(\)/);
    /* The same rule the pin follows: a note you merely re-drew must not
       jump up a recently-updated sort, and a change that never bumps
       `updated` needs a clock of its own to reach another device at all. */
    assert.doesNotMatch(setter[1], /note\.updated =|touchNote\(/);
    assert.match(app, /String\(item\.markdown\)\]\.join\('~'\)/,
                 'and the fingerprint notices one arriving from elsewhere');
});

test('both the card and the focus view carry the switch', () => {
    assert.match(app, /class="note-act act-md\$\{markdown \? ' is-on' : ''\}/);
    assert.match(html, /id="focus-mode" class="seg"/);
    assert.match(html, /data-mode="text"/);
    assert.match(html, /data-mode="markdown"/);
    assert.match(html, /<div id="focus-md" class="focus-md md-body"/);
    /* A checklist has neither a body nor anything to preview. */
    assert.match(app, /\$\{isList\(n\) \? '' : `<button class="note-act act-md/);
    assert.match(app, /el\('focus-mode'\)\.hidden = list/);
});

test('a rendered card opens the note rather than swallowing the click', () => {
    const handler = app.match(/el\('panel-notes'\)\.addEventListener\('click', \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(handler, 'the notes click handler exists');
    assert.match(handler[1], /act-md'\)\) \{[\s\S]*?setMarkdown\(note, !showsMarkdown\(note\)\)/);
    assert.match(handler[1], /note-md'\)\) \{[\s\S]*?if \(!e\.target\.closest\('a'\)\) openFocus\(note\.id\)/,
                 'a link inside the note is followed, not intercepted');
    /* And picking notes for a merge still comes first, or reaching for a
       rendered card would open it instead of picking it. */
    assert.ok(handler[1].indexOf('if (merging)') < handler[1].indexOf('act-md'));
});

test('the focus view has one place that decides which surface is showing', () => {
    const render = app.match(/function renderFocusBody\(note\) \{([\s\S]*?)\n    \}/);
    assert.ok(render, 'renderFocusBody exists');
    ['focus-body', 'focus-md', 'focus-items', 'focus-mode'].forEach((id) => {
        assert.ok(render[1].includes(`el('${id}').hidden`), `${id} is set here`);
    });
    assert.match(app, /function openFocus\(id\) \{[\s\S]*?renderFocusBody\(note\)/);
    /* The word count reads the note, because the textarea is empty while
       the preview is up. */
    const meta = app.match(/function updateFocusMeta\(\) \{([\s\S]*?)\n    \}/);
    assert.match(meta[1], /const body = note\.body \|\| ''/);
});

test('a rendered body is clamped and expanded like any other long note', () => {
    const sizeCard = app.match(/function sizeCard\(card\) \{([\s\S]*?)\n    \}/);
    assert.ok(sizeCard, 'sizeCard exists');
    /* A <div> grows on its own, so it is capped the way a checklist is
       rather than measured the way a textarea has to be. */
    assert.match(sizeCard[1], /querySelector\('\.check-wrap, \.note-md'\)/);
    assert.match(css, /\.note\.is-clamped \.note-fade \{ opacity: 1; \}/);
});

test('the tags the renderer emits are styled once, for both places it draws', () => {
    ['h1', 'h2', 'blockquote', 'pre', 'code', 'table', 'hr', 'img']
        .forEach((tag) => {
            assert.match(css, new RegExp(`\\.md-body ${tag}[ ,{]`), `${tag} is styled`);
        });
    /* A card is as wide as its column, so the two things that cannot wrap
       scroll inside themselves instead of taking the board sideways. */
    assert.match(css, /\.md-body pre \{[\s\S]*?overflow-x: auto/);
    assert.match(css, /\.md-tablewrap \{[\s\S]*?overflow-x: auto/);
    /* And nothing here names a colour of its own, or dark mode would need
       a second copy of the whole block. */
    const block = css.match(/MARKDOWN\r?\n[\s\S]*?\r?\n\/\* =+\r?\n   FILES/);
    assert.ok(block, 'the markdown block exists');
    assert.doesNotMatch(block[0], /#[0-9a-f]{3,6}\b/i);
});

test('the fourth footer control still fits the narrowest card', () => {
    /* Small view is a 230px column, and its footer already carried a
       folder, a stamp and three actions. The switch made it four, and the
       stamp lost its line: "5 min ago" wrapped to three rows and every
       card grew an inch. The row gives up spacing, not a control. */
    assert.match(css, /#panel-notes\[data-note-view="small"\] \.note-act \{ width: 30px/);
    assert.match(css, /#panel-notes\[data-note-view="small"\] \.note-foot \{[\s\S]*?gap: \.12rem/);
    /* And nothing lets it wrap again, in any view. */
    assert.match(css, /\.note-stamp \{[\s\S]*?white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
});

/* A modal that dismisses on a backdrop click cannot decide that on the
   click's target alone. The target of a `click` is the nearest common
   ancestor of where the button went down and where it came up, so a
   selection begun on the card and released past its edge arrives at the
   overlay indistinguishable from a click on the overlay — and dragging
   past the edge is what selecting to the end of a line looks like. The
   focus view was closing itself while its text was being selected to
   copy, taking the selection with it. */

/** Runs the real helper out of app.js against a stub overlay, so this
 *  tests the behaviour rather than the spelling of the source. */
function backdropHarness() {
    const source = app.match(/const dismissOnBackdrop = \(id, close\) => \{[\s\S]*?\n {4}\};/);
    assert.ok(source, 'dismissOnBackdrop exists');

    const handlers = {};
    const overlay = {
        addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
    };
    const fire = (type, target) => (handlers[type] || []).forEach((fn) => fn({ target }));

    let closed = 0;
    const build = new Function('el', `${source[0]}\nreturn dismissOnBackdrop;`);
    build(() => overlay)('focus-modal', () => { closed += 1; });

    /* What the browser reports for a press that starts on `from` and is
       released on `to`: the click lands on their common ancestor, which
       for anything inside the card is the overlay itself. */
    const drag = (from, to) => {
        fire('mousedown', from);
        fire('mouseup', to);
        fire('click', from === to ? from : overlay);
    };
    return { overlay, card: { id: 'focus-body' }, drag, count: () => closed };
}

test('a selection released past the card edge does not dismiss the modal', () => {
    const h = backdropHarness();
    h.drag(h.card, h.overlay);
    assert.equal(h.count(), 0, 'the press began on the card, so no dismiss was meant');
});

test('a click that both starts and ends on the backdrop still dismisses', () => {
    const h = backdropHarness();
    h.drag(h.overlay, h.overlay);
    assert.equal(h.count(), 1);
});

test('a drag off the card does not disarm the backdrop click after it', () => {
    const h = backdropHarness();
    h.drag(h.card, h.overlay);
    h.drag(h.overlay, h.overlay);
    assert.equal(h.count(), 1, 'the next genuine backdrop click still closes');
});

test('every modal dismisses through the guarded helper, none on a bare target test', () => {
    ['focus-modal', 'settings-modal', 'confirm-modal',
     'prompt-modal', 'folder-modal', 'history-modal'].forEach((id) => {
        assert.ok(app.includes(`dismissOnBackdrop('${id}'`), `${id} is guarded`);
    });
    assert.doesNotMatch(app, /if \(e\.target === el\('[a-z-]+-modal'\)\)/,
                        'no modal closes on the click target alone');
});

test('storage is guarded by a byte budget rather than a file count', () => {
    /* A count cannot tell 280 screenshots from 280 videos, and the old one
       advertised roughly twice the space the plan actually grants. */
    assert.doesNotMatch(app, /MAX_FILES/);
    assert.doesNotMatch(config, /MAX_FILES/);
    assert.match(app, /totalBytes\(\) \+ file\.size > CFG\.MAX_TOTAL_BYTES/);
    assert.match(config, /MAX_TOTAL_BYTES: 800 \* 1024 \* 1024/);
});

test('the browser file ceiling matches the one the Storage bucket enforces', () => {
    /* 50 * 1024 * 1024 = 52428800, the `file_size_limit` set on
       `doc-files-v2` by 20260827130000_doc_raise_file_size_limit_50mb.sql. The
       bucket answers 413 whether or not the browser agrees, so a change to
       either one that is not made to the other is a broken upload. */
    assert.match(config, /MAX_FILE_BYTES: 50 \* 1024 \* 1024/);
    assert.equal(50 * 1024 * 1024, 52428800);
});

test('the Files view exposes the byte budget as an accessible live meter', () => {
    assert.match(html, /<progress id="storage-meter"[^>]*aria-label="Supabase storage used"/s);
    assert.match(app, /meter\.max = Math\.max\(limit, 1\)/);
    assert.match(app, /meter\.value = Math\.min\(used, meter\.max\)/);
    assert.match(app, /meter\.setAttribute\('aria-valuetext'/);
    assert.match(app, /classList\.toggle\('is-near', ratio >= \.8 && ratio < 1\)/);
    assert.match(app, /classList\.toggle\('is-full', ratio >= 1\)/);
});

test('a long upload reports progress and saves each file as it lands', () => {
    /* app.js is CRLF, so every multi-line pattern here tolerates the \r. */
    const accept = app.match(/async function acceptFiles\(fileList\)[\s\S]*?\r?\n    \}\r?\n/);
    assert.ok(accept, 'acceptFiles exists');
    assert.match(accept[0], /Uploading \$\{file\.name\}/);
    assert.match(accept[0], /renderFiles\(\);\s+commit\(\);/);
    /* Whatever the batch does, the dropzone stops claiming to be busy. */
    assert.match(accept[0], /\} finally \{[\s\S]*?reflectConnection\(\);/);
});
