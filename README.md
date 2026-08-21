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

**Notes.** Any number of independent titled boxes, plain text or checklist.
They autosave about a second after you stop typing, and can be sorted by
recently updated, recently created or title.

The Notes toolbar carries a view menu shaped like a file explorer's — four
card sizes and a plain list:

| view | what you get |
| --- | --- |
| **Extra large** | one or two wide cards, a screenful of text each |
| **Large** | more width and visible text per note |
| **Medium** | the default board |
| **Small** | narrow cards, the most notes on screen |
| **List** | one row per note: title, folder, stamp, actions — no body |

List rows carry a chevron that opens the note in the full-height focus view,
since there is no body on the row to click into. The preference stays on that
device; a device still holding the retired **Compact** setting comes up on
**Small**, its nearest equivalent.

Leave the title blank and the card borrows its first line — shown only, never
written back, so typing a real title still just works. That is also why a new
note opens with the caret in its body rather than its title: the title has an
answer already, and pressing **New note** almost always means you have
something to type. A new list opens on its first item, for the same reason.

**Markdown.** A note that reads like Markdown is drawn the way GitHub would
draw it — headings, lists, tables, code blocks, task boxes, quotes, links —
rather than as the syntax you typed at it. Nothing has to be turned on:
`markdown.js` scores the usual constructs and decides per note. A fenced
code block, the row of dashes under a table header and a `- [ ]` box each
say Markdown on their own, because nothing else writes them by accident.
A heading or a list has to agree with something else, so a shell script
full of `#` comments and a pasted file full of asterisks stay the text they
are. A false positive costs a note its indentation until you say otherwise;
a false negative costs a click. The scoring leans that way on purpose.

It will still be wrong sometimes, which is what the **Plain text ·
Markdown** switch is for: the MD button in a card's footer, and the same
choice spelled out in the head of the focus view. Pressing it is that
note's answer from then on, and it is the note's rather than the device's —
see *Two machines at once*.

A rendered card has no caret to click into, so clicking one opens the focus
view, where switching back to plain text hands you the caret with it. A
link inside a note is followed rather than intercepted.

Two things it deliberately will not do. Raw HTML in a note is shown as the
characters you typed rather than rendered: a note is where you paste things
you did not write, and running those as live HTML inside a tab holding a
GitHub token is not a trade worth making. `javascript:` and `data:` link
targets go the same way, as plain text. And a single newline is a line
break here — the way it is in a GitHub comment, not the way it is in a
README — because pressing Enter and getting a new line is what writing a
note means, and gluing the lines back together is the surprise that makes
people give up on Markdown for notes.

**Pinning.** Pinned notes are lifted into their own band at the top, newest
pin first, as many as you like. Pinning deliberately does *not* touch the
updated stamp: it is not an edit, and a note you merely pinned should not
jump to the front of a recently-updated sort.

It carries its own date instead, `pinnedAt`, written whichever way the pin
is turned. That is what orders the band, and — because `updated` is what
every merge compares — it is also the only reason a pin made on your phone
is a pin on your laptop. See *Two machines at once*.

**Finish Next.** A second band, above Pinned, on the flag button beside the
pin — outline while the note is not flagged, solid once it is. Pinning is for
what you want kept in reach; Finish Next is for what you mean to get done,
and the two answer different questions often enough to be worth separate
bands. It works the same way in every respect — its own band,
newest mark first, its own date in `finishNextAt`, and the same deliberate
refusal to touch the updated stamp.

The two flags are independent: marking a note leaves its pin exactly as it
was, and unpinning one leaves its mark. A note wearing both is *drawn* once,
in the higher band, with both controls lit — a note drawn twice would be two
cards answering to one id, and every lookup on the board reads the first it
finds and leaves the other stale.

The board is laid out as masonry rather than a grid. A grid puts cards in
rows and makes every row as tall as its tallest card, so a two-line note
beside a sixty-line one leaves a dead band of whitespace beneath it.

A long note does not take over the page. Anything past ~260px collapses
behind an **Expand · N lines** control, and expanding opens the note centred
and full height — monospaced, wrapped, Tab indenting instead of tabbing away.
That view is where a pasted thousand-line file is actually readable, and on a
phone it becomes a full-screen sheet.

Lines wrap at every width rather than scrolling sideways. Preserving a code
line's real shape sounds better than it reads: it puts half of every long
line off-screen and leaves you working the scrollbar, which defeats the point
of a view that exists to make a long note legible. Indentation survives.

**Merging.** Two or more notes into one, on the **Merge** button in the
Notes toolbar. It turns the board into a selection surface: every card takes
a click, and each one you pick wears the number you picked it in. Nothing
else on a card answers while it does — the pin, the folder and the delete
all act on the board the pick order is being counted against.

The first pick is the note that survives. It keeps its id, its title, its
created date, its folder and both band flags, and every later pick is
appended into it in the order shown. That order is the whole feature, so it
is shown rather than assumed: the numbers say what arrives when, and the bar
above names the note the rest are going into.

Each note merged in is introduced by its own title, or by nothing if it has
none — its first line is already doing that job. The note being merged into
contributes its text bare, since its title is the merged note's title, and
heading its own text with it would title a section that is the whole note.

Checklists merged with checklists stay a checklist, items end to end. A
mixed pick lands as text, because text is the only shape both kinds share: a
checklist reads back as `[x] item`, the same lines the `.txt` export writes.
The other direction has no honest answer — turning a note's lines into
tickable items means guessing which of a thousand pasted lines were meant to
be ticked, and being wrong about most of them. The dialog says so before it
happens, flattening being the one part of a merge you cannot read back off
the result afterwards.

The notes merged in go to the trash rather than away, so the pick you did
not mean is a Restore away and the surviving note's previous text is in the
version history. Having asked first, a merge does not also offer an Undo —
the same trade the note delete makes. And it travels like any other pair of
edits: the surviving note wins on `updated`, and the ones it swallowed
travel as the tombstones every other delete does, so a merge made here does
not come undone by a browser elsewhere that still had all of them.

**Files.** Drag and drop or browse. Each upload becomes its own file inside
the gist, so it comes back down on any machine — download it, or copy a text
file's contents straight to the clipboard.

**Folders.** One shared set across both tabs, as a scrolling chip bar under
the tabs: `All`, each folder with its count, and `Unfiled`. The counts follow
whichever tab you are on. Create one with **+ Folder**, rename or delete one
with the controls on its chip, and move an item with the folder button on a
note's footer or in a file's meta line. Anything made while a folder is
selected lands in it.

**Search** is one box for the whole docket. It filters notes and files at
once — including inside checklist items — and the tab counts become match
counts, so you can see which side the hits are on without switching. Search
and folder filters toggle existing rows in place, preserving carets and
avoiding a resize/reflow pass for every card on each keystroke.

**Trash.** Deleting a note asks first — the delete control sits beside the
pin on every card, and an Undo you have eight seconds to notice is a poor
answer to a mis-click found later. Deleting a file still offers Undo on the
spot: dropping one in is a single motion with nothing to re-read, and a
dialog per file is friction where the toast is not.

Either way it goes to the trash, not away. A Trash tab appears while
anything is in it, with Restore and Delete forever; everything is purged
automatically after 30 days. A trashed file keeps its blob in the gist until
then — there would be nothing to restore otherwise, and emptying the trash
is what actually reclaims the space.

**Backup.** Settings → Backup exports the whole docket as `.json` (a complete
backup, re-importable) or `.txt` (every note laid out for reading, not
importable — it says so at the top). Import asks before replacing anything.

**Version history.** Durable typing and navigable history are separate. The
currently edited note autosaves on the short clock, while blur, note/tab
switches, structural changes, unload, and ten quiet minutes create archive
checkpoints. Settings → Version history thins the remaining gist clock noise
into useful restore points. A restore is itself a checkpoint and is undoable.

A folder is only a label — membership is one `folder` id on the item — so
deleting a folder never deletes what was in it. Its contents fall back to
Unfiled, and the confirm dialog says so before you commit.

---

## How it is wired

```
index.html   markup, inline SVG icon sprite, pre-paint theme bootstrap
style.css    design tokens + layout; dark mode is token overrides only
config.js    filenames, limits, passkey — no credentials
store.js     gist read/write: debounce, write queue, lazy blobs, errors
markdown.js  Markdown detection and rendering — no dependencies, no CDN
app.js       notes, files, focus view, tabs, modals, rendering
```

### Storage layout

```
docket share.json     cold notes + file/folder/trash metadata   written at checkpoints
docket-hot-<id>       a note being edited, stamped with its owner   written on the save clock
docket-blob-<id>      one file per upload                        written only when that file changes
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
undo each other. While typing, that PATCH contains only the compact hot note,
not the full docket. A failed write puts its dirty state back so the next edit,
or the Retry button, carries it up again.

The debounce has a 5 s ceiling. Without one it starves: typing steadily
resets the timer on every keystroke, so the app looks like it is saving and
never actually does. On blur or note switch, the hot note folds into the cold
archive and its temporary file is deleted. If a session is interrupted, load
reconciles the hot note by its update time and folds it on startup.

A failed save retries itself, backing off from 2 s to a minute, and honours
`Retry-After` when GitHub asks for one. Nothing rearmed the clock before, so a
single dropped packet parked the docket on **Failed** until somebody noticed
the banner and pressed Retry. Rate limiting is called by its name rather than
reported as the permission error it shares a status code with — several
browsers saving into one gist can reach GitHub's per-minute write limit, and
that is a wait, not a setting to change.

Closing the tab deliberately does *not* checkpoint. A checkpoint rewrites the
whole archive, an unloading page has no time for the read that would make that
safe, and the note you were typing is already durable in its own hot file —
the next load recovers it from there.

---

## Two machines at once

Two browsers on one gist are two writers with no lock between them. The write
queue in `store.js` only orders *this* browser's requests, so on its own it
does nothing about the case that matters: a PATCH that rewrites the whole
archive from memory that went stale minutes ago, replacing the other
browser's docket wholesale.

Three things keep that from happening.

**A write that rewrites the archive reads first.** Before that one payload —
and only that one, since hot files are named per note and per writer, and
blobs per upload — the store asks GitHub whether the gist has moved since it
last looked. The question is a conditional request, so an unchanged gist
answers `304` with no body and no rate-limit charge; the round trip is only
paid for at checkpoints, never on the typing clock.

**"It moved" is answered by merging, not by overwriting.** Items reconcile by
id on their own timestamp, and a deletion is not an absence — it is an entry
in `trash`, which is what lets a delete made on one machine survive being
merged with a machine that still has the item in its list. An item edited
after it was binned wins and takes its tombstone with it; emptying the trash
leaves the id, the date and a flag behind, because dropping the record
outright is how a purged note walks back in from the other browser. A tie
goes to the browser doing the reconciling.

**A band flag is reconciled on its own clock.** Everything above compares
`updated`, and neither pinning a note nor marking it to finish next bumps
it, so both are invisible to that comparison: two copies of a note differing only in their pin are a
tie, and the tie always keeps whatever the reconciling browser already had.
Read in one direction that looks like the feature — a pin made *here*
survives. Read in the other it is the bug it also was: a pin made on the
phone arrived looking exactly like a note the browser already had, so it was
dropped, and then written back to the gist as an unpin on the browser's next
checkpoint. The pin therefore carries `pinnedAt`, and the later pin change
wins the pin whichever copy of the note wins the note — so an edit on one
machine and a pin on the other both land. The stamp is written when the pin
comes off as well as when it goes on; an unpin that cleared the field was
the one change that could never out-argue the pin it undid.

`finishNext` carries `finishNextAt` and is reconciled the same way, on an
axis of its own rather than sharing the pin's. Sharing one would fail on the
case the separation exists for: pin a note here, mark it to finish next on
your phone, and neither change bumped `updated`, so the note itself is a tie
whichever way you look at it. A single clock settles that once and drops the
other machine's change. Two clocks land both.

The Markdown switch is the third of these, on `markdownAt`, and travels by
the same route for the same reason. It differs from the other two in being
three-valued rather than two: `true` and `false` are answers you gave, and
*absent* is nobody having said, which is what every note written before the
preview existed says and what leaves detection free to decide. Reconciling
it as a plain boolean is the bug that shape avoids — every one of those
notes would arrive at the other machine pinned to plain text by a decision
no one made.

The same overlay guards the hot file. A note being typed on one machine is
a snapshot that knows nothing of a pin another machine has put on it since,
and folding it in wholesale would strip the pin before the merge ever saw
it.

**A hot file belongs to the browser writing it.** Each one is stamped with a
client handle, and a browser folds only its own or one left abandoned for two
minutes. Opening a second window no longer deletes the first one's live
draft, and a genuine crash still recovers.

Edits to the same note remain last-write-wins. That is the one conflict the
data model cannot resolve for you, and the version history is the way back.

A visible tab re-reads the gist when you return to it and every 45 s
otherwise, so two windows side by side converge without being asked. The
status pill still forces it: it checkpoints, pushes anything outstanding,
then pulls.

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
