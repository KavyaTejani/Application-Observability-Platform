import {
  ENVIRONMENTS,
  createProjectSchema,
  toFieldErrors,
  type FieldErrors,
} from '@aop/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderKanban } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { FreshnessBadge } from '../components/StatusBadge';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pill,
  SelectField,
  Spinner,
  TextField,
} from '../components/ui';
import { api, ApiError, errorMessage, hasFieldErrors } from '../lib/api';
import { formatRelative } from '../lib/format';
import { projectsKey, useProjects } from '../lib/projects';
import type { OrganizationSummary, Project } from '../lib/types';

export { projectsKey };

export function ProjectsPage() {
  const org = useOutletContext<OrganizationSummary>();
  const isOwner = org.role === 'owner';
  const projects = useProjects(org.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="A project is one monitored service in one environment. Each has its own ingestion keys."
      />

      {projects.isPending && <Spinner />}
      {projects.isError && <Alert>{errorMessage(projects.error)}</Alert>}
      {projects.data?.projects.length === 0 && (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet">
            {isOwner
              ? 'Create your first project below.'
              : 'Ask an organization owner to create one.'}
          </EmptyState>
        </Card>
      )}
      {projects.data && projects.data.projects.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/orgs/${org.id}/projects/${project.id}`}
                className="group press-card flex h-full flex-col frame p-5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                    <FolderKanban className="size-4" aria-hidden="true" />
                  </span>
                  <FreshnessBadge lastTelemetryAt={project.lastTelemetryAt} />
                </div>
                <p className="mt-4 font-semibold text-fg">{project.name}</p>
                <p className="mt-1 text-xs text-fg-muted">
                  Last data {formatRelative(project.lastTelemetryAt)}
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <Pill>{project.environment}</Pill>
                  <ArrowRight
                    className="size-4 text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-text"
                    aria-hidden="true"
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
    <Card
      title="Create a project"
      description="Names are unique per organization. The environment cannot be changed later."
    >
      <form
        onSubmit={onSubmit}
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      >
        <TextField label="Name" name="name" placeholder="e.g. checkout-api" error={fields.name} />
        <SelectField label="Environment" name="environment" defaultValue="development">
          {ENVIRONMENTS.map((env) => (
            <option key={env} value={env}>
              {env}
            </option>
          ))}
        </SelectField>
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
