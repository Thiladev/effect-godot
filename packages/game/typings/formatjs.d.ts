// FormatJS ships plenty of side-effect-only subpaths (`/polyfill`,
// `/locale-data/en`, `/add-golden-tz`, ...) without `.d.ts` files for each of
// them. Rolldown resolves and bundles these fine at build time regardless;
// this ambient wildcard just keeps `tsc --noEmit` (editor type-checking)
// quiet about imports that exist purely for their side effects.
declare module "@formatjs/*"
