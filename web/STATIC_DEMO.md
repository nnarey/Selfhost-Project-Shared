# Static demo publish (no live data)

Static demo build of the World Cup UI with **seeded localStorage data only**.
No Apps Script URL, no Sheets, no Splunk, no Form roster sync.

## Artifact

`npm run build:static-demo` writes a local `web/dist` with seeded demo data only. Zip that folder yourself if you need to hand someone a static page.

Rebuild anytime with:

```bash
cd web
npm run build:static-demo
# then re-zip dist/ as above, or run the publish steps from the agent/README
```

## Static steps

1. static site → **New page** (or update an existing World Cup demo page)
2. Upload **`static-worldcup-demo.zip`**
3. Suggested slug: `fieldcam-worldcup-demo`
4. Visibility: **Unlisted** (share the link only)
5. Open the page URL — you should see an amber **Demo mode** banner

## Safety check

The production bundle was built with `VITE_APPS_SCRIPT_URL` forced empty and verified to contain **no** `script.google.com` references.
