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

import { userHasModPermission } from "./reactionCheck";
import {
  initializeDatabase,
  getOrCreateGuild,
  getGuild,
  updateGuild,
} from "./database";
import { handleDailyThemeCommand, handleClearDailyThemeButton, handleDailyThemeModalSubmit, handleLaunchDailyThemeModal } from "./bot/commands/theme";
import { podiumArtist } from "./types";
import { calculateTopThreeDrawings, createForumPost } from "./deadlineLogic";
import { buildRulesMessage, isImageMessage } from "./util";
import { handleThreadCreate } from "./bot/events/threadCreate";

const token = process.env.DISCORD_TOKEN;
// const testingGuildId = process.env.TESTING_GUILD_ID;
const applicationId = process.env.APPLICATION_ID;
const forumChannelName = process.env.FORUM_CHANNEL_NAME; // TODO: replace with per-guild config
const chatChannelName = process.env.CHAT_CHANNEL_NAME;
const pingUsersFlag = process.env.PING_USERS === "true";
const modRoles: string[] = process.env.MOD_ROLES ? process.env.MOD_ROLES.split(",").map((r) => r.trim()) : [];
const DEBUG = process.env.DEBUG === "true";


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

// TODO: simple caching for GuildConfig

// let botStatus = BotStatus.OFF; // TODO: Bot defaults to OFF
let botStatus = BotStatus.ON; // on during development

console.log(`Bot status is set to: ${BotStatus[botStatus]}`);

async function registerCommands() {
  const commands = [
    {
      name: "daily-bot-status",
      description: "Status screen with togglable options.",
      default_member_permissions: PermissionsBitField.Flags.KickMembers.toString(),
      dm_permission: false,
    },
    {
      name: "daily-theme",
      description: "Submit a new daily theme that will automatically post if you win.",
      dm_permission: false,
    },
  ];
  if (DEBUG) {
    commands.push({
      name: "daily-deadline",
      description: "DEBUG COMMAND - test the deadline vote counting.",
      default_member_permissions: PermissionsBitField.Flags.ManageGuild.toString(),
      dm_permission: false,
    });
  }
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationCommands(applicationId!), { body: commands });
  console.log("Global slash commands registered: /daily-bot-status, /daily-theme.");
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

// Event listener for slash commands and button interactions
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "daily-deadline") {
        await handleDailyDeadlineCommand(interaction);
        return;
      }
      if (interaction.commandName === "daily-bot-status") {
        await handleDailyBotStatusCommand(interaction);
        return;
      }
      if (interaction.commandName === "daily-theme") {
        await handleDailyThemeCommand(interaction);
        return;
      }
    } else if (interaction.isButton()) {
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

// Watch for new threads created in the forum channel and post the rules
client.on("threadCreate", async (thread) => {
  if (botStatus === BotStatus.OFF) return;

  handleThreadCreate(thread, forumChannelName!);


});

// Auto-react with :fire: on image posts in the forum channel
client.on("messageCreate", async (message) => {
  try {
    if (!message || !message.guild) return;
    // Ignore bot messages
    if (message.author?.bot) return;

    // Fetch partial message if needed
    if (message.partial) {
      try { await message.fetch(); } catch { /* ignore fetch errors */ }
    }

    const chAny: any = message.channel;
    const parentName = chAny?.parent?.name;
    if (parentName !== forumChannelName) return;

    // Only react to messages that appear to be images
    if (!isImageMessage(message)) return;

    // Add fire reaction
    try {
      await message.react("🔥");
      console.log(`Added fire react to message ${message.id} in guild ${message.guild.id}`);
    } catch (e) {
      // permission or unknown message errors are possible
      // log and continue
      console.error("Failed to add fire reaction:", e);
    }
  } catch (e) {
    console.error("Error in messageCreate handler:", e);
  }
});

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
    const scheduleLine = `Next run (UTC): ${utcStr}\nNext run (local time): ${discordLocal}\nTime until next run: ${hours}h ${minutes}m`;
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
      scheduledDeadline,
      { timezone: "UTC" }
    );
    console.log(`Scheduled daily job with cron expression '${cronSchedule}' (UTC)`);
  }
} catch (e) {
  console.error("Failed to schedule cron job:", e);
}



// Deadline stuff

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
    await deadlineResults(guild);
    await interaction.reply({ content: "Deadline results processed.", flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: "An error occurred while computing the deadline results.", flags: MessageFlags.Ephemeral });
  }
}

async function scheduledDeadline() {
  for (const [id] of client.guilds.cache) {
    try {
      const guild = await client.guilds.fetch(id).catch(() => null);
      if (!guild) continue;
      if (botStatus === BotStatus.OFF) {
        console.log(`Skipping guild ${guild.id} because botStatus is OFF`);
        continue;
      }

      deadlineResults(guild);

    } catch (e) {
      console.error("Error running scheduled job for guild:", id, e);
    }
  }
}

async function deadlineResults(guild: Guild) {
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

// Tally the votes and build the daily drawing results message embed
async function buildDeadlineResultsMessage(guild: Guild, topThree: podiumArtist[], newPostId: string | null): Promise<{ content: string; winnerId: string | null; mentionIds: string[] } | null> {
  try {
    // Build a message matching the requested template
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const utcDateStr = yesterday.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

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
