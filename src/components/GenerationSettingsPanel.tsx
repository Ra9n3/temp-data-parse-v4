import type { HumanizationSettings, OrchestrationSettings, ProjectGenerationSettings } from "../shared/schema/types";

const inputClass = "rounded bg-black/40 px-2 py-1 text-xs text-stone-100 ring-1 ring-white/10";
const groups = ["woodwinds", "brass", "strings", "percussion", "rhythm"] as const;

export function GenerationSettingsPanel({ settings, onChange, onClose }: {
  settings: ProjectGenerationSettings;
  onChange: (settings: ProjectGenerationSettings) => void;
  onClose: () => void;
}) {
  const setOrchestration = (patch: Partial<OrchestrationSettings>) => onChange({ ...settings, orchestration: { ...settings.orchestration, ...patch } });
  const setHumanization = (patch: Partial<HumanizationSettings>) => onChange({ ...settings, humanization: { ...settings.humanization, ...patch } });
  const selectClass = inputClass + " w-full";
  const range = (label: string, key: "intensity" | "rubato" | "intonationCents", max: number, unit: string) => (
    <label className="block text-xs text-stone-300">{label}: {settings.humanization[key]}{unit}
      <input aria-label={label} type="range" min={0} max={max} value={settings.humanization[key]} className="mt-1 w-full accent-orange-400"
        onChange={(event) => setHumanization({ [key]: Number(event.target.value) })} />
    </label>
  );
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-4" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Orchestral configuration and humanization" className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border border-white/10 bg-[#151821] p-5 text-stone-100 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <header className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Orchestral Configuration & Voicing</h2><p className="text-xs text-stone-500">Settings are stored with this project and used when composing.</p></div><button type="button" aria-label="Close settings" className="rounded px-2 py-1 text-stone-400 hover:bg-white/10" onClick={onClose}>✕</button></header>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-white/10 p-3"><h3 className="text-sm font-medium">Active instrument groups</h3>
            {groups.map((group) => <label key={group} className="flex items-center gap-2 text-xs capitalize"><input type="checkbox" checked={settings.orchestration.enabledGroups[group]} onChange={(event) => setOrchestration({ enabledGroups: { ...settings.orchestration.enabledGroups, [group]: event.target.checked } })} />{group === "rhythm" ? "Rhythm Section" : group}</label>)}
          </div>
          <div className="space-y-3 rounded-lg border border-white/10 p-3"><h3 className="text-sm font-medium">Section sizes</h3>
            <label className="block text-xs text-stone-400">Woodwinds<select aria-label="Woodwinds configuration" className={selectClass} value={settings.orchestration.woodwindsSize} onChange={(e) => setOrchestration({ woodwindsSize: e.target.value as OrchestrationSettings["woodwindsSize"] })}>{["Pairs", "Threes + Auxiliaries", "Chamber Ensemble"].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="block text-xs text-stone-400">Brass<select aria-label="Brass configuration" className={selectClass} value={settings.orchestration.brassSize} onChange={(e) => setOrchestration({ brassSize: e.target.value as OrchestrationSettings["brassSize"] })}>{["Standard", "Cinematic Double Brass"].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="block text-xs text-stone-400">Strings<select aria-label="Strings configuration" className={selectClass} value={settings.orchestration.stringsSize} onChange={(e) => setOrchestration({ stringsSize: e.target.value as OrchestrationSettings["stringsSize"] })}>{["Full Symphonic (16/14/12/10/8)", "Medium Studio", "Chamber"].map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <div className="space-y-2 rounded-lg border border-white/10 p-3"><h3 className="text-sm font-medium">Chord voicing</h3><select aria-label="Chord voicing style" className={selectClass} value={settings.orchestration.voicingStyle} onChange={(e) => setOrchestration({ voicingStyle: e.target.value as OrchestrationSettings["voicingStyle"] })}>{[["OVERTONE_SPREAD", "Overtone Auto-Spread (Default)"], ["DROP_2", "Drop-2"], ["SEMI_OPEN", "Semi-Open"], ["CLOSED", "Closed/Block"], ["OPEN_SPREAD", "Open/Spread"], ["CLUSTER", "Cluster"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="space-y-3 rounded-lg border border-white/10 p-3"><h3 className="text-sm font-medium">Humanization & realism</h3>
            {range("Humanize intensity", "intensity", 100, "%")}{range("Rubato / tempo flexibility", "rubato", 100, "%")}{range("Intonation / detuning spread", "intonationCents", 15, " cents")}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.humanization.latencyCompensation} onChange={(e) => setHumanization({ latencyCompensation: e.target.checked })} />Sample latency compensation</label>
            <label className="block text-xs text-stone-400">Default instrument attack compensation (ms)<input aria-label="Sample latency milliseconds" className={inputClass + " ml-2 w-20"} type="number" min={0} max={500} value={settings.humanization.latencyCompensationMs?.custom ?? 0} onChange={(e) => setHumanization({ latencyCompensationMs: { ...settings.humanization.latencyCompensationMs, custom: Math.max(0, Math.min(500, Number(e.target.value) || 0)) } })} /></label>
            {(["strings", "brass", "woodwinds", "percussion", "keys"] as const).map((family) => <label key={family} className="block text-xs capitalize text-stone-400">{family} attack compensation (ms)<input aria-label={`${family} latency milliseconds`} className={inputClass + " ml-2 w-20"} type="number" min={0} max={500} value={settings.humanization.latencyCompensationMs?.[family] ?? settings.humanization.latencyCompensationMs?.custom ?? 0} onChange={(e) => setHumanization({ latencyCompensationMs: { ...settings.humanization.latencyCompensationMs, [family]: Math.max(0, Math.min(500, Number(e.target.value) || 0)) } })} /></label>)}
          </div>
        </div>
      </section>
    </div>
  );
}
