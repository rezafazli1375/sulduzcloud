import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface the failure in the console for support/debugging.
    console.error('[panel] unhandled render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card w-full max-w-md p-7 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-300">
            <AlertTriangle className="h-6 w-6" />
          </span>
          <h1 className="mt-5 text-base font-semibold text-white">Something went wrong</h1>
          <p className="mt-2 text-[12px] leading-6 text-slate-400">
            An unexpected error occurred while rendering the panel.
            <br />
            Reload the page to continue.
          </p>
          <pre dir="ltr" className="mt-4 max-h-32 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 text-start font-mono text-[10px] leading-5 text-rose-200/70">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button type="button" className="btn btn-primary mt-5 inline-flex" onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
