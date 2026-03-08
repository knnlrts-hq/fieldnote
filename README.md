# Obsidian Web Editor

A static GitHub Pages-friendly markdown editor for encrypted standalone Obsidian notes stored in Supabase.

## Included features

- Email/password Supabase sign-in
- Second passphrase-derived AES-GCM encryption key held in memory only
- Upload local `.md`, `.markdown`, and `.txt` files
- Create, edit, rename, download, and delete notes
- Live markdown preview
- Obsidian-style wikilinks (`[[Note]]`, `[[Note|Alias]]`)
- Obsidian callouts (`> [!note]`, foldable `+`/`-` variants)
- LaTeX rendering with KaTeX
- Raw HTML tables in markdown
- Revision history with restore and download actions
- Static HTML/CSS/JS only, no build step, no React

## Files

- `index.html` — page shell, CSP, CDN dependencies
- `styles.css` — layout and preview styling
- `app.js` — auth, encryption, editor, preview, storage, revisions

## Before deploying

This version is already configured for:

- Supabase URL: `https://dbxmizntfrggqivkoibz.supabase.co`
- Bucket: `private-blobs`
- Tables: `blob_index`, `markdown_revisions`

If you switch projects later, update the constants at the top of `app.js` and the `connect-src` value in `index.html`.

## Deploy to GitHub Pages

1. Copy `index.html`, `styles.css`, and `app.js` into your GitHub Pages repository root.
2. Commit and push.
3. Enable GitHub Pages for that branch.
4. Open the published URL and sign in with your Supabase account.

## Notes

- The passphrase is never stored in Supabase.
- Losing the passphrase means you cannot decrypt existing notes.
- Revisions are stored as separate encrypted blobs in Supabase Storage.
- The app filters out non-markdown records already present in `blob_index`.
