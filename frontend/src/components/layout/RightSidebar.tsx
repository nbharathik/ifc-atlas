import { useCallback, useRef } from 'react';
import { useStore, activeToolOf } from '../../store/useStore';
import type { RightTab } from '../../store/useStore';
import PropertiesPanel from '../panels/PropertiesPanel';
import ViewpointsPanel from '../panels/ViewpointsPanel';
import ActivityPanel from '../panels/ActivityPanel';
import FeatureLauncherPanel from '../panels/FeatureLauncherPanel';
import ChatPanel from '../chat/ChatPanel';
import ResizeHandle from './ResizeHandle';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import type { IconName } from '../ui/Icon';

interface RightSidebarProps {
  onSaveViewpoint: (name: string) => void;
  onRestoreViewpoint: (id: string) => void;
}

interface TabSpec {
  id: RightTab;
  label: string;
  icon: IconName;
  shortcut: string;
  badge?: string;
}

/**
 * Right inspector panel. Uses horizontal tabs at the top (icon + label)
 * so it's immediately obvious what each tab opens. Below the tab bar,
 * the active panel fills the rest of the sidebar and scrolls internally
 * for long property lists.
 *
 * The ResizeHandle on the left edge lets users widen the sidebar for
 * long property values (widths are localStorage-persisted).
 */
export default function RightSidebar({
  onSaveViewpoint,
  onRestoreViewpoint,
}: RightSidebarProps) {
  const activeTab = useStore((s) => s.rightActiveTab);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const setRightSidebarOpen = useStore((s) => s.setRightSidebarOpen);
  const expanded = useStore((s) => s.rightSidebarExpanded);

  // Horizontal scroll fallback - by default the browser's mousewheel only
  // scrolls vertically, which is invisible on a `overflow-x: auto` row.
  // Map vertical wheel delta to horizontal scroll so users can reach all tabs
  // with a plain mousewheel. Touchpads already send a horizontal deltaX, so
  // we only intercept when deltaY dominates.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const absY = Math.abs(e.deltaY);
    const absX = Math.abs(e.deltaX);
    if (absY > absX) {
      // Using deltaY as horizontal scroll distance. Don't preventDefault:
      // that can fight with native scroll chaining on touchpads.
      el.scrollLeft += e.deltaY;
    }
  }, []);
  const toggleExpanded = useStore((s) => s.toggleRightSidebarExpanded);

  const viewpointsCount = useStore((s) => s.viewpoints.length);
  const chatLoading = useStore((s) => s.chatLoading);
  const activityCount = useStore((s) => s.activity.length);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const anyToolOpen = useStore((s) => activeToolOf(s) != null);

  const tabs: TabSpec[] = [
    {
      id: 'props', label: 'Properties', icon: 'info', shortcut: 'P',
      badge: selectedElementId != null ? `#${selectedElementId}` : undefined,
    },
    // AI chat needs the backend - absent from the static viewer-only build.
    ...(BROWSER_ONLY ? [] : [{
      id: 'chat', label: 'AI Chat', icon: 'sparkle', shortcut: 'C',
      badge: chatLoading ? '•' : undefined,
    } satisfies TabSpec]),
    // Tools launcher (QTO / IDS / BCF / Plugins + model panels). Present in
    // every build - the viewer-only demo keeps the client-side tools (Model
    // statistics); the backend-driven ones are filtered out inside the panel.
    {
      id: 'tools', label: 'Tools', icon: 'wrench', shortcut: '',
      badge: anyToolOpen ? '•' : undefined,
    },
    {
      id: 'views', label: 'Viewpoints', icon: 'camera', shortcut: 'B',
      badge: viewpointsCount > 0 ? String(viewpointsCount) : undefined,
    },
    {
      id: 'log', label: 'Activity', icon: 'activity', shortcut: 'L',
      badge: activityCount > 0 ? (activityCount > 99 ? '99+' : String(activityCount)) : undefined,
    },
  ];

  const renderActive = () => {
    switch (activeTab) {
      case 'props': return <PropertiesPanel embedded />;
      case 'views':
        return (
          <ViewpointsPanel
            embedded
            onSaveViewpoint={onSaveViewpoint}
            onRestoreViewpoint={onRestoreViewpoint}
          />
        );
      case 'log': return <ActivityPanel embedded />;
      case 'chat': return BROWSER_ONLY ? <PropertiesPanel embedded /> : <ChatPanel embedded />;
      case 'tools': return <FeatureLauncherPanel />;
    }
  };

  return (
    <aside
      className={`right-sidebar right-sidebar-vertical ${expanded ? 'right-sidebar-expanded' : ''}`}
      aria-label="Inspector sidebar"
    >
      {!expanded && (
        <ResizeHandle
          side="right"
          storageKey="pref.w.inspector"
          cssVar="--w-inspector"
          defaultWidth={288}
          min={240}
          max={640}
        />
      )}
      <nav className="itabs" aria-label="Inspector tabs" role="tablist">
        <div
          className="itabs-scroll"
          ref={scrollRef}
          onWheel={onWheel}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`itab ${t.id === activeTab ? 'active' : ''}`}
              onClick={() => focusRightTab(t.id)}
              title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
              role="tab"
              aria-selected={t.id === activeTab}
            >
              <span className="itab-icon"><Icon name={t.icon} size={12} /></span>
              <span className="itab-label">{t.label}</span>
              {t.badge && <span className="itab-badge">{t.badge}</span>}
            </button>
          ))}
        </div>
        <button
          className="itabs-action"
          title={expanded ? 'Collapse panel' : 'Expand panel to full width'}
          onClick={toggleExpanded}
          aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
        >
          <Icon name={expanded ? 'minimize' : 'maximize'} size={11} />
        </button>
        <button
          className="itabs-action"
          title="Hide inspector"
          onClick={() => setRightSidebarOpen(false)}
          aria-label="Hide inspector"
        >
          <Icon name="x" size={11} />
        </button>
      </nav>
      <div className="right-tab-body">
        {renderActive()}
      </div>
    </aside>
  );
}
