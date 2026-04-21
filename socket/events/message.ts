import { Server, Socket } from 'socket.io';
import { createUserClient } from '../../config/supabase.js';

export function messageEvents(io: Server, socket: Socket) {
  socket.on('message:send', async (incomingMessage) => {
    try {
      // Basic auth guard
      if (!socket.data?.userId || !socket.data?.userJWT) {
        return socket.emit('message:error', { error: 'Unauthorized' });
      }

      if (
        !incomingMessage ||
        typeof incomingMessage.room_id !== 'string' ||
        typeof incomingMessage.content !== 'string' ||
        typeof incomingMessage.clientTempId !== 'string'
      ) {
        return socket.emit('message:error', { error: 'Invalid payload' });
      }

      const content = incomingMessage.content.trim();

      // Content validation
      if (content.length === 0) {
        return socket.emit('message:error', {
          error: 'Message cannot be empty',
        });
      }

      if (content.length > 65536) {
        return socket.emit('message:error', { error: 'Message too long' });
      }

      const supabase = createUserClient(socket.data.userJWT);

      const { data: message, error } = await supabase
        .from('messages')
        .insert({
          sender_id: socket.data.userId,
          room_id: incomingMessage.room_id,
          content: content,
        })
        .select()
        .single();

      if (error || !message) {
        console.error(error);
        return socket.emit('message:error', {
          error: 'Failed to send message',
          clientTempId: incomingMessage.clientTempId,
        });
      }

      io.to(incomingMessage.room_id).emit('message:new', {
        message,
        clientTempId: incomingMessage.clientTempId,
      });
    } catch (err) {
      console.error(err);
      socket.emit('message:error', { error: 'Server error' });
    }
  });
}
