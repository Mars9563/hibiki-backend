// ============================================================
// services/room.service.ts
// Group-room business logic, kept out of routes/groups.ts so the
// route stays a thin HTTP <-> service translation layer.
//
// Trust-boundary rule (see groups RLS design notes): every write
// that touches chat_rooms or chat_room_participants goes through
// supabaseSuperUser, because neither table has an INSERT policy
// for normal users. group_invites DOES have working INSERT/UPDATE
// policies, so those two specific writes use the user-scoped
// client instead — least privilege where it's actually available.
//
// group_invites has NO DELETE policy at all, so reject must also
// go through supabaseSuperUser (this mirrors a real bug found in
// the existing friendships/reject route, which deletes via the
// user-scoped client with no DELETE policy present — that delete
// is very likely a silent no-op in production today. Not fixing
// that route here; just making sure groups doesn't repeat it).
// ============================================================
import { createUserClient, supabaseSuperUser } from '../config/supabase.js';

export class GroupServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Shared by createGroup and acceptGroupInvite — both need to hand a
// group room straight to a single client in the exact shape
// GET /api/rooms produces (roomId/roomType/members[]/etc), NOT the
// bare chat_rooms row. Keeping this in one place avoids the two call
// sites silently drifting into two different "what is a group room"
// shapes over time.
async function getEnrichedGroupRoom(roomId: string, forUserId: string) {
  const { data: room, error: roomError } = await supabaseSuperUser
    .from('chat_rooms')
    .select('id, name, avatar_url')
    .eq('id', roomId)
    .single();

  if (roomError || !room) {
    throw new GroupServiceError(500, 'Failed to load group');
  }

  const { data: participants, error: participantsError } =
    await supabaseSuperUser
      .from('chat_room_participants')
      .select('user_id, role')
      .eq('room_id', roomId);

  if (participantsError) {
    throw new GroupServiceError(500, 'Failed to load group members');
  }

  const memberIds = (participants ?? []).map((p) => p.user_id);
  const { data: profiles, error: profilesError } = await supabaseSuperUser
    .from('profiles')
    .select('id, username, full_name, avatar_url')
    .in(
      'id',
      memberIds.length > 0
        ? memberIds
        : ['00000000-0000-0000-0000-000000000000']
    );

  if (profilesError) {
    throw new GroupServiceError(500, 'Failed to load group members');
  }

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const roleByUserId = new Map(
    (participants ?? []).map((p) => [p.user_id, p.role])
  );

  const members = (participants ?? [])
    .map((p) => {
      const profile = profileMap.get(p.user_id);
      if (!profile) return null;
      return {
        id: profile.id,
        username: profile.username,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url,
        role: p.role,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return {
    roomId: room.id,
    roomType: 'group' as const,
    currentUserId: forUserId,
    currentUserRole: (roleByUserId.get(forUserId) ?? 'member') as
      | 'admin'
      | 'member',
    name: room.name as string,
    avatarUrl: room.avatar_url as string | null,
    members,
  };
}

type CreateGroupParams = {
  creatorId: string;
  creatorJWT: string;
  name: string;
  inviteeIds: string[];
};

export async function createGroup({
  creatorId,
  creatorJWT,
  name,
  inviteeIds,
}: CreateGroupParams) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new GroupServiceError(400, 'Group name is required');
  }

  // De-dupe and drop the creator if they somehow got included —
  // they're added as a participant directly, never via invite.
  const uniqueInvitees = [...new Set(inviteeIds)].filter(
    (id) => id !== creatorId
  );

  // 1️⃣ Create the room (service role — no INSERT policy on chat_rooms
  // for normal users, same constraint the direct-room path already
  // works around). Name must be set in this same insert — the
  // chat_rooms_name_matches_type check constraint requires a non-empty
  // name on any row with type = 'group' at insert time, so a bare
  // insert-then-update sequence violates it before the update runs.
  const { data: room, error: roomError } = await supabaseSuperUser
    .from('chat_rooms')
    .insert({ type: 'group', name: trimmedName })
    .select()
    .single();

  if (roomError || !room) {
    console.error('createGroup room insert error:', roomError);
    throw new GroupServiceError(500, 'Failed to create group');
  }

  // 2️⃣ Add the creator as the sole initial participant, role admin.
  // Everyone else joins only by accepting an invite — there is no
  // "direct add" path, even at creation time.
  const { error: participantError } = await supabaseSuperUser
    .from('chat_room_participants')
    .insert({ room_id: room.id, user_id: creatorId, role: 'admin' });

  if (participantError) {
    console.error('createGroup participant insert error:', participantError);
    throw new GroupServiceError(500, 'Failed to create group');
  }

  // 4️⃣ Insert invite rows for everyone else (user-scoped client —
  // group_invites already has a working INSERT policy for inviter_id).
  const userClient = createUserClient(creatorJWT);
  let invites: { id: string; invitee_id: string }[] = [];

  if (uniqueInvitees.length > 0) {
    const { data: insertedInvites, error: inviteError } = await userClient
      .from('group_invites')
      .insert(
        uniqueInvitees.map((inviteeId) => ({
          room_id: room.id,
          inviter_id: creatorId,
          invitee_id: inviteeId,
          status: 'pending',
        }))
      )
      .select('id, invitee_id');

    if (inviteError) {
      // Room already exists with the creator in it at this point —
      // we don't roll that back. The group simply exists with zero
      // pending invites and the creator can re-invite from the group
      // settings UI once it's built. Surfacing this as a 500 would be
      // misleading since the group itself was created successfully.
      console.error('createGroup invite insert error:', inviteError);
      throw new GroupServiceError(
        207,
        'Group created, but some invites failed to send'
      );
    }

    invites = insertedInvites ?? [];
  }

  // Return the enriched shape (roomId/roomType/members[]/etc) — same
  // contract as acceptGroupInvite, so the frontend's upsertRoom() can
  // consume either response identically with no translation step. At
  // this point the only member is the creator, so this resolves to a
  // single-element members array with role 'admin'.
  const enrichedRoom = await getEnrichedGroupRoom(room.id, creatorId);

  return {
    room: enrichedRoom,
    invites,
  };
}

type InviteToGroupParams = {
  roomId: string;
  inviterId: string;
  inviterJWT: string;
  inviteeId: string;
};

export async function inviteToGroup({
  roomId,
  inviterId,
  inviterJWT,
  inviteeId,
}: InviteToGroupParams) {
  if (inviteeId === inviterId) {
    throw new GroupServiceError(400, 'Cannot invite yourself');
  }

  const userClient = createUserClient(inviterJWT);

  // Confirm the inviter is actually an admin of this room. Membership
  // SELECT is already scoped correctly post-RLS-fix, so this query is
  // safe on the user-scoped client.
  const { data: membership, error: membershipError } = await userClient
    .from('chat_room_participants')
    .select('role')
    .eq('room_id', roomId)
    .eq('user_id', inviterId)
    .maybeSingle();

  if (membershipError) {
    console.error('inviteToGroup membership check error:', membershipError);
    throw new GroupServiceError(500, 'Server error');
  }

  if (!membership) {
    throw new GroupServiceError(403, 'You are not a member of this group');
  }

  if (membership.role !== 'admin') {
    throw new GroupServiceError(403, 'Only admins can invite members');
  }

  // Guard: already a participant?
  const { data: existingParticipant } = await userClient
    .from('chat_room_participants')
    .select('user_id')
    .eq('room_id', roomId)
    .eq('user_id', inviteeId)
    .maybeSingle();

  if (existingParticipant) {
    throw new GroupServiceError(409, 'User is already in this group');
  }

  // Guard: already has a pending invite?
  const { data: existingInvite } = await userClient
    .from('group_invites')
    .select('id')
    .eq('room_id', roomId)
    .eq('invitee_id', inviteeId)
    .eq('status', 'pending')
    .maybeSingle();

  if (existingInvite) {
    throw new GroupServiceError(409, 'User already has a pending invite');
  }

  const { data: invite, error: inviteError } = await userClient
    .from('group_invites')
    .insert({
      room_id: roomId,
      inviter_id: inviterId,
      invitee_id: inviteeId,
      status: 'pending',
    })
    .select()
    .single();

  if (inviteError || !invite) {
    console.error('inviteToGroup insert error:', inviteError);
    throw new GroupServiceError(500, 'Failed to send invite');
  }

  return invite;
}

type AcceptInviteParams = {
  inviteId: string;
  inviteeId: string;
  inviteeJWT: string;
};

export async function acceptGroupInvite({
  inviteId,
  inviteeId,
  inviteeJWT,
}: AcceptInviteParams) {
  const userClient = createUserClient(inviteeJWT);

  // Confirm the invite exists, belongs to this user, and is pending.
  const { data: invite, error } = await userClient
    .from('group_invites')
    .select('id, room_id, invitee_id, status')
    .eq('id', inviteId)
    .eq('invitee_id', inviteeId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) {
    console.error('acceptGroupInvite lookup error:', error);
    throw new GroupServiceError(500, 'Server error');
  }

  if (!invite) {
    throw new GroupServiceError(404, 'No such pending invite found');
  }

  // Flip status (user-scoped client — group_invites UPDATE policy
  // already allows invitee_id = auth.uid()).
  const { error: updateError } = await userClient
    .from('group_invites')
    .update({ status: 'accepted' })
    .eq('id', invite.id)
    .eq('status', 'pending');

  if (updateError) {
    console.error('acceptGroupInvite update error:', updateError);
    throw new GroupServiceError(500, 'Failed to accept invite');
  }

  // Add as participant — service role, no INSERT policy on
  // chat_room_participants for normal users.
  const { error: participantError } = await supabaseSuperUser
    .from('chat_room_participants')
    .upsert(
      { room_id: invite.room_id, user_id: inviteeId, role: 'member' },
      { onConflict: 'room_id,user_id', ignoreDuplicates: true }
    );

  if (participantError) {
    console.error(
      'acceptGroupInvite participant insert error:',
      participantError
    );
    throw new GroupServiceError(500, 'Failed to join group');
  }

  // Fetch the full enriched room (roomId/roomType/members[]/etc — the
  // exact shape GET /api/rooms produces) so the caller can hand it
  // straight to the frontend and upsertRoom() works without any
  // shape translation on the client side.
  const room = await getEnrichedGroupRoom(invite.room_id, inviteeId);

  return room;
}

type RejectInviteParams = {
  inviteId: string;
  inviteeId: string;
};

export async function rejectGroupInvite({
  inviteId,
  inviteeId,
}: RejectInviteParams) {
  // group_invites has no DELETE policy for any user, so this must go
  // through the service role — using the user-scoped client here would
  // silently no-op (0 rows deleted, no error thrown), exactly like the
  // suspected bug in friendships/reject. We still scope the delete by
  // invitee_id ourselves so a server-side bug elsewhere can't delete
  // the wrong row.
  const { data: invite, error } = await supabaseSuperUser
    .from('group_invites')
    .select('id, invitee_id, status')
    .eq('id', inviteId)
    .eq('invitee_id', inviteeId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) {
    console.error('rejectGroupInvite lookup error:', error);
    throw new GroupServiceError(500, 'Server error');
  }

  if (!invite) {
    throw new GroupServiceError(404, 'No such pending invite found');
  }

  // Deleted, not status-flipped, so the same admin can re-invite later
  // without tripping the UNIQUE(room_id, invitee_id) constraint.
  const { error: deleteError } = await supabaseSuperUser
    .from('group_invites')
    .delete()
    .eq('id', invite.id);

  if (deleteError) {
    console.error('rejectGroupInvite delete error:', deleteError);
    throw new GroupServiceError(500, 'Failed to reject invite');
  }
}

type GroupInviteStatusInfo = {
  userId: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  status: 'accepted' | 'pending';
};

// Used only by GET /api/group-invites/pending, to let a PENDING
// INVITEE see who else is already in / invited to a group they
// haven't joined yet. RLS deliberately blocks this for both tables
// (chat_room_participants requires existing membership; group_invites
// only exposes rows where you're the inviter or that specific
// invitee) — so this is a narrow, read-only exception that goes
// through supabaseSuperUser and returns ONLY display-safe fields,
// never raw invite rows, tokens, or anything else.
export async function getGroupRosterForInvitee(roomId: string) {
  const { data: participants, error: participantsError } =
    await supabaseSuperUser
      .from('chat_room_participants')
      .select('user_id')
      .eq('room_id', roomId);

  if (participantsError) {
    throw new GroupServiceError(500, 'Failed to load group roster');
  }

  // Only the most recent pending invite per invitee matters here —
  // rejected invites are deleted outright (see rejectGroupInvite), so
  // any row still present that isn't 'accepted' is, by construction,
  // pending.
  const { data: invites, error: invitesError } = await supabaseSuperUser
    .from('group_invites')
    .select('invitee_id, status')
    .eq('room_id', roomId);

  if (invitesError) {
    throw new GroupServiceError(500, 'Failed to load group roster');
  }

  const memberIds = (participants ?? []).map((p) => p.user_id);
  const pendingIds = (invites ?? [])
    .filter((i) => i.status === 'pending')
    .map((i) => i.invitee_id);

  const allIds = [...new Set([...memberIds, ...pendingIds])];

  const { data: profiles, error: profilesError } = await supabaseSuperUser
    .from('profiles')
    .select('id, username, full_name, avatar_url')
    .in(
      'id',
      allIds.length > 0 ? allIds : ['00000000-0000-0000-0000-000000000000']
    );

  if (profilesError) {
    throw new GroupServiceError(500, 'Failed to load group roster');
  }

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const memberIdSet = new Set(memberIds);

  const roster: GroupInviteStatusInfo[] = allIds
    .map((id) => {
      const profile = profileMap.get(id);
      if (!profile) return null;
      return {
        userId: profile.id,
        username: profile.username,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url,
        status: memberIdSet.has(id)
          ? ('accepted' as const)
          : ('pending' as const),
      };
    })
    .filter((r): r is GroupInviteStatusInfo => r !== null);

  return roster;
}