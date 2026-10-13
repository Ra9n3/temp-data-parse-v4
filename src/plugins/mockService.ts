export type PluginScanState = "not_scanned" | "scanning" | "empty" | "loaded";

export interface MockPlugin {
  id: string;
  rawName: string;
  failed: boolean;
}

export const MOCK_PLUGINS: MockPlugin[] = [
  { id: "bbcso-discover", rawName: "BBC Symphony Orchestra Discover.vst3", failed: false },
  { id: "bbcso-discover-64", rawName: "Spitfire BBCSO Discover (64-bit).vst3", failed: false },
  { id: "falcon", rawName: "UVI Falcon.vst3", failed: false },
  { id: "kontakt", rawName: "Kontakt 7 (64-bit).vst3", failed: false },
  { id: "css", rawName: "Cinematic Studio Strings.vst3", failed: false },
  { id: "cssb", rawName: "Cinematic Studio Brass.vst3", failed: false },
  { id: "play", rawName: "EastWest Play.vst3", failed: false },
  { id: "piano", rawName: "Keyscape.vst3", failed: false },
  { id: "broken", rawName: "Broken Plugin CrashTest.vst3", failed: true },
];

/** Strip .vst3 and 64-bit style suffixes from a display name. */
export function pluginDisplayName(raw: string): string {
  return raw
    .replace(/\.vst3$/i, "")
    .replace(/\(64-bit\)/gi, "")
    .replace(/\[64-bit\]/gi, "")
    .replace(/\b64-bit\b/gi, "")
    .replace(/\bx64\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const DEFAULT_SCAN_DIR = "C:\\Program Files\\Common Files\\VST3";
