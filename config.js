/* ============================================================
   DOCKET SHARING — configuration
   ============================================================ */

window.DOCKET_CONFIG = {
    /* The passkey that unlocks the front page. It is also the key that
       decrypts SEALED_TOKEN below, so changing one means re-sealing the
       other (see tools/seal.py). */
    PASSKEY: "p",

    /* The secret gist that backs the whole app.
       https://gist.github.com/kalistamp/0a151d864ab18d9e2fd950cb400c6261 */
    GIST_ID: "0a151d864ab18d9e2fd950cb400c6261",

    /* Notes + file *metadata* live here — small, rewritten on every edit. */
    DATA_FILE: "docket share.json",

    /* File *payloads* (base64) live in a companion file in the same gist.
       Splitting them matters: blobs can run to megabytes, and if they shared
       a file with the notes, every keystroke would re-upload all of them. */
    BLOB_FILE: "docket-blobs.json",

    /* Per-file ceiling. A gist file over ~10 MB is rejected by the API and
       one over ~1 MB stops being served inline, so we stay well under.
       Base64 inflates by ~33%, which this limit is applied *before*. */
    MAX_FILE_BYTES: 2 * 1024 * 1024,

    /* Ceiling on everything stored, measured on the raw bytes. Base64 adds
       ~33%, so 6 MB here lands around 8 MB on the wire — comfortably inside
       what the gist API will take, with headroom for the JSON around it. */
    MAX_TOTAL_BYTES: 6 * 1024 * 1024,

    /* Quiet period after typing before a save fires, in ms. */
    SAVE_DEBOUNCE_MS: 900,

    /* PBKDF2 rounds used to derive the token key. Must match the sealer. */
    KDF_ITERATIONS: 250000,

    /* The GitHub PAT, AES-GCM encrypted under the passkey.
       ------------------------------------------------------------------
       This repo is public, so the plaintext token can never live in it: a
       bare `github_pat_…` string would be caught by GitHub secret scanning
       and revoked automatically, and anyone could read it. Sealing keeps
       the app self-contained (any machine, passkey only, no setup) without
       publishing a live credential.

       Be clear-eyed about what this is: obfuscation, not secrecy. The
       passkey is one character, so anyone who reads this file can brute
       force it in moments. Keep the PAT scoped to gists and nothing else,
       and treat the gist contents as "not really private". A token pasted
       into Settings overrides this one and stays in localStorage only. */
    SEALED_TOKEN:
        "QXM8/eFsQ3vo0zCN68GqT7BGXyLqo5oDSalUrUWAkj/Ht0qGaYmkKk5W7+SioyS/" +
        "miTJJ9TW3mVOC3VdGOKoAJounWeWiQk3KFAcrUHdmVPLx/oOeugeiw2nlgP0qCwT" +
        "mABHzDR1tDIyZ4P3D5vBx4HAAi9/VqHHSiten18xwVDVtGtSDV+j0VM="
};
