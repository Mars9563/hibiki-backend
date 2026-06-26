// ============================================================
// config/cloudinary.ts
// Single place that knows how to talk to Cloudinary. Avatars are
// uploaded with type: 'authenticated' (not publicly listable or
// guessable) and delivered via signed URLs generated here — nothing
// else in the codebase should import the `cloudinary` package
// directly.
// ============================================================
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export { cloudinary };

// One deterministic public_id per user. Re-uploading always targets
// this same id with overwrite:true, so there is never a second,
// orphaned image left behind in the cloud — nothing to separately
// delete, nothing to track.
export function avatarPublicId(userId: string) {
  return `avatars/${userId}`;
}

// Signed delivery URL for a private ("authenticated" type) asset.
// Cloudinary signs this with your API secret — no extra dashboard
// setup required (that's only needed for the stricter, expiring
// auth_token feature, which we don't need here: the asset itself is
// access_mode 'authenticated', so the signature is what gates access
// at all, not a time window). Re-derived fresh on every profile read
// (GET /me, GET /rooms, etc) rather than cached in the database.
export function getSignedAvatarUrl(
  publicId: string | null | undefined
): string | null {
  if (!publicId) return null;

  return cloudinary.url(publicId, {
    type: 'authenticated',
    sign_url: true,
    secure: true,
    transformation: [{ width: 512, height: 512, crop: 'fill' }],
  });
}

// Upload a buffer (already-cropped square JPEG from the client) to
// the user's fixed avatar slot. overwrite:true means a re-upload
// replaces the previous asset in place — no separate delete call,
// no race between "delete old" and "save new".
export function uploadAvatarBuffer(
  buffer: Buffer,
  userId: string
): Promise<{ public_id: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: avatarPublicId(userId),
        type: 'authenticated',
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
      },
      (error, result) => {
        if (error || !result) {
          return reject(error || new Error('Cloudinary upload failed'));
        }
        resolve({ public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// One deterministic public_id per group, same overwrite-in-place
// pattern as avatars — re-uploading a group icon just replaces the
// previous one, no orphaned asset.
export function groupAvatarPublicId(roomId: string) {
  return `groups/${roomId}`;
}

export function uploadGroupAvatarBuffer(
  buffer: Buffer,
  roomId: string
): Promise<{ public_id: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: groupAvatarPublicId(roomId),
        type: 'authenticated',
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
      },
      (error, result) => {
        if (error || !result) {
          return reject(error || new Error('Cloudinary upload failed'));
        }
        resolve({ public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}