// CLI runner for the pinned suite: Node's ESM interop cannot statically see
// @tonejs/midi's CJS named export, so redirect that specifier to a shim.
// Production (Vite) interop is unaffected; the suite file itself is untouched.
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@tonejs/midi") return next(pathToFileURL(fileURLToPath(new URL("./tonejs-shim.mjs", import.meta.url))).href, context);
    return next(specifier, context);
  },
});
const { runUnitTests } = await import("../src/tests/runTests.ts");
let pass = 0, fail = 0;
for (const t of runUnitTests()) {
  if (t.pass) pass++; else { fail++; console.log("FAIL:", t.name, "—", t.detail); }
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
