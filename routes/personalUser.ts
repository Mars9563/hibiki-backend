import express from 'express';
import multer from 'multer';
import authMiddleware from '../middleware/auth.js';
import { createUserClient } from '../config/supabase.js';
import {
  ProfileServiceError,
  attachSignedAvatarUrl,
  updateProfile,
} from '../services/profile.service.js';

const router = express.Router();
router.use(authMiddleware);

// In-memory storage — the file never touches disk, it's piped
// straight to Cloudinary inside uploadAvatarBuffer(). Cap matches
// the limit already enforced client-side in the crop dialog.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ---------- GET /api/personal/me ----------
router.get('/me', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ success: false, message: 'Profile not found' });
    }

    return res.status(200).json({
      success: true,
      profile: attachSignedAvatarUrl(data),
    });
  } catch (error) {
    console.error('Get profile error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- PATCH /api/personal/me ----------
// Single combined save: name, username, and/or a new avatar all go
// through in one multipart request and one DB write. The image
// field (if present) is optional — text-only edits skip the upload
// path in profile.service.ts entirely.
router.patch('/me', upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.userId as string;
    const userJWT = req.userJWT as string;
    const { fullName, username, status } = req.body as {
      fullName?: string;
      username?: string;
      status?: string;
    };

    const profile = await updateProfile({
      userId,
      userJWT,
      fullName,
      username,
      status,
      avatarBuffer: req.file?.buffer,
    });

    return res.status(200).json({ success: true, profile });
  } catch (error) {
    if (error instanceof ProfileServiceError) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }
    console.error('Update profile error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

export default router;
