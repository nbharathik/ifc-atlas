import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Stable label for console diagnostics ("ViewerPanel", "ContextMenu" etc.). */
  label: string;
  children: ReactNode;
  /** Optional fallback override. Passing `null` deliberately keeps recovery silent. */
  fallback?: ReactNode;
  /** Optional escape hatch for model-level failures. */
  onOpenAnother?: () => void;
}

interface State {
  err: Error | null;
  componentStack: string;
  copyStatus: 'idle' | 'copied' | 'failed';
}

export interface ErrorDiagnosticEnvironment {
  url?: string;
  userAgent?: string;
  timestamp?: string;
}

/** Stable text payload suitable for support tickets and clipboard export. */
export function formatErrorDiagnostics(
  label: string,
  error: Error,
  componentStack = '',
  environment: ErrorDiagnosticEnvironment = {},
): string {
  return [
    `IFC Atlas component: ${label}`,
    `Time: ${environment.timestamp ?? new Date().toISOString()}`,
    environment.url ? `URL: ${environment.url}` : '',
    environment.userAgent ? `User agent: ${environment.userAgent}` : '',
    `Error: ${error.name}: ${error.message}`,
    error.stack ? `Stack:\n${error.stack}` : '',
    componentStack.trim() ? `React component stack:\n${componentStack.trim()}` : '',
  ].filter(Boolean).join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, componentStack: '', copyStatus: 'idle' };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err, copyStatus: 'idle' };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label}]`, err, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  reset = () => this.setState({ err: null, componentStack: '', copyStatus: 'idle' });

  copyDiagnostics = async () => {
    const { err, componentStack } = this.state;
    if (!err) return;
    const diagnostics = formatErrorDiagnostics(this.props.label, err, componentStack, {
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });
    const copied = await copyText(diagnostics);
    this.setState({ copyStatus: copied ? 'copied' : 'failed' });
  };

  openAnother = () => {
    this.reset();
    this.props.onOpenAnother?.();
  };

  render() {
    const { err, copyStatus } = this.state;
    if (!err) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <section className="error-boundary-fallback" role="alert" aria-live="assertive" aria-atomic="true">
        <span className="error-boundary-eyebrow">Viewer recovery</span>
        <h2>{this.props.label} stopped unexpectedly</h2>
        <p>The model session is still available. Retry this view or copy diagnostics for support.</p>
        <details className="error-boundary-details">
          <summary>Technical details</summary>
          <code>{err.name}: {err.message}</code>
        </details>
        <div className="error-boundary-actions">
          <button type="button" className="error-boundary-primary" onClick={this.reset}>Retry view</button>
          {this.props.onOpenAnother && (
            <button type="button" onClick={this.openAnother}>Open another model</button>
          )}
          <button type="button" onClick={() => { void this.copyDiagnostics(); }}>
            {copyStatus === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics'}
          </button>
        </div>
        {copyStatus === 'failed' && (
          <span className="error-boundary-copy-error">Clipboard access failed. Expand technical details to copy the message manually.</span>
        )}
      </section>
    );
  }
}

export default ErrorBoundary;
