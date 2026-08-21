/* ============================================================
   DOCKET SHARING — Markdown

   A small CommonMark/GFM renderer, written here rather than pulled in,
   because the whole app is a static page with no build step and no
   dependencies: a CDN script would be one more thing to wait on, one
   more thing to go down, and the one file in the load path that this
   repo could not read.

   Two things are exported:

     looksLikeMarkdown(text)   is this note probably Markdown?
     render(text)              → an HTML string, safe to assign

   ---- On safety -------------------------------------------------------

   Real Markdown passes raw HTML through untouched. This does not: every
   character of the source is escaped before anything else happens, and
   the only tags in the output are the ones built here. A note is a place
   people paste things they did not write — a page of a website, an email,
   a snippet off a forum — and passing that through as live HTML would run
   whatever came with it inside a tab holding a GitHub token. So `<b>`
   shows up as the four characters you typed, and the tags in the result
   are only ever this file's own.

   Link and image targets are checked as well: a scheme is allowed only if
   it is http, https or mailto (plus base64 raster data: URIs on images).
   Anything else — `javascript:` above all — renders as plain text.

   ---- One deliberate difference from a .md file on github.com ----------

   A single newline inside a paragraph becomes a <br> here. GitHub renders
   README files by CommonMark, where it would be a space and two lines
   would run together into one; GitHub renders *comments* the way this
   does, and a note typed into a textarea is much more the second thing
   than the first. Pressing Enter and getting a new line is what anybody
   writing a note means, and gluing their lines back together is the
   surprise that makes people give up on Markdown for notes.
   ============================================================ */

window.DocketMarkdown = (function () {
    'use strict';

    /* ============================================================
       ESCAPING AND URLS
       ============================================================ */

    const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

    /** A URL, or null if it is not one this renderer will link to.
     *
     *  Only a scheme is judged. Something with no scheme at all is a
     *  relative path or a `#fragment`, which can do nothing on its own, so
     *  it is left alone. Something with one has to name a scheme that only
     *  ever fetches: `javascript:` is the reason this function exists, but
     *  `data:` is the same hole wearing a different hat, and an SVG data
     *  URI carries script as happily as a page does — hence raster only,
     *  and only on an image. */
    function safeUrl(raw, forImage) {
        const url = String(raw || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
        const scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(url);
        if (!scheme) return url;
        const name = scheme[1].toLowerCase();
        if (name === 'http' || name === 'https' || name === 'mailto') return url;
        if (forImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)) return url;
        return null;
    }

    const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : '');

    /* ============================================================
       LINE HELPERS
       ============================================================ */

    const isBlank = (line) => !/\S/.test(line);
    const indentOf = (line) => /^ */.exec(line)[0].length;

    /** Remove up to `n` leading spaces, expanding a leading tab to four
     *  first — a tab-indented list is otherwise unreadable. */
    function undent(line, n) {
        let out = line.replace(/^\t/, '    ');
        let cut = 0;
        while (cut < n && out[cut] === ' ') cut++;
        return out.slice(cut);
    }

    const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
    const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
    const QUOTE = /^ {0,3}>/;
    const BULLET = /^( *)([-*+])([ \t]+|$)(.*)$/;
    const ORDERED = /^( *)(\d{1,9})([.)])([ \t]+|$)(.*)$/;
    const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
    const DEFINITION =
        /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]*)>?(?:[ \t]+["'(](.*)["')])?[ \t]*$/;

    /** A fence line, or null. A backtick fence may not carry a backtick in
     *  its info string — that rule is what keeps a stray `` `` `` inside a
     *  paragraph from opening a code block that never closes. */
    function fenceAt(line) {
        const m = FENCE.exec(line);
        if (!m) return null;
        if (m[2][0] === '`' && m[3].indexOf('`') !== -1) return null;
        return { indent: m[1].length, char: m[2][0], len: m[2].length, info: m[3].trim() };
    }

    function listAt(line) {
        const bullet = BULLET.exec(line);
        if (bullet && !THEMATIC.test(line)) {
            return {
                ordered: false, indent: bullet[1].length,
                contentIndent: bullet[1].length + 1 + (bullet[3].length || 1),
                text: bullet[4], start: 1
            };
        }
        const ordered = ORDERED.exec(line);
        if (ordered) {
            return {
                ordered: true, indent: ordered[1].length,
                contentIndent: ordered[1].length + ordered[2].length + 1 +
                               (ordered[4].length || 1),
                text: ordered[5], start: Number(ordered[2])
            };
        }
        return null;
    }

    /** Does this line begin a block of its own? Asked of a line already
     *  inside a paragraph, so it decides where that paragraph stops. An
     *  indented code block is deliberately absent: four spaces under a
     *  paragraph is a continuation of it, not a code block. */
    function startsBlock(lines, i) {
        const line = lines[i];
        return Boolean(fenceAt(line)) || THEMATIC.test(line) || ATX.test(line) ||
               QUOTE.test(line) || Boolean(listAt(line)) || Boolean(tableAt(lines, i));
    }

    /* ============================================================
       LINK REFERENCE DEFINITIONS

       `[label]: https://…` can sit anywhere, including after the link
       that uses it, so they are collected in a pass of their own before
       anything is rendered. Fenced code is skipped on the way through —
       a definition inside a code block is a line of code.
       ============================================================ */

    function collectDefinitions(lines) {
        const defs = new Map();
        let fence = null;
        lines.forEach((line) => {
            if (fence) {
                const close = fenceAt(line);
                if (close && close.char === fence.char && close.len >= fence.len &&
                    !close.info) fence = null;
                return;
            }
            const open = fenceAt(line);
            if (open) { fence = open; return; }
            if (indentOf(line) >= 4) return;
            const def = DEFINITION.exec(line);
            if (!def || !def[2]) return;
            const key = def[1].trim().toLowerCase();
            if (!defs.has(key)) defs.set(key, { href: def[2], title: def[3] || '' });
        });
        return defs;
    }

    /* ============================================================
       TABLES
       ============================================================ */

    /** Split one table row on its unescaped pipes. The outer pipes are
     *  optional in GFM, so a leading and a trailing one are dropped before
     *  the split rather than left to produce empty end cells. */
    function splitRow(row) {
        const line = row.trim().replace(/^\|/, '').replace(/\|[ \t]*$/, '');
        const cells = [];
        let cell = '';
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '\\' && line[i + 1] === '|') { cell += '|'; i++; continue; }
            if (line[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
            cell += line[i];
        }
        cells.push(cell.trim());
        return cells;
    }

    const DELIMITER_CELL = /^:?-+:?$/;

    /** A table starting at `i`, or null. The header and the row of dashes
     *  under it have to agree on how many columns there are — that
     *  agreement is the only thing telling a table apart from two ordinary
     *  lines that happen to contain a pipe. */
    function tableAt(lines, i) {
        const head = lines[i];
        const rule = lines[i + 1];
        if (head == null || rule == null) return null;
        if (head.indexOf('|') === -1 || indentOf(head) >= 4) return null;
        if (rule.indexOf('-') === -1) return null;

        const aligns = splitRow(rule);
        if (!aligns.length || !aligns.every((c) => DELIMITER_CELL.test(c))) return null;
        const heads = splitRow(head);
        if (heads.length !== aligns.length) return null;

        return {
            heads,
            aligns: aligns.map((c) => {
                const left = c[0] === ':';
                const right = c[c.length - 1] === ':';
                return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
            })
        };
    }

    /* ============================================================
       INLINE

       One left-to-right scanner rather than a stack of replacements. A
       chain of regexes over the whole string is what puts <em> tags
       inside code spans and turns the asterisks in a pasted diff into
       italics; a scanner sees a code span, steps over it, and cannot.
       ============================================================ */

    const PUNCTUATION = /[\\`*_{}[\]()#+\-.!>~|"']/;

    /** A code span at `i`, or null. The closing run has to be exactly as
     *  long as the opening one, so ``a ` b`` closes on the pair. */
    function codeSpanAt(src, i) {
        let open = 0;
        while (src[i + open] === '`') open++;
        if (!open) return null;
        let k = i + open;
        while (k < src.length) {
            if (src[k] !== '`') { k++; continue; }
            let run = 0;
            while (src[k + run] === '`') run++;
            if (run === open) {
                let content = src.slice(i + open, k).replace(/\n/g, ' ');
                if (content.length > 2 && content[0] === ' ' &&
                    content[content.length - 1] === ' ' && content.trim()) {
                    content = content.slice(1, -1);
                }
                return { end: k + run, content };
            }
            k += run;
        }
        return null;
    }

    /** Index of the delimiter run that closes an emphasis opened at
     *  `from`, or -1. Runs of the wrong length are stepped over whole, so
     *  the inner `**` of `*a **b** c*` never closes the outer `*`. */
    function findDelimiter(src, from, marker) {
        const ch = marker[0];
        let k = from;
        while (k < src.length) {
            const c = src[k];
            if (c === '\\') { k += 2; continue; }
            if (c === '`') {
                const code = codeSpanAt(src, k);
                if (code) { k = code.end; continue; }
            }
            if (c !== ch) { k++; continue; }
            let run = 0;
            while (src[k + run] === ch) run++;
            /* A closer cannot be preceded by whitespace: the asterisk in
               `2 * 3 * 4` is arithmetic, not emphasis. */
            if (run === marker.length && !/\s/.test(src[k - 1] || ' ')) return k;
            k += run;
        }
        return -1;
    }

    /** Index of the `]` matching the `[` at `i`, honouring nesting so the
     *  link in `[see [1](x)](y)` is the outer one. */
    function matchBracket(src, i) {
        let depth = 0;
        for (let k = i; k < src.length; k++) {
            const c = src[k];
            if (c === '\\') { k++; continue; }
            if (c === '`') {
                const code = codeSpanAt(src, k);
                if (code) { k = code.end - 1; continue; }
            }
            if (c === '[') depth++;
            else if (c === ']' && --depth === 0) return k;
        }
        return -1;
    }

    /** Index of the `)` matching the `(` at `i` — nested, because a URL
     *  with parentheses in it is exactly what Wikipedia hands you. */
    function matchParen(src, i) {
        let depth = 0;
        for (let k = i; k < src.length; k++) {
            const c = src[k];
            if (c === '\\') { k++; continue; }
            if (c === '(') depth++;
            else if (c === ')' && --depth === 0) return k;
        }
        return -1;
    }

    /** Pull a destination and an optional title out of `(…)`. */
    function splitDestination(inner) {
        let rest = inner.trim();
        let href = '';
        if (rest[0] === '<') {
            const gt = rest.indexOf('>');
            if (gt === -1) return null;
            href = rest.slice(1, gt);
            rest = rest.slice(gt + 1).trim();
        } else {
            const space = /\s/.exec(rest);
            href = space ? rest.slice(0, space.index) : rest;
            rest = space ? rest.slice(space.index).trim() : '';
        }
        const title = /^(".*"|'.*'|\(.*\))$/.test(rest) ? rest.slice(1, -1) : '';
        return { href, title };
    }

    /** A link or image starting at the `[`, in any of Markdown's three
     *  spellings: inline, `[text][label]`, and the shortcut `[label]`. */
    function linkAt(src, i, defs) {
        const close = matchBracket(src, i);
        if (close === -1) return null;
        const text = src.slice(i + 1, close);
        let k = close + 1;

        if (src[k] === '(') {
            const end = matchParen(src, k);
            if (end === -1) return null;
            const dest = splitDestination(src.slice(k + 1, end));
            if (!dest) return null;
            return { text, href: dest.href, title: dest.title, end: end + 1 };
        }

        let label = text;
        let end = close + 1;
        if (src[k] === '[') {
            const rc = src.indexOf(']', k + 1);
            if (rc === -1) return null;
            const named = src.slice(k + 1, rc).trim();
            if (named) label = named;
            end = rc + 1;
        }
        const def = defs.get(label.trim().toLowerCase());
        if (!def) return null;
        return { text, href: def.href, title: def.title, end };
    }

    const AUTOLINK = /^<([a-z][a-z0-9+.\-]{1,31}:[^<>\s]*)>/i;
    const AUTOMAIL = /^<([^\s<>@]+@[^\s<>@.]+\.[^\s<>@]+)>/;
    const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>]+/i;

    /** GFM autolinks bare URLs, but a sentence ends in punctuation more
     *  often than a URL does, so trailing `.,;:!?` and any unbalanced
     *  closing paren are handed back to the prose. */
    function trimUrlTail(url) {
        let out = url;
        for (;;) {
            const last = out[out.length - 1];
            if ('.,;:!?\'"'.indexOf(last) !== -1) { out = out.slice(0, -1); continue; }
            if (last === ')' &&
                out.split(')').length > out.split('(').length) { out = out.slice(0, -1); continue; }
            break;
        }
        return out;
    }

    /**
     * Render inline Markdown to HTML.
     *
     * `noLink` is set while rendering the text of a link, where a second
     * autolink would nest an <a> inside an <a> — which the parser then
     * unnests into two siblings, the second one holding the rest of the
     * label.
     */
    function inline(src, defs, noLink) {
        let out = '';
        let i = 0;

        while (i < src.length) {
            const c = src[i];

            /* A backslash escapes punctuation, and — outside a code span —
               ends a line the way two trailing spaces do. */
            if (c === '\\') {
                if (src[i + 1] === '\n') { out += '<br>\n'; i += 2; continue; }
                if (PUNCTUATION.test(src[i + 1] || '')) { out += esc(src[i + 1]); i += 2; continue; }
                out += esc(c); i++; continue;
            }

            /* Every newline inside a paragraph is a line break. See the
               note at the top of this file: a note is written the way a
               comment is, not the way a README is. */
            if (c === '\n') {
                out = out.replace(/[ \t]+$/, '');
                out += '<br>\n';
                i++;
                continue;
            }

            if (c === '`') {
                const code = codeSpanAt(src, i);
                if (code) {
                    out += `<code>${esc(code.content)}</code>`;
                    i = code.end;
                    continue;
                }
            }

            if (c === '<' && !noLink) {
                const mail = AUTOMAIL.exec(src.slice(i));
                if (mail) {
                    const href = safeUrl(`mailto:${mail[1]}`);
                    out += href ? `<a href="${esc(href)}">${esc(mail[1])}</a>` : esc(mail[0]);
                    i += mail[0].length;
                    continue;
                }
                const auto = AUTOLINK.exec(src.slice(i));
                if (auto) {
                    const href = safeUrl(auto[1]);
                    out += href
                        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(auto[1])}</a>`
                        : esc(auto[0]);
                    i += auto[0].length;
                    continue;
                }
            }

            if (c === '!' && src[i + 1] === '[') {
                const image = linkAt(src, i + 1, defs);
                if (image) {
                    const src_ = safeUrl(image.href, true);
                    out += src_
                        ? `<img src="${esc(src_)}" alt="${esc(image.text)}"` +
                          `${attr('title', image.title)} loading="lazy">`
                        : esc(image.text);
                    i = image.end;
                    continue;
                }
            }

            if (c === '[' && !noLink) {
                const link = linkAt(src, i, defs);
                if (link) {
                    const href = safeUrl(link.href);
                    const label = inline(link.text, defs, true);
                    out += href
                        ? `<a href="${esc(href)}"${attr('title', link.title)}` +
                          ` target="_blank" rel="noopener noreferrer">${label}</a>`
                        : label;
                    i = link.end;
                    continue;
                }
            }

            if (c === '~' && src[i + 1] === '~') {
                const end = findDelimiter(src, i + 2, '~~');
                if (end > i + 2 && !/\s/.test(src[i + 2])) {
                    out += `<del>${inline(src.slice(i + 2, end), defs, noLink)}</del>`;
                    i = end + 2;
                    continue;
                }
            }

            if (c === '*' || c === '_') {
                const emphasised = emphasisAt(src, i, defs, noLink);
                if (emphasised) { out += emphasised.html; i = emphasised.end; continue; }
            }

            if (!noLink && (c === 'h' || c === 'H' || c === 'w' || c === 'W') &&
                !/[\w@/]/.test(src[i - 1] || ' ')) {
                const bare = BARE_URL.exec(src.slice(i));
                if (bare) {
                    const text = trimUrlTail(bare[0]);
                    const href = safeUrl(/^www\./i.test(text) ? `https://${text}` : text);
                    if (href) {
                        out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
                        i += text.length;
                        continue;
                    }
                }
            }

            out += esc(c);
            i++;
        }

        return out;
    }

    /** `***a***`, `**a**` and `*a*`, tried longest run first, for either
     *  marker. An underscore additionally has to stand at a word boundary,
     *  or `snake_case_names` and `__init__` come back italicised. */
    function emphasisAt(src, i, defs, noLink) {
        const ch = src[i];
        let run = 0;
        while (src[i + run] === ch) run++;

        if (ch === '_' && /[\w]/.test(src[i - 1] || '')) return null;

        for (let len = Math.min(run, 3); len >= 1; len--) {
            const marker = ch.repeat(len);
            if (/\s/.test(src[i + len] || ' ')) continue;
            const end = findDelimiter(src, i + len, marker);
            if (end === -1 || end === i + len) continue;
            if (ch === '_' && /[\w]/.test(src[end + len] || '')) continue;

            const body = inline(src.slice(i + len, end), defs, noLink);
            const html = len === 3 ? `<em><strong>${body}</strong></em>`
                       : len === 2 ? `<strong>${body}</strong>`
                       : `<em>${body}</em>`;
            return { html, end: end + len };
        }
        return null;
    }

    /* ============================================================
       BLOCKS
       ============================================================ */

    /** Everything a list needs to know about itself, or null. Consumes
     *  from `i` and reports where it stopped. */
    function parseList(lines, i) {
        const first = listAt(lines[i]);
        if (!first || THEMATIC.test(lines[i])) return null;

        const list = { ordered: first.ordered, start: first.start, items: [], loose: false };
        let contentIndent = Infinity;
        let item = null;
        let blanks = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (isBlank(line)) { blanks++; i++; continue; }
            if (THEMATIC.test(line)) break;

            const next = listAt(line);
            if (next && next.ordered === list.ordered && next.indent < contentIndent) {
                if (blanks && list.items.length) list.loose = true;
                blanks = 0;
                item = { lines: next.text ? [next.text] : [] };
                list.items.push(item);
                contentIndent = next.contentIndent;
                i++;
                continue;
            }
            if (!item) break;

            /* Anything indented to the item's own text column belongs to
               that item — including a whole nested list, which the
               recursion below finds once the indent is taken off. */
            if (indentOf(line) >= contentIndent) {
                if (blanks) { list.loose = true; item.lines.push(''); }
                blanks = 0;
                item.lines.push(undent(line, contentIndent));
                i++;
                continue;
            }

            /* A dedented line only continues the item lazily: directly
               under it, and only if it is ordinary prose. */
            if (blanks || startsBlock(lines, i)) break;
            item.lines.push(line.trim());
            i++;
        }

        return list.items.length ? { list, end: i } : null;
    }

    const TASK = /^\[([ xX])\][ \t]+/;

    function renderList(list, defs) {
        const items = list.items.map((item) => {
            let lines = item.lines;
            let done = null;

            const task = TASK.exec(lines[0] || '');
            if (task) {
                done = task[1] !== ' ';
                lines = lines.slice();
                lines[0] = lines[0].slice(task[0].length);
            }

            const inner = blocks(lines, defs, !list.loose);
            const box = done === null ? ''
                : `<input type="checkbox" disabled${done ? ' checked' : ''}> `;
            return `<li${done === null ? '' : ' class="md-task"'}>${box}${inner}</li>`;
        }).join('\n');

        const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
        const tag = list.ordered ? 'ol' : 'ul';
        return `<${tag}${start}>\n${items}\n</${tag}>`;
    }

    function renderTable(lines, i, table, defs) {
        const cell = (text, align, head) => {
            const tag = head ? 'th' : 'td';
            const style = align ? ` style="text-align:${align}"` : '';
            return `<${tag}${style}>${inline(text, defs)}</${tag}>`;
        };
        const row = (cells, head) => `<tr>${
            table.aligns.map((align, k) => cell(cells[k] || '', align, head)).join('')}</tr>`;

        const body = [];
        let k = i + 2;
        while (k < lines.length && !isBlank(lines[k])) {
            if (lines[k].indexOf('|') === -1 && startsBlock(lines, k)) break;
            body.push(row(splitRow(lines[k]), false));
            k++;
        }

        /* The table is put in a scroller of its own rather than allowed to
           widen the note: a card is as wide as the column it sits in, and
           a table that overflows it pushes the whole board sideways. */
        return {
            html: `<div class="md-tablewrap"><table>\n<thead>${row(table.heads, true)}</thead>\n` +
                  (body.length ? `<tbody>\n${body.join('\n')}\n</tbody>\n` : '') +
                  `</table></div>`,
            end: k
        };
    }

    /**
     * Render a run of lines as a sequence of blocks.
     *
     * `tight` is set for the contents of a tight list item, where a
     * paragraph is written without its <p> — that is the whole difference
     * between a tight list and a loose one, and doing it here means one
     * paragraph path rather than two.
     */
    function blocks(lines, defs, tight) {
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (isBlank(line)) { i++; continue; }

            /* ---- fenced code ---- */
            const fence = fenceAt(line);
            if (fence) {
                const body = [];
                i++;
                while (i < lines.length) {
                    const close = fenceAt(lines[i]);
                    if (close && close.char === fence.char &&
                        close.len >= fence.len && !close.info) { i++; break; }
                    body.push(undent(lines[i], fence.indent));
                    i++;
                }
                const lang = fence.info.split(/\s+/)[0];
                const cls = lang ? ` class="language-${esc(lang.replace(/[^\w.+#-]/g, ''))}"` : '';
                out.push(`<pre><code${cls}>${esc(body.join('\n'))}\n</code></pre>`);
                continue;
            }

            /* ---- thematic break ---- (before lists: `- - -` is a rule) */
            if (THEMATIC.test(line)) { out.push('<hr>'); i++; continue; }

            /* ---- ATX heading ---- */
            const atx = ATX.exec(line);
            if (atx) {
                const level = atx[1].length;
                const text = (atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
                out.push(`<h${level}>${inline(text, defs)}</h${level}>`);
                i++;
                continue;
            }

            /* ---- blockquote ---- */
            if (QUOTE.test(line)) {
                const inner = [];
                while (i < lines.length) {
                    if (QUOTE.test(lines[i])) {
                        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
                        i++;
                        continue;
                    }
                    /* Lazy continuation: prose directly under a quoted
                       line is still part of the quote. */
                    if (!isBlank(lines[i]) && inner.length && !startsBlock(lines, i)) {
                        inner.push(lines[i]);
                        i++;
                        continue;
                    }
                    break;
                }
                out.push(`<blockquote>\n${blocks(inner, defs)}\n</blockquote>`);
                continue;
            }

            /* ---- list ---- */
            const parsed = parseList(lines, i);
            if (parsed) {
                out.push(renderList(parsed.list, defs));
                i = parsed.end;
                continue;
            }

            /* ---- table ---- */
            const table = tableAt(lines, i);
            if (table) {
                const rendered = renderTable(lines, i, table, defs);
                out.push(rendered.html);
                i = rendered.end;
                continue;
            }

            /* ---- indented code ---- */
            if (indentOf(line) >= 4) {
                const body = [];
                while (i < lines.length &&
                       (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
                    body.push(undent(lines[i], 4));
                    i++;
                }
                while (body.length && !/\S/.test(body[body.length - 1])) body.pop();
                out.push(`<pre><code>${esc(body.join('\n'))}\n</code></pre>`);
                continue;
            }

            /* ---- link reference definition ---- */
            const def = DEFINITION.exec(line);
            if (def && def[2] && defs.has(def[1].trim().toLowerCase())) { i++; continue; }

            /* ---- paragraph, and the setext heading it may turn into ---- */
            const para = [];
            let heading = 0;
            while (i < lines.length && !isBlank(lines[i])) {
                const setext = para.length && /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i]);
                if (setext) { heading = setext[1][0] === '=' ? 1 : 2; i++; break; }
                if (para.length && startsBlock(lines, i)) break;
                /* Leading whitespace on a continuation line is layout, not
                   content — without this the four spaces that wrapped a
                   long line of prose come through as four spaces of text. */
                para.push(lines[i].replace(/^[ \t]+/, ''));
                i++;
            }
            const text = inline(para.join('\n').replace(/^\s+|\s+$/g, ''), defs);
            if (heading) out.push(`<h${heading}>${text}</h${heading}>`);
            else if (tight) out.push(text);
            else out.push(`<p>${text}</p>`);
        }

        return out.join('\n');
    }

    /* ============================================================
       DETECTION

       Scored rather than matched, because no single character says
       "Markdown" on its own — a hyphen at the start of a line is a bullet
       in one note and a dash in the next.

       The weights below are set so that anything worth 4 renders. Three
       constructs earn that alone because nothing else writes them by
       accident: a fenced code block, a row of dashes under a table
       header, and a `- [ ]` checkbox. Everything else has to agree with
       something: a heading and a list, or a list and a link.

       A false positive costs a note its indentation until you press the
       toggle; a false negative costs a note nothing but a click. So the
       patterns lean strict — a link has to point at something URL-shaped,
       emphasis has to hug its text — and the tie goes to plain text.
       ============================================================ */

    const SIGNALS = [
        /* Unambiguous on their own. */
        [4, /^ {0,3}(?:```|~~~)/m],
        [4, /^ {0,3}\|?[^\n|]*\|[^\n]*\n {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/m],
        [4, /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+\S/m],

        /* Structural, but each needs a friend. */
        [2, /^ {0,3}#{1,6}[ \t]+\S/m],
        [2, /^ {0,3}>[ \t]?\S/m],
        [2, /^ {0,3}[-*+][ \t]+\S[\s\S]*?^ {0,3}[-*+][ \t]+\S/m],
        [2, /^ {0,3}\d{1,9}[.)][ \t]+\S[\s\S]*?^ {0,3}\d{1,9}[.)][ \t]+\S/m],
        /* A destination that looks like one. Without this, `argv[i](x)`
           in a pasted C file scores as a link. */
        [2, /!?\[[^\]\n]*\]\([ \t]*(?:https?:|mailto:|#|\.{0,2}\/|[\w.-]+\.[a-z]{2,})[^)\n]*\)/i],
        [2, /^ {0,3}\[[^\]\n]+\]:[ \t]*\S+$/m],
        [2, /\S[^\n]*\n {0,3}(?:=+|-{2,})[ \t]*$/m],

        /* Weak on their own; enough to tip a note that is already close. */
        [1, /(\*\*|__)(?=\S)(?:(?!\1)[\s\S])+?(?<=\S)\1/],
        [1, /`[^`\n]+`/],
        [1, /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/m]
    ];

    const THRESHOLD = 4;

    function looksLikeMarkdown(text) {
        const src = String(text || '');
        if (!src.trim()) return false;
        let score = 0;
        for (let i = 0; i < SIGNALS.length; i++) {
            if (SIGNALS[i][1].test(src)) score += SIGNALS[i][0];
            if (score >= THRESHOLD) return true;
        }
        return false;
    }

    /* ============================================================
       ENTRY POINT
       ============================================================ */

    function render(text) {
        /* Tabs are expanded at the start of a line only. Doing it
           everywhere would ruin a pasted TSV inside a code block, and the
           only thing block parsing needs from a tab is its indent. */
        const lines = String(text || '')
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
        return blocks(lines, collectDefinitions(lines));
    }

    return { render, looksLikeMarkdown, THRESHOLD };
})();

