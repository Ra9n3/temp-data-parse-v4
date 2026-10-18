import fixture from '../src/fixtures/dorian-16bars.json';
import { generate } from '../src/generation/generate.ts';
import { guardTrackNotes } from '../src/generation/monophony.ts';
import { cloneProject } from '../src/shared/schema/factory.ts';
import { validateProject } from '../src/shared/schema/validate.ts';
const v = validateProject(fixture);
const p = cloneProject(v.project);
const tracks = generate(p, { seed: 6, density: 0.75, humanize: false, lockedTrackIds: [] });
const worst = (notes) => {
  let w = 0;
  for (const note of notes) {
    const c = notes.filter(o => o.startTick < note.startTick + note.durationTicks && note.startTick < o.startTick + o.durationTicks).length;
    w = Math.max(w, c);
  }
  return w;
};
for (const role of ['violins1', 'flutes']) {
  const t = tracks.find(x => x.role === role);
  const r = guardTrackNotes(t.id, t.role, t.notes);
  console.log(role, 'before worst', worst(t.notes), '→ after worst', worst(r.notes));
}
