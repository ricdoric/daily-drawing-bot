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
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getGuild, getOrCreateGuild, updateGuild } from "../../database";
import { userHasModPermission } from "../../util";

// Handle the /daily-bot-config command: show current mod roles and an edit button
export async function handleDailyBotConfigCommand(interaction: ChatInputCommandInteraction) {
  try {
    const auth = await getGuildAndInvoker(interaction);
    if (!auth) return;
    const { guild, invoker } = auth;

    // Ensure guild record exists
    getOrCreateGuild(guild.id, guild.name);

    const guildData = getGuild(guild.id);
    const modRoles: string[] = guildData?.modRoles ? guildData.modRoles.split(",").map((r) => r.trim()) : [];

    if (!userHasModPermission(invoker, modRoles))
      return interaction.reply({ content: "You must be admin or mod.", flags: MessageFlags.Ephemeral });

    await interaction.reply({ ...buildConfigMessage(guildData), flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("Error showing bot config:", e);
    await interaction.reply({ content: "Failed to show bot config.", flags: MessageFlags.Ephemeral });
  }
}

// Handle button interaction to edit mod roles
export async function handleEditModRolesButton(interaction: ButtonInteraction) {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    const guildData = getGuild(guild.id);
    if (!guildData) {
      await interaction.reply({ content: "Guild data not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("edit-mod-roles-modal")
      .setTitle("Edit Moderator Roles");

    const modRolesInput = new TextInputBuilder()
      .setCustomId("mod-roles-input")
      .setLabel("Moderator Roles (comma-separated)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Enter role IDs or names, separated by commas")
      .setValue(guildData.modRoles || "")
      .setRequired(false);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(modRolesInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  } catch (e) {
    console.error("Error showing edit mod roles modal:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to open edit modal.", flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
}

// Handle modal submit for editing mod roles
export async function handleEditModRolesModal(interaction: ModalSubmitInteraction) {
  try {
    const auth = await requireAdminOrModForInteraction(interaction);
    if (!auth) return;
    const { guild } = auth;

    const modRolesValue = interaction.fields.getTextInputValue("mod-roles-input").trim();
    // Basic validation: ensure it's a comma-separated list
    const modRolesArray = modRolesValue ? modRolesValue.split(",").map(r => r.trim()).filter(r => r) : [];
    const cleanedModRoles = modRolesArray.join(", ");

    updateGuild(guild.id, { modRoles: cleanedModRoles || null });
    console.log(
      `Mod roles updated to "${cleanedModRoles}" for guild ${guild.id} by ${
        (interaction.user as any)?.tag || interaction.user.id
      }`
    );

    const guildData = getGuild(guild.id);
    await interaction.reply({ ...buildConfigMessage(guildData), flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("Error handling edit mod roles modal:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to update mod roles.", flags: MessageFlags.Ephemeral });
      }
    } catch {}
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
  const guildData = getGuild(guild.id);
  const modRoles: string[] = guildData?.modRoles ? guildData.modRoles.split(",").map((r) => r.trim()) : [];
  if (!userHasModPermission(invoker, modRoles)) {
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

// Helper to build the config message embed and buttons
function buildConfigMessage(guildData: any) {
  const modRolesText = guildData?.modRoles ? guildData.modRoles : "None set";

  const embed = new EmbedBuilder()
    .setTitle("Daily Bot Configuration")
    .setDescription("Configure moderator roles for this server.")
    .setColor(0x0099ff)
    .addFields({ name: "Moderator Roles", value: modRolesText });

  const editModRolesButton = new ButtonBuilder()
    .setCustomId("edit-mod-roles")
    .setLabel("Edit Mod Roles")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editModRolesButton);

  return { embeds: [embed], components: [row] };
}