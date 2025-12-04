import { ChatInputCommandInteraction, MessageFlags, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction, LabelBuilder } from "discord.js";
import { getOrCreateUser, updateUser, getUser } from "./database";

// Show modal for /daily-theme command
async function handleDailyThemeCommand(interaction: ChatInputCommandInteraction) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });

    const userId = interaction.user.id;
    const guildId = guild.id;
    const username = interaction.user.username;
    const user = getOrCreateUser(userId, guildId, username);

    const title = user?.themeTitle || "(no saved theme)";
    const desc = user?.themeDescription || "";

    const { embed, row } = buildSavedThemeEmbed(title, desc);
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("Error showing daily theme status:", e);
    try { await interaction.reply({ content: "Failed to show theme status.", flags: MessageFlags.Ephemeral }); } catch { }
  }
}

// Launch modal to create/update daily theme (used by button)
async function handleLaunchDailyThemeModal(interaction: ButtonInteraction) {
  try {
    const modal = new ModalBuilder().setCustomId("daily-theme-modal").setTitle("Submit Daily Theme");

    // Title
    const titleInput = new TextInputBuilder()
      .setCustomId("themeTitle")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const titleLabel = new LabelBuilder()
      .setLabel("Daily theme title")
      .setTextInputComponent(titleInput);

    // Description
    const descInput = new TextInputBuilder()
      .setCustomId("themeDescription")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(400);

    const descLabel = new LabelBuilder()
      .setLabel("More details (optional)")
      .setTextInputComponent(descInput);

    modal.addLabelComponents(titleLabel, descLabel);

    await interaction.showModal(modal);
  } catch (e) {
    console.error("Error launching daily theme modal:", e);
    try { await interaction.reply({ content: "Failed to open theme form.", flags: MessageFlags.Ephemeral }); } catch { }
  }
}

// Clear a user's saved theme (used by button)
async function handleClearDailyThemeButton(interaction: ButtonInteraction) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });

    const userId = interaction.user.id;
    const guildId = guild.id;
    const username = interaction.user.username;

    // Ensure user exists
    getOrCreateUser(userId, guildId, username);
    updateUser(userId, guildId, { themeTitle: null, themeDescription: null, themeTimestampUTC: null });

    const user = getUser(userId, guildId);
    const title = user?.themeTitle || "(no saved theme)";
    const desc = user?.themeDescription || "";

    const { embed, row } = buildSavedThemeEmbed(title, desc);
    await interaction.update({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error("Error clearing daily theme:", e);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "Failed to clear theme.", flags: MessageFlags.Ephemeral }); } catch { }
  }
}

// Handle modal submit for daily-theme
async function handleDailyThemeModalSubmit(interaction: ModalSubmitInteraction) {
  try {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Guild not found.", flags: MessageFlags.Ephemeral });

    const userId = interaction.user.id;
    const guildId = guild.id;
    const username = interaction.user.username;
    const title = interaction.fields.getTextInputValue("themeTitle") || "";
    const description = interaction.fields.getTextInputValue("themeDescription") || "";
    const timestampUTC = new Date().toISOString();

    // Ensure user record exists then update
    getOrCreateUser(userId, guildId, username);
    updateUser(userId, guildId, {
      themeTitle: title,
      themeDescription: description,
      themeTimestampUTC: timestampUTC,
      username: username,
    });

    // Build updated embed and buttons
    const user = getUser(userId, guildId);
    const updatedTitle = user?.themeTitle || "(no saved theme)";
    const updatedDesc = user?.themeDescription || "";
    const { embed, row } = buildSavedThemeEmbed(updatedTitle, updatedDesc);
    try {
      await interaction.deferUpdate();
      await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      console.log("Failed to edit reply, sending new reply instead", e);
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error("Error handling daily theme submit:", e);
    try { await interaction.reply({ content: "Failed to save theme.", flags: MessageFlags.Ephemeral }); } catch { }
  }
}

// Helper to build the saved daily theme embed and buttons
function buildSavedThemeEmbed(title: string, desc: string) {
  const embed = new EmbedBuilder()
    .setTitle("Daily Drawing Theme")
    .setDescription("Save a daily drawing theme that will automatically be posted if you win")
    .setColor(0x0099ff)
    .addFields(
      { name: "Title", value: title },
      { name: "Description", value: desc || "(none)" }
    );
  const updateButton = new ButtonBuilder().setCustomId("daily-theme-update").setLabel("Update Theme").setStyle(ButtonStyle.Primary);
  const clearButton = new ButtonBuilder().setCustomId("daily-theme-clear").setLabel("Clear Theme").setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(updateButton, clearButton);
  return { embed, row };
}

export {
  handleDailyThemeCommand,
  handleLaunchDailyThemeModal,
  handleClearDailyThemeButton,
  handleDailyThemeModalSubmit,
};
