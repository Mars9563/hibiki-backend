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
  // works around).
  const { data: room, error: roomError } = await supabaseSuperUser
    .from('chat_rooms')
    .insert({ type: 'group' })
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

  // 3️⃣ We also need a `name` column to exist for groups to be
  // displayable — see migration note below. For now this function
  // assumes `chat_rooms.name` exists; if it doesn't yet, this update
  // will simply no-op on a non-existent column and Postgres will error,
  // which is the signal to run the migration first.
  const { error: nameError } = await supabaseSuperUser
    .from('chat_rooms')
    .update({ name: trimmedName })
    .eq('id', room.id);

  if (nameError) {
    console.error('createGroup name update error:', nameError);
    throw new GroupServiceError(500, 'Failed to set group name');
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

  return {
    room: { ...room, name: trimmedName, type: 'group' as const },
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

  // Fetch the full room so the caller can hand it straight to the
  // frontend (same "return a fully-formed object" pattern as
  // friendships/accept).
  const { data: room, error: roomError } = await supabaseSuperUser
    .from('chat_rooms')
    .select('*')
    .eq('id', invite.room_id)
    .single();

  if (roomError || !room) {
    console.error('acceptGroupInvite room fetch error:', roomError);
    throw new GroupServiceError(500, 'Joined group but failed to load it');
  }

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
