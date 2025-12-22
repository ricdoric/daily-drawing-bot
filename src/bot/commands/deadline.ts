import { AnyThreadChannel, ChannelType, ChatInputCommandInteraction, ForumChannel, Guild, MessageFlags, TextChannel } from "discord.js";
import { buildRulesMessage, isImageMessage, userHasModPermission } from "../../util";
import { getOrCreateGuild, getUser, updateUser } from "../../database";
import { podiumArtist } from "../../types";
import { countFireReactors, isMarkedOvertime } from "../../reactionCheck";

// Testing command, this will be replaced with a timed action with node-cron
export async function handleDailyDeadlineCommand(
  interaction: ChatInputCommandInteraction,
  forumChannelName?: string,
  chatChannelName?: string
) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });

    // Ensure guild record exists
    getOrCreateGuild(guild.id, guild.name);

    const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!invoker)
      return interaction.reply({
        content: "Unable to verify your permissions.",
        flags: MessageFlags.Ephemeral,
      });
    if (!userHasModPermission(invoker)) {
      return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });
    }
    const forum = guild.channels.cache.find(
      (ch) => ch.type === 15 && ch.name === forumChannelName // 15 = GuildForum
    ) as ForumChannel | undefined;
    if (!forum)
      return interaction.reply({
        content: `Forum channel '${forumChannelName}' not found.`,
        flags: MessageFlags.Ephemeral,
      });
    await deadlineResults(guild, forumChannelName, chatChannelName);
    await interaction.reply({ content: "Deadline results processed.", flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(err);
    await interaction.reply({
      content: "An error occurred while computing the deadline results.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function deadlineResults(guild: Guild, forumChannelName?: string, chatChannelName?: string) {
  console.log(`Posting results to chat channel`);
  try {
    // Calculate the top three
    const topThree: podiumArtist[] = await calculateTopThreeDrawings(guild, forumChannelName!);
    // If winner has saved theme, create forum post
    if (topThree.length === 0 || topThree[0].id === "none") {
      console.log(`No drawing entries found for guild ${guild.id}`);
      return;
    }
    const newPostId = await createForumPost(guild, forumChannelName!, topThree[0]);

    // Build the results message
    const result = await buildDeadlineResultsMessage(guild, topThree, newPostId);
    if (!result) {
      console.log(`No results to announce for guild ${guild.id}`);
      return;
    }
    const content = result.content;
    const chat = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name === chatChannelName
    ) as TextChannel | undefined;
    if (!chat) {
      console.log(`Chat channel '${chatChannelName}' not found in guild ${guild.id}`);
      return;
    }
    try {
      await chat.send({ content, allowedMentions: { users: result.mentionIds } });
      console.log(`Posted daily results in guild ${guild.id} to text channel '${chatChannelName}'`);
    } catch (e) {
      console.error(`Failed to post daily results in guild ${guild.id}:`, e);
    }
  } catch (e) {
    console.error("Error running scheduled job for guild:", guild.id, e);
  }
}

export async function calculateTopThreeDrawings(
  guild: Guild,
  forumChannelName: string
): Promise<podiumArtist[]> {
  // Logic to calculate top three drawings based on votes
  let topThree: podiumArtist[] = [];

  try {
    const forum = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildForum && ch.name === forumChannelName
    ) as ForumChannel | undefined;
    if (!forum) return topThree;

    // Fetch the most recent thread (post) in the forum
    const threads = await forum.threads.fetchActive();
    const threadArr = Array.from(threads.threads.values());
    threadArr.sort((a: AnyThreadChannel, b: AnyThreadChannel) => {
      const aTime = a.createdTimestamp ?? 0;
      const bTime = b.createdTimestamp ?? 0;
      return bTime - aTime;
    });
    const latestThread = threadArr[0];
    if (!latestThread) return topThree;

    // Fetch all messages in the thread (the post and all replies)
    const allMessages = await latestThread.messages.fetch({ limit: 100 });

    // Exclude the first message (the post itself), only consider replies
    const replies = Array.from(allMessages.values()).filter((msg, idx, arr) => idx !== arr.length - 1);
    if (replies.length === 0) return topThree;

    // Compute fire-react counts per reply author (only image replies)
    const drawingEntries: { id: string; username: string; count: number }[] = [];
    for (const reply of replies) {
      const author = reply.author;
      if (!author) continue;

      // Skip non-image messages
      if (!isImageMessage(reply)) continue;

      // Skip if marked as overtime
      if (await isMarkedOvertime(reply)) continue;

      const fireCount = await countFireReactors(reply);
      drawingEntries.push({ id: author.id, username: author.username || "Unknown", count: fireCount });
    }

    // If user has multiple drawings, take the max fire count among them
    const agg = new Map<string, { id: string; username: string; count: number }>();
    for (const a of drawingEntries) {
      const prev = agg.get(a.id);
      if (prev) prev.count = Math.max(prev.count, a.count);
      else agg.set(a.id, { ...a });
    }

    const sorted = Array.from(agg.values()).sort((x, y) => y.count - x.count);

    const winner = sorted[0] ?? null;
    const second = sorted[1] ?? null;
    const third = sorted[2] ?? null;

    const winnerObj = winner ?? { id: "none", username: "none", count: 0 };
    const secondObj = second ?? { id: "none", username: "none", count: 0 };
    const thirdObj = third ?? { id: "none", username: "none", count: 0 };

    topThree = [
      { id: winnerObj.id, username: winnerObj.username, votes: winnerObj.count },
      { id: secondObj.id, username: secondObj.username, votes: secondObj.count },
      { id: thirdObj.id, username: thirdObj.username, votes: thirdObj.count },
    ];

    return topThree;
  } catch (e) {
    console.error("Error calculating top three drawings:", e);
    return topThree;
  }
}

// Create a forum post for the winning artist's saved theme
export async function createForumPost(
  guild: Guild,
  forumChannelName: string,
  winner: podiumArtist
): Promise<string | null> {
  try {
    let newPostId: string | null = null;
    const winnerId = winner.id;
    if (winnerId) {
      const saved = getUser(winnerId, guild.id);
      if (saved && saved.themeTitle) {
        const forum = guild.channels.cache.find((ch) => ch.type === 15 && ch.name === forumChannelName) as
          | ForumChannel
          | undefined;
        const body = `Theme by: <@${winnerId}>\n\n${saved.themeDescription || ""}\n\n${buildRulesMessage()}`;
        if (forum) {
          try {
            const thread = await (forum as any).threads.create({
              name: saved.themeTitle,
              message: { content: body, allowedMentions: { users: [] } },
            });
            newPostId = thread.id;
            console.log(`Created forum post for saved theme '${saved.themeTitle}' in guild ${guild.id}`);
          } catch (e) {
            console.error("Failed to create forum post for theme:", e);
          }
        } else {
          console.log(
            `Forum channel '${forumChannelName}' not found in guild ${guild.id} while creating theme post.`
          );
        }

        // Clear the user's saved theme
        try {
          updateUser(winnerId, guild.id, {
            themeTitle: null,
            themeDescription: null,
            themeTimestampUTC: null,
          });
          console.log(`Cleared saved theme for user ${winnerId} in guild ${guild.id}`);
        } catch (e) {
          console.error("Failed to clear saved theme for user:", e);
        }
      }
    }
    return newPostId;
  } catch (e) {
    console.error("Error handling saved theme after posting results:", e);
    return null;
  }
}

// Tally the votes and build the daily drawing results message embed
async function buildDeadlineResultsMessage(
  guild: Guild,
  topThree: podiumArtist[],
  newPostId: string | null
): Promise<{ content: string; winnerId: string | null; mentionIds: string[] } | null> {
  try {
    // Build a message matching the requested template
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const utcDateStr = yesterday.toLocaleDateString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const winnerDisplay = topThree[0].id !== "none" ? `<@${topThree[0].id}>` : topThree[0].username;
    const secondDisplay = topThree[1].id !== "none" ? `<@${topThree[1].id}>` : topThree[1].username;
    const thirdDisplay = topThree[2].id !== "none" ? `<@${topThree[2].id}>` : topThree[2].username;

    // Collect which users should actually be mentioned (for allowedMentions)
    const mentionSet = new Set<string>();
    if (topThree[0].id !== "none" && !newPostId) mentionSet.add(topThree[0].id);

    // Build content according to user's template
    let content = "## 15 Minute Daily Drawing Results\n";
    content += `-# ${utcDateStr}\n`;
    content += `### \`🔥 ${String(topThree[0].votes).padStart(2, " ")}\` ${winnerDisplay}\n`;
    content += `### \`🔥 ${String(topThree[1].votes).padStart(2, " ")}\` ${secondDisplay}\n`;
    content += `### \`🔥 ${String(topThree[2].votes).padStart(2, " ")}\` ${thirdDisplay}\n\n`;

    if (topThree[0].id !== "none") {
      content += `Congratulations <@${topThree[0].id}>!\n`;
      if (newPostId) {
        content += `The new theme for today is here: <#${newPostId}>\n\n`;
      } else {
        content += `Please create a forum post with a new theme!\n\n`;
      }
    }

    content += `-# Type \`/daily-theme\` at any time to save your own theme!\n`;

    const winnerId = topThree[0].id !== "none" ? topThree[0].id : null;
    return { content, winnerId, mentionIds: Array.from(mentionSet) };
  } catch (err) {
    console.error("Error computing deadline for guild:", guild.id, err);
    return null;
  }
}
