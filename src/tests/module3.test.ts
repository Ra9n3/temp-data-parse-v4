/** Standalone Module 3 verification harness (run with `node --import tsx`). */
import {
  applyRegisterDynamicModifiers,
  INSTRUMENT_DATABASE,
  InstrumentProfileLoader,
  isWithinPracticalRange,
  TranspositionAdapter,
  type OrchestralRole,
} from "../generation/instrumentDB";

const results: string[] = [];
const check = (name: string, fn: () => string) => {
  try {
    results.push(`PASS ${name} :: ${fn()}`);
  } catch (error) {
    results.push(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
};

check("database coverage and band validity", () => {
  const loader = new InstrumentProfileLoader();
  if (loader.instrumentCount < 20) throw new Error(`only ${loader.instrumentCount} instruments`);
  for (const family of ["STRINGS", "WOODWINDS", "BRASS", "PITCHED_PERCUSSION", "KEYBOARDS"] as const) {
    if (!loader.getProfilesByFamily(family).length) throw new Error(`missing family ${family}`);
  }
  for (const profile of INSTRUMENT_DATABASE) {
    if (!profile.registers.length) throw new Error(`${profile.id} no registers`);
    if (profile.rangeWritten.practicalMin < 0 || profile.rangeWritten.practicalMax > 127) throw new Error(`${profile.id} bounds`);
    for (const band of profile.registers) {
      if (band.minPitchWritten > band.maxPitchWritten) throw new Error(`${profile.id} inverted band`);
      if (band.velocityModifier < -15 || band.velocityModifier > 15) throw new Error(`${profile.id} vel range`);
      if (band.brightnessModifier < -20 || band.brightnessModifier > 20) throw new Error(`${profile.id} brightness range`);
    }
    if (!(profile.carryingPowerWeight > 0 && profile.carryingPowerWeight <= 1.2)) throw new Error(`${profile.id} carrying power`);
  }
  for (const role of ["LEAD", "COUNTERLINE", "PAD", "OSTINATO", "BASS"] as OrchestralRole[]) {
    if (!loader.getProfilesByRole(role).length) throw new Error(`no ${role} instrument`);
  }
  return `${loader.instrumentCount} instruments, all bands/roles/weights valid`;
});

check("range utility flags", () => {
  const loader = new InstrumentProfileLoader();
  const ok = isWithinPracticalRange(72, "violin_1", loader);
  if (!ok.withinPracticalRange || !ok.withinProfessionalRange || ok.professionalOnly) throw new Error("mid violin wrong");
  const pro = isWithinPracticalRange(94, "violin_1", loader);
  if (pro.withinPracticalRange || !pro.withinProfessionalRange || !pro.tooHigh || !pro.professionalOnly) {
    throw new Error(`pro-only zone wrong: ${JSON.stringify(pro)}`);
  }
  const absurd = isWithinPracticalRange(127, "violin_1", loader);
  if (absurd.withinPracticalRange || absurd.withinProfessionalRange) throw new Error("127 should fail both");
  const unknown = isWithinPracticalRange(60, "theremin");
  if (unknown.withinPracticalRange) throw new Error("unknown id should fail closed");
  const flute = isWithinPracticalRange(60, "flute", loader);
  if (!flute.withinPracticalRange) throw new Error("flute C4 should be practical");
  return "practical / professional-only / out-of-bounds / unknown-ID paths validated";
});

check("transposition adapter", () => {
  const loader = new InstrumentProfileLoader();
  const cases: Array<[string, number]> = [
    ["french_horn", -7],
    ["english_horn", -7],
    ["clarinet_bb", -2],
    ["trumpet_bb", -2],
    ["bass_clarinet", -14],
    ["double_bass", -12],
    ["piccolo", 12],
    ["glockenspiel", 24],
    ["celesta", 12],
    ["violin_1", 0],
  ];
  for (const [id, offset] of cases) {
    const profile = loader.getProfile(id);
    if (!profile) throw new Error(`${id} missing`);
    if (profile.transpositionSemitones !== offset) throw new Error(`${id} offset ${profile.transpositionSemitones} != ${offset}`);
    const written = TranspositionAdapter.concertToWritten(60, profile);
    if (TranspositionAdapter.writtenToConcert(written, profile) !== 60) throw new Error(`${id} not invertible`);
    if (TranspositionAdapter.clefForPitch(90, profile) !== (profile.alternateClef ?? profile.defaultClef)) throw new Error(`${id} clef fallback`);
  }
  return "horn -7, EH -7, clarinet -2, trumpet -2, bass clarinet -14, contrabass -12, piccolo +12, glock +24, celesta +12 verified";
});

check("register modifiers", () => {
  const loader = new InstrumentProfileLoader();
  const flute = loader.getProfile("flute")!;
  const trumpet = loader.getProfile("trumpet_bb")!;
  const horn = loader.getProfile("french_horn")!;
  const fluteLow = applyRegisterDynamicModifiers(60, flute);
  if (!fluteLow.requiresAccompanimentAttenuation) throw new Error("low flute no attenuation flag");
  if (!(fluteLow.velocityModifier < 0 && fluteLow.brightnessModifier < 0)) throw new Error("low flute modifiers wrong");
  if (applyRegisterDynamicModifiers(72, flute).requiresAccompanimentAttenuation) throw new Error("mid flute flagged");
  const trumpetHigh = applyRegisterDynamicModifiers(84, trumpet);
  if (Math.abs(trumpetHigh.cc11Scale - 0.88) > 1e-9) throw new Error(`high trumpet cc11 ${trumpetHigh.cc11Scale}`);
  if (!(trumpetHigh.velocityModifier > 0 && trumpetHigh.brightnessModifier > 0)) throw new Error("high trumpet modifiers");
  if (applyRegisterDynamicModifiers(64, trumpet).cc11Scale !== 1) throw new Error("mid trumpet scaled");
  if (!(applyRegisterDynamicModifiers(44, horn).velocityModifier < 0)) throw new Error("low horn modifier");
  return "flute attenuation, trumpet CC balance, register scaling verified";
});

console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
