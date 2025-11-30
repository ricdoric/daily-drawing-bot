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
  ModalSubmitInteraction,
  MessageFlags,
} from "discord.js";
import cron from "node-cron";
import cronParser from "cron-parser";
import * as dotenv from "dotenv";
dotenv.config();

import { isMarkedOvertime, countFireReactors, userHasModPermission } from "./reactionCheck";
import {
  initializeDatabase,
  getOrCreateGuild,
  getGuild,
  updateGuild,
  getOrCreateUser,
  getUser,
  updateUser,
} from "./database";
import { handleDailyThemeCommand, handleClearDailyThemeButton, handleDailyThemeModalSubmit, handleLaunchDailyThemeModal } from "./themeSaving";

const token = process.env.DISCORD_TOKEN;
// const testingGuildId = process.env.TESTING_GUILD_ID;
const applicationId = process.env.APPLICATION_ID;
const forumChannelName = process.env.FORUM_CHANNEL_NAME;
const chatChannelName = process.env.CHAT_CHANNEL_NAME;
const pingUsersFlag = process.env.PING_USERS === "true";
// const modRoles: string[] = process.env.MOD_ROLES ? process.env.MOD_ROLES.split(",").map((r) => r.trim()) : [];

if (!token || !applicationId) {
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
    {
      name: "daily-theme",
      description: "Submit today's theme (title + optional description).",
      dm_permission: false,
    },
  ];
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationCommands(applicationId!), { body: commands });
  console.log("Global slash commands registered: /daily-deadline, /daily-bot-status, /daily-theme.");
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  initializeDatabase();

  // Initialize all guilds in the database
  for (const [guildId, guild] of client.guilds.cache) {
    getOrCreateGuild(guildId, guild.name);
  }

  // Log all guilds the bot is registered in (on startup)
  try {
    const guildList = Array.from(client.guilds.cache.values()).map((g) => `${g.name} (${g.id})`);
    if (guildList.length === 0) {
      console.log("Bot is not in any guilds.");
    } else {
      console.log("Bot registered in the following guilds:");
      for (const entry of guildList) console.log(` - ${entry}`);
    }
  } catch (e) {
    console.error("Failed to list guilds during clientReady:", e);
  }

  await registerCommands();
});

// Ensure guild record exists when bot joins a new guild
client.on("guildCreate", (guild) => {
  getOrCreateGuild(guild.id, guild.name);
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
      if (interaction.commandName === "daily-theme") {
        await handleDailyThemeCommand(interaction);
        return;
      }
    } else if (interaction.isButton()) {
      // handle toggle button
      // daily-theme buttons
      if ((interaction as ButtonInteraction).customId === "daily-theme-update") {
        await handleLaunchDailyThemeModal(interaction as ButtonInteraction);
        return;
      }
      if ((interaction as ButtonInteraction).customId === "daily-theme-clear") {
        await handleClearDailyThemeButton(interaction as ButtonInteraction);
        return;
      }
      if ((interaction as ButtonInteraction).customId === "daily-bot-toggle") {
        await handleDailyBotToggleButton(interaction as ButtonInteraction);
        return;
      }
      if ((interaction as ButtonInteraction).customId === "toggle-ping-users") {
        await handleTogglePingUsersButton(interaction as ButtonInteraction);
        return;
      }
      if ((interaction as ButtonInteraction).customId === "toggle-theme-saving") {
        await handleToggleThemeSavingButton(interaction as ButtonInteraction);
        return;
      }
    } else if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      // handle modal submits
      if ((interaction as ModalSubmitInteraction).customId === "daily-theme-modal") {
        await handleDailyThemeModalSubmit(interaction as ModalSubmitInteraction);
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

function buildRulesMessage(): string {
  const now = new Date();
  const utcTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dateStr = utcTomorrow.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return (
    `Welcome to the daily drawing thread for ${dateStr}!\n` +
    "- Please only post images in this thread\n" +
    "- React an image with \\:fire\\: :fire: to vote for it to win, you may vote as much as you'd like\n" +
    "- If your drawing went over time, react on it with \\:timer\\: :timer: and it won't be counted\n" +
    "- You can post multiple drawings, just keep them as separate replies in the thread\n" +
    "- The votes will be counted and the winner announced at 04:00 UTC\n"
  );
}

// Watch for new threads created in the forum channel and post the rules
client.on("threadCreate", async (thread) => {
  if (botStatus === BotStatus.OFF) return; // Do nothing if bot is OFF
  try {
    // If the thread was created by the bot, do nothing
    if (thread.ownerId && thread.client.user && thread.ownerId === thread.client.user.id) return;

    const parentName = (thread.parent as any)?.name;
    if (parentName !== forumChannelName) return;

    // Ensure guild record exists
    if (thread.guild) {
      getOrCreateGuild(thread.guild.id, thread.guild.name);
    }

    const rules = buildRulesMessage();
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
async function buildDailyResultsMessage(guild: Guild): Promise<{ embed: EmbedBuilder; winnerId: string | null } | null> {
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

    // Check if winner has a saved theme
    let winnerHasTheme = false;
    let winnerPingOrNot = winnerName;
    let footer = "";
    if (winnerObj.id !== "none") {
      const saved = getUser(winnerObj.id, guild.id);
      if (saved && saved.themeTitle) {
        console.log(`Winner ${winnerObj.username} has a saved theme: ${saved.themeTitle}`);
        winnerHasTheme = true;
      }
    }
    // If winner has a saved theme, do not ping them in the embed
    if (winnerHasTheme) {
      winnerPingOrNot = winnerName;
      footer = `Congratulations ${winnerName}! The bot will create a forum post with your saved theme!`;
    } else if (winnerObj.id !== "none") {
      winnerPingOrNot = pingUsersFlag ? winnerMention : winnerName;
      footer = `Congratulations ${winnerName}! Please create a forum post with a new theme!`;
    } else {
      footer = "No winner this round!";
    }
    const fieldValue = `${winnerPingOrNot}\n\n:fire: ` +
      `${secondObj.count}\n${secondName}\n\n:fire: ` +
      `${thirdObj.count}\n${thirdName}`;
    fields.push({ name: `:fire: ${winnerObj.count}`, value: fieldValue });

    const embed = new EmbedBuilder()
      .setTitle("15 Minute Daily Drawing Results")
      .addFields(fields as any)
      .setColor(0xffa500)
      .setFooter({ text: footer });
    const winnerId = winnerObj.id !== "none" ? winnerObj.id : null;
    return { embed, winnerId };
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

    // Ensure guild record exists
    getOrCreateGuild(guild.id, guild.name);

    const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!invoker) return interaction.reply({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral });
    if (!userHasModPermission(invoker)) {
      return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });
    }
    const forum = guild.channels.cache.find(
      (ch) => ch.type === 15 && ch.name === forumChannelName // 15 = GuildForum
    ) as ForumChannel | undefined;
    if (!forum) return interaction.reply({ content: `Forum channel '${forumChannelName}' not found.`, flags: MessageFlags.Ephemeral });
    const result = await buildDailyResultsMessage(guild);
    if (!result) return interaction.reply({ content: "No results to report for the most recent post.", flags: MessageFlags.Ephemeral });
    await interaction.reply({ embeds: [result.embed] });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: "An error occurred while computing the deadline results.", flags: MessageFlags.Ephemeral });
  }
}

client.login(token);

// Helper to build the status message embed and buttons
function buildStatusMessage(guildData: any) {
  const statusLabel = botStatus === BotStatus.ON ? "ON" : "OFF";
  const pingUsersLabel = guildData?.pingUsers ? "ON" : "OFF";
  const themeSavingLabel = guildData?.themeSavingEnabled ? "ON" : "OFF";

  const embed = new EmbedBuilder()
    .setTitle("Daily Bot Status")
    .setDescription(`The daily drawing bot is currently **${statusLabel}**.`)
    .setColor(botStatus === BotStatus.ON ? 0x00ff00 : 0xff0000)
    .addFields(
      { name: "Ping Users", value: pingUsersLabel },
      { name: "Theme Saving", value: themeSavingLabel }
    );

  const schedule = buildStatusSchedule();
  if ("error" in schedule) {
    embed.addFields({ name: "Schedule", value: schedule.error });
  } else {
    const { cronSchedule, utcStr, discordLocal, hours, minutes } = schedule;
    const scheduleLine = `Cron: ${cronSchedule}\nNext run (UTC): ${utcStr}\nNext run (local time): ${discordLocal}\nTime until next run: ${hours}h ${minutes}m`;
    embed.addFields({ name: "Schedule", value: scheduleLine });
  }

  const toggleBotButton = new ButtonBuilder()
    .setCustomId("daily-bot-toggle")
    .setLabel(botStatus === BotStatus.ON ? "Turn Bot OFF" : "Turn Bot ON")
    .setStyle(ButtonStyle.Primary);

  const togglePingButton = new ButtonBuilder()
    .setCustomId("toggle-ping-users")
    .setLabel(guildData?.pingUsers ? "Disable Ping Users" : "Enable Ping Users")
    .setStyle(ButtonStyle.Secondary);

  const toggleThemeButton = new ButtonBuilder()
    .setCustomId("toggle-theme-saving")
    .setLabel(guildData?.themeSavingEnabled ? "Disable Theme Saving" : "Enable Theme Saving")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBotButton, togglePingButton, toggleThemeButton);

  return { embeds: [embed], components: [row] };
}

// Handle the /daily-bot-status command: show current status and a toggle button
async function handleDailyBotStatusCommand(interaction: ChatInputCommandInteraction) {
  try {
    const auth = await getGuildAndInvoker(interaction);
    if (!auth) return;
    const { guild, invoker } = auth;

    // Ensure guild record exists
    getOrCreateGuild(guild.id, guild.name);

    if (!userHasModPermission(invoker)) return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });

    const guildData = getGuild(guild.id);
    await interaction.reply({ ...buildStatusMessage(guildData), flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("Error showing bot status:", e);
    await interaction.reply({ content: "Failed to show bot status.", flags: MessageFlags.Ephemeral });
  }
}

// Handle button interaction to toggle bot status
async function handleDailyBotToggleButton(interaction: ButtonInteraction) {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    botStatus = botStatus === BotStatus.ON ? BotStatus.OFF : BotStatus.ON;
    console.log(`Bot status toggled to ${BotStatus[botStatus]} by ${(interaction.user as any)?.tag || interaction.user.id}`);

    const guildData = getGuild(guild.id);
    await interaction.update(buildStatusMessage(guildData));
  } catch (e) {
    console.error("Error handling toggle button:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to toggle bot status.", flags: MessageFlags.Ephemeral });
      }
    } catch { }
  }
}

// Handle button interaction to toggle pingUsers setting for a guild
async function handleTogglePingUsersButton(interaction: ButtonInteraction) {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    const guildData = getGuild(guild.id);
    if (!guildData) {
      await interaction.reply({ content: "Guild data not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const newPingValue = guildData.pingUsers ? 0 : 1;
    updateGuild(guild.id, { pingUsers: newPingValue });
    console.log(`Ping users toggled to ${newPingValue} for guild ${guild.id} by ${(interaction.user as any)?.tag || interaction.user.id}`);

    await interaction.update(buildStatusMessage({ ...guildData, pingUsers: newPingValue }));
  } catch (e) {
    console.error("Error handling ping users toggle:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to toggle ping users setting.", flags: MessageFlags.Ephemeral });
      }
    } catch { }
  }
}

// Handle button interaction to toggle theme saving for a guild
async function handleToggleThemeSavingButton(interaction: ButtonInteraction) {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    const guildData = getGuild(guild.id);
    if (!guildData) {
      await interaction.reply({ content: "Guild data not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const newThemeValue = guildData.themeSavingEnabled ? 0 : 1;
    updateGuild(guild.id, { themeSavingEnabled: newThemeValue });
    console.log(`Theme saving toggled to ${newThemeValue} for guild ${guild.id} by ${(interaction.user as any)?.tag || interaction.user.id}`);

    await interaction.update(buildStatusMessage({ ...guildData, themeSavingEnabled: newThemeValue }));
  } catch (e) {
    console.error("Error handling theme saving toggle:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to toggle theme saving setting.", flags: MessageFlags.Ephemeral });
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
    try { await (interaction as any).reply?.({ content: "Guild not found.", flags: MessageFlags.Ephemeral }); } catch { }
    return null;
  }
  const user = (interaction as any).user as any;
  if (!user) {
    try { await (interaction as any).reply?.({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral }); } catch { }
    return null;
  }
  const invoker = await guild.members.fetch(user.id).catch(() => null);
  if (!invoker) {
    try { await (interaction as any).reply?.({ content: "Unable to verify your permissions.", flags: MessageFlags.Ephemeral }); } catch { }
    return null;
  }
  if (!userHasModPermission(invoker)) {
    try { await (interaction as any).reply?.({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral }); } catch { }
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
      deadlineResults,
      { timezone: "UTC" }
    );
    console.log(`Scheduled daily job with cron expression '${cronSchedule}' (UTC)`);
  }
} catch (e) {
  console.error("Failed to schedule cron job:", e);
}

async function deadlineResults() {
  console.log(`Posting results to chat channel`);
  for (const [id] of client.guilds.cache) {
    try {
      const guild = await client.guilds.fetch(id).catch(() => null);
      if (!guild) continue;
      if (botStatus === BotStatus.OFF) {
        console.log(`Skipping guild ${guild.id} because botStatus is OFF`);
        continue;
      }
      const result = await buildDailyResultsMessage(guild);
      if (!result) {
        console.log(`No results to announce for guild ${guild.id}`);
        continue;
      }
      const embed = result.embed;
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

      // If the winner has a saved theme, create a forum post and announce it, then clear the saved theme
      try {
        const winnerId = result.winnerId;
        if (winnerId) {
          const saved = getUser(winnerId, guild.id);
          if (saved && saved.themeTitle) {
            // Create forum post
            const forum = guild.channels.cache.find(
              (ch) => ch.type === 15 && ch.name === forumChannelName
            ) as ForumChannel | undefined;
            const body = `${saved.themeDescription || ""}\n\nTheme by: <@${winnerId}>\n\n${buildRulesMessage()}`;
            if (forum) {
              try {
                // create a new forum post (thread) with the theme
                await(forum as any).threads.create({ name: saved.themeTitle, message: { content: body } });
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
      } catch (e) {
        console.error("Error handling saved theme after posting results:", e);
      }
    } catch (e) {
      console.error("Error running scheduled job for guild:", id, e);
    }
  }
}