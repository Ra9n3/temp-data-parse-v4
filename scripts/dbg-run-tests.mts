import { runUnitTests } from "../src/tests/runTests";
let pass = 0, fail = 0;
for (const t of runUnitTests()) {
  if (t.pass) pass++; else { fail++; console.log("FAIL:", t.name, "—", t.detail); }
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
