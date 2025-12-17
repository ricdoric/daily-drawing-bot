import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { GuildConfig, UserConfig } from "./types";

// Ensure data directory exists
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "drawbot.db");
const db = new Database(dbPath);

// Enable foreign keys
db.pragma("foreign_keys = ON");

/**
 * Initialize the database and create tables if they don't exist.
 */
function initializeDatabase(): void {
  try {
    // Create guilds table
    db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL UNIQUE,
        name TEXT,
        deadlineUTC TEXT,
        contestEntriesChannelName TEXT,
        contestForumChannelName TEXT,
        reminderTiming INTEGER DEFAULT 0,
        reminderMsg TEXT,
        rulesEnabled INTEGER DEFAULT 0,
        rulesMsg TEXT,
        pingUsers INTEGER DEFAULT 0,
        themeSavingEnabled INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create users table
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        guildId TEXT NOT NULL,
        username TEXT,
        themeTitle TEXT,
        themeDescription TEXT,
        themeTimestampUTC TEXT,
        clearThemeDaily INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, guildId),
        FOREIGN KEY(guildId) REFERENCES guilds(guildId)
      );
    `);

    console.log("Database initialized successfully");
  } catch (err) {
    console.error("Error initializing database:", err);
    throw err;
  }
}

/**
 * Get or create a guild record.
 */
function getOrCreateGuild(guildId: string, name?: string): GuildConfig {
  try {
    const existing = db.prepare("SELECT * FROM guilds WHERE guildId = ?").get(guildId) as GuildConfig | undefined;
    if (existing) return existing;

    const stmt = db.prepare(`
      INSERT INTO guilds (guildId, name, pingUsers)
      VALUES (?, ?, ?)
    `);
    stmt.run(guildId, name || "Unknown Guild", 0);

    return db.prepare("SELECT * FROM guilds WHERE guildId = ?").get(guildId) as GuildConfig;
  } catch (err) {
    console.error("Error getting or creating guild:", err);
    throw err;
  }
} 

/**
 * Update a guild's settings.
 */
function updateGuild(guildId: string, updates: Record<string, any>): boolean {
  try {
    const keys = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(", ");
    const values = Object.values(updates);

    const stmt = db.prepare(`
      UPDATE guilds
      SET ${keys}, updatedAt = CURRENT_TIMESTAMP
      WHERE guildId = ?
    `);
    const result = stmt.run(...values, guildId);

    return result.changes > 0;
  } catch (err) {
    console.error("Error updating guild:", err);
    throw err;
  }
}

/**
 * Get a guild by ID.
 */
function getGuild(guildId: string): GuildConfig | undefined {
  try {
    return db.prepare("SELECT * FROM guilds WHERE guildId = ?").get(guildId) as GuildConfig | undefined;
  } catch (err) {
    console.error("Error getting guild:", err);
    throw err;
  }
} 

/**
 * Delete a guild record.
 */
function deleteGuild(guildId: string): boolean {
  try {
    const stmt = db.prepare("DELETE FROM guilds WHERE guildId = ?");
    const result = stmt.run(guildId);
    return result.changes > 0;
  } catch (err) {
    console.error("Error deleting guild:", err);
    throw err;
  }
}

/**
 * Get all guilds.
 */
function getAllGuilds(): GuildConfig[] {
  try {
    return db.prepare("SELECT * FROM guilds").all() as GuildConfig[];
  } catch (err) {
    console.error("Error getting all guilds:", err);
    throw err;
  }
}

/**
 * Get or create a user record.
 */
function getOrCreateUser(userId: string, guildId: string, username: string): UserConfig {
  try {
    const existing = db.prepare("SELECT * FROM users WHERE userId = ? AND guildId = ?").get(userId, guildId) as UserConfig | undefined;
    if (existing) return existing;

    const stmt = db.prepare(`
      INSERT INTO users (userId, guildId, username)
      VALUES (?, ?, ?)
    `);
    stmt.run(userId, guildId, username);

    return db.prepare("SELECT * FROM users WHERE userId = ? AND guildId = ?").get(userId, guildId) as UserConfig;
  } catch (err) {
    console.error("Error getting or creating user:", err);
    throw err;
  }
} 

/**
 * Get a user by userId and guildId.
 */
function getUser(userId: string, guildId: string): UserConfig | undefined {
  try {
    return db.prepare("SELECT * FROM users WHERE userId = ? AND guildId = ?").get(userId, guildId) as UserConfig | undefined;
  } catch (err) {
    console.error("Error getting user:", err);
    throw err;
  }
} 

/**
 * Update a user's settings.
 */
function updateUser(userId: string, guildId: string, updates: Record<string, any>): boolean {
  try {
    const keys = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(", ");
    const values = Object.values(updates);

    const stmt = db.prepare(`
      UPDATE users
      SET ${keys}, updatedAt = CURRENT_TIMESTAMP
      WHERE userId = ? AND guildId = ?
    `);
    const result = stmt.run(...values, userId, guildId);

    return result.changes > 0;
  } catch (err) {
    console.error("Error updating user:", err);
    throw err;
  }
}

/**
 * Delete a user record.
 */
function deleteUser(userId: string, guildId: string): boolean {
  try {
    const stmt = db.prepare("DELETE FROM users WHERE userId = ? AND guildId = ?");
    const result = stmt.run(userId, guildId);
    return result.changes > 0;
  } catch (err) {
    console.error("Error deleting user:", err);
    throw err;
  }
}

/**
 * Get all users in a guild.
 */
function getUsersByGuild(guildId: string): UserConfig[] {
  try {
    return db.prepare("SELECT * FROM users WHERE guildId = ?").all(guildId) as UserConfig[];
  } catch (err) {
    console.error("Error getting users by guild:", err);
    throw err;
  }
}

/**
 * Get all users across all guilds.
 */
function getAllUsers(): UserConfig[] {
  try {
    return db.prepare("SELECT * FROM users").all() as UserConfig[];
  } catch (err) {
    console.error("Error getting all users:", err);
    throw err;
  }
}

/**
 * Close the database connection.
 */
function closeDatabase(): void {
  try {
    db.close();
    console.log("Database closed");
  } catch (err) {
    console.error("Error closing database:", err);
  }
}

export {
  db,
  initializeDatabase,
  getOrCreateGuild,
  updateGuild,
  getGuild,
  deleteGuild,
  getAllGuilds,
  getOrCreateUser,
  getUser,
  updateUser,
  deleteUser,
  getUsersByGuild,
  getAllUsers,
  closeDatabase,
};
