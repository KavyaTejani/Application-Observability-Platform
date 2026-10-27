import type { Environment } from '@aop/validation';
import { AppError, notFound } from '../../lib/errors.js';
import type { ApiKeyService } from '../api-keys/api-key.service.js';
import type { ProjectScope, TenantScope } from '../authz/tenant-scope.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { makeSlug } from '../organizations/organization.service.js';
import { PlanModel } from '../plans/plan.model.js';
import { ProjectModel, type ProjectDoc } from './project.model.js';

export interface ProjectSummary {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  environment: Environment;
  lastTelemetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const toSummary = (project: ProjectDoc): ProjectSummary => ({
  id: project._id.toHexString(),
  organizationId: project.organizationId.toHexString(),
  name: project.name,
  slug: project.slug,
  environment: project.environment,
  lastTelemetryAt: project.lastTelemetryAt?.toISOString() ?? null,
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
});

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

const nameTaken = () =>
  new AppError(409, 'PROJECT_NAME_TAKEN', 'A project with this name already exists.', {
    fields: { name: 'A project with this name already exists' },
  });

export class ProjectService {
  constructor(private readonly apiKeys: ApiKeyService) {}

  async list(scope: TenantScope): Promise<ProjectSummary[]> {
    const projects = await ProjectModel.find({
      organizationId: scope.organizationId,
      status: 'active',
    })
      .sort({ createdAt: 1 })
      .lean();
    return projects.map(toSummary);
  }

  async get(scope: ProjectScope): Promise<ProjectSummary> {
    const project = await ProjectModel.findOne({
      _id: scope.projectId,
      organizationId: scope.organizationId,
      status: 'active',
    }).lean();
    if (!project) throw notFound('Project not found.');
    return toSummary(project);
  }

  /**
   * Creates a project within the plan's `maxProjects`. The limit is enforced with a conditional
   * increment on the organization, so concurrent requests cannot exceed it. The slot is released
   * if the insert fails.
   */
  async create(
    scope: TenantScope,
    input: { name: string; environment: Environment },
  ): Promise<ProjectSummary> {
    const org = await OrganizationModel.findOne(
      { _id: scope.organizationId },
      { planId: 1 },
    ).lean();
    if (!org) throw notFound('Organization not found.');
    const plan = await PlanModel.findOne({ _id: org.planId }, { limits: 1 }).lean();
    if (!plan) throw new Error(`Plan ${org.planId.toHexString()} missing for organization`);

    const reserved = await OrganizationModel.updateOne(
      {
        _id: scope.organizationId,
        // Organizations created before projectCount existed have no field. That means zero
        // projects, and $inc on a missing field starts it at 1.
        $or: [
          { projectCount: { $lt: plan.limits.maxProjects } },
          { projectCount: { $exists: false } },
        ],
      },
      { $inc: { projectCount: 1 } },
    );
    if (reserved.modifiedCount === 0) {
      throw new AppError(
        409,
        'PLAN_LIMIT_REACHED',
        `Your plan allows ${plan.limits.maxProjects} projects. Delete one to create another.`,
        { limit: plan.limits.maxProjects, resource: 'projects' },
      );
    }

    try {
      const project = await ProjectModel.create({
        organizationId: scope.organizationId,
        name: input.name,
        nameNormalized: input.name.toLowerCase(),
        slug: makeSlug(input.name),
        environment: input.environment,
        createdBy: scope.userId,
      });
      return toSummary(project.toObject());
    } catch (error) {
      await OrganizationModel.updateOne(
        { _id: scope.organizationId, projectCount: { $gt: 0 } },
        { $inc: { projectCount: -1 } },
      );
      if (isDuplicateKeyError(error)) throw nameTaken();
      throw error;
    }
  }

  async rename(scope: ProjectScope, name: string): Promise<ProjectSummary> {
    try {
      const project = await ProjectModel.findOneAndUpdate(
        { _id: scope.projectId, organizationId: scope.organizationId, status: 'active' },
        { $set: { name, nameNormalized: name.toLowerCase() } },
        { returnDocument: 'after', lean: true },
      );
      if (!project) throw notFound('Project not found.');
      return toSummary(project);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw nameTaken();
      throw error;
    }
  }

  /**
   * Soft delete: the project disappears from the product and every key is revoked at once, so
   * lingering credentials cannot write new telemetry (PRD §16). Telemetry already stored ages out
   * through backend retention; it is not purged instantly.
   */
  async remove(scope: ProjectScope): Promise<void> {
    const result = await ProjectModel.updateOne(
      { _id: scope.projectId, organizationId: scope.organizationId, status: 'active' },
      { $set: { status: 'deleted', deletedAt: new Date() } },
    );
    if (result.modifiedCount === 0) throw notFound('Project not found.');
    await this.apiKeys.revokeAllForProject(scope.organizationId, scope.projectId);
    await OrganizationModel.updateOne(
      { _id: scope.organizationId, projectCount: { $gt: 0 } },
      { $inc: { projectCount: -1 } },
    );
  }
}
