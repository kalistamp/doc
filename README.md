# Docket Sharing

A private static notes-and-files application backed by the `doc` schema in a
shared Supabase project.

## Architecture

- Supabase Auth provides email/password sign-in.
- `doc.documents` stores the current notes, folders, file metadata, and trash as JSONB.
- `doc.drafts` protects active edits and supports crash recovery.
- `doc.blobs` stores uploaded file content separately so app startup remains fast.
- `doc.revisions` stores document checkpoints for version history.
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

One-time Gist export, Supabase SQL, import utilities, cleanup SQL, and the
migration guide are intentionally kept outside this repository at:

`/home/ks/Documents/projects/backup_migration/doc/`
