/* The Markdown renderer and its detector.

   markdown.js is loaded the way store.js is: run in a vm context with a
   `window` stub, so the file under test is the file the browser gets and
   there is no second copy to keep in step. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'markdown.js'), 'utf8');

const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'markdown.js' });
const MD = context.window.DocketMarkdown;

const md = (text) => MD.render(text);
const looks = (text) => MD.looksLikeMarkdown(text);

/* ---- the file itself --------------------------------------------------- */

test('markdown.js is plain text, with no stray control byte in it', () => {
    /* app.js was once made a binary file by a single NUL, and a byte that
       does not print is a byte nobody notices until git or an editor
       does. */
    assert.doesNotMatch(source, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test('nothing is fetched, and no dependency is reached for', () => {
    assert.doesNotMatch(source, /\bfetch\s*\(|<script|cdn\.|unpkg|jsdelivr/);
});

/* ---- headings, paragraphs, breaks -------------------------------------- */

test('ATX headings render at their level, and closing hashes come off', () => {
    assert.equal(md('# One'), '<h1>One</h1>');
    assert.equal(md('###### Six'), '<h6>Six</h6>');
    assert.equal(md('## Two ##'), '<h2>Two</h2>');
    /* Seven is not a level, and a hash with no space is a hashtag. */
    assert.equal(md('####### Seven'), '<p>####### Seven</p>');
    assert.equal(md('#nope'), '<p>#nope</p>');
});

test('a setext underline turns the paragraph above it into a heading', () => {
    assert.equal(md('Title\n====='), '<h1>Title</h1>');
    assert.equal(md('Title\n-----'), '<h2>Title</h2>');
    /* But a rule with a blank line above it is a rule, which is what the
       app writes between two merged notes. */
    assert.equal(md('Title\n\n---\n\nMore'), '<p>Title</p>\n<hr>\n<p>More</p>');
});

test('a single newline inside a paragraph is a line break', () => {
    /* The one deliberate difference from a .md file on github.com: a note
       is written the way a comment is. Pressing Enter has to make a line. */
    assert.equal(md('one\ntwo'), '<p>one<br>\ntwo</p>');
    assert.equal(md('one  \ntwo'), '<p>one<br>\ntwo</p>', 'trailing spaces do not survive');
    assert.equal(md('one\\\ntwo'), '<p>one<br>\ntwo</p>', 'nor does a backslash break');
});

test('a blank line separates paragraphs', () => {
    assert.equal(md('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
});

test('thematic breaks are drawn from any of the three markers', () => {
    ['---', '***', '___', '- - -', '*  *  *'].forEach((rule) => {
        assert.equal(md(rule), '<hr>', `${rule} is a rule`);
    });
});

/* ---- emphasis ---------------------------------------------------------- */

test('emphasis, strong, both at once, and strikethrough', () => {
    assert.equal(md('*a*'), '<p><em>a</em></p>');
    assert.equal(md('**a**'), '<p><strong>a</strong></p>');
    assert.equal(md('***a***'), '<p><em><strong>a</strong></em></p>');
    assert.equal(md('~~a~~'), '<p><del>a</del></p>');
    assert.equal(md('_a_'), '<p><em>a</em></p>');
    assert.equal(md('__a__'), '<p><strong>a</strong></p>');
});

test('emphasis nests without the inner run closing the outer one', () => {
    assert.equal(md('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
    assert.equal(md('**a *b* c**'), '<p><strong>a <em>b</em> c</strong></p>');
});

test('an asterisk with air around it is arithmetic, not emphasis', () => {
    assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
    assert.equal(md('a * b'), '<p>a * b</p>');
});

test('an underscore inside a word is part of the word', () => {
    /* snake_case, dunder names and a pasted identifier all live in notes,
       and all of them used to come back italicised. */
    assert.equal(md('snake_case_name'), '<p>snake_case_name</p>');
    assert.equal(md('__init__ and __main__'),
                 '<p><strong>init</strong> and <strong>main</strong></p>');
    assert.equal(md('a_b_c d'), '<p>a_b_c d</p>');
});

test('a backslash escapes the character after it', () => {
    assert.equal(md('\\*not em\\*'), '<p>*not em*</p>');
    assert.equal(md('\\# not a heading'), '<p># not a heading</p>');
});

/* ---- code -------------------------------------------------------------- */

test('a code span is literal, and nothing inside it is markup', () => {
    assert.equal(md('`**a**`'), '<p><code>**a**</code></p>');
    assert.equal(md('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
    /* A longer run of backticks lets a code span hold one. */
    assert.equal(md('``a ` b``'), '<p><code>a ` b</code></p>');
});

test('a fenced block keeps its text exactly, and names its language', () => {
    assert.equal(md('```js\nconst a = 1;\n```'),
                 '<pre><code class="language-js">const a = 1;\n</code></pre>');
    assert.equal(md('~~~\nplain\n~~~'), '<pre><code>plain\n</code></pre>');
});

test('a fence holds markdown without rendering any of it', () => {
    assert.equal(md('```\n# not a heading\n- not a list\n```'),
                 '<pre><code># not a heading\n- not a list\n</code></pre>');
});

test('an unclosed fence still ends at the end of the note', () => {
    assert.equal(md('```\nleft open'), '<pre><code>left open\n</code></pre>');
});

test('four spaces is an indented code block, but only at a block start', () => {
    assert.equal(md('    code()'), '<pre><code>code()\n</code></pre>');
    /* Under a paragraph the same four spaces are a continuation of it —
       otherwise every wrapped, indented line of prose becomes code. */
    assert.equal(md('text\n    still text'), '<p>text<br>\nstill text</p>');
});

test('a language name is sanitised before it reaches a class attribute', () => {
    assert.match(md('```js" onload="x\ncode\n```'), /class="language-js"/);
});

/* ---- lists ------------------------------------------------------------- */

test('bullet lists, from any of the three markers', () => {
    assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('* a\n* b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('+ a\n+ b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
});

test('ordered lists keep the number they start at', () => {
    assert.equal(md('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.match(md('3. a\n4. b'), /^<ol start="3">/);
});

test('a blank line between items makes the list loose', () => {
    assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>', 'tight');
    assert.equal(md('- a\n\n- b'),
                 '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>', 'loose');
});

test('an indented list under an item is nested inside it', () => {
    assert.equal(md('- a\n    - b'),
                 '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ul>');
});

test('a checkbox item renders as one, and it is not clickable', () => {
    const done = md('- [x] shipped');
    assert.match(done, /<input type="checkbox" disabled checked>/);
    assert.match(done, /class="md-task"/);
    assert.match(md('- [ ] todo'), /<input type="checkbox" disabled>/);
    assert.doesNotMatch(md('- [ ] todo'), /checked/);
});

test('a rule is a rule even where a list marker would fit', () => {
    assert.equal(md('- a\n\n---\n\n- b'),
                 '<ul>\n<li>a</li>\n</ul>\n<hr>\n<ul>\n<li>b</li>\n</ul>');
});

/* ---- quotes ------------------------------------------------------------ */

test('blockquotes hold blocks, and nest', () => {
    assert.equal(md('> quoted'), '<blockquote>\n<p>quoted</p>\n</blockquote>');
    assert.equal(md('> # head'), '<blockquote>\n<h1>head</h1>\n</blockquote>');
    assert.equal(md('> > deep'),
                 '<blockquote>\n<blockquote>\n<p>deep</p>\n</blockquote>\n</blockquote>');
});

/* ---- tables ------------------------------------------------------------ */

test('a pipe table renders, with the alignment its rule asks for', () => {
    const html = md('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
    assert.match(html, /<table>/);
    assert.match(html, /<th style="text-align:left">a<\/th>/);
    assert.match(html, /<th style="text-align:center">b<\/th>/);
    assert.match(html, /<th style="text-align:right">c<\/th>/);
    assert.match(html, /<td style="text-align:left">1<\/td>/);
    /* A card is only as wide as its column, so a wide table scrolls
       inside itself rather than pushing the board sideways. */
    assert.match(html, /<div class="md-tablewrap">/);
});

test('two lines that merely contain a pipe are not a table', () => {
    assert.doesNotMatch(md('a | b\nc | d'), /<table>/);
    assert.doesNotMatch(md('| a | b |\n| --- |\n| 1 | 2 |'), /<table>/,
                        'the columns have to agree');
});

/* ---- links and images -------------------------------------------------- */

test('inline links open in a new tab, and cannot reach back', () => {
    assert.equal(md('[text](https://example.com)'),
        '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">text</a></p>');
});

test('a title on a link survives', () => {
    assert.match(md('[t](https://e.com "why")'), /title="why"/);
});

test('reference links resolve, in all three spellings', () => {
    const defs = '\n\n[ref]: https://example.com';
    assert.match(md(`[text][ref]${defs}`), /href="https:\/\/example\.com"/);
    assert.match(md(`[ref][]${defs}`), /href="https:\/\/example\.com"/);
    assert.match(md(`[ref]${defs}`), /href="https:\/\/example\.com"/);
    assert.doesNotMatch(md(`[text][ref]${defs}`), /\[ref\]:/, 'the definition is not drawn');
});

test('a bare URL is linked, and the full stop after it is not', () => {
    assert.equal(md('see https://example.com/a.'),
        '<p>see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">' +
        'https://example.com/a</a>.</p>');
    assert.match(md('www.example.com'), /href="https:\/\/www\.example\.com"/);
});

test('an image renders as one', () => {
    assert.match(md('![alt](https://example.com/a.png)'),
                 /<img src="https:\/\/example\.com\/a\.png" alt="alt" loading="lazy">/);
});

test('an autolink in angle brackets works for URLs and for mail', () => {
    assert.match(md('<https://example.com>'), /href="https:\/\/example\.com"/);
    assert.match(md('<a@b.com>'), /href="mailto:a@b\.com"/);
});

/* ---- safety ------------------------------------------------------------ */

test('raw HTML in the source is shown, never run', () => {
    assert.equal(md('<script>alert(1)</script>'),
                 '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(md('<img src=x onerror=alert(1)>'),
                 '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    assert.equal(md('<b>bold?</b>'), '<p>&lt;b&gt;bold?&lt;/b&gt;</p>');
});

test('a javascript: link renders as text with no anchor at all', () => {
    const html = md('[click](javascript:alert(1))');
    assert.doesNotMatch(html, /<a /);
    assert.doesNotMatch(html, /javascript:/);
    assert.equal(html, '<p>click</p>');
});

test('the schemes that only ever fetch are the schemes that link', () => {
    ['https://a.com', 'http://a.com', 'mailto:a@b.com', '#anchor', '/path', './rel']
        .forEach((href) => {
            assert.match(md(`[t](${href})`), /<a href=/, `${href} links`);
        });
    ['javascript:x', 'JaVaScRiPt:x', 'data:text/html,<script>', 'vbscript:x', 'file:///etc']
        .forEach((href) => {
            assert.doesNotMatch(md(`[t](${href})`), /<a href=/, `${href} does not`);
        });
});

test('a javascript: URL hiding behind a control character is still caught', () => {
    /* The classic dodge: browsers strip these before parsing the scheme,
       so the check has to strip them too. */
    const sneaky = 'java' + String.fromCharCode(9, 10, 13) + 'script:alert(1)';
    const html = md('[t](' + sneaky + ')');
    assert.doesNotMatch(html, /<a href=/);
});

test('an image may carry a raster data URI, and nothing else', () => {
    assert.match(md('![a](data:image/png;base64,AAAA)'), /<img /);
    assert.doesNotMatch(md('![a](data:image/svg+xml;base64,AAAA)'), /<img /);
    assert.doesNotMatch(md('![a](javascript:alert(1))'), /<img /);
});

test('quotes and angle brackets in text and in attributes are escaped', () => {
    assert.match(md('[a"b](https://e.com/?q="x")'), /href="https:\/\/e\.com\/\?q=&quot;x&quot;"/);
    assert.equal(md('5 > 3 && 2 < 4'), '<p>5 &gt; 3 &amp;&amp; 2 &lt; 4</p>');
});

/* ---- detection --------------------------------------------------------- */

test('plain prose is not Markdown', () => {
    assert.equal(looks('Just a note about the meeting on Tuesday.'), false);
    assert.equal(looks('Call mum\nBuy milk\nBook the van'), false);
    assert.equal(looks(''), false);
    assert.equal(looks('   \n  '), false);
});

test('one weak signal on its own is not enough', () => {
    assert.equal(looks('that was **very** good'), false);
    assert.equal(looks('press the `enter` key'), false);
    assert.equal(looks('a - b - c'), false);
});

test('the three unambiguous constructs each carry a note on their own', () => {
    assert.equal(looks('```js\nconst a = 1;\n```'), true, 'a fence');
    assert.equal(looks('| a | b |\n| --- | --- |\n| 1 | 2 |'), true, 'a table');
    assert.equal(looks('- [ ] one thing'), true, 'a checkbox');
});

test('two ordinary signals agreeing is enough', () => {
    assert.equal(looks('## Shopping\n- milk\n- eggs'), true);
    assert.equal(looks('- one\n- two\n\nSee [the docs](https://example.com).'), true);
    assert.equal(looks('> quoted\n\n# Heading'), true);
});

test('a heading on its own is not enough, because a comment looks like one', () => {
    /* `# note to self` at the top of a shell script, a Dockerfile or a
       config file is the false positive this threshold exists for. */
    assert.equal(looks('# just a title'), false);
    assert.equal(looks('#!/bin/sh\n# set up the box\nrm -rf /tmp/x\n# done'), false);
});

test('pasted source code is not mistaken for Markdown', () => {
    assert.equal(looks([
        'function pick(argv) {',
        '    const first = argv[0](2 * 3);',
        '    // 1. read it',
        '    // 2. write it',
        '    return first * 2 * 3;',
        '}'
    ].join('\n')), false);
});

test('an index expression is not a link', () => {
    assert.equal(looks('rows[i](x)\ncols[j](y)\n- a\n- b'), false,
                 'the two bullets alone do not reach the threshold');
    assert.equal(looks('- a\n- b\nsee [docs](https://x.com)'), true,
                 'a destination that looks like one does');
});

test('a real Markdown note is detected', () => {
    assert.equal(looks([
        '# Release notes',
        '',
        'The **big** one. See [the issue](https://github.com/x/y/issues/1).',
        '',
        '- fixed the thing',
        '- broke another'
    ].join('\n')), true);
});

/* ---- the whole thing --------------------------------------------------- */

test('a document with every construct in it renders without throwing', () => {
    const html = md([
        '# Title', '', 'Intro with **bold**, `code` and [a link](https://e.com).', '',
        '## List', '- one', '- two', '  - nested', '', '1. first', '2. second', '',
        '> quoted', '', '```py', 'print("hi")', '```', '',
        '| a | b |', '| --- | ---: |', '| 1 | 2 |', '',
        '---', '', '- [x] done', '- [ ] not'
    ].join('\n'));
    ['<h1>', '<h2>', '<ul>', '<ol>', '<blockquote>', '<pre><code class="language-py">',
     '<table>', '<hr>', '<input type="checkbox"'].forEach((tag) => {
        assert.ok(html.includes(tag), `${tag} is in the output`);
    });
});

test('an empty note renders to nothing rather than to an empty paragraph', () => {
    assert.equal(md(''), '');
    assert.equal(md('\n\n  \n'), '');
});

test('a long note does not take exponential time to render', () => {
    const big = Array.from({ length: 4000 }, (_, i) =>
        `- item ${i} with **bold** and \`code\` and [a link](https://e.com/${i})`).join('\n');
    const started = Date.now();
    const html = md(big);
    assert.ok(html.includes('item 3999'));
    assert.ok(Date.now() - started < 4000, 'rendered in reasonable time');
});
