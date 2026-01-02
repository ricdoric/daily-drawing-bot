import {
  ChatInputCommandInteraction,
  MessageFlags,
  ChannelType,
  ForumChannel,
} from "discord.js";

export async function handleDailyBotDebugCommand(
  interaction: ChatInputCommandInteraction,
  adminUsers: string[],
  forumChannelName: string,
  chatChannelName: string | undefined
) {
  try {
    // Check if user is in admin list
    if (!adminUsers.includes(interaction.user.id)) {
      return interaction.reply({
        content: "You do not have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({
        content: "This command can only be used in a guild.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Find the forum channel
    let latestThreadTitle = "No forum channel found or no threads";
    const forumChannel = guild.channels.cache.find(
      (ch) => ch.name === forumChannelName && ch.type === ChannelType.GuildForum
    ) as ForumChannel | undefined;

    if (forumChannel) {
      try {
        // Fetch threads from the forum channel
        const threads = await forumChannel.threads.fetchActive();
        
        if (threads.threads.size > 0) {
          // Get the most recent thread by creation timestamp
          const sortedThreads = Array.from(threads.threads.values()).sort(
            (a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0)
          );
          latestThreadTitle = sortedThreads[0].name;
        } else {
          latestThreadTitle = "No active threads found";
        }
      } catch (e) {
        console.error("Error fetching threads:", e);
        latestThreadTitle = "Error fetching threads";
      }
    }

    const debugInfo = [
      `**Debug Information**`,
      ``,
      `**Forum Channel Name:** ${forumChannelName}`,
      `**Chat Channel Name:** ${chatChannelName || "Not set"}`,
      `**Latest Thread Title:** ${latestThreadTitle}`,
    ].join("\n");

    await interaction.reply({
      content: debugInfo,
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    console.error("Error in debug command:", e);
    await interaction.reply({
      content: "An error occurred while running the debug command.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
