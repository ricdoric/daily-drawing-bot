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
  Guild,
  GuildMember,
  ChannelType,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  ButtonInteraction,
  MessageFlags,
} from "discord.js";
import cron from "node-cron";
import cronParser from "cron-parser";
import * as dotenv from "dotenv";
dotenv.config();

import { isMarkedOvertime, countFireReactors, userHasModPermission } from "./reactionCheck";

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const clientId = process.env.CLIENT_ID;
const forumChannelName = process.env.FORUM_CHANNEL_NAME;
const chatChannelName = process.env.CHAT_CHANNEL_NAME;
const pingUsersFlag = process.env.PING_USERS === "true";
// const modRoles: string[] = process.env.MOD_ROLES ? process.env.MOD_ROLES.split(",").map((r) => r.trim()) : [];

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

enum BotStatus {
  OFF,
  ON,
}

// let botStatus = BotStatus.OFF; // TODO: Bot defaults to OFF
let botStatus = BotStatus.ON; // on during development

console.log(`Bot status is set to: ${BotStatus[botStatus]}`);

async function registerCommands() {
  const commands = [
    {
      name: "daily-deadline",
      description: "Announce voting deadline and post winner, 2nd and 3rd place (by fire reactions).",
      default_member_permissions: PermissionsBitField.Flags.KickMembers.toString(),
      dm_permission: false,
    },
    {
      name: "daily-bot-status",
      description: "Show the current daily-bot status and toggle it (interactive).",
      default_member_permissions: PermissionsBitField.Flags.KickMembers.toString(),
      dm_permission: false,
    },
  ];
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationGuildCommands(clientId!, guildId!), { body: commands });
  console.log("Slash commands registered: /daily-deadline, /daily-bot-status.");
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "daily-deadline") {
        await handleDailyDeadlineCommand(interaction);
        return;
      }
      // /daily-bot-on and /daily-bot-off removed; use /daily-bot-status instead
      if (interaction.commandName === "daily-bot-status") {
        await handleDailyBotStatusCommand(interaction);
        return;
      }
    } else if (interaction.isButton()) {
      // handle toggle button
      if ((interaction as ButtonInteraction).customId === "daily-bot-toggle") {
        await handleDailyBotToggleButton(interaction as ButtonInteraction);
        return;
      }
    }
  } catch (e) {
    console.error("Error handling interaction:", e);
    try {
      if (interaction && (interaction as any).reply) {
        await (interaction as any).reply?.({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
      }
    } catch { }
  }
});

// Watch for new threads created in the forum channel and post the rules
client.on("threadCreate", async (thread) => {
  if (botStatus === BotStatus.OFF) return; // Do nothing if bot is OFF
  try {
    const parentName = (thread.parent as any)?.name;
    if (parentName !== forumChannelName) return;

    const now = new Date();
    const utcTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dateStr = utcTomorrow.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });

    const rules = `Welcome to the daily drawing thread for ${dateStr}!\n` +
      "- Please only post images in this thread\n" +
      "- React an image with \\:fire\\: :fire: to vote for it to win, you may vote as much as you'd like\n" +
      "- If your drawing went over time, react on it with \\:timer\\: :timer: and it won't be counted\n" +
      "- You can post multiple drawings, just keep them as separate replies in the thread\n" +
      "- The votes will be counted and the winner announced at 04:00 UTC\n";

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

// Tally the votes and build the daily drawing results message embed
async function buildDailyResultsMessage(guild: Guild): Promise<EmbedBuilder | null> {
  try {
    const forum = guild.channels.cache.find((ch) => ch.type === 15 && ch.name === forumChannelName) as ForumChannel | undefined;
    if (!forum) return null;

    // Fetch the most recent thread (post) in the forum
    const threads = await forum.threads.fetchActive();
    const threadArr = Array.from(threads.threads.values());
    threadArr.sort((a: AnyThreadChannel, b: AnyThreadChannel) => {
      const aTime = a.createdTimestamp ?? 0;
      const bTime = b.createdTimestamp ?? 0;
      return bTime - aTime;
    });
    const latestThread = threadArr[0];
    if (!latestThread) return null;

    // Fetch all messages in the thread (the post and all replies)
    const allMessages = await latestThread.messages.fetch({ limit: 100 });

    // Exclude the first message (the post itself), only consider replies
    const replies = Array.from(allMessages.values()).filter((msg, idx, arr) => idx !== arr.length - 1);
    if (replies.length === 0) return null;

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

    // Helper: fetch a member's display name if available, otherwise fall back to username
    async function fetchDisplayName(id: string, fallback: string): Promise<string> {
      if (!id || id === "none") return fallback || "none";
      try {
        const member = await guild.members.fetch(id).catch(() => null);
        return (member && member.displayName) ? member.displayName : (fallback || "none");
      } catch {
        return fallback || "none";
      }
    }

    const [winnerName, secondName, thirdName] = await Promise.all([
      fetchDisplayName(winnerObj.id, winnerObj.username),
      fetchDisplayName(secondObj.id, secondObj.username),
      fetchDisplayName(thirdObj.id, thirdObj.username),
    ]);

    const fields: { name: string; value: string; inline?: boolean }[] = [];
    const winnerMention = winnerObj.id !== "none" ? `<@${winnerObj.id}>` : "none";

    // Check env var for ping users flag
    let winnerPingOrNot = winnerName;
    if (pingUsersFlag) winnerPingOrNot = winnerMention;
    const fieldValue = `${winnerPingOrNot}\n\n:fire: ` +
      `${secondObj.count}\n${secondName}\n\n:fire: ` +
      `${thirdObj.count}\n${thirdName}`;
    fields.push({ name: `:fire: ${winnerObj.count}`, value: fieldValue });

    const footer = winnerObj.id !== "none" 
      ? `Congratulations ${winnerName}! Please create a forum post with a new theme!` 
      : "No winner this round!";
    
    const embed = new EmbedBuilder()
      .setTitle("15 Minute Daily Drawing Results")
      .addFields(fields as any)
      .setColor(0xffa500)
      .setFooter({ text: footer });
    return embed;
  } catch (err) {
    console.error("Error computing deadline for guild:", guild.id, err);
    return null;
  }
}

// function createDailyResultsEmbed(first, second, third, ping: boolean = true): EmbedBuilder {
//   const fields: { name: string; value: string; inline?: boolean }[] = [];
//   fields.push({ name: `Rank`, value: `1st\n2nd\n3rd`, inline: true });
//   const firstMention = first.id !== "none" ? `<@${first.id}>` : "none";

//   // Check env var for ping users flag
//   if (ping === true) {
//     fields.push({ name: `Name`, value: `${firstMention}\n${second.username}\n${third.username}`, inline: true });
//   } else {
//     fields.push({ name: `Name`, value: `${first.username}\n${second.username}\n${third.username}`, inline: true });
//   }
//   fields.push({ name: `:fire:`, value: `${first.count}\n${second.count}\n${third.count}`, inline: true });

//   const embed = new EmbedBuilder().setTitle("15 Minute Daily Results").addFields(fields as any).setColor(0xffa500);
//   return embed;
// }

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
async function handleDailyDeadlineCommand(interaction: ChatInputCommandInteraction) {
  if (botStatus === BotStatus.OFF) {
    return interaction.reply({ content: "Daily drawing bot is currently OFF." });
  }
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });
    const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!invoker) return interaction.reply({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral });
    if (!userHasModPermission(invoker)) {
      return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });
    }
    const forum = guild.channels.cache.find(
      (ch) => ch.type === 15 && ch.name === forumChannelName // 15 = GuildForum
    ) as ForumChannel | undefined;
    if (!forum) return interaction.reply({ content: `Forum channel '${forumChannelName}' not found.`, flags: MessageFlags.Ephemeral });
    const embed = await buildDailyResultsMessage(guild);
    if (!embed) return interaction.reply({ content: "No results to report for the most recent post.", flags: MessageFlags.Ephemeral });
    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: "An error occurred while computing the deadline results.", flags: MessageFlags.Ephemeral });
  }
}

client.login(token);

// Handle the /daily-bot-status command: show current status and a toggle button
async function handleDailyBotStatusCommand(interaction: ChatInputCommandInteraction) {
  try {
    const auth = await getGuildAndInvoker(interaction);
    if (!auth) return;
    const { guild, invoker } = auth;
    if (!userHasModPermission(invoker)) return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });
    const statusLabel = botStatus === BotStatus.ON ? "ON" : "OFF";

    const embed = new EmbedBuilder()
      .setTitle("Daily Bot Status")
      .setDescription(`The daily drawing bot is currently **${statusLabel}**.`)
      .setColor(botStatus === BotStatus.ON ? 0x00ff00 : 0xff0000);

    const schedule = buildStatusSchedule();
    if ("error" in schedule) {
      embed.addFields({ name: "Schedule", value: schedule.error });
    } else {
      const { cronSchedule, utcStr, discordLocal, hours, minutes } = schedule;
      const scheduleLine = `Deadline (UTC): ${utcStr}\nDeadline (local time): ${discordLocal}\nTime until deadline: ${hours}h ${minutes}m`;
      embed.addFields({ name: "Schedule", value: scheduleLine });
    }

    const toggleLabel = botStatus === BotStatus.ON ? "Turn OFF" : "Turn ON";
    const button = new ButtonBuilder().setCustomId("daily-bot-toggle").setLabel(toggleLabel).setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button as any);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (e) {
    console.error("Error showing bot status:", e);
    await interaction.reply({ content: "Failed to show bot status.", flags: MessageFlags.Ephemeral });
  }
}

// Handle button interaction to toggle bot status
async function handleDailyBotToggleButton(interaction: ButtonInteraction) {
  try {
    // require admin/mod for button toggle
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return; // requireAdmin... will reply ephemerally on failure

    // toggle
    botStatus = botStatus === BotStatus.ON ? BotStatus.OFF : BotStatus.ON;
    console.log(`Bot status toggled to ${BotStatus[botStatus]} by ${(interaction.user as any)?.tag || interaction.user.id}`);

    // update the message embed and button label
    const statusLabel = botStatus === BotStatus.ON ? "ON" : "OFF";
    const embed = new EmbedBuilder()
      .setTitle("Daily Bot Status")
      .setDescription(`The daily drawing bot is currently **${statusLabel}**.`)
      .setColor(botStatus === BotStatus.ON ? 0x00ff00 : 0xff0000);


    const schedule = buildStatusSchedule();
    if ("error" in schedule) {
      embed.addFields({ name: "Schedule", value: schedule.error });
    } else {
      const { cronSchedule, utcStr, discordLocal, hours, minutes } = schedule;
      const scheduleLine = `Cron: ${cronSchedule}\nNext run (UTC): ${utcStr}\nNext run (local time): ${discordLocal}\nTime until next run: ${hours}h ${minutes}m`;
      embed.addFields({ name: "Schedule", value: scheduleLine });
    }

    const toggleLabel = botStatus === BotStatus.ON ? "Turn OFF" : "Turn ON";
    const button = new ButtonBuilder().setCustomId("daily-bot-toggle").setLabel(toggleLabel).setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button as any);

    // Update the original message where the button was pressed
    await interaction.update({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error("Error handling toggle button:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to toggle bot status.", ephemeral: true });
      }
    } catch { }
  }
}

function buildStatusSchedule():
  | { error: string }
  | {
    cronSchedule: string;
    nextUtc: Date;
    unixSeconds: number;
    discordLocal: string;
    utcStr: string;
    hours: number;
    minutes: number;
  } {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 4 * * *";
  try {
    if (!cron.validate(cronSchedule)) return { error: `Configured cron expression '${cronSchedule}' is invalid.` };

    const interval = cronParser.parseExpression(cronSchedule, { tz: "UTC" });
    const nextUtc = interval.next().toDate();
    const unixSeconds = Math.floor(nextUtc.getTime() / 1000);

    // Discord timestamp for local display (Discord will render according to viewer timezone)
    const discordLocal = `<t:${unixSeconds}>`;

    // UTC formatted string (human readable)
    const utcStr = nextUtc.toLocaleString("en-US", { timeZone: "UTC", hour12: false });

    const now = new Date();
    const diffMs = nextUtc.getTime() - now.getTime();
    const positiveDiff = Math.max(0, diffMs);
    const hours = Math.floor(positiveDiff / (1000 * 60 * 60));
    const minutes = Math.floor((positiveDiff % (1000 * 60 * 60)) / (1000 * 60));

    return { cronSchedule, nextUtc, unixSeconds, discordLocal, utcStr, hours, minutes };
  } catch (e) {
    return { error: `Unable to compute next run for cron '${cronSchedule}'.` };
  }
}

async function requireAdminOrModForInteraction(interaction: Interaction): Promise<{ guild: Guild; invoker: GuildMember } | null> {
  const guild = interaction.guild as Guild | null;
  if (!guild) {
    try { await (interaction as any).reply?.({ content: "Guild not found.", ephemeral: true }); } catch { }
    return null;
  }
  const user = (interaction as any).user as any;
  if (!user) {
    try { await (interaction as any).reply?.({ content: "Unable to verify your permissions.", ephemeral: true }); } catch { }
    return null;
  }
  const invoker = await guild.members.fetch(user.id).catch(() => null);
  if (!invoker) {
    try { await (interaction as any).reply?.({ content: "Unable to verify your permissions.", ephemeral: true }); } catch { }
    return null;
  }
  if (!userHasModPermission(invoker)) {
    try { await (interaction as any).reply?.({ content: "You must be admin or mod.", ephemeral: true }); } catch { }
    return null;
  }
  return { guild, invoker };
}

// Helper: fetch guild and invoker (member) and reply with ephemeral errors if missing
async function getGuildAndInvoker(interaction: ChatInputCommandInteraction): Promise<{ guild: Guild; invoker: GuildMember } | null> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });
    return null;
  }
  const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!invoker) {
    await interaction.reply({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral });
    return null;
  }
  return { guild, invoker };
}

// Schedule daily job (configured by CRON_SCHEDULE env var) to run the deadline logic across guilds
try {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 4 * * *";
  if (!cron.validate(cronSchedule)) {
    console.error(`CRON_SCHEDULE '${cronSchedule}' is not a valid cron expression; skipping scheduler.`);
  } else {
    cron.schedule(
      cronSchedule,
      async () => {
        console.log(`Running scheduled daily deadline job (${cronSchedule} UTC)`);
        for (const [id, g] of client.guilds.cache) {
          try {
            const guild = await client.guilds.fetch(id).catch(() => null);
            if (!guild) continue;
            if (botStatus === BotStatus.OFF) {
              console.log(`Skipping guild ${guild.id} because botStatus is OFF`);
              continue;
            }
            const embed = await buildDailyResultsMessage(guild);
            if (!embed) {
              console.log(`No results to announce for guild ${guild.id}`);
              continue;
            }
            const chat = guild.channels.cache.find(
              (ch) => ch.type === ChannelType.GuildText && ch.name === chatChannelName
            ) as TextChannel | undefined;
            if (!chat) {
              console.log(`Chat channel '${chatChannelName}' not found in guild ${guild.id}`);
              continue;
            }
            try {
              await chat.send({ embeds: [embed] });
              console.log(`Posted daily results in guild ${guild.id} to text channel '${chatChannelName}'`);
            } catch (e) {
              console.error(`Failed to post daily results in guild ${guild.id}:`, e);
            }
          } catch (e) {
            console.error("Error running scheduled job for guild:", id, e);
          }
        }
      },
      { timezone: "UTC" }
    );
    console.log(`Scheduled daily job with cron expression '${cronSchedule}' (UTC)`);
  }
} catch (e) {
  console.error("Failed to schedule cron job:", e);
}
