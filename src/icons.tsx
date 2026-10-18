import { Icon, type IconifyIcon } from "@iconify/react";

function stroke(d: string): IconifyIcon {
  return {
    body: `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`,
    width: 24,
    height: 24,
  };
}

function fill(d: string): IconifyIcon {
  return {
    body: `<path fill="currentColor" d="${d}"/>`,
    width: 24,
    height: 24,
  };
}

export const icons = {
  play: fill("M5 3.8v16.4c0 .9 1 1.5 1.8 1L20 13.7c.7-.5.7-1.6 0-2.1L6.8 2.8C6 2.3 5 2.9 5 3.8z"),
  stop: fill("M6 6h12v12H6z"),
  rewind: stroke("M19 20L9 12l10-8M5 19V5"),
  record: fill("M12 5a7 7 0 100 14 7 7 0 000-14z"),
  loop: stroke("M17 2l4 4-4 4M21 6H9a6 6 0 000 12h2M7 22l-4-4 4-4M3 18h12a6 6 0 000-12h-2"),
  metronome: stroke("M12 3v4M8 21h8M9.5 7.5L6 21M14.5 7.5L18 21M9 14h6"),
  lock: stroke("M8 11V8a4 4 0 118 0v3M7 11h10v9H7z"),
  unlock: stroke("M8 11V8a4 4 0 017.5-2M7 11h10v9H7z"),
  mute: stroke("M4 10v4h4l5 4V6L8 10H4zM22 10l-6 6M16 10l6 6"),
  speaker: stroke("M4 10v4h4l5 4V6L8 10H4zM18 8a5 5 0 010 8"),
  solo: stroke("M4 14v-1a8 8 0 0116 0v1M4 14a2 2 0 104 0 2 2 0 00-4 0zm12 0a2 2 0 104 0 2 2 0 00-4 0z"),
  plug: stroke("M9 7v4M15 7v4M8 11h8v3a4 4 0 01-8 0v-3zM12 18v3M7 3h10"),
  plus: stroke("M12 5v14M5 12h14"),
  sparkle: stroke("M12 3v4M12 17v4M4.9 6.5l2.8 2.8M16.3 14.7l2.8 2.8M3 12h4M17 12h4M4.9 17.5l2.8-2.8M16.3 9.3l2.8-2.8"),
  download: stroke("M12 4v12M7 11l5 5 5-5M5 20h14"),
  upload: stroke("M12 20V8M7 13l5-5 5 5M5 4h14"),
  search: stroke("M11 5a6 6 0 100 12 6 6 0 000-12zM21 21l-4.3-4.3"),
  x: stroke("M6 6l12 12M18 6L6 18"),
  gear: stroke("M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"),
  dice: stroke("M5 5h14v14H5zM9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"),
  flask: stroke("M9 3h6M10 3v6L5 18a2 2 0 002 3h10a2 2 0 002-3l-5-9V3M8.5 14h7"),
  info: stroke("M12 11v6M12 7h.01M12 3a9 9 0 100 18 9 9 0 000-18z"),
  piano: stroke("M4 6h16v12H4zM8 6v8M12 6v8M16 6v8M8 14h.01M12 14h.01M16 14h.01"),
  caret: stroke("M7 10l5 5 5-5"),
  trash: stroke("M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"),
  folder: stroke("M3 7h6l2 2h10v10H3z"),
  warning: stroke("M12 9v5M12 17h.01M10.3 4.7L2.8 18a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.7a2 2 0 00-3.4 0z"),
  check: stroke("M5 12l5 5 9-10"),
  snow: stroke("M12 3v18M5 7l14 10M19 7L5 17M4 12h16"),
  music: stroke("M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zm10-2a3 3 0 11-6 0 3 3 0 016 0z"),
  wand: stroke("M4 20L16 8M14.5 6.5l3 3M16 4l.5 2.5L19 7l-2.5.5L16 10l-.5-2.5L13 7l2.5-.5z"),
} as const;

export type IconName = keyof typeof icons;

export function Ph({
  name,
  className,
  title,
}: {
  name: IconName;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className="inline-flex">
      <Icon icon={icons[name]} className={className} />
    </span>
  );
}
