/**
 * Fixed project paths, in a module with no imports. Modules that build other constants from these at load time
 * (e.g. `${TMP_DIR}/skills`) import them from here: in the bundled CLI an import cycle through presets.ts left
 * TMP_DIR undefined at that moment (".tossana/tmp" became "undefined").
 */

/** Folder for comment drafts and per-machine run files (git-ignored). */
export const TMP_DIR = '.tossana/tmp';
