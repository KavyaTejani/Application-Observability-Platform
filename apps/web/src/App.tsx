import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, RouterProvider } from 'react-router';
import { AppLayout } from './pages/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProjectLayout, ProjectSettingsPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RegisterPage } from './pages/RegisterPage';
import { StatusPage } from './pages/StatusPage';
import { RedirectIfAuthenticated, RequireAuth } from './routes/guards';
import { Spinner } from './components/ui';

// The dashboard pulls in the charting library; load it only when a dashboard is opened. Other
// secondary pages are split out too, so the first load stays small.
const ProjectDashboardPage = lazy(() =>
  import('./pages/ProjectDashboardPage').then((m) => ({ default: m.ProjectDashboardPage })),
);
const LogsPage = lazy(() => import('./pages/LogsPage').then((m) => ({ default: m.LogsPage })));
const AlertsPage = lazy(() =>
  import('./pages/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);
const IncidentPage = lazy(() =>
  import('./pages/IncidentPage').then((m) => ({ default: m.IncidentPage })),
);
const UsagePage = lazy(() => import('./pages/UsagePage').then((m) => ({ default: m.UsagePage })));
const OperatorPage = lazy(() =>
  import('./pages/OperatorPage').then((m) => ({ default: m.OperatorPage })),
);

const page = (element: ReactNode, label = 'Loading…') => (
  <Suspense fallback={<Spinner label={label} />}>{element}</Suspense>
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function NotFoundPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link to="/" className="mt-4 inline-block text-sm underline">
        Go to the app
      </Link>
    </main>
  );
}

const router = createBrowserRouter([
  { path: '/status', element: <StatusPage /> },
  // Operator access is a deployment token, not a customer session (PRD §12.8).
  { path: '/operator', element: page(<OperatorPage />) },
  {
    element: <RedirectIfAuthenticated />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      // `/` resolves to the user's first organization inside AppLayout.
      { path: '/', element: <AppLayout /> },
      {
        path: '/orgs/:organizationId',
        element: <AppLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'usage', element: page(<UsagePage />) },
          {
            path: 'projects/:projectId',
            element: <ProjectLayout />,
            children: [
              {
                index: true,
                element: page(<ProjectDashboardPage />, 'Loading dashboard…'),
              },
              { path: 'logs', element: page(<LogsPage />) },
              { path: 'alerts', element: page(<AlertsPage />) },
              { path: 'alerts/incidents/:incidentId', element: page(<IncidentPage />) },
              { path: 'settings', element: <ProjectSettingsPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
