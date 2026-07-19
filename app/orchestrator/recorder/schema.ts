export * from "../../../docs/schema/fovea.js";

// The recorder writes `.fcap`. The export NAME stays `FOVEA_EXTENSION`, so
// consumers that name the container file from it pick this value up
// transparently. Legacy `.fovea` containers stay readable (the viewer open
// filters / file-association strings in electron/main.ts accept both). The
// shared schema constant in docs/schema/fovea.ts keeps the legacy value for the
// Python-side generator until the pyfcap rename lands; a local re-declaration
// shadows the `export *` name above.
export const FOVEA_EXTENSION = ".fcap";
