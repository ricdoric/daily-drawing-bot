import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionsBitField,
  ButtonInteraction,
  ModalSubmitInteraction,
  MessageFlags,
} from "discord.js";
import cron from "node-cron";
import cronParser from "cron-parser";
import * as dotenv from "dotenv";
dotenv.config();

import { initializeDatabase, getOrCreateGuild, getGuild, updateGuild } from "./database";
import {
  handleDailyThemeCommand,
  handleClearDailyThemeButton,
  handleDailyThemeModalSubmit,
  handleLaunchDailyThemeModal,
} from "./bot/commands/theme";

import { buildRulesMessage, isImageMessage } from "./util";
import { handleThreadCreate } from "./bot/events/threadCreate";
import { deadlineResults, handleDailyDeadlineCommand } from "./bot/commands/deadline";
import {
  handleDailyBotStatusCommand,
  handleDailyBotToggleButton,
  handleTogglePingUsersButton,
  handleToggleThemeSavingButton,
} from "./bot/commands/status";

const token = process.env.DISCORD_TOKEN;
// const testingGuildId = process.env.TESTING_GUILD_ID;
const applicationId = process.env.APPLICATION_ID;
const forumChannelName = process.env.FORUM_CHANNEL_NAME || "contestForum"; // TODO: replace with per-guild config
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

export enum BotStatus {
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
        await handleDailyDeadlineCommand(interaction, forumChannelName, chatChannelName);
        return;
      }
      if (interaction.commandName === "daily-bot-status") {
        await handleDailyBotStatusCommand(interaction, botStatus);
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
        const newBotStatus = await handleDailyBotToggleButton(interaction as ButtonInteraction, botStatus);
        if (newBotStatus !== undefined) {
          botStatus = newBotStatus;
        }
        return;
      }
      if ((interaction as ButtonInteraction).customId === "toggle-ping-users") {
        await handleTogglePingUsersButton(interaction as ButtonInteraction, botStatus);
        return;
      }
      if ((interaction as ButtonInteraction).customId === "toggle-theme-saving") {
        await handleToggleThemeSavingButton(interaction as ButtonInteraction, botStatus);
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
    } catch {}
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
      try {
        await message.fetch();
      } catch {
        /* ignore fetch errors */
      }
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

// Schedule daily job (configured by CRON_SCHEDULE env var) to run the deadline logic across guilds
try {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 4 * * *";
  if (!cron.validate(cronSchedule)) {
    console.error(`CRON_SCHEDULE '${cronSchedule}' is not a valid cron expression; skipping scheduler.`);
  } else {
    cron.schedule(cronSchedule, scheduleDeadline, { timezone: "UTC" });
    console.log(`Scheduled daily job with cron expression '${cronSchedule}' (UTC)`);
  }
} catch (e) {
  console.error("Failed to schedule cron job:", e);
}

async function scheduleDeadline() {
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
