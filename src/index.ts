import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ForumChannel,
  EmbedBuilder,
  PermissionsBitField,
  AnyThreadChannel,
  MessageFlags,
} from "discord.js";
import * as dotenv from "dotenv";

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const clientId = process.env.CLIENT_ID;
const forumChannelName = process.env.FORUM_CHANNEL_NAME || "15-minute-daily-images";

if (!token || !guildId || !clientId) {
  throw new Error("Missing required environment variables.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

async function registerCommands() {
  const commands = [
    {
      name: "tally",
      description: "Count emoji reactions on the most recent forum post in 15-minute-daily-images.",
    },
    {
      name: "deadline",
      description: "Announce voting deadline and post winner, 2nd and 3rd place (by fire reactions).",
      default_member_permissions: PermissionsBitField.Flags.KickMembers.toString(),
      dm_permission: false,
    },
  ];
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationGuildCommands(clientId!, guildId!), { body: commands });
  console.log("Slash command /tally and /deadline registered.");
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "tally") {
    await handleTallyCommand(interaction);
  }
  if (interaction.commandName === "deadline") {
    await handleDeadlineCommand(interaction);
  }
});

// Watch for new threads created in the forum channel and post the rules
client.on("threadCreate", async (thread) => {
  try {
    const parentName = (thread.parent as any)?.name;
    if (parentName !== forumChannelName) return;

    // Compute tomorrow's date in 'Month DD YYYY' format
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const rules = `This is the daily drawing thread for ${dateStr}!\nPlease only post images in this thread\nReact with 🔥 to vote for an image to win\nIf you took longer than 15 minutes you can still post your drawing, just add a ⏲️ emoji and it won't be counted`;

    try {
      await (thread as any).send(rules);
      console.log(`Posted rules in new thread under '${forumChannelName}': ${thread.id}`);
    } catch (e) {
      console.error("Failed to post rules message in new thread:", e);
    }
  } catch (err) {
    console.error("Error handling threadCreate:", err);
  }
});

// Old testing command
async function handleTallyCommand(interaction: ChatInputCommandInteraction) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });
    const forum = guild.channels.cache.find(
      (ch) => ch.type === 15 && ch.name === forumChannelName // 15 = GuildForum
    ) as ForumChannel | undefined;
    if (!forum)
      return interaction.reply({ content: `Forum channel '${forumChannelName}' not found.`, flags: MessageFlags.Ephemeral });
    // Fetch the most recent thread (post) in the forum
    const threads = await forum.threads.fetchActive();
    const threadArr = Array.from(threads.threads.values());
    threadArr.sort((a: AnyThreadChannel, b: AnyThreadChannel) => {
      const aTime = a.createdTimestamp ?? 0;
      const bTime = b.createdTimestamp ?? 0;
      return bTime - aTime;
    });
    const latestThread = threadArr[0];
    if (!latestThread) return interaction.reply({ content: "No posts found in the forum.", flags: MessageFlags.Ephemeral });
    // Fetch all messages in the thread (the post and all replies)
    const allMessages = await latestThread.messages.fetch({ limit: 100 });
    // Exclude the first message (the post itself), only tally replies
    const replies = Array.from(allMessages.values()).filter((msg, idx, arr) => idx !== arr.length - 1);
    if (replies.length === 0) {
      return interaction.reply({ content: "No replies found in the most recent post." });
    }
    const replyTallies = await Promise.all(
      replies.map(async (reply) => {
        // Only count the fire emoji (🔥). For custom emojis named 'fire' also accept that name.
        let uniqueUserIds = new Set<string>();
        for (const reaction of reply.reactions.cache.values()) {
          try {
            const emojiName = reaction.emoji.name;
            if (emojiName !== "🔥" && emojiName?.toLowerCase() !== "fire") continue;
            const users = await reaction.users.fetch();
            users.forEach((user) => {
              // Skip bots and the original reply author (don't count the poster's own fire reaction)
              if (!user.bot && user.id !== (reply.author?.id ?? "")) uniqueUserIds.add(user.id);
            });
          } catch (e) {
            // ignore fetch errors for individual reactions
          }
        }
        const username = reply.author?.username || "Unknown";
        return `User: ${username}\nMessage ID: ${reply.id}\nFire Reactors: ${uniqueUserIds.size}`;
      })
    );
    await interaction.reply({
      content: `🔥 tally for replies to the most recent post in '${forumChannelName}':\n\n${replyTallies.join("\n\n")}`,
    });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: "An error occurred while tallying reactions.", flags: MessageFlags.Ephemeral });
  }
}

// Return true if the message appears to be an image reply (attachment, embed image, or image URL)
function isImageMessage(msg: any): boolean {
  try {
    if (msg.attachments && msg.attachments.size > 0) {
      for (const att of msg.attachments.values()) {
        const ct = (att.contentType as string) || "";
        if (ct.startsWith("image/")) return true;
        const name = att.name || att.url || "";
        if (/(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.tiff|\.svg)$/i.test(name)) return true;
      }
    }
    if (msg.embeds && msg.embeds.length > 0) {
      for (const e of msg.embeds) {
        if (e.image?.url || e.thumbnail?.url) return true;
        if (e.type === "image" && e.url) return true;
      }
    }
    if (typeof msg.content === "string" && msg.content) {
      const urlRegex = /(https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|tiff|svg))(?:\?\S*)?/i;
      if (urlRegex.test(msg.content)) return true;
    }
  } catch (e) {
    // If anything goes wrong, be conservative and treat as non-image
  }
  return false;
}

// Testing command, this will be replaced with a timed action with node-cron
async function handleDeadlineCommand(interaction: ChatInputCommandInteraction) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });
    const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!invoker) return interaction.reply({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral });
    const isAdmin = invoker.permissions?.has?.(PermissionsBitField.Flags?.Administrator ?? 0);
      const canKick = invoker.permissions?.has?.(PermissionsBitField.Flags?.KickMembers ?? 0);
      if (!isAdmin && !canKick) {
        return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });
    }
    const forum = guild.channels.cache.find(
      (ch) => ch.type === 15 && ch.name === forumChannelName // 15 = GuildForum
    ) as ForumChannel | undefined;
    if (!forum)
      return interaction.reply({ content: `Forum channel '${forumChannelName}' not found.`, flags: MessageFlags.Ephemeral });

    // Fetch the most recent thread (post) in the forum
    const threads = await forum.threads.fetchActive();
    const threadArr = Array.from(threads.threads.values());
    threadArr.sort((a: AnyThreadChannel, b: AnyThreadChannel) => {
      const aTime = a.createdTimestamp ?? 0;
      const bTime = b.createdTimestamp ?? 0;
      return bTime - aTime;
    });
    const latestThread = threadArr[0];
    if (!latestThread) return interaction.reply({ content: "No posts found in the forum.", flags: MessageFlags.Ephemeral });

    // Fetch all messages in the thread (the post and all replies)
    const allMessages = await latestThread.messages.fetch({ limit: 100 });
    // Exclude the first message (the post itself), only consider replies
    const replies = Array.from(allMessages.values()).filter((msg, idx, arr) => idx !== arr.length - 1);
    if (replies.length === 0) {
      return interaction.reply({ content: "No replies found in the most recent post." });
    }

    // Compute fire-react counts per reply author
    const authorCounts: { id: string; username: string; count: number }[] = [];
    for (const reply of replies) {
      const author = reply.author;
      if (!author) continue;
      // Only consider replies that are images
      if (!isImageMessage(reply)) continue;
      // If the poster reacted to their own submission with a timer emoji, ignore this submission
      try {
        for (const reactCheck of reply.reactions.cache.values()) {
          try {
            const name = reactCheck.emoji.name;
            const isTimerEmoji =
              name === "⏱️" || name === "⏲️" || (name && name.toLowerCase().includes("timer")) || (name && name.toLowerCase().includes("stopwatch"));
            if (!isTimerEmoji) continue;
            const usersForTimer = await reactCheck.users.fetch();
            if (usersForTimer.has(reply.author?.id ?? "")) {
              // skip this reply entirely
              throw new Error("SKIP_REPLY_TIMER");
            }
          } catch (e) {
            if ((e as Error).message === "SKIP_REPLY_TIMER") throw e;
            // otherwise ignore
          }
        }
      } catch (e) {
        if ((e as Error).message === "SKIP_REPLY_TIMER") continue;
      }
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
          // ignore fetch errors
        }
      }
      authorCounts.push({ id: author.id, username: author.username || "Unknown", count: uniqueUserIds.size });
    }

    // Aggregate by author id (in case an author posted multiple replies)
    const agg = new Map<string, { id: string; username: string; count: number }>();
    for (const a of authorCounts) {
      const prev = agg.get(a.id);
      if (prev) prev.count += a.count;
      else agg.set(a.id, { ...a });
    }

    const sorted = Array.from(agg.values()).sort((x, y) => y.count - x.count);

    const winner = sorted[0] ?? null;
    const second = sorted[1] ?? null;
    const third = sorted[2] ?? null;

    // Build announcement embed using members' display names when possible
    const fields: { name: string; value: string; inline?: boolean }[] = [];

    // Provide safe fallbacks for cases with fewer than 3 submissions
    const winnerObj = winner ?? { id: "none", username: "none", count: 0 };
    const secondObj = second ?? { id: "none", username: "none", count: 0 };
    const thirdObj = third ?? { id: "none", username: "none", count: 0 };

    let winnerName = winnerObj.username || "none";
    const secondName = secondObj.username || "none";
    const thirdName = thirdObj.username || "none";

    if (winner) {
      try {
        const member = await guild.members.fetch(winnerObj.id);
        if (member && member.displayName) winnerName = member.displayName;
      } catch (e) {
        // ignore if member fetch fails
      }
    }

    // Place
    fields.push({ name: `Rank`, value: `1st\n2nd\n3rd`, inline: true });

    // Names (mention the winner if present)
    const winnerMention = winnerObj.id !== "none" ? `<@${winnerObj.id}>` : "none";
    fields.push({ name: `Name`, value: `${winnerMention}\n${secondName}\n${thirdName}`, inline: true });

    // Votes (use numeric fallbacks)
    fields.push({ name: `:fire:`, value: `${winnerObj.count}\n${secondObj.count}\n${thirdObj.count}`, inline: true });


    const embed = new EmbedBuilder()
      .setTitle("15 minute daily results are in!")
      .addFields(fields as any)
      .setColor(0xffa500);

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: "An error occurred while computing the deadline results.", flags: MessageFlags.Ephemeral });
  }
}

client.login(token);
