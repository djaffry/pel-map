# PeL Map

A small static web app that **visualizes organization** in a clear, balanced layout.
> In the app, press **?** for the legend and keyboard shortcuts.

## Run it

```bash
python3 -m http.server 8080   # or: npm run serve
# then open http://localhost:8080
```

Serve over HTTP (not a `file://` URL) — the app uses ES modules and `fetch`.

## Tests

```bash
npm test        # zero-dep unit tests (node --test)
npm run test:ui # DOM smoke test (needs: npm i)
```
