// ============================================================
// routes/rooms.ts
// PATCHED to return direct AND group rooms in one unified `rooms`
// array, discriminated by `roomType`. The frontend rooms slice
// consumes this directly — see store/slices/createRoomSlice.ts.
//
// Old contract: { success, directRooms: DirectChatRoomDTO[] }
// New contract: { success, rooms: (DirectChatRoomDTO | GroupChatRoomDTO)[] }
//
// Avatars: profiles now store avatar_public_id, not a finished URL.
// Every profile fetched here goes through getSignedAvatarUrl() before
// it's placed on a DTO — see profile.service.ts for why.
// ============================================================
import express from 'express';
import { createUserClient } from '../config/supabase.js';
import authMiddleware from '../middleware/auth.js';
import { getSignedAvatarUrl } from '../config/cloudinary.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/rooms', async (req, res) => {
  try {
    const userId = req.userId as string;
    const userJWT = req.userJWT as string;

    const supabase = createUserClient(userJWT);

    // 1️⃣ Fetch every room this user participates in, of any type.
    const { data: participantRows, error: participantError } = await supabase
      .from('chat_room_participants')
      .select('room_id, role')
      .eq('user_id', userId);

    if (participantError) {
      console.error('Rooms participant fetch error:', participantError);
      return res.status(500).json({ success: false });
    }

    if (!participantRows || participantRows.length === 0) {
      return res.status(200).json({ success: true, rooms: [] });
    }

    const roomIds = participantRows.map((p) => p.room_id);
    const myRoleByRoom = new Map(
      participantRows.map((p) => [p.room_id, p.role])
    );

    const { data: rooms, error: roomError } = await supabase
      .from('chat_rooms')
      .select('id, type, name, avatar_public_id, description, updated_at') // was: avatar_url
      .in('id', roomIds);

    if (roomError) {
      console.error('Rooms fetch error:', roomError);
      return res.status(500).json({ success: false });
    }

    if (!rooms || rooms.length === 0) {
      return res.status(200).json({ success: true, rooms: [] });
    }

    const directRoomIds = rooms
      .filter((r) => r.type === 'direct')
      .map((r) => r.id);
    const groupRoomIds = rooms
      .filter((r) => r.type === 'group')
      .map((r) => r.id);

    // 2️⃣ For direct rooms: fetch the other participant + their profile.
    let directRoomDtos: any[] = [];

    if (directRoomIds.length > 0) {
      const { data: directParticipants, error: directParticipantsError } =
        await supabase
          .from('chat_room_participants')
          .select('room_id, user_id')
          .in('room_id', directRoomIds);

      if (directParticipantsError) {
        console.error(
          'Direct room participants fetch error:',
          directParticipantsError
        );
        return res.status(500).json({ success: false });
      }

      const otherUserIds = [
        ...new Set(
          (directParticipants ?? [])
            .filter((p) => p.user_id !== userId)
            .map((p) => p.user_id)
        ),
      ];

      const { data: otherProfiles, error: otherProfilesError } =
        otherUserIds.length > 0
          ? await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_public_id, status')
              .in('id', otherUserIds)
          : { data: [], error: null };

      if (otherProfilesError) {
        console.error('Direct room profiles fetch error:', otherProfilesError);
        return res.status(500).json({ success: false });
      }

      const profileMap = new Map((otherProfiles ?? []).map((p) => [p.id, p]));

      directRoomDtos = (directParticipants ?? [])
        .filter((p) => p.user_id !== userId)
        .map((p) => {
          const otherProfile = profileMap.get(p.user_id);
          if (!otherProfile) return null;

          return {
            roomId: p.room_id,
            roomType: 'direct' as const,
            currentUserId: userId,
            otherUserId: p.user_id,
            otherUser: {
              id: otherProfile.id,
              fullName: otherProfile.full_name,
              username: otherProfile.username,
              avatarUrl: getSignedAvatarUrl(otherProfile.avatar_public_id),
              status: otherProfile.status, // add
            },
          };
        })
        .filter(Boolean);
    }

    // 3️⃣ For group rooms: fetch every member + their profile, plus
    // room name/avatar already pulled in `rooms` above.
    let groupRoomDtos: any[] = [];

    if (groupRoomIds.length > 0) {
      const { data: groupParticipants, error: groupParticipantsError } =
        await supabase
          .from('chat_room_participants')
          .select('room_id, user_id, role')
          .in('room_id', groupRoomIds);

      if (groupParticipantsError) {
        console.error(
          'Group room participants fetch error:',
          groupParticipantsError
        );
        return res.status(500).json({ success: false });
      }

      const memberIds = [
        ...new Set((groupParticipants ?? []).map((p) => p.user_id)),
      ];

      const { data: memberProfiles, error: memberProfilesError } =
        memberIds.length > 0
          ? await supabase
              .from('profiles')
              .select('id, username, full_name, avatar_public_id, status')
              .in('id', memberIds)
          : { data: [], error: null };

      if (memberProfilesError) {
        console.error(
          'Group member profiles fetch error:',
          memberProfilesError
        );
        return res.status(500).json({ success: false });
      }

      const profileMap = new Map((memberProfiles ?? []).map((p) => [p.id, p]));
      const roomMap = new Map(rooms.map((r) => [r.id, r]));

      const participantsByRoom = new Map<string, any[]>();
      (groupParticipants ?? []).forEach((p) => {
        const profile = profileMap.get(p.user_id);
        if (!profile) return;
        const list = participantsByRoom.get(p.room_id) ?? [];
        list.push({
          id: profile.id,
          username: profile.username,
          fullName: profile.full_name,
          avatarUrl: getSignedAvatarUrl(profile.avatar_public_id),
          status: profile.status, // add
          role: p.role,
        });
        participantsByRoom.set(p.room_id, list);
      });

      groupRoomDtos = groupRoomIds.map((roomId) => {
        const room = roomMap.get(roomId);
        return {
          roomId,
          roomType: 'group' as const,
          currentUserId: userId,
          currentUserRole: myRoleByRoom.get(roomId) ?? 'member',
          name: room?.name ?? 'Unnamed group',
          avatarUrl: getSignedAvatarUrl(room?.avatar_public_id ?? null), // was: room?.avatar_url ?? null
          description: room?.description ?? null,
          members: participantsByRoom.get(roomId) ?? [],
        };
      });
    }

    return res.status(200).json({
      success: true,
      rooms: [...directRoomDtos, ...groupRoomDtos],
    });
  } catch (error) {
    console.error('\nROOMS ROUTE CRASH:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

export default router;
