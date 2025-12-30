import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMember,
  Interaction,
  MessageFlags,
} from "discord.js";
import { getGuild, getOrCreateGuild, updateGuild } from "../../database";
import { userHasModPermission } from "../../util";
import { BotStatus } from "../..";
import cron from "node-cron";
import cronParser from "cron-parser";

// Handle the /daily-bot-status command: show current status and a toggle button
export async function handleDailyBotStatusCommand(
  interaction: ChatInputCommandInteraction,
  botStatus: BotStatus
) {
  try {
    const auth = await getGuildAndInvoker(interaction);
    if (!auth) return;
    const { guild, invoker } = auth;

    // Ensure guild record exists
    getOrCreateGuild(guild.id, guild.name);

    if (!userHasModPermission(invoker))
      return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });

    const guildData = getGuild(guild.id);
    await interaction.reply({ ...buildStatusMessage(guildData, botStatus), flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("Error showing bot status:", e);
    await interaction.reply({ content: "Failed to show bot status.", flags: MessageFlags.Ephemeral });
  }
}

// Handle button interaction to toggle bot status
export async function handleDailyBotToggleButton(
  interaction: ButtonInteraction,
  botStatus: BotStatus
): Promise<BotStatus | undefined> {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    const newBotStatus = botStatus === BotStatus.ON ? BotStatus.OFF : BotStatus.ON;
    console.log(
      `Bot status toggled to ${BotStatus[newBotStatus]} by ${
        (interaction.user as any)?.tag || interaction.user.id
      }`
    );

    const guildData = getGuild(guild.id);
    await interaction.update(buildStatusMessage(guildData, newBotStatus));
    return newBotStatus;
  } catch (e) {
    console.error("Error handling toggle button:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to toggle bot status.", flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
}

// Handle button interaction to toggle pingUsers setting for a guild
export async function handleTogglePingUsersButton(interaction: ButtonInteraction, botStatus: BotStatus) {
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
    console.log(
      `Ping users toggled to ${newPingValue} for guild ${guild.id} by ${
        (interaction.user as any)?.tag || interaction.user.id
      }`
    );

    await interaction.update(buildStatusMessage({ ...guildData, pingUsers: newPingValue }, botStatus));
  } catch (e) {
    console.error("Error handling ping users toggle:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Failed to toggle ping users setting.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {}
  }
}

// Handle button interaction to toggle theme saving for a guild
export async function handleToggleThemeSavingButton(interaction: ButtonInteraction, botStatus: BotStatus) {
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
    console.log(
      `Theme saving toggled to ${newThemeValue} for guild ${guild.id} by ${
        (interaction.user as any)?.tag || interaction.user.id
      }`
    );

    await interaction.update(
      buildStatusMessage({ ...guildData, themeSavingEnabled: newThemeValue }, botStatus)
    );
  } catch (e) {
    console.error("Error handling theme saving toggle:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Failed to toggle theme saving setting.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {}
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
    if (!cron.validate(cronSchedule))
      return { error: `Configured cron expression '${cronSchedule}' is invalid.` };

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

async function requireAdminOrModForInteraction(
  interaction: Interaction
): Promise<{ guild: Guild; invoker: GuildMember } | null> {
  const guild = interaction.guild as Guild | null;
  if (!guild) {
    try {
      await (interaction as any).reply?.({ content: "Guild not found.", flags: MessageFlags.Ephemeral });
    } catch {}
    return null;
  }
  const user = (interaction as any).user as any;
  if (!user) {
    try {
      await (interaction as any).reply?.({
        content: "Unable to verify your permissions.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
    return null;
  }
  const invoker = await guild.members.fetch(user.id).catch(() => null);
  if (!invoker) {
    try {
      await (interaction as any).reply?.({
        content: "Unable to verify your permissions.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
    return null;
  }
  if (!userHasModPermission(invoker)) {
    try {
      await (interaction as any).reply?.({
        content: "You must be admin or mod.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
    return null;
  }
  return { guild, invoker };
}

// Helper: fetch guild and invoker (member) and reply with ephemeral errors if missing
async function getGuildAndInvoker(
  interaction: ChatInputCommandInteraction
): Promise<{ guild: Guild; invoker: GuildMember } | null> {
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

// Helper to build the status message embed and buttons
function buildStatusMessage(guildData: any, botStatus: BotStatus) {
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
    const scheduleLine = `Next run (UTC): ${utcStr}
      Next run (local time): ${discordLocal}
      Time until next run: ${hours}h ${minutes}m`;
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    toggleBotButton,
    togglePingButton,
    toggleThemeButton
  );

  return { embeds: [embed], components: [row] };
}
