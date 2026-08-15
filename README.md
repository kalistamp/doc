# Docket Sharing

A private docket for notes and files, synced across every machine you use.
Static HTML/CSS/JS — no build step, no server, no dependencies. A secret
GitHub gist is the entire backend.

**Live:** https://kalistamp.github.io/docket-sharing/

---

## What it does

**Notes.** Any number of independent notes, each its own titled text box.
They autosave about a second after you stop typing, can be pinned to the top,
and are searchable. Open the site on another machine, enter the passkey, and
they are all there.

**Files.** Drag and drop (or browse) to upload. Each file is base64'd into the
gist, so it comes back down on any machine. Download it, delete it, or — for
text-ish files — copy its contents straight to the clipboard.

Both halves share one lock screen and one sync indicator. The indicator in the
top bar tells you whether the current state has reached the gist; clicking it
pushes anything outstanding and then pulls whatever another machine wrote.

---

## How it is wired

```
index.html   markup, inline SVG icon sprite, pre-paint theme bootstrap
style.css    design tokens + layout; dark mode is token overrides only
config.js    gist id, filenames, limits, the sealed token
crypto.js    passkey → PAT (PBKDF2-SHA256 + AES-GCM, via Web Crypto)
store.js     gist read/write: debounce, write queue, error translation
app.js       notes, files, tabs, modals, rendering
tools/seal.py   re-seals a new PAT against the passkey
```

### Storage layout

Everything lives in one gist, split across two files:

| file | holds | rewritten |
| --- | --- | --- |
| `docket share.json` | notes, file *metadata* | on every edit |
| `docket-blobs.json` | file payloads, base64 | only when files change |

The split is the point. If the blobs shared a file with the notes, every
keystroke would re-upload every megabyte you have stored.

Writes are debounced (~0.9 s) and queued so only one PATCH is ever in flight —
two overlapping PATCHes to the same gist can land out of order and quietly
undo each other. A failed write puts its dirty flag back so the next edit,
or the Retry button, carries it up again.

### The token

The repo is public, so the PAT cannot sit in it as plaintext: GitHub secret
scanning would revoke it within minutes and anyone could lift it. Instead
`config.js` carries the token AES-GCM encrypted under a key derived from the
passkey, and the browser decrypts it after you unlock.

**This is obfuscation, not secrecy.** The passkey is one character and this
source is public, so anyone who cares can brute force it in seconds. See
*Security* below for what that actually means.

To install a different token:

```bash
python3 tools/seal.py /path/to/token.txt p
# paste the output into SEALED_TOKEN in config.js
```

Or skip the redeploy entirely — Settings → GitHub token accepts a PAT and
keeps it in `localStorage` on that machine, overriding the sealed one.

---

## Security

Be clear about what this is and is not.

- **The gist is secret, not private.** GitHub "secret" gists are unlisted, not
  access-controlled: anyone holding the gist id can read it without a token,
  and the gist id is in this public repo. Treat everything you put in Docket
  as *semi-public*. No passwords, keys, financial records, or anything you
  would mind a stranger reading.
- **The passkey is a speed bump.** `"p"` keeps a casual visitor out of the UI.
  It is not a defence against anyone who reads `config.js`.
- **Keep the PAT scoped to gists only.** If it leaks, the blast radius should
  stop at this one gist. It should have no repo, workflow, or package
  permissions.

If you ever want this to be genuinely private, the shape of the fix is a real
backend with a real session — not a longer passkey.

---

## Token permissions

The PAT needs **Account permissions → Gists → Read and write** at
<https://github.com/settings/personal-access-tokens>.

Read-only is the easy mistake, and it fails in a confusing way: the app loads
your existing notes perfectly and then every save fails. `store.js` translates
GitHub's unhelpful *"Resource not accessible by personal access token"* into a
banner that names the setting to change.

---

## Running it locally

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Any static server works. `file://` does not — the Web Crypto API used to
unseal the token requires a secure context, which means `http://localhost` or
HTTPS.

---

## Deployment

Pushing to `main` publishes it; GitHub Pages serves the repo root. `.nojekyll`
is there to stop Jekyll from touching the files. Asset links carry a `?v=`
cache buster — bump it when you change a script or the stylesheet so returning
visitors do not run a stale file against new markup.
