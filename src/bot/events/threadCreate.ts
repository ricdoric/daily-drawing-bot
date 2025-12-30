import { ThreadChannel } from "discord.js";
import { buildRulesMessage } from "../../util";
import { getOrCreateGuild } from "../../database";

export async function handleThreadCreate(thread: ThreadChannel, hardcodedForumChannelName: string) {
  try {
    // If the thread was created by the bot, do nothing
    if (thread.ownerId && thread.client.user && thread.ownerId === thread.client.user.id) return;

    const parentName = (thread.parent as any)?.name;
    if (parentName !== hardcodedForumChannelName) return;

    // Ensure guild record exists
    if (thread.guild) {
      getOrCreateGuild(thread.guild.id, thread.guild.name);
    }

    const rules = buildRulesMessage();
    try {
      await (thread as any).send(rules);
      console.log(`Posted rules in new thread under '${hardcodedForumChannelName}': ${thread.id}`);
    } catch (e) {
      console.error("Failed to post rules message in new thread:", e);
    }
  } catch (err) {
    console.error("Error handling threadCreate:", err);
  }
  return;
}
