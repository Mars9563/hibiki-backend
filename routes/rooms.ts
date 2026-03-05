import express from 'express';
import { createUserClient } from '../config/supabase.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/rooms', async (req, res) => {
  try {

    const userId = req.userId;
    const userJWT = req.userJWT;


    const supabase = createUserClient(userJWT!);

    // 1️⃣ Fetch direct rooms

    const { data: rooms, error: roomError } = await supabase
      .from('chat_rooms')
      .select('id')
      .eq('type', 'direct');


    if (roomError) {
      return res.status(500).json({ success: false });
    }

    if (!rooms || rooms.length === 0) {
      return res.status(200).json({ success: true, directRooms: [] });
    }

    const roomIds = rooms.map((r) => r.id);

    // 2️⃣ Fetch participants

    const { data: chatRoomParticipants, error: participantsError } =
      await supabase
        .from('chat_room_participants')
        .select('room_id, user_id')
        .in('room_id', roomIds);


    if (participantsError) {
      return res.status(500).json({ success: false });
    }

    if (!chatRoomParticipants || chatRoomParticipants.length === 0) {
      return res.status(200).json({ success: true, directRooms: [] });
    }

    // 3️⃣ Extract other users

    const otherUsers = chatRoomParticipants
      .filter((user) => user.user_id !== userId)
      .map((user) => user.user_id);

    const uniqueOtherUsers = [...new Set(otherUsers)];


    if (uniqueOtherUsers.length === 0) {
      return res.status(200).json({ success: true, directRooms: [] });
    }

    // 4️⃣ Fetch profiles

    const { data: userProfiles, error: userProfileError } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_url')
      .in('id', uniqueOtherUsers);


    if (userProfileError) {
      return res.status(500).json({ success: false });
    }

    if (!userProfiles || userProfiles.length === 0) {
      return res.status(200).json({ success: true, directRooms: [] });
    }

    // 5️⃣ Build response

    const profileMap = new Map(
      userProfiles.map((profile) => [profile.id, profile])
    );


    const directRooms = chatRoomParticipants
      .filter((room) => room.user_id !== userId)
      .map((room) => {
        const otherProfile = profileMap.get(room.user_id);


        if (!otherProfile) {
          return null;
        }

        return {
          roomId: room.room_id,
          roomType: 'direct',
          currentUserId: userId,
          otherUserId: room.user_id,
          otherUser: {
            id: otherProfile.id,
            fullName: otherProfile.full_name,
            username: otherProfile.username,
            avatarUrl: otherProfile.avatar_url,
          },
        };
      })
      .filter(Boolean);

    const joinRooms = directRooms.map((room) => (room?.roomId));
    

    return res.status(200).json({
      success: true,
      directRooms,
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
