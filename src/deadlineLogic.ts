import { AnyThreadChannel, ChannelType, ForumChannel, Guild } from "discord.js";
import { podiumArtist } from "./types";
import { countFireReactors, isMarkedOvertime } from "./reactionCheck";
import { getUser, updateUser } from "./database";
import { buildRulesMessage, isImageMessage } from "./util";


export async function calculateTopThreeDrawings(guild: Guild, forumChannelName: string): Promise<podiumArtist[]> {
  // Logic to calculate top three drawings based on votes
  let topThree: podiumArtist[] = [];

  try {
    const forum = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildForum && ch.name === forumChannelName) as ForumChannel | undefined;
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

    const { winnerThemeTitle, winnerThemeDescription } = getUser(winnerObj.id, guild.id);

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
export async function createForumPost(guild: Guild, forumChannelName: string, winner: podiumArtist): Promise<string | null> {
  try {
    let newPostId: string | null = null;
    const winnerId = winner.id
    if (winnerId) {
      const saved = getUser(winnerId, guild.id);
      if (saved && saved.themeTitle) {
        const forum = guild.channels.cache.find(
          (ch) => ch.type === 15 && ch.name === forumChannelName
        ) as ForumChannel | undefined;
        const body = `${saved.themeDescription || ""}\n\nTheme by: <@${winnerId}>\n\n${buildRulesMessage()}`;
        if (forum) {
          try {
            const thread = await (forum as any).threads.create({ name: saved.themeTitle, message: { content: body, allowedMentions: { users: [] } } });
            newPostId = thread.id;
            console.log(`Created forum post for saved theme '${saved.themeTitle}' in guild ${guild.id}`);
          } catch (e) {
            console.error("Failed to create forum post for theme:", e);
          }
        } else {
          console.log(`Forum channel '${forumChannelName}' not found in guild ${guild.id} while creating theme post.`);
        }

        // Clear the user's saved theme
        try {
          updateUser(winnerId, guild.id, { themeTitle: null, themeDescription: null, themeTimestampUTC: null });
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

// Helpers


