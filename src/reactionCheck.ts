import { Message, GuildMember, PermissionsBitField } from "discord.js";

const modRoles: string[] = process.env.MOD_ROLES ? process.env.MOD_ROLES.split(",").map((r) => r.trim()) : [];

/**
 * Check if a message is marked as overtime (timer emoji reacted by the author).
 * Returns true if the author reacted with any timer emoji variant.
 */
async function isMarkedOvertime(reply: Message<true>): Promise<boolean> {
  try {
    for (const reactCheck of reply.reactions.cache.values()) {
      try {
        const name = reactCheck.emoji.name;
        const isTimerEmoji =
          name === "⏱️" ||
          name === "⏲️" ||
          (name && name.toLowerCase().includes("timer")) ||
          (name && name.toLowerCase().includes("stopwatch"));

        if (!isTimerEmoji) continue;

        // check if author reacted with timer on their own drawing
        const usersForTimer = await reactCheck.users.fetch();
        if (usersForTimer.has(reply.author?.id ?? "")) {
          return true;
        }

        // check if timer reactor has mod permission, mark overtime if so
        for (const user of usersForTimer.values()) {
          const member = await reply.guild.members.fetch(user.id).catch(() => null);
          if (userHasModPermission(member)) {
            return true;
          }
        }
      } catch (e) {
        // Ignore individual reaction fetch errors
      }
    }
  } catch (e) {
    console.error("Error checking for overtime marker:", e);
  }
  return false;
}

/**
 * Count unique users (excluding bots and the author) who reacted with fire emoji.
 * Returns the count of unique fire reactors.
 */
async function countFireReactors(reply: Message<true>): Promise<number> {
  try {
    let uniqueUserIds = new Set<string>();
    for (const reaction of reply.reactions.cache.values()) {
      try {
        const emojiName = reaction.emoji.name;
        if (emojiName !== "🔥" && emojiName?.toLowerCase() !== "fire") continue;
        const users = await reaction.users.fetch();
        users.forEach((user) => {
          if (!user.bot && user.id !== (reply.author?.id ?? "")) uniqueUserIds.add(user.id);
        });
      } catch (e) {
        // Ignore fetch errors for individual reactions
      }
    }
    return uniqueUserIds.size;
  } catch (e) {
    console.error("Error counting fire reactors:", e);
    return 0;
  }
}

/**
 * Check if a user has mod permissions (either specified mod role or kick permission).
 */
function userHasModPermission(member: GuildMember | null): boolean {
  if (!member) return false;

  // Check for kick permission
  const canKick = member.permissions?.has?.(PermissionsBitField.Flags?.KickMembers ?? 0);
  if (canKick) return true;

  // Check for admin
  const isAdmin = member.permissions?.has?.(PermissionsBitField.Flags?.Administrator ?? 0);
  if (isAdmin) return true;

  // Check for mod roles
  if (modRoles.length > 0) {
    for (const role of member.roles.cache.values()) {
      if (modRoles.includes(role.id) || modRoles.includes(role.name)) {
        return true;
      }
    }
  }

  return false;
}

export { isMarkedOvertime, countFireReactors, userHasModPermission };