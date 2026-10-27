import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Link, RouterProvider } from 'react-router';
import { AppLayout } from './pages/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { RegisterPage } from './pages/RegisterPage';
import { StatusPage } from './pages/StatusPage';
import { RedirectIfAuthenticated, RequireAuth } from './routes/guards';

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
        children: [{ index: true, element: <OverviewPage /> }],
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
