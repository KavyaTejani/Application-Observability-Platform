import {
  ENVIRONMENTS,
  createProjectSchema,
  toFieldErrors,
  type FieldErrors,
} from '@aop/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { Alert, Button, Card, Spinner, TextField } from '../components/ui';
import { api, ApiError, errorMessage, hasFieldErrors } from '../lib/api';
import type { OrganizationSummary, Project } from '../lib/types';

export const projectsKey = (organizationId: string) => [
  'organizations',
  organizationId,
  'projects',
];

export function ProjectsPage() {
  const org = useOutletContext<OrganizationSummary>();
  const isOwner = org.role === 'owner';
  const projects = useQuery({
    queryKey: projectsKey(org.id),
    queryFn: ({ signal }) =>
      api<{ projects: Project[] }>(`/organizations/${org.id}/projects`, { signal }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
        <p className="mt-1 text-sm text-slate-600">
          A project is one monitored service in one environment. Each has its own ingestion keys.
        </p>
      </div>

      <Card title="Your projects">
        {projects.isPending && <Spinner />}
        {projects.isError && <Alert>{errorMessage(projects.error)}</Alert>}
        {projects.data?.projects.length === 0 && (
          <p className="text-sm text-slate-600">
            No projects yet.{' '}
            {isOwner ? 'Create one below.' : 'Ask an organization owner to create one.'}
          </p>
        )}
        {projects.data && projects.data.projects.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {projects.data.projects.map((project) => (
              <li key={project.id} className="flex items-center justify-between py-3">
                <Link
                  to={`/orgs/${org.id}/projects/${project.id}`}
                  className="font-medium text-slate-900 underline-offset-2 hover:underline"
                >
                  {project.name}
                </Link>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {project.environment}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isOwner && <CreateProjectForm organizationId={org.id} />}
    </div>
  );
}

function CreateProjectForm({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (input: { name: string; environment: string }) =>
      api<{ project: Project }>(`/organizations/${organizationId}/projects`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectsKey(organizationId) }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parsed = createProjectSchema.safeParse({
      name: form.get('name'),
      environment: form.get('environment'),
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
    <Card title="Create a project">
      <form
        onSubmit={onSubmit}
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      >
        <TextField label="Name" name="name" placeholder="e.g. checkout-api" error={fields.name} />
        <div>
          <label htmlFor="environment" className="block text-sm font-medium text-slate-700">
            Environment
          </label>
          <select
            id="environment"
            name="environment"
            defaultValue="development"
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
      </form>
      {create.isError && !hasFieldErrors(create.error) && (
        <div className="mt-3">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
      {create.isSuccess && (
        <div className="mt-3">
          <Alert tone="success">Project “{create.data.project.name}” created.</Alert>
        </div>
      )}
    </Card>
  );
}
