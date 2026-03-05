import { Server } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import { socketAuthMiddleware } from './auth.js';
import { registerSocketEvents } from './events.js';

let io: Server | null = null;

export function initSocket(server: HTTPServer) {
  io = new Server(server, {
    cors: {
      origin: 'http://localhost:3000',
      credentials: true,
    },
  });

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.join(`${socket.data.userId}`)

    registerSocketEvents(io!, socket);

    socket.on('disconnect', () => {
      console.log('Disconnected:', socket.id);
    });
  });
}

export function getIo(): Server {
  if (!io) {
    throw new Error('socket.io server is not initilaized.');
  }
  return io;
}