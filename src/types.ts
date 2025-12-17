export type podiumArtist = {
  id: string;
  username: string;
  votes: number;
  themeTitle?: string;
  themeDescription?: string;
}

export interface GuildConfig {
  id: number;
  guildId: string;
  name?: string | null;
  deadlineUTC?: string | null;
  contestEntriesChannelName?: string | null;
  contestForumChannelName?: string | null;
  reminderTiming?: number | null;
  reminderMsg?: string | null;
  rulesEnabled?: number | null;
  rulesMsg?: string | null;
  pingUsers?: number | null;
  themeSavingEnabled?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
} 

export interface UserConfig {
  id: number;
  userId: string;
  guildId: string;
  username?: string | null;
  themeTitle?: string | null;
  themeDescription?: string | null;
  themeTimestampUTC?: string | null;
  clearThemeDaily?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
} 