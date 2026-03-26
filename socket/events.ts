import { Server, Socket } from 'socket.io';
import { messageEvents } from './events/message.js';
import { roomJoinEvents } from './events/rooms.js';

export function registerSocketEvents(io: Server, socket: Socket) {
  // all the room joining events go in this function.
  roomJoinEvents(io, socket);
  // all the message related events go in this function.
  messageEvents(io, socket);
}
