// clearGuildCommands.js
// Usage: npm run clear
// Logs the bot in, iterates all guilds the bot is in and clears all guild-scoped application commands.

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN in environment. Aborting.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag} — clearing guild commands for all cached guilds.`);

  try {
    if (!client.guilds.cache || client.guilds.cache.size === 0) {
      console.log('No guilds cached — make sure the bot is a member of at least one guild.');
    }

    for (const [id, guild] of client.guilds.cache) {
      try {
        console.log(`Clearing commands for guild ${guild.name || id} (${id})`);
        // Set guild commands to an empty array — this will remove all application commands scoped to this guild
        await guild.commands.set([]);
        console.log(`Successfully cleared guild commands for ${id}`);
      } catch (err) {
        console.error(`Failed to clear commands for guild ${id}:`, err);
      }
    }

    console.log('Done clearing guild commands (for cached guilds).');
  } catch (err) {
    console.error('Unexpected error while clearing guild commands:', err);
  } finally {
    try { await client.destroy(); } catch { };
    process.exit(0);
  }
});

client.on('error', (err) => console.error('Discord client error:', err));

client.login(token).catch((err) => {
  console.error('Failed to login with provided DISCORD_TOKEN:', err);
  process.exit(1);
});