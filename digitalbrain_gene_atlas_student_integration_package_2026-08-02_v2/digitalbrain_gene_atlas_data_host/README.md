# DigitalBrain Gene Atlas Data Host

Public, read-only delivery host for the individual-study compact matrices used
by the DigitalBrain Gene Atlas. It exists because the combined atlas plus all
study bundles exceed the main site's deployment-package limit.

It contains derived browser matrices only, never raw H5AD files. The main atlas
reads them from the host's public, CORS-enabled `/api/data/…` route, which maps
only to immutable files under `dist/client/data/`. Visitors download only the
gene index and blocks required by their selected study and gene queries.

Run `npm run build` to create the deployable `dist/` directory.
