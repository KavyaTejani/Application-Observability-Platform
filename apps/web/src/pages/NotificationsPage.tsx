import { createDestinationSchema, toFieldErrors, type FieldErrors } from '@aop/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router';
import { Alert, Button, Card, Spinner, TextField } from '../components/ui';
import { api, ApiError, errorMessage, hasFieldErrors } from '../lib/api';
import { destinationsKey, useDestinations, type Destination } from '../lib/alerts';
import type { OrganizationSummary } from '../lib/types';

/** Organization webhook destinations (PRD §12.7.1). Owners manage them; members can view. */
export function NotificationsPage() {
  const org = useOutletContext<OrganizationSummary>();
  const isOwner = org.role === 'owner';
  const destinations = useDestinations(org.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Notifications</h1>
        <p className="mt-1 text-sm text-slate-600">
          Webhook destinations receive a signed JSON payload when an incident fires or resolves.
        </p>
      </div>

      <Card title="Webhook destinations">
        {destinations.isPending && <Spinner />}
        {destinations.isError && <Alert>{errorMessage(destinations.error)}</Alert>}
        {destinations.data?.destinations.length === 0 && (
          <p className="text-sm text-slate-600">No destinations yet.</p>
        )}
        {destinations.data && destinations.data.destinations.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {destinations.data.destinations.map((d) => (
              <DestinationRow
                key={d.id}
                destination={d}
                organizationId={org.id}
                canManage={isOwner}
              />
            ))}
          </ul>
        )}
      </Card>

      {isOwner ? (
        <CreateDestinationForm organizationId={org.id} />
      ) : (
        <Alert tone="info">Only organization owners can add or change destinations.</Alert>
      )}

      <Card title="Verifying signatures">
        <p className="text-sm text-slate-700">
          Each request carries <code>X-AOP-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where{' '}
          <code>v1 = HMAC-SHA256(signingSecret, t + "." + rawBody)</code>. Recompute it with your
          secret, compare in constant time, and reject timestamps older than five minutes.
        </p>
      </Card>
    </div>
  );
}

function DestinationRow({
  destination,
  organizationId,
  canManage,
}: {
  destination: Destination;
  organizationId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: destinationsKey(organizationId) });
  const toggle = useMutation({
    mutationFn: () =>
      api(`/notification-destinations/${destination.id}`, {
        method: 'PATCH',
        body: { enabled: !destination.enabled },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/notification-destinations/${destination.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ result: { status: string; responseStatus?: number; errorSummary?: string } }>(
        `/notification-destinations/${destination.id}/test`,
        { method: 'POST' },
      ),
  });

  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{destination.name}</span>
        <code className="text-xs text-slate-600">{destination.urlPreview}</code>
        <span className="text-xs text-slate-500">
          {destination.enabled ? '● enabled' : '○ disabled'}
        </span>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? 'Sending…' : 'Send test'}
          </Button>
          <Button variant="secondary" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {destination.enabled ? 'Disable' : 'Enable'}
          </Button>
          {!confirm ? (
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          ) : (
            <>
              <Button onClick={() => remove.mutate()}>Confirm delete</Button>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
      {test.data && (
        <p
          className={`text-xs ${test.data.result.status === 'success' ? 'text-emerald-800' : 'text-red-700'}`}
        >
          Test: {test.data.result.status}
          {test.data.result.responseStatus ? ` (HTTP ${test.data.result.responseStatus})` : ''}
          {test.data.result.errorSummary ? ` · ${test.data.result.errorSummary}` : ''}
        </p>
      )}
      {(test.error ?? toggle.error ?? remove.error) && (
        <p className="text-xs text-red-700">
          {errorMessage(test.error ?? toggle.error ?? remove.error)}
        </p>
      )}
    </li>
  );
}

function CreateDestinationForm({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const [fields, setFields] = useState<FieldErrors>({});
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: { name: string; url: string }) =>
      api<{ destination: Destination; signingSecret: string }>(
        `/organizations/${organizationId}/notification-destinations`,
        {
          method: 'POST',
          body: input,
        },
      ),
    onSuccess: (data) => {
      setSecret(data.signingSecret);
      void qc.invalidateQueries({ queryKey: destinationsKey(organizationId) });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parsed = createDestinationSchema.safeParse({
      name: form.get('name'),
      url: form.get('url'),
    });
    if (!parsed.success) {
      setFields(toFieldErrors(parsed.error));
      return;
    }
    setFields({});
    create.mutate(parsed.data, {
      onSuccess: () => formElement.reset(),
      onError: (error) => error instanceof ApiError && setFields(error.fieldErrors),
    });
  };

  return (
    <Card title="Add a webhook destination">
      {secret && (
        <div
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm"
          role="status"
        >
          <p className="font-semibold text-amber-900">
            Copy the signing secret now. It will not be shown again.
          </p>
          <code className="mt-2 block break-all select-all">{secret}</code>
          <Button variant="secondary" className="mt-2" onClick={() => setSecret(null)}>
            I've stored it
          </Button>
        </div>
      )}
      <form
        onSubmit={onSubmit}
        noValidate
        className="grid gap-4 md:grid-cols-[1fr_2fr_auto] md:items-end"
      >
        <TextField
          label="Name"
          name="name"
          placeholder="e.g. On-call channel"
          error={fields.name}
        />
        <TextField
          label="URL"
          name="url"
          placeholder="https://…"
          error={fields.url}
          hint="Internal and private addresses are rejected."
        />
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add destination'}
        </Button>
      </form>
      {create.isError && !hasFieldErrors(create.error) && (
        <div className="mt-3">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
