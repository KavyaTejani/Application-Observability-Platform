import { loginSchema, toFieldErrors, type FieldErrors } from '@aop/validation';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, TextField } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { useLogin } from '../lib/auth';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [fields, setFields] = useState<FieldErrors>({});

  // Return to the page that required sign-in. Only same-app paths are honoured (no open redirect).
  const from = (location.state as { from?: string } | null)?.from;
  const destination = from?.startsWith('/') && !from.startsWith('//') ? from : '/';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = loginSchema.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    });
    if (!parsed.success) {
      setFields(toFieldErrors(parsed.error));
      return;
    }
    setFields({});
    login.mutate(parsed.data, {
      onSuccess: () => navigate(destination, { replace: true }),
      onError: (error) => error instanceof ApiError && setFields(error.fieldErrors),
    });
  };

  return (
    <AuthLayout title="Sign in">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {login.isError && <Alert>{errorMessage(login.error)}</Alert>}
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          error={fields.email}
          required
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          error={fields.password}
          required
        />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        No account?{' '}
        <Link to="/register" className="font-medium text-slate-900 underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
