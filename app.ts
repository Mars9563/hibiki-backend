import express from 'express';
import friendshipsRouter from './routes/friendships.js';
import roomsRouter from './routes/rooms.js';
import personalInfoRouter from './routes/personalUser.js';
import messagesRouter from './routes/userMessages.js';
import groupsRouter from './routes/groups.js';
import cors from 'cors';
const app = express();

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  })
);
app.use(express.json());
app.use('/api/friendships', friendshipsRouter);
app.use('/api', roomsRouter);
app.use('/api/personal', personalInfoRouter);
app.use('/api', messagesRouter);
app.use('/api/', groupsRouter);

app.get('/', (req, res) => {
  res.send('Hibiki backend is alive');
});
export default app;
