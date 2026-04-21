# Hibiki — Server

The backend for Hibiki, a real-time messaging app. Built with Express and Socket.IO, using Supabase as the database and auth provider.

---

## Tech Stack

- **Runtime** — Node.js with TypeScript (via `tsx`)
- **Framework** — Express v5
- **Real-time** — Socket.IO
- **Database & Auth** — Supabase
- **Validation** — Zod

---

## Project Structure

```
server/
├── config/
│   └── supabase.ts         # Supabase client setup (anon + service role)
├── middleware/
│   └── auth.ts             # JWT auth middleware for HTTP routes
├── routes/
│   ├── friendships.ts      # Friend requests, accept, reject, search
│   ├── rooms.ts            # Fetch user's chat rooms
│   ├── personalUser.ts     # Fetch the logged-in user's profile
│   └── userMessages.ts     # Fetch messages for given rooms
├── socket/
│   ├── index.ts            # Socket.IO server init
│   ├── auth.ts             # Socket JWT auth middleware
│   ├── events.ts           # Registers all socket event handlers
│   └── events/
│       ├── message.ts      # message:send event
│       └── rooms.ts        # room:join, rooms:joinMany events
├── services/               # (reserved for future service layer)
├── app.ts                  # Express app setup, CORS, routes
├── index.ts                # Entry point, starts HTTP + Socket server
└── package.json
```

---

## API Routes

All routes are protected by JWT auth middleware. The token must be passed as a `Bearer` token in the `Authorization` header.

### Friendships — `/api/friendships`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search?q=username` | Search for users to add (min 2 chars) |
| `GET` | `/pending` | Get all pending friend requests (sent and received) |
| `POST` | `/request` | Send a friend request `{ targetUserId }` |
| `POST` | `/accept` | Accept a friend request `{ targetId }` |
| `DELETE` | `/reject` | Reject a friend request `{ targetId }` |

### Rooms — `/api`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rooms` | Get all direct chat rooms for the logged-in user |

### Messages — `/api`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/messages?roomIds=[...]` | Fetch all messages for the given room IDs (JSON array as query string) |

### Personal — `/api/personal`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/me` | Get the logged-in user's profile |

---

## Socket Events

The socket connection requires a valid Supabase JWT passed in the handshake:
```js
const socket = io(SERVER_URL, {
  auth: { token: supabaseAccessToken }
});
```

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ roomId: string }` | Join a specific chat room (membership is verified) |
| `rooms:joinMany` | `{ roomIds: string[] }` | Join multiple rooms at once |
| `message:send` | `{ room_id, content, clientTempId }` | Send a message to a room |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ success, roomId }` | Confirms you have joined a room |
| `room:unauthorized` | `{ error, roomId }` | You are not a participant of that room |
| `room:error` | `{ error }` | Generic room error |
| `message:new` | `{ message, clientTempId }` | A new message was received in a room |
| `message:error` | `{ error, clientTempId? }` | Message failed to send |
| `friendship:requested` | `{ to }` | Emitted to sender when a request is sent |
| `friendship:got_a_request` | `{ from }` | Emitted to receiver when a request arrives |
| `friendship:accepted` | `{ room }` | Emitted to both users when a request is accepted |
| `friendship:rejected` | `{ by }` | Emitted to sender when their request is rejected |

---

## Environment Variables

Create a `.env` file in the server root:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ALLOWED_ORIGIN=http://localhost:3000
PORT=5000
```

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — used for privileged operations like creating chat rooms on friendship accept |
| `ALLOWED_ORIGIN` | Frontend URL allowed by CORS. Use `http://localhost:3000` locally, your Vercel URL in production |
| `PORT` | Port to listen on. Defaults to `5000` locally. Set automatically by Fly.io in production. |

---

## Running Locally

```bash
# Install dependencies
npm install

# Start in dev mode (auto-restarts on file changes)
npm run dev
```

Server will start at `http://localhost:5000`.

---
