import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Link
          to="/"
          className="block text-center text-sm font-semibold tracking-wide text-slate-500"
        >
          APPLICATION OBSERVABILITY PLATFORM
        </Link>
        <h1 className="mt-4 text-center text-2xl font-semibold text-slate-900">{title}</h1>
        <div className="mt-8 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
