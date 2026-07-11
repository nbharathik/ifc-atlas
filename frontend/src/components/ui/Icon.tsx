/**
 * Hand-rolled lucide-style icon set.
 *
 * These are inlined SVGs with a uniform 24x24 viewBox, 2-unit stroke,
 * `currentColor` fills/strokes so they inherit from the parent. When the
 * UI-improvement plan reaches Phase C we'll swap this module for
 * `lucide-react` without changing any call sites -- the <Icon name=.. />
 * API deliberately mirrors lucide's naming.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'box'
  | 'panel-left-open'
  | 'panel-left-close'
  | 'panel-right-open'
  | 'panel-right-close'
  | 'layers'
  | 'search'
  | 'info'
  | 'bookmark'
  | 'clipboard-list'
  | 'message-square'
  | 'command'
  | 'sun'
  | 'moon'
  | 'settings'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'plus'
  | 'x'
  | 'external-link'
  | 'maximize'
  | 'minimize'
  | 'check'
  | 'zap'
  | 'eye'
  | 'eye-off'
  | 'box-select'
  | 'camera'
  | 'trash'
  | 'pencil'
  | 'focus'
  | 'crop'
  | 'cursor'
  | 'hand'
  | 'orbit'
  | 'ruler'
  | 'section'
  | 'magnet'
  | 'clip'
  | 'home'
  | 'sparkle'
  | 'send'
  | 'cube'
  | 'activity'
  | 'refresh'
  | 'undo'
  | 'redo'
  | 'folder'
  | 'file'
  | 'column'
  | 'beam'
  | 'wall'
  | 'door'
  | 'stair'
  | 'slab'
  | 'zoom'
  | 'target'
  | 'tag'
  | 'chevron-up'
  | 'grid-3x3'
  | 'columns'
  | 'square'
  | 'list-checks'
  | 'bot'
  | 'cpu'
  | 'lock'
  | 'sliders'
  | 'file-text'
  | 'layout-dashboard'
  | 'wrench'
  | 'shield'
  | 'terminal'
  | 'plug'
  | 'bar-chart'
  | 'upload'
  | 'alert-circle'
  | 'loader'
  | 'inbox'
  | 'ghost'
  | 'brain'
  | 'more-horizontal';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

// Each path is expressed as JSX so the set remains tree-shakeable if we
// split it later. Paths were authored with the same visual rules lucide
// uses: 24x24 grid, 2-unit stroke, round linecaps/joins.
const PATHS: Record<IconName, React.ReactNode> = {
  // Dashed wireframe cube, represents AABB section box
  'box': (
    <>
      <path d="M12 2 3 7v10l9 5 9-5V7Z" strokeDasharray="3 2" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 12v10" strokeDasharray="3 2" />
    </>
  ),
  'panel-left-open': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </>
  ),
  'panel-left-close': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </>
  ),
  'panel-right-open': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
      <path d="m10 15-3-3 3-3" />
    </>
  ),
  'panel-right-close': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
      <path d="m8 9 3 3-3 3" />
    </>
  ),
  'layers': (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 17 9 5 9-5" />
      <path d="m3 12 9 5 9-5" />
    </>
  ),
  'search': (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  'info': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  'bookmark': (
    <>
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
    </>
  ),
  'clipboard-list': (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </>
  ),
  'message-square': (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </>
  ),
  'command': (
    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z" />
  ),
  'sun': (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  'moon': (
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  ),
  'settings': (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'plus': (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  'x': (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  'external-link': (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  'maximize': (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    </>
  ),
  'minimize': (
    <>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </>
  ),
  'check': <path d="M20 6 9 17l-5-5" />,
  'zap': (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14Z" />
  ),
  'eye': (
    <>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
    </>
  ),
  'box-select': (
    <>
      <path d="M5 3a2 2 0 0 0-2 2" />
      <path d="M19 3a2 2 0 0 1 2 2" />
      <path d="M21 19a2 2 0 0 1-2 2" />
      <path d="M5 21a2 2 0 0 1-2-2" />
      <path d="M9 3h1" />
      <path d="M9 21h1" />
      <path d="M14 3h1" />
      <path d="M14 21h1" />
      <path d="M3 9v1" />
      <path d="M21 9v1" />
      <path d="M3 14v1" />
      <path d="M21 14v1" />
    </>
  ),
  'camera': (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  'trash': (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  'pencil': (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  // Crosshair / zoom-to-element target
  'focus': (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
    </>
  ),
  // Crop / isolate-just-this
  'crop': (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  // Mouse / select tool cursor
  'cursor': (
    <path d="m4 4 7.07 17 2.51-7.39L21 11.07Z" />
  ),
  // Pan / hand move tool
  'hand': (
    <>
      <path d="M12 2v14" />
      <path d="M2 12h20" />
      <path d="m7 7-5 5 5 5" />
      <path d="m17 7 5 5-5 5" />
    </>
  ),
  // Orbit (two overlapping ellipses)
  'orbit': (
    <>
      <ellipse cx="12" cy="12" rx="10" ry="4.5" />
      <ellipse cx="12" cy="12" rx="4.5" ry="10" />
    </>
  ),
  // Ruler / measure
  'ruler': (
    <>
      <path d="M3 15 15 3l6 6L9 21Z" />
      <path d="m5 13 2 2" />
      <path d="m8 10 2 2" />
      <path d="m11 7 2 2" />
    </>
  ),
  // Section plane
  'section': (
    <>
      <path d="M3 14 12 3l9 11-9 5Z" />
      <path d="M3 14l9 5 9-5" strokeDasharray="2 2" />
    </>
  ),
  // Magnet / snap
  'magnet': (
    <>
      <path d="M4 4v7a8 8 0 0 0 16 0V4h-4v7a4 4 0 0 1-8 0V4Z" />
      <path d="M4 4h4" />
      <path d="M16 4h4" />
    </>
  ),
  // Clip / paperclip
  'clip': (
    <path d="M9 3v14a3 3 0 0 0 6 0V6a1.5 1.5 0 0 0-3 0v11a.5.5 0 0 0 1 0V6" />
  ),
  // Home
  'home': (
    <>
      <path d="m3 11 9-8 9 8v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M9 22V12h6v10" />
    </>
  ),
  // Sparkle (4-point star)
  'sparkle': (
    <path d="M12 3 13.8 8.8 19.5 11 13.8 13.2 12 19 10.2 13.2 4.5 11 10.2 8.8Z" />
  ),
  // Send (paper plane)
  'send': (
    <>
      <path d="m22 2-10.5 19L10 12 2 10.5Z" />
      <path d="M22 2 10 12" />
    </>
  ),
  // Cube / 3D
  'cube': (
    <>
      <path d="M12 2 3 7v10l9 5 9-5V7Z" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 12v10" />
    </>
  ),
  // Activity / signal
  'activity': (
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  ),
  // Refresh
  'refresh': (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </>
  ),
  // Undo / redo (lucide undo-2 / redo-2)
  'undo': (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </>
  ),
  'redo': (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
    </>
  ),
  // Folder
  'folder': (
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
  // File
  'file': (
    <>
      <path d="M4 3h10l6 6v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v6h6" />
    </>
  ),
  // IFC primitives (stylised)
  'column': (
    <>
      <rect x="8" y="3" width="8" height="18" />
      <path d="M6 3v18M18 3v18" />
    </>
  ),
  'beam': <rect x="2" y="9" width="20" height="6" />,
  'wall': (
    <>
      <rect x="2" y="3" width="20" height="18" />
      <path d="M2 9h20M2 15h20M7 3v6M15 9v6M7 15v6M15 3v3M4 3v3M18 3v3" />
    </>
  ),
  'door': (
    <>
      <path d="M4 21V3h12v18" />
      <path d="M4 21h14" />
      <circle cx="13" cy="12" r="1" />
    </>
  ),
  'stair': (
    <path d="M3 21h5v-4h4v-4h4V9h4V5" />
  ),
  'slab': (
    <>
      <path d="M3 14l9-4 9 4-9 4Z" />
      <path d="M3 14v3M21 14v3M12 18v3" />
    </>
  ),
  // Magnifying glass with + / zoom
  'zoom': (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6M11 8v6" />
    </>
  ),
  // Target / crosshair (viewport frame action)
  'target': (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>
  ),
  // Tag / classification label
  'tag': (
    <path d="M12 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Zm-1 11H8m5-4H8" />
  ),
  // Chevron up
  'chevron-up': <path d="m18 15-6-6-6 6" />,
  // Grid 3x3 - lucide's standard grid glyph
  'grid-3x3': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </>
  ),
  'columns': (
    <>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="18" rx="1" />
    </>
  ),
  'square': (
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
  ),
  'list-checks': (
    <>
      <path d="M11 12H3" />
      <path d="M16 6H3" />
      <path d="M16 18H3" />
      <path d="M21 6l-5 5 1.5 1.5" />
      <path d="M21 12l-5 5 1.5 1.5" />
    </>
  ),
  // Bot / robot agent face
  'bot': (
    <>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" strokeWidth="3" strokeLinecap="round" />
      <line x1="16" y1="16" x2="16" y2="16" strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  // CPU / chip
  'cpu': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </>
  ),
  // Lock
  'lock': (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  // Sliders (horizontal)
  'sliders': (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  // File with text lines
  'file-text': (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </>
  ),
  // Layout dashboard (grid overview)
  'layout-dashboard': (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  // Wrench (tools)
  'wrench': (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  // Shield (security / validation)
  'shield': (
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  ),
  // Terminal / code
  'terminal': (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  // Plug (integrations / MCP)
  'plug': (
    <>
      <path d="M12 22v-5" />
      <path d="M9 7V2" />
      <path d="M15 7V2" />
      <path d="M6 13v-2a6 6 0 0 1 12 0v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" />
    </>
  ),
  // Bar chart (quantities / analysis)
  'bar-chart': (
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ),
  'upload': (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  'loader': (
    <>
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
    </>
  ),
  'inbox': (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  'ghost': (
    <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
  ),
  'brain': (
    <>
      <path d="M9.5 2a2.5 2.5 0 0 1 5 0" />
      <path d="M12 2v20" />
      <path d="M9.5 2C6.46 2 4 4.46 4 7.5c0 1.74.8 3.29 2.05 4.32A4.5 4.5 0 0 0 9.5 20" />
      <path d="M14.5 2C17.54 2 20 4.46 20 7.5c0 1.74-.8 3.29-2.05 4.32A4.5 4.5 0 0 1 14.5 20" />
    </>
  ),
  'more-horizontal': (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
};

export default function Icon({ name, size = 16, strokeWidth = 2, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
