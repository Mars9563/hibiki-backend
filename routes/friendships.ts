import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient, supabaseSuperUser } from '../config/supabase.js';
import { getIo } from '../socket/index.js';
import {
  attachSignedAvatarUrl,
  attachSignedAvatarUrls,
} from '../services/profile.service.js';
import { searchLimiter, writeLimiter } from '../middleware/rateLimiter.js';
const router = express.Router();

router.use(authMiddleware);
router.get('/search',searchLimiter, async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');
    const userId = req.userId;
    const q = (req.query.q as string)?.trim();

    if (!q || q.length < 2) {
      return res.status(200).json({ success: true, results: [] });
    }

    const { data: existing, error: friendshipError } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

    if (friendshipError)
      console.error('🔍 [SEARCH] Friendship fetch error:', friendshipError);

    const excludedIds = new Set<string>();
    excludedIds.add(userId as string);

    existing?.forEach((f) => {
      if (f.requester_id !== userId) excludedIds.add(f.requester_id);
      if (f.addressee_id !== userId) excludedIds.add(f.addressee_id);
    });

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_public_id, avatar_version') // was: avatar_url
      .ilike('username', `%${q}%`)
      .limit(10);

    if (error) {
      console.error('🔍 [SEARCH] Profile search failed:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Search failed.' });
    }

    // 3️⃣ Filter out excluded users
    const results = attachSignedAvatarUrls(
      (profiles ?? []).filter((profile) => !excludedIds.has(profile.id))
    );

    return res.status(200).json({
      success: true,
      results,
    });
  } catch (error) {
    console.error('🔍 [SEARCH] Caught exception:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

router.get('/pending', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');
    const userId = req.userId;

    // 1️⃣ Fetch raw friendships only (no relational expansion)
    const { data: friendships, error } = await supabase
      .from('friendships')
      .select(
        `
        id,
        status,
        created_at,
        requester_id,
        addressee_id
      `
      )
      .eq('status', 'pending')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Pending fetch error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch pending requests.',
      });
    }

    if (!friendships || friendships.length === 0) {
      return res.status(200).json({
        success: true,
        pending: [],
      });
    }

    // 2️⃣ Collect unique user IDs
    const userIds = [
      ...new Set(friendships.flatMap((f) => [f.requester_id, f.addressee_id])),
    ];

    // 3️⃣ Fetch profiles manually
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_public_id, avatar_version') // was: avatar_url
      .in('id', userIds);

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch user profiles.',
      });
    }

    // 4️⃣ Create lookup map
    const profileMap = Object.fromEntries(
      attachSignedAvatarUrls(profiles ?? []).map((p) => [p.id, p])
    );

    // 5️⃣ Enrich friendships
    const enriched = friendships.map((f) => ({
      ...f,
      requester: profileMap[f.requester_id],
      addressee: profileMap[f.addressee_id],
    }));

    return res.status(200).json({
      success: true,
      pending: enriched,
    });
  } catch (error) {
    console.error('Pending route error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error. While fetching pending request.',
    });
  }
});

router.post('/request',writeLimiter, async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const requesterId = req.userId;
    const targetId = req.body.targetUserId;

    // 1️⃣ Validate input
    if (!targetId) {
      return res
        .status(400)
        .json({ success: false, message: 'targetUserId is required' });
    }

    if (targetId === requesterId) {
      return res
        .status(400)
        .json({ success: false, message: 'Cannot send request to yourself' });
    }

    // 2️⃣ Ensure target user exists — and grab their profile now so we
    // can return a fully-formed friendship row without a second round
    // trip from the frontend.
    const { data: targetProfile } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_public_id, avatar_version') // was: avatar_url
      .eq('id', targetId)
      .maybeSingle();

    if (!targetProfile) {
      return res
        .status(404)
        .json({ success: false, message: 'Target user not found' });
    }

    // 3️⃣ Check existing friendship (both directions)
    const { data: existing } = await supabase
      .from('friendships')
      .select('id')
      .or(
        `and(requester_id.eq.${requesterId},addressee_id.eq.${targetId}),and(requester_id.eq.${targetId},addressee_id.eq.${requesterId})`
      )
      .limit(1);

    if (existing && existing.length > 0) {
      return res
        .status(409)
        .json({ success: false, message: 'Friendship already exists' });
    }

    // 4️⃣ Insert friendship and select the row back (was previously
    // a fire-and-forget insert with no returned data).
    const { data: friendship, error } = await supabase
      .from('friendships')
      .insert({
        requester_id: requesterId,
        addressee_id: targetId,
        status: 'pending',
      })
      .select('id, status, created_at, requester_id, addressee_id')
      .single();

    if (error || !friendship) {
      console.error(error);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to send request' });
    }

    // 5️⃣ Also fetch the requester's own profile so the payload is
    // shaped exactly like a /pending entry — frontend can push it
    // straight into sentPending with zero guessing.
    const { data: requesterProfile } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_public_id, avatar_version') // was: avatar_url
      .eq('id', requesterId)
      .maybeSingle();

    getIo().to(`${requesterId}`).emit('friendship:requested', {
      to: targetId,
    });
    getIo().to(`${targetId}`).emit('friendship:got_a_request', {
      from: requesterId,
    });

    return res.status(201).json({
      success: true,
      message: 'Friend request sent successfully',
      friendship: {
        ...friendship,
        requester: requesterProfile
          ? attachSignedAvatarUrl(requesterProfile)
          : null,
        addressee: targetProfile ? attachSignedAvatarUrl(targetProfile) : null,
      },
    });
  } catch (error) {
    console.error('Friendship request error: ', error);
    return res.status(500).json({
      success: false,
      message: 'internal server error. Please try again.',
    });
  }
});

router.post('/accept', writeLimiter, async (req, res) => {
  try {
    const accepter_id = req.userId;
    const sender_id = req.body.targetId;

    if (!sender_id)
      return res
        .status(400)
        .json({ success: false, message: 'No targetId found in backend.' });

    if (sender_id === accepter_id)
      return res
        .status(400)
        .json({ success: false, message: 'Can not accept self request.' });

    const { data: room, error } = await supabaseSuperUser.rpc(
      'accept_friendship',
      { p_requester_id: sender_id, p_accepter_id: accepter_id }
    );

    if (error || !room) {
      if (error?.code === 'P0002') {
        return res
          .status(404)
          .json({ success: false, message: 'No pending request found.' });
      }
      console.error('Accept friendship RPC error:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error.' });
    }

    const io = getIo();
    io.to([sender_id, accepter_id]).emit('friendship:accepted', { room });

    return res.status(200).json({ success: true, room });
  } catch (error) {
    console.error('Accept error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error.' });
  }
});

router.delete('/reject',writeLimiter, async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const rejecter_id = req.userId;
    const sender_id = req.body.targetId;

    if (!sender_id)
      return res
        .status(400)
        .json({ success: false, message: 'No targetId found.' });

    if (sender_id === rejecter_id)
      return res
        .status(400)
        .json({ success: false, message: 'Cannot reject your own request.' });

    // Check the request exists and current user is the addressee
    const { data: friendship, error } = await supabase
      .from('friendships')
      .select('id, status')
      .match({
        requester_id: sender_id,
        addressee_id: rejecter_id,
        status: 'pending',
      })
      .single();

    if (error || !friendship)
      return res
        .status(404)
        .json({ success: false, message: 'No such pending request found.' });

    const { error: deleteError } = await supabase
      .from('friendships')
      .delete()
      .eq('id', friendship.id);

    if (deleteError)
      return res
        .status(500)
        .json({ success: false, message: 'Failed to reject request.' });

    const io = getIo();
    io.to(`${sender_id}`).emit('friendship:rejected', { by: rejecter_id });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Reject error:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error.' });
  }
});

export default router;
