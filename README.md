# Docket Sharing

A private docket for notes and files, synced across every machine you use.
Static HTML/CSS/JS — no build step, no server, no dependencies. A GitHub gist
you own is the entire backend.

**Live:** https://kalistamp.github.io/doc/

---

## It has no backend of its own

Docket ships with no credentials and no gist id. It is an empty shell until
you point it at a gist you own, under **Settings → Cloud sync**:

| field | what it is |
| --- | --- |
| **GitHub token** | a PAT with **Gists → Read and write** and nothing else |
| **Gist ID** | any gist you own — paste the id or the whole URL |

Both are kept in that browser's `localStorage` and go nowhere but
`api.github.com`. Enter the same two on another machine and the same docket
appears. Anyone else who finds the site gets a blank one until they enter
their own — their notes are their business, yours are yours.

Until you connect something, Docket still works: notes are kept in
`localStorage` on that device and the header reads **Local**. Connecting
later merges what is already there into the gist rather than replacing it.

Files are the exception — their bytes have nowhere to live but the gist, so
uploads wait until you have connected one.

---

## What it does

**Notes.** Any number of independent titled boxes. They autosave about a
second after you stop typing, can be pinned, and are searchable.

A long note does not take over the page. Anything past ~260px collapses
behind an **Expand · N lines** control, and expanding opens the note centred
and full height — monospaced, its own scrollbar, Tab indenting instead of
tabbing away. That view is where a pasted thousand-line file is actually
readable, and on a phone it becomes a full-screen sheet.

**Files.** Drag and drop or browse. Each upload becomes its own file inside
the gist, so it comes back down on any machine — download it, or copy a text
file's contents straight to the clipboard.

---

## How it is wired

```
index.html   markup, inline SVG icon sprite, pre-paint theme bootstrap
style.css    design tokens + layout; dark mode is token overrides only
config.js    filenames, limits, passkey — no credentials
store.js     gist read/write: debounce, write queue, lazy blobs, errors
app.js       notes, files, focus view, tabs, modals, rendering
```

### Storage layout

```
docket share.json     notes + file metadata      rewritten on every edit
docket-blob-<id>      one file per upload        written only when that file changes
```

One gist file per upload, rather than one big JSON of them, because of how
the API is shaped:

- it returns **1 MB inline** per file, serves the rest through `raw_url`, and
  gives up entirely past **10 MB** — and that ceiling is *per file*, so
  splitting multiplies the space actually reachable;
- changing one file no longer re-uploads every other;
- opening the app no longer downloads every byte you have stored.

That last one matters most. Blobs are fetched **only when you download or
copy that file**, so a docket holding hundreds of megabytes opens as fast as
an empty one.

### Limits, and why they are where they are

| limit | value | why |
| --- | --- | --- |
| per file | **7 MB** | base64 adds a third, landing at ~9.3 MB stored — just under the 10 MB past which GitHub stops serving a gist file over HTTP and wants a `git clone` instead |
| files | **280** | the API returns at most 300 files per gist and truncates the list beyond that |

7 MB is the honest ceiling for something that has to read its own data back
over HTTP. Raising it further would let you store files the app could no
longer open.

### Saving

Writes are debounced (~0.9 s) and queued so only one PATCH is ever in flight —
two overlapping PATCHes to the same gist can land out of order and quietly
undo each other. A failed write puts its dirty flag back so the next edit, or
the Retry button, carries it up again.

The debounce has a 5 s ceiling. Without one it starves: typing steadily
resets the timer on every keystroke, so the app looks like it is saving and
never actually does.

---

## Two machines at once

Sync is last-write-wins on the whole document. There is no merge: if you edit
the same note on two machines without syncing in between, the second save
wins outright.

In practice this rarely bites, because saves land about a second after you
stop typing. If you know another machine has been busy, click the status pill
first — it pushes anything outstanding and then pulls.

---

## The passkey

`p`, in `config.js`. It keeps the UI from opening to a passer-by and that is
all it is for — this file is public, so it is a doorbell, not a lock. What
actually protects your notes is the token, which is never in this repo.

---

## Token permissions

The PAT needs **Gists → Read and write**. On a fine-grained token that lives
under *Account permissions*, not *Repository permissions*.

Read-only is the easy mistake, and it fails confusingly: the app loads your
existing notes perfectly and then every save fails. `store.js` translates
GitHub's unhelpful *"Resource not accessible by personal access token"* into
a banner naming the setting to change.

---

## Running it locally

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Any static server works, and `file://` is fine too — there is no longer any
Web Crypto in the load path.

---

## Deployment

Pushing to `main` publishes it; Pages serves the repo root. `.nojekyll` stops
Jekyll touching the files, and asset links carry a `?v=` cache buster — bump
it when you change a script or the stylesheet so returning visitors do not
run a stale file against new markup.
