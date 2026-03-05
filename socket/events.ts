import { Server, Socket } from 'socket.io';
import { createUserClient } from '../config/supabase.js';
import z from 'zod';

const joinData = z.object({
  roomId: z.string().nonoptional(),
});

export function registerSocketEvents(io: Server, socket: Socket) {
  socket.on('chat message', (msg: string) => {
    io.emit('chat message', {
      id: socket.id,
      message: msg,
    });
  });
  socket.on('room:join', async (rawData) => {
    console.log('hello i am a joined room');
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
}
