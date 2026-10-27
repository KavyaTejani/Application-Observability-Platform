import {
  PASSWORD_MIN_LENGTH,
  registerSchema,
  toFieldErrors,
  type FieldErrors,
} from '@aop/validation';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, TextField } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { useRegister } from '../lib/auth';
import { AuthLayout } from './AuthLayout';

export function RegisterPage() {
  const register = useRegister();
  const navigate = useNavigate();
  const [fields, setFields] = useState<FieldErrors>({});

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const organizationName = String(form.get('organizationName') ?? '').trim();
    const parsed = registerSchema.safeParse({
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      organizationName: organizationName || undefined,
    });
    if (!parsed.success) {
      setFields(toFieldErrors(parsed.error));
      return;
    }
    setFields({});
    register.mutate(parsed.data, {
      onSuccess: () => navigate('/', { replace: true }),
      onError: (error) => error instanceof ApiError && setFields(error.fieldErrors),
    });
  };

  // Field-level errors are shown under each input; the banner covers everything else.
  const bannerError =
    register.isError &&
    !(register.error instanceof ApiError && Object.keys(register.error.fieldErrors).length > 0);

  return (
    <AuthLayout title="Create your account">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {bannerError && <Alert>{errorMessage(register.error)}</Alert>}
        <TextField label="Name" name="name" autoComplete="name" error={fields.name} required />
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
          autoComplete="new-password"
          error={fields.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
          required
        />
        <TextField
          label="Organization name (optional)"
          name="organizationName"
          autoComplete="organization"
          error={fields.organizationName}
          hint="You can invite teammates to it later."
        />
        <Button type="submit" className="w-full" disabled={register.isPending}>
          {register.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-slate-900 underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
