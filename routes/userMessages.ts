// ============================================================
// routes/userMessages.ts
// PATCHED for cursor-based pagination, per-room (not per-room-list).
//
// Old contract: GET /api/messages?roomIds=["a","b"]  -> ALL messages
//               for ALL rooms in one unbounded query.
// New contract: GET /api/messages?roomId=a&limit=50&before=<ISO ts>
//               -> up to `limit` messages older than `before`,
//               newest-first (DESC). Omit `before` for page 1.
//
// This is a breaking change to the route's query shape — the
// frontend slice (createMessagesSlice.ts) already calls it this
// way. There is no remaining caller of the old `roomIds=[...]`
// shape once useRooms.ts's effect is deleted (see migration
// checklist), so this is safe to replace outright rather than
// version it.
// ============================================================
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient } from '../config/supabase.js';

const router = express.Router();
router.use(authMiddleware);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

router.get('/messages', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const roomId = req.query.roomId;
    if (!roomId || typeof roomId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing roomId' });
    }

    // Confirm the caller is actually a participant of this room before
    // returning anything — the old route trusted the client-supplied
    // roomIds array with no membership check at all.
    const { data: membership, error: membershipError } = await supabase
      .from('chat_room_participants')
      .select('room_id')
      .eq('room_id', roomId)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (membershipError) {
      console.error(membershipError);
      return res.status(500).json({ success: false, error: 'Server error' });
    }

    if (!membership) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const before = req.query.before;

    let query = supabase
      .from('messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before && typeof before === 'string') {
      query = query.lt('created_at', before);
    }

    const { data, error } = await query;

    if (error) {
      console.error(error);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Returned newest-first (DESC) — the frontend slice reverses this
    // into chronological order for rendering and reads the LAST item
    // here (the oldest of this page) to compute the next `before` cursor.
    res.json({
      success: true,
      messages: data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
