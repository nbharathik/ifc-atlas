interface AccentPreset {
  id: string;
  label: string;
  acc: string;
  hi: string;
  dim: string;
  bord: string;
  glow: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'blue',    label: 'Blue',    acc: '#0070f3', hi: '#3291ff', dim: 'rgba(0,112,243,0.12)',  bord: 'rgba(0,112,243,0.38)',  glow: 'rgba(0,112,243,0.26)'  },
  { id: 'teal',    label: 'Teal',    acc: '#4fb8d1', hi: '#72cde0', dim: 'rgba(79,184,209,0.14)', bord: 'rgba(79,184,209,0.38)', glow: 'rgba(79,184,209,0.26)' },
  { id: 'emerald', label: 'Emerald', acc: '#3ecf8e', hi: '#62dba6', dim: 'rgba(62,207,142,0.14)', bord: 'rgba(62,207,142,0.38)', glow: 'rgba(62,207,142,0.26)' },
  { id: 'amber',   label: 'Amber',   acc: '#CD9731', hi: '#e1ae55', dim: 'rgba(205,151,49,0.14)', bord: 'rgba(205,151,49,0.38)', glow: 'rgba(205,151,49,0.26)' },
  { id: 'neutral', label: 'Neutral', acc: '#ededed', hi: '#ffffff', dim: 'rgba(237,237,237,0.06)', bord: 'rgba(237,237,237,0.22)', glow: 'rgba(237,237,237,0.18)' },
];

export function applyAccentPreset(id: string) {
  const preset = ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty('--acc', preset.acc);
  root.style.setProperty('--acc-hi', preset.hi);
  root.style.setProperty('--acc-dim', preset.dim);
  root.style.setProperty('--acc-bord', preset.bord);
  root.style.setProperty('--acc-glow', preset.glow);
  root.style.setProperty('--accent', preset.acc);
  root.style.setProperty('--accent-hover', preset.hi);
  root.style.setProperty('--accent-dim', preset.dim);
}
