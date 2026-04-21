import 'dotenv/config';
import { createServer } from 'node:http';
import app from './app.js';
import { initSocket } from './socket/index.js';

const PORT = process.env.PORT ?? 8080;
console.log('ENV CHECK:', {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_PUBLISHABLE_KEY,
});

const server = createServer(app);

initSocket(server);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
