import type { Environment } from '@aop/validation';
import { Schema, model, type Types } from 'mongoose';

export interface ProjectDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  /** Lower-cased name, unique among an organization's active projects. */
  nameNormalized: string;
  slug: string;
  environment: Environment;
  status: 'active' | 'deleted';
  createdBy: Types.ObjectId;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<ProjectDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 60 },
    nameNormalized: { type: String, required: true },
    slug: { type: String, required: true },
    environment: { type: String, enum: ['development', 'staging', 'production'], required: true },
    status: { type: String, enum: ['active', 'deleted'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

projectSchema.index({ organizationId: 1, createdAt: 1 });
// Names are unique per organization among active projects. A deleted project's name can be
// reused.
projectSchema.index(
  { organizationId: 1, nameNormalized: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

export const ProjectModel = model<ProjectDoc>('Project', projectSchema, 'projects');
