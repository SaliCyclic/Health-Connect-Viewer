# Contributing

Thanks for helping! A few things keep this project trustworthy for people's health data.

## Ground rules

- **No health data in the repository, issues or pull requests.** Use the synthetic export (`tests/make_fake_export.py`) for testing and screenshots. If a bug only shows up with a real export, ask the reporter for their **schema report** (All tables & SQL → Copy schema report). It contains table and column names only.
- **The page stays offline.** Don't add anything that loads scripts, fonts, styles or data from the internet, or sends anything out. The Content-Security-Policy in `src/index.html` (`connect-src 'none'`) enforces this. Don't loosen it.
- **One file.** `dist/health-connect-viewer.html` must keep working when opened straight from disk, with no server and no network.

## Layout

| Path | What it is |
|---|---|
| `src/index.html` | Page shell with placeholders the build fills in |
| `src/css/app.css` | All styles (light, dark, phone, print) |
| `src/js/00-core.js` … `90-app.js` | The app, concatenated in name order into one script |
| `src/worker/db-worker.js` | The database worker (SQLite WebAssembly + streaming unzip; memory or low-memory mode) |
| `src/pwa/` | Service worker, manifest and icons for the installable offline app |
| `scripts/build.mjs` | Builds `dist/` |
| `tests/` | Synthetic data generator, end-to-end tests, performance script |

All database access goes through `q()` / `qx()` in `src/js/10-db.js`, which send SQL to the worker and cache answers. The export is read-only, so cached answers stay valid while a file is open.

## Workflow

```sh
npm ci
npm run build                       # rebuild dist/ after any change in src/
python tests/make_fake_export.py    # once, or after changing the generator
python tests/test_viewer.py
```

Commit the rebuilt `dist/` along with your source change. CI fails if `dist/` doesn't match the source.

## Adding a metric

Most Health Connect record types need only an entry in `METRICS` in `src/js/00-core.js`. Give it:

- **table:** the AOSP table name
- **cols:** the value column
- **kind:** `sum` for daily totals, `avg` for measurements, `duration` for session minutes
- **unit, scale and dp:** how values are shown
- **cat:** its Health Connect data category, used for app priority

Then add a few rows for it to `tests/make_fake_export.py`.

## Releasing

1. Bump `version` in `package.json` and run `npm run build`.
2. Commit, then tag `vX.Y.Z` and push the tag. The release workflow builds the page and attaches it to a GitHub release.
