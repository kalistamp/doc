# Docket Sharing

A private static notes-and-files application backed by the `doc` schema in a
shared Supabase project.

## Architecture

- Supabase Auth provides email/password sign-in.
- `doc.docket_items` stores one note, folder, file-metadata record, or trash
  tombstone per row; edits send only changed rows.
- `doc.docket_item_versions` and `doc.docket_revision_events` provide delta
  history without copying the whole docket on every save.
- A private `doc-files-v2` Supabase Storage bucket holds file bytes.
- `doc.docket_sync_state` drives filtered Realtime updates; there is no
  background database polling loop.
- IndexedDB caches individual records locally, so a keystroke persists only
  the note being edited.
- Row Level Security limits every record to its authenticated owner.

The browser receives only the public Supabase URL and publishable key. The
service-role key is never used by the website.

## Deployment

Repository secrets required by `.github/workflows/deploy-pages.yml`:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

In repository **Settings → Pages**, select **GitHub Actions** as the source.
Pushing `main` runs the tests, injects the public values into the deployment
artifact, and publishes the site.

## Local verification

```bash
node --check config.js
node --check store.js
node --check markdown.js
node --check app.js
for test_file in tests/*.test.js; do node "$test_file"; done
```

Shared Supabase migrations and deployment commands are intentionally kept
outside this static repository at:

`/home/ks/Documents/projects_audit/prelaunch_deployment/shared_supabase/`

The v2 migration is additive. Legacy `documents`, `drafts`, `blobs`, and
`revisions` tables remain available as rollback data until the upgraded site
has been verified and legacy file migration has completed.
