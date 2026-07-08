import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Stable label for console diagnostics ("ViewerPanel", "ContextMenu" …). */
  label: string;
  children: ReactNode;
  /** Optional fallback override. Default = silent recovery (renders null). */
  fallback?: ReactNode;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label}]`, err, info.componentStack);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return null;
  }
}

export default ErrorBoundary;
