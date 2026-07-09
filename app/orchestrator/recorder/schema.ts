export * from "../../../docs/schema/fovea.js";

// Ruling 2 (standalone-viewer-and-fcap): the recorder writes `.fcap`. Only the
// VALUE changes here — the export NAME stays `FOVEA_EXTENSION`, so recorder-node.ts
// and recorder/types.ts (which name the container file from it) are untouched and
// pick this up transparently. Legacy `.fovea` containers stay readable (the viewer
// open filters / file-association strings in electron/main.ts accept both). The
// shared schema constant in docs/schema/fovea.ts keeps the legacy value for the
// Python-side generator until the pyfcap rename (ruling 3, wave 2) lands; a local
// re-declaration shadows the `export *` name above.
export const FOVEA_EXTENSION = ".fcap";
