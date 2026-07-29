import { Suspense, lazy } from 'react';

import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';

// Lazy so the markdown pipeline and chat transport stay off the model-open path.
const ChatPanel = lazy(() => import('../chat/ChatPanel'));

/**
 * The minimised "Ask AI" pill. Split out from the expanded dock below so it can
 * sit as a flex child of the bottom-right row (next to ViewerResetControl),
 * while the dock stays absolutely positioned against the viewer. Rendering both
 * from one component would force the dock to anchor to the row instead.
 */
export function FloatingChatPill() {
  const chatLoading = useStore((s) => s.chatLoading);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightActiveTab = useStore((s) => s.rightActiveTab);
  const minimized = useStore((s) => s.floatingChatMinimized);
  const setMinimized = useStore((s) => s.setFloatingChatMinimized);

  const sidebarChatActive = rightSidebarOpen && rightActiveTab === 'chat';
  if (sidebarChatActive || !minimized) return null;

  return (
    <button
      className="floating-chat-pill"
      onClick={() => setMinimized(false)}
      title="Open AI chat  Ctrl+/"
      aria-label="Open AI chat"
    >
      <Icon name="sparkle" size={13} />
      <span className="floating-chat-pill-label">Ask AI</span>
      <kbd className="floating-chat-pill-kbd">Ctrl /</kbd>
      {chatLoading && <span className="floating-chat-pill-dot" aria-hidden="true" />}
    </button>
  );
}

export default function FloatingChatDock() {
  const chatProvider = useStore((s) => s.chatProvider);
  const chatModel = useStore((s) => s.chatModel);
  const clearChat = useStore((s) => s.clearChat);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightActiveTab = useStore((s) => s.rightActiveTab);
  const minimized = useStore((s) => s.floatingChatMinimized);
  const setMinimized = useStore((s) => s.setFloatingChatMinimized);

  const sidebarChatActive = rightSidebarOpen && rightActiveTab === 'chat';
  if (sidebarChatActive || minimized) return null;

  const providerLabel = chatProvider === 'openai' ? 'GPT' : 'Claude';
  const modelLabel = chatModel.replace(/^claude-/, '').replace(/-(\d{8})$/, '');

  return (
    <div className="floating-chat-dock" role="dialog" aria-label="AI assistant">
      <div className="floating-chat-head">
        <Icon name="sparkle" size={13} />
        <span className="floating-chat-title">AI Assistant</span>
        <div className="floating-chat-head-spacer" />
        <span className="floating-chat-model" title={chatModel}>
          {providerLabel} · {modelLabel}
        </span>
        <button
          className="floating-chat-head-btn"
          onClick={() => clearChat()}
          title="Clear chat history"
          aria-label="Clear chat history"
        >
          <Icon name="trash" size={11} />
        </button>
        <button
          className="floating-chat-head-btn"
          onClick={() => focusRightTab('chat')}
          title="Dock to sidebar"
          aria-label="Dock to right sidebar"
        >
          <Icon name="panel-right-open" size={11} />
        </button>
        <button
          className="floating-chat-head-btn"
          onClick={() => setMinimized(true)}
          title="Minimize"
          aria-label="Minimize chat"
        >
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="floating-chat-body">
        <Suspense fallback={null}>
          <ChatPanel embedded />
        </Suspense>
      </div>
    </div>
  );
}
