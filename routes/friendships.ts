import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient, supabaseSuperUser } from '../config/supabase.js';
import { getIo } from '../socket/index.js';
const router = express.Router();

router.use(authMiddleware);
router.get('/search', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const userId = req.userId;
    const q = (req.query.q as string)?.trim();

    if (!q || q.length < 2) {
      return res.status(200).json({ success: true, results: [] });
    }

    // 1️⃣ Get all users already connected (any status)
    const { data: existing } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

    const excludedIds = new Set<string>();
    excludedIds.add(userId as string);

    existing?.forEach((f) => {
      if (f.requester_id !== userId) excludedIds.add(f.requester_id);
      if (f.addressee_id !== userId) excludedIds.add(f.addressee_id);
    });

    // 2️⃣ Search profiles
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, username,full_name,avatar_url')
      .ilike('username', `%${q}%`)
      .limit(10);

    if (error) {
      console.error('Search error:', error);
      return res
        .status(500)
        .json({ success: false, message: 'Search failed.' });
    }

    // 3️⃣ Filter out excluded users
    const results = profiles?.filter((profile) => !excludedIds.has(profile.id));

    return res.status(200).json({
      success: true,
      results,
    });
  } catch (error) {
    console.error('Search route error:', error);
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
      .select(
        `
        id,
        username,
        full_name,
        avatar_url
      `
      )
      .in('id', userIds);

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch user profiles.',
      });
    }

    // 4️⃣ Create lookup map
    const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p]));

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

router.post('/request', async (req, res) => {
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

    // 2️⃣ Ensure target user exists
    const { data: targetUser } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', targetId)
      .limit(1);

    if (!targetUser || targetUser.length === 0) {
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

    // 4️⃣ Insert friendship
    const { data, error } = await supabase.from('friendships').insert({
      requester_id: requesterId,
      addressee_id: targetId,
      status: 'pending',
    });
    console.log(data);
    console.log(error);
    if (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Failed to send request' });
    }

    getIo().to(`${requesterId}`).emit('friendship:requested', {
      to: targetId,
    });
    getIo().to(`${targetId}`).emit('friendship:got_a_request', {
      from: requesterId,
    });

    return res.status(201).json({
      success: true,
      message: 'Friend request sent successfully',
    });
  } catch (error) {
    console.error('Friendship request error: ', error);
    return res.status(500).json({
      success: false,
      message: 'internal server error. Please try again.',
    });
  }
});

router.post('/accept', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const accepter_id = req.userId;
    const sender_id = req.body.targetId;
    // check payload
    if (!sender_id)
      return res
        .status(400)
        .json({ success: false, message: 'No targetId found in backend.' });
    // validate if it is not invalid
    if (sender_id === accepter_id)
      return res
        .status(400)
        .json({ success: false, message: 'Can not accept self request.' });

    // check if request is present in the db;
    const { data: friendship,error } = await supabase
      .from('friendships')
      .select('id, status')
      .match({
        requester_id: sender_id,
        addressee_id: accepter_id,
        status: 'pending',
      })
      .single();

    if (error || !friendship)
      return res
        .status(404)
        .json({ success: false, message: 'No such request found;' });

    const { data: updated, error: updateError } = await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('id', friendship.id)
      .eq('status', 'pending')
      .select()
      .single();

    if (updateError || !updated)
      return res
        .status(404)
        .json({ success: false, message: 'Request alerady handeled.' });

    const pairHash = [sender_id, accepter_id].sort().join('_');

    let room;

    const { data: newRoom, error: roomError } = await supabaseSuperUser
      .from('chat_rooms')
      .insert({
        type: 'direct',
        direct_pair_hash: pairHash,
      })
      .select()
      .single();

    if (roomError) {
      if (roomError.code === '23505') {
        // Unique violation → room already exists
        const { data: existingRoom, error: fetchError } =
          await supabaseSuperUser
            .from('chat_rooms')
            .select('*')
            .eq('direct_pair_hash', pairHash)
            .single();

        if (fetchError || !existingRoom) {
          throw fetchError || new Error('Failed to fetch existing room');
        }

        room = existingRoom;
      } else {
        throw roomError; // real unexpected error
      }
    } else {
      room = newRoom;
    }

    // 4️⃣ Insert participants (service role)
    await supabaseSuperUser.from('chat_room_participants').upsert(
      [
        { room_id: room.id, user_id: sender_id },
        { room_id: room.id, user_id: accepter_id },
      ],
      {
        onConflict: 'room_id,user_id',
        ignoreDuplicates: true,
      }
    );

    // 5️⃣ Emit to both
    const io = getIo();

    io.to([sender_id, accepter_id]).emit('friendship:accepted', { room });

    return res.status(200).json({
      success: true,
      room,
    });
  } catch (error) {
    console.error('Accept error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

export default router;
