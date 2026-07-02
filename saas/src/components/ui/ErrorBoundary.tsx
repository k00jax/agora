'use client';

import { Component, type ReactNode } from 'react';
import Link from 'next/link';

interface Props { children: ReactNode; }
interface State { hasError: boolean; errorMessage: string; }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center px-4 bg-[#0d0d1a]">
          <div className="text-center max-w-md">
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-400 mb-6">{this.state.errorMessage}</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
                className="px-5 py-2.5 rounded-xl bg-[#1a3a5c] hover:bg-[#22507a] font-semibold transition-colors"
              >
                Reload
              </button>
              <Link href="/chat" className="px-5 py-2.5 rounded-xl border border-gray-600 hover:border-gray-400 font-semibold transition-colors">
                Go to Chat
              </Link>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
