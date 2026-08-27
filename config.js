/* Public browser values are injected into the deployed copy by GitHub Actions. */
window.SUPABASE_CONFIG = {
    url: 'PUT_YOUR_SUPABASE_URL_HERE',
    publishableKey: 'PUT_YOUR_PUBLISHABLE_KEY_HERE',
    schema: 'doc'
};

/* Docket behavior and UI limits. */

window.DOCKET_CONFIG = {
    /* Private Storage bucket and per-file ceiling. This must stay in step
       with `file_size_limit` on the bucket, which answers 413 for anything
       larger whether or not the browser agrees. */
    STORAGE_BUCKET: 'doc-files-v2',
    MAX_FILE_BYTES: 50 * 1024 * 1024,

    /* A guard against exhausting the free tier's 1 GB of Storage, held clear
       of the ceiling so a slow cleanup is not an outage. Counted in bytes
       rather than files: a file count cannot tell 280 screenshots from 280
       videos, and the old one quietly promised twice the space the plan has.

       Storage is a separate allowance from the 500 MB database the four
       applications share, so this budget is Docket's alone to spend. */
    MAX_TOTAL_BYTES: 800 * 1024 * 1024,

    /* How much of that IndexedDB keeps on the device, so opening the same
       file twice costs Storage egress once. Egress is the scarcest part of
       the free tier; least-recently-used bytes are evicted to make room. */
    BLOB_CACHE_BYTES: 200 * 1024 * 1024,

    /* Quiet period after typing before a save fires, in ms. */
    SAVE_DEBOUNCE_MS: 900,

    /* Ceiling on how long an unsaved change may sit, in ms. Without it,
       steady typing resets the debounce forever and nothing is saved. */
    MAX_SAVE_WAIT_MS: 5000,

    /* A failed save retries on its own, doubling from here to this
       ceiling. Without it a single dropped packet parked the docket on
       "Failed" until somebody noticed the banner. */
    RETRY_BASE_MS: 2000,
    RETRY_MAX_MS: 60000,

    /* Realtime handles active tabs. Focus events use this long throttle as
       a reconnect safety net, without a background polling loop. */
    REFRESH_THROTTLE_MS: 5 * 60 * 1000,

    /* Legacy Postgres blobs migrate to Storage one at a time. */
    BLOB_MIGRATION_PAUSE_MS: 1500,

    /* A note taller than this collapses behind an expand control, so one
       pasted file cannot push everything else off the screen. */
    NOTE_COLLAPSE_PX: 260,

    /* Card height follows the local view preference. Width is controlled in
       CSS; these values keep the visible amount of note text proportional.
       `list` is absent on purpose — that view shows titles only, so there
       is no body to measure and nothing that can overflow. */
    NOTE_VIEW_HEIGHTS: {
        small:  { collapse: 150, minimum: 68 },
        medium: { collapse: 260, minimum: 96 },
        large:  { collapse: 420, minimum: 140 },
        xlarge: { collapse: 560, minimum: 150 }
    },

    /* Deleted items sit in the trash this long before being purged on the
       next load. Long enough to notice a mistake a week later. */
    TRASH_DAYS: 30,

    /* How long the Undo button stays on a toast, in ms. */
    UNDO_MS: 8000,

    /* Maximum revisions listed in the history dialog. */
    HISTORY_LIMIT: 40
};
