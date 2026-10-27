import { Navigate, Outlet, useLocation } from 'react-router';
import { Alert, Button, Spinner } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';

function SessionCheckFailed({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <Alert>
        Could not check your session: {errorMessage(error)} The server may be starting up; this can
        take up to a minute after a period of inactivity.
      </Alert>
      <Button className="mt-4" onClick={retry}>
        Try again
      </Button>
    </main>
  );
}

/** Renders child routes only for a signed-in user; otherwise redirects to /login. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (me.isError) return <SessionCheckFailed error={me.error} retry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Sends already-signed-in users away from /login and /register. */
export function RedirectIfAuthenticated() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}
