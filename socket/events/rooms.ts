import { Server, Socket } from 'socket.io';
import { createUserClient } from '../../config/supabase.js';
import z from 'zod';

const joinData = z.object({
  roomId: z.string().nonoptional(),
});
const roomsJoinManySchema = z.object({
  roomIds: z.array(z.string()),
});

export function roomJoinEvents(io: Server, socket: Socket) {
  socket.on('room:join', async (rawData) => {
    const parsed = joinData.safeParse(rawData);

    if (!parsed.success) {
      return socket.emit('room:error', {
        success: false,
        error: 'Invalid room payload.',
      });
    }

    const { roomId } = parsed.data;

    try {
      const supabase = createUserClient(socket.data.userJWT);

      const { data, error } = await supabase
        .from('chat_room_participants')
        .select('room_id')
        .eq('room_id', roomId)
        .eq('user_id', socket.data.userId)
        .maybeSingle();

      if (error) {
        console.error('Membership check error:', error);
        return socket.emit('room:error', {
          success: false,
          error: 'Server error while joining room.',
        });
      }

      if (!data) {
        return socket.emit('room:unauthorized', {
          success: false,
          error: 'You are not authorized for this action.',
          roomId,
        });
      }

      socket.join(roomId);

      socket.emit('room:joined', {
        success: true,
        message: 'Chat connected successfully',
        roomId,
      });
    } catch (err) {
      console.error('Join room crash:', err);
      socket.emit('room:error', {
        success: false,
        error: 'Unexpected error occurred.',
      });
    }
  });
  socket.on('rooms:joinMany', async (data) => {
    const parsed = roomsJoinManySchema.safeParse(data);

    if (!parsed.success) {
      return socket.emit('room:error', {
        success: false,
        error: 'Invalid room payload.',
      });
    }
    const { roomIds } = parsed.data;

    try {
      const supabase = createUserClient(socket.data.userJWT);

      const { data: membership, error } = await supabase
        .from('chat_room_participants')
        .select('room_id')
        .eq('user_id', socket.data.userId)
        .in('room_id', roomIds);
      if (error) throw new Error();

      const validRoomIds = membership?.map((room) => room.room_id) ?? [];

      socket.join(validRoomIds);
    } catch (error) {
      console.error(error);
    }
  });
}
