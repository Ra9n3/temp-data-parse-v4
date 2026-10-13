import { createRequire } from "node:module";
// Direct file require: the run hook redirects the bare specifier "@tonejs/midi"
// back here, so the shim must load the CJS build by path (no hook match).
const require = createRequire(import.meta.url);
const mod = require("../node_modules/@tonejs/midi/build/Midi.js");
export const Midi = mod.Midi ?? mod.default?.Midi;
export default mod;
