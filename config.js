/* ============================================================
   DOCKET SHARING — configuration

   No credentials live here. The GitHub token and gist id are yours,
   entered once per device under Settings → Cloud sync, and kept in
   localStorage on that device only. Nothing in this repo can reach
   anyone's gist, which is what makes the published site safe to share.
   ============================================================ */

window.DOCKET_CONFIG = {
    /* Unlocks the front page. Not a security boundary — this file is
       public. It only keeps the UI from opening to a passer-by; your
       data is protected by the token you enter, not by this. */
    PASSKEY: "p",

    /* Notes and file *metadata* — small, rewritten on every edit. */
    DATA_FILE: "docket share.json",

    /* Each upload becomes its own gist file, `docket-blob-<id>`. One
       file per blob rather than one big JSON of them, because:
         · the API only returns 1 MB inline, and serves the rest through
           raw_url up to 10 MB — a ceiling that applies per FILE, so
           splitting multiplies the space actually reachable;
         · changing one file no longer re-uploads all the others;
         · loading the app no longer downloads every blob you have. */
    BLOB_PREFIX: "docket-blob-",

    /* Per-file ceiling on the raw bytes. base64 inflates by 4/3, so this
       lands at ~9.3 MB stored — just under the 10 MB above which GitHub
       stops serving a gist file over HTTP and demands a git clone. Going
       higher would store files the app then could not read back. */
    MAX_FILE_BYTES: 7 * 1024 * 1024,

    /* The API returns at most 300 files per gist and truncates the list
       past that. One slot is the data file; the rest is headroom. */
    MAX_FILES: 280,

    /* Quiet period after typing before a save fires, in ms. */
    SAVE_DEBOUNCE_MS: 900,

    /* Ceiling on how long an unsaved change may sit, in ms. Without it,
       steady typing resets the debounce forever and nothing is saved. */
    MAX_SAVE_WAIT_MS: 5000,

    /* A note taller than this collapses behind an expand control, so one
       pasted file cannot push everything else off the screen. */
    NOTE_COLLAPSE_PX: 260
};
