// ============================================================
// services/profile.service.ts
// Profile update business logic, kept out of routes/personalUser.ts
// so the route stays a thin HTTP <-> service translation layer
// (same split used in room.service.ts).
//
// `profiles` has a working user-scoped UPDATE policy (RLS lets a
// user update their own row), so this uses createUserClient rather
// than supabaseSuperUser — least privilege where it's available,
// same reasoning documented at the top of room.service.ts.
//
// Avatars: the column actually stored is `avatar_public_id`, not a
// finished URL. Every read site (this file, room.service.ts,
// rooms.ts, friendships.ts) must run raw profile rows through
// attachSignedAvatarUrl()/attachSignedAvatarUrls() below rather than
// trusting any URL coming straight out of the database — that's the
// one rule that keeps signed delivery working everywhere a profile
// shows up.
// ============================================================
import { createUserClient } from '../config/supabase.js';
import {
  getSignedAvatarUrl,
  uploadAvatarBuffer,
} from '../config/cloudinary.js';

export class ProfileServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const USERNAME_REGEX = /^[_a-zA-Z][a-zA-Z0-9._]{2,19}$/;

// ---------- Shared signed-URL enrichment ----------
// Use these instead of reading avatar_public_id/avatar_url directly
// from any `profiles` row, anywhere in the backend.

type RawProfileRow = {
  id: string;
  username: string;
  full_name: string | null;
  avatar_public_id: string | null;
  [key: string]: unknown;
};

export function attachSignedAvatarUrl<T extends RawProfileRow>(
  profile: T
): Omit<T, 'avatar_public_id'> & { avatar_url: string | null } {
  const { avatar_public_id, ...rest } = profile;
  return { ...rest, avatar_url: getSignedAvatarUrl(avatar_public_id) };
}

export function attachSignedAvatarUrls<T extends RawProfileRow>(
  profiles: T[]
): (Omit<T, 'avatar_public_id'> & { avatar_url: string | null })[] {
  return profiles.map(attachSignedAvatarUrl);
}

// ---------- Update ----------

export type UpdateProfileInput = {
  userId: string;
  userJWT: string;
  fullName?: string;
  username?: string;
  status?: string;
  avatarBuffer?: Buffer;
};

export async function updateProfile({
  userId,
  userJWT,
  fullName,
  username,
  status,
  avatarBuffer,
}: UpdateProfileInput) {
  const patch: Record<string, string> = {};

  if (fullName !== undefined) {
    const trimmed = fullName.trim();
    if (!trimmed) {
      throw new ProfileServiceError(400, 'Name is required');
    }
    if (trimmed.length > 255) {
      throw new ProfileServiceError(
        400,
        'Name must be 255 characters or fewer'
      );
    }
    patch.full_name = trimmed;
  }

  if (username !== undefined) {
    const trimmed = username.trim();
    if (!USERNAME_REGEX.test(trimmed)) {
      throw new ProfileServiceError(
        400,
        'Username must start with a letter or underscore and contain only letters, numbers, dots, or underscores (3–20 chars).'
      );
    }
    patch.username = trimmed;
  }

  if (status !== undefined) {
    const trimmed = status.trim();
    if (trimmed.length > 150) {
      throw new ProfileServiceError(
        400,
        'Status must be 150 characters or fewer'
      );
    }
    patch.status = trimmed;
  }

  // Upload happens before the DB write so a failed upload never
  // leaves the row half-updated. overwrite:true on a fixed
  // public_id means this either fully replaces the previous avatar
  // or fails outright — no orphaned asset, no partial state either way.
  if (avatarBuffer) {
    try {
      const { public_id } = await uploadAvatarBuffer(avatarBuffer, userId);
      patch.avatar_public_id = public_id;
    } catch (err) {
      console.error('Avatar upload error:', err);
      throw new ProfileServiceError(502, 'Failed to upload photo');
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new ProfileServiceError(400, 'No fields to update');
  }

  const supabase = createUserClient(userJWT);

  // Username has a UNIQUE constraint — Postgres 23505 on conflict.
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new ProfileServiceError(409, 'That username is already taken');
    }
    throw new ProfileServiceError(500, 'Failed to update profile');
  }

  return attachSignedAvatarUrl(data as RawProfileRow);
}
