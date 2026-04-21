# Hibiki — Client

The frontend for Hibiki, a real-time messaging app. Built with Next.js and Socket.IO, using Supabase for authentication.

---

## Tech Stack

- **Framework** — Next.js 15 (App Router)
- **Language** — TypeScript
- **Auth** — Supabase (client + server-side)
- **Real-time** — Socket.IO client
- **State Management** — Zustand
- **Data Fetching** — TanStack Query
- **Forms** — React Hook Form + Zod
- **UI** — Custom pixel-art component library (Pixelact UI)

---

## Project Structure

```
client/
├── app/
│   ├── layout.tsx              # Root layout (fonts, theme, toast)
│   ├── globals.css
│   ├── (auth)/
│   │   ├── login/page.tsx      # Login page
│   │   └── register/page.tsx   # Register page
│   ├── (app)/
│   │   ├── layout.tsx          # Protected layout (auth guard + user data fetch)
│   │   └── page.tsx            # Main chat page
│   └── api/
│       ├── rooms/route.ts      # Proxy → backend /api/rooms
│       ├── messages/route.ts   # Proxy → backend /api/messages
│       └── friendships/
│           ├── request/        # Proxy → POST /api/friendships/request
│           ├── accept/         # Proxy → POST /api/friendships/accept
│           ├── reject/         # Proxy → DELETE /api/friendships/reject
│           ├── pending/        # Proxy → GET /api/friendships/pending
│           └── search/         # Proxy → GET /api/friendships/search
├── components/
│   ├── auth/
│   │   ├── login-form.tsx      # Login form (email + password)
│   │   └── register.tsx        # Register form (name, username, email, password)
│   └── ui/
│       ├── pixelact-ui/        # Custom pixel-art UI components
│       └── ...                 # Shadcn-based utility components
├── features/
│   └── chat/
│       ├── layout/
│       │   ├── ChatLayout.tsx          # Top-level chat layout (sidebar + list + area)
│       │   └── ViewListContainer.tsx   # Switches between rooms, requests, user panel
│       ├── sidebar/
│       │   └── Sidebar.tsx             # Icon sidebar (navigation + logout)
│       ├── ui/
│       │   ├── ChatArea.tsx            # Right panel (topbar + messages + input)
│       │   ├── TopBar.tsx              # Chat header with other user's info
│       │   ├── MessageArea.tsx         # Scrollable message list with date separators
│       │   ├── MessageBubble.tsx       # Individual message bubble (with status icons)
│       │   ├── ChatInput.tsx           # Message input with optimistic send
│       │   ├── useMessages.tsx         # Zustand store for all messages
│       │   └── dateSeperator.tsx       # Date separator between messages
│       ├── rooms/                      # Rooms list panel
│       ├── requests/                   # Friend requests panel
│       ├── userpanel/                  # User settings panel
│       ├── context/
│       │   └── chat-ui-context.tsx     # View mode + selected room context
│       └── socket/
│           └── ChatSocketSync.tsx      # Listens to socket events, syncs to store
├── providers/
│   ├── toast-provider.tsx      # Sonner toast setup
│   ├── theme-provider.tsx      # next-themes dark/light mode
│   ├── query-provider.tsx      # TanStack Query client
│   ├── socket-provider.tsx     # Socket.IO connection lifecycle
│   └── user-provider.tsx       # Logged-in user context
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # Supabase browser client
│   │   └── server.ts           # Supabase server client (for RSC + middleware)
│   ├── socket.ts               # Socket.IO client instance
│   └── types.ts                # Shared TypeScript types
└── server/
    └── actions/
        └── auth/
            └── register.ts     # Server action for user registration
```

---

## How It Works

### Authentication

Auth is handled entirely by Supabase. On login/register, Supabase sets a session cookie. The protected `(app)` layout checks this cookie server-side and redirects to `/login` if no valid session is found.

### API Proxy Pattern

The client never calls the backend directly from the browser. Instead, all backend calls go through Next.js API routes (`app/api/...`), which:
1. Verify the Supabase session server-side
2. Extract the access token
3. Forward the request to the backend with the token attached

This keeps the backend URL and token handling off the client entirely.

### Real-time Messaging

On load, the app connects to the backend Socket.IO server using the Supabase access token for auth. It then:
1. Joins all of the user's rooms via `rooms:joinMany`
2. Listens for `message:new` events and updates the Zustand store
3. On send, adds an optimistic message instantly, then swaps it with the real one when the server confirms

### Message Status Icons

Each message bubble shows a status indicator (visible only on your own messages):
- `🕐` Pending — sent to server, awaiting confirmation
- `✓` Sent — confirmed by server
- `✓✓` Received — delivered to the room

---

## Environment Variables

Create a `.env.local` file in the client root:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
BACKEND_BASE_URL=http://localhost:5000
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=your-cloud-name
NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET=hibiki_avatars
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key |
| `BACKEND_BASE_URL` | Backend URL for server-side fetch calls. Use `http://localhost:5000` locally, your Fly.io URL in production. Not exposed to the browser. |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for avatar uploads |
| `NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET` | Cloudinary upload preset configured for avatar images |

In production, set `BACKEND_BASE_URL` to your deployed Fly.io backend URL (e.g. `https://hibiki-server.fly.dev`).

---

## Running Locally

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

App will be available at `http://localhost:3000`.

Make sure the backend is also running locally at port `5000` before testing the chat features.

---

## Deployment (Vercel)

The client is a standard Next.js app and deploys to Vercel with zero configuration:

1. Push to GitHub
2. Import the repo on [vercel.com](https://vercel.com)
3. Add the environment variables in the Vercel dashboard:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `BACKEND_BASE_URL` → your Fly.io backend URL (e.g. `https://hibiki-server.fly.dev`)
   - `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`
   - `NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET`
4. Deploy
