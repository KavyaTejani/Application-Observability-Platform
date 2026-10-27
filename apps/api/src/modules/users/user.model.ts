import { Schema, model, type Types } from 'mongoose';

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  emailNormalized: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    emailNormalized: { type: String, required: true, unique: true },
    // Argon2id PHC string. Never selected by default, so it cannot leak through a careless query.
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export const UserModel = model<UserDoc>('User', userSchema, 'users');

export interface PublicUser {
  id: string;
  name: string;
  email: string;
}

export const toPublicUser = (
  user: Pick<UserDoc, '_id' | 'name' | 'emailNormalized'>,
): PublicUser => ({
  id: user._id.toHexString(),
  name: user.name,
  email: user.emailNormalized,
});
