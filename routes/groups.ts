import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient, supabaseSuperUser } from '../config/supabase.js';
import { getIo } from '../socket/index.js';
import multer from 'multer';
import {
  GroupServiceError,
  createGroup,
  inviteToGroup,
  acceptGroupInvite,
  rejectGroupInvite,
  getGroupRosterForInvitee,
  updateGroup,
} from '../services/room.service.js';
import { getSignedAvatarUrl } from '../config/cloudinary.js';
import { attachSignedAvatarUrls } from '../services/profile.service.js';
import { searchLimiter, writeLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ---------- POST /api/groups ----------
// Create a group. Creator becomes the sole initial participant
// (role: admin). Everyone in inviteeIds gets a pending group_invite —
// there is no direct-add path, even at creation time.
router.post('/groups', writeLimiter, async (req, res) => {
  try {
    const creatorId = req.userId as string;
    const creatorJWT = req.userJWT as string;
    const { name, inviteeIds } = req.body as {
      name?: string;
      inviteeIds?: string[];
    };

    if (!name || typeof name !== 'string') {
      return res
        .status(400)
        .json({ success: false, message: 'Group name is required' });
    }

    if (!Array.isArray(inviteeIds)) {
      return res
        .status(400)
        .json({ success: false, message: 'inviteeIds must be an array' });
    }

    const { room, invites } = await createGroup({
      creatorId,
      creatorJWT,
      name,
      inviteeIds,
    });

    // Notify each invitee live, same pattern as friendship:got_a_request.
    const io = getIo();
    invites.forEach((invite) => {
      io.to(`${invite.invitee_id}`).emit('group:invited', {
        roomId: room.roomId,
        roomName: room.name,
        inviterId: creatorId,
        inviteId: invite.id,
      });
    });

    return res.status(201).json({ success: true, room, invites });
  } catch (error) {
    if (error instanceof GroupServiceError) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }
    console.error('Create group error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- POST /api/groups/:roomId/invites ----------
// Invite a user to an existing group. Admin-only, enforced in the
// service layer. Same shape whether this is the first invite round
// or a later "invite more people" action — no separate concept.
router.post('/groups/:roomId/invites', writeLimiter, async (req, res) => {
  try {
    const inviterId = req.userId as string;
    const inviterJWT = req.userJWT as string;
    const { roomId } = req.params as {
      roomId: string;
    };
    const { inviteeId } = req.body as { inviteeId?: string };

    if (!inviteeId) {
      return res
        .status(400)
        .json({ success: false, message: 'inviteeId is required' });
    }

    const invite = await inviteToGroup({
      roomId,
      inviterId,
      inviterJWT,
      inviteeId,
    });

    getIo().to(`${inviteeId}`).emit('group:invited', {
      roomId,
      inviterId,
      inviteId: invite.id,
    });

    return res.status(201).json({ success: true, invite });
  } catch (error) {
    if (error instanceof GroupServiceError) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }
    console.error('Invite to group error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- GET /api/group-invites/pending ----------
// Mirrors friendships/pending — invites where the current user is
// the invitee, enriched with room + inviter info AND, now, the
// full roster of that group (who's accepted, who's still pending)
// so the invitee can see group composition before deciding whether
// to join. Roster comes from a service-role lookup since a pending
// invitee has no RLS-visible access to a room they haven't joined.
router.get('/group-invites/pending', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');
    const userId = req.userId;

    const { data: invites, error } = await supabase
      .from('group_invites')
      .select('id, status, created_at, room_id, inviter_id, invitee_id')
      .eq('invitee_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Group invites pending fetch error:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to fetch invites' });
    }

    if (!invites || invites.length === 0) {
      return res.status(200).json({ success: true, pending: [] });
    }

    const roomIds = [...new Set(invites.map((i) => i.room_id))];
    const inviterIds = [...new Set(invites.map((i) => i.inviter_id))];

    const [
      { data: rooms, error: roomsError },
      { data: inviters, error: invitersError },
      rosters,
    ] = await Promise.all([
      supabaseSuperUser
        .from('chat_rooms')
        .select('id, name, avatar_public_id, avatar_version')
        .in('id', roomIds),
      supabase
        .from('profiles')
        .select('id, username, full_name, avatar_public_id, avatar_version')
        .in('id', inviterIds),
      Promise.all(roomIds.map((id) => getGroupRosterForInvitee(id))),
    ]);

    if (roomsError || invitersError) {
      console.error(
        'Group invites pending enrichment error:',
        roomsError,
        invitersError
      );
      return res
        .status(500)
        .json({ success: false, message: 'Failed to fetch invites' });
    }

    const roomMap = Object.fromEntries(
      (rooms ?? []).map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          avatar_url: getSignedAvatarUrl(r.avatar_public_id, r.avatar_version),
        },
      ])
    );
    const inviterMap = Object.fromEntries(
      attachSignedAvatarUrls(inviters ?? []).map((p) => [p.id, p])
    );
    const rosterMap = Object.fromEntries(
      roomIds.map((id, i) => [id, rosters[i]])
    );

    const enriched = invites.map((invite) => ({
      ...invite,
      room: roomMap[invite.room_id],
      inviter: inviterMap[invite.inviter_id],
      roster: rosterMap[invite.room_id] ?? [],
    }));

    return res.status(200).json({ success: true, pending: enriched });
  } catch (error) {
    console.error('Group invites pending route error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- POST /api/group-invites/accept ----------
router.post('/group-invites/accept', writeLimiter, async (req, res) => {
  try {
    const inviteeId = req.userId as string;
    const inviteeJWT = req.userJWT as string;
    const { inviteId } = req.body as { inviteId?: string };

    if (!inviteId) {
      return res
        .status(400)
        .json({ success: false, message: 'inviteId is required' });
    }

    const room = await acceptGroupInvite({ inviteId, inviteeId, inviteeJWT });

    // Let everyone already in the room (including the new member's
    // own other sessions) know a member joined.
    getIo().to(room.roomId).emit('group:memberJoined', {
      roomId: room.roomId,
      userId: inviteeId,
    });
    // Hand the new member their room directly, same as
    // friendship:accepted does for direct rooms.
    getIo().to(`${inviteeId}`).emit('group:joined', { room });

    return res.status(200).json({ success: true, room });
  } catch (error) {
    if (error instanceof GroupServiceError) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }
    console.error('Accept group invite error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- DELETE /api/group-invites/reject ----------
router.delete('/group-invites/reject', writeLimiter, async (req, res) => {
  try {
    const inviteeId = req.userId as string;
    const { inviteId } = req.body as { inviteId?: string };

    if (!inviteId) {
      return res
        .status(400)
        .json({ success: false, message: 'inviteId is required' });
    }

    await rejectGroupInvite({ inviteId, inviteeId });

    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof GroupServiceError) {
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    }
    console.error('Reject group invite error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
});

// ---------- GET /api/groups/search ----------
// Search for users to invite to a group. Unlike /friendships/search,
// this does NOT filter out existing friends — group invites are
// independent of friendship status, so your actual friends (who
// you're most likely to want in a group) must show up. Only
// exclusion: yourself.
router.get('/groups/search', searchLimiter, async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');
    const userId = req.userId;
    const q = (req.query.q as string)?.trim();

    if (!q || q.length < 2) {
      return res.status(200).json({ success: true, results: [] });
    }

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_public_id, avatar_version')
      .ilike('username', `%${q}%`)
      .neq('id', userId)
      .limit(10);

    if (error) {
      console.error('Group search error:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Search failed.' });
    }

    return res
      .status(200)
      .json({ success: true, results: attachSignedAvatarUrls(profiles ?? []) });
  } catch (error) {
    console.error('Group search route error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error.' });
  }
});

// ---------- PATCH /api/groups/:roomId ----------
// Admin-only. Same single-combined-save shape as PATCH /personal/me —
// name, description, and/or a new icon all in one multipart request.
router.patch(
  '/groups/:roomId',
  writeLimiter,
  upload.single('avatar'),
  async (req, res) => {
    try {
      const adminId = req.userId as string;
      const adminJWT = req.userJWT as string;
      const { roomId } = req.params as {
        roomId: string;
      };
      const { name, description } = req.body as {
        name?: string;
        description?: string;
      };

      const room = await updateGroup({
        roomId,
        adminId,
        adminJWT,
        name,
        description,
        avatarBuffer: req.file?.buffer,
      });

      return res.status(200).json({ success: true, room });
    } catch (error) {
      if (error instanceof GroupServiceError) {
        return res
          .status(error.status)
          .json({ success: false, message: error.message });
      }
      console.error('Update group error:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

export default router;
