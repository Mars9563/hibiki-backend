import { Socket } from 'socket.io';
import { supabase } from '../config/supabase.js';

export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Unauthorized: No token found.'));
    }
    const { data, error } = await supabase.auth.getUser(token);

    if (error) {
      console.error('Supabase auth error:', error);
      return next(new Error('Unauthorized: Invalid token'));
    }

    socket.data.userId = data.user.id;
    socket.data.userJWT = token;

    next();
  } catch (error) {
    console.log(error);
    return next(new Error('Authentication failed.'));
  }
}
